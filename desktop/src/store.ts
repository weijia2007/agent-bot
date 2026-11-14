import { create } from 'zustand';
import {
  formatModelLabel,
  type BotConfig, type DiffEntry, type EngineHealth, type EngineModelCatalog, type QuotaState,
  type Room, type RoomMessage, type SearchHit, type StreamEvent, type StudioState,
  type DesktopSession, type EngineType, type PermissionMode,
} from './types';

type ChannelPayloads = Record<string, unknown>;

declare global {
  interface Window {
    studio: {
      getState(): Promise<StudioState>;
      createRoom(name: string, projectPath: string): Promise<Room>;
      setRoomProject(roomId: string, projectPath: string): Promise<boolean>;
      createBot(input: unknown): Promise<BotConfig>;
      deleteBot(botId: string): Promise<boolean>;
      stopBot(botId: string): Promise<void>;
      reconnectBot(botId: string): Promise<BotConfig | null>;
      setBotModel(botId: string, model: string, reasoningEffort?: string): Promise<BotConfig | null>;
      listModels(refresh?: boolean): Promise<EngineModelCatalog>;
      listDesktopSessions(engine: EngineType): Promise<DesktopSession[]>;
      listDesktopTargets(): Promise<{ id: string; label: string }[]>;
      launchDesktop(engine: EngineType, roomId: string): Promise<void>;
      setBotPermission(id: string, mode: PermissionMode): Promise<BotConfig>;
      setSupervisor(botId: string): Promise<boolean>;
      sendMessage(room: string, text: string, target?: string | null, attachments?: string[]): Promise<RoomMessage>;
      sendDirect(botId: string, text: string, room: string, attachments?: string[]): Promise<RoomMessage>;
      emergencyStop(active: boolean): Promise<boolean>;
      respondApproval(id: string, approved: boolean, reason?: string | null): Promise<boolean>;
      resolveHopPause(id: string, resume: boolean): Promise<boolean>;
      releaseLock(id: string): Promise<boolean>;
      searchMessages(query: string, room?: string, limit?: number): Promise<{ total: number; engine: string; hits: SearchHit[] }>;
      wsEndpoint(): Promise<string>;
      getDiffs(botId: string): Promise<DiffEntry[]>;
      worktreeStatus(botId: string): Promise<string>;
      mergeWorktree(botId: string): Promise<{ ok: boolean; message: string }>;
      resetWorktree(botId: string): Promise<{ ok: boolean; message: string }>;
      setMaxHops(value: number): Promise<boolean>;
      setSpawnEnabled(enabled: boolean): Promise<boolean>;
      health(): Promise<EngineHealth>;
      quotas(): Promise<QuotaState>;
      openPath(target: string): Promise<boolean>;
      pickProject(): Promise<string | null>;
      pickAttachments(): Promise<string[]>;
      pathForFile(file: File): string;
      openSession(id: string): Promise<boolean>;
      openCodexConversation(id: string): Promise<boolean>;
      dataHome(): Promise<string>;
      openHelp(): Promise<boolean>;
      on(channel: string, listener: (payload: unknown) => void): () => void;
    };
  }
}

export interface Toast { id: string; text: string; level: 'info' | 'error' | 'success' }

export type InspectorTab = 'tasks' | 'approvals' | 'locks' | 'health';

interface StudioStore {
  state: StudioState | null;
  activeRoom: string;
  activeBot: string | null;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  sidebarWidth: number;
  inspectorWidth: number;
  newBotOpen: boolean;
  newRoomOpen: boolean;
  streams: Record<string, StreamEvent[]>;
  health: EngineHealth | null;
  quotas: QuotaState | null;
  modelsCatalog: EngineModelCatalog | null;
  modelsLoading: boolean;
  toasts: Toast[];
  ready: boolean;
  wsConnected: boolean;
  setActiveRoom(id: string): void;
  setActiveBot(id: string | null): void;
  setBotModel(botId: string, model: string, reasoningEffort?: string): Promise<void>;
  loadModels(refresh?: boolean): Promise<void>;
  setInspectorOpen(open: boolean): void;
  setInspectorTab(tab: InspectorTab): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setNewBotOpen(open: boolean): void;
  setNewRoomOpen(open: boolean): void;
  toast(text: string, level?: Toast['level']): void;
  dismissToast(id: string): void;
  clearStream(botId: string): void;
  refresh(): Promise<void>;
  init(): Promise<void>;
}

let initialized = false;

export const useStudio = create<StudioStore>((set, get) => ({
  state: null,
  activeRoom: 'default',
  activeBot: null,
  inspectorOpen: false,
  inspectorTab: 'tasks',
  sidebarWidth: 248,
  inspectorWidth: 320,
  newBotOpen: false,
  newRoomOpen: false,
  streams: {},
  health: null,
  quotas: null,
  modelsCatalog: null,
  modelsLoading: false,
  toasts: [],
  ready: false,
  wsConnected: false,

  setActiveRoom: (id) => set({ activeRoom: id, activeBot: null }),
  setActiveBot: (id) => set({ activeBot: id }),
  loadModels: async (refresh = false) => {
    set({ modelsLoading: true });
    try {
      const modelsCatalog = await window.studio.listModels(refresh);
      set({ modelsCatalog, modelsLoading: false });
      if (refresh) get().toast('已重新读取本机模型与强度列表', 'success');
    } catch (e) {
      set({ modelsLoading: false });
      if (refresh) get().toast(`读取模型列表失败：${(e as Error).message}`, 'error');
    }
  },
  setBotModel: async (botId, model, reasoningEffort) => {
    try {
    const updated = await window.studio.setBotModel(botId, model, reasoningEffort);
    if (updated) {
      set((s) => s.state ? ({
        state: {
          ...s.state,
          bots: s.state.bots.map((b) => (b.bot_id === botId ? updated : b)),
        },
      }) : s);
      const label = formatModelLabel(updated.engine_type, updated.model, get().modelsCatalog, updated.reasoning_effort);
      get().toast(`已保存桌面模型配置，下一轮生效：${label}`, 'success');
    }
    } catch (e) { get().toast(`模型切换失败：${(e as Error).message}`, 'error'); }
  },
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  setInspectorTab: (tab) => set({ inspectorTab: tab, inspectorOpen: true }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(230, Math.min(460, width)) }),
  setInspectorWidth: (width) => set({ inspectorWidth: Math.max(280, Math.min(560, width)) }),
  setNewBotOpen: (open) => set({ newBotOpen: open }),
  setNewRoomOpen: (open) => set({ newRoomOpen: open }),
  toast: (text, level = 'info') => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, level }] }));
    setTimeout(() => get().dismissToast(id), 6500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearStream: (botId) => set((s) => ({ streams: { ...s.streams, [botId]: [] } })),

  refresh: async () => {
    const state = await window.studio.getState();
    set({ state });
    if (!state.rooms.some((r) => r.id === get().activeRoom)) {
      set({ activeRoom: state.rooms[0]?.id ?? 'default' });
    }
  },

  init: async () => {
    if (initialized) return;
    initialized = true;
    try {
      const state = await window.studio.getState();
      set({ state, streams: state.activity ?? {}, activeRoom: state.rooms[0]?.id ?? 'default', ready: true });
      void get().loadModels().catch(() => undefined);
    } catch (e) {
      set({ ready: true });
      get().toast(`读取状态失败：${(e as Error).message}`, 'error');
      return;
    }

    const handlers: Record<string, (p: unknown) => void> = {
      state: (p) => { const state = p as StudioState; set({ state, streams: state.activity ?? {} }); },
      bots: (p) => set((s) => ({ state: s.state ? { ...s.state, bots: p as BotConfig[] } : s.state })),
      rooms: (p) => set((s) => ({ state: s.state ? { ...s.state, rooms: p as Room[] } : s.state })),
      approvals: (p) => set((s) => ({ state: s.state ? { ...s.state, approvals: p as StudioState['approvals'] } : s.state })),
      'hop-pauses': (p) => set((s) => ({ state: s.state ? { ...s.state, hopPauses: p as StudioState['hopPauses'] } : s.state })),
      locks: (p) => set((s) => ({ state: s.state ? { ...s.state, locks: p as StudioState['locks'] } : s.state })),
      emergency: (p) => set((s) => ({ state: s.state ? { ...s.state, emergencyStop: Boolean(p) } : s.state })),
      config: (p) => set((s) => {
        const cfg = p as { maxHops: number; spawnEnabled: boolean };
        return { state: s.state ? { ...s.state, maxHops: cfg.maxHops, spawnEnabled: cfg.spawnEnabled } : s.state };
      }),
      'bot:status': (p) => {
        const { botId, status } = p as { botId: string; status: BotConfig['status'] };
        set((s) => ({
          state: s.state
            ? { ...s.state, bots: s.state.bots.map((b) => b.bot_id === botId ? { ...b, status } : b) }
            : s.state,
        }));
      },
      message: (p) => {
        const message = p as RoomMessage;
        set((s) => {
          if (!s.state) return {};
          const exists = s.state.messages.some((m) => m.id === message.id);
          const messages = exists
            ? s.state.messages.map((m) => m.id === message.id ? message : m)
            : [...s.state.messages, message].slice(-10_000);
          return { state: { ...s.state, messages } };
        });
      },
      stream: (p) => {
        const ev = p as StreamEvent;
        set((s) => {
          const prev = s.streams[ev.bot_id] ?? [];
          const last = prev[prev.length - 1];
          // Coalesce consecutive streaming text/thinking chunks so long multi-step turns keep full tool history
          if (last && ev.event.type === 'thinking_delta' && last.event.type === 'thinking_delta') {
            const merged: StreamEvent = { ...ev, event: { type: 'thinking_delta', text: last.event.text + ev.event.text } };
            return { streams: { ...s.streams, [ev.bot_id]: [...prev.slice(0, -1), merged] } };
          }
          if (last && ev.event.type === 'text_delta' && last.event.type === 'text_delta') {
            const merged: StreamEvent = { ...ev, event: { type: 'text_delta', text: last.event.text + ev.event.text } };
            return { streams: { ...s.streams, [ev.bot_id]: [...prev.slice(0, -1), merged] } };
          }
          return { streams: { ...s.streams, [ev.bot_id]: [...prev, ev].slice(-400) } };
        });
      },
      error: (p) => get().toast(String((p as ChannelPayloads).message ?? '发生错误'), 'error'),
      'engine:exit': (p) => get().toast(`内置引擎进程退出：${JSON.stringify(p)}`, 'error'),
      'engine:restarted': () => get().toast('内置引擎已自动保活拉起', 'success'),
    };

    for (const [ch, fn] of Object.entries(handlers)) {
      window.studio.on(ch, fn);
    }

    const connectWs = async (): Promise<void> => {
      try {
        const endpoint = await window.studio.wsEndpoint();
        if (!endpoint) return;
        const ws = new WebSocket(endpoint);
        ws.onopen = () => {
          set({ wsConnected: true });
          void get().refresh().catch(() => undefined);
        };
        ws.onmessage = (msg) => {
          try {
            const packet = JSON.parse(String(msg.data)) as { channel?: string; payload?: unknown };
            if (packet.channel && handlers[packet.channel]) handlers[packet.channel](packet.payload);
          } catch { /* ignore malformed ws frame */ }
        };
        ws.onclose = () => {
          set({ wsConnected: false });
          setTimeout(() => { void connectWs(); }, 2000);
        };
        ws.onerror = () => { ws.close(); };
      } catch {
        setTimeout(() => { void connectWs(); }, 2500);
      }
    };
    void connectWs();

    const poll = async (): Promise<void> => {
      try {
        const [health, quotas] = await Promise.all([window.studio.health(), window.studio.quotas()]);
        set({ health, quotas });
      } catch { /* the probe panel shows the last known state */ }
    };
    void poll();
    setInterval(() => { void poll(); }, 20_000);
  },
}));
