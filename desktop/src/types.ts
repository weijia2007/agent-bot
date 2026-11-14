export type EngineType = 'claude' | 'codex' | 'antigravity';
export type BotStatus = 'idle' | 'working' | 'queued' | 'error' | 'paused' | 'waiting_approval';
export type WorkspaceMode = 'worktree' | 'shared';
export type PermissionMode = 'auto' | 'ask_ui';

export interface BotConfig {
  bot_id: string;
  display_name: string;
  engine_type: EngineType;
  model?: string;
  role: string;
  system_prompt: string;
  permission_mode: PermissionMode;
  workspace_mode: WorkspaceMode;
  room: string;
  workspace: string;
  worktree_branch?: string;
  is_supervisor: boolean;
  external_session_id?: string;
  status: BotStatus;
  color: string;
  created_at: string;
}

export interface Room {
  id: string;
  name: string;
  project_path: string;
  created_at: string;
}

export type MessageKind = 'user' | 'supervisor' | 'bot' | 'system' | 'review';

export interface RoomMessage {
  id: string;
  kind: MessageKind;
  from: string;
  to?: string;
  reply_to?: string;
  room: string;
  text: string;
  created: string;
  status?: 'queued' | 'delivered' | 'working' | 'done' | 'review_back' | 'cancelled' | 'uncertain';
  trace_id?: string;
  hop_count?: number;
  progress?: string;
  attachments?: string[];
  review_items?: ReviewItem[];
}

export interface SearchHit {
  id: string;
  from: string;
  to: string;
  topic: string;
  created: string;
  score: number;
  snippet: string;
  reply_to?: string;
}

export interface ReviewItem {
  file: string;
  line: number;
  severity: 'high' | 'medium' | 'low';
  note: string;
  accepted?: boolean;
  from_bot: string;
}

export interface StreamEvent {
  bot_id: string;
  at: string;
  event: AgentStreamEvent;
}

export type AgentStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; tool: string; args?: string }
  | { type: 'tool_call_result'; tool: string; output?: string; ok?: boolean }
  | { type: 'approval_required'; requestId: string; command: string; files?: string[] }
  | { type: 'turn_completed'; summary?: string }
  | { type: 'error'; message: string; uncertain?: boolean };

export interface TurnResult {
  ok: boolean;
  sessionId?: string;
  text?: string;
  uncertain?: boolean;
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  bot_id: string;
  command: string;
  files: string[];
  created_at: string;
}

export interface HopPause {
  id: string;
  trace_id: string;
  hop_count: number;
  max_hops: number;
  from_bot: string;
  to: string;
  created_at: string;
}

export interface FileLock {
  id: string;
  bot_id: string;
  paths: string[];
  reason: string;
  expires_at: string;
}

export interface TaskNode {
  id: string;
  label: string;
  bot_id?: string;
  parent?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  started_at?: string;
  finished_at?: string;
}

export interface QuotaState {
  codex: unknown;
  antigravity: unknown;
  codex_blocked_reason?: string | null;
  antigravity_blocked_reason?: string | null;
  fetched_at: string;
}

export interface EngineHealth {
  online: boolean;
  pid?: number;
  version?: string;
  relay_home?: string;
  sse_clients?: number;
  emergency_stop?: boolean;
  probes: {
    claude: { available: boolean; reason?: string };
    codex: { available: boolean; reason?: string };
    antigravity: { available: boolean; reason?: string };
  };
}

export interface EngineEvent {
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  before: string;
  after: string;
  patch?: string;
}

export const ENGINE_COLORS: Record<EngineType, string> = {
  claude: '#e9a23b',
  codex: '#3ecf8e',
  antigravity: '#5b9dff',
};

export const ENGINE_LABELS: Record<EngineType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export interface ModelOption {
  id: string;
  label: string;
}

export const ENGINE_MODELS: Record<EngineType, ModelOption[]> = {
  claude: [
    { id: '', label: '默认模型' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { id: '', label: '默认模型' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'o4-mini', label: 'o4-mini' },
  ],
  antigravity: [
    { id: '', label: '跟随 IDE 模型' },
  ],
};

export function formatModelLabel(engine: EngineType, model?: string): string {
  const value = model?.trim() ?? '';
  if (!value) return ENGINE_MODELS[engine]?.[0]?.label ?? '默认模型';
  const preset = ENGINE_MODELS[engine]?.find((m) => m.id === value);
  return preset ? preset.label : value;
}

export interface StudioState {
  rooms: Room[];
  bots: BotConfig[];
  messages: RoomMessage[];
  approvals: ApprovalRequest[];
  hopPauses: HopPause[];
  locks: FileLock[];
  maxHops: number;
  spawnEnabled: boolean;
  emergencyStop: boolean;
}

export interface CreateBotInput {
  display_name: string;
  engine_type: EngineType;
  model?: string;
  role: string;
  roleTemplate: string;
  system_prompt: string;
  permission_mode: PermissionMode;
  workspace_mode: WorkspaceMode;
  room: string;
  color?: string;
  is_supervisor?: boolean;
}
