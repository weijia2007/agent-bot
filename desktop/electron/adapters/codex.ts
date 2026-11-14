import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { findCodexEntry } from '../discovery';
import { mcpUrl } from '../config';
import type { AgentAdapter, HealthResult, SessionHandle } from './types';
import { safeJson } from './types';
import type { AgentStreamEvent, BotConfig, TurnResult } from '../../src/types';

const execFileAsync = promisify(execFile);

interface CodexSession {
  id: string;
  threadId?: string;
  appServerUsable: boolean;
}

function identityPreamble(bot: BotConfig): string {
  return `[NexusBot Identity: bot_id="${bot.bot_id}" | Room: "${bot.room}"] ` +
    `You are ${bot.display_name}, a ${bot.role} bot. Use the nexus-bot-studio MCP server; ` +
    `always pass as_bot="${bot.bot_id}" to send/reply/read/progress/inbox. ` +
    `When a peer wakes you, never ask the human user a blocking question.`;
}

/** Minimal app-server JSON-RPC client over stdio. The local Codex 0.157.1 answers initialize and
 *  thread/list, but thread/start stalls while its model manager refreshes; when that happens we
 *  degrade to a controlled `codex exec --json` session (never a GUI click). */
class CodexRpc {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private buffer = '';
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};

  constructor(nodeExe: string, codexJs: string, bot: BotConfig, token: string) {
    this.proc = spawn(nodeExe, [
      codexJs, 'app-server', '--listen', 'stdio://',
      '-c', `mcp_servers.nexus_bot_studio.url="${mcpUrl(bot.bot_id)}"`,
      '-c', 'mcp_servers.nexus_bot_studio.bearer_token_env_var="NEXUS_BOT_MCP_TOKEN"',
    ], {
      windowsHide: true,
      cwd: bot.workspace && fs.existsSync(bot.workspace) ? bot.workspace : os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NEXUS_BOT_MCP_TOKEN: token },
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.feed(chunk));
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      const obj = line ? safeJson(line) : null;
      if (obj) {
        const id = typeof obj.id === 'number' ? obj.id : null;
        if (id !== null && this.pending.has(id)) {
          const slot = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(slot.timer);
          if (obj.error) slot.reject(new Error(JSON.stringify(obj.error)));
          else slot.resolve(obj.result ?? {});
        } else if (typeof obj.method === 'string') {
          this.onNotification(obj.method, (obj.params as Record<string, unknown>) ?? {});
        }
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 6000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  kill(): void { this.proc.kill(); }
}

export interface CodexAdapterDeps {
  spawnFn?: typeof spawn;
  findEntry?: typeof findCodexEntry;
}

export class CodexSessionAdapter implements AgentAdapter {
  readonly engineType = 'codex' as const;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly running = new Map<string, ChildProcess>();
  private readonly spawnFn: typeof spawn;
  private readonly findEntry: typeof findCodexEntry;

  constructor(private readonly token: string, deps: CodexAdapterDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.findEntry = deps.findEntry ?? findCodexEntry;
  }

  async healthCheck(): Promise<HealthResult> {
    const entry = this.findEntry();
    if (!entry) return { available: false, reason: 'node.exe or codex.js not found (set NEXUS_BOT_CODEX_JS)' };
    try {
      const { stdout } = await execFileAsync(entry.nodeExe, [entry.codexJs, '--version'],
        { windowsHide: true, timeout: 25_000 });
      return { available: true, detail: { nodeExe: entry.nodeExe, codexJs: entry.codexJs, version: stdout.trim() } };
    } catch (e) {
      return { available: false, reason: (e as Error).message, detail: { ...entry } };
    }
  }

  async createSession(bot: BotConfig): Promise<SessionHandle> {
    const id = crypto.randomUUID();
    this.sessions.set(bot.bot_id, { id, appServerUsable: true });
    return { externalSessionId: id, metadata: { engine: 'codex', mcpUrl: mcpUrl(bot.bot_id) } };
  }

  /** Never silently open a second thread for an existing bot: reuse restored external threadId across restarts. */
  private async sessionFor(bot: BotConfig): Promise<CodexSession | undefined> {
    const existing = this.sessions.get(bot.bot_id);
    if (existing) return existing;
    if (bot.external_session_id) {
      const restored: CodexSession = {
        id: bot.external_session_id,
        threadId: bot.external_session_id,
        appServerUsable: false,
      };
      this.sessions.set(bot.bot_id, restored);
      return restored;
    }
    await this.createSession(bot);
    return this.sessions.get(bot.bot_id);
  }

  async sendTurn(bot: BotConfig, prompt: string, onEvent: (ev: AgentStreamEvent) => void): Promise<TurnResult> {
    const entry = this.findEntry();
    if (!entry) return { ok: false, error: 'Codex CLI not found' };
    const session = await this.sessionFor(bot);
    if (!session) return { ok: false, error: 'failed to create an isolated Codex session' };
    const fullPrompt = `${identityPreamble(bot)}\n\n${prompt}`;

    if (session.appServerUsable && !session.threadId) {
      const result = await this.tryAppServer(entry, bot, session, fullPrompt, onEvent);
      if (result) return result;
      session.appServerUsable = false;
      onEvent({ type: 'error', message: 'app-server thread/start unavailable; degraded to codex exec --json' });
    }
    return this.execTurn(entry, bot, session, fullPrompt, onEvent);
  }

  private async tryAppServer(
    entry: { nodeExe: string; codexJs: string }, bot: BotConfig, session: CodexSession,
    prompt: string, onEvent: (ev: AgentStreamEvent) => void,
  ): Promise<TurnResult | null> {
    const rpc = new CodexRpc(entry.nodeExe, entry.codexJs, bot, this.token);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'nexus-bot-studio', version: '0.1.0' }, capabilities: {} }, 5000);
      rpc.notify('initialized');
      const started = await rpc.request('thread/start', {
        cwd: bot.workspace && fs.existsSync(bot.workspace) ? bot.workspace : os.homedir(),
        ...(bot.model ? { model: bot.model } : {}),
      }, 6000) as Record<string, unknown> | null;
      const thread = (started?.thread ?? {}) as Record<string, unknown>;
      const threadId = String(thread.id ?? started?.threadId ?? started?.id ?? '');
      if (!threadId) { rpc.kill(); return null; }
      session.threadId = threadId;

      return await new Promise<TurnResult>((resolve) => {
        let done = false;
        let streamedText = '';
        const finish = (r: TurnResult): void => {
          if (!done) { done = true; clearTimeout(timer); rpc.kill(); resolve(r.ok && !r.text && streamedText ? { ...r, text: streamedText } : r); }
        };
        const timer = setTimeout(() => finish({ ok: false, uncertain: true, error: 'app-server turn timed out' }), 20 * 60 * 1000);
        rpc.onNotification = (method, params) => this.mapNotification(method, params, (ev) => {
          if (ev.type === 'text_delta') streamedText += ev.text;
          onEvent(ev);
        }, finish);
        rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          ...(bot.model ? { model: bot.model } : {}),
        }, 10_000)
          .catch((e) => finish({ ok: false, error: (e as Error).message }));
      });
    } catch {
      rpc.kill();
      return null;
    }
  }

  private mapNotification(method: string, params: Record<string, unknown>,
    onEvent: (ev: AgentStreamEvent) => void, finish: (r: TurnResult) => void): void {
    const m = method.toLowerCase();
    const text = typeof params.delta === 'string' ? params.delta
      : typeof params.text === 'string' ? params.text
      : typeof (params.item as Record<string, unknown> | undefined)?.text === 'string'
        ? String((params.item as Record<string, unknown>).text) : '';
    if (m.includes('agentmessage') && text) onEvent({ type: 'text_delta', text });
    else if (m.includes('reasoning') && text) onEvent({ type: 'thinking_delta', text });
    else if (m.includes('outputdelta') && text) onEvent({ type: 'tool_call_result', tool: 'command', output: text.slice(0, 1200), ok: true });
    else if (m.includes('started') && (m.includes('command') || m.includes('mcp') || m.includes('filechange')))
      onEvent({ type: 'tool_call_start', tool: String((params.item as Record<string, unknown> | undefined)?.type ?? method) });
    else if (m.includes('approval')) onEvent({ type: 'approval_required', requestId: String(params.requestId ?? method), command: String(params.command ?? method) });
    if (m.includes('turn/completed') || m === 'turn/completed') {
      onEvent({ type: 'turn_completed' });
      finish({ ok: true, sessionId: params.threadId as string | undefined });
    } else if (m.includes('error') || m.includes('failed')) {
      onEvent({ type: 'error', message: JSON.stringify(params).slice(0, 800) });
      finish({ ok: false, error: 'app-server turn failed' });
    }
  }

  private buildExecArgs(
    entry: { nodeExe: string; codexJs: string }, cwd: string, bot: BotConfig, prompt: string, threadId?: string,
  ): string[] {
    const base = threadId
      ? ['exec', 'resume', threadId, '--skip-git-repo-check']
      : ['exec', '--skip-git-repo-check', '-C', cwd];
    if (bot.model) base.push('-m', bot.model);
    return [
      entry.codexJs, ...base, '--json',
      '-c', `mcp_servers.nexus_bot_studio.url="${mcpUrl(bot.bot_id)}"`,
      '-c', 'mcp_servers.nexus_bot_studio.bearer_token_env_var="NEXUS_BOT_MCP_TOKEN"',
      prompt,
    ];
  }

  /** Degraded path: one real `codex exec --json` process per turn, resuming the same thread id
   *  on later turns so the conversation keeps its own context. */
  private execTurn(
    entry: { nodeExe: string; codexJs: string }, bot: BotConfig, session: CodexSession,
    prompt: string, onEvent: (ev: AgentStreamEvent) => void,
  ): Promise<TurnResult> {
    const cwd = bot.workspace && fs.existsSync(bot.workspace) ? bot.workspace : os.homedir();
    const args = this.buildExecArgs(entry, cwd, bot, prompt, session.threadId);
    return this.runExec(entry, args, cwd, session, bot, prompt, onEvent, true);
  }

  private runExec(
    entry: { nodeExe: string; codexJs: string }, args: string[], cwd: string, session: CodexSession, bot: BotConfig,
    prompt: string, onEvent: (ev: AgentStreamEvent) => void, allowRetry: boolean,
  ): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      const proc = this.spawnFn(entry.nodeExe, args, {
        windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEXUS_BOT_MCP_TOKEN: this.token },
      });
      this.running.set(bot.bot_id, proc);
      let buffer = '';
      let stderr = '';
      let text = '';
      let settled = false;
      const timer = setTimeout(() => { proc.kill(); }, 20 * 60 * 1000);
      const finish = (r: TurnResult): void => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (this.running.get(bot.bot_id) === proc) this.running.delete(bot.bot_id);
        resolve(r);
      };
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const obj = line ? safeJson(line) : null;
          if (obj) this.mapExecEvent(obj, session, onEvent, (t) => { text += t; });
          nl = buffer.indexOf('\n');
        }
      });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      proc.on('error', (e) => finish({ ok: false, error: e.message }));
      proc.on('close', (code) => {
        if (allowRetry && code !== 0 && session.threadId && !text
          && /resume|unknown|not found|no recorded|missing|does not exist/i.test(stderr)) {
          // Clear stale thread id and rebuild a fresh `codex exec` invocation without `resume`.
          session.threadId = undefined;
          const retry = this.buildExecArgs(entry, cwd, bot, prompt);
          this.runExec(entry, retry, cwd, session, bot, prompt, onEvent, false).then(finish);
          return;
        }
        if (code === 0) { onEvent({ type: 'turn_completed', summary: text.slice(-2000) }); finish({ ok: true, sessionId: session.threadId ?? session.id, text }); }
        else { onEvent({ type: 'error', message: stderr.slice(-1000) || `exit ${code}` }); finish({ ok: false, error: stderr.slice(-1000) || `codex exited ${code}` }); }
      });
    });
  }

  private mapExecEvent(obj: Record<string, unknown>, session: CodexSession,
    onEvent: (ev: AgentStreamEvent) => void, collect: (t: string) => void): void {
    const type = String(obj.type ?? '');
    if (type === 'thread.started' && typeof obj.thread_id === 'string') session.threadId = obj.thread_id;
    else if (type === 'item.started' || type === 'item.completed') {
      const item = (obj.item ?? {}) as Record<string, unknown>;
      const kind = String(item.type ?? 'tool');
      if (kind === 'agent_message' || kind === 'assistant_message') {
        const value = typeof item.text === 'string' ? item.text : '';
        if (type === 'item.completed' && value) { onEvent({ type: 'text_delta', text: value }); collect(value); }
      } else if (kind === 'reasoning') {
        const value = typeof item.text === 'string' ? item.text : '';
        if (type === 'item.completed' && value) onEvent({ type: 'thinking_delta', text: value });
      } else if (type === 'item.started') onEvent({ type: 'tool_call_start', tool: kind, args: JSON.stringify(item).slice(0, 600) });
      else onEvent({ type: 'tool_call_result', tool: kind, output: String(item.text ?? item.output ?? '').slice(0, 1200), ok: true });
    } else if (type === 'agent_message' || type === 'item/agentMessage/delta') {
      const value = String(obj.message ?? obj.delta ?? '');
      if (value) { onEvent({ type: 'text_delta', text: value }); collect(value); }
    } else if (type === 'error' || type === 'turn.failed') {
      onEvent({ type: 'error', message: String(obj.message ?? JSON.stringify(obj)).slice(0, 800) });
    }
  }

  async abortTurn(bot: BotConfig): Promise<void> {
    const proc = this.running.get(bot.bot_id);
    if (proc && !proc.killed) proc.kill();
    this.running.delete(bot.bot_id);
  }

  async dispose(bot: BotConfig): Promise<void> {
    await this.abortTurn(bot);
    this.sessions.delete(bot.bot_id);
  }
}
