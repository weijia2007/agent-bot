import { useEffect, useState } from 'react';
import {
  Activity, ChevronDown, ChevronRight, FileCode2, GitBranch, GitMerge, RefreshCcw,
  RotateCcw, Terminal, Wrench,
} from 'lucide-react';
import { useStudio } from '../store';
import type { BotConfig, DiffEntry, StreamEvent } from '../types';
import { EmptyState, formatTime } from './Common';

type Tab = 'stream' | 'diff';

function StreamRow({ item }: { item: StreamEvent }): React.ReactNode {
  const ev = item.event;
  const [open, setOpen] = useState(ev.type === 'tool_call_result');
  const style = 'rounded-lg border border-white/5 bg-ink-950/50 px-2.5 py-1.5';
  if (ev.type === 'text_delta') return <div className={`${style} stream-line text-[11.5px] leading-relaxed text-slate-300 whitespace-pre-wrap`}>{ev.text}</div>;
  if (ev.type === 'thinking_delta') return (
    <div className="rounded-lg border border-white/5 bg-white/[.015] px-2.5 py-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 text-[10.5px] text-slate-500">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 思考过程
      </button>
      {open && <div className="mt-1 pl-4 text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap">{ev.text}</div>}
    </div>
  );
  if (ev.type === 'tool_call_start') return (
    <div className={`${style} flex items-start gap-2`}>
      <Wrench size={12} className="mt-0.5 shrink-0 text-sky-400" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11px] text-sky-300">{ev.tool}</div>
        {ev.args && <div className="mono mt-0.5 truncate text-slate-600" title={ev.args}>{ev.args}</div>}
      </div>
      <span className="mono shrink-0 text-slate-600">{formatTime(item.at)}</span>
    </div>
  );
  if (ev.type === 'tool_call_result') return (
    <div className={`${style} flex items-start gap-2`}>
      <Terminal size={12} className={`mt-0.5 shrink-0 ${ev.ok === false ? 'text-red-400' : 'text-emerald-400'}`} />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => setOpen((v) => !v)} className="font-mono text-[11px] text-slate-300">{ev.tool} → 结果</button>
        {open && ev.output && <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-slate-500">{ev.output}</pre>}
      </div>
    </div>
  );
  if (ev.type === 'approval_required') return (
    <div className="rounded-lg border border-violet-500/25 bg-violet-500/[.07] px-2.5 py-2 text-[11px] text-violet-200">
      <div className="font-medium">等待权限审批</div>
      <div className="mono mt-1 truncate text-violet-200/60">{ev.command}</div>
    </div>
  );
  if (ev.type === 'error') return (
    <div className="rounded-lg border border-red-500/25 bg-red-500/[.07] px-2.5 py-2 text-[11px] text-red-200">
      <div className="font-medium">{ev.uncertain ? '交付不确定（不会自动重放）' : '错误'}</div>
      <div className="mt-1 whitespace-pre-wrap text-red-200/70">{ev.message}</div>
    </div>
  );
  return <div className={`${style} flex items-center gap-2 text-[11px] text-emerald-300`}><Activity size={12} />回合完成{ev.summary && <span className="truncate text-slate-500">{ev.summary.slice(0, 80)}</span>}</div>;
}

function DiffItem({ entry }: { entry: DiffEntry }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'unified' | 'side'>(entry.patch ? 'unified' : 'side');
  const color = entry.status === 'added' ? 'text-emerald-300' : entry.status === 'deleted' ? 'text-red-300' : 'text-amber-300';
  const patchLines = (entry.patch ?? '').split(/\r?\n/).filter((l) => !l.startsWith('diff ') && !l.startsWith('index '));
  return (
    <div className="rounded-lg border border-white/5 bg-ink-950/40">
      <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        <FileCode2 size={12} className="text-slate-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">{entry.path}</span>
        <span className={`chip bg-white/5 ${color}`}>{entry.status}</span>
        {open ? <ChevronDown size={12} className="text-slate-600" /> : <ChevronRight size={12} className="text-slate-600" />}
      </button>
      {open && (
        <div className="border-t border-white/5 p-2">
          <div className="mb-2 flex gap-1">
            {entry.patch && (
              <button type="button" onClick={() => setMode('unified')} className={`chip ${mode === 'unified' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-slate-500'}`}>Unified Patch</button>
            )}
            <button type="button" onClick={() => setMode('side')} className={`chip ${mode === 'side' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-slate-500'}`}>Side-by-side</button>
          </div>
          {mode === 'unified' && entry.patch ? (
            <pre className="mono max-h-72 overflow-auto rounded border border-white/5 bg-ink-950 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
              {patchLines.map((l, i) => {
                const cls = l.startsWith('@@')
                  ? 'text-sky-300/80 bg-sky-500/10 px-1'
                  : l.startsWith('+') && !l.startsWith('+++')
                    ? 'diff-add'
                    : l.startsWith('-') && !l.startsWith('---')
                      ? 'diff-del'
                      : 'text-slate-500';
                return <div key={i} className={cls}>{l || ' '}</div>;
              })}
            </pre>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <pre className="mono max-h-64 overflow-auto rounded border border-white/5 bg-ink-950 p-2 leading-relaxed text-slate-400 whitespace-pre-wrap">
                {entry.before ? entry.before.split('\n').map((l, i) => <div key={`b${i}`} className="diff-del">{l || ' '}</div>) : <span className="text-slate-600">（无旧内容）</span>}
              </pre>
              <pre className="mono max-h-64 overflow-auto rounded border border-white/5 bg-ink-950 p-2 leading-relaxed text-slate-400 whitespace-pre-wrap">
                {entry.after ? entry.after.split('\n').map((l, i) => <div key={`a${i}`} className="diff-add">{l || ' '}</div>) : <span className="text-slate-600">（无新内容）</span>}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WorkspacePanel({ bot }: { bot: BotConfig }): React.ReactNode {
  const { streams, toast } = useStudio();
  const [tab, setTab] = useState<Tab>('stream');
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const events = streams[bot.bot_id] ?? [];

  const loadDiffs = async (): Promise<void> => {
    setDiffs(await window.studio.getDiffs(bot.bot_id));
    setStatus(await window.studio.worktreeStatus(bot.bot_id));
  };
  useEffect(() => { void loadDiffs(); }, [bot.bot_id]);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; message: string } | string>): Promise<void> => {
    setBusy(true);
    try {
      const result = await fn();
      const message = typeof result === 'string' ? result : result.message;
      toast(`${label}：${message.slice(0, 220)}`, typeof result === 'string' || result.ok ? 'success' : 'error');
      await loadDiffs();
    } catch (e) { toast(`${label}失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900/60">
      <div className="flex items-center gap-1 border-b border-white/5 px-2.5 py-2">
        <button type="button" onClick={() => setTab('stream')} className={`btn px-2.5 py-1.5 ${tab === 'stream' ? 'bg-white/8 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
          <Activity size={13} /> 实时动作流
        </button>
        <button type="button" onClick={() => { setTab('diff'); void loadDiffs(); }} className={`btn px-2.5 py-1.5 ${tab === 'diff' ? 'bg-white/8 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
          <FileCode2 size={13} /> 变更 / Diff <span className="rounded bg-white/8 px-1 text-[10px]">{diffs.length}</span>
        </button>
        <button type="button" title="刷新" onClick={() => void loadDiffs()} className="ml-auto text-slate-600 hover:text-slate-300"><RefreshCcw size={13} /></button>
      </div>

      {tab === 'stream' ? (
        <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {events.length === 0 ? (
            <EmptyState icon={<Terminal size={22} />} title="等待该 Bot 开始工作" hint="思考过程、工具调用、终端输出与 MCP send/reply 都会实时出现在这里。" />
          ) : events.map((item, i) => <StreamRow key={`${item.at}-${i}`} item={item} />)}
        </div>
      ) : (
        <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {diffs.length === 0 ? (
            <EmptyState icon={<FileCode2 size={22} />} title="暂无文件变更" hint="Bot 修改文件后，这里会列出所有变更并提供语法高亮的 Side-by-Side Diff。" />
          ) : diffs.map((d) => <DiffItem key={d.path} entry={d} />)}
        </div>
      )}

      <div className="border-t border-white/5 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[10.5px] text-slate-500">
          <GitBranch size={12} className="text-emerald-400" />
          <span className="mono truncate" title={bot.worktree_branch}>{bot.worktree_branch ?? '共享主目录（EditGuard 文件锁）'}</span>
        </div>
        {status && <pre className="mono mb-2 max-h-20 overflow-auto whitespace-pre-wrap rounded border border-white/5 bg-ink-950/60 p-2 text-slate-500">{status}</pre>}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={busy} className="btn-ghost border border-white/8 px-2 py-1.5" onClick={() => void run('分支状态', () => window.studio.worktreeStatus(bot.bot_id))}>
            <GitBranch size={12} /> 分支状态
          </button>
          <button type="button" disabled={busy || !bot.worktree_branch} className="btn-ghost border border-white/8 px-2 py-1.5" onClick={() => void run('合并', () => window.studio.mergeWorktree(bot.bot_id))}>
            <GitMerge size={12} /> Merge 到主工作区
          </button>
          <button type="button" disabled={busy} className="btn-ghost border border-white/8 px-2 py-1.5" onClick={() => void run('重置', () => window.studio.resetWorktree(bot.bot_id))}>
            <RotateCcw size={12} /> 重置 Worktree
          </button>
        </div>
      </div>
    </div>
  );
}
