import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { brainDir, discoverAntigravityTarget, findAntigravityExe, type AntigravityTarget } from '../discovery';
import type { AgentAdapter, HealthResult, SessionHandle } from './types';
import { safeJson } from './types';
import type { AgentStreamEvent, BotConfig, TurnResult } from '../../src/types';

const execFileAsync = promisify(execFile);

interface AgySession { conversationId: string; title: string }

/** Static Antigravity MCP config cannot carry a per-conversation ?bot= URL, so every wake prompt
 *  declares its identity explicitly and the engine accepts as_bot on relay tool calls. */
function wakePreamble(bot: BotConfig): string {
  return `[NexusBot Identity: bot_id="${bot.bot_id}" | Room: "${bot.room}"] ` +
    `在调用 nexus-bot-studio / nexus-relay 工具（send/reply/read/progress/inbox/list_bots）时，请务必传入参数 as_bot="${bot.bot_id}"。` +
    `你是 ${bot.display_name}（${bot.role}）。被同伴唤醒时禁止向人类用户弹出阻塞式提问，请自行决策或用 reply 向发送方确认。`;
}

function transcriptPath(conversationId: string, root = brainDir()): string {
  return path.join(root, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

interface AgentApiResult { ok: boolean; json: Record<string, unknown> | null; raw: string; exitCode: number; uncertain: boolean }

export interface AntigravityAdapterDeps {
  spawnFn?: typeof spawn;
  discoverFn?: typeof discoverAntigravityTarget;
  brainDirFn?: typeof brainDir;
}

export class AntigravitySessionAdapter implements AgentAdapter {
  readonly engineType = 'antigravity' as const;
  private readonly sessions = new Map<string, AgySession>();
  private readonly watchers = new Map<string, { watcher: FSWatcher; offset: number }>();
  private readonly running = new Map<string, ChildProcess>();
  private target: AntigravityTarget | null = null;
  private lastUncertain = false;
  private readonly spawnFn: typeof spawn;
  private readonly discoverFn: typeof discoverAntigravityTarget;
  private readonly brainDirFn: typeof brainDir;

  constructor(deps: AntigravityAdapterDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.discoverFn = deps.discoverFn ?? discoverAntigravityTarget;
    this.brainDirFn = deps.brainDirFn ?? brainDir;
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
    const initPrompt = `${wakePreamble(bot)}\n\n` +
      `This is a NEW independent conversation bound to bot_id="${bot.bot_id}". ` +
      `Acknowledge your identity briefly and wait for tasks. ${bot.system_prompt ?? ''}`;
    const result = await this.runAgentApi(['new-conversation', `--title=${title}`, '--', initPrompt], 120_000, bot.bot_id);
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
    this.sessions.set(bot.bot_id, { conversationId, title });
    return {
      externalSessionId: conversationId,
      metadata: { engine: 'antigravity', title, transcript: path.join(this.brainDirFn(), conversationId, '.system_generated', 'logs', 'transcript.jsonl') },
    };
  }

  async sendTurn(bot: BotConfig, prompt: string, onEvent: (ev: AgentStreamEvent) => void): Promise<TurnResult> {
    await this.targetOrDiscover();
    let session = this.sessions.get(bot.bot_id);
    if (!session && bot.external_session_id) {
      session = { conversationId: bot.external_session_id, title: `[NexusBot] ${bot.display_name}`.slice(0, 80) };
      this.sessions.set(bot.bot_id, session);
    }
    if (!session) return { ok: false, uncertain: true, error: 'no bound conversation for this bot' };

    const transcriptFile = path.join(this.brainDirFn(), session.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    this.watchTranscript(bot.bot_id, transcriptFile, onEvent);
    const title = session.title.slice(0, 144);
    const result = await this.runAgentApi([
      'send-message', `--title=${title}`, session.conversationId,
      `${wakePreamble(bot)}\n\n${prompt}`,
    ], 120_000, bot.bot_id);

    if (!result.ok || result.uncertain) {
      if (result.exitCode !== 0 && /connect|refused|eof|csrf|unauthorized|timeout/i.test(result.raw)) {
        // Drop cached LS endpoint so the NEXT manual turn/reconnect rediscovers a restarted Antigravity IDE;
        // never auto-replay this uncertain call itself.
        this.target = null;
      }
      // SAFETY: a timeout or unparsable reply means the send intent is landed but its outcome is
      // unknown. Mark uncertain and require human confirmation. Never replay the prompt.
      this.lastUncertain = true;
      this.stopWatching(bot.bot_id);
      onEvent({ type: 'error', message: `agentapi outcome uncertain (no auto replay): ${result.raw.slice(0, 500)}`, uncertain: true });
      return { ok: false, uncertain: true, sessionId: session.conversationId, error: 'agentapi outcome uncertain; human confirmation required' };
    }
    await new Promise((r) => setTimeout(r, 350));
    this.flushTranscript(bot.bot_id, transcriptFile, onEvent);
    onEvent({ type: 'turn_completed', summary: result.raw.slice(0, 1200) });
    this.stopWatching(bot.bot_id);
    return { ok: true, sessionId: session.conversationId, text: result.raw.slice(0, 2000) };
  }

  private flushTranscript(botId: string, file: string, onEvent: (ev: AgentStreamEvent) => void): void {
    const entry = this.watchers.get(botId);
    if (!entry) return;
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size < entry.offset) entry.offset = 0;
      const length = size - entry.offset;
      if (length <= 0) return;
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, entry.offset);
      fs.closeSync(fd);
      entry.offset = size;
      for (const line of buffer.toString('utf8').split('\n')) {
        const obj = line.trim() ? safeJson(line.trim()) : null;
        if (obj) this.mapTranscriptLine(obj, onEvent);
      }
    } catch { /* a partially written line is picked up on the next flush */ }
  }

  private watchTranscript(botId: string, file: string, onEvent: (ev: AgentStreamEvent) => void): void {
    let offset = 0;
    try { offset = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { offset = 0; }
    const entry = { watcher: null as unknown as FSWatcher, offset };
    const watcher = chokidar.watch(file, { ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 } });
    watcher.on('change', () => this.flushTranscript(botId, file, onEvent));
    entry.watcher = watcher;
    this.watchers.set(botId, entry);
  }

  private mapTranscriptLine(obj: Record<string, unknown>, onEvent: (ev: AgentStreamEvent) => void): void {
    const kind = String(obj.type ?? obj.role ?? '').toUpperCase();
    const text = typeof obj.text === 'string' ? obj.text
      : typeof obj.content === 'string' ? obj.content
      : typeof obj.response === 'string' ? obj.response : '';
    if (kind.includes('ERROR')) { onEvent({ type: 'error', message: text.slice(0, 800) || JSON.stringify(obj).slice(0, 800) }); return; }
    if (Array.isArray(obj.tool_calls) || kind.includes('TOOL_CALL')) {
      for (const call of (obj.tool_calls as unknown[] | undefined) ?? []) {
        const c = call as Record<string, unknown>;
        onEvent({ type: 'tool_call_start', tool: String(c.name ?? c.type ?? 'tool'), args: JSON.stringify(c.args ?? {}).slice(0, 600) });
      }
      return;
    }
    if (kind.includes('PLANNER_RESPONSE') || kind.includes('MODEL') || kind.includes('ASSISTANT')) {
      if (text) onEvent({ type: 'text_delta', text });
    } else if (kind.includes('THINK') || kind.includes('REASONING')) {
      if (text) onEvent({ type: 'thinking_delta', text });
    }
  }

  private stopWatching(botId: string): void {
    const entry = this.watchers.get(botId);
    if (entry) { void entry.watcher.close(); this.watchers.delete(botId); }
  }

  async abortTurn(bot: BotConfig): Promise<void> {
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
