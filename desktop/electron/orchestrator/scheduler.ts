import type { AgentAdapter } from '../adapters/types';
import type { AgentStreamEvent, BotConfig, BotStatus } from '../../src/types';

export interface QueuedTurn {
  botId: string;
  prompt: string;
  source: string;
  messageId?: string;
  traceId?: string;
  hopCount?: number;
  onEvent: (ev: AgentStreamEvent) => void;
  resolve: (ok: boolean) => void;
}

/** One serial queue per bot. Two peers writing to the same session at once would inject two
 *  prompts into a turn that is already streaming; the scheduler always drains one at a time. */
export class BotScheduler {
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly busy = new Set<string>();
  private readonly statuses = new Map<string, BotStatus>();
  private paused = false;
  onStatus?: (botId: string, status: BotStatus) => void;
  onQueueChange?: (botId: string, depth: number) => void;

  status(botId: string): BotStatus { return this.statuses.get(botId) ?? 'idle'; }
  queueDepth(botId: string): number { return this.queues.get(botId)?.length ?? 0; }
  isBusy(botId: string): boolean { return this.busy.has(botId); }

  private setStatus(botId: string, status: BotStatus): void {
    if (this.statuses.get(botId) === status) return;
    this.statuses.set(botId, status);
    this.onStatus?.(botId, status);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) for (const id of [...this.queues.keys()]) void this.drain(id);
  }

  clearAll(): number {
    let count = 0;
    for (const [id, queue] of this.queues) {
      count += queue.length;
      for (const turn of queue) turn.resolve(false);
      this.queues.set(id, []);
      this.onQueueChange?.(id, 0);
    }
    return count;
  }

  clearBot(botId: string): number {
    const queue = this.queues.get(botId);
    if (!queue || queue.length === 0) return 0;
    const count = queue.length;
    for (const turn of queue) turn.resolve(false);
    this.queues.set(botId, []);
    this.onQueueChange?.(botId, 0);
    return count;
  }

  enqueue(turn: QueuedTurn): void {
    const queue = this.queues.get(turn.botId) ?? [];
    queue.push(turn);
    this.queues.set(turn.botId, queue);
    this.onQueueChange?.(turn.botId, queue.length);
    if (!this.busy.has(turn.botId)) this.setStatus(turn.botId, 'queued');
    void this.drain(turn.botId);
  }

  private async drain(botId: string): Promise<void> {
    if (this.paused || this.busy.has(botId)) return;
    const queue = this.queues.get(botId);
    const turn = queue?.shift();
    if (!turn) return;
    this.onQueueChange?.(botId, queue!.length);
    this.busy.add(botId);
    this.setStatus(botId, 'working');
    try {
      const result = await this.runner!(turn);
      const hasMore = (this.queues.get(botId)?.length ?? 0) > 0;
      this.setStatus(botId, !result ? 'error' : hasMore ? 'queued' : 'idle');
      turn.resolve(result);
    } catch {
      this.setStatus(botId, 'error');
      turn.resolve(false);
    } finally {
      this.busy.delete(botId);
      void this.drain(botId);
    }
  }

  private runner?: (turn: QueuedTurn) => Promise<boolean>;

  setRunner(fn: (turn: QueuedTurn) => Promise<boolean>): void { this.runner = fn; }

  async abortAll(adapters: Map<string, AgentAdapter>, bots: Map<string, BotConfig>): Promise<{ botId: string; error: string }[]> {
    this.clearAll();
    const requests: Promise<{ botId: string; error: string } | null>[] = [];
    for (const [id, adapter] of adapters) {
      const bot = bots.get(id);
      if (bot) requests.push(adapter.abortTurn(bot).then(() => null, e => ({ botId: id, error: (e as Error).message })));
    }
    return (await Promise.all(requests)).filter((value): value is { botId: string; error: string } => value !== null);
  }
}
