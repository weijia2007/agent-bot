import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import { useStudio } from '../store';
import {
  EFFORT_LABELS, clampEffortForModel, formatModelLabel, resolveEffortOptions, resolveModelOptions,
  type EngineType, type StreamEvent, type TraceStep,
} from '../types';

export interface LiveTurnPreview {
  text: string;
  thinking: string;
  activeTool: string | null;
  steps: TraceStep[];
  startedAt?: string;
  lastEventAt?: string;
}

/** Extracts streaming output and process timeline belonging only to the currently executing turn. */
export function extractLiveTurnStream(events: StreamEvent[]): LiveTurnPreview {
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].event.type;
    if (t === 'turn_completed') {
      startIdx = i + 1;
      break;
    }
    if (t === 'error') {
      const next = events[i + 1];
      const gapMs = next ? Date.parse(next.at) - Date.parse(events[i].at) : 0;
      if (!next || gapMs > 10_000) {
        startIdx = i + 1;
        break;
      }
    }
  }
  let text = '';
  let thinking = '';
  let activeTool: string | null = null;
  const steps: TraceStep[] = [];
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;

  for (let i = startIdx; i < events.length; i++) {
    const item = events[i];
    if (!startedAt) startedAt = item.at;
    lastEventAt = item.at;
    const ev = item.event;
    if (ev.type === 'text_delta') {
      text += ev.text;
    } else if (ev.type === 'thinking_delta') {
      thinking += ev.text;
      const last = steps[steps.length - 1];
      if (last?.kind === 'thinking') {
        last.detail = `${last.detail ?? ''}${ev.text}`;
        last.at = item.at;
      } else {
        steps.push({ kind: 'thinking', title: '思考过程', detail: ev.text, at: item.at });
      }
    } else if (ev.type === 'tool_call_start') {
      activeTool = ev.tool;
      steps.push({ kind: 'tool_start', title: ev.tool, detail: ev.args, at: item.at });
    } else if (ev.type === 'tool_call_result') {
      activeTool = null;
      steps.push({ kind: 'tool_result', title: ev.tool, detail: ev.output, ok: ev.ok, at: item.at });
    } else if (ev.type === 'error') {
      steps.push({ kind: 'error', title: '异常信息', detail: ev.message, ok: false, at: item.at });
    }
  }
  return { text, thinking, activeTool, steps, startedAt, lastEventAt };
}

interface ModelPickerProps {
  engine: EngineType;
  model?: string;
  effort?: string;
  onChange: (nextModel: string, nextEffort?: string) => void;
  direction?: 'up' | 'down';
  align?: 'left' | 'right';
  compact?: boolean;
  targetId?: string;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  engine, model, effort, onChange, direction = 'down', align = 'right', compact = false, targetId,
}) => {
  const { modelsCatalog, modelsLoading, loadModels } = useStudio();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(model ?? '');
  const boxRef = useRef<HTMLDivElement>(null);
  const current = model?.trim() ?? '';
  const currentEffort = effort?.trim() ?? '';
  const catalogEntry = modelsCatalog?.[engine];
  const options = (targetId && engine === 'antigravity' ? catalogEntry?.targetModels?.[targetId] : undefined) ?? resolveModelOptions(engine, modelsCatalog);
  const supportsEffort = catalogEntry ? catalogEntry.supportsEffort : engine !== 'antigravity';
  const effortOptions = resolveEffortOptions(engine, current, modelsCatalog);
  const activeOpt = options.find((m) => m.id === current);
  const supportsCustom = engine !== 'antigravity';

  useEffect(() => { setCustom(model ?? ''); }, [model]);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const applyModel = (nextModel: string): void => {
    const clean = nextModel.trim();
    const nextEffort = currentEffort
      ? (clampEffortForModel(engine, clean, currentEffort, modelsCatalog) ?? '')
      : undefined;
    onChange(clean, nextEffort);
    if (!supportsEffort) setOpen(false);
  };

  const applyEffort = (nextEffort: string): void => {
    onChange(current, nextEffort);
  };

  const buttonLabel = formatModelLabel(engine, current, modelsCatalog, currentEffort);

  return (
    <div ref={boxRef} className="relative inline-block">
      <button
        type="button"
        disabled={engine === 'claude'}
        onClick={() => setOpen((v) => !v)}
        title={engine === 'claude' ? 'Claude 模型请在原桌面对话中切换，实际模型会同步显示' : '切换真实桌面对话的模型与推理强度'}
        className={`flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[.04] text-slate-200 hover:border-white/20 hover:bg-white/[.08] transition-colors ${
          compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-[11.5px]'
        }`}
      >
        <Sparkles className="w-3 h-3 text-indigo-300 shrink-0" />
        <span className="truncate max-w-[190px]">{buttonLabel}</span>
        <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute ${direction === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${align === 'left' ? 'left-0' : 'right-0'} z-40 w-72 rounded-xl border border-white/10 bg-ink-850 shadow-2xl p-2`}
        >
          <div className="flex items-center justify-between px-1.5 pb-1.5 text-[10px] text-slate-400">
            <span className="font-medium">
              选择模型
              {catalogEntry?.discoveredAt && (
                <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] text-emerald-300">已自动读取</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => { void loadModels(true); }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
              title="重新读取本机已安装的模型与强度"
            >
              <RefreshCw className={`w-2.5 h-2.5 ${modelsLoading ? 'animate-spin' : ''}`} /> 刷新
            </button>
          </div>

          <div className="max-h-56 overflow-y-auto space-y-0.5 pr-0.5">
            {options.map((opt) => {
              const active = current === opt.id;
              return (
                <button
                  key={opt.id || 'default'}
                  type="button"
                  onClick={() => applyModel(opt.id)}
                  className={`w-full flex items-start justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                    active ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="truncate font-medium">{opt.label}</span>
                      {opt.id && opt.id !== opt.label && (
                        <span className="truncate font-mono text-[9.5px] text-slate-500">{opt.id}</span>
                      )}
                      {opt.defaultEffort && supportsEffort && (
                        <span className="shrink-0 rounded bg-white/[.06] px-1 py-0.5 text-[9px] text-slate-400">
                          默认 {opt.defaultEffort}
                        </span>
                      )}
                    </div>
                    {opt.description && (
                      <div className="truncate text-[10px] text-slate-500 mt-0.5">{opt.description}</div>
                    )}
                  </div>
                  {active && <Check className="w-3.5 h-3.5 text-indigo-300 shrink-0 mt-0.5" />}
                </button>
              );
            })}
          </div>

          {supportsEffort && effortOptions.length > 0 && (
            <div className="mt-2 pt-2 border-t border-white/8 px-1">
              <div className="mb-1.5 flex items-center justify-between text-[10px] text-slate-400">
                <span>推理强度</span>
                {(activeOpt?.defaultEffort || catalogEntry?.defaultEffort) && (
                  <span className="text-slate-500">
                    模型默认：{activeOpt?.defaultEffort ?? catalogEntry?.defaultEffort}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => applyEffort('')}
                  className={`rounded-md border px-2 py-0.5 text-[10.5px] transition-colors ${
                    !currentEffort
                      ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
                      : 'border-white/8 bg-white/[.03] text-slate-400 hover:bg-white/5'
                  }`}
                >
                  默认
                </button>
                {effortOptions.map((eff) => {
                  const active = currentEffort === eff;
                  const zh = EFFORT_LABELS[eff];
                  return (
                    <button
                      key={eff}
                      type="button"
                      onClick={() => applyEffort(eff)}
                      className={`rounded-md border px-2 py-0.5 text-[10.5px] transition-colors ${
                        active
                          ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
                          : 'border-white/8 bg-white/[.03] text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      {zh ? `${zh} ${eff}` : eff}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {supportsCustom ? (
            <form
              onSubmit={(e) => { e.preventDefault(); applyModel(custom); setOpen(false); }}
              className="mt-2 pt-1.5 border-t border-white/8 flex items-center gap-1 px-0.5"
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="自定义模型 ID…"
                className="flex-1 min-w-0 bg-ink-950/80 border border-white/10 focus:border-indigo-500/50 rounded-md px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 outline-none"
              />
              <button type="submit" className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 text-[11px] text-slate-200">
                应用
              </button>
            </form>
          ) : (
            <p className="mt-2 border-t border-white/8 px-1 pt-1.5 pb-0.5 text-[10px] text-slate-400 leading-relaxed">
              {catalogEntry?.effortNote ?? '切换 Pro / Flash / Flash Lite 将重绑底层会话；选择默认即跟随当前 Antigravity IDE 模型与强度。'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
