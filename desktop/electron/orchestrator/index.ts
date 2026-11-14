import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EngineBridge } from '../engine';
import { DATA_HOME, STATE_FILE, ensureDirs } from '../config';
import { createAdapter, probeEngines, type AgentAdapter } from '../adapters';
import { discoverModelCatalog } from '../discovery';
import { BotScheduler, type QueuedTurn } from './scheduler';
import { createWorktree, removeWorktree, collectDiffs, mergeToMain, resetWorktree, worktreeStatus } from './worktree';
import { supervisorPrompt } from './supervisor';
import { extractDispatches } from './actions';
import type { DesktopObservation } from '../adapters/types';
import type { DesktopSession, PermissionMode } from '../../src/types';
import { gravityModels, gravityTargets } from '../desktop/antigravity-rpc';
import {
  clampEffortForModel,
  type AgentStreamEvent, type ApprovalRequest, type BotConfig, type BotStatus, type CreateBotInput,
  type DiffEntry, type EngineEvent, type EngineHealth, type EngineModelCatalog, type EngineType, type FileLock,
  type HopPause, type QuotaState, type Room, type RoomMessage, type SearchHit, type StreamEvent,
  type StudioState, type TraceStep,
} from '../../src/types';

const DEFAULT_STATE: StudioState = {
  rooms: [], bots: [], messages: [], approvals: [], hopPauses: [], locks: [],
  maxHops: 10, spawnEnabled: true, emergencyStop: false,
};

type Emit = (channel: string, payload: unknown) => void;

export class Orchestrator {
  readonly engine = new EngineBridge();
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly scheduler = new BotScheduler();
  private readonly bots = new Map<string, BotConfig>();
  private state: StudioState = structuredClone(DEFAULT_STATE);
  private emit: Emit = () => {};
  private started = false;
  private readonly reconnectPromises = new Map<string, Promise<BotConfig | null>>();
  private modelCatalog: EngineModelCatalog | null = null;
  private readonly observers = new Map<string, () => void>();
  private readonly seenDeliveries = new Set<string>();
  private readonly roomCreation = new Set<string>();
  private readonly pausedBots = new Set<string>();
  private persistTimer?: NodeJS.Timeout;

  setEmitter(emit: Emit): void { this.emit = emit; }

  getState(): StudioState { return this.state; }

  async init(): Promise<void> {
    if (this.started) return;
    ensureDirs();
    this.loadState();
    await this.engine.start({ maxHops: this.state.maxHops, spawnEnabled: this.state.spawnEnabled });
    void this.engine.setEngineConfig({ maxHops: this.state.maxHops, spawnEnabled: this.state.spawnEnabled }).catch(() => undefined);
    this.engine.on('engine-event', (ev: EngineEvent) => this.onEngineEvent(ev));
    this.engine.on('engine-exit', (info: unknown) => this.emit('engine:exit', info));
    this.engine.on('engine-restarted', () => {
      void this.engine.setEngineConfig({ maxHops: this.state.maxHops, spawnEnabled: this.state.spawnEnabled }).catch(() => undefined);
      for (const bot of this.bots.values()) {
        void this.engine.registerBot(bot).catch(() => undefined);
      }
      void this.syncLocks();
      this.emit('engine:restarted', { at: new Date().toISOString() });
    });

    this.scheduler.onStatus = (botId, status: BotStatus) => {
      const bot = this.bots.get(botId);
      if (bot) { bot.status = this.state.emergencyStop || this.pausedBots.has(botId) ? 'paused' : status; this.emit('bot:status', { botId, status: bot.status }); }
      void this.engine.setBotStatus(botId, status).catch(() => undefined);
    };
    this.scheduler.onQueueChange = (botId, depth) => this.emit('bot:queue', { botId, depth });
    this.scheduler.setRunner((turn) => this.runTurn(turn));

    for (const bot of this.state.bots) {
      if (!bot.connection_mode) { bot.connection_mode = 'legacy_cli'; bot.status = 'paused'; }
      this.bots.set(bot.bot_id, bot);
      if (bot.status === 'paused') this.pausedBots.add(bot.bot_id);
      this.adapters.set(bot.bot_id, createAdapter(bot.engine_type, this.engine.authToken));
      void this.engine.registerBot(bot).catch(() => undefined);
      if (bot.connection_mode === 'desktop') void this.restoreDesktop(bot);
    }
    await this.syncLocks();
    this.started = true;
    this.emit('state', this.state);
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StudioState>;
      this.state = {
        ...DEFAULT_STATE, ...parsed,
        rooms: parsed.rooms ?? [],
        bots: (parsed.bots ?? []).map((b) =>
          b.status === 'working' || b.status === 'queued' ? { ...b, status: 'idle' as const } : b
        ),
        messages: (parsed.messages ?? []).slice(-10_000),
        approvals: parsed.approvals ?? [], hopPauses: parsed.hopPauses ?? [], locks: parsed.locks ?? [],
        emergencyStop: false,
      };
    } catch {
      this.state = structuredClone(DEFAULT_STATE);
      this.state.rooms = [{
        id: 'default', name: '默认协作房间',
        project_path: '', created_at: new Date().toISOString(),
      }];
    }
  }

  private persist(): void {
    try {
      this.state.messages = this.state.messages.slice(-10_000);
      const temporary = `${STATE_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(temporary, STATE_FILE);
    } catch (e) {
      this.emit('error', { message: `state persist failed: ${(e as Error).message}` });
    }
  }

  private pushMessage(message: RoomMessage): void {
    const idx = this.state.messages.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      const prev = this.state.messages[idx];
      const terminal = prev.status === 'done' || prev.status === 'uncertain' || prev.status === 'cancelled';
      const updated: RoomMessage = {
        ...prev,
        ...message,
        trace_id: message.trace_id ?? prev.trace_id,
        attachments: message.attachments ?? prev.attachments,
        channel: message.channel ?? prev.channel,
        task_id: message.task_id ?? prev.task_id,
        handoff: message.handoff ?? prev.handoff,
        status: terminal ? prev.status : message.status,
      };
      this.state.messages[idx] = updated;
      this.emit('message', updated);
      this.persist();
      return;
    }
    this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-10_000);
    this.emit('message', message);
    this.persist();
  }

  // ---------------------------------------------------------------- rooms / bots

  async createRoom(name: string, projectPath: string): Promise<Room> {
    const room: Room = {
      id: `room-${crypto.randomBytes(3).toString('hex')}`,
      name: name.trim() || '新房间',
      project_path: projectPath.trim(),
      created_at: new Date().toISOString(),
    };
    this.state.rooms.push(room);
    this.persist();
    this.emit('rooms', this.state.rooms);
    return room;
  }

  setRoomProject(roomId: string, projectPath: string): void {
    const room = this.state.rooms.find((r) => r.id === roomId);
    if (room) { room.project_path = projectPath; this.persist(); this.emit('rooms', this.state.rooms); }
  }

  supervisorOf(room: string): BotConfig | undefined {
    return [...this.bots.values()].find((b) => b.room === room && b.is_supervisor);
  }

  async createBot(input: CreateBotInput): Promise<BotConfig> {
    if (!input || !['claude', 'codex', 'antigravity'].includes(input.engine_type)) throw new Error('请选择有效的 Agent 引擎');
    if (this.roomCreation.has(input.room)) throw new Error('该项目正在创建 Bot，请等待完成');
    this.roomCreation.add(input.room);
    try { return await this.createBotNow(input); } finally { this.roomCreation.delete(input.room); }
  }

  private async createBotNow(input: CreateBotInput): Promise<BotConfig> {
    const room = this.state.rooms.find((r) => r.id === input.room);
    if (!room) throw new Error('项目不存在，请先新建项目');
    const roomBots = [...this.bots.values()].filter(b => b.room === room.id);
    if (!roomBots.some(b => b.is_supervisor) && !input.is_supervisor) throw new Error('项目的第一个 Bot 必须是主管，请先设置主管 Bot');
    if (input.external_session_id && [...this.bots.values()].some(b => b.engine_type === input.engine_type && b.external_session_id === input.external_session_id)) throw new Error('该真实对话已绑定其他 Bot，请为每个 Bot 选择独立对话');
    if (input.engine_type !== 'codex' && input.permission_mode !== 'inherit') throw new Error('此桌面端目前需继承原 Agent 权限，请在原应用设置权限');
    const roomId = room?.id ?? 'default';
    const shortEngine = input.engine_type === 'antigravity' ? 'agy' : input.engine_type;
    const slug = (input.roleTemplate || input.role || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'bot';
    let botId = `${slug}-${shortEngine}-1`;
    let n = 1;
    while (this.bots.has(botId)) { n++; botId = `${slug}-${shortEngine}-${n}`; }

    const projectPath = room?.project_path || os.homedir();
    let workspace = projectPath;
    let worktreeBranch: string | undefined;
    let effectiveMode = input.workspace_mode;
    if (input.workspace_mode === 'worktree') {
      const isolated = await createWorktree({ ...({} as BotConfig), room: roomId, bot_id: botId } as BotConfig, projectPath)
        .catch(() => null);
      if (isolated) { workspace = isolated.workspace; worktreeBranch = isolated.branch; }
      else effectiveMode = 'shared'; // not a git repo: fall back to shared + EditGuard
    }

    const isSupervisor = Boolean(input.is_supervisor);
    const cleanModel = input.model?.trim() || undefined;
    const cleanEffort = clampEffortForModel(input.engine_type, cleanModel, input.reasoning_effort, this.modelCatalog);
    const bot: BotConfig = {
      bot_id: botId,
      display_name: input.display_name.trim() || botId,
      engine_type: input.engine_type,
      model: cleanModel,
      reasoning_effort: cleanEffort,
      role: input.role || input.roleTemplate,
      system_prompt: input.system_prompt,
      permission_mode: input.permission_mode,
      workspace_mode: effectiveMode,
      room: roomId,
      workspace,
      worktree_branch: worktreeBranch,
      is_supervisor: isSupervisor,
      external_session_id: input.external_session_id,
      desktop_target_id: input.desktop_target_id,
      connection_mode: 'desktop',
      status: 'queued',
      color: input.color ?? { claude: '#e9a23b', codex: '#3ecf8e', antigravity: '#5b9dff' }[input.engine_type],
      created_at: new Date().toISOString(),
    };
    this.bots.set(botId, bot);
    const adapter = createAdapter(bot.engine_type, this.engine.authToken);
    this.adapters.set(botId, adapter);

    // A bot is only "bound" when a REAL independent session was created. Failures are reported,
    // never faked: the bot stays visible with status=error and no external_session_id.
    let bindingError = '';
    try {
      const session = await adapter.createSession(bot);
      bot.external_session_id = session.externalSessionId;
      if (room.project_path && path.resolve(bot.workspace).toLowerCase() !== path.resolve(room.project_path).toLowerCase()) throw new Error(`原对话工作目录是 ${bot.workspace}，与项目 ${room.project_path} 不一致，请选择正确项目的独立对话`);
      bot.status = 'idle';
      this.attachObserver(bot, adapter);
    } catch (e) {
      bindingError = (e as Error).message;
      bot.status = 'error';
    }

    if (isSupervisor) {
      const previous = [...this.bots.values()].filter(other => other.bot_id !== botId && other.room === roomId && other.is_supervisor);
      if (bot.status === 'error' && previous.length) bot.is_supervisor = false;
      else for (const other of previous) { other.is_supervisor = false; void this.engine.registerBot(other).catch(() => undefined); }
    }

    try { await this.engine.registerBot(bot); }
    catch (e) { bindingError += ` | engine register: ${(e as Error).message}`; }

    this.state.bots = [...this.bots.values()];
    this.persist();
    this.emit('bots', this.state.bots);
    if (bindingError) {
      this.emit('error', { message: `${bot.display_name} 未绑定真实会话：${bindingError.slice(0, 400)}` });
      this.pushMessage({
        id: crypto.randomUUID(), kind: 'system', from: 'system', room: roomId,
        text: `Bot ${bot.display_name} 创建完成但底层会话绑定失败（未伪造状态）：${bindingError.slice(0, 300)}`,
        created: new Date().toISOString(), status: 'uncertain',
      });
    }
    return bot;
  }

  async deleteBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;
    if (bot.is_supervisor && [...this.bots.values()].some(b => b.room === bot.room && b.bot_id !== botId)) throw new Error('请先指定其他 Bot 为主管，再删除当前主管');
    if (this.scheduler.isBusy(botId)) throw new Error('请先停止此 Bot 的任务，再删除连接');
    this.observers.get(botId)?.(); this.observers.delete(botId);
    this.scheduler.clearBot(botId);
    const adapter = this.adapters.get(botId);
    if (adapter) await adapter.dispose(bot);
    if (bot.workspace_mode === 'worktree') {
      const room = this.state.rooms.find((r) => r.id === bot.room);
      if (room?.project_path) await removeWorktree(bot, room.project_path);
    }
    await this.engine.deleteBot(botId).catch(() => undefined);
    this.bots.delete(botId);
    this.pausedBots.delete(botId);
    this.adapters.delete(botId);
    this.state.bots = [...this.bots.values()];

    const nextApprovals = this.state.approvals.filter((a) => a.bot_id !== botId);
    if (nextApprovals.length !== this.state.approvals.length) {
      this.state.approvals = nextApprovals;
      this.emit('approvals', this.state.approvals);
    }
    const orphanLocks = this.state.locks.filter((l) => l.bot_id === botId);
    if (orphanLocks.length > 0) {
      for (const lock of orphanLocks) {
        await this.engine.releaseLock(lock.id).catch(() => undefined);
      }
      this.state.locks = this.state.locks.filter((l) => l.bot_id !== botId);
      this.emit('locks', this.state.locks);
    }

    this.persist();
    this.emit('bots', this.state.bots);
  }

  async setSupervisor(botId: string): Promise<void> {
    const target = this.bots.get(botId);
    if (!target) return;
    const changed: BotConfig[] = [];
    for (const bot of this.bots.values()) {
      if (bot.room !== target.room) continue;
      const next = bot.bot_id === botId;
      if (bot.is_supervisor !== next) {
        bot.is_supervisor = next;
        changed.push(bot);
      }
    }
    for (const bot of changed) {
      void this.engine.registerBot(bot).catch(() => undefined);
    }
    this.state.bots = [...this.bots.values()];
    this.persist();
    this.emit('bots', this.state.bots);
  }

  reconnectBot(botId: string): Promise<BotConfig | null> {
    const existing = this.reconnectPromises.get(botId);
    if (existing) return existing;
    const task = (async (): Promise<BotConfig | null> => {
      const bot = this.bots.get(botId);
      const adapter = this.adapters.get(botId);
      if (!bot || !adapter) return null;
      this.pausedBots.delete(botId);
      await adapter.abortTurn(bot).catch(() => undefined);
      try {
        if (bot.connection_mode !== 'desktop') throw new Error('旧版 CLI 会话不能自动冒充桌面对话，请新建 Bot 并选择原应用中的真实对话');
        const session = await adapter.createSession(bot);
        bot.external_session_id = session.externalSessionId;
        bot.status = 'idle';
        this.attachObserver(bot, adapter);
        await this.engine.registerBot(bot).catch(() => undefined);
        this.state.bots = [...this.bots.values()];
        this.persist();
        this.emit('bots', this.state.bots);
        return bot;
      } catch (e) {
        bot.status = 'error';
        this.state.bots = [...this.bots.values()];
        this.persist();
        this.emit('bots', this.state.bots);
        this.emit('error', { message: `${bot.display_name} 重连底层会话失败：${(e as Error).message.slice(0, 300)}` });
        return bot;
      }
    })().finally(() => {
      if (this.reconnectPromises.get(botId) === task) this.reconnectPromises.delete(botId);
    });
    this.reconnectPromises.set(botId, task);
    return task;
  }

  async setBotModel(botId: string, model: string, reasoningEffort?: string): Promise<BotConfig | null> {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    if (this.scheduler.isBusy(botId)) throw new Error('请等待当前任务结束后再切换模型');
    const trimmed = model.trim();
    const next = { ...bot, model: trimmed || undefined };
    const requestedEffort = reasoningEffort === undefined ? bot.reasoning_effort : (reasoningEffort.trim() || undefined);
    next.reasoning_effort = clampEffortForModel(bot.engine_type, next.model, requestedEffort, this.modelCatalog);
    const adapter = this.adapters.get(botId);
    if (!adapter?.applySettings) throw new Error('当前连接不支持桌面设置，请重新连接真实对话');
    await adapter.applySettings(next);
    Object.assign(bot, next);
    this.state.bots = [...this.bots.values()];
    this.persist();
    this.emit('bots', this.state.bots);
    void this.engine.registerBot(bot).catch(() => undefined);
    return bot;
  }

  async listModels(refresh = false): Promise<EngineModelCatalog> {
    const catalog = await discoverModelCatalog({ force: refresh, skipCliProbe: true });
    this.modelCatalog = catalog;
    try {
      const targets = await gravityTargets(refresh);
      const discovered = await Promise.all(targets.map(async target => [String(target.pid), await gravityModels(target)] as const));
      const targetModels = Object.fromEntries(discovered);
      const models = discovered[0]?.[1] ?? [];
      catalog.antigravity = { models, targetModels, supportsEffort: false, sources: ['反重力运行中桌面的 GetUserStatus'], discoveredAt: new Date().toISOString(), effortNote: models.length ? '列表来自所连接的反重力桌面账号；模型包含各自的推理强度，切换后沿用同一真实对话。' : '反重力桌面未连接，请先打开并登录原应用。' };
    } catch {
      catalog.antigravity = { models: [], supportsEffort: false, effortNote: '反重力桌面接口离线，无法取得真实模型列表。' };
    }
    catalog.claude.effortNote = 'Claude 当前桌面收件箱只支持发送任务；模型和权限请在原 Agent 中选择，实际执行模型会同步回来。';
    return catalog;
  }

  async listDesktopSessions(engine: EngineType): Promise<DesktopSession[]> {
    const adapter = createAdapter(engine, this.engine.authToken);
    try { return await adapter.listSessions?.() ?? []; } finally { await adapter.dispose({} as BotConfig); }
  }

  async listDesktopTargets(): Promise<{ id: string; label: string }[]> {
    return (await gravityTargets()).map(t => ({ id: String(t.pid), label: t.account }));
  }

  async setBotPermission(botId: string, mode: PermissionMode): Promise<BotConfig> {
    if (!['inherit', 'read_only', 'ask_ui', 'auto'].includes(mode)) throw new Error('未知的权限等级');
    const bot = this.bots.get(botId); if (!bot) throw new Error('Bot 不存在');
    if (this.scheduler.isBusy(botId)) throw new Error('请等待任务结束后再修改权限');
    const adapter = this.adapters.get(botId); if (!adapter?.applySettings) throw new Error('当前桌面连接不支持修改权限');
    const next = { ...bot, permission_mode: mode }; await adapter.applySettings(next);
    bot.permission_mode = mode; this.persist(); this.emit('bots', [...this.bots.values()]); return bot;
  }

  private async restoreDesktop(bot: BotConfig): Promise<void> {
    try { const adapter = this.adapters.get(bot.bot_id)!; await adapter.createSession(bot); this.attachObserver(bot, adapter); }
    catch (e) { bot.status = 'error'; this.emit('error', { message: `${bot.display_name} 桌面对话离线：${(e as Error).message}` }); }
    this.persist(); this.emit('bots', [...this.bots.values()]);
  }

  private attachObserver(bot: BotConfig, adapter: AgentAdapter): void {
    this.observers.get(bot.bot_id)?.();
    const stop = adapter.observe?.(bot, observation => this.onDesktopObservation(bot, observation));
    if (stop) this.observers.set(bot.bot_id, stop);
  }

  private recordActivity(botId: string, event: AgentStreamEvent): void {
    const stream: StreamEvent = { bot_id: botId, at: new Date().toISOString(), event };
    const activity = this.state.activity ??= {};
    const previous = activity[botId]?.at(-1);
    if (event.type === 'error' && previous?.event.type === 'error' && previous.event.message === event.message && Date.now() - Date.parse(previous.at) < 30_000) return;
    activity[botId] = [...(activity[botId] ?? []), stream].slice(-500);
    this.emit('stream', stream);
    if (!this.persistTimer) this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.persist(); }, 500);
  }

  private onDesktopObservation(bot: BotConfig, observation: DesktopObservation): void {
    if (observation.type === 'message') {
      if (observation.role === 'assistant' && this.state.messages.some(m => m.from === bot.bot_id && m.status === 'done' && m.native_message_ids?.includes(observation.id))) return;
      const id = `desktop:${bot.bot_id}:${observation.id}`;
      const previous = this.state.messages.find(m => m.id === id);
      if (previous?.text === observation.text) return;
      this.pushMessage({ id, kind: observation.role === 'user' ? 'user' : 'bot', from: observation.role === 'user' ? 'user' : bot.bot_id,
        to: observation.role === 'user' ? bot.bot_id : 'user', room: bot.room, text: observation.text, created: observation.at, channel: 'desktop', status: 'done' });
    } else if (observation.type === 'activity') {
      this.recordActivity(bot.bot_id, observation.event);
      if (observation.event.type === 'error' && observation.event.uncertain) { bot.status = 'error'; this.emit('bots', [...this.bots.values()]); }
      if (observation.event.type === 'approval_required') {
        const event = observation.event;
        if (!this.state.approvals.some(a => a.id === event.requestId && a.bot_id === bot.bot_id)) {
          this.state.approvals.push({ id: event.requestId, bot_id: bot.bot_id, command: event.command, files: event.files ?? [], created_at: new Date().toISOString() });
          this.emit('approvals', this.state.approvals);
        }
        bot.status = 'waiting_approval'; this.emit('bots', [...this.bots.values()]);
      }
    }
    else {
      if (observation.approvalIds) {
        const pending = this.state.approvals.filter(a => a.bot_id !== bot.bot_id || observation.approvalIds!.includes(a.id));
        if (pending.length !== this.state.approvals.length) { this.state.approvals = pending; this.emit('approvals', pending); }
      }
      if (observation.permissions) bot.permissions = observation.permissions;
      // Model changes selected in the original desktop are mirrored as well.
      if (observation.model && !this.scheduler.isBusy(bot.bot_id)) bot.model = observation.model;
      if (!this.scheduler.isBusy(bot.bot_id) && bot.status !== 'paused') bot.status = observation.approvalIds?.length ? 'waiting_approval' : observation.working ? 'working' : 'idle';
      this.emit('bots', [...this.bots.values()]);
    }
  }

  // ---------------------------------------------------------------- messaging

  async sendMessage(room: string, text: string, target?: string, attachments: string[] = []): Promise<RoomMessage> {
    this.validateMessage(room, text, attachments);
    const to = target ?? this.supervisorOf(room)?.bot_id;
    if (!to) throw new Error('该房间没有主管 Bot；请先新建一个主管 Bot 或 @指定 Bot');
    if (this.bots.get(to)?.room !== room) throw new Error('不能向其他项目的 Bot 派单');
    const fallbackTraceId = crypto.randomBytes(8).toString('hex');
    const posted = await this.engine.postUserMessage(to, text, room, fallbackTraceId);
    const traceId = posted.traceId ?? fallbackTraceId;
    const message: RoomMessage = {
      id: posted.id, kind: 'user', from: 'user', to, room, text,
      created: new Date().toISOString(), status: 'delivered', trace_id: traceId, hop_count: 0,
      channel: 'group', attachments, task_id: posted.id,
    };
    this.pushMessage(message);
    // Drive the real session directly; the SSE handler skips user-originated messages to avoid
    // injecting the same prompt twice into a streaming turn.
    this.enqueue(to, text + this.attachmentPrompt(attachments), 'user', { messageId: posted.id, traceId, hopCount: 0 });
    return message;
  }

  async sendDirect(botId: string, text: string, room: string, attachments: string[] = []): Promise<RoomMessage> {
    this.validateMessage(room, text, attachments);
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`未知的 Bot：${botId}`);
    if (bot.room !== room) throw new Error('Bot 不属于此项目');
    const traceId = crypto.randomBytes(8).toString('hex');
    let id: string;
    let resolvedTraceId = traceId;
    try {
      const posted = await this.engine.postUserMessage(botId, text, room, traceId);
      id = posted.id;
      resolvedTraceId = posted.traceId ?? traceId;
    } catch (e) { throw new Error(`任务未持久化，未派发到桌面：${(e as Error).message}`); }
    const message: RoomMessage = {
      id, kind: 'user', from: 'user', to: botId, room, text,
      created: new Date().toISOString(), status: 'delivered', trace_id: resolvedTraceId, hop_count: 0,
      channel: 'direct', attachments, task_id: id,
    };
    this.pushMessage(message);
    const directPrompt = `[Agent Bot · 私聊指令]\nmessage_id: ${id}\nroom / topic: ${room}\nto (your bot_id): ${botId}\n\n${text}${this.attachmentPrompt(attachments)}`;
    this.enqueue(botId, directPrompt, 'user', { messageId: id, traceId: resolvedTraceId, hopCount: 0 });
    return message;
  }

  private validateMessage(room: string, text: string, attachments: string[]): void {
    if (this.state.emergencyStop) throw new Error('紧急停止已启用，请先恢复再派单');
    if (!this.state.rooms.some(r => r.id === room)) throw new Error('项目不存在');
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('任务内容为空或过长');
    if (!Array.isArray(attachments) || attachments.length > 8 || attachments.some(file => typeof file !== 'string' || !fs.existsSync(file) || !fs.statSync(file).isFile())) throw new Error('附件不存在或不是文件，每次最多 8 个附件');
  }

  private attachmentPrompt(files: string[]): string { return files.length ? `\n\n用户上传的任务附件（本地文件）：\n${files.join('\n')}\n仅按当前任务需要读取。` : ''; }

  private enqueue(botId: string, prompt: string, source: string, meta?: { traceId?: string; hopCount?: number; messageId?: string }): void {
    if (!this.bots.has(botId)) return;
    if (this.pausedBots.has(botId)) {
      if (source === 'user') this.pausedBots.delete(botId);
      else {
        const message = this.state.messages.find(m => m.id === meta?.messageId);
        if (message) { message.status = 'cancelled'; message.progress = '此 Bot 已由用户暂停，任务未执行'; this.emit('message', message); this.persist(); }
        return;
      }
    }
    if (meta?.messageId) {
      const key = `${botId}:${meta.messageId}`;
      if (this.seenDeliveries.has(key)) return;
      this.seenDeliveries.add(key);
    }
    if (this.state.emergencyStop) {
      this.emit('error', { message: '紧急停止已激活，消息未投递' });
      return;
    }
    this.scheduler.enqueue({
      botId, prompt, source,
      messageId: meta?.messageId,
      traceId: meta?.traceId, hopCount: meta?.hopCount,
      onEvent: (event) => {
        this.recordActivity(botId, event);
        if (event.type === 'approval_required') {
          const approval: ApprovalRequest = {
            id: event.requestId, bot_id: botId, command: event.command,
            files: event.files ?? [], created_at: new Date().toISOString(),
          };
          if (!this.state.approvals.some(a => a.id === approval.id && a.bot_id === botId)) this.state.approvals.push(approval);
          this.emit('approvals', this.state.approvals);
          const bot = this.bots.get(botId); if (bot) bot.status = 'waiting_approval';
          this.persist();
        }
        if (event.type === 'turn_completed' && meta?.messageId) {
          const msg = this.state.messages.find((m) => m.id === meta.messageId);
          if (msg) { msg.status = 'done'; this.emit('message', msg); }
        }
        if (event.type === 'error' && event.uncertain && meta?.messageId) {
          const msg = this.state.messages.find((m) => m.id === meta.messageId);
          if (msg) { msg.status = 'uncertain'; this.emit('message', msg); }
        }
      },
      resolve: () => {},
    });
  }

  private async runTurn(turn: QueuedTurn): Promise<boolean> {
    const { botId, prompt, onEvent } = turn;
    const bot = this.bots.get(botId);
    const adapter = this.adapters.get(botId);
    if (!bot || !adapter) return false;
    const pendingReconnect = this.reconnectPromises.get(turn.botId);
    if (pendingReconnect) await pendingReconnect.catch(() => undefined);

    const expectedTo = turn.source === 'user' ? 'user' : turn.source;
    if (!bot.external_session_id) {
      const errMsg = '该 Bot 未绑定真实底层会话，无法执行；请点击重连或检查引擎健康面板';
      onEvent({ type: 'error', message: errMsg });
      this.pushMessage({
        id: crypto.randomUUID(),
        kind: 'system',
        from: bot.bot_id,
        to: expectedTo,
        reply_to: turn.messageId,
        room: bot.room,
        text: errMsg,
        created: new Date().toISOString(),
        status: 'uncertain',
        trace_id: turn.traceId,
      });
      return false;
    }

    let streamedText = '';
    let lastError = '';
    const traceSteps: TraceStep[] = [];
    const turnStartedAt = Date.now();
    const wrappedOnEvent = (ev: AgentStreamEvent): void => {
      const nowIso = new Date().toISOString();
      if (ev.type === 'text_delta' && ev.text) {
        streamedText += ev.text;
      } else if (ev.type === 'thinking_delta' && ev.text) {
        const last = traceSteps[traceSteps.length - 1];
        if (last?.kind === 'thinking') {
          last.detail = ((last.detail ?? '') + ev.text).slice(-1600);
          last.at = nowIso;
        } else if (traceSteps.length < 60) {
          traceSteps.push({ kind: 'thinking', title: '思考过程', detail: ev.text.slice(0, 1600), at: nowIso });
        }
      } else if (ev.type === 'tool_call_start') {
        if (traceSteps.length < 60) {
          traceSteps.push({ kind: 'tool_start', title: ev.tool, detail: ev.args?.slice(0, 500), at: nowIso });
        }
      } else if (ev.type === 'tool_call_result') {
        if (traceSteps.length < 60) {
          traceSteps.push({ kind: 'tool_result', title: ev.tool, detail: ev.output?.slice(0, 600), ok: ev.ok, at: nowIso });
        }
      } else if (ev.type === 'error' && ev.message) {
        lastError = ev.message;
        if (traceSteps.length < 60) {
          traceSteps.push({ kind: 'error', title: '异常信息', detail: ev.message.slice(0, 500), ok: false, at: nowIso });
        }
      }
      onEvent(ev);
    };

    const hasBotReply = (): boolean => this.state.messages.some((m) =>
      m.room === bot.room
      && m.from === bot.bot_id
      && m.kind === 'bot'
      && (
        (turn.messageId && m.reply_to === turn.messageId)
        || (
          !m.reply_to
          && m.to === expectedTo
          && Date.parse(m.created) >= turnStartedAt
        )
      ));

    try {
      const result = await adapter.sendTurn(bot, this.desktopPrompt(bot, turn, prompt), wrappedOnEvent);
      if (result.sessionId && result.sessionId !== bot.external_session_id) {
        bot.external_session_id = result.sessionId;
        this.state.bots = [...this.bots.values()];
        this.persist();
        this.emit('bots', this.state.bots);
        void this.engine.registerBot(bot).catch(() => undefined);
      }
      if (!result.ok) {
        onEvent({ type: 'error', message: result.error ?? 'turn failed', uncertain: result.uncertain });
      }

      const cleanResult = result.text && !/^\s*(\{\s*\}|\{\s*"(response|conversationId|error)")/.test(result.text)
        ? result.text.trim()
        : '';
      const parsedReply = extractDispatches(cleanResult || streamedText.trim());
      const replyText = parsedReply.text;
      const original = this.state.messages.find(m => m.id === turn.messageId);

      if (!hasBotReply()) {
        if (replyText) {
          this.pushMessage({
            id: crypto.randomUUID(),
            kind: 'bot',
            from: bot.bot_id,
            to: expectedTo,
            reply_to: turn.messageId,
            room: bot.room,
            text: replyText,
            created: new Date().toISOString(),
            status: result.ok ? 'done' : 'uncertain',
            trace_id: turn.traceId,
            hop_count: turn.hopCount,
            trace_steps: traceSteps.length ? traceSteps : undefined,
            channel: original?.channel === 'direct' ? 'direct' : 'group', task_id: turn.messageId,
            native_message_ids: result.nativeMessageIds,
          });
        } else if (!result.ok) {
          this.pushMessage({
            id: crypto.randomUUID(),
            kind: 'system',
            from: bot.bot_id,
            to: expectedTo,
            reply_to: turn.messageId,
            room: bot.room,
            text: `执行失败：${(result.error ?? lastError) || '底层引擎未返回内容'}`,
            created: new Date().toISOString(),
            status: 'uncertain',
            trace_id: turn.traceId,
            trace_steps: traceSteps.length ? traceSteps : undefined,
          });
        }
      } else if (traceSteps.length) {
        const existingReply = [...this.state.messages].reverse().find((m) =>
          m.room === bot.room
          && m.from === bot.bot_id
          && m.kind === 'bot'
          && ((turn.messageId && m.reply_to === turn.messageId) || (!m.reply_to && m.to === expectedTo && Date.parse(m.created) >= turnStartedAt)));
        if (existingReply && !existingReply.trace_steps?.length) {
          existingReply.trace_steps = traceSteps;
          this.persist();
          this.emit('message', existingReply);
        }
      }
      if (result.ok && turn.messageId) {
        const orig = this.state.messages.find((m) => m.id === turn.messageId);
        if (orig && orig.status !== 'done') {
          orig.status = 'done';
          this.emit('message', orig);
          this.persist();
        }
      }
      if (result.ok && !this.state.emergencyStop) {
        for (const [index, action] of parsedReply.actions.entries()) {
          if (action.to === bot.bot_id || this.bots.get(action.to)?.room !== bot.room) {
            this.emit('error', { message: `${bot.display_name} 的派单目标无效：${action.to}` }); continue;
          }
          this.routeBotMessage(bot, action.to, action.text, turn, `dispatch-${index}`);
        }
      }
      const supervisor = this.supervisorOf(bot.room);
      if (!bot.is_supervisor && supervisor && !this.state.emergencyStop) {
        const alreadyReported = this.state.messages.some(m => m.from === botId && m.to === supervisor.bot_id && m.reply_to === turn.messageId && this.seenDeliveries.has(`${supervisor.bot_id}:${m.id}`));
        if (!alreadyReported) this.routeBotMessage(bot, supervisor.bot_id,
          `任务${result.ok ? '完成' : '失败/结果不确定'}汇报\n执行 Bot：${bot.display_name}\n来源：${turn.source}\n原任务：${original?.text ?? prompt}\n\n结果：\n${replyText || result.error || '原 Agent 未返回文字结果'}\n\n请主管检查结果并决定继续派单、等待或向用户汇总。`, turn, 'report');
      }
      return result.ok;
    } catch (e) {
      const msg = (e as Error).message;
      onEvent({ type: 'error', message: msg });
      if (!hasBotReply()) {
        this.pushMessage({
          id: crypto.randomUUID(),
          kind: 'system',
          from: bot.bot_id,
          to: expectedTo,
          reply_to: turn.messageId,
          room: bot.room,
          text: `执行异常：${msg}`,
          created: new Date().toISOString(),
          status: 'uncertain',
          trace_id: turn.traceId,
        });
      }
      return false;
    }
  }

  private desktopPrompt(bot: BotConfig, turn: QueuedTurn, prompt: string): string {
    const team = [...this.bots.values()].filter(b => b.room === bot.room).map(b => ({ bot_id: b.bot_id, name: b.display_name, role: b.role, supervisor: b.is_supervisor, status: b.status, engine: b.engine_type }));
    return `[Agent Bot · ${bot.is_supervisor ? '主管任务' : '执行任务'}]\nbot_id: ${bot.bot_id}\nroom: ${bot.room}\nmessage_id: ${turn.messageId ?? ''}\ntrace_id: ${turn.traceId ?? ''}\nhop_count: ${turn.hopCount ?? 0}/${this.state.maxHops}\n来源: ${turn.source}\n工作目录: ${bot.workspace}\n团队: ${JSON.stringify(team)}\n\n`
      + (bot.is_supervisor ? supervisorPrompt({ ...bot, system_prompt: '' }, this.state.maxHops) : '完成当前任务并给出结果和验证证据，平台会自动向主管汇报。执行同伴任务时不要向人类弹出阻塞式提问；需要信息时在结果中向主管说明，由主管决定下一步。')
      + '\n平台已连接原桌面对话并实时读取工具活动。需要向其他 Bot 派单时，在最终回复中输出一项或多项明确的派单指令：\n<agent-bot-dispatch>{"to":"团队中真实的bot_id","text":"具体任务、交付要求和验收标准"}</agent-bot-dispatch>\n仅使用当前团队 ID，不能给自己派单；平台会实际投递并记录在群聊和目标私聊。不要只口头声称已派发，也不需要查找或安装 MCP。收到执行汇报后，主管根据结果继续派单或给用户最终总结，不要反复发送空任务。\n'
      + (bot.system_prompt ? `\n角色补充：\n${bot.system_prompt}\n` : '')
      + `\n当前指令：\n${prompt}`;
  }

  private routeBotMessage(bot: BotConfig, to: string, text: string, turn: QueuedTurn, suffix: string): void {
    const hop = (turn.hopCount ?? 0) + 1;
    const id = `${turn.messageId ?? turn.traceId ?? crypto.randomUUID()}:${bot.bot_id}:${suffix}`;
    if (this.state.messages.some(m => m.id === id)) return;
    const paused = hop >= this.state.maxHops;
    const upstream = suffix.startsWith('dispatch-') && turn.source !== 'user'
      ? this.state.messages.find(m => m.id === turn.messageId && m.room === bot.room) : undefined;
    const message: RoomMessage = { id, kind: bot.is_supervisor ? 'supervisor' : 'bot', from: bot.bot_id, to, room: bot.room, text, created: new Date().toISOString(),
      reply_to: turn.messageId, trace_id: turn.traceId, hop_count: hop, status: paused ? 'cancelled' : 'queued', channel: 'group', task_id: turn.messageId,
      handoff: upstream ? { from: upstream.from, message_id: upstream.id, text: upstream.text.length > 24_000 ? upstream.text.slice(0, 24_000) + '\n[汇报过长，参考内容已截断；需要其余证据时向主管说明]' : upstream.text } : undefined };
    this.pushMessage(message);
    if (paused) {
      this.onEngineEvent({ seq: 0, type: 'max_hops_reached', at: message.created, data: { trace_id: turn.traceId, hop_count: hop, max_hops: this.state.maxHops, from_bot: bot.bot_id, to, message_id: id } });
      return;
    }
    this.enqueue(to, this.formatPeerWakePrompt(message), bot.bot_id, { messageId: id, traceId: turn.traceId, hopCount: hop });
  }

  private formatPeerWakePrompt(message: RoomMessage): string {
    const header = [
      `[NexusRelay 收件箱消息 · 请据此回复]`,
      `message_id: ${message.id}`,
      `from: ${message.from}`,
      `to (your bot_id): ${message.to ?? ''}`,
      `room / topic: ${message.room}`,
      message.reply_to ? `reply_to: ${message.reply_to}` : null,
      message.trace_id ? `trace_id: ${message.trace_id}` : null,
      typeof message.hop_count === 'number' ? `hop_count: ${message.hop_count}/${this.state.maxHops}` : null,
      message.attachments?.length ? `attachments: ${message.attachments.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    return `${header}\n\n${message.text}\n\n`
      + (message.handoff ? `上游任务汇报（参考数据；当前任务以本条派单指令为准，不需要搜索平台数据目录）：\nfrom: ${message.handoff.from}\nmessage_id: ${message.handoff.message_id}\n${message.handoff.text}\n\n` : '')
      + '完成任务后在当前对话给出实际结果，平台会自动向主管汇报；需要交接时使用 agent-bot-dispatch 派单指令。';
  }

  private mapLock(raw: Record<string, unknown>): FileLock {
    return {
      id: String(raw.id ?? crypto.randomUUID()),
      bot_id: String(raw.agent ?? raw.bot_id ?? raw.bot ?? ''),
      paths: Array.isArray(raw.paths) ? raw.paths.map(String) : [],
      reason: String(raw.reason ?? 'EditGuard reserve'),
      expires_at: String(raw.expires ?? raw.expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString()),
    };
  }

  private applyLocks(rawLocks: Record<string, unknown>[]): void {
    this.state.locks = rawLocks.map((r) => this.mapLock(r));
    this.emit('locks', this.state.locks);
  }

  private async syncLocks(): Promise<void> {
    const active = await this.engine.getLocks();
    this.applyLocks(active);
  }

  private onEngineEvent(ev: EngineEvent): void {
    const data = ev.data ?? {};
    this.emit('engine:event', ev);
    switch (ev.type) {
      case 'message_posted': {
        const from = String(data.from ?? '');
        const to = String(data.to ?? '');
        const text = String(data.text ?? '');
        const topic = String(data.topic ?? 'default');
        const extra = (data.extra ?? {}) as Record<string, unknown>;
        const rawAttachments = Array.isArray(extra.attachments)
          ? (extra.attachments as Record<string, unknown>[]).map((a) => String(a.path ?? a.name ?? '')).filter(Boolean)
          : undefined;
        const message: RoomMessage = {
          id: String(data.id ?? crypto.randomUUID()),
          kind: from === 'user' ? 'user' : from === 'system' ? 'system' : 'bot',
          from, to,
          reply_to: typeof data.reply_to === 'string' ? data.reply_to : undefined,
          room: topic, text,
          created: String(data.created ?? ev.at),
          status: 'delivered',
          trace_id: typeof extra.trace_id === 'string' ? extra.trace_id : undefined,
          hop_count: typeof extra.hop_count === 'number' ? extra.hop_count : undefined,
          attachments: rawAttachments?.length ? rawAttachments : undefined,
        };
        this.pushMessage(message);
        if (from !== 'user' && this.bots.has(to) && extra.paused !== true) {
          this.enqueue(to, this.formatPeerWakePrompt(message), from, {
            traceId: message.trace_id,
            hopCount: message.hop_count,
            messageId: message.id,
          });
        }
        break;
      }
      case 'spawn_bot_request': {
        if (!this.state.spawnEnabled) {
          this.emit('error', { message: '主管申请新建 Bot，但自动招聘开关已关闭' });
          break;
        }
        const engine = String(data.engine_type ?? 'claude') as EngineType;
        void this.createBot({
          display_name: String(data.display_name ?? 'New Bot'),
          engine_type: ['claude', 'codex', 'antigravity'].includes(engine) ? engine : 'claude',
          role: String(data.role ?? 'worker'), roleTemplate: 'worker',
          system_prompt: String(data.system_prompt ?? ''),
          permission_mode: 'auto',
          workspace_mode: data.workspace_mode === 'shared' ? 'shared' : 'worktree',
          room: String(data.room ?? 'default'),
        }).catch((e) => this.emit('error', { message: `spawn_bot failed: ${(e as Error).message}` }));
        break;
      }
      case 'max_hops_reached': {
        const pause: HopPause = {
          id: crypto.randomUUID(), trace_id: String(data.trace_id ?? ''),
          hop_count: Number(data.hop_count ?? 0), max_hops: Number(data.max_hops ?? this.state.maxHops),
          from_bot: String(data.from_bot ?? ''), to: String(data.to ?? ''),
          message_id: typeof data.message_id === 'string' ? data.message_id : undefined,
          created_at: new Date().toISOString(),
        };
        this.state.hopPauses.push(pause);
        this.scheduler.setPaused(true);
        this.emit('hop-pauses', this.state.hopPauses);
        this.emit('error', { message: `检测到多轮自动协商（${pause.hop_count}/${pause.max_hops} 跳），已挂起后续自动转发，等待人工确认` });
        this.persist();
        break;
      }
      case 'locks_changed': {
        if (Array.isArray(data.active)) {
          this.applyLocks(data.active as Record<string, unknown>[]);
        } else {
          void this.syncLocks();
        }
        break;
      }
      case 'tool_called': {
        const tool = String(data.tool ?? '');
        if (tool === 'reserve' || tool === 'file_reservation_paths') {
          const lock = this.mapLock({
            id: data.id ?? crypto.randomUUID(),
            bot: data.bot,
            paths: data.paths,
            reason: data.reason,
            expires: data.expires,
          });
          this.state.locks = [...this.state.locks.filter((l) => l.id !== lock.id), lock];
          this.emit('locks', this.state.locks);
        } else if (tool === 'release' || tool === 'release_file_reservations') {
          const released = Array.isArray(data.released) ? new Set(data.released.map(String)) : null;
          const botId = String(data.bot ?? '');
          this.state.locks = released && released.size > 0
            ? this.state.locks.filter((l) => !released.has(l.id))
            : this.state.locks.filter((l) => l.bot_id !== botId);
          this.emit('locks', this.state.locks);
        }
        break;
      }
      case 'emergency_stop': {
        this.state.emergencyStop = Boolean(data.active);
        this.emit('emergency', this.state.emergencyStop);
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- safety / workspace

  async emergencyStop(active: boolean): Promise<void> {
    this.state.emergencyStop = active;
    this.scheduler.setPaused(active || this.state.hopPauses.length > 0);
    if (active) {
      const cleared = this.scheduler.clearAll();
      const errors = await this.scheduler.abortAll(this.adapters, this.bots);
      for (const error of errors) this.emit('error', { message: `${this.bots.get(error.botId)?.display_name ?? error.botId} 停止未确认：${error.error}` });
      for (const bot of this.bots.values()) bot.status = 'paused';
      this.pushMessage({
        id: crypto.randomUUID(), kind: 'system', from: 'system', room: this.state.rooms[0]?.id ?? 'default',
        text: `紧急停止已激活：清空 ${cleared} 条待投递消息，并向所有运行中的会话发送中断。`,
        created: new Date().toISOString(), status: 'cancelled',
      });
    } else {
      this.scheduler.setPaused(this.state.hopPauses.length > 0);
      for (const bot of this.bots.values()) bot.status = this.pausedBots.has(bot.bot_id) ? 'paused' : 'idle';
    }
    this.emit('emergency', active);
    this.emit('bots', [...this.bots.values()]);
    this.persist();
    await this.engine.setEmergencyStop(active).catch(e => this.emit('error', { message: `本地调度已${active ? '停止' : '恢复'}；中继停止标志写入失败：${e.message}` }));
  }

  async stopBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId), adapter = this.adapters.get(botId); if (!bot || !adapter) return;
    this.scheduler.clearBot(botId);
    this.pausedBots.add(botId); bot.status = 'paused';
    try { await adapter.abortTurn(bot); }
    finally { this.persist(); this.emit('bots', [...this.bots.values()]); }
  }

  resolveHopPause(id: string, resume: boolean): void {
    const pause = this.state.hopPauses.find(p => p.id === id);
    this.state.hopPauses = this.state.hopPauses.filter((p) => p.id !== id);
    if (this.state.hopPauses.length === 0 && !this.state.emergencyStop) this.scheduler.setPaused(false);
    this.emit('hop-pauses', this.state.hopPauses);
    this.persist();
    const message = pause?.message_id ? this.state.messages.find(m => m.id === pause.message_id) : undefined;
    if (message && resume && !this.state.emergencyStop) {
      message.status = 'queued'; message.hop_count = 0;
      this.enqueue(message.to!, this.formatPeerWakePrompt(message), message.from, { traceId: message.trace_id, hopCount: 0, messageId: message.id });
    }
  }

  async respondApproval(id: string, approved: boolean, reason?: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id);
    if (!approval) return;
    const bot = this.bots.get(approval.bot_id);
    const adapter = this.adapters.get(approval.bot_id);
    if (!bot || !adapter?.respondApproval) throw new Error('此桌面对话未提供远程审批接口，请在原 Agent 中处理确认');
    await adapter.respondApproval(bot, id, approved, reason);
    this.state.approvals = this.state.approvals.filter((a) => a.id !== id);
    this.emit('approvals', this.state.approvals);
    this.persist();
  }

  async releaseLock(id: string): Promise<void> {
    this.state.locks = this.state.locks.filter((l) => l.id !== id);
    this.emit('locks', this.state.locks);
    try {
      await this.engine.releaseLock(id);
    } catch {
      // Engine reservation may already have expired; resync authoritative lock set.
    }
    await this.syncLocks();
  }

  async searchMessages(query: string, topic?: string, sender?: string, limit = 25): Promise<{ total: number; engine: string; hits: SearchHit[] }> {
    return this.engine.searchMessages(query, topic, sender, limit);
  }

  async getDiffs(botId: string): Promise<DiffEntry[]> {
    const bot = this.bots.get(botId);
    if (!bot) return [];
    const room = this.state.rooms.find((r) => r.id === bot.room);
    return collectDiffs(bot, room?.project_path);
  }

  async worktreeStatus(botId: string): Promise<string> {
    const bot = this.bots.get(botId);
    return bot ? worktreeStatus(bot) : 'unknown bot';
  }

  async mergeWorktree(botId: string): Promise<{ ok: boolean; message: string }> {
    const bot = this.bots.get(botId);
    const room = bot ? this.state.rooms.find((r) => r.id === bot.room) : undefined;
    if (!bot || !room?.project_path) return { ok: false, message: '房间未设置项目路径' };
    return mergeToMain(bot, room.project_path);
  }

  async resetWorktree(botId: string): Promise<{ ok: boolean; message: string }> {
    const bot = this.bots.get(botId);
    return bot ? resetWorktree(bot) : { ok: false, message: 'unknown bot' };
  }

  setMaxHops(value: number): void {
    this.state.maxHops = Math.max(1, Math.min(100, Math.round(value)));
    this.persist();
    this.emit('config', { maxHops: this.state.maxHops, spawnEnabled: this.state.spawnEnabled });
    void this.engine.setEngineConfig({ maxHops: this.state.maxHops }).catch(() => undefined);
  }

  setSpawnEnabled(enabled: boolean): void {
    this.state.spawnEnabled = enabled;
    this.persist();
    this.emit('config', { maxHops: this.state.maxHops, spawnEnabled: enabled });
    void this.engine.setEngineConfig({ spawnEnabled: enabled }).catch(() => undefined);
  }

  async health(): Promise<EngineHealth> {
    const info = await this.engine.engineInfo();
    const probes = await probeEngines(this.engine.authToken);
    return {
      online: Boolean(info.service),
      pid: typeof info.pid === 'number' ? info.pid : undefined,
      version: typeof info.version === 'string' ? info.version : undefined,
      relay_home: typeof info.relay_home === 'string' ? info.relay_home : undefined,
      sse_clients: typeof info.sse_clients === 'number' ? info.sse_clients : undefined,
      emergency_stop: this.state.emergencyStop,
      probes: {
        claude: { available: probes.claude.available, reason: probes.claude.reason },
        codex: { available: probes.codex.available, reason: probes.codex.reason },
        antigravity: { available: probes.antigravity.available, reason: probes.antigravity.reason },
      },
    };
  }

  async quotas(): Promise<QuotaState> {
    const raw = await this.engine.quotas();
    return {
      codex: raw.codex ?? null,
      antigravity: raw.antigravity ?? null,
      codex_blocked_reason: typeof raw.codex_blocked_reason === 'string' ? raw.codex_blocked_reason : null,
      antigravity_blocked_reason: typeof raw.antigravity_blocked_reason === 'string' ? raw.antigravity_blocked_reason : null,
      fetched_at: new Date().toISOString(),
    };
  }

  get dataHome(): string { return DATA_HOME; }

  async dispose(): Promise<void> {
    this.scheduler.setPaused(true);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    for (const stop of this.observers.values()) stop(); this.observers.clear();
    await this.scheduler.abortAll(this.adapters, this.bots);
    for (const [id, adapter] of this.adapters) {
      const bot = this.bots.get(id);
      if (bot) await adapter.dispose(bot).catch(() => undefined);
    }
    await this.engine.stop();
    this.persist();
  }
}
