import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { StudioWebSocketServer } from '../electron/ws';

describe('StudioWebSocketServer', () => {
  let server: StudioWebSocketServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('rejects unauthenticated or non-upgrade requests and streams real WebSocket frames', async () => {
    server = new StudioWebSocketServer();
    const { port, url } = await server.start(0);
    expect(port).toBeGreaterThan(0);
    expect(url).toContain(`ws://127.0.0.1:${port}/?token=`);

    // Plain HTTP request receives 426 Upgrade Required.
    const httpStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    expect(httpStatus).toBe(426);

    // Wrong token is rejected before handshake.
    await expect(new Promise<void>((resolve, reject) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong`);
      bad.addEventListener('open', () => { bad.close(); reject(new Error('should not open')); });
      bad.addEventListener('error', () => resolve());
      bad.addEventListener('close', () => resolve());
    })).resolves.toBeUndefined();

    // Authenticated client receives small and large (>64KB) broadcast frames intact.
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (e) => reject(e), { once: true });
    });

    expect(server.clientCount).toBe(1);

    const received: Array<{ channel: string; payload: unknown }> = [];
    ws.addEventListener('message', (ev) => {
      received.push(JSON.parse(String(ev.data)) as { channel: string; payload: unknown });
    });

    const bigText = 'x'.repeat(70_000);
    server.broadcast('approvals', [{ id: 'req-1', command: 'git commit' }]);
    server.broadcast('stream', { bot_id: 'bot-a', event: { type: 'text_delta', text: bigText } });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.length >= 2) { clearInterval(timer); resolve(); }
      }, 15);
    });

    expect(received[0]).toEqual({ channel: 'approvals', payload: [{ id: 'req-1', command: 'git commit' }] });
    expect((received[1].payload as { event: { text: string } }).event.text.length).toBe(70_000);

    ws.close();
  });
});
