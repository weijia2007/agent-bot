import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface WsClient {
  socket: Duplex;
  buffer: Buffer;
  closed: boolean;
}

/**
 * Minimal zero-dependency RFC 6455 loopback WebSocket server for Electron main -> Renderer
 * real-time event streaming (terminal/tool deltas, approval requests, EditGuard locks, chat frames).
 */
export class StudioWebSocketServer {
  private readonly token = crypto.randomBytes(24).toString('base64url');
  private readonly clients = new Set<WsClient>();
  private server?: http.Server;
  private heartbeat?: NodeJS.Timeout;
  private boundPort = 0;

  get port(): number { return this.boundPort; }
  get url(): string { return this.boundPort > 0 ? `ws://127.0.0.1:${this.boundPort}/?token=${this.token}` : ''; }
  get clientCount(): number { return this.clients.size; }

  async start(preferredPort = 0): Promise<{ port: number; url: string }> {
    if (this.server && this.boundPort > 0) return { port: this.boundPort, url: this.url };

    const server = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Upgrade Required');
    });

    server.on('upgrade', (req, socket, head) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const token = reqUrl.searchParams.get('token');
      const key = req.headers['sec-websocket-key'];
      const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

      if (token !== this.token || !key || upgrade !== 'websocket') {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      const client: WsClient = {
        socket,
        buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
        closed: false,
      };
      this.clients.add(client);

      socket.on('data', (chunk: Buffer) => this.onData(client, chunk));
      socket.on('close', () => this.dropClient(client));
      socket.on('error', () => this.dropClient(client));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferredPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : preferredPort;
    this.server = server;

    this.heartbeat = setInterval(() => {
      for (const c of [...this.clients]) {
        if (c.closed || c.socket.destroyed) { this.dropClient(c); continue; }
        this.writeFrame(c, 0x09, Buffer.alloc(0));
      }
    }, 25_000);
    this.heartbeat.unref();

    return { port: this.boundPort, url: this.url };
  }

  broadcast(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return;
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify({ channel, payload }), 'utf8');
    } catch {
      return;
    }
    const frame = StudioWebSocketServer.encodeFrame(0x01, body);
    for (const c of [...this.clients]) {
      if (c.closed || c.socket.destroyed) { this.dropClient(c); continue; }
      try { c.socket.write(frame); } catch { this.dropClient(c); }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const c of [...this.clients]) {
      try { this.writeFrame(c, 0x08, Buffer.alloc(0)); } catch { /* ignore */ }
      try { c.socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.server) {
      const s = this.server;
      this.server = undefined;
      this.boundPort = 0;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  private dropClient(client: WsClient): void {
    client.closed = true;
    this.clients.delete(client);
  }

  private writeFrame(client: WsClient, opcode: number, data: Buffer): void {
    if (client.closed || client.socket.destroyed) return;
    try {
      client.socket.write(StudioWebSocketServer.encodeFrame(opcode, data));
    } catch {
      this.dropClient(client);
    }
  }

  private onData(client: WsClient, chunk: Buffer): void {
    client.buffer = client.buffer.length > 0 ? Buffer.concat([client.buffer, chunk]) : chunk;
    while (client.buffer.length >= 2) {
      const b0 = client.buffer[0];
      const b1 = client.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (client.buffer.length < 10) return;
        const bigLen = client.buffer.readBigUInt64BE(2);
        if (bigLen > 16n * 1024n * 1024n) { this.dropClient(client); client.socket.destroy(); return; }
        length = Number(bigLen);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLen + length) return;

      const payload = Buffer.from(client.buffer.subarray(offset + maskLen, offset + maskLen + length));
      if (masked) {
        const mask = client.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      client.buffer = client.buffer.subarray(offset + maskLen + length);

      if (opcode === 0x08) {
        this.writeFrame(client, 0x08, Buffer.alloc(0));
        client.socket.end();
        this.dropClient(client);
        return;
      }
      if (opcode === 0x09) {
        this.writeFrame(client, 0x0a, payload);
      }
    }
  }

  static encodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let headerLen = 2;
    if (len >= 126 && len <= 0xffff) headerLen = 4;
    else if (len > 0xffff) headerLen = 10;

    const frame = Buffer.allocUnsafe(headerLen + len);
    frame[0] = 0x80 | (opcode & 0x0f);
    if (headerLen === 2) {
      frame[1] = len;
    } else if (headerLen === 4) {
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    if (len > 0) payload.copy(frame, headerLen);
    return frame;
  }
}
