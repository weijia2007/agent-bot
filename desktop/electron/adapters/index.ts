import type { AgentAdapter, HealthResult } from './types';
import type { EngineType } from '../../src/types';
import { ClaudeSessionAdapter } from './claude';
import { CodexSessionAdapter } from './codex';
import { AntigravitySessionAdapter } from './antigravity';

export type { AgentAdapter, SessionHandle, HealthResult } from './types';

export function createAdapter(engine: EngineType, token: string): AgentAdapter {
  switch (engine) {
    case 'claude': return new ClaudeSessionAdapter(token);
    case 'codex': return new CodexSessionAdapter(token);
    case 'antigravity': return new AntigravitySessionAdapter();
  }
}

export async function probeEngines(token: string): Promise<Record<EngineType, HealthResult>> {
  const adapters = [
    new ClaudeSessionAdapter(token),
    new CodexSessionAdapter(token),
    new AntigravitySessionAdapter(),
  ];
  const results = await Promise.all(adapters.map((a) => a.healthCheck().catch((e) => ({ available: false, reason: (e as Error).message }))));
  return {
    claude: results[0],
    codex: results[1],
    antigravity: results[2],
  };
}
