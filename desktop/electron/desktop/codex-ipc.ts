import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

type Packet = Record<string, any>;
const VERSIONS: Record<string, number> = {
  'thread-owner-discovery': 1, 'thread-follower-start-turn': 2,
  'thread-follower-interrupt-turn': 3, 'thread-follower-update-thread-settings': 2,
  'thread-follower-load-complete-history': 1,
  'thread-follower-command-approval-decision': 1, 'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
};

/** Joins the running desktop router; never starts an independent app-server or CLI. */
export class CodexDesktopClient extends EventEmitter {
  private socket?: net.Socket;
  private clientId = 'uninitialized';
  private buffer = Buffer.alloc(0);
  private connecting?: Promise<void>;
  private readonly pending = new Map<string, { resolve: (value: Packet) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly snapshots = new Map<string, Packet>();
  readonly owners = new Map<string, string>();

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.clientId !== 'uninitialized') return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = net.createConnection(process.env.NEXUS_BOT_CODEX_DESKTOP_PIPE ?? '\\\\.\\pipe\\codex-ipc');
      this.socket = socket; this.buffer = Buffer.alloc(0);
      socket.on('data', chunk => this.read(chunk));
      socket.on('error', error => { if (this.socket === socket) this.disconnect(error); });
      socket.on('close', () => { if (this.socket === socket) this.disconnect(new Error('Codex 桌面连接已断开，请重新连接原对话')); });
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.setTimeout(5000, () => { socket.destroy(new Error('Codex desktop connection timeout')); }); });
      const result = await this.requestRaw('initialize', { clientType: 'desktop' }, 0);
      this.clientId = result.result.clientId;
      socket.setTimeout(0);
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private write(packet: Packet): void {
    if (!this.socket || this.socket.destroyed) throw new Error('Codex desktop is not connected');
    const body = Buffer.from(JSON.stringify(packet)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > 32 * 1024 * 1024) { this.socket?.destroy(new Error('Invalid Codex desktop frame')); return; }
      if (this.buffer.length < length + 4) return;
      let packet: Packet;
      try { packet = JSON.parse(this.buffer.subarray(4, length + 4).toString()); } catch { this.socket?.destroy(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      if (packet.type === 'response') {
        const request = this.pending.get(packet.requestId); if (!request) continue;
        this.pending.delete(packet.requestId); clearTimeout(request.timer);
        packet.resultType === 'success' ? request.resolve(packet) : request.reject(new Error(String(packet.error ?? 'Codex desktop request failed')));
      } else if (packet.type === 'client-discovery-request') {
        this.write({ type: 'client-discovery-response', requestId: packet.requestId, response: { canHandle: false } });
      } else if (packet.type === 'broadcast' && packet.method === 'thread-stream-state-changed') {
        const { conversationId, change } = packet.params;
        if (change.type === 'snapshot') this.snapshots.set(conversationId, change.conversationState);
        else if (change.type === 'patches') {
          const state = this.snapshots.get(conversationId);
          if (state) for (const patch of change.patches ?? []) applyDesktopPatch(state, patch);
        }
        this.emit('snapshot', conversationId, this.snapshots.get(conversationId));
      }
    }
  }

  private requestRaw(method: string, params: Packet, version: number, targetClientId?: string): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method}: desktop outcome uncertain; no automatic replay`)); }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs: 12_000 }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  async request(method: string, params: Packet, targetClientId?: string): Promise<Packet> {
    await this.connect(); return this.requestRaw(method, params, VERSIONS[method] ?? 0, targetClientId);
  }

  async follow(id: string): Promise<Packet> {
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id });
    this.owners.set(id, owner.handledByClientId);
    this.snapshots.delete(id);
    this.write({ type: 'broadcast', sourceClientId: this.clientId, version: 1, method: 'thread-stream-following-changed',
      params: { hostId: 'local', conversationId: id, following: true, targetClientIds: [owner.handledByClientId] } });
    const deadline = Date.now() + 5000;
    while (!this.snapshots.has(id) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error('未收到 Codex 桌面会话快照，请先在原应用中打开此对话再重连');
    return snapshot;
  }

  private disconnect(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.clientId = 'uninitialized'; this.snapshots.clear(); this.owners.clear();
    this.socket = undefined;
  }

  close(): void { this.socket?.destroy(); this.disconnect(new Error('Desktop connection closed')); }
}

export function applyDesktopPatch(state: Packet, patch: { op: string; path: (string | number)[]; value?: unknown }): void {
  if (!Array.isArray(patch.path) || patch.path.some(p => ['__proto__', 'constructor', 'prototype'].includes(String(p)))) return;
  if (!patch.path.length) return;
  let target: any = state;
  for (const part of patch.path.slice(0, -1)) { if (target?.[part] == null) return; target = target[part]; }
  const key = patch.path[patch.path.length - 1];
  if (patch.op === 'remove') { if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; }
  else if (patch.op === 'add' && Array.isArray(target)) target.splice(Number(key), 0, patch.value);
  else target[key] = patch.value;
}
