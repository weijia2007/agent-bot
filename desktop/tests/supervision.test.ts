import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'agent-bot-team-')),
  calls: [] as { botId: string; prompt: string }[],
  answer: (_bot: any, _prompt: string): string => '完成',
  seq: 0,
}));
vi.mock('../electron/config', () => ({ DATA_HOME: fake.root, STATE_FILE: path.join(fake.root, 'state.json'), ensureDirs: () => fs.mkdirSync(fake.root, { recursive: true }) }));
vi.mock('../electron/discovery', () => ({ discoverModelCatalog: vi.fn() }));
vi.mock('../electron/desktop/antigravity-rpc', () => ({ gravityModels: async () => [], gravityTargets: async () => [] }));
vi.mock('../electron/engine', async () => {
  const { EventEmitter } = await import('node:events');
  return { EngineBridge: class extends EventEmitter {
    authToken = 'test-token';
    start = async () => {}; stop = async () => {}; setEngineConfig = async () => {};
    registerBot = async () => {}; deleteBot = async () => {}; setBotStatus = async () => {};
    setEmergencyStop = async () => {}; getLocks = async () => []; releaseLock = async () => {};
    postUserMessage = async () => ({ id: `task-${++fake.seq}`, traceId: `trace-${fake.seq}` });
  } };
});
vi.mock('../electron/adapters', () => ({ createAdapter: () => ({
  createSession: async (bot: any) => ({ externalSessionId: bot.external_session_id ?? `desktop-${bot.bot_id}` }),
  sendTurn: async (bot: any, prompt: string, emit: any) => {
    fake.calls.push({ botId: bot.bot_id, prompt });
    emit({ type: 'tool_call_start', tool: 'read_file', args: 'task.txt' });
    emit({ type: 'tool_call_result', tool: 'read_file', output: 'read', ok: true });
    const text = fake.answer(bot, prompt); emit({ type: 'text_delta', text });
    emit({ type: 'turn_completed' }); return { ok: true, sessionId: bot.external_session_id, text, nativeMessageIds: [`native-${fake.calls.length}`] };
  },
  abortTurn: async () => {}, dispose: async () => {}, applySettings: async () => {}, observe: () => () => {},
}) }));

import { Orchestrator } from '../electron/orchestrator';
import { extractDispatches } from '../electron/orchestrator/actions';
import type { BotConfig, CreateBotInput } from '../src/types';

const active: Orchestrator[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(o => o.dispose())); fake.calls = []; fake.seq = 0; fs.rmSync(path.join(fake.root, 'state.json'), { force: true }); });
async function studio(): Promise<Orchestrator> { const o = new Orchestrator(); active.push(o); await o.init(); return o; }
function input(room: string, engine: 'codex' | 'claude' | 'antigravity', supervisor = false): CreateBotInput {
  return { display_name: supervisor ? '主管' : engine, engine_type: engine, room, role: supervisor ? 'supervisor' : 'worker', roleTemplate: supervisor ? 'supervisor' : 'worker', system_prompt: '', permission_mode: 'inherit', workspace_mode: 'shared', is_supervisor: supervisor };
}
async function until(test: () => boolean): Promise<void> { const end = Date.now() + 2500; while (!test() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); expect(test()).toBe(true); }

describe('desktop team routing', () => {
  it('requires a first supervisor and a unique real desktop conversation per Bot', async () => {
    const o = await studio();
    await expect(o.createBot(input('default', 'codex'))).rejects.toThrow('第一个 Bot 必须是主管');
    const supervisor = await o.createBot({ ...input('default', 'codex', true), external_session_id: 'real-1' });
    expect(supervisor.connection_mode).toBe('desktop');
    await expect(o.createBot({ ...input('default', 'codex'), external_session_id: 'real-1' })).rejects.toThrow('已绑定其他 Bot');
    await o.createBot(input('default', 'antigravity'));
    await expect(o.deleteBot(supervisor.bot_id)).rejects.toThrow('先指定其他 Bot');
  });

  it('dispatches, reports to the supervisor, and dispatches to a different engine without duplicate turns', async () => {
    const o = await studio(), room = 'default';
    const sup = await o.createBot(input(room, 'codex', true));
    const worker = await o.createBot(input(room, 'antigravity'));
    const reviewer = await o.createBot(input(room, 'claude'));
    let supervisorTurns = 0;
    fake.answer = (bot, prompt) => {
      if (bot.bot_id !== sup.bot_id) return `${bot.display_name} 已完成任务并验证`;
      supervisorTurns++;
      if (supervisorTurns === 1) return `开始执行。<agent-bot-dispatch>${JSON.stringify({ to: worker.bot_id, text: '读取任务附件并完成实现' })}</agent-bot-dispatch>`;
      if (supervisorTurns === 2) { expect(prompt).toContain('任务完成汇报'); return `<agent-bot-dispatch>${JSON.stringify({ to: reviewer.bot_id, text: '验证执行结果' })}</agent-bot-dispatch>`; }
      return '所有任务完成，验证通过。';
    };
    const task = await o.sendMessage(room, '执行项目任务');
    await until(() => fake.calls.length === 5);
    expect(fake.calls.map(c => c.botId)).toEqual([sup.bot_id, worker.bot_id, sup.bot_id, reviewer.bot_id, sup.bot_id]);
    expect(fake.calls[3].prompt).toContain('antigravity 已完成任务并验证');
    expect(fake.calls[3].prompt).toContain('上游任务汇报');
    const state = o.getState();
    expect(state.messages.some(m => m.from === sup.bot_id && m.to === worker.bot_id)).toBe(true);
    expect(state.messages.find(m => m.from === sup.bot_id && m.to === reviewer.bot_id)?.handoff?.text).toContain('antigravity 已完成任务并验证');
    expect(state.messages.some(m => m.from === worker.bot_id && m.to === sup.bot_id && m.text.includes('汇报'))).toBe(true);
    expect(state.messages.filter(m => m.from === sup.bot_id && m.text === '所有任务完成，验证通过。')).toHaveLength(1);
    expect(state.messages.filter(m => m.trace_id === task.trace_id).length).toBeGreaterThan(6);
    expect(state.activity?.[worker.bot_id].some(e => e.event.type === 'tool_call_start')).toBe(true);
    const beforeMirror = state.messages.length;
    const lastReply = state.messages.find(m => m.from === sup.bot_id && m.text === '所有任务完成，验证通过。')!;
    (o as any).onDesktopObservation(sup, { type: 'message', role: 'assistant', id: lastReply.native_message_ids![0], text: lastReply.text, at: new Date().toISOString() });
    expect(state.messages).toHaveLength(beforeMirror);
  });

  it('preserves the conversation on model changes and rejects settings the desktop refuses', async () => {
    const o = await studio(), bot = await o.createBot(input('default', 'codex', true));
    const id = bot.external_session_id;
    await o.setBotModel(bot.bot_id, 'gpt-6.1-sol', 'high');
    expect(bot.external_session_id).toBe(id);
    const internals = o as any;
    internals.adapters.get(bot.bot_id).applySettings = async () => { throw new Error('desktop refused'); };
    await expect(o.setBotModel(bot.bot_id, 'invalid-model')).rejects.toThrow('desktop refused');
    expect(bot.model).toBe('gpt-6.1-sol');
  });

  it('rejects cross-project routing, missing attachments and tasks during emergency stop', async () => {
    const o = await studio();
    const sup = await o.createBot(input('default', 'codex', true));
    const other = await o.createRoom('other', '');
    await expect(o.sendMessage(other.id, 'wrong room', sup.bot_id)).rejects.toThrow('其他项目');
    await expect(o.sendMessage('default', 'missing file', undefined, [path.join(os.tmpdir(), 'missing-task-file-19.txt')])).rejects.toThrow('附件不存在');
    await o.emergencyStop(true);
    await expect(o.sendDirect(sup.bot_id, 'do not execute', 'default')).rejects.toThrow('紧急停止');
    expect(fake.calls).toHaveLength(0);
  });

  it('stops automatic ping-pong at the hop limit and resumes exactly the held message', async () => {
    const o = await studio(); o.setMaxHops(2);
    const sup = await o.createBot(input('default', 'codex', true)), worker = await o.createBot(input('default', 'antigravity'));
    fake.answer = (bot: BotConfig) => bot.is_supervisor ? `<agent-bot-dispatch>${JSON.stringify({ to: worker.bot_id, text: '一次任务' })}</agent-bot-dispatch>` : '已完成';
    await o.sendMessage('default', 'test limit');
    await until(() => o.getState().hopPauses.length > 0);
    expect(fake.calls).toHaveLength(2);
    const pause = o.getState().hopPauses[0]; expect(pause.message_id).toBeTruthy();
    fake.answer = () => '最终完成'; o.resolveHopPause(pause.id, true);
    await until(() => fake.calls.length === 3);
    expect(fake.calls[2].botId).toBe(sup.bot_id);
  });
});

describe('dispatch envelope parser', () => {
  it('accepts explicit valid dispatches and retains malformed text without executing it', () => {
    expect(extractDispatches('plain {"to":"x","text":"no envelope"}').actions).toEqual([]);
    expect(extractDispatches('<agent-bot-dispatch>{"to":4,"text":"x"}</agent-bot-dispatch>').actions).toEqual([]);
    const parsed = extractDispatches('已安排。<agent-bot-dispatch>{"to":"worker","text":"do work"}</agent-bot-dispatch>');
    expect(parsed).toEqual({ text: '已安排。', actions: [{ to: 'worker', text: 'do work' }] });
  });
});
