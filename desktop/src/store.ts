import { create } from 'zustand';
import type {
  BotConfig, DiffEntry, EngineHealth, QuotaState, Room, RoomMessage,
  SearchHit, StreamEvent, StudioState,
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
      reconnectBot(botId: string): Promise<BotConfig | null>;
      setSupervisor(botId: string): Promise<boolean>;
      sendMessage(room: string, text: string, target?: string | null): Promise<RoomMessage>;
      sendDirect(botId: string, text: string, room: string): Promise<RoomMessage>;
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
      dataHome(): Promise<string>;
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
  toasts: Toast[];
  ready: boolean;
  wsConnected: boolean;
  setActiveRoom(id: string): void;
  setActiveBot(id: string | null): void;
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
  inspectorOpen: true,
  inspectorTab: 'tasks',
  sidebarWidth: 292,
  inspectorWidth: 340,
  newBotOpen: false,
  newRoomOpen: false,
  streams: {},
  health: null,
  quotas: null,
  toasts: [],
  ready: false,
  wsConnected: false,

  setActiveRoom: (id) => set({ activeRoom: id, activeBot: null }),
  setActiveBot: (id) => set({ activeBot: id }),
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
      set({ state, activeRoom: state.rooms[0]?.id ?? 'default', ready: true });
    } catch (e) {
      set({ ready: true });
      get().toast(`读取状态失败：${(e as Error).message}`, 'error');
      return;
    }

    const handlers: Record<string, (p: unknown) => void> = {
      state: (p) => set({ state: p as StudioState }),
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
            : [...s.state.messages, message].slice(-500);
          return { state: { ...s.state, messages } };
        });
      },
      stream: (p) => {
        const ev = p as StreamEvent;
        set((s) => ({
          streams: {
            ...s.streams,
            [ev.bot_id]: [...(s.streams[ev.bot_id] ?? []), ev].slice(-400),
          },
        }));
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
