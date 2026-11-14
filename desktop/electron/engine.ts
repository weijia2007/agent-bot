import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_HOME,
  ENGINE_PORT,
  engineEnvironment,
  engineExecutable,
  ensureDirs,
  generateToken,
} from './config';
import type { BotConfig, EngineEvent, SearchHit } from '../src/types';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** Owns the isolated C# engine process and the authenticated loopback control channel. */
export class EngineBridge extends EventEmitter {
  private proc?: ChildProcess;
  private sseRequest?: http.ClientRequest;
  private reconnectTimer?: NodeJS.Timeout;
  private respawnTimer?: NodeJS.Timeout;
  private recentRestarts: number[] = [];
  private stopped = false;
  private readonly token: string;
  private maxHops = 10;
  private spawnEnabled = true;

  constructor() {
    super();
    ensureDirs();
    this.token = EngineBridge.loadOrCreateToken();
  }

  private static loadOrCreateToken(): string {
    const file = path.join(DATA_HOME, 'engine-token.txt');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {
      // First launch.
    }
    const token = generateToken();
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ignores POSIX modes. */ }
    return token;
  }

  get authToken(): string { return this.token; }
  get isRunning(): boolean { return this.proc !== undefined && !this.proc.killed; }

  async start(options?: { maxHops?: number; spawnEnabled?: boolean }): Promise<void> {
    this.stopped = false;
    this.maxHops = options?.maxHops ?? 10;
    this.spawnEnabled = options?.spawnEnabled ?? true;

    // Reuse a healthy engine left by a previous launch (same persisted token).
    try {
      const info = await this.api('GET', '/api/engine');
      if (info.status === 200 && info.body?.service === 'nexus-bot-studio-engine') {
        this.connectEvents();
        this.emit('engine-ready', { reused: true });
        return;
      }
    } catch {
      // Nothing healthy listening: start our own.
    }

    await this.spawnAndWait();
    this.connectEvents();
    this.emit('engine-ready', { reused: false });
  }

  private async spawnAndWait(): Promise<void> {
    const exe = engineExecutable();
    this.proc = spawn(exe, ['--http', String(ENGINE_PORT)], {
      env: engineEnvironment(this.token, this.maxHops, this.spawnEnabled),
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: 'ignore',
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = undefined;
      this.emit('engine-exit', { code, signal });
      if (!this.stopped) this.scheduleRestart();
    });
    this.proc.on('error', (err) => this.emit('engine-error', err.message));

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const health = await this.api('GET', '/health');
        if (health.status === 200 || health.status === 503) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const probe = await this.api('GET', '/api/engine');
      if (probe.status !== 200) throw new Error(`engine control API answered ${probe.status}`);
    } catch (e) {
      throw new Error(`NexusBot Studio engine failed to start: ${(e as Error).message}`);
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.respawnTimer) return;
    const now = Date.now();
    this.recentRestarts = this.recentRestarts.filter((t) => now - t < 60_000);
    if (this.recentRestarts.length >= 5) {
      this.emit('engine-error', '引擎在 60 秒内重启超过 5 次，停止自动拉起');
      return;
    }
    this.recentRestarts.push(now);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.stopped || this.proc) return;
      void this.spawnAndWait()
        .then(() => {
          this.connectEvents();
          this.emit('engine-restarted');
        })
        .catch((err: unknown) => this.emit('engine-error', (err as Error).message));
    }, 1500);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = undefined; }
    this.sseRequest?.destroy();
    this.sseRequest = undefined;
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      await new Promise((r) => setTimeout(r, 300));
    }
    this.proc = undefined;
  }

  private api<T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: ENGINE_PORT,
          path: route,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed: unknown = {};
            try { parsed = raw.length ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`timeout: ${method} ${route}`)); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private connectEvents(): void {
    if (this.stopped) return;
    this.sseRequest?.destroy();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ENGINE_PORT,
        path: '/api/events',
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.scheduleReconnect();
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) {
              try {
                this.emit('engine-event', JSON.parse(line.slice(5).trim()) as EngineEvent);
              } catch {
                // A truncated frame is ignored; the next one is complete.
              }
            }
            split = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => this.scheduleReconnect());
        res.on('error', () => this.scheduleReconnect());
      },
    );
    req.on('error', () => this.scheduleReconnect());
    req.end();
    this.sseRequest = req;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectEvents();
    }, 1500);
  }

  async listBots(room?: string): Promise<Record<string, unknown>[]> {
    const res = await this.api<{ bots: Record<string, unknown>[] }>('GET', `/api/bots${room ? `?room=${encodeURIComponent(room)}` : ''}`);
    return res.body?.bots ?? [];
  }

  async registerBot(bot: BotConfig): Promise<void> {
    const res = await this.api('POST', '/api/bots/register', {
      bot_id: bot.bot_id,
      display_name: bot.display_name,
      engine_type: bot.engine_type,
      role: bot.role,
      status: bot.status,
      workspace: bot.workspace,
      room: bot.room,
      is_supervisor: bot.is_supervisor,
      external_session_id: bot.external_session_id ?? '',
      bound: Boolean(bot.external_session_id),
    });
    if (res.status !== 200) throw new Error(`register bot failed: ${JSON.stringify(res.body)}`);
  }

  async deleteBot(botId: string): Promise<void> {
    await this.api('DELETE', `/api/bots/${encodeURIComponent(botId)}`);
  }

  async setBotStatus(botId: string, status: string): Promise<void> {
    await this.api('POST', '/api/bots/status', { bot_id: botId, status });
  }

  async postUserMessage(to: string, text: string, topic: string, traceId?: string): Promise<{ id: string; traceId?: string }> {
    const res = await this.api<{ id: string; trace_id?: string }>('POST', '/api/messages/user', {
      to, text, topic, ...(traceId ? { trace_id: traceId } : {}),
    });
    if (res.status !== 200) throw new Error(`post message failed: ${JSON.stringify(res.body)}`);
    return { id: res.body.id, traceId: res.body.trace_id };
  }

  async setEngineConfig(opts: { maxHops?: number; spawnEnabled?: boolean }): Promise<void> {
    await this.api('POST', '/api/engine/config', {
      ...(typeof opts.maxHops === 'number' ? { max_hops: opts.maxHops } : {}),
      ...(typeof opts.spawnEnabled === 'boolean' ? { spawn_enabled: opts.spawnEnabled } : {}),
    });
  }

  async setEmergencyStop(active: boolean): Promise<void> {
    await this.api(active ? 'POST' : 'DELETE', '/api/emergency-stop', active ? {} : undefined);
  }

  async quotas(): Promise<Record<string, unknown>> {
    // The renderer polls this on a timer. During boot (or while the engine restarts) the loopback
    // listener may not exist yet: report an empty snapshot instead of throwing into an IPC handler.
    try {
      const res = await this.api('GET', '/api/quotas');
      return res.status === 200 ? (res.body ?? {}) : {};
    } catch {
      return {};
    }
  }

  async engineInfo(): Promise<Record<string, unknown>> {
    try {
      const res = await this.api('GET', '/api/engine');
      return res.status === 200 ? res.body : {};
    } catch {
      return {};
    }
  }

  async searchMessages(query: string, topic?: string, sender?: string, limit = 25): Promise<{ total: number; engine: string; hits: SearchHit[] }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (topic) params.set('topic', topic);
    if (sender) params.set('sender', sender);
    const res = await this.api<{ total?: number; engine?: string; hits?: SearchHit[]; error?: string }>('GET', `/api/search?${params.toString()}`);
    if (res.status !== 200) throw new Error(res.body?.error ?? `search failed (${res.status})`);
    return {
      total: Number(res.body?.total ?? 0),
      engine: String(res.body?.engine ?? 'fts5'),
      hits: Array.isArray(res.body?.hits) ? res.body.hits : [],
    };
  }

  async getMessages(topic?: string, limit = 200): Promise<Record<string, unknown>[]> {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (topic) params.set('topic', topic);
      const res = await this.api<{ messages?: Record<string, unknown>[] }>('GET', `/api/messages?${params.toString()}`);
      return res.status === 200 && Array.isArray(res.body?.messages) ? res.body.messages : [];
    } catch {
      return [];
    }
  }

  async getLocks(): Promise<Record<string, unknown>[]> {
    try {
      const res = await this.api<{ locks?: Record<string, unknown>[] }>('GET', '/api/locks');
      return res.status === 200 && Array.isArray(res.body?.locks) ? res.body.locks : [];
    } catch {
      return [];
    }
  }

  async releaseLock(lockId: string): Promise<string[]> {
    const res = await this.api<{ released?: string[]; error?: string }>('DELETE', `/api/locks/${encodeURIComponent(lockId)}`);
    if (res.status !== 200) throw new Error(res.body?.error ?? `release lock failed (${res.status})`);
    return Array.isArray(res.body?.released) ? res.body.released : [];
  }
}
