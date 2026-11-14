// Phase 4 acceptance smoke test: run the real isolated engine as a black box and exercise the
// loopback control plane, the SSE stream, the MCP tool surface and the kill switch.
// Usage: node scripts/smoke-engine.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 16191;
const EXE = path.join(ROOT, 'engine', 'publish', 'NexusRelay.exe');
const HOME = path.join(ROOT, 'docs', '.smoke-home');
const TOKEN = crypto.randomBytes(32).toString('hex');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function request(method, route, body, { token = TOKEN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${route}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitEngine() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request('GET', '/api/engine');
      if (r.status === 200) return r.body;
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  throw new Error('engine did not become ready on 127.0.0.1:16191');
}

function openEvents() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/events', method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`SSE status ${res.statusCode}`)); return; }
      const events = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i = buffer.indexOf('\n\n');
        while (i >= 0) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line) {
            try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* heartbeat */ }
          }
          i = buffer.indexOf('\n\n');
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`engine binary missing: ${EXE}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  const env = {
    ...process.env,
    NEXUS_RELAY_HOME: path.join(HOME, 'relay'),
    NEXUS_BOT_PORT: String(PORT),
    NEXUS_MCP_TOKEN: TOKEN,
    NEXUS_RELAY_HOST: 'all',
    NEXUS_BOT_ALLOW_PEER_SEND: '1',
    NEXUS_BOT_SPAWN_ENABLED: '1',
    NEXUS_BOT_MAX_HOPS: '10',
    NEXUS_RELAY_UPDATE_CHECK: '0',
  };
  const proc = spawn(EXE, ['--http', String(PORT)], {
    env, cwd: path.dirname(EXE), windowsHide: true, stdio: 'ignore',
  });
  proc.on('error', (e) => console.error('engine spawn error:', e.message));

  try {
    const info = await waitEngine();
    check('engine /api/engine identity', info.service === 'nexus-bot-studio-engine', `version=${info.version} pid=${info.pid}`);
    check('isolated relay home', String(info.relay_home).includes('.smoke-home'), String(info.relay_home));

    const denied = await request('GET', '/api/bots', undefined, { token: null });
    check('Bearer token enforced', denied.status === 401, `status=${denied.status}`);

    const reg = await request('POST', '/api/bots/register', {
      bot_id: 'supervisor-1', display_name: 'Supervisor', engine_type: 'claude',
      role: 'supervisor', room: 'studio', is_supervisor: true, status: 'idle',
      workspace: '', external_session_id: 'uuid-claude-1', bound: true,
    });
    const reg2 = await request('POST', '/api/bots/register', {
      bot_id: 'be-codex-1', display_name: 'Backend', engine_type: 'codex',
      role: 'worker', room: 'studio', is_supervisor: false, status: 'idle',
      workspace: '', external_session_id: 'uuid-codex-1', bound: true,
    });
    check('two distinct bots registered', reg.status === 200 && reg2.status === 200);

    const list = await request('GET', '/api/bots?room=studio');
    const ids = (list.body.bots ?? []).map((b) => b.bot_id);
    check('bot registry lists independent ids', ids.includes('supervisor-1') && ids.includes('be-codex-1'), ids.join(','));

    const tools = await request('POST', '/mcp?bot=supervisor-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    const names = (tools.body?.result?.tools ?? []).map((t) => t.name);
    check('MCP tools/list has 22 tools incl. list_bots/spawn_bot',
      names.length === 22 && names.includes('list_bots') && names.includes('spawn_bot'),
      `count=${names.length}`);

    const sse = await openEvents();
    await sleep(200);
    const posted = await request('POST', '/api/messages/user', {
      to: 'be-codex-1', text: 'Build the /health endpoint', topic: 'studio',
    });
    check('user message accepted', posted.status === 200 && Boolean(posted.body.id), `id=${posted.body.id}`);
    for (let i = 0; i < 40 && !sse.events.some((e) => e.type === 'message_posted'); i++) await sleep(100);
    const ev = sse.events.find((e) => e.type === 'message_posted');
    check('SSE delivered real message_posted event', Boolean(ev) && ev.data?.to === 'be-codex-1',
      ev ? `seq=${ev.seq} to=${ev.data?.to}` : 'no event');
    sse.close();

    const stopFile = path.join(HOME, 'relay', 'stop');
    const stop = await request('POST', '/api/emergency-stop', {});
    check('emergency stop file lives in isolated home', stop.status === 200 && fs.existsSync(stopFile), stopFile);
    const cleared = await request('DELETE', '/api/emergency-stop');
    check('emergency stop can be cleared', cleared.status === 200 && !fs.existsSync(stopFile));

    const quotas = await request('GET', '/api/quotas');
    check('/api/quotas responds', quotas.status === 200);

    const removed = await request('DELETE', '/api/bots/be-codex-1');
    check('bot can be unregistered', removed.status === 200 && removed.body.removed === true);

    const after = await request('GET', '/api/bots?room=studio');
    const ids2 = (after.body.bots ?? []).map((b) => b.bot_id);
    check('unregistered bot disappears', !ids2.includes('be-codex-1'), ids2.join(','));
  } finally {
    proc.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exitCode = 1; });
