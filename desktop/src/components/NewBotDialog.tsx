import { useEffect, useState } from 'react';
import { Check, Crown, FolderGit2, LockKeyhole, Sparkles, X, Zap } from 'lucide-react';
import { useStudio } from '../store';
import { ENGINE_COLORS, ENGINE_LABELS } from '../types';
import type { EngineType, PermissionMode, WorkspaceMode } from '../types';
import { ROLE_TEMPLATE_OPTIONS } from '../roleTemplates';

const COLOR_PRESETS = ['#e9a23b', '#3ecf8e', '#5b9dff', '#a78bfa', '#f472b6', '#f05252', '#22d3ee', '#facc15'];

export function NewRoomDialog(): React.ReactNode {
  const { setNewRoomOpen, setActiveRoom, toast } = useStudio();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm" onClick={() => setNewRoomOpen(false)}>
      <div className="w-[440px] rounded-2xl border border-white/10 bg-ink-850 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">新建协作房间</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">一个房间 = 一个项目主题，各 Bot 在其中共享消息与任务链</p>
          </div>
          <button type="button" onClick={() => setNewRoomOpen(false)} className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>
        <label className="label">房间名称</label>
        <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：支付网关重构" autoFocus />
        <label className="label">项目根目录（可选，用于 Git Worktree 隔离）</label>
        <div className="flex gap-2">
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\projects\my-app" />
          <button type="button" className="btn-ghost shrink-0 border border-white/8" onClick={async () => { const p = await window.studio.pickProject(); if (p) setPath(p); }}>浏览</button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setNewRoomOpen(false)}>取消</button>
          <button type="button" disabled={!name.trim() || busy} className="btn-primary" onClick={async () => {
            setBusy(true);
            try { const room = await window.studio.createRoom(name, path); setActiveRoom(room.id); setNewRoomOpen(false); toast(`房间「${room.name}」已创建`, 'success'); }
            catch (e) { toast(`创建失败：${(e as Error).message}`, 'error'); }
            finally { setBusy(false); }
          }}>创建房间</button>
        </div>
      </div>
    </div>
  );
}

export default function NewBotDialog(): React.ReactNode {
  const { state, activeRoom, setNewBotOpen, toast } = useStudio();
  const [displayName, setDisplayName] = useState('');
  const [engine, setEngine] = useState<EngineType>('claude');
  const [roleTemplate, setRoleTemplate] = useState('fullstack');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [permission, setPermission] = useState<PermissionMode>('auto');
  const [workspace, setWorkspace] = useState<WorkspaceMode>('worktree');
  const [color, setColor] = useState(ENGINE_COLORS.claude);
  const [supervisor, setSupervisor] = useState(false);
  const [busy, setBusy] = useState(false);

  const room = state?.rooms.find((r) => r.id === activeRoom);
  const hasSupervisor = state?.bots.some((b) => b.room === activeRoom && b.is_supervisor);

  useEffect(() => { setColor(ENGINE_COLORS[engine]); }, [engine]);

  const option = ROLE_TEMPLATE_OPTIONS.find((r) => r.id === roleTemplate);

  const create = async (): Promise<void> => {
    if (!displayName.trim() || busy) return;
    setBusy(true);
    try {
      await window.studio.createBot({
        display_name: displayName.trim(),
        engine_type: engine,
        role: option?.role ?? roleTemplate,
        roleTemplate,
        system_prompt: systemPrompt || option?.prompt || '',
        permission_mode: permission,
        workspace_mode: workspace,
        room: activeRoom,
        color,
        is_supervisor: supervisor,
      });
      setNewBotOpen(false);
      toast(`Bot「${displayName.trim()}」创建请求已提交，正在绑定独立底层会话`, 'success');
      setDisplayName(''); setSystemPrompt(''); setSupervisor(false);
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setNewBotOpen(false)}>
      <div className="flex max-h-[92vh] w-[620px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300"><Sparkles size={17} /></span>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">新建 Bot</h2>
              <p className="text-[11px] text-slate-500">每个 Bot 对应底层引擎中一个独立、持久化的真实会话</p>
            </div>
          </div>
          <button type="button" onClick={() => setNewBotOpen(false)} className="text-slate-500 hover:text-slate-200"><X size={17} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-[1fr,auto] gap-4">
            <div>
              <label className="label">Bot 名称</label>
              <input className="input" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：前端小 C" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
            </div>
            <div>
              <label className="label">头像配色</label>
              <div className="flex gap-1.5 pt-1">
                {COLOR_PRESETS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)} className="flex h-7 w-7 items-center justify-center rounded-lg border transition-transform hover:scale-110" style={{ background: `${c}22`, borderColor: color === c ? c : 'transparent' }}>
                    <span className="h-3 w-3 rounded-full" style={{ background: c }} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="label">底座 Agent</label>
            <div className="grid grid-cols-3 gap-2">
              {(['claude', 'codex', 'antigravity'] as EngineType[]).map((e) => (
                <button key={e} type="button" onClick={() => setEngine(e)}
                  className={`relative flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${engine === e ? 'border-white/20 bg-white/[.06]' : 'border-white/6 bg-ink-950/40 hover:border-white/12'}`}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: ENGINE_COLORS[e], boxShadow: `0 0 10px ${ENGINE_COLORS[e]}66` }} />
                  <span className="text-xs font-medium text-slate-200">{ENGINE_LABELS[e]}</span>
                  {engine === e && <Check size={13} className="ml-auto text-indigo-300" />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label">角色模板</label>
            <select className="input" value={roleTemplate} onChange={(e) => { setRoleTemplate(e.target.value); const o = ROLE_TEMPLATE_OPTIONS.find((x) => x.id === e.target.value); if (o && !systemPrompt) setSystemPrompt(o.prompt); }}>
              {ROLE_TEMPLATE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label"><Zap size={11} className="mr-1 inline" />权限模式</label>
              <div className="space-y-1.5">
                {([['auto', '自动执行（工作区内）'], ['ask_ui', '敏感操作弹窗审批']] as [PermissionMode, string][]).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setPermission(v)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-[11.5px] ${permission === v ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-white/6 text-slate-400 hover:bg-white/5'}`}>
                    <span className={`h-2 w-2 rounded-full ${permission === v ? 'bg-indigo-400' : 'bg-slate-600'}`} />{label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label"><FolderGit2 size={11} className="mr-1 inline" />工作区模式</label>
              <div className="space-y-1.5">
                {([['worktree', '自动分配独立 Git Worktree'], ['shared', '共享目录 + 文件锁']] as [WorkspaceMode, string][]).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setWorkspace(v)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-[11.5px] ${workspace === v ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-white/6 text-slate-400 hover:bg-white/5'}`}>
                    <span className={`h-2 w-2 rounded-full ${workspace === v ? 'bg-indigo-400' : 'bg-slate-600'}`} />{label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="label">专属 System Prompt</label>
            <textarea className="input mono h-24 leading-relaxed" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="这个 Bot 的人设、职责边界、交付规范…" />
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/6 bg-white/[.02] px-3 py-2.5">
            <input type="checkbox" className="mt-0.5 accent-amber-400" checked={supervisor} onChange={(e) => setSupervisor(e.target.checked)} />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200"><Crown size={12} className="text-amber-400" />设为主管 Bot（Primary / Supervisor）</span>
              <span className="mt-0.5 block text-[10.5px] text-slate-500">主管负责拆解任务、派单、组织交叉审查并汇总；{hasSupervisor ? '当前房间已有主管，新建后会自动替换。' : '当前房间还没有主管。'}</span>
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-ink-950/50 px-3 py-2 text-[10.5px] leading-relaxed text-slate-500">
            <LockKeyhole size={12} className="mt-0.5 shrink-0" />
            <span>房间：<span className="text-slate-400">{room?.name ?? activeRoom}</span>。数据目录与 MCP 端口与原版 NexusRelay 完全隔离；所有子进程以隐藏窗口方式启动。</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-3.5">
          <button type="button" className="btn-ghost" onClick={() => setNewBotOpen(false)}>取消</button>
          <button type="button" className="btn-primary px-5" disabled={!displayName.trim() || busy} onClick={() => void create()}>
            {busy ? '正在创建真实会话…' : '创建 Bot'}
          </button>
        </div>
      </div>
    </div>
  );
}
