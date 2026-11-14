import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { brainDir, discoverAntigravityTarget, findAntigravityExe, findTranscriptFile, type AntigravityTarget } from '../discovery';
import type { AgentAdapter, HealthResult, SessionHandle } from './types';
import { safeJson } from './types';
import type { AgentStreamEvent, BotConfig, TurnResult } from '../../src/types';

const execFileAsync = promisify(execFile);

type AntigravityModelTier = 'flash_lite' | 'flash' | 'pro';
interface AgySession { conversationId: string; title: string; model?: AntigravityModelTier }

function normalizeAntigravityModel(model?: string): AntigravityModelTier | undefined {
  const norm = model?.trim().toLowerCase().replace(/-/g, '_');
  return norm === 'flash_lite' || norm === 'flash' || norm === 'pro' ? norm : undefined;
}

function extractInlineReply(json: Record<string, unknown> | null): string {
  if (!json) return '';
  const resp = json.response as Record<string, unknown> | undefined;
  for (const cand of [json.text, json.content, resp?.text, resp?.content]) {
    if (typeof cand === 'string' && cand.trim()) return cand.trim();
  }
  return '';
}

/** Static Antigravity MCP config cannot carry a per-conversation ?bot= URL, so every wake prompt
 *  declares its identity explicitly and the engine accepts as_bot on relay tool calls. */
function wakePreamble(bot: BotConfig): string {
  return `[NexusBot Identity: bot_id="${bot.bot_id}" | Room: "${bot.room}"] ` +
    `你是 ${bot.display_name}（${bot.role}）。仅当你的当前工具列表中已挂载 nexus-bot-studio / nexus-relay MCP 工具（send/reply/read/progress/inbox/list_bots）时才调用它们（并传入 as_bot="${bot.bot_id}"）；` +
    `若当前没有这些 MCP 工具或仅需普通对话，严禁执行命令或读文件去查找 nexus 工具，请直接用文字回复。被同伴唤醒时禁止向人类用户弹出阻塞式提问，请自行决策或用 reply 向发送方确认。`;
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return JSON.stringify(args ?? {}).slice(0, 600);
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['CommandLine', 'command', 'Path', 'path', 'AbsolutePath', 'query', 'Query', 'url', 'to']) {
    if (obj[key] !== undefined && obj[key] !== '') {
      parts.push(`${key}=${String(obj[key]).replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  return (parts.length ? parts.join(' | ') : JSON.stringify(obj)).slice(0, 600);
}

function transcriptPath(conversationId: string, root = brainDir()): string {
  return path.join(root, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

interface AgentApiResult { ok: boolean; json: Record<string, unknown> | null; raw: string; exitCode: number; uncertain: boolean }

export interface AntigravityAdapterDeps {
  spawnFn?: typeof spawn;
  discoverFn?: typeof discoverAntigravityTarget;
  brainDirFn?: typeof brainDir;
  /** Override post-send transcript settle timeouts (useful for unit tests). */
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class AntigravitySessionAdapter implements AgentAdapter {
  readonly engineType = 'antigravity' as const;
  private readonly sessions = new Map<string, AgySession>();
  private readonly watchers = new Map<string, { watcher: FSWatcher; offset: number }>();
  private readonly running = new Map<string, ChildProcess>();
  private readonly turnAborters = new Map<string, () => void>();
  private target: AntigravityTarget | null = null;
  private lastUncertain = false;
  private readonly spawnFn: typeof spawn;
  private readonly discoverFn: typeof discoverAntigravityTarget;
  private readonly brainDirFn: typeof brainDir;
  private readonly hasCustomBrainDir: boolean;
  private readonly turnTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(deps: AntigravityAdapterDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.discoverFn = deps.discoverFn ?? discoverAntigravityTarget;
    this.brainDirFn = deps.brainDirFn ?? brainDir;
    this.hasCustomBrainDir = Boolean(deps.brainDirFn);
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 20 * 60 * 1000;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 300_000;
  }

  private resolveTranscript(conversationId: string): string {
    return this.hasCustomBrainDir
      ? transcriptPath(conversationId, this.brainDirFn())
      : findTranscriptFile(conversationId, this.brainDirFn());
  }

  async healthCheck(): Promise<HealthResult> {
    const exe = findAntigravityExe();
    if (!exe) return { available: false, reason: 'language_server.exe not found (set NEXUS_BOT_ANTIGRAVITY_EXE)' };
    try {
      const { stdout } = await execFileAsync(exe, ['agentapi', '--help'], { windowsHide: true, timeout: 20_000 });
      if (!stdout.includes('new-conversation')) return { available: false, reason: 'agentapi subcommand unavailable' };
      const target = await discoverAntigravityTarget();
      if (!target) return {
        available: false,
        reason: 'agentapi present but ANTIGRAVITY_LS_ADDRESS could not be discovered; start Antigravity or set NEXUS_BOT_AGENTAPI_LS_ADDRESS / _CSRF_TOKEN',
        detail: { exe },
      };
      this.target = target;
      return { available: true, detail: { exe, lsAddress: target.lsAddress, pid: target.pid } };
    } catch (e) {
      return { available: false, reason: (e as Error).message, detail: { exe } };
    }
  }

  private async targetOrDiscover(): Promise<AntigravityTarget | null> {
    if (this.target) return this.target;
    this.target = await this.discoverFn();
    return this.target;
  }

  private runAgentApi(args: string[], timeoutMs = 120_000, botId?: string): Promise<AgentApiResult> {
    return new Promise((resolve) => {
      const target = this.target;
      if (!target) { resolve({ ok: false, json: null, raw: 'no language server target', exitCode: -1, uncertain: true }); return; }
      const proc = this.spawnFn(target.agentapiExe, ['agentapi', ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ANTIGRAVITY_LS_ADDRESS: target.lsAddress,
          ANTIGRAVITY_CSRF_TOKEN: target.csrfToken,
        },
      });
      if (botId) this.running.set(botId, proc);
      let out = '';
      let err = '';
      let settled = false;
      const done = (r: AgentApiResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (botId && this.running.get(botId) === proc) this.running.delete(botId);
        resolve(r);
      };
      const timer = setTimeout(() => { proc.kill(); done({ ok: false, json: null, raw: 'agentapi timeout', exitCode: -1, uncertain: true }); }, timeoutMs);
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (c: string) => { out += c; });
      proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
      proc.on('error', (e) => done({ ok: false, json: null, raw: e.message, exitCode: -1, uncertain: true }));
      proc.on('close', (code) => {
        const start = out.indexOf('{');
        const json = start >= 0 ? safeJson(out.slice(start)) : null;
        const hasError = Boolean(json?.error) || err.trim().length > 0 && code !== 0;
        done({
          ok: code === 0 && json !== null && !hasError,
          json,
          raw: (out + err).slice(0, 4000),
          exitCode: code ?? -1,
          uncertain: code !== 0 || json === null,
        });
      });
    });
  }

  async createSession(bot: BotConfig): Promise<SessionHandle> {
    await this.targetOrDiscover();
    const title = `[NexusBot] ${bot.display_name}`.slice(0, 80);
    const tier = normalizeAntigravityModel(bot.model);
    const initPrompt = `${wakePreamble(bot)}\n\n` +
      `This is a NEW independent conversation bound to bot_id="${bot.bot_id}". ` +
      `Reply in ONE concise sentence confirming your identity and readiness; do NOT call any tools or shell commands for initialization. ${bot.system_prompt ?? ''}`;
    const args = [
      'new-conversation',
      ...(tier ? [`--model=${tier}`] : []),
      `--title=${title}`,
      '--',
      initPrompt,
    ];
    const result = await this.runAgentApi(args, 120_000, bot.bot_id);
    const response = result.json?.response as Record<string, unknown> | undefined;
    const newConversation = response?.newConversation as Record<string, unknown> | undefined;
    const conversationId = String(newConversation?.conversationId ?? response?.conversationId ?? '');
    if (!result.ok || !conversationId) {
      if (result.exitCode !== 0 && /connect|refused|eof|csrf|unauthorized|timeout/i.test(result.raw)) {
        this.target = null;
      }
      // The intent may already be persisted by the agent API. Never replay automatically:
      // mark the outcome uncertain and let the UI ask the human operator.
      this.lastUncertain = true;
      throw new Error(`agentapi new-conversation uncertain (no auto replay): ${result.raw.slice(0, 400)}`);
    }
    this.sessions.set(bot.bot_id, { conversationId, title, model: tier });
    return {
      externalSessionId: conversationId,
      metadata: { engine: 'antigravity', title, model: tier ?? '', transcript: this.resolveTranscript(conversationId) },
    };
  }

  async sendTurn(bot: BotConfig, prompt: string, onEvent: (ev: AgentStreamEvent) => void): Promise<TurnResult> {
    await this.targetOrDiscover();
    const desiredTier = normalizeAntigravityModel(bot.model);
    let session = this.sessions.get(bot.bot_id);
    if (!session && bot.external_session_id) {
      session = {
        conversationId: bot.external_session_id,
        title: `[NexusBot] ${bot.display_name}`.slice(0, 80),
        model: desiredTier,
      };
      this.sessions.set(bot.bot_id, session);
    }
    if (!session || session.model !== desiredTier) {
      try {
        await this.createSession(bot);
        session = this.sessions.get(bot.bot_id);
      } catch (e) {
        return { ok: false, uncertain: true, error: (e as Error).message };
      }
    }
    if (!session) return { ok: false, uncertain: true, error: 'no bound conversation for this bot' };

    // Track transcript lines starting from EOF before sending (or from 0 once newly created)
    let transcriptFile = this.resolveTranscript(session.conversationId);
    let offset = 0;
    try { offset = fs.existsSync(transcriptFile) ? fs.statSync(transcriptFile).size : 0; } catch { offset = 0; }
    let pending = Buffer.alloc(0);
    const seenSteps = new Set<number>();

    let replyText = '';
    let hasFinalReply = false;
    let lastError = '';
    let lastErrorAt = 0;
    let lastActivityAt = Date.now();
    let lastToolName = '';
    let aborted = false;
    let wakeWaiter: (() => void) | null = null;
    const wake = (): void => { wakeWaiter?.(); wakeWaiter = null; };
    const waitSignal = (ms: number): Promise<void> => new Promise((resolve) => {
      if (aborted) { resolve(); return; }
      const t = setTimeout(() => { wakeWaiter = null; resolve(); }, ms);
      wakeWaiter = () => { clearTimeout(t); resolve(); };
    });
    this.turnAborters.set(bot.bot_id, () => { aborted = true; wake(); });

    const consumeRecord = (obj: Record<string, unknown>): void => {
      const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : null;
      if (stepIdx !== null) {
        if (seenSteps.has(stepIdx)) return;
        seenSteps.add(stepIdx);
      }
      lastActivityAt = Date.now();
      const kind = String(obj.type ?? obj.role ?? '').toUpperCase();
      const hasTools = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
      const text = typeof obj.text === 'string' ? obj.text
        : typeof obj.content === 'string' ? obj.content
        : typeof obj.response === 'string' ? obj.response
        : typeof obj.error === 'string' ? obj.error : '';
      const status = String(obj.status ?? '').toUpperCase();

      if (kind.includes('ERROR')) {
        lastError = text.slice(0, 800) || JSON.stringify(obj).slice(0, 800);
        lastErrorAt = Date.now();
      } else if (kind.includes('PLANNER_RESPONSE') || kind.includes('MODEL') || kind.includes('ASSISTANT') || hasTools) {
        // Any model progress after a transient error clears the pending error failure gate.
        lastError = '';
        lastErrorAt = 0;
      }

      if ((kind.includes('PLANNER_RESPONSE') || kind.includes('MODEL') || kind.includes('ASSISTANT')) && !hasTools && text.trim()) {
        replyText += (replyText ? '\n' : '') + text;
        if (!status || status === 'DONE' || status === 'COMPLETED') {
          hasFinalReply = true;
        }
      }
      lastToolName = this.mapTranscriptLine(obj, onEvent, lastToolName);
      wake();
    };

    let watchedFile = '';
    const attachWatcher = (file: string): void => {
      if (watchedFile === file || !fs.existsSync(file)) return;
      this.stopWatching(bot.bot_id);
      const watcher = chokidar.watch(file, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 60 },
      });
      watcher.on('add', () => { pump(); });
      watcher.on('change', () => { pump(); });
      this.watchers.set(bot.bot_id, { watcher, offset });
      watchedFile = file;
    };

    const pump = (): void => {
      try {
        if (!fs.existsSync(transcriptFile)) {
          const resolved = this.resolveTranscript(session!.conversationId);
          if (resolved !== transcriptFile && fs.existsSync(resolved)) {
            transcriptFile = resolved;
            offset = 0;
            pending = Buffer.alloc(0);
          } else {
            return;
          }
        }
        attachWatcher(transcriptFile);
        const size = fs.statSync(transcriptFile).size;
        if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
        const length = size - offset;
        if (length <= 0) return;
        const fd = fs.openSync(transcriptFile, 'r');
        const chunk = Buffer.alloc(length);
        fs.readSync(fd, chunk, 0, length, offset);
        fs.closeSync(fd);
        offset = size;
        pending = Buffer.concat([pending, chunk]);
        const nl = 0x0a;
        let idx = pending.indexOf(nl);
        while (idx >= 0) {
          const line = pending.subarray(0, idx).toString('utf8').trim();
          pending = pending.subarray(idx + 1);
          const obj = line ? safeJson(line) : null;
          if (obj) consumeRecord(obj);
          idx = pending.indexOf(nl);
        }
        // Parse a final line without trailing newline if it already forms valid JSON
        const tail = pending.toString('utf8').trim();
        const tailObj = tail ? safeJson(tail) : null;
        if (tailObj) {
          pending = Buffer.alloc(0);
          consumeRecord(tailObj);
        }
      } catch { /* partial line will be completed on next read */ }
    };

    if (fs.existsSync(transcriptFile)) attachWatcher(transcriptFile);

    try {
      const title = session.title.slice(0, 144);
      const result = await this.runAgentApi([
        'send-message', `--title=${title}`, session.conversationId,
        `${wakePreamble(bot)}\n\n${prompt}`,
      ], 120_000, bot.bot_id);

      if (aborted || !result.ok || result.uncertain) {
        if (result.exitCode !== 0 && /connect|refused|eof|csrf|unauthorized|timeout/i.test(result.raw)) {
          // Drop cached LS endpoint so the NEXT manual turn/reconnect rediscovers a restarted Antigravity IDE;
          // never auto-replay this uncertain call itself.
          this.target = null;
        }
        // SAFETY: a timeout or unparsable reply means the send intent is landed but its outcome is
        // unknown. Mark uncertain and require human confirmation. Never replay the prompt.
        this.lastUncertain = true;
        onEvent({ type: 'error', message: `agentapi outcome uncertain (no auto replay): ${result.raw.slice(0, 500)}`, uncertain: true });
        return { ok: false, uncertain: true, sessionId: session.conversationId, error: 'agentapi outcome uncertain; human confirmation required' };
      }

      pump();
      const inlineReply = extractInlineReply(result.json);
      if (!fs.existsSync(transcriptFile) && inlineReply) {
        onEvent({ type: 'text_delta', text: inlineReply });
        onEvent({ type: 'turn_completed', summary: inlineReply.slice(0, 1200) });
        return { ok: true, sessionId: session.conversationId, text: inlineReply };
      }

      const sendDoneAt = Date.now();
      while (!aborted) {
        pump();
        if (hasFinalReply) {
          await waitSignal(180);
          pump();
          break;
        }
        if (lastError && Date.now() - lastErrorAt >= 3_000) {
          return { ok: false, sessionId: session.conversationId, error: lastError };
        }
        const now = Date.now();
        if (now - sendDoneAt >= this.turnTimeoutMs || now - Math.max(sendDoneAt, lastActivityAt) >= this.idleTimeoutMs) {
          break;
        }
        await waitSignal(200);
      }

      if (aborted) {
        return { ok: false, uncertain: true, sessionId: session.conversationId, error: 'aborted' };
      }

      const finalText = replyText.trim();
      if (!finalText) {
        if (lastError) return { ok: false, sessionId: session.conversationId, error: lastError };
        return {
          ok: false,
          uncertain: true,
          sessionId: session.conversationId,
          error: 'Antigravity 未在 transcript.jsonl 中返回最终回复（请检查 IDE 会话或超时设置）',
        };
      }
      onEvent({ type: 'turn_completed', summary: finalText.slice(0, 1200) });
      return { ok: true, sessionId: session.conversationId, text: finalText };
    } finally {
      this.turnAborters.delete(bot.bot_id);
      this.stopWatching(bot.bot_id);
    }
  }

  private mapTranscriptLine(obj: Record<string, unknown>, onEvent: (ev: AgentStreamEvent) => void, activeTool = ''): string {
    const kind = String(obj.type ?? obj.role ?? '').toUpperCase();
    const source = String(obj.source ?? '').toUpperCase();
    const text = typeof obj.text === 'string' ? obj.text
      : typeof obj.content === 'string' ? obj.content
      : typeof obj.response === 'string' ? obj.response
      : typeof obj.error === 'string' ? obj.error : '';
    if (kind.includes('ERROR')) {
      onEvent({ type: 'error', message: text.slice(0, 800) || JSON.stringify(obj).slice(0, 800) });
      return '';
    }
    if (typeof obj.thinking === 'string' && obj.thinking) {
      onEvent({ type: 'thinking_delta', text: obj.thinking });
    }
    if ((Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) || kind.includes('TOOL_CALL')) {
      let lastTool = activeTool;
      for (const call of (obj.tool_calls as unknown[] | undefined) ?? []) {
        const c = call as Record<string, unknown>;
        lastTool = String(c.name ?? c.type ?? 'tool');
        onEvent({ type: 'tool_call_start', tool: lastTool, args: summarizeToolArgs(c.args) });
      }
      return lastTool;
    }
    if (kind === 'GENERIC' && source === 'MODEL' && text.trim()) {
      const ok = !/Command exited with code [1-9-]|^Error\b/im.test(text.slice(0, 300));
      onEvent({ type: 'tool_call_result', tool: activeTool || 'tool', output: text.slice(0, 1200), ok });
      return '';
    }
    if (kind.includes('PLANNER_RESPONSE') || kind.includes('MODEL') || kind.includes('ASSISTANT')) {
      if (text) onEvent({ type: 'text_delta', text });
      return '';
    }
    if (kind.includes('THINK') || kind.includes('REASONING')) {
      if (text) onEvent({ type: 'thinking_delta', text });
    }
    return activeTool;
  }

  private stopWatching(botId: string): void {
    const entry = this.watchers.get(botId);
    if (entry) { void entry.watcher.close(); this.watchers.delete(botId); }
  }

  async abortTurn(bot: BotConfig): Promise<void> {
    this.turnAborters.get(bot.bot_id)?.();
    const proc = this.running.get(bot.bot_id);
    if (proc && !proc.killed) proc.kill();
    this.running.delete(bot.bot_id);
    this.stopWatching(bot.bot_id);
  }

  async dispose(bot: BotConfig): Promise<void> {
    await this.abortTurn(bot);
    this.sessions.delete(bot.bot_id);
  }

  get uncertain(): boolean { return this.lastUncertain; }
}
