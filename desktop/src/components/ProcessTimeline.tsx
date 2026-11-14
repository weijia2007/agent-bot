import { useEffect, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronRight, Clock, Sparkles, Terminal, Wrench, XCircle,
} from 'lucide-react';
import type { BotStatus, TraceStep } from '../types';
import { formatTime } from './Common';
import type { LiveTurnPreview } from './ModelPicker';

function formatElapsed(startedAt?: string, nowMs = Date.now()): string {
  if (!startedAt) return '0s';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '0s';
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem.toString().padStart(2, '0')}s`;
}

function StepRow({ step, defaultExpanded = false }: { step: TraceStep; defaultExpanded?: boolean }): React.ReactNode {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (step.kind === 'thinking') {
    const snippet = (step.detail ?? '').trim();
    if (!snippet) return null;
    return (
      <div className="rounded-lg border border-indigo-500/15 bg-indigo-500/[.04] px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1.5 text-left text-[11px] text-indigo-300/90"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Sparkles size={11} className="shrink-0" />
          <span className="font-medium">思考推理</span>
          <span className="ml-auto mono text-[10px] text-slate-500">{formatTime(step.at)}</span>
        </button>
        {expanded && (
          <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words pl-4 text-[11.5px] leading-relaxed text-slate-300/90 select-text">
            {snippet}
          </div>
        )}
      </div>
    );
  }

  if (step.kind === 'tool_start') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-white/6 bg-ink-950/60 px-2.5 py-1.5 text-[11px]">
        <Wrench size={11} className="mt-0.5 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium text-sky-300">{step.title}</span>
            <span className="mono ml-auto text-[10px] text-slate-600">{formatTime(step.at)}</span>
          </div>
          {step.detail && (
            <div className="mono mt-0.5 truncate text-[10.5px] text-slate-400" title={step.detail}>
              {step.detail}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step.kind === 'tool_result') {
    const hasDetail = Boolean(step.detail?.trim());
    return (
      <div className="rounded-lg border border-white/6 bg-ink-950/40 px-2.5 py-1.5 text-[11px]">
        <button
          type="button"
          disabled={!hasDetail}
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          {step.ok === false
            ? <XCircle size={11} className="shrink-0 text-red-400" />
            : <CheckCircle2 size={11} className="shrink-0 text-emerald-400" />}
          <Terminal size={11} className="shrink-0 text-slate-500" />
          <span className="font-mono text-slate-300">{step.title} 输出</span>
          {hasDetail && (
            <span className="text-[10px] text-slate-500">{expanded ? '收起' : '查看'}</span>
          )}
          <span className="mono ml-auto text-[10px] text-slate-600">{formatTime(step.at)}</span>
        </button>
        {expanded && hasDetail && (
          <pre className="mono mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-white/5 bg-ink-950/80 p-2 text-[10.5px] text-slate-400 select-text">
            {step.detail}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[.06] px-2.5 py-1.5 text-[11px] text-amber-200">
      <XCircle size={11} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{step.detail || step.title}</div>
      <span className="mono shrink-0 text-[10px] text-amber-200/50">{formatTime(step.at)}</span>
    </div>
  );
}

export function LiveProcessCard({
  live, status, compact = false, onOpenDetail,
}: {
  live: LiveTurnPreview;
  status: BotStatus;
  compact?: boolean;
  onOpenDetail?: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'working' && status !== 'queued') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const toolCount = live.steps.filter((s) => s.kind === 'tool_start').length;
  const visibleSteps = compact ? live.steps.slice(-6) : live.steps.slice(-16);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5 text-indigo-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {status === 'queued' ? '排队等待中…' : live.activeTool ? `正在调用 ${live.activeTool}` : live.thinking ? '正在思考推理…' : '正在等待响应…'}
        </span>
        {live.startedAt && (
          <span className="chip bg-white/[.04] text-slate-400 mono">
            <Clock size={10} /> {formatElapsed(live.startedAt, now)}
          </span>
        )}
        {toolCount > 0 && (
          <span className="chip border border-sky-500/20 bg-sky-500/10 text-sky-300">
            <Wrench size={10} /> 工具 ×{toolCount}
          </span>
        )}
        {live.steps.length > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            className="text-[10.5px] text-slate-500 hover:text-slate-300"
          >
            {open ? '收起过程' : `展开过程 (${live.steps.length})`}
          </button>
        )}
        {onOpenDetail && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenDetail(); }}
            className="ml-auto text-[10.5px] text-indigo-300/80 hover:text-indigo-200"
          >
            单聊详情 →
          </button>
        )}
      </div>

      {open && visibleSteps.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-white/8 bg-ink-900/70 p-2.5">
          {visibleSteps.map((step, idx) => (
            <StepRow
              key={`${step.at}-${step.kind}-${idx}`}
              step={step}
              defaultExpanded={step.kind === 'thinking' && idx === visibleSteps.length - 1 && !live.text}
            />
          ))}
        </div>
      )}

      {live.text && (
        <div className="text-[13.5px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words select-text">
          {live.text}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-indigo-400 align-middle" />
        </div>
      )}
    </div>
  );
}

export function MessageTraceDrawer({ steps }: { steps?: TraceStep[] }): React.ReactNode {
  const [open, setOpen] = useState(false);
  if (!steps || steps.length === 0) return null;

  const toolCount = steps.filter((s) => s.kind === 'tool_start').length;
  const thinkCount = steps.filter((s) => s.kind === 'thinking' && s.detail?.trim()).length;
  const summaryParts = [
    thinkCount > 0 ? `思考 ×${thinkCount}` : '',
    toolCount > 0 ? `工具 ×${toolCount}` : '',
  ].filter(Boolean);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[.03] px-2.5 py-1 text-[11px] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Sparkles size={11} className="text-indigo-300" />
        <span>思考与工具过程{summaryParts.length ? ` · ${summaryParts.join(' / ')}` : ` · ${steps.length} 步`}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-xl border border-white/8 bg-ink-900/60 p-2.5">
          {steps.map((step, idx) => (
            <StepRow
              key={`${step.at}-${step.kind}-${idx}`}
              step={step}
              defaultExpanded={step.kind === 'thinking' && idx === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
