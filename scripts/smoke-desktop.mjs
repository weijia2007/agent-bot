// Phase 4 acceptance smoke test: launch the packaged Electron main process headlessly-ish and
// verify it boots the isolated engine, reads the shared token and exposes the control plane.
// Usage: node scripts/smoke-desktop.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const PACKAGED = process.argv.includes('--packaged');
const ELECTRON = PACKAGED
  ? path.join(DESKTOP, 'release', 'win-unpacked', 'Agent Bot.exe')
  : path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const TOKEN_FILE = path.join(os.homedir(), '.nexus-bot-studio', 'engine-token.txt');
const PORT = 16191;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(route, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }, timeout: 2500,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error(`electron runtime missing: ${ELECTRON}`);
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  // Some Electron-based hosts export ELECTRON_RUN_AS_NODE=1 for their children; if inherited,
  // electron.exe behaves like plain node and require('electron') returns a path instead of the API.
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, PACKAGED ? [] : ['.'], {
    cwd: PACKAGED ? path.dirname(ELECTRON) : DESKTOP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  let log = '';
  proc.stdout?.on('data', (c) => { log += c.toString(); });
  proc.stderr?.on('data', (c) => { log += c.toString(); });
  let exited = false;
  proc.on('exit', (code, signal) => { exited = true; console.log(`electron exited code=${code} signal=${signal}`); });

  let info = null;
  try {
    for (let i = 0; i < 150; i++) {
      if (exited) break;
      if (fs.existsSync(TOKEN_FILE)) {
        const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        try {
          const res = await get('/api/engine', token);
          if (res.status === 200 && res.body.service === 'nexus-bot-studio-engine') { info = res.body; break; }
        } catch { /* engine not up yet */ }
      }
      await sleep(200);
    }
  } finally {
    // Stop the engine first (it is a child of Electron on the same loopback port), then Electron.
    if (info?.pid) { try { process.kill(info.pid); } catch { /* already gone */ } }
    try { proc.kill(); } catch { /* already gone */ }
  }

  const ok = {
    'Electron process stayed alive during boot': !exited,
    'main process started isolated engine': Boolean(info),
    'engine identity correct': info?.service === 'nexus-bot-studio-engine',
    'token file created in isolated home': fs.existsSync(TOKEN_FILE),
    'no fatal renderer/main error in log': !/Uncaught Exception|ERR_MODULE_NOT_FOUND|Cannot find module|Error occurred in handler|ECONNREFUSED/i.test(log),
  };
  for (const [name, pass] of Object.entries(ok)) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (log.trim()) console.log(`\n--- electron log (first 1200 chars) ---\n${log.slice(0, 1200)}`);
  if (info) console.log(`engine: version=${info.version} pid=${info.pid} relay_home=${info.relay_home}`);
  const failed = Object.values(ok).filter((v) => !v).length;
  console.log(`\nDESKTOP SMOKE: ${Object.keys(ok).length - failed}/${Object.keys(ok).length} passed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('DESKTOP SMOKE ERROR:', e); process.exitCode = 1; });
