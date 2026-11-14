import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { tempHome } = vi.hoisted(() => {
  const f = require('node:fs') as typeof import('node:fs');
  const o = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  return { tempHome: f.mkdtempSync(p.join(o.tmpdir(), 'nbs-adp-')) };
});

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../electron/config', async () => {
  const p = await import('node:path');
  return {
    DATA_HOME: tempHome,
    RELAY_HOME: p.join(tempHome, 'relay'),
    MCP_CONFIG_DIR: p.join(tempHome, 'mcp'),
    WORKTREE_ROOT: p.join(tempHome, 'worktrees'),
    LOG_DIR: p.join(tempHome, 'logs'),
    STATE_FILE: p.join(tempHome, 'state.json'),
    ENGINE_PORT: 16198,
    mcpUrl: (botId?: string) => `http://127.0.0.1:16198/mcp${botId ? `?bot=${encodeURIComponent(botId)}` : ''}`,
    ensureDirs: () => fs.mkdirSync(tempHome, { recursive: true }),
    generateToken: () => 'test-token',
    engineExecutable: () => '',
    engineEnvironment: () => ({}),
  };
});

import { ClaudeSessionAdapter } from '../electron/adapters/claude';
import { CodexSessionAdapter } from '../electron/adapters/codex';
import { AntigravitySessionAdapter } from '../electron/adapters/antigravity';
import type { AgentStreamEvent, BotConfig } from '../src/types';

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    bot_id: 'bot-1',
    display_name: 'Bot 1',
    engine_type: 'claude',
    role: 'worker',
    system_prompt: 'Be concise.',
    permission_mode: 'auto',
    workspace_mode: 'shared',
    room: 'default',
    workspace: tempHome,
    is_supervisor: false,
    status: 'idle',
    color: '#e9a23b',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    queueMicrotask(() => this.emit('close', 1));
    return true;
  });
}

describe('Session Adapters continuity and abort handling', () => {
  afterAll(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('ClaudeSessionAdapter preserves UUID across turns and restores external_session_id with fallback retry', async () => {
    const calls: string[][] = [];
    const mockSpawn = ((_cmd: string, args: string[]) => {
      calls.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        if (calls.length === 3 && args.includes('--resume')) {
          // Simulate restart before Turn 1 persisted: --resume finds no conversation yet
          proc.stderr.write('No conversation found with session ID restored-123\n');
          proc.emit('close', 1);
          return;
        }
        proc.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    // 1. Fresh session: turn 1 -> --session-id, turn 2 -> --resume with same UUID
    const a1 = new ClaudeSessionAdapter('tok-1', { spawnFn: mockSpawn, findExe: () => 'claude.exe' });
    const bot = makeBot({ bot_id: 'cl-1', engine_type: 'claude' });
    const events: AgentStreamEvent[] = [];
    const r1 = await a1.sendTurn(bot, 'hi', (e) => events.push(e));
    expect(r1.ok).toBe(true);
    expect(calls[0]).toContain('--session-id');
    expect(events.filter((e) => e.type === 'turn_completed')).toHaveLength(1);

    const r2 = await a1.sendTurn(bot, 'again', () => {});
    expect(r2.ok).toBe(true);
    expect(calls[1]).toContain('--resume');
    expect(calls[1][calls[1].indexOf('--resume') + 1]).toBe(r1.sessionId);

    // 2. Restart restore: new adapter instance reuses bot.external_session_id, and falls back once to --session-id if missing on disk
    const a2 = new ClaudeSessionAdapter('tok-2', { spawnFn: mockSpawn, findExe: () => 'claude.exe' });
    const restoredBot = makeBot({ bot_id: 'cl-restored', engine_type: 'claude', external_session_id: 'restored-123' });
    const r3 = await a2.sendTurn(restoredBot, 'wake', () => {});
    expect(r3.ok).toBe(true);
    expect(r3.sessionId).toBe('restored-123');
    expect(calls[2]).toContain('--resume');
    expect(calls[2]).toContain('restored-123');
    expect(calls[3]).toContain('--session-id');
    expect(calls[3]).toContain('restored-123');
  });

  it('CodexSessionAdapter restores external_session_id via exec resume across restarts', async () => {
    const calls: string[][] = [];
    const mockSpawn = ((_cmd: string, args: string[]) => {
      calls.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_restored_99' }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'agent_message', message: 'resumed ok' }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const adapter = new CodexSessionAdapter('tok-c', {
      spawnFn: mockSpawn,
      findEntry: () => ({ nodeExe: 'node.exe', codexJs: 'codex.js' }),
    });
    const bot = makeBot({ bot_id: 'cx-1', engine_type: 'codex', external_session_id: 'th_restored_99' });
    const result = await adapter.sendTurn(bot, 'continue task', () => {});
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('th_restored_99');
    expect(calls).toHaveLength(1);
    const execIdx = calls[0].indexOf('exec');
    expect(calls[0].slice(execIdx, execIdx + 3)).toEqual(['exec', 'resume', 'th_restored_99']);
  });

  it('AntigravitySessionAdapter restores external_session_id and tracks running process for abortTurn', async () => {
    const spawned: FakeProc[] = [];
    const argsSeen: string[][] = [];
    const mockSpawn = ((_cmd: string, args: string[]) => {
      argsSeen.push([...args]);
      const proc = new FakeProc();
      spawned.push(proc);
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const adapter = new AntigravitySessionAdapter({
      spawnFn: mockSpawn,
      discoverFn: async () => ({ agentapiExe: 'language_server.exe', lsAddress: '127.0.0.1:4444', csrfToken: 'csrf', pid: 1234 }),
      brainDirFn: () => path.join(tempHome, 'brain'),
    });
    const bot = makeBot({ bot_id: 'ag-1', engine_type: 'antigravity', external_session_id: 'conv-abc-777' });

    const pending = adapter.sendTurn(bot, 'hello after restart', () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(argsSeen).toHaveLength(1);
    expect(argsSeen[0]).toContain('send-message');
    expect(argsSeen[0]).toContain('conv-abc-777');

    // abortTurn must kill the active agentapi process immediately
    await adapter.abortTurn(bot);
    expect(spawned[0].kill).toHaveBeenCalledTimes(1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBe(true);
  });

  it('passes model override flags to Claude and Codex and extracts item.completed agent_message text', async () => {
    const claudeArgs: string[][] = [];
    const claudeSpawn = ((_cmd: string, args: string[]) => {
      claudeArgs.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'result', result: 'fallback answer' }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const claude = new ClaudeSessionAdapter('tok-m', { spawnFn: claudeSpawn, findExe: () => 'claude.exe' });
    const clRes = await claude.sendTurn(makeBot({ bot_id: 'cl-m', model: 'opus' }), 'hi', () => {});
    expect(clRes.ok).toBe(true);
    expect(clRes.text).toBe('fallback answer');
    expect(claudeArgs[0]).toContain('--model');
    expect(claudeArgs[0][claudeArgs[0].indexOf('--model') + 1]).toBe('opus');

    const codexArgs: string[][] = [];
    const codexEvents: AgentStreamEvent[] = [];
    const codexSpawn = ((_cmd: string, args: string[]) => {
      codexArgs.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_m1' }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking...' } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Codex final reply' } }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const codex = new CodexSessionAdapter('tok-cx', {
      spawnFn: codexSpawn,
      findEntry: () => ({ nodeExe: 'node.exe', codexJs: 'codex.js' }),
    });
    const cxRes = await codex.sendTurn(
      makeBot({ bot_id: 'cx-m', engine_type: 'codex', model: 'gpt-5.4', external_session_id: 'th_m1' }),
      'hi codex',
      (e) => codexEvents.push(e),
    );
    expect(cxRes.ok).toBe(true);
    expect(cxRes.text).toBe('Codex final reply');
    expect(codexEvents.some((e) => e.type === 'text_delta' && e.text === 'Codex final reply')).toBe(true);
    expect(codexArgs[0]).toContain('-m');
    expect(codexArgs[0][codexArgs[0].indexOf('-m') + 1]).toBe('gpt-5.4');
    // Resumed codex exec must NOT pass -C (only supported on fresh exec, rejected after `resume`)
    expect(codexArgs[0]).not.toContain('-C');
  });
});
