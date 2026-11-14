import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CodexDesktopClient, applyDesktopPatch } from '../electron/desktop/codex-ipc';
import { JournalTail, journalObservations } from '../electron/desktop/journals';

const roots: string[] = [];
const clients: CodexDesktopClient[] = [];
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  clients.splice(0).forEach(client => client.close());
  sockets.forEach(socket => socket.destroy()); sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.NEXUS_BOT_CODEX_DESKTOP_PIPE;
});
function temporary(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bot-protocol-')); roots.push(root); return root; }
function frame(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); }

describe('running Codex desktop connection', () => {
  it('joins the desktop router, follows the original conversation and receives snapshots split across frames', async () => {
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\agent-bot-test-${crypto.randomUUID()}` : path.join(temporary(), 'ipc.sock');
    const received: Record<string, any>[] = [];
    const server = net.createServer(socket => {
      sockets.add(socket); let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
          const length = buffer.readUInt32LE(0), packet = JSON.parse(buffer.subarray(4, 4 + length).toString()); buffer = buffer.subarray(4 + length); received.push(packet);
          if (packet.type === 'request') socket.write(frame({ type: 'response', requestId: packet.requestId, resultType: 'success', handledByClientId: 'actual-desktop-owner', result: packet.method === 'initialize' ? { clientId: 'bot-client' } : { supportsUntrustedAppInput: true } }));
          if (packet.method === 'thread-stream-following-changed') {
            const body = frame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'desktop-thread', change: { type: 'snapshot', revision: 1, conversationState: { cwd: 'C:\\project', latestModel: 'real-desktop-model', currentPermissions: { approvalPolicy: 'on-request' } } } } });
            socket.write(body.subarray(0, 2)); setTimeout(() => socket.write(body.subarray(2)), 5);
          }
        }
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(pipe, resolve));
    process.env.NEXUS_BOT_CODEX_DESKTOP_PIPE = pipe;
    const client = new CodexDesktopClient(); clients.push(client);
    const state = await client.follow('desktop-thread');
    expect(state.latestModel).toBe('real-desktop-model');
    expect(received.map(packet => packet.method)).toEqual(['initialize', 'thread-owner-discovery', 'thread-stream-following-changed']);
    expect(received[1].version).toBe(1);
    await client.request('thread-follower-start-turn', { conversationId: 'desktop-thread', turnStart: { request: { threadId: 'desktop-thread', input: [{ type: 'text', text: 'test' }] } } }, client.owners.get('desktop-thread'));
    const sent = received.at(-1)!;
    expect(sent.version).toBe(2); expect(sent.targetClientId).toBe('actual-desktop-owner');
  });

  it('applies desktop patches without permitting prototype paths', () => {
    const state = { turns: [{ text: 'before' }], requests: ['a'] };
    applyDesktopPatch(state, { op: 'replace', path: ['turns', 0, 'text'], value: 'after' });
    applyDesktopPatch(state, { op: 'add', path: ['requests', 1], value: 'b' });
    applyDesktopPatch(state, { op: 'remove', path: ['requests', 0] });
    applyDesktopPatch(state, { op: 'add', path: ['__proto__', 'injected'], value: true });
    expect(state).toEqual({ turns: [{ text: 'after' }], requests: ['b'] });
    expect(({} as any).injected).toBeUndefined();
  });
});

describe('real agent journal mirroring', () => {
  it('keeps incomplete JSON and split UTF-8 without rereading delivered rows', () => {
    const file = path.join(temporary(), 'transcript.jsonl'); const bytes = Buffer.from('{"text":"中文工具反馈"}\n');
    const cut = bytes.indexOf(Buffer.from('中')) + 1;
    fs.writeFileSync(file, bytes.subarray(0, cut)); const tail = new JournalTail(file);
    expect(tail.read()).toEqual([]); fs.appendFileSync(file, bytes.subarray(cut));
    expect(tail.read()).toEqual([{ text: '中文工具反馈' }]); expect(tail.read()).toEqual([]);
    fs.writeFileSync(file, '{"new":true}\n'); expect(tail.read()).toEqual([{ new: true }]);
  });

  it('mirrors visible messages and tool calls while omitting internal reasoning and Bot prompt echoes', () => {
    const message = (channel: string, text: string) => ({ type: 'response_item', timestamp: '2026-11-15T00:00:00Z', payload: { type: 'message', role: 'assistant', channel, content: [{ text }] } });
    expect(journalObservations(message('analysis', 'private reasoning'), 'codex')).toEqual([]);
    expect(journalObservations(message('final', 'visible response'), 'codex')[0]).toMatchObject({ type: 'message', text: 'visible response' });
    expect(journalObservations(message('commentary', '[Agent Bot · task]'), 'codex')).toEqual([]);
    const tool = journalObservations({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'read_file', input: 'task.md' } }, 'codex');
    expect(tool[0]).toMatchObject({ type: 'activity', event: { type: 'tool_call_start', tool: 'read_file' } });
    expect(journalObservations({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true }, 'claude')).toEqual([]);
    expect(journalObservations({ type: 'assistant', isSidechain: true, message: { content: 'subagent' } }, 'claude')).toEqual([]);
  });
});
