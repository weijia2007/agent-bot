import { useEffect, useState } from 'react';
import { Check, ChevronDown, Crown, FolderGit2, RefreshCw, Sparkles, X, Zap } from 'lucide-react';
import { useStudio } from '../store';
import {
  EFFORT_LABELS, ENGINE_COLORS, ENGINE_LABELS, clampEffortForModel, resolveEffortOptions, resolveModelOptions,
} from '../types';
import type { DesktopSession, EngineType, PermissionMode, WorkspaceMode } from '../types';
import { ROLE_TEMPLATE_OPTIONS } from '../roleTemplates';

const COLOR_PRESETS = ['#e9a23b', '#3ecf8e', '#5b9dff', '#a78bfa', '#f472b6', '#f05252', '#22d3ee', '#facc15'];

export function NewRoomDialog(): React.ReactNode {
  const { setNewRoomOpen, setNewBotOpen, setActiveRoom, toast } = useStudio();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm" onClick={() => setNewRoomOpen(false)}>
      <div className="w-[440px] rounded-2xl border border-white/10 bg-ink-850 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">新建项目</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">一个房间 = 一个项目主题，各 Bot 在其中共享消息与任务链</p>
          </div>
          <button type="button" onClick={() => setNewRoomOpen(false)} className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>
        <label className="label">项目名称</label>
        <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：支付网关重构" autoFocus />
        <label className="label">项目根目录（可选，需与原桌面对话目录一致）</label>
        <div className="flex gap-2">
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\projects\my-app" />
          <button type="button" className="btn-ghost shrink-0 border border-white/8" onClick={async () => { const p = await window.studio.pickProject(); if (p) setPath(p); }}>浏览</button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setNewRoomOpen(false)}>取消</button>
          <button type="button" disabled={!name.trim() || busy} className="btn-primary" onClick={async () => {
            setBusy(true);
            try { const room = await window.studio.createRoom(name, path); setActiveRoom(room.id); setNewRoomOpen(false); setNewBotOpen(true); toast(`项目「${room.name}」已创建，请先设置主管 Bot`, 'success'); }
            catch (e) { toast(`创建失败：${(e as Error).message}`, 'error'); }
            finally { setBusy(false); }
          }}>创建并设置主管</button>
        </div>
      </div>
    </div>
  );
}

export default function NewBotDialog(): React.ReactNode {
  const { state, activeRoom, modelsCatalog, modelsLoading, loadModels, setNewBotOpen, toast } = useStudio();
  const [displayName, setDisplayName] = useState('');
  const [engine, setEngine] = useState<EngineType>('claude');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [customModelMode, setCustomModelMode] = useState(false);
  const [roleTemplate, setRoleTemplate] = useState('fullstack');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [permission, setPermission] = useState<PermissionMode>('inherit');
  const [workspace, setWorkspace] = useState<WorkspaceMode>('shared');
  const [color, setColor] = useState(ENGINE_COLORS.claude);
  const [supervisor, setSupervisor] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetId, setTargetId] = useState('');
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [connectionError, setConnectionError] = useState('');

  const hasSupervisor = state?.bots.some((b) => b.room === activeRoom && b.is_supervisor);
  const mustBeSupervisor = !hasSupervisor;

  useEffect(() => { if (mustBeSupervisor) { setSupervisor(true); setRoleTemplate('supervisor'); } }, [mustBeSupervisor]);

  useEffect(() => {
    let cancelled = false;
    setPermission('inherit'); setSessionId(''); setConnectionError(''); setLoadingSessions(true);
    void Promise.all([window.studio.listDesktopSessions(engine), engine === 'antigravity' ? window.studio.listDesktopTargets() : Promise.resolve([])])
      .then(([list, desktops]) => { if (!cancelled) { setSessions(list); setTargets(desktops); setTargetId(desktops[0]?.id ?? ''); } })
      .catch(e => { if (!cancelled) { setSessions([]); setConnectionError((e as Error).message); } })
      .finally(() => { if (!cancelled) setLoadingSessions(false); });
    return () => { cancelled = true; };
  }, [engine]);

  useEffect(() => {
    setColor(ENGINE_COLORS[engine]);
    setModel('');
    setReasoningEffort('');
    setCustomModelMode(false);
  }, [engine]);

  const option = ROLE_TEMPLATE_OPTIONS.find((r) => r.id === roleTemplate);

  const refreshConnections = async (): Promise<void> => {
    setLoadingSessions(true); setConnectionError('');
    try {
      const [list, desktops] = await Promise.all([
        window.studio.listDesktopSessions(engine),
        engine === 'antigravity' ? window.studio.listDesktopTargets() : Promise.resolve([]),
      ]);
      setSessions(list); setTargets(desktops);
      setTargetId(current => desktops.some(t => t.id === current) ? current : desktops[0]?.id ?? '');
      if (sessionId && !list.some(s => s.id === sessionId)) setSessionId('');
      await loadModels(true);
    } catch (e) { setConnectionError((e as Error).message); }
    finally { setLoadingSessions(false); }
  };

  const create = async (): Promise<void> => {
    if (!displayName.trim() || busy) return;
    setBusy(true);
    try {
      await window.studio.createBot({
        display_name: displayName.trim(),
        engine_type: engine,
        model: model.trim() || undefined,
        reasoning_effort: reasoningEffort.trim() || undefined,
        role: option?.role ?? roleTemplate,
        roleTemplate,
        system_prompt: systemPrompt || option?.prompt || '',
        permission_mode: permission,
        workspace_mode: workspace,
        room: activeRoom,
        color,
        is_supervisor: mustBeSupervisor || supervisor,
        external_session_id: sessionId || undefined,
        desktop_target_id: (sessions.find(s => s.id === sessionId)?.target_id ?? targetId) || undefined,
      });
      setNewBotOpen(false);
      toast(`Bot「${displayName.trim()}」已创建，请查看真实会话连接状态`, 'success');
      setDisplayName(''); setSystemPrompt(''); setSupervisor(false); setModel(''); setReasoningEffort('');
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'error');
    } finally { setBusy(false); }
  };

  const catalogEntry = modelsCatalog?.[engine];
  const presets = (engine === 'antigravity' && targetId ? catalogEntry?.targetModels?.[targetId] : undefined) ?? resolveModelOptions(engine, modelsCatalog);
  const supportsEffort = catalogEntry ? catalogEntry.supportsEffort : engine !== 'antigravity';
  const effortOptions = resolveEffortOptions(engine, model, modelsCatalog);
  const activeModelOption = presets.find((opt) => opt.id === model);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setNewBotOpen(false)}>
      <div className="flex max-h-[90vh] w-[520px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300"><Sparkles size={15} /></span>
            <h2 className="text-sm font-semibold text-slate-100">新建 Bot</h2>
          </div>
          <button type="button" onClick={() => setNewBotOpen(false)} className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-[1fr,auto] gap-3 items-end">
            <div>
              <label className="label">名称</label>
              <input className="input" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：架构师 / 前端助手" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
            </div>
            <div className="flex gap-1 pb-1.5">
              {COLOR_PRESETS.slice(0, 6).map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} className="flex h-6 w-6 items-center justify-center rounded-md border" style={{ background: `${c}22`, borderColor: color === c ? c : 'transparent' }}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label">Agent 引擎</label>
            <div className="grid grid-cols-3 gap-2">
              {(['claude', 'codex', 'antigravity'] as EngineType[]).map((e) => (
                <button key={e} type="button" onClick={() => setEngine(e)}
                  className={`relative flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${engine === e ? 'border-white/20 bg-white/[.06]' : 'border-white/6 bg-ink-950/40 hover:border-white/12'}`}>
                  <span className="h-2 w-2 rounded-full" style={{ background: ENGINE_COLORS[e] }} />
                  <span className="text-xs font-medium text-slate-200">{ENGINE_LABELS[e]}</span>
                  {engine === e && <Check size={12} className="ml-auto text-indigo-300" />}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 space-y-2">
            <label className="label">连接原 Agent 的真实桌面对话</label>
            <p className="text-[11px] text-slate-400">Bot 和原应用共享同一对话。每个 Bot 需要独立会话；不启动 CLI 替代会话。</p>
            {engine === 'antigravity' && <select className="input" value={targetId} onChange={e => { setTargetId(e.target.value); setSessionId(''); setModel(''); }}>{targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>}
            <select className="input" value={sessionId} disabled={loadingSessions} onChange={e => { setSessionId(e.target.value); setModel(''); setReasoningEffort(''); }}>
              <option value="">{loadingSessions ? '正在读取原应用对话…' : engine === 'antigravity' ? '在此桌面新建真实对话' : '请选择原桌面中已打开的独立对话'}</option>
              {sessions.filter(s => engine !== 'antigravity' || !targetId || s.target_id === targetId).filter(s => !state?.bots.some(b => b.engine_type === engine && b.external_session_id === s.id)).map(s => <option key={s.id} value={s.id}>{s.title} · {s.id.slice(0, 8)}</option>)}
            </select>
            {engine === 'claude' && <p className="text-[11px] text-amber-200/80">请先在 Claude 桌面 Code 新建对话，启用 Remote Control 并保持会话运行；接力收件需使用 Auto 模式。模型、权限在原 Agent 中设置。</p>}
            {engine === 'codex' && <p className="text-[11px] text-slate-400">请先在 Codex 桌面新建独立对话并保持打开，再选择连接。</p>}
            {engine === 'codex' && sessionId && <button type="button" className="btn-ghost text-xs text-sky-300" onClick={() => { void window.studio.openCodexConversation(sessionId).catch(e => toast(e.message, 'error')); }}>在 Codex 桌面中打开所选对话</button>}
            {connectionError && <p className="text-[11px] text-red-300">{connectionError}</p>}
            <button type="button" className="btn-ghost text-xs text-sky-300" onClick={() => { void window.studio.launchDesktop(engine, activeRoom).then(() => toast('已打开原桌面，请创建独立对话后刷新列表', 'info')).catch(e => toast(e.message, 'error')); }}>打开 {ENGINE_LABELS[engine]} 原桌面</button>
            <button type="button" disabled={loadingSessions} className="btn-ghost text-xs" onClick={() => { void refreshConnections(); }}><RefreshCw size={12} />刷新真实对话</button>
          </div>

          {mustBeSupervisor && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">此项目尚无主管，当前 Bot 必须担任主管。Agent 和模型由你选择；创建后再连接执行 Bot。</div>}

          <div hidden={engine === 'claude'}>
            <div className="flex items-center justify-between mb-1">
              <label className="label !mb-0 flex items-center gap-1.5">
                模型
                  {catalogEntry?.discoveredAt && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-normal text-emerald-300">
                    自动读取本机
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => { void loadModels(true); }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                <RefreshCw size={11} className={modelsLoading ? 'animate-spin' : ''} /> 刷新模型列表
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((opt) => {
                const active = !customModelMode && model === opt.id;
                return (
                  <button
                    key={opt.id || 'default'}
                    type="button"
                    title={opt.description ?? opt.id}
                    onClick={() => {
                      setCustomModelMode(false);
                      setModel(opt.id);
                      setReasoningEffort((prev) => prev ? (clampEffortForModel(engine, opt.id, prev, modelsCatalog) ?? '') : '');
                    }}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      active ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200' : 'border-white/8 bg-ink-950/40 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
              {engine !== 'antigravity' && (
                <button
                  type="button"
                  onClick={() => setCustomModelMode(true)}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    customModelMode ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200' : 'border-white/8 bg-ink-950/40 text-slate-400 hover:bg-white/5'
                  }`}
                >
                  自定义…
                </button>
              )}
            </div>
            {activeModelOption?.description && !customModelMode && (
              <p className="mt-1.5 text-[10.5px] text-slate-400">{activeModelOption.description}</p>
            )}
            {customModelMode && engine !== 'antigravity' && (
              <input
                className="input mt-2 text-xs"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={engine === 'claude' ? '输入模型 ID，如 claude-fable-5-1[1m] / opus' : '输入模型 ID，如 gpt-6.1-terra'}
              />
            )}
          </div>

          {supportsEffort && effortOptions.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label !mb-0">推理强度（按所选模型对齐）</label>
                {(activeModelOption?.defaultEffort || catalogEntry?.defaultEffort) && (
                  <span className="text-[10.5px] text-slate-500">
                    模型默认：{activeModelOption?.defaultEffort ?? catalogEntry?.defaultEffort}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setReasoningEffort('')}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    !reasoningEffort ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200' : 'border-white/8 bg-ink-950/40 text-slate-300 hover:bg-white/5'
                  }`}
                >
                  默认强度
                </button>
                {effortOptions.map((eff) => {
                  const active = reasoningEffort === eff;
                  const zh = EFFORT_LABELS[eff];
                  return (
                    <button
                      key={eff}
                      type="button"
                      onClick={() => setReasoningEffort(eff)}
                      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                        active ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200' : 'border-white/8 bg-ink-950/40 text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      {zh ? `${zh} (${eff})` : eff}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-white/6 bg-ink-950/40 px-3 py-2 text-[11px] text-slate-400">
              {catalogEntry?.effortNote ?? '请打开并登录原 Agent 桌面端，刷新连接后读取实际可用模型。'}
            </p>
          )}

          <div className="grid grid-cols-[1fr,auto] gap-3 items-center">
            <div>
              <label className="label">角色</label>
              <select className="input" value={roleTemplate} onChange={(e) => { setRoleTemplate(e.target.value); const o = ROLE_TEMPLATE_OPTIONS.find((x) => x.id === e.target.value); if (o && !systemPrompt) setSystemPrompt(o.prompt); }}>
                {ROLE_TEMPLATE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg border border-white/8 bg-white/[.02] px-3 py-2 text-xs text-slate-200" title={hasSupervisor ? '替换当前房间主管' : '设为主管'}>
              <input type="checkbox" className="accent-amber-400" checked={mustBeSupervisor || supervisor} disabled={mustBeSupervisor} onChange={(e) => setSupervisor(e.target.checked)} />
              <Crown size={13} className="text-amber-400" />
              设为主管
            </label>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
          >
            <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            更多选项（权限 / 工作目录 / 提示词）
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-xl border border-white/6 bg-ink-950/40 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label"><Zap size={11} className="mr-1 inline" />权限模式</label>
                  <div className="space-y-1.5">
                    {([['inherit', '继承原 Agent 实际权限'], ...(engine === 'codex' ? [['read_only', '只读'], ['auto', '工作区内自动执行'], ['ask_ui', '敏感操作审批']] : [])] as [PermissionMode, string][]).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setPermission(v)} className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${permission === v ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-white/6 text-slate-400 hover:bg-white/5'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${permission === v ? 'bg-indigo-400' : 'bg-slate-600'}`} />{label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label"><FolderGit2 size={11} className="mr-1 inline" />工作区</label>
                  <div className="space-y-1.5">
                    {([['shared', '使用原桌面对话工作目录']] as [WorkspaceMode, string][]).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setWorkspace(v)} className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${workspace === v ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-white/6 text-slate-400 hover:bg-white/5'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${workspace === v ? 'bg-indigo-400' : 'bg-slate-600'}`} />{label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="label">专属 System Prompt</label>
                <textarea className="input mono h-20 leading-relaxed" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="人设、职责边界、交付规范…" />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-3">
          <button type="button" className="btn-ghost" onClick={() => setNewBotOpen(false)}>取消</button>
          <button type="button" className="btn-primary px-5" disabled={!displayName.trim() || busy || loadingSessions || (engine !== 'antigravity' && !sessionId) || (engine === 'antigravity' && !targetId)} onClick={() => void create()}>
            {busy ? '创建中…' : '创建 Bot'}
          </button>
        </div>
      </div>
    </div>
  );
}
