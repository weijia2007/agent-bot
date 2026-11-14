import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CornerDownLeft, PanelRightClose, PanelRightOpen, RefreshCw, Send, Sparkles, Wrench } from 'lucide-react';
import { useStudio } from '../store';
import { ENGINE_LABELS, formatModelLabel, type BotConfig, type RoomMessage } from '../types';
import { BotAvatar, EmptyState, formatTime, StatusDot } from './Common';
import { extractLiveTurnStream, ModelPicker } from './ModelPicker';
import WorkspacePanel from './WorkspacePanel';

function DirectMessage({ message, bot, peerName }: { message: RoomMessage; bot: BotConfig; peerName?: string }): React.ReactNode {
  if (message.kind === 'system') {
    return (
      <div className="my-2 rounded-xl border border-amber-500/25 bg-amber-500/[.06] px-3.5 py-2.5 text-[12px] text-amber-200 whitespace-pre-wrap select-text">
        {message.text}
      </div>
    );
  }

  const mine = message.from === 'user';
  if (mine) {
    return (
      <div className="animate-slideIn flex justify-end py-1.5">
        <div className="max-w-[76%]">
          <div className="rounded-2xl rounded-br-sm border border-indigo-500/25 bg-indigo-500/15 px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-100 whitespace-pre-wrap break-words select-text">
            {message.text}
          </div>
          <div className="mt-1 text-right text-[10px] text-slate-600">{formatTime(message.created)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-slideIn flex items-start gap-3 py-1.5">
      <BotAvatar bot={bot} size={28} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="font-medium text-slate-200">{bot.display_name}</span>
          {peerName && <span className="text-slate-500">→ @{peerName}</span>}
          <span className="text-slate-600">{formatTime(message.created)}</span>
        </div>
        <div className="text-[13.5px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words select-text">
          {message.text}
        </div>
      </div>
    </div>
  );
}

export default function BotView({ bot }: { bot: BotConfig }): React.ReactNode {
  const { state, streams, activeRoom, setActiveBot, setBotModel, toast } = useStudio();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() =>
    (state?.messages ?? []).filter((m) => m.room === activeRoom && (m.to === bot.bot_id || m.from === bot.bot_id)),
  [state?.messages, activeRoom, bot.bot_id]);

  const botMap = useMemo(() => new Map((state?.bots ?? []).map((b) => [b.bot_id, b])), [state?.bots]);
  const liveTurn = useMemo(
    () => (bot.status === 'working' || bot.status === 'queued' ? extractLiveTurnStream(streams[bot.bot_id] ?? []) : null),
    [bot.status, streams, bot.bot_id],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, bot.bot_id, liveTurn?.text, liveTurn?.activeTool]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try { await window.studio.sendDirect(bot.bot_id, value, activeRoom); setText(''); }
    catch (e) { toast(`发送失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(false); }
  };

  const reconnect = async (): Promise<void> => {
    setReconnecting(true);
    try {
      const updated = await window.studio.reconnectBot(bot.bot_id);
      if (updated?.external_session_id && updated.status !== 'error') toast('底层会话已重新绑定', 'success');
      else toast('重连未成功，请检查引擎状态', 'error');
    } catch (e) {
      toast(`重连失败：${(e as Error).message}`, 'error');
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-950">
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2.5">
        <button type="button" onClick={() => setActiveBot(null)} className="btn-ghost px-2 py-1 text-xs" title="返回群聊">
          <ArrowLeft size={14} /> 群聊
        </button>
        <div className="h-4 w-px bg-white/8" />
        <BotAvatar bot={bot} size={28} />
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[13px] font-semibold text-slate-100">{bot.display_name}</span>
          <StatusDot status={bot.status} pulse={bot.status === 'working'} />
          <ModelPicker
            engine={bot.engine_type}
            model={bot.model}
            align="left"
            onChange={(next) => { void setBotModel(bot.bot_id, next); }}
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void reconnect()}
            className={`btn-ghost border px-2 py-1 text-xs ${
              !bot.external_session_id || bot.status === 'error'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                : 'border-white/8 text-slate-400'
            }`}
            title="重连独立底层会话"
          >
            <RefreshCw size={12} className={reconnecting ? 'animate-spin' : ''} />
            {reconnecting ? '重连中' : '重连'}
          </button>
          <button
            type="button"
            className={`btn-ghost border px-2 py-1 text-xs ${workspaceOpen ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-white/8 text-slate-400'}`}
            onClick={() => setWorkspaceOpen((v) => !v)}
            title="显示 / 收起动作流与 Diff 面板"
          >
            {workspaceOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
            动作与 Diff
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
            <div className="mx-auto max-w-3xl space-y-3">
              {messages.length === 0 && !liveTurn && (
                <EmptyState
                  icon={<Sparkles size={20} />}
                  title={`与 ${bot.display_name} 对话`}
                  hint={`${ENGINE_LABELS[bot.engine_type]} · ${formatModelLabel(bot.engine_type, bot.model)}。直接发送问题或任务即可在此查看回复。`}
                />
              )}

              {messages.map((m) => (
                <DirectMessage
                  key={m.id}
                  message={m}
                  bot={bot}
                  peerName={m.to && m.to !== 'user' && m.to !== bot.bot_id ? (botMap.get(m.to)?.display_name ?? m.to) : undefined}
                />
              ))}

              {liveTurn && (
                <div className="animate-slideIn flex items-start gap-3 py-1.5">
                  <BotAvatar bot={bot} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="font-medium text-slate-200">{bot.display_name}</span>
                      <span className="text-indigo-300">{bot.status === 'queued' ? '排队中…' : '生成中…'}</span>
                      {liveTurn.activeTool && (
                        <span className="chip border border-white/10 bg-white/[.04] text-slate-300">
                          <Wrench size={10} /> {liveTurn.activeTool}
                        </span>
                      )}
                    </div>
                    {liveTurn.text ? (
                      <div className="text-[13.5px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words select-text">
                        {liveTurn.text}
                        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-indigo-400 align-middle" />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                        {liveTurn.thinking ? '正在思考推理…' : '正在等待响应…'}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="px-4 pb-4 pt-1">
            <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-ink-900/80 focus-within:border-indigo-500/40 transition-colors">
              <textarea
                value={text}
                rows={2}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                className="w-full bg-transparent px-4 pt-3 text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none resize-none"
                placeholder={`发消息给 ${bot.display_name}…`}
              />
              <div className="flex items-center gap-2 px-3 pb-2.5">
                <ModelPicker
                  engine={bot.engine_type}
                  model={bot.model}
                  direction="up"
                  align="left"
                  compact
                  onChange={(next) => { void setBotModel(bot.bot_id, next); }}
                />
                <span className="text-[10.5px] text-slate-600">Enter 发送 · Shift+Enter 换行</span>
                <button type="button" className="btn-primary ml-auto px-3.5 py-1.5 rounded-xl" disabled={!text.trim() || busy} onClick={() => void send()}>
                  <Send size={12} /> 发送 <CornerDownLeft size={10} className="opacity-60" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {workspaceOpen && (
          <div className="w-[40%] min-w-[300px] border-l border-white/5">
            <WorkspacePanel bot={bot} />
          </div>
        )}
      </div>
    </div>
  );
}
