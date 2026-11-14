import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findClaudeExe } from '../discovery';
import { MCP_CONFIG_DIR, mcpUrl } from '../config';
import type { AgentAdapter, HealthResult, SessionHandle } from './types';
import { safeJson } from './types';
import type { AgentStreamEvent, BotConfig, TurnResult } from '../../src/types';

const execFileAsync = promisify(execFile);

interface ClaudeSession {
  id: string;
  firstTurn: boolean;
  mcpConfig: string;
}

function systemPrompt(bot: BotConfig): string {
  return [
    `You are "${bot.display_name}" (bot_id="${bot.bot_id}"), a ${bot.role} bot in the NexusBot Studio room "${bot.room}".`,
    `Your engine is Claude Code; your workspace is ${bot.workspace || '(default)'}.`,
    'You collaborate with other bots through the "nexus-bot-studio" MCP server.',
    'Always pass as_bot="' + bot.bot_id + '" to send/reply/read/progress/inbox so the room routes your identity correctly.',
    'Call list_bots() before dispatching work. Use send(to, text, topic) for peers and reply(id, text) for answers.',
    'When a peer wakes you, NEVER ask the human user a blocking question: decide with your own judgement or reply to the sender.',
    'During a cross review, change no file; return file:line, the breaking scenario and severity.',
    bot.is_supervisor
      ? 'You are the SUPERVISOR: decompose the user goal, dispatch concrete deliverables with acceptance criteria, wait for answers, organise a cross review by a different engine, and hand the user one consolidated result.'
      : 'You are a worker bot: deliver the requested artifact in your workspace, then reply to the requester with a concise summary and file:line references.',
    bot.system_prompt ? `\nRole-specific instructions:\n${bot.system_prompt}` : '',
  ].filter(Boolean).join('\n');
}

export interface ClaudeAdapterDeps {
  spawnFn?: typeof spawn;
  findExe?: typeof findClaudeExe;
}

/** One Claude Code session per bot: a fresh UUID at creation, --session-id on the first turn and
 *  --resume afterwards. Each bot also gets its own --mcp-config pointing at ?bot=<bot_id>. */
export class ClaudeSessionAdapter implements AgentAdapter {
  readonly engineType = 'claude' as const;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly running = new Map<string, ChildProcess>();
  private readonly spawnFn: typeof spawn;
  private readonly findExe: typeof findClaudeExe;

  constructor(private readonly token: string, deps: ClaudeAdapterDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.findExe = deps.findExe ?? findClaudeExe;
  }

  async healthCheck(): Promise<HealthResult> {
    const exe = findClaudeExe();
    if (!exe) return { available: false, reason: 'claude.exe not found (set NEXUS_BOT_CLAUDE_EXE)' };
    try {
      const { stdout } = await execFileAsync(exe, ['--version'], { windowsHide: true, timeout: 20_000 });
      return { available: true, detail: { exe, version: stdout.trim() } };
    } catch (e) {
      return { available: false, reason: (e as Error).message, detail: { exe } };
    }
  }

  private writeMcpConfig(bot: BotConfig): string {
    fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });
    const file = path.join(MCP_CONFIG_DIR, `${bot.bot_id}.json`);
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: {
        'nexus-bot-studio': {
          type: 'http',
          url: mcpUrl(bot.bot_id),
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    }, null, 2), 'utf8');
    return file;
  }

  async createSession(bot: BotConfig): Promise<SessionHandle> {
    const id = crypto.randomUUID();
    const mcpConfig = this.writeMcpConfig(bot);
    this.sessions.set(bot.bot_id, { id, firstTurn: true, mcpConfig });
    return { externalSessionId: id, metadata: { mcpConfig, engine: 'claude' } };
  }

  /** A resumed process must reuse the SAME uuid (including after app restart via bot.external_session_id),
   *  otherwise the bot loses its conversation memory. */
  private async sessionFor(bot: BotConfig): Promise<ClaudeSession | undefined> {
    const existing = this.sessions.get(bot.bot_id);
    if (existing) {
      existing.mcpConfig = this.writeMcpConfig(bot);
      return existing;
    }
    if (bot.external_session_id) {
      const restored: ClaudeSession = {
        id: bot.external_session_id,
        firstTurn: false,
        mcpConfig: this.writeMcpConfig(bot),
      };
      this.sessions.set(bot.bot_id, restored);
      return restored;
    }
    await this.createSession(bot);
    return this.sessions.get(bot.bot_id);
  }

  async sendTurn(bot: BotConfig, prompt: string, onEvent: (ev: AgentStreamEvent) => void): Promise<TurnResult> {
    const exe = this.findExe();
    if (!exe) return { ok: false, error: 'claude.exe not found' };
    const session = await this.sessionFor(bot);
    if (!session) return { ok: false, error: 'failed to create an isolated Claude session' };
    return this.spawnTurn(exe, bot, session, prompt, onEvent, true);
  }

  private spawnTurn(
    exe: string, bot: BotConfig, session: ClaudeSession, prompt: string,
    onEvent: (ev: AgentStreamEvent) => void, allowResumeFallback: boolean,
  ): Promise<TurnResult> {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      session.firstTurn ? '--session-id' : '--resume', session.id,
      '--mcp-config', session.mcpConfig,
      '--strict-mcp-config',
      '--append-system-prompt', systemPrompt(bot),
      '--permission-mode', bot.permission_mode === 'auto' ? 'acceptEdits' : 'default',
    ];

    return new Promise<TurnResult>((resolve) => {
      const proc = this.spawnFn(exe, args, {
        windowsHide: true,
        cwd: bot.workspace && fs.existsSync(bot.workspace) ? bot.workspace : os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NEXUS_BOT_STUDIO: '1' },
      });
      this.running.set(bot.bot_id, proc);
      let text = '';
      let finished = false;
      let completedEmitted = false;
      let stderr = '';
      let buffer = '';

      const done = (result: TurnResult): void => {
        if (finished) return;
        finished = true;
        if (this.running.get(bot.bot_id) === proc) this.running.delete(bot.bot_id);
        clearTimeout(timer);
        resolve(result);
      };
      const emit = (ev: AgentStreamEvent): void => {
        if (ev.type === 'turn_completed') {
          if (completedEmitted) return;
          completedEmitted = true;
        }
        onEvent(ev);
      };
      const timer = setTimeout(() => {
        proc.kill();
        done({ ok: false, sessionId: session.id, error: 'Claude turn timed out after 20 minutes', uncertain: true });
      }, 20 * 60 * 1000);

      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.parseLine(line, emit, (delta) => { text += delta; });
          nl = buffer.indexOf('\n');
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      proc.on('error', (err) => done({ ok: false, error: err.message }));
      proc.on('close', (code) => {
        if (finished) return;
        // If a bot was created before any turn ran and the app restarted, --resume finds no persisted
        // conversation yet; fall back cleanly once to --session-id with the same UUID if nothing streamed.
        if (code !== 0 && allowResumeFallback && !session.firstTurn && !text
          && /no conversation|session.*not found|could not find|does not exist/i.test(stderr)) {
          session.firstTurn = true;
          finished = true;
          if (this.running.get(bot.bot_id) === proc) this.running.delete(bot.bot_id);
          clearTimeout(timer);
          this.spawnTurn(exe, bot, session, prompt, onEvent, false).then(resolve);
          return;
        }
        session.firstTurn = false;
        if (code === 0) {
          emit({ type: 'turn_completed', summary: text.slice(-2000) });
          done({ ok: true, sessionId: session.id, text });
        } else {
          emit({ type: 'error', message: stderr.slice(-1200) || `exit ${code}` });
          done({ ok: false, sessionId: session.id, error: stderr.slice(-1200) || `claude exited ${code}` });
        }
      });

      proc.stdin?.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        session_id: session.id,
      }) + '\n');
      proc.stdin?.end();
    });
  }

  private parseLine(line: string, onEvent: (ev: AgentStreamEvent) => void, collect: (t: string) => void): void {
    const obj = safeJson(line);
    if (!obj) return;
    const type = String(obj.type ?? '');

    if (type === 'stream_event') {
      const ev = obj.event as Record<string, unknown> | undefined;
      const delta = ev?.delta as Record<string, unknown> | undefined;
      if (ev?.type === 'content_block_delta' && delta) {
        const kind = String(delta.type ?? '');
        const value = typeof delta.text === 'string' ? delta.text : typeof delta.thinking === 'string' ? delta.thinking : '';
        if (!value) return;
        if (kind === 'thinking_delta') onEvent({ type: 'thinking_delta', text: value });
        else if (kind === 'text_delta') { onEvent({ type: 'text_delta', text: value }); collect(value); }
      }
      if (ev?.type === 'content_block_start') {
        const block = ev.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          onEvent({ type: 'tool_call_start', tool: String(block.name ?? 'tool'), args: JSON.stringify(block.input ?? {}).slice(0, 800) });
        }
      }
      return;
    }

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content as Record<string, unknown>[] : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          onEvent({ type: 'text_delta', text: block.text });
          collect(block.text);
        } else if (block.type === 'tool_use') {
          onEvent({ type: 'tool_call_start', tool: String(block.name ?? 'tool'), args: JSON.stringify(block.input ?? {}).slice(0, 800) });
        }
      }
      return;
    }

    if (type === 'user') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content as Record<string, unknown>[] : [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          onEvent({
            type: 'tool_call_result',
            tool: String(block.tool_use_id ?? 'tool'),
            output: typeof block.content === 'string' ? block.content.slice(0, 1200) : JSON.stringify(block.content ?? '').slice(0, 1200),
            ok: block.is_error !== true,
          });
        }
      }
      return;
    }

    if (type === 'result') {
      if (obj.subtype === 'error' || obj.is_error === true) {
        onEvent({ type: 'error', message: String(obj.result ?? obj.error ?? 'Claude result error') });
      } else {
        onEvent({ type: 'turn_completed', summary: String(obj.result ?? '').slice(0, 2000) });
      }
    }
  }

  async abortTurn(bot: BotConfig): Promise<void> {
    const proc = this.running.get(bot.bot_id);
    if (proc && !proc.killed) proc.kill();
    this.running.delete(bot.bot_id);
  }

  /** Claude Code's print/stream-json CLI has no runtime approval channel. A pending approval is
   *  recorded here so the UI can show and resolve it; use permission_mode=auto for unattended runs. */
  async respondApproval(_bot: BotConfig, _requestId: string, approved: boolean, reason?: string): Promise<void> {
    if (!approved) await this.abortTurn(_bot);
    else if (reason) { /* decision is surfaced by the orchestrator event stream */ }
  }

  async dispose(bot: BotConfig): Promise<void> {
    await this.abortTurn(bot);
    const session = this.sessions.get(bot.bot_id);
    if (session) {
      try { fs.unlinkSync(session.mcpConfig); } catch { /* already removed */ }
    }
    this.sessions.delete(bot.bot_id);
  }
}
