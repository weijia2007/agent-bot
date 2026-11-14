import { useEffect } from 'react';
import { AlertTriangle, Bot, LayoutPanelLeft, PanelRightOpen, Power, ShieldCheck, X } from 'lucide-react';
import { useStudio } from './store';
import Sidebar from './components/Sidebar';
import RoomView from './components/RoomView';
import BotView from './components/BotView';
import Inspector from './components/Inspector';
import NewBotDialog, { NewRoomDialog } from './components/NewBotDialog';

function Resizer({ onDrag }: { onDrag: (e: React.MouseEvent) => void }): React.ReactNode {
  return (
    <div
      onMouseDown={onDrag}
      className="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-500/30"
      title="拖拽调整宽度"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

function TopBar(): React.ReactNode {
  const { state, activeRoom, activeBot, health, inspectorOpen, setInspectorOpen, setInspectorTab, toast } = useStudio();
  const room = state?.rooms.find((r) => r.id === activeRoom);
  const bot = state?.bots.find((b) => b.bot_id === activeBot);
  const emergency = state?.emergencyStop ?? false;
  const alertCount = (state?.approvals.length ?? 0) + (state?.hopPauses.length ?? 0);

  const toggleEmergency = async (): Promise<void> => {
    try {
      await window.studio.emergencyStop(!emergency);
      toast(emergency ? '已恢复全部派单' : '紧急停止已激活：清空队列并中断当前任务', emergency ? 'success' : 'error');
    } catch (e) { toast(`熔断操作失败：${(e as Error).message}`, 'error'); }
  };

  return (
    <header className="glass-top flex h-11 shrink-0 items-center gap-3 border-b border-white/6 px-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-sky-500 text-white">
          <Bot size={14} />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-slate-100">Agent Bot</span>
      </div>

      <div className="h-4 w-px bg-white/8" />
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-slate-500">
        <LayoutPanelLeft size={12} />
        <span className="truncate">{room?.name ?? activeRoom}</span>
        {bot && <><span className="text-slate-700">/</span><span className="truncate text-slate-200">{bot.display_name}</span></>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-full border border-white/6 bg-white/[.02] px-2.5 py-1 text-[11px] text-slate-400 sm:inline-flex">
          <span className={`h-1.5 w-1.5 rounded-full ${health?.online ? 'bg-emerald-400' : 'bg-amber-400 animate-pulseDot'}`} />
          {health?.online ? '就绪' : '连接中'}
        </span>
        {alertCount > 0 && (
          <button
            type="button"
            onClick={() => setInspectorTab((state?.approvals.length ?? 0) > 0 ? 'approvals' : 'tasks')}
            className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20"
          >
            待处理 {alertCount}
          </button>
        )}
        <button
          type="button"
          onClick={() => void toggleEmergency()}
          className={`btn px-2.5 py-1 text-[11.5px] font-medium ${emergency ? 'bg-emerald-500/90 text-white hover:bg-emerald-400' : 'border border-white/8 bg-white/[.04] text-slate-300 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-200'}`}
          title="紧急停止全部运行中的会话并清空排队"
        >
          <Power size={12} /> {emergency ? '恢复' : '急停'}
        </button>
        <button
          type="button"
          onClick={() => setInspectorOpen(!inspectorOpen)}
          className={`btn-ghost border border-white/8 px-2 py-1 text-[11.5px] ${inspectorOpen ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'text-slate-400'}`}
          title="打开或收起右侧管理面板（任务 / 审批 / 锁 / 健康）"
        >
          <PanelRightOpen size={13} /> 面板
        </button>
      </div>
    </header>
  );
}

function Toasts(): React.ReactNode {
  const { toasts, dismissToast } = useStudio();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto animate-slideIn flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[11.5px] shadow-2xl backdrop-blur ${t.level === 'error' ? 'border-red-500/30 bg-red-950/85 text-red-200' : t.level === 'success' ? 'border-emerald-500/30 bg-emerald-950/85 text-emerald-200' : 'border-white/10 bg-ink-800/95 text-slate-300'}`}>
          {t.level === 'error' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <ShieldCheck size={14} className="mt-0.5 shrink-0" />}
          <span className="flex-1 leading-relaxed">{t.text}</span>
          <button type="button" onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export default function App(): React.ReactNode {
  const {
    init, state, activeBot, inspectorOpen, sidebarWidth, inspectorWidth,
    setSidebarWidth, setInspectorWidth, newBotOpen, newRoomOpen, ready,
  } = useStudio();

  useEffect(() => { void init(); }, [init]);

  const startDrag = (which: 'sidebar' | 'inspector') => (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = which === 'sidebar' ? sidebarWidth : inspectorWidth;
    const move = (ev: MouseEvent): void => {
      const delta = ev.clientX - startX;
      if (which === 'sidebar') setSidebarWidth(startWidth + delta);
      else setInspectorWidth(startWidth - delta);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const bot = state?.bots.find((b) => b.bot_id === activeBot);

  if (!ready) {
    return <div className="flex h-full items-center justify-center text-xs text-slate-500">正在启动 Agent Bot…</div>;
  }

  return (
    <div className="flex h-full flex-col bg-ink-950 text-slate-200">
      <TopBar />
      {state?.emergencyStop && (
        <div className="flex items-center justify-center gap-2 border-b border-red-500/30 bg-red-500/10 py-1.5 text-[11px] text-red-300">
          <AlertTriangle size={12} /> 紧急停止已激活 — 自动转发暂停，所有运行中的会话已收到中断请求
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div style={{ width: sidebarWidth }} className="shrink-0 border-r border-white/5"><Sidebar /></div>
        <Resizer onDrag={startDrag('sidebar')} />
        <main className="min-w-0 flex-1">
          {bot ? <BotView bot={bot} /> : <RoomView />}
        </main>
        {inspectorOpen && (
          <>
            <Resizer onDrag={startDrag('inspector')} />
            <div style={{ width: inspectorWidth }} className="shrink-0 border-l border-white/5"><Inspector /></div>
          </>
        )}
      </div>
      {newBotOpen && <NewBotDialog />}
      {newRoomOpen && <NewRoomDialog />}
      <Toasts />
    </div>
  );
}
