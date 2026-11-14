import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CodexEntry { nodeExe: string; codexJs: string; version?: string }
export interface AntigravityTarget { exe: string; agentapiExe: string; lsAddress: string; csrfToken: string; pid?: number }

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** The Electron main process runs on Electron's own binary, not a node.exe. Codex is a Node CLI,
 *  so we need a real node.exe to launch app-server without a console window. */
export function findNodeExe(): string | null {
  const override = process.env.NEXUS_BOT_NODE_EXE;
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    path.join('C:\\Program Files\\nodejs', 'node.exe'),
    path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-6', 'node.exe'),
    ...pathDirs().map((dir) => path.join(dir, 'node.exe')),
  ];
  return firstExisting(candidates);
}

/** Claude Code ships a versioned native claude.exe. We pick the newest installed build instead
 *  of hardcoding one version; the user can override with NEXUS_BOT_CLAUDE_EXE. */
export function findClaudeExe(): string | null {
  const override = process.env.NEXUS_BOT_CLAUDE_EXE;
  if (override && fs.existsSync(override)) return override;
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Claude-3p', 'claude-code'),
    path.join(os.homedir(), '.rec', 'claude'),
  ];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.toLowerCase() === 'claude.exe') found.push(full);
    }
  };
  roots.forEach((r) => walk(r, 0));
  found.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  const fromPath = pathDirs()
    .flatMap((dir) => ['claude.exe', 'claude.cmd'].map((n) => path.join(dir, n)))
    .find((p) => fs.existsSync(p));
  return found[0] ?? fromPath ?? null;
}

/** Reads the launcher script to find the real JS entry (D:\Codex\codex.cmd -> codex.js). */
export function findCodexEntry(): CodexEntry | null {
  const nodeExe = findNodeExe();
  if (!nodeExe) return null;
  const override = process.env.NEXUS_BOT_CODEX_JS;
  if (override && fs.existsSync(override)) return { nodeExe, codexJs: override };

  for (const dir of pathDirs()) {
    const cmd = path.join(dir, 'codex.cmd');
    if (!fs.existsSync(cmd)) continue;
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { nodeExe, codexJs: js };
  }
  const fallback = path.join('D:\\Codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(fallback) ? { nodeExe, codexJs: fallback } : null;
}

export function findAntigravityExe(): string | null {
  const override = process.env.NEXUS_BOT_ANTIGRAVITY_EXE;
  if (override && fs.existsSync(override)) return override;
  return firstExisting([
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join('C:\\Program Files', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
  ]);
}

/** Each Antigravity language_server process listens on a pair of loopback ports; exactly one
 *  answers /healthz. The csrf token comes from that process's command line. This mirrors how
 *  the original C# NativeSidecar inherits ANTIGRAVITY_LS_ADDRESS from its sidecar parent. */
export async function discoverAntigravityTarget(): Promise<AntigravityTarget | null> {
  const exe = findAntigravityExe();
  if (!exe) return null;
  if (process.env.NEXUS_BOT_AGENTAPI_LS_ADDRESS && process.env.NEXUS_BOT_AGENTAPI_CSRF_TOKEN) {
    return {
      exe,
      agentapiExe: exe,
      lsAddress: process.env.NEXUS_BOT_AGENTAPI_LS_ADDRESS,
      csrfToken: process.env.NEXUS_BOT_AGENTAPI_CSRF_TOKEN,
    };
  }
  const script = `
$ErrorActionPreference='SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'")
$ids = @($procs | Select-Object -ExpandProperty ProcessId)
$listen = @(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess })
foreach($p in $procs) {
  $token = [regex]::Match($p.CommandLine,'--csrf_token\\s+([0-9a-fA-F-]+)').Groups[1].Value
  foreach($c in ($listen | Where-Object { $_.OwningProcess -eq $p.ProcessId })) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($c.LocalPort)/healthz" -TimeoutSec 1 -UseBasicParsing
      if($r.StatusCode -eq 200) { [pscustomobject]@{ address="127.0.0.1:$($c.LocalPort)"; csrf=$token; pid=$p.ProcessId } | ConvertTo-Json -Compress; exit 0 }
    } catch {}
  }
}
`;
  try {
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
    if (!line) return null;
    const parsed = JSON.parse(line) as { address: string; csrf: string; pid: number };
    if (!parsed.address || !parsed.csrf) return null;
    return { exe, agentapiExe: exe, lsAddress: parsed.address, csrfToken: parsed.csrf, pid: parsed.pid };
  } catch {
    return null;
  }
}

export function brainDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}
