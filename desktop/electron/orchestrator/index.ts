import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { EngineBridge } from '../engine';
import { DATA_HOME, STATE_FILE, ensureDirs } from '../config';
import { createAdapter, probeEngines, type AgentAdapter } from '../adapters';
import { BotScheduler, type QueuedTurn } from './scheduler';
import { createWorktree, removeWorktree, collectDiffs, mergeToMain, resetWorktree, worktreeStatus } from './worktree';
import { supervisorPrompt } from './supervisor';
import type {
  AgentStreamEvent, ApprovalRequest, BotConfig, BotStatus, CreateBotInput, DiffEntry, EngineEvent, EngineHealth,
  EngineType, FileLock, HopPause, QuotaState, Room, RoomMessage, SearchHit, StreamEvent, StudioState,
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
  private state: StudioState = { ...DEFAULT_STATE };
  private emit: Emit = () => {};
  private started = false;

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
      if (bot) { bot.status = status; this.emit('bot:status', { botId, status }); }
      void this.engine.setBotStatus(botId, status).catch(() => undefined);
    };
    this.scheduler.onQueueChange = (botId, depth) => this.emit('bot:queue', { botId, depth });
    this.scheduler.setRunner((turn) => this.runTurn(turn));

    for (const bot of this.state.bots) {
      this.bots.set(bot.bot_id, bot);
      this.adapters.set(bot.bot_id, createAdapter(bot.engine_type, this.engine.authToken));
      void this.engine.registerBot(bot).catch(() => undefined);
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
        rooms: parsed.rooms ?? [], bots: parsed.bots ?? [], messages: (parsed.messages ?? []).slice(-500),
        approvals: parsed.approvals ?? [], hopPauses: parsed.hopPauses ?? [], locks: parsed.locks ?? [],
        emergencyStop: false,
      };
    } catch {
      this.state = { ...DEFAULT_STATE };
      this.state.rooms = [{
        id: 'default', name: '默认协作房间',
        project_path: '', created_at: new Date().toISOString(),
      }];
    }
  }

  private persist(): void {
    try {
      this.state.messages = this.state.messages.slice(-500);
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
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
        status: terminal ? prev.status : message.status,
      };
      this.state.messages[idx] = updated;
      this.emit('message', updated);
      this.persist();
      return;
    }
    this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-500);
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
    const room = this.state.rooms.find((r) => r.id === input.room) ?? this.state.rooms[0];
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
    const bot: BotConfig = {
      bot_id: botId,
      display_name: input.display_name.trim() || botId,
      engine_type: input.engine_type,
      model: input.model?.trim() || undefined,
      role: input.role || input.roleTemplate,
      system_prompt: input.system_prompt,
      permission_mode: input.permission_mode,
      workspace_mode: effectiveMode,
      room: roomId,
      workspace,
      worktree_branch: worktreeBranch,
      is_supervisor: isSupervisor,
      status: 'queued',
      color: input.color ?? { claude: '#e9a23b', codex: '#3ecf8e', antigravity: '#5b9dff' }[input.engine_type],
      created_at: new Date().toISOString(),
    };
    if (isSupervisor) {
      const sup = supervisorPrompt(bot, this.state.maxHops);
      bot.system_prompt = input.system_prompt && !sup.includes(input.system_prompt)
        ? `${sup}\n\n${input.system_prompt}`
        : sup;
    }
    if (isSupervisor) {
      for (const other of this.bots.values()) {
        if (other.room === roomId && other.is_supervisor) {
          other.is_supervisor = false;
          void this.engine.registerBot(other).catch(() => undefined);
        }
      }
    }

    this.bots.set(botId, bot);
    const adapter = createAdapter(bot.engine_type, this.engine.authToken);
    this.adapters.set(botId, adapter);

    // A bot is only "bound" when a REAL independent session was created. Failures are reported,
    // never faked: the bot stays visible with status=error and no external_session_id.
    let bindingError = '';
    try {
      const session = await adapter.createSession(bot);
      bot.external_session_id = session.externalSessionId;
      bot.status = 'idle';
    } catch (e) {
      bindingError = (e as Error).message;
      bot.status = 'error';
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
    this.scheduler.clearBot(botId);
    const adapter = this.adapters.get(botId);
    if (adapter) await adapter.dispose(bot);
    if (bot.workspace_mode === 'worktree') {
      const room = this.state.rooms.find((r) => r.id === bot.room);
      if (room?.project_path) await removeWorktree(bot, room.project_path);
    }
    await this.engine.deleteBot(botId).catch(() => undefined);
    this.bots.delete(botId);
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
    const wasSupervisor = target.is_supervisor;
    for (const bot of this.bots.values()) {
      if (bot.room !== target.room) continue;
      const next = bot.bot_id === botId;
      if (bot.is_supervisor !== next) {
        bot.is_supervisor = next;
        changed.push(bot);
      }
    }
    if (!wasSupervisor) {
      const sup = supervisorPrompt(target, this.state.maxHops);
      if (!target.system_prompt.includes('SUPERVISOR') && !target.system_prompt.includes(`bot_id="${target.bot_id}"`)) {
        target.system_prompt = target.system_prompt && !sup.includes(target.system_prompt)
          ? `${sup}\n\n${target.system_prompt}`
          : sup;
      }
    }
    for (const bot of changed) {
      void this.engine.registerBot(bot).catch(() => undefined);
    }
    this.state.bots = [...this.bots.values()];
    this.persist();
    this.emit('bots', this.state.bots);
  }

  async reconnectBot(botId: string): Promise<BotConfig | null> {
    const bot = this.bots.get(botId);
    const adapter = this.adapters.get(botId);
    if (!bot || !adapter) return null;
    await adapter.abortTurn(bot).catch(() => undefined);
    try {
      const session = await adapter.createSession(bot);
      bot.external_session_id = session.externalSessionId;
      bot.status = 'idle';
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
  }

  setBotModel(botId: string, model: string): BotConfig | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    const trimmed = model.trim();
    bot.model = trimmed || undefined;
    this.state.bots = [...this.bots.values()];
    this.persist();
    this.emit('bots', this.state.bots);
    void this.engine.registerBot(bot).catch(() => undefined);
    return bot;
  }

  // ---------------------------------------------------------------- messaging

  async sendMessage(room: string, text: string, target?: string): Promise<RoomMessage> {
    const to = target ?? this.supervisorOf(room)?.bot_id;
    if (!to) throw new Error('该房间没有主管 Bot；请先新建一个主管 Bot 或 @指定 Bot');
    const fallbackTraceId = crypto.randomBytes(8).toString('hex');
    const posted = await this.engine.postUserMessage(to, text, room, fallbackTraceId);
    const traceId = posted.traceId ?? fallbackTraceId;
    const message: RoomMessage = {
      id: posted.id, kind: 'user', from: 'user', to, room, text,
      created: new Date().toISOString(), status: 'delivered', trace_id: traceId, hop_count: 0,
    };
    this.pushMessage(message);
    // Drive the real session directly; the SSE handler skips user-originated messages to avoid
    // injecting the same prompt twice into a streaming turn.
    this.enqueue(to, text, 'user', { messageId: posted.id, traceId, hopCount: 0 });
    return message;
  }

  async sendDirect(botId: string, text: string, room: string): Promise<RoomMessage> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`未知的 Bot：${botId}`);
    const traceId = crypto.randomBytes(8).toString('hex');
    let id: string;
    let resolvedTraceId = traceId;
    try {
      const posted = await this.engine.postUserMessage(botId, text, room, traceId);
      id = posted.id;
      resolvedTraceId = posted.traceId ?? traceId;
    } catch {
      id = crypto.randomUUID();
    }
    const message: RoomMessage = {
      id, kind: 'user', from: 'user', to: botId, room, text,
      created: new Date().toISOString(), status: 'delivered', trace_id: resolvedTraceId, hop_count: 0,
    };
    this.pushMessage(message);
    const directPrompt = `[NexusBot Studio 私聊纠偏 · direct]\nmessage_id: ${id}\nroom / topic: ${room}\nto (your bot_id): ${botId}\n\n${text}`;
    this.enqueue(botId, directPrompt, 'user', { messageId: id, traceId: resolvedTraceId, hopCount: 0 });
    return message;
  }

  private enqueue(botId: string, prompt: string, source: string, meta?: { traceId?: string; hopCount?: number; messageId?: string }): void {
    if (!this.bots.has(botId)) return;
    if (this.state.emergencyStop) {
      this.emit('error', { message: '紧急停止已激活，消息未投递' });
      return;
    }
    this.scheduler.enqueue({
      botId, prompt, source,
      messageId: meta?.messageId,
      traceId: meta?.traceId, hopCount: meta?.hopCount,
      onEvent: (event) => {
        const stream: StreamEvent = { bot_id: botId, at: new Date().toISOString(), event };
        this.emit('stream', stream);
        if (event.type === 'approval_required') {
          const approval: ApprovalRequest = {
            id: event.requestId, bot_id: botId, command: event.command,
            files: event.files ?? [], created_at: new Date().toISOString(),
          };
          this.state.approvals.push(approval);
          this.emit('approvals', this.state.approvals);
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
    const turnStartedAt = Date.now();
    const wrappedOnEvent = (ev: AgentStreamEvent): void => {
      if (ev.type === 'text_delta' && ev.text) streamedText += ev.text;
      else if (ev.type === 'error' && ev.message) lastError = ev.message;
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
      const result = await adapter.sendTurn(bot, prompt, wrappedOnEvent);
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

      const cleanResult = result.text && !/^\s*\{\s*"(response|conversationId|error)"/.test(result.text)
        ? result.text.trim()
        : '';
      const replyText = streamedText.trim() || cleanResult;

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
          });
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
      + `完成分析或改动后，请务必调用 MCP 工具 reply(id="${message.id}", as_bot="${message.to ?? ''}", text="...")（如需继续追问他人可调用 send）答复。`;
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
    await this.engine.setEmergencyStop(active);
    if (active) {
      const cleared = this.scheduler.clearAll();
      this.scheduler.abortAll(this.adapters, this.bots);
      for (const bot of this.bots.values()) bot.status = 'paused';
      this.pushMessage({
        id: crypto.randomUUID(), kind: 'system', from: 'system', room: this.state.rooms[0]?.id ?? 'default',
        text: `紧急停止已激活：清空 ${cleared} 条待投递消息，并向所有运行中的会话发送中断。`,
        created: new Date().toISOString(), status: 'cancelled',
      });
    } else {
      this.scheduler.setPaused(false);
      for (const bot of this.bots.values()) bot.status = 'idle';
    }
    this.emit('emergency', active);
    this.emit('bots', [...this.bots.values()]);
    this.persist();
  }

  resolveHopPause(id: string, resume: boolean): void {
    this.state.hopPauses = this.state.hopPauses.filter((p) => p.id !== id);
    if (this.state.hopPauses.length === 0) this.scheduler.setPaused(false);
    this.emit('hop-pauses', this.state.hopPauses);
    this.persist();
    if (!resume) this.scheduler.clearAll();
  }

  async respondApproval(id: string, approved: boolean, reason?: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id);
    if (!approval) return;
    const bot = this.bots.get(approval.bot_id);
    const adapter = this.adapters.get(approval.bot_id);
    if (bot && adapter?.respondApproval) await adapter.respondApproval(bot, id, approved, reason);
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
    this.scheduler.abortAll(this.adapters, this.bots);
    for (const [id, adapter] of this.adapters) {
      const bot = this.bots.get(id);
      if (bot) await adapter.dispose(bot).catch(() => undefined);
    }
    await this.engine.stop();
  }
}
