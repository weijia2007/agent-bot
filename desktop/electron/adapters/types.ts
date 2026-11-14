import type { AgentStreamEvent, BotConfig, DesktopSession, PermissionSnapshot, TurnResult } from '../../src/types';

export type DesktopObservation =
  | { type: 'message'; id: string; role: 'user' | 'assistant'; text: string; at: string }
  | { type: 'activity'; event: AgentStreamEvent }
  | { type: 'state'; working: boolean; permissions?: PermissionSnapshot; model?: string; approvalIds?: string[] };

export interface SessionHandle {
  externalSessionId: string;
  metadata?: Record<string, unknown>;
}

export interface HealthResult {
  available: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Every engine adapter must bind one persistent, isolated conversation per bot. */
export interface AgentAdapter {
  readonly engineType: BotConfig['engine_type'];
  createSession(bot: BotConfig): Promise<SessionHandle>;
  sendTurn(bot: BotConfig, prompt: string, onEvent: (ev: AgentStreamEvent) => void): Promise<TurnResult>;
  abortTurn(bot: BotConfig): Promise<void>;
  respondApproval?(bot: BotConfig, requestId: string, approved: boolean, reason?: string): Promise<void>;
  healthCheck(): Promise<HealthResult>;
  dispose(bot: BotConfig): Promise<void>;
  listSessions?(): Promise<DesktopSession[]>;
  observe?(bot: BotConfig, callback: (observation: DesktopObservation) => void): () => void;
  applySettings?(bot: BotConfig): Promise<void>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
