import type { ReactNode } from 'react';
import type { BotConfig, BotStatus, EngineType, RoomMessage } from '../types';
import { ENGINE_COLORS, ENGINE_LABELS } from '../types';

export function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function HandoffContext({ handoff }: { handoff?: RoomMessage['handoff'] }): ReactNode {
  if (!handoff) return null;
  return <details className="mt-2 rounded-lg border border-sky-500/15 bg-sky-500/5 p-2 text-xs text-slate-400">
    <summary className="cursor-pointer text-sky-300">随任务转交的上游汇报 · {handoff.from}</summary>
    <div className="mt-2 whitespace-pre-wrap break-words select-text">{handoff.text}</div>
  </details>;
}

export function BotAvatar({ bot, size = 32 }: { bot: BotConfig; size?: number }): ReactNode {
  const color = bot.color || ENGINE_COLORS[bot.engine_type];
  return (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-lg font-semibold text-ink-950"
      style={{ width: size, height: size, background: `linear-gradient(140deg, ${color}, ${color}aa)`, fontSize: size * 0.42 }}
      title={`${bot.display_name} · ${ENGINE_LABELS[bot.engine_type]}`}
    >
      {bot.display_name.slice(0, 1).toUpperCase()}
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900" style={{ background: color }} />
    </div>
  );
}

export function StatusDot({ status, pulse = true }: { status: BotStatus; pulse?: boolean }): ReactNode {
  const labels: Record<BotStatus, string> = {
    idle: '空闲', working: '执行中', queued: '排队中', error: '异常', paused: '已暂停', waiting_approval: '等待审批',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400" title={labels[status]}>
      <span className={`h-2 w-2 rounded-full dot-${status} ${pulse && (status === 'working' || status === 'queued' || status === 'waiting_approval') ? 'animate-pulseDot' : ''}`} />
      {labels[status]}
    </span>
  );
}

export function EngineBadge({ engine }: { engine: EngineType }): ReactNode {
  const color = ENGINE_COLORS[engine];
  return (
    <span className="chip border" style={{ color, borderColor: `${color}40`, background: `${color}12` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {ENGINE_LABELS[engine]}
    </span>
  );
}

export function IconButton({ children, title, onClick, active, danger }: {
  children: ReactNode; title: string; onClick?: () => void; active?: boolean; danger?: boolean;
}): ReactNode {
  return (
    <button
      type="button" title={title} onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${danger ? 'text-red-400 hover:bg-red-500/15' : active ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500 hover:bg-white/5 hover:text-slate-200'}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/5 bg-white/[.03] text-slate-600">{icon}</div>
      <div className="text-sm font-medium text-slate-400">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-slate-600">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between px-1 pb-2 pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-600">{children}</span>
      {right}
    </div>
  );
}
