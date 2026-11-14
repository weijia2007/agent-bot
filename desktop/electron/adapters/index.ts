import type { AgentAdapter, HealthResult } from './types';
import type { EngineType } from '../../src/types';
import { desktopAdapter } from './desktop';

export type { AgentAdapter, SessionHandle, HealthResult } from './types';

export function createAdapter(engine: EngineType, token: string): AgentAdapter {
  void token;
  return desktopAdapter(engine);
}

export async function probeEngines(token: string): Promise<Record<EngineType, HealthResult>> {
  const adapters = [
    desktopAdapter('claude'),
    desktopAdapter('codex'),
    desktopAdapter('antigravity'),
  ];
  const results = await Promise.all(adapters.map((a) => a.healthCheck().catch((e) => ({ available: false, reason: (e as Error).message }))));
  await Promise.all(adapters.map(a => a.dispose({} as never)));
  return {
    claude: results[0],
    codex: results[1],
    antigravity: results[2],
  };
}
