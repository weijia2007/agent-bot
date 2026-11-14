import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { ENGINE_MODELS, formatModelLabel, type EngineType, type StreamEvent } from '../types';

export interface LiveTurnPreview {
  text: string;
  thinking: string;
  activeTool: string | null;
}

/** Extracts streaming output belonging only to the currently executing turn. */
export function extractLiveTurnStream(events: StreamEvent[]): LiveTurnPreview {
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].event.type;
    if (t === 'turn_completed' || t === 'error') {
      startIdx = i + 1;
      break;
    }
  }
  let text = '';
  let thinking = '';
  let activeTool: string | null = null;
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i].event;
    if (ev.type === 'text_delta') text += ev.text;
    else if (ev.type === 'thinking_delta') thinking += ev.text;
    else if (ev.type === 'tool_call_start') activeTool = ev.tool;
    else if (ev.type === 'tool_call_result') activeTool = null;
  }
  return { text, thinking, activeTool };
}

interface ModelPickerProps {
  engine: EngineType;
  model?: string;
  onChange: (nextModel: string) => void;
  direction?: 'up' | 'down';
  align?: 'left' | 'right';
  compact?: boolean;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  engine, model, onChange, direction = 'down', align = 'right', compact = false,
}) => {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(model ?? '');
  const boxRef = useRef<HTMLDivElement>(null);
  const current = model?.trim() ?? '';
  const presets = ENGINE_MODELS[engine] ?? [];
  const supportsOverride = engine !== 'antigravity';

  useEffect(() => { setCustom(model ?? ''); }, [model]);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const apply = (next: string): void => {
    onChange(next.trim());
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={supportsOverride ? '切换执行模型' : 'Antigravity 模型在 IDE 内切换'}
        className={`flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[.04] text-slate-200 hover:border-white/20 hover:bg-white/[.08] transition-colors ${
          compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-[11.5px]'
        }`}
      >
        <Sparkles className="w-3 h-3 text-indigo-300 shrink-0" />
        <span className="truncate max-w-[140px]">{formatModelLabel(engine, current)}</span>
        <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute ${direction === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${align === 'left' ? 'left-0' : 'right-0'} z-40 w-60 rounded-xl border border-white/10 bg-ink-850 shadow-2xl p-1.5`}
        >
          <div className="px-2 py-1 text-[10px] font-medium text-slate-500">
            {supportsOverride ? '选择模型' : 'Antigravity 模型说明'}
          </div>
          {presets.map((opt) => {
            const active = current === opt.id;
            return (
              <button
                key={opt.id || 'default'}
                type="button"
                onClick={() => apply(opt.id)}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors ${
                  active ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <span>{opt.label}</span>
                {active && <Check className="w-3.5 h-3.5 text-indigo-300" />}
              </button>
            );
          })}
          {supportsOverride ? (
            <form
              onSubmit={(e) => { e.preventDefault(); apply(custom); }}
              className="mt-1.5 pt-1.5 border-t border-white/8 flex items-center gap-1 px-1"
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
            <p className="px-2.5 py-1.5 text-[11px] text-slate-400 leading-relaxed">
              Antigravity 会话跟随 IDE 当前选中的模型，请在 Antigravity 窗口内切换。
            </p>
          )}
        </div>
      )}
    </div>
  );
};
