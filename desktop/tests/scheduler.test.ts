import { describe, expect, it, vi } from 'vitest';
import { BotScheduler } from '../electron/orchestrator/scheduler';
import type { AgentAdapter } from '../electron/adapters/types';
import type { BotConfig } from '../src/types';

function makeBot(id: string): BotConfig {
  return {
    bot_id: id,
    display_name: id,
    engine_type: 'claude',
    role: 'worker',
    system_prompt: '',
    permission_mode: 'auto',
    workspace_mode: 'shared',
    room: 'default',
    workspace: 'C:\\temp',
    is_supervisor: false,
    status: 'idle',
    color: '#e9a23b',
    created_at: new Date().toISOString(),
  };
}

describe('BotScheduler', () => {
  it('serializes turns for the same bot while running distinct bots concurrently', async () => {
    const scheduler = new BotScheduler();
    const order: string[] = [];
    const active = new Map<string, number>();
    let maxOverlapSameBot = 0;
    let maxConcurrentTotal = 0;
    let totalRunning = 0;

    scheduler.setRunner(async (turn) => {
      const count = (active.get(turn.botId) ?? 0) + 1;
      active.set(turn.botId, count);
      maxOverlapSameBot = Math.max(maxOverlapSameBot, count);
      totalRunning++;
      maxConcurrentTotal = Math.max(maxConcurrentTotal, totalRunning);
      order.push(`start:${turn.botId}:${turn.prompt}`);
      await new Promise((r) => setTimeout(r, 35));
      order.push(`end:${turn.botId}:${turn.prompt}`);
      totalRunning--;
      active.set(turn.botId, count - 1);
      return true;
    });

    const p1 = new Promise<boolean>((resolve) =>
      scheduler.enqueue({ botId: 'bot-a', prompt: '1', source: 'user', onEvent: () => {}, resolve }));
    const p2 = new Promise<boolean>((resolve) =>
      scheduler.enqueue({ botId: 'bot-a', prompt: '2', source: 'user', onEvent: () => {}, resolve }));
    const p3 = new Promise<boolean>((resolve) =>
      scheduler.enqueue({ botId: 'bot-b', prompt: '1', source: 'user', onEvent: () => {}, resolve }));

    expect(await Promise.all([p1, p2, p3])).toEqual([true, true, true]);
    expect(maxOverlapSameBot).toBe(1);
    expect(maxConcurrentTotal).toBe(2);
    expect(order.indexOf('end:bot-a:1')).toBeLessThan(order.indexOf('start:bot-a:2'));
  });

  it('pauses draining when setPaused(true) and resumes on setPaused(false)', async () => {
    const scheduler = new BotScheduler();
    const ran: string[] = [];
    scheduler.setRunner(async (turn) => {
      ran.push(turn.prompt);
      return true;
    });

    scheduler.setPaused(true);
    let done = false;
    const p = new Promise<boolean>((resolve) =>
      scheduler.enqueue({
        botId: 'bot-x',
        prompt: 'queued-while-paused',
        source: 'bot-y',
        onEvent: () => {},
        resolve: (ok) => { done = true; resolve(ok); },
      }));

    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(ran).toEqual([]);
    expect(scheduler.queueDepth('bot-x')).toBe(1);

    scheduler.setPaused(false);
    expect(await p).toBe(true);
    expect(ran).toEqual(['queued-while-paused']);
  });

  it('clears queued turns and calls abortTurn across adapters on abortAll()', () => {
    const scheduler = new BotScheduler();
    scheduler.setPaused(true);
    const results: boolean[] = [];
    scheduler.enqueue({ botId: 'bot-1', prompt: 't1', source: 'user', onEvent: () => {}, resolve: (ok) => results.push(ok) });
    scheduler.enqueue({ botId: 'bot-1', prompt: 't2', source: 'user', onEvent: () => {}, resolve: (ok) => results.push(ok) });

    const abortTurn = vi.fn(async () => {});
    const fakeAdapter = { abortTurn } as unknown as AgentAdapter;
    const adapters = new Map([['bot-1', fakeAdapter]]);
    const bots = new Map([['bot-1', makeBot('bot-1')]]);

    scheduler.abortAll(adapters, bots);
    expect(scheduler.queueDepth('bot-1')).toBe(0);
    expect(results).toEqual([false, false]);
    expect(abortTurn).toHaveBeenCalledTimes(1);
  });

  it('does not flicker to idle between back-to-back queued turns and clears a single bot cleanly', async () => {
    const scheduler = new BotScheduler();
    const transitions: string[] = [];
    scheduler.onStatus = (botId, status) => {
      if (botId === 'bot-a') transitions.push(status);
    };
    scheduler.setRunner(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return true;
    });

    const p1 = new Promise<boolean>((resolve) =>
      scheduler.enqueue({ botId: 'bot-a', prompt: 'first', source: 'user', onEvent: () => {}, resolve }));
    const p2 = new Promise<boolean>((resolve) =>
      scheduler.enqueue({ botId: 'bot-a', prompt: 'second', source: 'user', onEvent: () => {}, resolve }));

    expect(await Promise.all([p1, p2])).toEqual([true, true]);
    expect(transitions).toEqual(['queued', 'working', 'queued', 'working', 'idle']);

    scheduler.setPaused(true);
    const resA: boolean[] = [];
    const resB: boolean[] = [];
    scheduler.enqueue({ botId: 'bot-a', prompt: 'drop-a', source: 'user', onEvent: () => {}, resolve: (ok) => resA.push(ok) });
    scheduler.enqueue({ botId: 'bot-b', prompt: 'keep-b', source: 'user', onEvent: () => {}, resolve: (ok) => resB.push(ok) });
    expect(scheduler.clearBot('bot-a')).toBe(1);
    expect(resA).toEqual([false]);
    expect(scheduler.queueDepth('bot-b')).toBe(1);
    scheduler.setPaused(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(resB).toEqual([true]);
  });
});
