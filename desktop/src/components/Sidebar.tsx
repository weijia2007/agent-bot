import { useEffect, useState } from 'react';
import {
  Bot, ChevronDown, Crown, FolderPlus, GitBranch, MessageSquare, MoreVertical, Plus, RefreshCw, Settings2, Trash2, UserRoundCog,
} from 'lucide-react';
import { useStudio } from '../store';
import { ENGINE_LABELS, formatModelLabel, type BotConfig, type Room } from '../types';
import { BotAvatar, SectionTitle, StatusDot } from './Common';

function RoomSwitcher({ rooms, active, onPick }: { rooms: Room[]; active: string; onPick: (id: string) => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const current = rooms.find((r) => r.id === active);
  return (
    <div className="relative px-3 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-white/5 bg-white/[.03] px-3 py-2.5 text-left hover:border-indigo-500/30"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-300">
          <Bot size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-slate-100">{current?.name ?? '协作房间'}</span>
          <span className="block truncate text-[10px] text-slate-500">{current?.project_path || '未设置项目路径'}</span>
        </span>
        <ChevronDown size={14} className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-3 right-3 z-30 mt-1 rounded-lg border border-white/8 bg-ink-800 p-1 shadow-2xl">
          {rooms.map((room) => (
            <button
              key={room.id} type="button"
              onClick={() => { onPick(room.id); setOpen(false); }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs ${room.id === active ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-300 hover:bg-white/5'}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className="flex-1 truncate">{room.name}</span>
              {room.id === active && <span className="text-[10px] opacity-60">当前</span>}
            </button>
          ))}
          <div className="divider my-1" />
          <button
            type="button"
            onClick={() => { setOpen(false); useStudio.getState().setNewRoomOpen(true); }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-100"
          >
            <Plus size={13} /> 新建项目
          </button>
        </div>
      )}
    </div>
  );
}

function BotRow({ bot, active, onPick, onMenu }: {
  bot: BotConfig; active: boolean; onPick: () => void; onMenu: (e: React.MouseEvent) => void;
}): React.ReactNode {
  const modelsCatalog = useStudio((s) => s.modelsCatalog);
  const modelText = bot.model || bot.reasoning_effort
    ? formatModelLabel(bot.engine_type, bot.model, modelsCatalog, bot.reasoning_effort)
    : bot.role;
  return (
    <div
      onClick={onPick}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${active ? 'bg-indigo-500/12 ring-1 ring-indigo-500/20' : 'hover:bg-white/[.04]'}`}
    >
      <BotAvatar bot={bot} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-slate-200">{bot.display_name}</span>
          {bot.is_supervisor && <Crown size={11} className="shrink-0 text-amber-400" />}
        </div>
        <div className="truncate text-[10.5px] text-slate-500">
          {ENGINE_LABELS[bot.engine_type]} · {modelText}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full dot-${bot.status}`} />
        <button
          type="button" title="Bot 操作" onClick={(e) => { e.stopPropagation(); onMenu(e); }}
          className="hidden rounded p-0.5 text-slate-600 hover:bg-white/10 hover:text-slate-300 group-hover:block"
        >
          <MoreVertical size={13} />
        </button>
      </div>
    </div>
  );
}

export default function Sidebar(): React.ReactNode {
  const {
    state, activeRoom, activeBot, modelsCatalog, setActiveRoom, setActiveBot, setNewBotOpen, setInspectorTab, toast,
  } = useStudio();
  const [menu, setMenu] = useState<{ bot: BotConfig; x: number; y: number } | null>(null);
  const [projectPick, setProjectPick] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setNewBotOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', close); };
  }, [setNewBotOpen]);

  if (!state) return null;
  const roomBots = state.bots.filter((b) => b.room === activeRoom);
  const supervisor = roomBots.find((b) => b.is_supervisor);
  const workers = roomBots.filter((b) => !b.is_supervisor);
  const room = state.rooms.find((r) => r.id === activeRoom);

  const showMenu = (e: React.MouseEvent, bot: BotConfig): void => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ bot, x: e.clientX, y: e.clientY });
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-ink-900">
      <RoomSwitcher rooms={state.rooms} active={activeRoom} onPick={setActiveRoom} />

      <button
        type="button"
        onClick={async () => {
          setProjectPick(true);
          const picked = await window.studio.pickProject();
          setProjectPick(false);
          if (picked) { await window.studio.setRoomProject(activeRoom, picked); toast('项目路径已更新', 'success'); }
        }}
        className="mx-3 mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] text-slate-500 hover:bg-white/5 hover:text-slate-300"
        title="设置当前房间的项目根目录（Git Worktree 从此仓库创建）"
      >
        <FolderPlus size={12} /> {projectPick ? '选择中…' : room?.project_path ? '更换项目路径' : '设置项目路径'}
      </button>

      <div className="mt-3 flex-1 overflow-y-auto px-2.5 pb-3">
        <button
          type="button"
          onClick={() => setActiveBot(null)}
          className={`mb-3 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
            !activeBot ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-500/25' : 'text-slate-400 hover:bg-white/[.04] hover:text-slate-200'
          }`}
        >
          <MessageSquare size={14} /> 群聊主厅
        </button>

        <SectionTitle right={<span className="text-[10px] text-slate-600">{roomBots.length}</span>}>主管</SectionTitle>
        {supervisor ? (
          <div
            onClick={() => setActiveBot(supervisor.bot_id)}
            className={`group relative cursor-pointer rounded-xl border p-2.5 transition-colors ${activeBot === supervisor.bot_id ? 'border-indigo-500/40 bg-indigo-500/10' : 'border-white/8 bg-white/[.02] hover:border-white/15'}`}
            onContextMenu={(e) => showMenu(e, supervisor)}
          >
            <div className="flex items-center gap-2.5">
              <BotAvatar bot={supervisor} size={30} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-semibold text-slate-100">{supervisor.display_name}</span>
                  <Crown size={11} className="shrink-0 text-amber-400" />
                </div>
                <div className="truncate text-[10.5px] text-slate-500">
                  {ENGINE_LABELS[supervisor.engine_type]} · {formatModelLabel(supervisor.engine_type, supervisor.model, modelsCatalog, supervisor.reasoning_effort)}
                </div>
              </div>
              <StatusDot status={supervisor.status} pulse={supervisor.status === 'working'} />
              <button type="button" title="更多" onClick={(e) => showMenu(e, supervisor)} className="hidden text-slate-600 hover:text-slate-300 group-hover:block">
                <MoreVertical size={13} />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button" onClick={() => setNewBotOpen(true)}
            className="w-full rounded-xl border border-dashed border-white/10 px-3 py-3 text-xs text-slate-500 hover:border-amber-500/40 hover:text-amber-300"
          >
            + 指定主管 Bot
          </button>
        )}

        <div className="mt-4">
          <SectionTitle>成员</SectionTitle>
          <div className="space-y-0.5">
            {workers.map((bot) => (
              <BotRow
                key={bot.bot_id} bot={bot} active={activeBot === bot.bot_id}
                onPick={() => setActiveBot(bot.bot_id)} onMenu={(e) => showMenu(e, bot)}
              />
            ))}
            {workers.length === 0 && (
              <div className="rounded-lg border border-dashed border-white/6 px-3 py-5 text-center text-[11px] text-slate-600">
                还没有子 Bot，点击底部新建
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 p-3">
        <button type="button" onClick={() => setNewBotOpen(true)} className="btn-primary w-full py-2.5">
          <Plus size={15} /> 新建 Bot <span className="ml-auto rounded bg-black/20 px-1.5 py-0.5 text-[10px]">Ctrl+N</span>
        </button>
        <button type="button" onClick={() => setInspectorTab('health')} className="btn-ghost mt-1.5 w-full justify-start">
          <Settings2 size={14} /> 引擎健康与配额
        </button>
      </div>

      {menu && (
        <div
          className="fixed z-50 w-48 rounded-lg border border-white/10 bg-ink-800 p-1 shadow-2xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 170) }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-slate-300 hover:bg-white/5" onClick={async () => { await window.studio.setSupervisor(menu.bot.bot_id); setMenu(null); toast(`${menu.bot.display_name} 已设为主管`, 'success'); }}>
            <UserRoundCog size={13} /> 设为主管
          </button>
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-slate-300 hover:bg-white/5" onClick={() => { setActiveBot(menu.bot.bot_id); setInspectorTab('tasks'); setMenu(null); }}>
            <Settings2 size={13} /> 编辑 / 透视
          </button>
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-slate-300 hover:bg-white/5" onClick={async () => { const b = await window.studio.reconnectBot(menu.bot.bot_id); setMenu(null); if (b?.external_session_id && b.status !== 'error') toast(`${b.display_name} 底层会话已重连`, 'success'); }}>
            <RefreshCw size={13} /> 重连底层会话
          </button>
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-slate-300 hover:bg-white/5" onClick={async () => { await window.studio.openPath(menu.bot.workspace); setMenu(null); }}>
            <GitBranch size={13} /> 打开工作目录
          </button>
          <div className="divider my-1" />
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-xs text-red-400 hover:bg-red-500/10" onClick={async () => { await window.studio.deleteBot(menu.bot.bot_id); if (activeBot === menu.bot.bot_id) setActiveBot(null); setMenu(null); toast('Bot 已移除', 'info'); }}>
            <Trash2 size={13} /> 移除 Bot
          </button>
        </div>
      )}
    </aside>
  );
}
