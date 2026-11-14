import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

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
    expect(enqueued[0].prompt).toContain('reply(id="20261114T080000123-abcdef", as_bot="codex-worker"');

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
    });
    internal.pushMessage({
      id: 'msg-dup-1', kind: 'user', from: 'user', to: 'r1-a', room: 'room-1',
      text: 'hello', created: '2026-11-14T10:00:00Z', status: 'delivered',
    });
    const stored = orch.getState().messages.filter((m) => m.id === 'msg-dup-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('done');
    expect(stored[0].trace_id).toBe('tr-keep');

    // 2. setSupervisor only affects target.room and formats valid bot_id/room (never "undefined")
    await orch.setSupervisor('r1-b');
    expect(internal.bots.get('r1-a')?.is_supervisor).toBe(false);
    expect(internal.bots.get('r1-b')?.is_supervisor).toBe(true);
    expect(internal.bots.get('r2-sup')?.is_supervisor).toBe(true);
    expect(internal.bots.get('r1-b')?.system_prompt).not.toContain('undefined');
    expect(internal.bots.get('r1-b')?.system_prompt).toContain('room-1');

    // 3. deleteBot removes approvals and locks belonging to deleted bot only
    await orch.deleteBot('r1-b');
    expect(orch.getState().approvals.map((a) => a.id)).toEqual(['ap-2']);
    expect(orch.getState().locks.map((l) => l.id)).toEqual(['lk-2']);
  });
});
