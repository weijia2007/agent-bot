import { contextBridge, ipcRenderer } from 'electron';

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on('studio:event', (_event, packet: { channel: string; payload: unknown }) => {
  const set = listeners.get(packet.channel);
  if (set) for (const listener of set) {
    try { listener(packet.payload); } catch { /* a bad renderer listener must not break IPC */ }
  }
});

const invoke = (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(`studio:${method}`, ...args);

const api = {
  getState: () => invoke('getState'),
  createRoom: (name: string, projectPath: string) => invoke('createRoom', name, projectPath),
  setRoomProject: (roomId: string, projectPath: string) => invoke('setRoomProject', roomId, projectPath),
  createBot: (input: unknown) => invoke('createBot', input),
  deleteBot: (botId: string) => invoke('deleteBot', botId),
  reconnectBot: (botId: string) => invoke('reconnectBot', botId),
  setBotModel: (botId: string, model: string) => invoke('setBotModel', botId, model),
  setSupervisor: (botId: string) => invoke('setSupervisor', botId),
  sendMessage: (room: string, text: string, target?: string) => invoke('sendMessage', room, text, target ?? null),
  sendDirect: (botId: string, text: string, room: string) => invoke('sendDirect', botId, text, room),
  emergencyStop: (active: boolean) => invoke('emergencyStop', active),
  respondApproval: (id: string, approved: boolean, reason?: string) => invoke('respondApproval', id, approved, reason ?? null),
  resolveHopPause: (id: string, resume: boolean) => invoke('resolveHopPause', id, resume),
  releaseLock: (id: string) => invoke('releaseLock', id),
  searchMessages: (query: string, room?: string, limit?: number) => invoke('searchMessages', query, room ?? null, limit ?? null),
  wsEndpoint: () => invoke('wsEndpoint'),
  getDiffs: (botId: string) => invoke('getDiffs', botId),
  worktreeStatus: (botId: string) => invoke('worktreeStatus', botId),
  mergeWorktree: (botId: string) => invoke('mergeWorktree', botId),
  resetWorktree: (botId: string) => invoke('resetWorktree', botId),
  setMaxHops: (value: number) => invoke('setMaxHops', value),
  setSpawnEnabled: (enabled: boolean) => invoke('setSpawnEnabled', enabled),
  health: () => invoke('health'),
  quotas: () => invoke('quotas'),
  openPath: (target: string) => invoke('openPath', target),
  pickProject: () => invoke('pickProject'),
  dataHome: () => invoke('dataHome'),
  on: (channel: string, listener: Listener): (() => void) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(channel, set);
    return () => { set.delete(listener); };
  },
};

contextBridge.exposeInMainWorld('studio', api);
