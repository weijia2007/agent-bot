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
import { discoverModelCatalog, findTranscriptFile } from '../electron/discovery';
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

  it('AntigravitySessionAdapter passes --model on createSession and waits for async PLANNER_RESPONSE in transcript.jsonl', async () => {
    const agyCalls: string[][] = [];
    const brainRoot = path.join(tempHome, 'agy-brain');
    const convId = 'conv-async-99';
    const transcriptFile = path.join(brainRoot, convId, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    // Pre-existing init step that must be ignored on the new turn
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'old init ack' }) + '\n',
      'utf8',
    );

    const mockSpawn = ((_cmd: string, args: string[]) => {
      agyCalls.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        if (args.includes('new-conversation')) {
          proc.stdout.write(JSON.stringify({ response: { newConversation: { conversationId: convId } } }) + '\n');
          proc.emit('close', 0);
          return;
        }
        // Simulate agentapi send-message returning `{}` BEFORE transcript response finishes writing
        proc.stdout.write('{}\n');
        proc.emit('close', 0);
        setTimeout(() => {
          fs.appendFileSync(
            transcriptFile,
            JSON.stringify({ step_index: 2, type: 'ERROR_MESSAGE', error: 'transient retry error' }) + '\n',
          );
        }, 40);
        setTimeout(() => {
          fs.appendFileSync(
            transcriptFile,
            JSON.stringify({
              step_index: 3,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              thinking: 'checking model',
              tool_calls: [{ name: 'read_file', args: { Path: 'a.ts' } }],
            }) + '\n',
          );
        }, 90);
        setTimeout(() => {
          fs.appendFileSync(
            transcriptFile,
            JSON.stringify({
              step_index: 4,
              source: 'MODEL',
              type: 'GENERIC',
              status: 'DONE',
              content: 'Command exited with code 0.\nfile content ok',
            }) + '\n',
          );
        }, 160);
        setTimeout(() => {
          fs.appendFileSync(
            transcriptFile,
            JSON.stringify({
              step_index: 5,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: '我是 Gemini Pro，已经收到你的消息。',
            }) + '\n',
          );
        }, 420);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const adapter = new AntigravitySessionAdapter({
      spawnFn: mockSpawn,
      discoverFn: async () => ({ agentapiExe: 'language_server.exe', lsAddress: '127.0.0.1:4444', csrfToken: 'csrf', pid: 1234 }),
      brainDirFn: () => brainRoot,
      turnTimeoutMs: 5_000,
      idleTimeoutMs: 3_000,
    });

    const bot = makeBot({ bot_id: 'ag-model', engine_type: 'antigravity', model: 'pro' });
    const handle = await adapter.createSession(bot);
    expect(handle.externalSessionId).toBe(convId);
    expect(agyCalls[0]).toContain('--model=pro');

    const events: AgentStreamEvent[] = [];
    const turn = await adapter.sendTurn({ ...bot, external_session_id: convId }, '你是什么模型', (e) => events.push(e));
    expect(turn.ok).toBe(true);
    expect(turn.text).toBe('我是 Gemini Pro，已经收到你的消息。');
    expect(events.some((e) => e.type === 'thinking_delta' && e.text.includes('checking model'))).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_start' && e.tool === 'read_file')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_result' && e.tool === 'read_file' && e.ok === true)).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text.includes('Gemini Pro'))).toBe(true);
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    // Must never leak pre-turn init step
    expect(turn.text).not.toContain('old init ack');
  });

  it('findTranscriptFile locates transcripts under NEXUS_BOT_BRAIN_DIR override', () => {
    const customRoot = path.join(tempHome, 'pool-brain-override');
    const cid = 'conv-pool-42';
    const expected = path.join(customRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, '{"step_index":0}\n', 'utf8');
    const prev = process.env.NEXUS_BOT_BRAIN_DIR;
    process.env.NEXUS_BOT_BRAIN_DIR = customRoot;
    try {
      expect(findTranscriptFile(cid, path.join(tempHome, 'missing-primary-brain'))).toBe(expected);
    } finally {
      if (prev === undefined) delete process.env.NEXUS_BOT_BRAIN_DIR;
      else process.env.NEXUS_BOT_BRAIN_DIR = prev;
    }
  });

  it('ClaudeSessionAdapter and CodexSessionAdapter forward model and reasoning_effort CLI flags', async () => {
    const claudeCalls: string[][] = [];
    const mockClaudeSpawn = ((_cmd: string, args: string[]) => {
      claudeCalls.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const claude = new ClaudeSessionAdapter('tok-cl', { spawnFn: mockClaudeSpawn, findExe: () => 'claude.exe' });
    await claude.sendTurn(makeBot({ bot_id: 'cl-eff', engine_type: 'claude', model: 'opus', reasoning_effort: 'xhigh' }), 'hi', () => {});
    expect(claudeCalls[0]).toContain('--model');
    expect(claudeCalls[0][claudeCalls[0].indexOf('--model') + 1]).toBe('opus');
    expect(claudeCalls[0]).toContain('--effort');
    expect(claudeCalls[0][claudeCalls[0].indexOf('--effort') + 1]).toBe('xhigh');

    const codexCalls: string[][] = [];
    const mockCodexSpawn = ((_cmd: string, args: string[]) => {
      codexCalls.push([...args]);
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_eff_1' }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'agent_message', message: 'ok' }) + '\n');
        proc.emit('close', 0);
      });
      return proc as unknown as ChildProcess;
    }) as unknown as typeof spawn;

    const codex = new CodexSessionAdapter('tok-cx', {
      spawnFn: mockCodexSpawn,
      findEntry: () => ({ nodeExe: 'node.exe', codexJs: 'codex.js' }),
    });
    await codex.sendTurn(
      makeBot({ bot_id: 'cx-eff', engine_type: 'codex', model: 'gpt-6.1-terra', reasoning_effort: 'ultra', external_session_id: 'th_eff_1' }),
      'hi',
      () => {},
    );
    expect(codexCalls[0]).toContain('-m');
    expect(codexCalls[0][codexCalls[0].indexOf('-m') + 1]).toBe('gpt-6.1-terra');
    expect(codexCalls[0]).toContain('model_reasoning_effort="ultra"');
  });

  it('discoverModelCatalog auto-reads Codex models_cache, Claude configs, and Antigravity state without exposing tokens', async () => {
    const fakeHome = path.join(tempHome, 'fake-user-home');
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });

    fs.writeFileSync(
      path.join(fakeHome, '.codex', 'config.toml'),
      'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "high"\n[mcp_servers.demo]\nurl = "http://127.0.0.1:1"\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeHome, '.codex', 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'GPT-6.1-Sol',
            visibility: 'list',
            priority: 1,
            default_reasoning_level: 'low',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }],
          },
          {
            slug: 'gpt-6-luna',
            display_name: 'GPT-6-Luna',
            visibility: 'list',
            priority: 2,
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
          },
          {
            slug: 'hidden-internal',
            display_name: 'Hidden',
            visibility: 'hide',
            priority: 0,
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        effortLevel: 'max',
        availableModels: ['claude-custom-test'],
        env: { ANTHROPIC_AUTH_TOKEN: 'secret-token-never-expose', ANTHROPIC_MODEL: 'claude-opus-5-5' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeHome, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 1M' }],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeHome, '.gemini', 'antigravity_state.pbtxt'),
      'last_selected_agent_model: MODEL_PLACEHOLDER_M528\n',
      'utf8',
    );

    const catalog = await discoverModelCatalog({ homes: [fakeHome], skipCliProbe: true, force: true });
    expect(catalog.codex.defaultModel).toBe('gpt-6.1-terra');
    expect(catalog.codex.defaultEffort).toBe('high');
    expect(catalog.codex.models.some((m) => m.id === 'hidden-internal')).toBe(false);
    expect(catalog.codex.models.find((m) => m.id === 'gpt-6.1-sol')?.efforts).toEqual(['low', 'high', 'ultra']);
    expect(catalog.codex.models.find((m) => m.id === 'gpt-6-luna')?.efforts).toEqual(['low', 'max']);

    expect(catalog.claude.defaultModel).toBe('opus');
    expect(catalog.claude.defaultEffort).toBe('max');
    expect(catalog.claude.models.some((m) => m.id === 'claude-fable-5-1[1m]')).toBe(true);
    expect(catalog.claude.models.some((m) => m.id === 'claude-opus-5-5')).toBe(true);
    expect(catalog.claude.models.some((m) => m.id === 'claude-custom-test')).toBe(true);

    expect(catalog.antigravity.supportsEffort).toBe(false);
    expect(catalog.antigravity.ideModelHint).toBe('MODEL_PLACEHOLDER_M528');
    expect(JSON.stringify(catalog)).not.toContain('secret-token-never-expose');
  });
});
