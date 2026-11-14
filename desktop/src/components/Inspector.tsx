import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Check, CircleDot, Clock3, GitBranch, HardDrive,
  ListTree, LockKeyhole, ShieldCheck, SlidersHorizontal, X,
} from 'lucide-react';
import { useStudio, type InspectorTab } from '../store';
import { BotAvatar, EmptyState, EngineBadge, formatTime } from './Common';

const TABS: { id: InspectorTab; label: string; icon: React.ReactNode }[] = [
  { id: 'tasks', label: '任务', icon: <ListTree size={13} /> },
  { id: 'approvals', label: '审批', icon: <ShieldCheck size={13} /> },
  { id: 'locks', label: '文件锁', icon: <LockKeyhole size={13} /> },
  { id: 'health', label: '配额', icon: <Activity size={13} /> },
];

function TaskGraph(): React.ReactNode {
  const { state, activeRoom, setActiveBot } = useStudio();
  const messages = (state?.messages ?? []).filter((m) => m.room === activeRoom);
  const roots = messages.filter((m) => m.kind === 'user' && m.channel !== 'desktop').slice(-12);
  if (roots.length === 0) return <EmptyState icon={<ListTree size={22} />} title="暂无任务链" hint="用户下达需求后，树状进度与耗时统计会显示在这里。" />;
  return (
    <div className="space-y-4 p-3">
      {roots.map((root) => {
        const children = messages.filter((m) => m.id !== root.id && m.kind !== 'user' && (root.trace_id ? m.trace_id === root.trace_id : m.reply_to === root.id)).slice(0, 30);
        const done = children.filter((c) => c.status === 'done').length;
        return (
          <div key={root.id} className="rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
            <div className="flex items-start gap-2">
              <CircleDot size={13} className="mt-0.5 shrink-0 text-indigo-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] font-medium text-slate-200">{root.text.slice(0, 90)}</div>
                <div className="mono mt-0.5 flex items-center gap-2 text-slate-600"><Clock3 size={10} />{formatTime(root.created)} · {children.length} 条派单 / {done} 完成</div>
              </div>
            </div>
            <div className="mt-2 ml-2 space-y-1 border-l border-white/8 pl-3">
              {children.map((c) => {
                const bot = state?.bots.find((b) => b.bot_id === c.to || b.bot_id === c.from);
                return (
                  <button key={c.id} type="button" onClick={() => bot && setActiveBot(bot.bot_id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-white/5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.status === 'done' ? 'bg-emerald-400' : c.status === 'uncertain' ? 'bg-red-400' : 'bg-amber-400'}`} />
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-slate-400">{c.text.slice(0, 60)}</span>
                    {bot && <EngineBadge engine={bot.engine_type} />}
                  </button>
                );
              })}
              {children.length === 0 && <div className="px-1.5 py-1 text-[10.5px] text-slate-600">等待主管拆解派单…</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Approvals(): React.ReactNode {
  const { state, toast } = useStudio();
  const approvals = state?.approvals ?? [];
  const pauses = state?.hopPauses ?? [];
  if (approvals.length === 0 && pauses.length === 0) {
    return <EmptyState icon={<ShieldCheck size={22} />} title="没有待处理事项" hint="权限申请与触发 max_hops 的协商链会集中出现在这里等待你确认。" />;
  }
  return (
    <div className="space-y-2.5 p-3">
      {pauses.map((p) => (
        <div key={p.id} className="rounded-lg border border-red-500/25 bg-red-500/[.06] p-2.5">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-red-300"><AlertTriangle size={13} />检测到多轮自动协商</div>
          <div className="mono mt-1.5 space-y-0.5 text-[10.5px] text-red-200/70">
            <div>trace {p.trace_id || '(无)'} · {p.hop_count}/{p.max_hops} 跳</div>
            <div>{p.from_bot || '?'} → {p.to}</div>
          </div>
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="btn-primary flex-1 py-1.5" onClick={async () => { await window.studio.resolveHopPause(p.id, true); toast('已继续协商链', 'success'); }}><Check size={12} /> 继续</button>
            <button type="button" className="btn-ghost flex-1 border border-white/8 py-1.5" onClick={async () => { await window.studio.resolveHopPause(p.id, false); toast('已终止协商链并清空队列', 'info'); }}><X size={12} /> 终止</button>
          </div>
        </div>
      ))}
      {approvals.map((a) => (
        <div key={a.id} className="rounded-lg border border-violet-500/25 bg-violet-500/[.06] p-2.5">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-violet-300"><ShieldCheck size={13} />权限申请 · {a.bot_id}</div>
          <pre className="mono mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-ink-950/60 p-2 text-[10.5px] text-slate-400">{a.command}</pre>
          {a.files.length > 0 && <div className="mono mt-1 text-[10px] text-slate-500">影响文件：{a.files.join(', ')}</div>}
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="btn-primary flex-1 py-1.5" onClick={async () => { await window.studio.respondApproval(a.id, true); toast('已批准', 'success'); }}><Check size={12} /> 批准</button>
            <button type="button" className="btn-ghost flex-1 border border-white/8 py-1.5" onClick={async () => { await window.studio.respondApproval(a.id, false, '用户拒绝'); toast('已拒绝并中断该回合', 'info'); }}><X size={12} /> 拒绝</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Locks(): React.ReactNode {
  const { state, toast } = useStudio();
  const locks = state?.locks ?? [];
  return (
    <div className="p-3">
      {locks.length === 0 ? (
        <EmptyState icon={<LockKeyhole size={22} />} title="当前没有文件租约" hint="Bot 调用 reserve / EditGuard 自动租约时，这里会实时显示哪个 Bot 正在占用哪些文件，并可手动强制释放。" />
      ) : (
        <div className="space-y-2">
          {locks.map((l) => (
            <div key={l.id} className="rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
              <div className="flex items-center gap-2">
                <LockKeyhole size={12} className="text-amber-400" />
                <span className="flex-1 text-[11.5px] text-slate-300">{l.bot_id}</span>
                <button type="button" className="chip bg-red-500/10 text-red-300 hover:bg-red-500/20" onClick={async () => { await window.studio.releaseLock(l.id); toast('已通知引擎强制释放 EditGuard 文件锁', 'info'); }}>强制释放</button>
              </div>
              <div className="mono mt-1.5 space-y-0.5 text-[10.5px] text-slate-500">
                {l.paths.length ? l.paths.map((p) => <div key={p} className="truncate">{p}</div>) : <div>{l.reason}</div>}
                <div>到期 {formatTime(l.expires_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function quotaPercent(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const used = typeof v.used_pct === 'number' ? v.used_pct
    : typeof v.remaining_pct === 'number' ? 100 - (v.remaining_pct as number) : null;
  return used === null ? null : Math.max(0, Math.min(100, used));
}

function Health(): React.ReactNode {
  const { health, quotas, state, toast } = useStudio();
  const [hops, setHops] = useState(state?.maxHops ?? 10);
  const probes = health?.probes;
  const codexUsed = quotaPercent(quotas?.codex);
  const agyUsed = quotaPercent(quotas?.antigravity);

  const quotaBar = (label: string, used: number | null, blocked?: string | null): React.ReactNode => (
    <div className="rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className={used !== null && used >= 90 ? 'text-red-300' : 'text-slate-500'}>{used === null ? '暂无数据' : `${used.toFixed(0)}% 已用`}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
        <div className={`h-full rounded-full ${used !== null && used >= 90 ? 'bg-red-400' : 'bg-emerald-400'}`} style={{ width: `${used ?? 0}%` }} />
      </div>
      {blocked && <div className="mt-1.5 text-[10px] text-red-300">阻断原因：{blocked}</div>}
      {used === null && <pre className="mono mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap text-[9.5px] text-slate-600">{JSON.stringify(label === 'Codex' ? quotas?.codex : quotas?.antigravity, null, 1)?.slice(0, 260) ?? 'null'}</pre>}
    </div>
  );

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center gap-2 rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
        <HardDrive size={14} className={health?.online ? 'text-emerald-400' : 'text-red-400'} />
        <div className="flex-1">
          <div className="text-[11.5px] text-slate-200">内置 C# 引擎 {health?.online ? '在线' : '离线'}</div>
          <div className="mono mt-0.5 text-[10px] text-slate-600">127.0.0.1:16191 · pid {health?.pid ?? '—'} · SSE {health?.sse_clients ?? 0} · v{health?.version ?? '—'}</div>
        </div>
        <span className={`h-2 w-2 rounded-full ${health?.online ? 'dot-working' : 'dot-error'}`} />
      </div>

      <div className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-600">底座探针</div>
      {probes && (['claude', 'codex', 'antigravity'] as const).map((engine) => (
        <div key={engine} className="rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${probes[engine].available ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className="flex-1"><EngineBadge engine={engine} /></span>
            <span className="text-[10px] text-slate-500">{probes[engine].available ? '可用' : '不可用'}</span>
          </div>
          {probes[engine].reason && <div className="mt-1.5 break-words text-[10px] leading-relaxed text-red-300/80">{probes[engine].reason}</div>}
        </div>
      ))}

      <div className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-600">配额</div>
      {quotaBar('Codex', codexUsed, quotas?.codex_blocked_reason)}
      {quotaBar('Antigravity', agyUsed, quotas?.antigravity_blocked_reason)}

      <div className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-600">安全护栏</div>
      <div className="space-y-2 rounded-lg border border-white/6 bg-ink-950/40 p-2.5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={12} className="text-slate-500" />
          <span className="flex-1 text-[11px] text-slate-400">max_hops 上限</span>
          <input type="number" min={1} max={100} value={hops} onChange={(e) => setHops(Number(e.target.value))} className="w-14 rounded border border-white/8 bg-ink-900 px-1.5 py-0.5 text-center text-[11px] text-slate-200 outline-none" />
          <button type="button" className="chip bg-indigo-500/15 text-indigo-300" onClick={async () => { await window.studio.setMaxHops(hops); toast('已实时更新跳数上限', 'success'); }}>应用</button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
          <input type="checkbox" className="accent-indigo-400" checked={Boolean(state?.spawnEnabled)} onChange={async (e) => { await window.studio.setSpawnEnabled(e.target.checked); toast(e.target.checked ? '已开启主管自动招聘' : '已关闭主管自动招聘', 'info'); }} />
          允许主管调用 spawn_bot 自动招聘
        </label>
        <div className="mono flex items-start gap-1 text-[10px] leading-relaxed text-slate-600">
          <GitBranch size={10} className="mt-0.5" />
          <span className="break-all">数据目录 {health?.relay_home ?? '~/.nexus-bot-studio/relay'}</span>
        </div>
      </div>
    </div>
  );
}

export default function Inspector(): React.ReactNode {
  const { inspectorTab, setInspectorTab, setInspectorOpen, state } = useStudio();
  const badge = (state?.approvals.length ?? 0) + (state?.hopPauses.length ?? 0);
  return (
    <aside className="flex h-full min-h-0 flex-col bg-ink-900">
      <div className="flex items-center gap-0.5 border-b border-white/5 px-2 py-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setInspectorTab(t.id)}
            className={`relative flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[10.5px] transition-colors ${inspectorTab === t.id ? 'bg-white/8 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
            {t.icon}{t.label}
            {t.id === 'approvals' && badge > 0 && <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] text-white">{badge}</span>}
          </button>
        ))}
        <button type="button" title="收起面板" onClick={() => setInspectorOpen(false)} className="ml-1 text-slate-600 hover:text-slate-300"><X size={14} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {inspectorTab === 'tasks' && <TaskGraph />}
        {inspectorTab === 'approvals' && <Approvals />}
        {inspectorTab === 'locks' && <Locks />}
        {inspectorTab === 'health' && <Health />}
      </div>
    </aside>
  );
}
