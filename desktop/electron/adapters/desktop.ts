import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { AgentAdapter, DesktopObservation, SessionHandle, HealthResult } from './types';
import type { AgentStreamEvent, BotConfig, DesktopSession, EngineType, PermissionSnapshot, TurnResult } from '../../src/types';
import { CodexDesktopClient } from '../desktop/codex-ipc';
import { alive, claudeHome, claudeJournal, JournalTail, journalObservations, jsonFile, listClaudeSessions, listCodexSessions } from '../desktop/journals';
import { gravityCall, gravityCreate, gravityModels, gravityModelNumber, gravitySend, gravitySessions, gravityTargets, type GravityTarget, type Json } from '../desktop/antigravity-rpc';

const unknownPermissions = (detail: string): PermissionSnapshot => ({ source: 'unknown', observed_at: new Date().toISOString(), detail, can_apply: false });

/** Desktop observers are shared by passive mirroring and active turns, so an event is read once. */
abstract class ObservedDesktopAdapter implements AgentAdapter {
  abstract readonly engineType: EngineType;
  protected callback?: (event: DesktopObservation) => void;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private refreshPromise?: Promise<void>;
  protected active?: { text: string; messages: Map<string, string>; done: boolean; error?: string; cancelled: boolean; onEvent: (ev: AgentStreamEvent) => void };
  protected working = false;
  abstract createSession(bot: BotConfig): Promise<SessionHandle>;
  abstract healthCheck(): Promise<HealthResult>;
  abstract listSessions(): Promise<DesktopSession[]>;
  protected abstract poll(bot: BotConfig): Promise<void>;
  protected abstract dispatch(bot: BotConfig, prompt: string): Promise<void>;
  abstract abortTurn(bot: BotConfig): Promise<void>;

  protected refresh(bot: BotConfig): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const promise = this.poll(bot).finally(() => { if (this.refreshPromise === promise) this.refreshPromise = undefined; });
    this.refreshPromise = promise; return promise;
  }

  protected publish(observation: DesktopObservation): void {
    if (observation.type === 'state') this.working = observation.working;
    if (this.active) {
      if (observation.type === 'message' && observation.role === 'assistant') {
        const previous = this.active.messages.get(observation.id);
        const separator = previous === undefined && this.active.messages.size ? '\n\n' : '';
        this.active.messages.set(observation.id, (previous ?? '') + observation.text);
        this.active.text = [...this.active.messages.values()].join('\n\n');
        this.active.onEvent({ type: 'text_delta', text: separator + observation.text });
      } else if (observation.type === 'activity') {
        this.active.onEvent(observation.event);
        if (observation.event.type === 'turn_completed') this.active.done = true;
        if (observation.event.type === 'error') { this.active.error = observation.event.message; this.active.done = true; }
      }
      // Active turn text is persisted by the orchestrator with task/trace ownership.
      if (observation.type !== 'message' && observation.type !== 'activity') this.callback?.(observation);
    } else this.callback?.(observation);
  }

  observe(bot: BotConfig, callback: (event: DesktopObservation) => void): () => void {
    this.callback = callback;
    const tick = async (): Promise<void> => {
      if (this.polling) return;
      this.polling = true;
      try { await this.refresh(bot); } catch (e) { if (this.active) { this.active.error = (e as Error).message; this.active.done = true; } this.callback?.({ type: 'activity', event: { type: 'error', message: `桌面事件流断开：${(e as Error).message}`, uncertain: true } }); }
      finally { this.polling = false; }
    };
    void tick(); this.timer = setInterval(() => { void tick(); }, 1000); this.timer.unref();
    return () => { if (this.timer) clearInterval(this.timer); this.callback = undefined; };
  }

  async sendTurn(bot: BotConfig, prompt: string, onEvent: (event: AgentStreamEvent) => void): Promise<TurnResult> {
    if (this.active) return { ok: false, error: '此桌面对话正在执行 Agent Bot 任务' };
    await this.refresh(bot);
    if (this.working) return { ok: false, error: '原 Agent 正在执行任务；等待原对话结束后再派单，未插入新指令' };
    const turn = { text: '', messages: new Map<string, string>(), done: false, cancelled: false, onEvent, error: undefined as string | undefined };
    this.active = turn;
    let standalone: NodeJS.Timeout | undefined;
    if (!this.timer) standalone = setInterval(() => { void this.refresh(bot).catch(e => { turn.error = e.message; turn.done = true; }); }, 500);
    try {
      await this.dispatch(bot, prompt);
      const deadline = Date.now() + 30 * 60_000;
      while (!turn.done && !turn.cancelled && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
      if (!turn.done && !turn.cancelled) turn.error = '等待桌面任务完成超时；执行结果不确定，请查看原对话，不会自动重发';
      if (turn.cancelled) turn.error = '任务已请求中断，请以原 Agent 的停止状态为准';
      return { ok: !turn.error, sessionId: bot.external_session_id, text: turn.text, nativeMessageIds: [...turn.messages.keys()], error: turn.error, uncertain: !!turn.error };
    } catch (e) { return { ok: false, sessionId: bot.external_session_id, text: turn.text, nativeMessageIds: [...turn.messages.keys()], error: (e as Error).message, uncertain: true }; }
    finally { if (standalone) clearInterval(standalone); this.active = undefined; }
  }

  async applySettings(bot: BotConfig): Promise<void> {
    if (bot.permission_mode !== 'inherit') throw new Error('该桌面接口无法修改权限，请在原 Agent 中设置；Agent Bot 当前仅能继承实际权限');
  }
  async dispose(_bot: BotConfig): Promise<void> { if (this.timer) clearInterval(this.timer); this.callback = undefined; }
}

export class CodexDesktopAdapter extends ObservedDesktopAdapter {
  readonly engineType = 'codex' as const;
  private readonly client = new CodexDesktopClient();
  private tail?: JournalTail;
  private snapshot?: Json;
  private readonly seenRequests = new Set<string>();

  async healthCheck(): Promise<HealthResult> { try { await this.client.connect(); return { available: true, detail: { mode: 'desktop' } }; } catch (e) { return { available: false, reason: `请启动 Codex 桌面端：${(e as Error).message}` }; } }
  async listSessions(): Promise<DesktopSession[]> { return listCodexSessions(); }
  async createSession(bot: BotConfig): Promise<SessionHandle> {
    if (!bot.external_session_id) throw new Error('请选择 Codex 桌面中已创建的真实对话，并在原应用中打开该对话');
    if (bot.external_session_id === process.env.CODEX_THREAD_ID) throw new Error('不能将正在开发本平台的对话绑定成执行 Bot，请在 Codex 桌面中新建独立对话');
    const state = await this.client.follow(bot.external_session_id);
    this.snapshot = state;
    this.seenRequests.clear();
    if (state.cwd) bot.workspace = state.cwd;
    bot.connection_mode = 'desktop';
    bot.model ??= state.latestModel;
    bot.reasoning_effort ??= state.latestReasoningEffort;
    bot.permissions = this.permissions(state);
    if (state.rolloutPath && (!this.tail || this.tail.file !== state.rolloutPath)) this.tail = new JournalTail(state.rolloutPath);
    return { externalSessionId: bot.external_session_id };
  }
  private permissions(state: Json): PermissionSnapshot {
    const value = state.currentPermissions ?? state.latestThreadSettings;
    return value ? { source: 'desktop_session', approval_policy: String(value.approvalPolicy ?? 'unknown'), sandbox: String(value.sandboxPolicy?.type ?? value.activePermissionProfile?.id ?? 'unknown'), observed_at: new Date().toISOString(), detail: '从 Codex 原桌面对话快照读取', can_apply: true } : unknownPermissions('原桌面对话暂未提供权限快照');
  }
  protected async poll(bot: BotConfig): Promise<void> {
    const state = this.client.snapshots.get(bot.external_session_id ?? '') ?? await this.client.follow(bot.external_session_id!);
    if (!state) return;
    if (state.rolloutPath && (!this.tail || this.tail.file !== state.rolloutPath)) this.tail = new JournalTail(state.rolloutPath);
    for (const entry of this.tail?.read() ?? []) for (const observation of journalObservations(entry, 'codex')) this.publish(observation);
    const requests = Array.isArray(state.requests) ? state.requests : [];
    for (const request of requests) {
      const id = String(request.id);
      if (this.seenRequests.has(id)) continue;
      if (/Approval|approval/.test(request.method ?? request.type ?? '')) {
        this.seenRequests.add(id);
        this.publish({ type: 'activity', event: { type: 'approval_required', requestId: id, command: String(request.params?.command ?? request.params?.reason ?? request.method), files: request.params?.paths ?? (request.params?.changes ? Object.keys(request.params.changes) : []) } });
      }
    }
    this.publish({ type: 'state', working: state.threadRuntimeStatus?.type === 'active', permissions: this.permissions(state), model: state.latestModel, approvalIds: requests.filter((r: Json) => /Approval|approval/.test(r.method ?? r.type ?? '')).map((r: Json) => String(r.id)) });
  }
  private settings(bot: BotConfig): Json {
    const settings: Json = { ...(bot.model ? { model: bot.model } : {}), ...(bot.reasoning_effort ? { effort: bot.reasoning_effort } : {}) };
    if (bot.model) {
      const state = this.client.snapshots.get(bot.external_session_id ?? '') ?? this.snapshot;
      const current = state?.latestCollaborationMode ?? state?.latestThreadSettings?.collaborationMode;
      settings.collaborationMode = { mode: current?.mode ?? 'default', settings: { ...current?.settings, model: bot.model, reasoning_effort: bot.reasoning_effort ?? state?.latestReasoningEffort ?? null, developer_instructions: current?.settings?.developer_instructions ?? null } };
    }
    if (bot.permission_mode !== 'inherit') {
      settings.approvalPolicy = bot.permission_mode === 'auto' ? 'never' : 'on-request';
      settings.sandboxPolicy = bot.permission_mode === 'read_only' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [bot.workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      const profile = bot.permission_mode === 'read_only' ? ':read-only' : ':workspace';
      settings.activePermissionProfile = { id: profile, extends: null }; settings.permissions = profile;
    }
    return settings;
  }
  async applySettings(bot: BotConfig): Promise<void> {
    await this.refresh(bot);
    if (this.working || this.active) throw new Error('请等待原对话当前任务结束后再修改模型或权限');
    const id = bot.external_session_id!;
    const state = this.client.snapshots.get(id) ?? this.snapshot!;
    const response = await this.client.request('thread-follower-update-thread-settings', { conversationId: id, threadSettings: { ...state.latestThreadSettings, ...this.settings(bot) }, condition: null }, this.client.owners.get(id));
    if (response.result?.applied === false) throw new Error('Codex 桌面端未应用设置，请刷新后重试');
  }
  protected async dispatch(bot: BotConfig, prompt: string): Promise<void> {
    const id = bot.external_session_id!;
    await this.client.request('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }], ...this.settings(bot) }, context: { inheritThreadSettings: true } } }, this.client.owners.get(id));
  }
  async respondApproval(bot: BotConfig, requestId: string, approved: boolean): Promise<void> {
    const id = bot.external_session_id!, snapshot = this.client.snapshots.get(id) ?? this.snapshot;
    const request = snapshot?.requests?.find((r: Json) => String(r.id) === requestId);
    if (!request) throw new Error('原 Agent 中该权限请求已结束，请刷新');
    if (request.method === 'item/permissions/requestApproval') {
      await this.client.request('thread-follower-permissions-request-approval-response', { conversationId: id, requestId: request.id, response: { permissions: approved ? request.params?.permissions ?? {} : {}, scope: 'turn' } }, this.client.owners.get(id));
      return;
    }
    if (!['item/fileChange/requestApproval', 'item/commandExecution/requestApproval'].includes(request.method)) throw new Error('此类确认请在原 Agent 中处理，平台未伪造批准结果');
    const method = /file|patch/i.test(request.method ?? request.type) ? 'thread-follower-file-approval-decision' : 'thread-follower-command-approval-decision';
    await this.client.request(method, { conversationId: id, requestId: request.id, decision: approved ? 'accept' : 'decline' }, this.client.owners.get(id));
  }
  async abortTurn(bot: BotConfig): Promise<void> {
    if (!this.active && !this.working) return;
    await this.client.request('thread-follower-interrupt-turn', { conversationId: bot.external_session_id, mode: 'user-stop' }, this.client.owners.get(bot.external_session_id!));
    if (this.active) this.active.cancelled = true;
  }
  async dispose(bot: BotConfig): Promise<void> { await super.dispose(bot); this.client.close(); }
}

export class ClaudeDesktopAdapter extends ObservedDesktopAdapter {
  readonly engineType = 'claude' as const;
  private entry?: Json;
  private tail?: JournalTail;
  async listSessions(): Promise<DesktopSession[]> { return listClaudeSessions(); }
  async healthCheck(): Promise<HealthResult> { const sessions = await this.listSessions(); return { available: sessions.length > 0, reason: sessions.length ? undefined : '请在 Claude 桌面 Code 中打开独立对话并启用 Remote Control，保持会话运行' }; }
  async createSession(bot: BotConfig): Promise<SessionHandle> {
    const sessions = await this.listSessions(), selected = sessions.find(s => s.id === bot.external_session_id);
    if (!selected) throw new Error('未找到运行中的 Claude 桌面对话，请在原应用中打开独立 Code 会话并选择它');
    this.entry = jsonFile(path.join(claudeHome(), 'sessions', `${selected.target_id}.json`));
    const file = claudeJournal(selected.id); if (!file) throw new Error('Claude 桌面对话还没有可读取的执行日志，请先在原对话中发送初始化消息');
    this.tail = new JournalTail(file); bot.workspace = selected.workspace; bot.connection_mode = 'desktop';
    bot.permissions = this.permissionSnapshot();
    return { externalSessionId: selected.id };
  }
  private permissionSnapshot(): PermissionSnapshot {
    const config = jsonFile(path.join(claudeHome(), 'settings.json'));
    return config?.permissions?.defaultMode ? { source: 'desktop_config', approval_policy: String(config.permissions.defaultMode), observed_at: new Date().toISOString(), detail: 'Claude 配置默认值；桌面会话可能存在临时覆盖，请以原 Agent 的确认提示为准', can_apply: false } : unknownPermissions('Claude 会话注册表未公开有效权限；继承原桌面设置，不能从 Agent Bot 提升权限');
  }
  protected async poll(_bot: BotConfig): Promise<void> {
    if (!this.entry || !alive(Number(this.entry.pid))) throw new Error('Claude 桌面 Code 会话已退出，请在原应用中恢复会话后重连');
    for (const entry of this.tail?.read() ?? []) {
      if (entry.type === 'assistant' && entry.message?.model) _bot.model = entry.message.model;
      for (const observation of journalObservations(entry, 'claude')) {
        this.publish(observation);
      }
    }
    const registry = jsonFile(path.join(claudeHome(), 'sessions', `${this.entry.pid}.json`));
    const working = /working|running|busy/i.test(String(registry?.status ?? ''));
    this.publish({ type: 'state', working, permissions: this.permissionSnapshot(), model: _bot.model });
  }
  protected async dispatch(bot: BotConfig, prompt: string): Promise<void> {
    if (bot.permission_mode !== 'inherit') throw new Error('Claude 桌面权限只能在原 Agent 内修改，请选择“继承原 Agent”');
    const entry = this.entry!;
    if (!/^\\\\[.?]\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i.test(entry.messagingSocketPath ?? '')) throw new Error('Claude 桌面未提供有效的本地收件箱');
    const dir = path.join(claudeHome(), 'sessions'); let token: string | undefined;
    for (const file of fs.readdirSync(dir).filter(f => f.startsWith(`${entry.pid}.`) && f.endsWith('.key'))) {
      const key = jsonFile(path.join(dir, file));
      if (key?.procStartFt != null && String(key.procStartFt) !== String(entry.procStart)) continue;
      if (/^[0-9a-f]{32}$/.test(key?.peerToken ?? '')) { token = key!.peerToken; break; }
    }
    if (!token) throw new Error('Claude 桌面会话收件箱凭据已过期，请重新打开原对话');
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(entry.messagingSocketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Claude 收件箱投递未确认，请查看原对话，不会自动重发')); }, 5000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => {
        socket.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: `<cross-session-message from-name="Agent Bot">\n${prompt}\n</cross-session-message>` } }) + '\n', () => { clearTimeout(timer); resolve(); });
      });
    });
  }
  async applySettings(bot: BotConfig): Promise<void> {
    await super.applySettings(bot);
    if (bot.model) throw new Error('Claude 当前桌面收件箱不开放模型切换，请在原应用中选择模型；Agent Bot 会读取实际执行模型');
  }
  async abortTurn(_bot: BotConfig): Promise<void> {
    if (this.active || this.working) { if (this.active) this.active.cancelled = true; throw new Error('已停止 Agent Bot 后续调度；Claude 收件箱不支持远程停止，请在原对话点击停止'); }
  }
}

export class AntigravityDesktopAdapter extends ObservedDesktopAdapter {
  readonly engineType = 'antigravity' as const;
  private target?: GravityTarget;
  private readonly steps = new Map<number, string>();
  private knownSteps = 0;
  private pendingTurn = false;
  private turnBaseline = 0;
  private readonly responseText = new Map<number, string>();
  private readonly toolStarts = new Set<string>();
  private readonly toolResults = new Map<number, string>();
  async listSessions(): Promise<DesktopSession[]> { return gravitySessions(); }
  async healthCheck(): Promise<HealthResult> { try { const targets = await gravityTargets(); return { available: targets.length > 0, reason: targets.length ? undefined : '请打开并登录反重力桌面端' }; } catch (e) { return { available: false, reason: (e as Error).message }; } }
  private async resolve(bot: BotConfig): Promise<GravityTarget> {
    const targets = await gravityTargets();
    let target = targets.find(t => String(t.pid) === bot.desktop_target_id) ?? (!bot.desktop_target_id ? targets[0] : undefined);
    if (!target && bot.external_session_id) {
      // Desktop process IDs change after restart. Rebind only after proving the SAME conversation exists.
      for (const candidate of targets) {
        try { if ((await gravityCall(candidate, 'GetCascadeTrajectory', { cascadeId: bot.external_session_id })).trajectory) { target = candidate; break; } } catch { /* read-only lookup */ }
      }
    }
    if (!target) throw new Error('反重力桌面连接已离线，请选择当前运行的桌面对话后重连');
    this.target = target; bot.desktop_target_id = String(target.pid); return target;
  }
  async createSession(bot: BotConfig): Promise<SessionHandle> {
    const target = await this.resolve(bot);
    if (!bot.external_session_id) bot.external_session_id = await gravityCreate(target, pathToFileURL(bot.workspace).href);
    const data = await gravityCall(target, 'GetCascadeTrajectory', { cascadeId: bot.external_session_id });
    if (!data.trajectory) throw new Error('反重力桌面未找到此对话，未创建替代会话');
    const summaries = await gravityCall(target, 'GetAllCascadeTrajectories');
    const uri = summaries.trajectorySummaries?.[bot.external_session_id!]?.workspaces?.[0]?.workspaceFolderAbsoluteUri;
    if (typeof uri === 'string' && uri.startsWith('file:')) bot.workspace = fileURLToPath(uri);
    this.knownSteps = 0; this.steps.clear(); this.responseText.clear(); this.toolStarts.clear(); this.toolResults.clear(); bot.connection_mode = 'desktop';
    bot.permissions = unknownPermissions('继承反重力桌面权限；Cascade 接口未提供完整权限等级，请在原应用中设置');
    const models = await gravityModels(target);
    if (bot.model && !models.some(model => model.id === bot.model)) throw new Error('所选模型不是此反重力桌面账号提供的模型，请刷新模型列表');
    if (!bot.model) {
      const planner = [...(data.trajectory.steps ?? [])].reverse().find((s: Json) => s.userInput?.userConfig?.plannerConfig)?.userInput.userConfig.plannerConfig;
      bot.model = planner?.planModel ?? planner?.requestedModel?.model ?? models[0]?.id;
    }
    return { externalSessionId: bot.external_session_id! };
  }
  protected async poll(bot: BotConfig): Promise<void> {
    if (!this.target || !bot.external_session_id) return;
    const data = await gravityCall(this.target, 'GetCascadeTrajectory', { cascadeId: bot.external_session_id });
    const steps: Json[] = data.trajectory?.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], signature = JSON.stringify(step);
      if (this.steps.get(i) === signature) continue;
      const previous = this.steps.get(i); this.steps.set(i, signature);
      const at = step.metadata?.createdAt ?? new Date().toISOString(), id = `${bot.external_session_id}:${i}`;
      if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        const text = step.userInput?.userResponse || (step.userInput?.items ?? []).map((item: Json) => item.text ?? '').join('\n');
        if (text && !text.includes('[Agent Bot ·') && !previous) this.publish({ type: 'message', id, role: 'user', text, at });
        const planner = step.userInput?.userConfig?.plannerConfig;
        if (!previous && (planner?.planModel ?? planner?.requestedModel?.model)) this.publish({ type: 'state', working: data.status !== 'CASCADE_RUN_STATUS_IDLE', model: planner.planModel ?? planner.requestedModel.model, permissions: bot.permissions });
      } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        const planner = step.plannerResponse ?? {};
        const response = planner.modifiedResponse || planner.response || '';
        if (response && response !== this.responseText.get(i)) {
          const previousText = this.responseText.get(i) ?? ''; this.responseText.set(i, response);
          this.publish({ type: 'message', id, role: 'assistant', text: this.active && response.startsWith(previousText) ? response.slice(previousText.length) : response, at });
        }
        for (const [index, call] of (planner.toolCalls ?? []).entries()) {
          const key = String(call.id ?? `${i}:${index}`);
          if (this.toolStarts.has(key)) continue; this.toolStarts.add(key);
          this.publish({ type: 'activity', event: { type: 'tool_call_start', tool: String(call.name ?? call.toolName ?? call.function?.name ?? 'tool'), args: typeof call.argumentsJson === 'string' ? call.argumentsJson.slice(0, 4000) : JSON.stringify(call.arguments ?? call.function?.arguments ?? {}).slice(0, 4000) } });
        }
      } else if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
        this.publish({ type: 'activity', event: { type: 'error', message: String(step.errorMessage?.userErrorMessage ?? step.errorMessage?.error ?? step.errorMessage?.message ?? '反重力桌面执行失败') } });
      } else if (!/CHECKPOINT|EPHEMERAL|CONVERSATION_HISTORY/.test(step.type ?? '')) {
        const tool = String(step.metadata?.toolCall?.name ?? step.type ?? 'desktop_tool').replace('CORTEX_STEP_TYPE_', '').toLowerCase();
        const key = String(step.metadata?.toolCall?.id ?? `step:${i}`);
        if (tool !== 'generic' && !this.toolStarts.has(key)) { this.toolStarts.add(key); this.publish({ type: 'activity', event: { type: 'tool_call_start', tool, args: summarizeStep(step) } }); }
        const output = summarizeStep(step);
        if (tool !== 'generic' && /DONE|COMPLETED|ERROR|FAILED/.test(step.status ?? '') && this.toolResults.get(i) !== output) { this.toolResults.set(i, output); this.publish({ type: 'activity', event: { type: 'tool_call_result', tool, output, ok: !/ERROR|FAILED/.test(step.status ?? '') } }); }
      }
    }
    const working = data.status !== 'CASCADE_RUN_STATUS_IDLE';
    this.knownSteps = steps.length;
    if (this.pendingTurn && !working && steps.length > this.turnBaseline) {
      const lastInput = steps.map(s => s.type).lastIndexOf('CORTEX_STEP_TYPE_USER_INPUT');
      if (lastInput >= this.turnBaseline && steps.slice(lastInput + 1).some(s => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') && !steps.slice(lastInput + 1).some(s => /PENDING|WAITING|BLOCKED/.test(s.status ?? ''))) {
        this.pendingTurn = false; this.publish({ type: 'activity', event: { type: 'turn_completed' } });
      }
    }
    this.publish({ type: 'state', working, permissions: bot.permissions });
  }
  protected async dispatch(bot: BotConfig, prompt: string): Promise<void> {
    if (bot.permission_mode !== 'inherit') throw new Error('反重力权限请在原桌面设置，并在这里选择“继承原 Agent”');
    const target = this.target ?? await this.resolve(bot);
    const models = await gravityModels(target); const selected = models.find(m => m.id === bot.model);
    if (!selected) throw new Error('当前桌面账号未提供所选模型，请刷新后选择');
    this.pendingTurn = true; this.turnBaseline = this.knownSteps;
    await gravitySend(target, bot.external_session_id!, prompt, gravityModelNumber(selected.id), pathToFileURL(bot.workspace).href);
  }
  async applySettings(bot: BotConfig): Promise<void> {
    await super.applySettings(bot);
    await this.refresh(bot);
    if (this.working || this.active) throw new Error('请等待反重力原对话当前任务结束后再切换模型');
    if (!(await gravityModels(this.target)).some(m => m.id === bot.model)) throw new Error('此模型不在当前反重力桌面账号的列表中');
    // The model is supplied on the next message in the SAME Cascade, preserving history.
  }
  async abortTurn(bot: BotConfig): Promise<void> {
    if ((!this.active && !this.working) || !this.target) return;
    await gravityCall(this.target, 'CancelCascadeInvocation', { cascadeId: bot.external_session_id });
    if (this.active) this.active.cancelled = true; this.pendingTurn = false;
  }
}

function summarizeStep(step: Json): string {
  const publicData = Object.fromEntries(Object.entries(step).filter(([key]) => !['metadata', 'type', 'status', 'thinking', 'reasoning'].includes(key)));
  return JSON.stringify(publicData).slice(0, 8000);
}

export function desktopAdapter(engine: EngineType): AgentAdapter {
  return engine === 'codex' ? new CodexDesktopAdapter() : engine === 'claude' ? new ClaudeDesktopAdapter() : new AntigravityDesktopAdapter();
}
