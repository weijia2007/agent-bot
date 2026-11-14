import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { tempHome } = vi.hoisted(() => {
  const f = require('node:fs') as typeof import('node:fs');
  const o = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  return { tempHome: f.mkdtempSync(p.join(o.tmpdir(), 'nbs-orch-')) };
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
    ENGINE_PORT: 16199,
    DEV_SERVER: 'http://127.0.0.1:5173',
    ensureDirs: () => fs.mkdirSync(tempHome, { recursive: true }),
    generateToken: () => 'test-token',
    engineExecutable: () => '',
    engineEnvironment: () => ({}),
  };
});

import { Orchestrator } from '../electron/orchestrator';
import type { BotConfig, EngineEvent, FileLock, HopPause, RoomMessage } from '../src/types';

describe('Orchestrator routing, hop guard, and lock synchronization', () => {
  afterAll(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('formats peer wake prompts with message_id/trace/hop metadata, tracks locks, and pauses on max_hops_reached', () => {
    const orch = new Orchestrator();
    const emitted: Array<{ ch: string; payload: unknown }> = [];
    orch.setEmitter((ch, payload) => emitted.push({ ch, payload }));

    const enqueued: Array<{ botId: string; prompt: string; source: string }> = [];
    // Inject a fake registered bot and spy on enqueue without spawning external CLIs
    const internal = orch as unknown as {
      bots: Map<string, { bot_id: string }>;
      enqueue: (botId: string, prompt: string, source: string, meta?: unknown) => void;
      onEngineEvent: (ev: EngineEvent) => void;
    };
    internal.bots.set('codex-worker', { bot_id: 'codex-worker' });
    internal.enqueue = (botId, prompt, source) => {
      enqueued.push({ botId, prompt, source });
    };

    const msgEv: EngineEvent = {
      seq: 1,
      type: 'message_posted',
      at: new Date().toISOString(),
      data: {
        id: '20261114T080000123-abcdef',
        from: 'claude-sup',
        to: 'codex-worker',
        topic: 'default',
        text: 'Please review src/login.ts',
        reply_to: '20261114T075900000-000001',
        extra: { trace_id: 'tr-123', hop_count: 3 },
      },
    };
    internal.onEngineEvent(msgEv);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].botId).toBe('codex-worker');
    expect(enqueued[0].prompt).toContain('message_id: 20261114T080000123-abcdef');
    expect(enqueued[0].prompt).toContain('from: claude-sup');
    expect(enqueued[0].prompt).toContain('trace_id: tr-123');
    expect(enqueued[0].prompt).toContain('agent-bot-dispatch');

    // locks_changed updates state.locks authoritatively
    internal.onEngineEvent({
      seq: 2,
      type: 'locks_changed',
      at: new Date().toISOString(),
      data: {
        active: [{ id: 'lock-1', agent: 'codex-worker', paths: ['C:\\repo\\auth.ts'], reason: 'editing', expires: '2099-01-01T00:00:00Z' }],
      },
    });
    const locks = orch.getState().locks as FileLock[];
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ id: 'lock-1', bot_id: 'codex-worker', paths: ['C:\\repo\\auth.ts'] });

    // max_hops_reached creates a hopPause entry and notifies UI
    internal.onEngineEvent({
      seq: 3,
      type: 'max_hops_reached',
      at: new Date().toISOString(),
      data: { trace_id: 'tr-123', hop_count: 10, max_hops: 10, from_bot: 'claude-sup', to: 'codex-worker' },
    });
    const pauses = orch.getState().hopPauses as HopPause[];
    expect(pauses).toHaveLength(1);
    expect(pauses[0].trace_id).toBe('tr-123');
    expect(emitted.some((e) => e.ch === 'hop-pauses')).toBe(true);
  });

  it('deduplicates messages while keeping terminal status, scopes setSupervisor per room, and cleans bot approvals/locks on delete', async () => {
    const orch = new Orchestrator();
    const internal = orch as unknown as {
      bots: Map<string, BotConfig>;
      state: ReturnType<Orchestrator['getState']>;
      pushMessage: (m: RoomMessage) => void;
    };
    const makeBot = (bot_id: string, room: string, is_supervisor: boolean): BotConfig => ({
      bot_id, display_name: bot_id, engine_type: 'claude', role: 'worker',
      system_prompt: 'check lint', permission_mode: 'auto', workspace_mode: 'shared',
      room, workspace: tempHome, is_supervisor, status: 'idle', color: '#e9a23b',
      created_at: new Date().toISOString(), external_session_id: `sess-${bot_id}`,
    });

    internal.bots.set('r1-a', makeBot('r1-a', 'room-1', true));
    internal.bots.set('r1-b', makeBot('r1-b', 'room-1', false));
    internal.bots.set('r2-sup', makeBot('r2-sup', 'room-2', true));
    internal.state.bots = [...internal.bots.values()];
    internal.state.approvals = [
      { id: 'ap-1', bot_id: 'r1-b', command: 'rm', files: [], created_at: new Date().toISOString() },
      { id: 'ap-2', bot_id: 'r2-sup', command: 'ls', files: [], created_at: new Date().toISOString() },
    ];
    internal.state.locks = [
      { id: 'lk-1', bot_id: 'r1-b', paths: ['a.ts'], reason: 'edit', expires_at: new Date().toISOString() },
      { id: 'lk-2', bot_id: 'r2-sup', paths: ['b.ts'], reason: 'edit', expires_at: new Date().toISOString() },
    ];

    // 1. pushMessage deduplication + terminal status preservation
    internal.pushMessage({
      id: 'msg-dup-1', kind: 'user', from: 'user', to: 'r1-a', room: 'room-1',
      text: 'hello', created: '2026-11-14T10:00:00Z', status: 'done', trace_id: 'tr-keep',
      attachments: ['C:\\tasks\\brief.txt'], channel: 'direct', task_id: 'msg-dup-1',
    });
    internal.pushMessage({
      id: 'msg-dup-1', kind: 'user', from: 'user', to: 'r1-a', room: 'room-1',
      text: 'hello', created: '2026-11-14T10:00:00Z', status: 'delivered', attachments: undefined,
    });
    const stored = orch.getState().messages.filter((m) => m.id === 'msg-dup-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('done');
    expect(stored[0].trace_id).toBe('tr-keep');
    expect(stored[0].attachments).toEqual(['C:\\tasks\\brief.txt']);
    expect(stored[0].channel).toBe('direct');
    expect(stored[0].task_id).toBe('msg-dup-1');

    // 2. setSupervisor only affects target.room and formats valid bot_id/room (never "undefined")
    await orch.setSupervisor('r1-b');
    expect(internal.bots.get('r1-a')?.is_supervisor).toBe(false);
    expect(internal.bots.get('r1-b')?.is_supervisor).toBe(true);
    expect(internal.bots.get('r2-sup')?.is_supervisor).toBe(true);
    expect(internal.bots.get('r1-b')?.system_prompt).not.toContain('undefined');
    expect(internal.bots.get('r1-b')?.system_prompt).toBe('check lint');

    // 3. deleteBot removes approvals and locks belonging to deleted bot only
    await expect(orch.deleteBot('r1-b')).rejects.toThrow('先指定其他 Bot 为主管');
    await orch.setSupervisor('r1-a');
    await orch.deleteBot('r1-b');
    expect(orch.getState().approvals.map((a) => a.id)).toEqual(['ap-2']);
    expect(orch.getState().locks.map((l) => l.id)).toEqual(['lk-2']);
  });

  it('captures non-MCP bot text replies and errors into state.messages, skips duplicate when MCP reply exists, and updates model via setBotModel', async () => {
    const orch = new Orchestrator();
    const emitted: Array<{ ch: string; payload: unknown }> = [];
    orch.setEmitter((ch, payload) => emitted.push({ ch, payload }));

    const internal = orch as unknown as {
      bots: Map<string, BotConfig>;
      adapters: Map<string, { sendTurn: (...args: unknown[]) => Promise<{ ok: boolean; sessionId?: string; text?: string; error?: string }> }>;
      state: ReturnType<Orchestrator['getState']>;
      runTurn: (turn: {
        botId: string;
        prompt: string;
        source: string;
        messageId?: string;
        traceId?: string;
        hopCount?: number;
        onEvent: (ev: unknown) => void;
      }) => Promise<boolean>;
    };

    const bot: BotConfig = {
      bot_id: 'bot-reply', display_name: 'Reply Bot', engine_type: 'claude', role: 'worker',
      system_prompt: 'help', permission_mode: 'auto', workspace_mode: 'shared',
      room: 'room-r', workspace: tempHome, is_supervisor: false, status: 'idle',
      color: '#e9a23b', created_at: new Date().toISOString(), external_session_id: 'sess-r1',
    };
    internal.bots.set(bot.bot_id, bot);
    internal.state.bots = [bot];

    // 1. setBotModel updates, persists reasoning_effort, clamps per-model effort, and clears cleanly
    internal.adapters.set(bot.bot_id, { applySettings: async () => {} } as never);
    const updated = await orch.setBotModel(bot.bot_id, 'opus', 'xhigh');
    expect(updated?.model).toBe('opus');
    expect(updated?.reasoning_effort).toBe('xhigh');
    const clampedCodexBot: BotConfig = { ...bot, bot_id: 'bot-cx-clamp', engine_type: 'codex' };
    internal.bots.set(clampedCodexBot.bot_id, clampedCodexBot);
    internal.adapters.set(clampedCodexBot.bot_id, { applySettings: async () => {} } as never);
    expect((await orch.setBotModel(clampedCodexBot.bot_id, 'gpt-6-luna', 'ultra'))?.reasoning_effort).toBe('max');
    expect((await orch.setBotModel(bot.bot_id, 'opus', ''))?.reasoning_effort).toBeUndefined();
    expect((await orch.setBotModel(bot.bot_id, ''))?.model).toBeUndefined();

    // 2. Non-MCP streamed reply automatically creates a visible RoomMessage with captured thinking/tool trace_steps
    internal.adapters.set(bot.bot_id, {
      sendTurn: async (_b: unknown, _p: unknown, onEvent: (ev: { type: string; text?: string; tool?: string; args?: string; output?: string; ok?: boolean }) => void) => {
        onEvent({ type: 'thinking_delta', text: '先检查环境' });
        onEvent({ type: 'tool_call_start', tool: 'run_command', args: 'CommandLine=dir' });
        onEvent({ type: 'tool_call_result', tool: 'run_command', output: 'ok', ok: true });
        onEvent({ type: 'text_delta', text: '这是自动捕获的 ' });
        onEvent({ type: 'text_delta', text: 'Bot 回复' });
        return { ok: true, sessionId: 'sess-r1', text: '这是自动捕获的 Bot 回复' };
      },
    });
    const ok1 = await internal.runTurn({
      botId: bot.bot_id, prompt: '你好', source: 'user', messageId: 'u-1', traceId: 'tr-1', hopCount: 0, onEvent: () => {},
    });
    expect(ok1).toBe(true);
    const botReplies1 = orch.getState().messages.filter((m) => m.from === bot.bot_id && m.reply_to === 'u-1');
    expect(botReplies1).toHaveLength(1);
    expect(botReplies1[0].text).toBe('这是自动捕获的 Bot 回复');
    expect(botReplies1[0].trace_steps?.map((s) => s.kind)).toEqual(['thinking', 'tool_start', 'tool_result']);

    // 3. When MCP reply already landed in state.messages during the turn, runTurn must NOT push a duplicate
    internal.adapters.set(bot.bot_id, {
      sendTurn: async (_b: unknown, _p: unknown, onEvent: (ev: { type: string; text?: string }) => void) => {
        orch.getState().messages.push({
          id: 'mcp-r2', kind: 'bot', from: bot.bot_id, to: 'user', reply_to: 'u-2',
          room: 'room-r', text: 'MCP reply text', created: new Date().toISOString(), status: 'done',
        });
        onEvent({ type: 'text_delta', text: 'MCP reply text' });
        return { ok: true, sessionId: 'sess-r1', text: 'MCP reply text' };
      },
    });
    await internal.runTurn({
      botId: bot.bot_id, prompt: '第二个问题', source: 'user', messageId: 'u-2', onEvent: () => {},
    });
    expect(orch.getState().messages.filter((m) => m.reply_to === 'u-2')).toHaveLength(1);

    // 4. Turn failure pushes a visible system failure notice for the user
    internal.adapters.set(bot.bot_id, {
      sendTurn: async () => ({ ok: false, error: 'API quota exceeded' }),
    });
    const ok3 = await internal.runTurn({
      botId: bot.bot_id, prompt: '第三个问题', source: 'user', messageId: 'u-3', onEvent: () => {},
    });
    expect(ok3).toBe(false);
    const errMsgs = orch.getState().messages.filter((m) => m.reply_to === 'u-3' && m.kind === 'system');
    expect(errMsgs).toHaveLength(1);
    expect(errMsgs[0].text).toContain('API quota exceeded');

    // 5. Desktop model changes retain the exact conversation and apply through the desktop adapter.
    let reboundModel: string | undefined;
    const agyBot: BotConfig = {
      bot_id: 'agy-m1', display_name: 'Agy Model', engine_type: 'antigravity', role: 'worker',
      system_prompt: 'help', permission_mode: 'auto', workspace_mode: 'shared',
      room: 'room-r', workspace: tempHome, is_supervisor: false, status: 'idle',
      color: '#5b8cff', created_at: new Date().toISOString(), external_session_id: 'old-conv-1',
    };
    internal.bots.set(agyBot.bot_id, agyBot);
    internal.adapters.set(agyBot.bot_id, {
      sendTurn: async () => ({ ok: true }),
      abortTurn: async () => {},
      applySettings: async (b: BotConfig) => { reboundModel = b.model; },
      createSession: async (b: BotConfig) => {
        reboundModel = b.model;
        return { externalSessionId: 'new-conv-pro-2', metadata: {} };
      },
    } as unknown as { sendTurn: (...args: unknown[]) => Promise<{ ok: boolean }> });
    const agyUpdated = await orch.setBotModel(agyBot.bot_id, 'MODEL_DESKTOP_TEST');
    expect(agyUpdated?.model).toBe('MODEL_DESKTOP_TEST');
    expect(reboundModel).toBe('MODEL_DESKTOP_TEST');
    expect(agyBot.external_session_id).toBe('old-conv-1');

    // Persisted working/queued status resets cleanly on loadState()
    const stateFile = path.join(tempHome, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      rooms: [{ id: 'room-r', name: 'Room R', project_path: tempHome, created_at: new Date().toISOString() }],
      bots: [{ ...agyBot, status: 'working' }],
      messages: [],
      approvals: [],
      hopPauses: [],
      locks: [],
      maxHops: 10,
      spawnEnabled: true,
      emergencyStop: false,
    }));
    const orch2 = new Orchestrator();
    (orch2 as unknown as { loadState: () => void }).loadState();
    expect(orch2.getState().bots[0].status).toBe('idle');
  });
});
