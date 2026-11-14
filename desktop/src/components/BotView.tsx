import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CornerDownLeft, PanelRightClose, PanelRightOpen, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { useStudio } from '../store';
import type { BotConfig, RoomMessage } from '../types';
import { BotAvatar, EmptyState, EngineBadge, formatTime, StatusDot } from './Common';
import WorkspacePanel from './WorkspacePanel';

function DirectMessage({ message, bot }: { message: RoomMessage; bot: BotConfig }): React.ReactNode {
  const mine = message.from === 'user';
  return (
    <div className={`animate-slideIn flex gap-2.5 py-1.5 ${mine ? 'flex-row-reverse' : ''}`}>
      {mine
        ? <div className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-600/60 text-[10px] text-slate-200">U</div>
        : <BotAvatar bot={bot} size={28} />}
      <div className="max-w-[78%]">
        <div className={`mb-1 flex items-center gap-2 text-[10px] text-slate-600 ${mine ? 'justify-end' : ''}`}>
          {mine ? '你' : bot.display_name}<span>{formatTime(message.created)}</span>
        </div>
        <div className={`rounded-xl px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words ${mine ? 'rounded-tr-sm border border-indigo-500/25 bg-indigo-500/12 text-slate-100' : 'card text-slate-200'}`}>
          {message.text}
        </div>
      </div>
    </div>
  );
}

export default function BotView({ bot }: { bot: BotConfig }): React.ReactNode {
  const { state, streams, activeRoom, setActiveBot, clearStream, toast } = useStudio();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() =>
    (state?.messages ?? []).filter((m) => m.room === activeRoom && (m.to === bot.bot_id || m.from === bot.bot_id)),
  [state?.messages, activeRoom, bot.bot_id]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages.length]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try { await window.studio.sendDirect(bot.bot_id, value, activeRoom); setText(''); }
    catch (e) { toast(`发送失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2.5">
        <button type="button" onClick={() => setActiveBot(null)} className="btn-ghost px-2 py-1.5" title="返回群聊主厅">
          <ArrowLeft size={14} /> 群聊
        </button>
        <div className="h-5 w-px bg-white/8" />
        <BotAvatar bot={bot} size={30} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-slate-100">{bot.display_name}</span>
            <EngineBadge engine={bot.engine_type} />
            {bot.is_supervisor && <span className="chip bg-amber-500/10 text-amber-300">主管</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
            <StatusDot status={bot.status} pulse={false} />
            <span className="mono truncate" title={bot.external_session_id}>
              {bot.external_session_id ? `会话 ${bot.external_session_id.slice(0, 13)}` : '⚠ 未绑定真实会话'}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="mono hidden truncate text-[10px] text-slate-600 xl:block" title={bot.workspace}>{bot.workspace}</span>
          {(!bot.external_session_id || bot.status === 'error') && (
            <button
              type="button"
              disabled={reconnecting}
              onClick={async () => {
                setReconnecting(true);
                try {
                  const updated = await window.studio.reconnectBot(bot.bot_id);
                  if (updated?.external_session_id && updated.status !== 'error') toast('底层会话已重新绑定', 'success');
                } catch (e) {
                  toast(`重连失败：${(e as Error).message}`, 'error');
                } finally {
                  setReconnecting(false);
                }
              }}
              className="btn-ghost border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-300 hover:bg-amber-500/20"
              title="重新绑定真实底层会话"
            >
              <RefreshCw size={12} className={reconnecting ? 'animate-spin' : ''} />
              {reconnecting ? '重连中…' : '重连会话'}
            </button>
          )}
          {(streams[bot.bot_id]?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => clearStream(bot.bot_id)}
              className="btn-ghost border border-white/8 px-2 py-1.5 text-slate-400"
              title="清空当前输出流缓存"
            >
              <Trash2 size={12} /> 清空流
            </button>
          )}
          <button type="button" className="btn-ghost border border-white/8 px-2 py-1.5" onClick={() => setWorkspaceOpen((v) => !v)} title="显示 / 收起实时工作台">
            {workspaceOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
            {workspaceOpen ? '收起工作台' : 'Live Workspace'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
            {messages.length === 0 ? (
              <EmptyState
                icon={<Sparkles size={22} />}
                title={`与 ${bot.display_name} 的专属会话`}
                hint="这里会显示你单独发给它的指令，以及它通过 Relay 收到的来自主管 / 其他 Bot 的上下文消息。你可以随时人工纠偏。"
              />
            ) : messages.map((m) => <DirectMessage key={m.id} message={m} bot={bot} />)}
          </div>
          <div className="border-t border-white/5 bg-ink-900/60 p-3">
            <div className="rounded-xl border border-white/8 bg-ink-950/70 focus-within:border-indigo-500/40">
              <textarea
                value={text} rows={2}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                className="w-full bg-transparent px-3.5 pt-2.5 text-[12.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none"
                placeholder={`直接给 ${bot.display_name} 发消息（人工纠偏）…`}
              />
              <div className="flex items-center gap-2 px-3 pb-2">
                <span className="mono text-[10px] text-slate-600">独立会话 · {bot.permission_mode === 'auto' ? '自动执行' : '敏感操作审批'}</span>
                <button type="button" className="btn-primary ml-auto px-3" disabled={!text.trim() || busy} onClick={() => void send()}>
                  <Send size={12} /> 发送 <CornerDownLeft size={10} className="opacity-60" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {workspaceOpen && (
          <div className="w-[44%] min-w-[320px] border-l border-white/5">
            <WorkspacePanel bot={bot} />
          </div>
        )}
      </div>
    </div>
  );
}
