import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, AtSign, CheckCircle2, CornerDownLeft, Paperclip, Search, Send, ShieldAlert, Sparkles, Users, X, XCircle } from 'lucide-react';
import { useStudio } from '../store';
import type { BotConfig, RoomMessage, SearchHit } from '../types';
import { BotAvatar, EmptyState, EngineBadge, formatTime, HandoffContext } from './Common';
import { extractLiveTurnStream, ModelPicker } from './ModelPicker';
import { LiveProcessCard, MessageTraceDrawer } from './ProcessTimeline';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'text-amber-300 bg-amber-500/10' },
  delivered: { label: '已送达', cls: 'text-sky-300 bg-sky-500/10' },
  working: { label: '执行中', cls: 'text-indigo-300 bg-indigo-500/10' },
  done: { label: '已完成', cls: 'text-emerald-300 bg-emerald-500/10' },
  review_back: { label: 'Review 退回', cls: 'text-orange-300 bg-orange-500/10' },
  cancelled: { label: '已取消', cls: 'text-slate-400 bg-white/5' },
  uncertain: { label: '交付不确定', cls: 'text-red-300 bg-red-500/10' },
};

function botById(bots: BotConfig[], id?: string): BotConfig | undefined {
  return id ? bots.find((b) => b.bot_id === id) : undefined;
}

function MessageCard({ message, bots, onPickBot }: {
  message: RoomMessage; bots: BotConfig[]; onPickBot: (id: string) => void;
}): React.ReactNode {
  const from = botById(bots, message.from);
  const to = botById(bots, message.to);
  const status = message.status ? STATUS_LABEL[message.status] : undefined;

  if (message.kind === 'system') {
    return (
      <div className="my-2 flex items-start gap-2.5 rounded-lg border border-amber-500/15 bg-amber-500/[.05] px-3 py-2 text-[11.5px] text-amber-200/80">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <span className="flex-1 leading-relaxed">{message.text}</span>
        <span className="mono shrink-0 text-amber-200/40">{formatTime(message.created)}</span>
      </div>
    );
  }

  if (message.kind === 'user') {
    return (
      <div className="animate-slideIn flex justify-end gap-2.5 py-1.5">
        <div className="max-w-[74%]">
          <div className="mb-1 flex items-center justify-end gap-2 text-[10px] text-slate-500">
            <span>{formatTime(message.created)}</span>
            <span className="text-slate-400">你 {to && <>→ <span className="text-indigo-300">@{to.display_name}</span></>}</span>
          </div>
          <div className="rounded-2xl rounded-tr-sm border border-indigo-500/25 bg-indigo-500/12 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
            {message.text}
            {message.attachments?.map(file => <button key={file} type="button" className="mt-2 block text-xs text-sky-300" onClick={() => { void window.studio.openPath(file); }}><Paperclip size={11} className="inline" /> {file.split(/[\\/]/).pop()}</button>)}
          </div>
        </div>
        <div className="mt-5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-600/60 text-xs font-semibold text-slate-200">U</div>
      </div>
    );
  }

  return (
    <div className="animate-slideIn flex gap-3 py-1.5">
      {from ? <BotAvatar bot={from} size={28} /> : <div className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg bg-white/5 text-slate-500"><Sparkles size={14} /></div>}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
          <button type="button" onClick={() => from && onPickBot(from.bot_id)} className="font-medium text-slate-200 hover:text-indigo-300">{from?.display_name ?? message.from}</button>
          {to && (
            <span className="flex items-center gap-1 text-slate-500">
              <ArrowRight size={11} />
              <button type="button" onClick={() => onPickBot(to.bot_id)} className="text-slate-400 hover:text-indigo-300">@{to.display_name}</button>
            </span>
          )}
          {from?.is_supervisor && <span className="text-[10px] text-amber-300/80">主管</span>}
          {status && message.status !== 'delivered' && message.status !== 'done' && <span className={`chip ${status.cls}`}>{status.label}</span>}
          {typeof message.hop_count === 'number' && message.hop_count > 0 && <span className="chip bg-white/5 text-slate-500">hop {message.hop_count}</span>}
          <span className="mono ml-auto text-[10px] text-slate-600">{formatTime(message.created)}</span>
        </div>
        <div className="rounded-xl border border-white/6 bg-white/[.02] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words select-text">
          <MessageTraceDrawer steps={message.trace_steps} />
          {message.text}
          <HandoffContext handoff={message.handoff} />
        </div>
        {message.progress && <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-slate-500"><CheckCircle2 size={11} />{message.progress}</div>}
        {message.review_items && message.review_items.length > 0 && (
          <div className="mt-2 space-y-1.5 rounded-lg border border-orange-500/15 bg-orange-500/[.04] p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-orange-300">交叉审查发现 {message.review_items.length} 项</div>
            {message.review_items.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <span className={`chip shrink-0 ${item.severity === 'high' ? 'bg-red-500/15 text-red-300' : item.severity === 'medium' ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-slate-400'}`}>{item.severity}</span>
                <span className="mono text-sky-300">{item.file}:{item.line}</span>
                <span className="flex-1 text-slate-400">{item.note}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoomView(): React.ReactNode {
  const { state, streams, activeRoom, setActiveBot, setBotModel, toast } = useStudio();
  const [text, setText] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const room = state?.rooms.find((r) => r.id === activeRoom);
  const bots = useMemo(() => state?.bots.filter((b) => b.room === activeRoom) ?? [], [state?.bots, activeRoom]);
  const workingBots = useMemo(() => bots.filter((b) => b.status === 'working' || b.status === 'queued'), [bots]);
  const effectiveTarget = useMemo(() => (selectedTarget && bots.some((b) => b.bot_id === selectedTarget) ? selectedTarget : ''), [selectedTarget, bots]);
  const composerBot = useMemo(
    () => bots.find((b) => b.bot_id === effectiveTarget) ?? bots.find((b) => b.is_supervisor) ?? bots[0],
    [bots, effectiveTarget],
  );
  const messages = useMemo(() => state?.messages.filter((m) => m.room === activeRoom && m.channel !== 'direct' && m.channel !== 'desktop') ?? [], [state?.messages, activeRoom]);
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return bots.filter((b) => b.display_name.toLowerCase().includes(q) || b.bot_id.includes(q)).slice(0, 6);
  }, [mention, bots]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages.length]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    let target: string | undefined = effectiveTarget || undefined;
    let body = value;
    const first = value.match(/^@([\w-]+)\s*/);
    if (first) {
      const found = bots.find((b) => b.bot_id === first[1] || b.display_name === first[1]);
      if (found) {
        target = found.bot_id;
        body = value.slice(first[0].length).trim() || value;
      }
    }
    setBusy(true);
    try {
      await window.studio.sendMessage(activeRoom, body, target ?? null, attachments);
      setText(''); setAttachments([]); setMention(null);
    } catch (e) { toast(`发送失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(false); inputRef.current?.focus(); }
  };

  const onChange = (value: string, caret: number): void => {
    setText(value);
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
      const query = before.slice(at + 1);
      if (!/\s/.test(query) && query.length <= 24) { setMention({ query, index: at }); return; }
    }
    setMention(null);
  };

  const insertMention = (bot: BotConfig): void => {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.index)}@${bot.bot_id} ${text.slice(caret)}`;
    setText(next); setMention(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(mention.index + bot.bot_id.length + 2, mention.index + bot.bot_id.length + 2); });
  };

  const runSearch = async (): Promise<void> => {
    const q = searchQuery.trim();
    if (!q) { setSearchHits(null); return; }
    setSearching(true);
    try {
      const res = await window.studio.searchMessages(q, activeRoom, 20);
      setSearchHits(res.hits);
    } catch (e) {
      toast(`FTS5 检索失败：${(e as Error).message}`, 'error');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
        <Users size={14} className="text-indigo-400" />
        <span className="text-xs font-medium text-slate-300">协作群聊主厅</span>
        <span className="text-[10px] text-slate-600">·</span>
        <span className="truncate text-[11px] text-slate-500">{room?.name ?? activeRoom}</span>
        <button
          type="button"
          onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchHits(null); }}
          className={`btn-ghost ml-2 border border-white/8 px-2 py-1 text-[10.5px] ${searchOpen ? 'text-indigo-300' : ''}`}
          title="SQLite FTS5 全文检索消息记录"
        >
          <Search size={12} /> 检索
        </button>
        <div className="ml-auto flex items-center -space-x-1.5">
          {bots.slice(0, 7).map((b) => (
            <button key={b.bot_id} type="button" title={`${b.display_name} · 点击透视`} onClick={() => setActiveBot(b.bot_id)} className="rounded-lg ring-2 ring-ink-900 transition-transform hover:z-10 hover:scale-110">
              <BotAvatar bot={b} size={24} />
            </button>
          ))}
          {bots.length > 7 && <span className="ml-2 text-[10px] text-slate-500">+{bots.length - 7}</span>}
        </div>
      </div>

      {searchOpen && (
        <div className="border-b border-white/5 bg-ink-950/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Search size={13} className="text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              placeholder="输入关键词进行本地 SQLite FTS5 检索（支持中英文与词干）…"
              className="flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
            />
            <button type="button" disabled={searching} onClick={() => void runSearch()} className="btn-primary px-2.5 py-1 text-[11px]">
              {searching ? '检索中…' : '搜索'}
            </button>
            <button type="button" onClick={() => { setSearchQuery(''); setSearchHits(null); setSearchOpen(false); }} className="text-slate-500 hover:text-slate-300">
              <X size={13} />
            </button>
          </div>
          {searchHits && (
            <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto">
              {searchHits.length === 0 ? (
                <div className="text-[11px] text-slate-500">未找到匹配的本地历史消息</div>
              ) : searchHits.map((hit) => (
                <div key={hit.id} className="rounded-lg border border-white/6 bg-ink-900/70 px-2.5 py-1.5 text-[11px]">
                  <div className="flex items-center gap-2 text-[10px] text-slate-500">
                    <span className="font-medium text-indigo-300">{hit.from}</span>
                    <span>→</span>
                    <span className="text-slate-300">{hit.to}</span>
                    <span className="chip bg-white/5 text-slate-400">score {hit.score}</span>
                    <span className="mono ml-auto">{formatTime(hit.created)}</span>
                  </div>
                  <div className="mt-0.5 text-slate-300">{hit.snippet}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {messages.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={22} />}
              title="房间已就绪"
              hint="在下方输入需求发给团队，或点击左侧任意 Bot 进行单聊。输入 @ 可点名指定成员。"
            />
          ) : messages.map((m) => <MessageCard key={m.id} message={m} bots={bots} onPickBot={setActiveBot} />)}

          {workingBots.map((b) => {
            const live = extractLiveTurnStream(streams[b.bot_id] ?? []);
            return (
              <div
                key={`live-${b.bot_id}`}
                className="animate-slideIn flex items-start gap-3 py-1.5 opacity-95"
              >
                <BotAvatar bot={b} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                    <span className="font-medium text-slate-200">{b.display_name}</span>
                  </div>
                  <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/[.04] px-3.5 py-2.5">
                    <LiveProcessCard
                      live={live}
                      status={b.status}
                      compact
                      onOpenDetail={() => setActiveBot(b.bot_id)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="relative px-4 pb-4 pt-1">
        <div className="mx-auto max-w-3xl">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span key={a} className="chip bg-white/5 text-slate-400">
                  <Paperclip size={10} />{a.split(/[\\/]/).pop()}
                  <button type="button" onClick={() => setAttachments((list) => list.filter((x) => x !== a))}><XCircle size={11} /></button>
                </span>
              ))}
            </div>
          )}
          {mention && suggestions.length > 0 && (
            <div className="absolute bottom-full left-4 z-20 mb-1 w-64 rounded-lg border border-white/10 bg-ink-800 p-1 shadow-2xl">
              <div className="px-2 py-1 text-[10px] text-slate-500">点名 Bot（默认发主管）</div>
              {suggestions.map((b) => (
                <button key={b.bot_id} type="button" onClick={() => insertMention(b)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-white/5">
                  <BotAvatar bot={b} size={20} /><span className="flex-1">{b.display_name}</span><EngineBadge engine={b.engine_type} />
                </button>
              ))}
            </div>
          )}
          <div
            className="rounded-2xl border border-white/10 bg-ink-900/80 focus-within:border-indigo-500/40 transition-colors"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)).filter(Boolean);
              if (files.length) setAttachments((list) => [...list, ...files].slice(0, 8));
            }}
          >
            <textarea
              ref={inputRef} value={text} rows={2}
              onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                if (e.key === 'Escape') setMention(null);
              }}
              className="w-full bg-transparent px-4 pt-3 pb-1 text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none resize-none"
              placeholder="下达任务给团队… 输入 @ 点名 Bot"
            />
            <div className="flex items-center gap-1.5 px-3 pb-2.5">
              <select
                value={effectiveTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                title="选择接收任务的目标 Bot（默认发给主管）"
                className="rounded-lg border border-white/10 bg-white/[.04] px-2 py-1 text-[11px] text-slate-300 outline-none focus:border-indigo-500/40"
              >
                <option value="">自动派单（主管）</option>
                {bots.map((b) => (
                  <option key={b.bot_id} value={b.bot_id}>
                    @{b.display_name}
                  </option>
                ))}
              </select>
              {composerBot && (
                <ModelPicker
                  engine={composerBot.engine_type}
                  targetId={composerBot.desktop_target_id}
                  model={composerBot.model}
                  effort={composerBot.reasoning_effort}
                  direction="up"
                  align="left"
                  compact
                  onChange={(nextModel, nextEffort) => { void setBotModel(composerBot.bot_id, nextModel, nextEffort); }}
                />
              )}
              <button type="button" className="btn-ghost px-2 py-1 text-[11px]" title="输入 @ 触发补全" onClick={() => { setText((t) => `${t}@`); inputRef.current?.focus(); }}>
                <AtSign size={12} /> 提及
              </button>
              <button type="button" className="btn-ghost cursor-pointer px-2 py-1 text-[11px]" title="上传任务文件 / 截图" onClick={() => { void window.studio.pickAttachments().then(files => setAttachments(list => [...new Set([...list, ...files])].slice(0, 8))); }}>
                <Paperclip size={12} /> 附件
              </button>
              <button type="button" className="btn-primary ml-auto px-3.5 py-1.5 rounded-xl" disabled={!text.trim() || busy} onClick={() => void send()}>
                <Send size={12} /> 发送 <CornerDownLeft size={10} className="opacity-60" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
