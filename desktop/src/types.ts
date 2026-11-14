export type EngineType = 'claude' | 'codex' | 'antigravity';
export type BotStatus = 'idle' | 'working' | 'queued' | 'error' | 'paused' | 'waiting_approval';
export type WorkspaceMode = 'worktree' | 'shared';
export type PermissionMode = 'inherit' | 'read_only' | 'auto' | 'ask_ui';

export interface DesktopSession {
  id: string;
  engine: EngineType;
  title: string;
  workspace: string;
  account?: string;
  target_id?: string;
  updated_at?: string;
}

export interface PermissionSnapshot {
  source: 'desktop_session' | 'desktop_config' | 'unknown';
  approval_policy?: string;
  sandbox?: string;
  observed_at: string;
  detail: string;
  can_apply: boolean;
}

export interface BotConfig {
  bot_id: string;
  display_name: string;
  engine_type: EngineType;
  model?: string;
  reasoning_effort?: string;
  role: string;
  system_prompt: string;
  permission_mode: PermissionMode;
  workspace_mode: WorkspaceMode;
  room: string;
  workspace: string;
  worktree_branch?: string;
  is_supervisor: boolean;
  external_session_id?: string;
  desktop_target_id?: string;
  connection_mode?: 'desktop' | 'legacy_cli';
  permissions?: PermissionSnapshot;
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

export interface TraceStep {
  kind: 'thinking' | 'tool_start' | 'tool_result' | 'error';
  title: string;
  detail?: string;
  ok?: boolean;
  at: string;
}

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
  trace_steps?: TraceStep[];
  channel?: 'group' | 'direct' | 'desktop';
  task_id?: string;
  handoff?: { from: string; message_id: string; text: string };
  native_message_ids?: string[];
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
  nativeMessageIds?: string[];
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
  message_id?: string;
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
  description?: string;
  defaultEffort?: string;
  efforts?: string[];
  source?: 'discovered' | 'preset' | 'configured';
}

export interface EngineCatalogEntry {
  models: ModelOption[];
  defaultModel?: string;
  defaultEffort?: string;
  ideModelHint?: string;
  supportsEffort: boolean;
  effortNote?: string;
  discoveredAt?: string;
  sources?: string[];
  targetModels?: Record<string, ModelOption[]>;
}

export type EngineModelCatalog = Record<EngineType, EngineCatalogEntry>;

export const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极限',
  ultra: '极致',
};

export function formatEffortLabel(effort?: string): string {
  const key = effort?.trim().toLowerCase() ?? '';
  if (!key) return '默认强度';
  const zh = EFFORT_LABELS[key];
  return zh ? `${zh} (${key})` : effort!.trim();
}

export const ENGINE_MODELS: Record<EngineType, ModelOption[]> = {
  claude: [
    { id: '', label: '默认模型', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'fable', label: 'Fable', description: '长程难题旗舰别名', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M)', description: '1M 上下文旗舰', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'opus', label: 'Opus', description: '深度推理主力', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'sonnet', label: 'Sonnet', description: '日常开发均衡', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'haiku', label: 'Haiku', description: '轻量高速', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
  ],
  codex: [
    { id: '', label: '默认模型', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], source: 'preset' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'preset' },
  ],
  antigravity: [
    { id: '', label: '默认（跟随 IDE）', source: 'preset' },
    { id: 'pro', label: 'Pro', description: '旗舰档位（agentapi --model=pro）', source: 'preset' },
    { id: 'flash', label: 'Flash', description: '均衡档位（agentapi --model=flash）', source: 'preset' },
    { id: 'flash_lite', label: 'Flash Lite', description: '快速轻量（agentapi --model=flash_lite）', source: 'preset' },
  ],
};

export function resolveModelOptions(engine: EngineType, catalog?: EngineModelCatalog | null): ModelOption[] {
  const discovered = catalog?.[engine]?.models;
  if (catalog?.[engine]) return discovered ?? [];
  // A disconnected desktop has no verified model catalog. Never display CLI tiers as desktop models.
  return engine === 'antigravity' ? [] : ENGINE_MODELS[engine] ?? [];
}

export function resolveEffortOptions(engine: EngineType, model?: string, catalog?: EngineModelCatalog | null): string[] {
  if (engine === 'antigravity') return [];
  const entry = catalog?.[engine];
  if (entry && !entry.supportsEffort) return [];
  const options = resolveModelOptions(engine, catalog);
  const key = model?.trim() ?? '';
  const match = options.find((m) => m.id === key) ?? options.find((m) => m.id.toLowerCase() === key.toLowerCase());
  if (match?.efforts && match.efforts.length > 0) return match.efforts;
  const fallback = ENGINE_MODELS[engine];
  const fbMatch = fallback?.find((m) => m.id.toLowerCase() === key.toLowerCase());
  if (fbMatch?.efforts && fbMatch.efforts.length > 0) return fbMatch.efforts;
  return engine === 'codex'
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : ['low', 'medium', 'high', 'xhigh', 'max'];
}

export function clampEffortForModel(
  engine: EngineType,
  model: string | undefined,
  effort: string | undefined,
  catalog?: EngineModelCatalog | null,
): string | undefined {
  const clean = effort?.trim();
  if (!clean || engine === 'antigravity') return undefined;
  const allowed = resolveEffortOptions(engine, model, catalog);
  if (allowed.length === 0) return undefined;
  if (allowed.includes(clean)) return clean;
  if (clean === 'ultra' && allowed.includes('max')) return 'max';
  if (clean === 'xhigh' && allowed.includes('high')) return 'high';
  return undefined;
}

export function formatModelLabel(
  engine: EngineType,
  model?: string,
  catalog?: EngineModelCatalog | null,
  effort?: string,
): string {
  const value = model?.trim() ?? '';
  const options = resolveModelOptions(engine, catalog);
  const baseLabel = !value
    ? (options[0]?.label ?? '默认模型')
    : (options.find((m) => m.id === value)?.label ?? ENGINE_MODELS[engine]?.find((m) => m.id === value)?.label ?? value);
  const cleanEffort = effort?.trim();
  if (cleanEffort && engine !== 'antigravity') {
    return `${baseLabel} · ${cleanEffort}`;
  }
  return baseLabel;
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
  activity?: Record<string, StreamEvent[]>;
}

export interface CreateBotInput {
  display_name: string;
  engine_type: EngineType;
  model?: string;
  reasoning_effort?: string;
  role: string;
  roleTemplate: string;
  system_prompt: string;
  permission_mode: PermissionMode;
  workspace_mode: WorkspaceMode;
  room: string;
  color?: string;
  is_supervisor?: boolean;
  external_session_id?: string;
  desktop_target_id?: string;
}
