import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/types';

const native = vi.hoisted(() => ({ data: { status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { steps: [] as any[] } }, sent: false }));
vi.mock('../electron/desktop/antigravity-rpc', () => ({
  gravityTargets: async () => [{ pid: 123, port: 12345, csrf: 'fixture', account: 'fixture' }],
  gravityCall: async (_target: unknown, method: string) => method === 'GetCascadeTrajectory' ? native.data : {},
  gravityModels: async () => [{ id: 'MODEL_TEST', label: 'Desktop fixture' }],
  gravityModelNumber: () => 123,
  gravitySend: async () => { native.sent = true; },
}));
import { AntigravityDesktopAdapter } from '../electron/adapters/desktop';
import { extractDispatches } from '../electron/orchestrator/actions';

describe('real desktop reply assembly', () => {
  it('keeps split dispatch JSON byte-contiguous while separating different assistant messages', async () => {
    const adapter = new AntigravityDesktopAdapter();
    const bot = { bot_id: 'supervisor', engine_type: 'antigravity', external_session_id: 'native-test', desktop_target_id: '123', workspace: 'C:\\fixture', permission_mode: 'inherit', model: 'MODEL_TEST' } as BotConfig;
    await adapter.createSession(bot);
    let streamed = '';
    const turn = adapter.sendTurn(bot, 'dispatch fixture', event => { if (event.type === 'text_delta') streamed += event.text; });
    await vi.waitFor(() => expect(native.sent).toBe(true));
    const part = '<agent-bot-dispatch>{"to":"worker","text":"请在当前';
    native.data = { status: 'CASCADE_RUN_STATUS_RUNNING', trajectory: { steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: '[Agent Bot · task]' } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: part } },
    ] } };
    await (adapter as any).poll(bot);
    const full = part + '目录只读执行"}</agent-bot-dispatch>';
    native.data.trajectory.steps[1] = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: full } };
    native.data.trajectory.steps.push({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '等待成员汇报。' } });
    native.data.status = 'CASCADE_RUN_STATUS_IDLE';
    await (adapter as any).poll(bot);
    const result = await turn;
    expect(result.ok).toBe(true);
    expect(result.text).toBe(full + '\n\n等待成员汇报。');
    expect(result.nativeMessageIds).toEqual(['native-test:1', 'native-test:2']);
    expect(streamed).toBe(result.text);
    expect(extractDispatches(result.text!).actions).toEqual([{ to: 'worker', text: '请在当前目录只读执行' }]);
    await adapter.dispose(bot);
  });
});
