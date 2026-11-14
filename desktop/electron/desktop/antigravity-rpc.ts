import http2 from 'node:http2';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { findAntigravityExe } from '../discovery';
import type { DesktopSession, ModelOption } from '../../src/types';

const exec = promisify(execFile);
export interface GravityTarget { pid: number; port: number; csrf: string; account: string }
let cached: { at: number; targets: GravityTarget[] } | undefined;
export type Json = Record<string, any>;

/** The desktop's loopback ConnectRPC service. No provider API or gateway key is involved. */
export async function gravityCall(target: GravityTarget, method: string, data: Json | Buffer = {}, streaming = false): Promise<Json> {
  if (!/^[A-Za-z]+$/.test(method)) throw new Error('Invalid desktop method');
  const session = http2.connect(`https://127.0.0.1:${target.port}`, { servername: 'localhost', rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: http2.ClientHttp2Stream;
    const finish = (error?: Error, value: Json = {}): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); request?.close(); session.destroy();
      error ? reject(error) : resolve(value);
    };
    let status = 0;
    const timer = setTimeout(() => {
      // Desktop SendUserCascadeMessage uses an unframed protobuf body and holds the response
      // open. HTTP acceptance is followed by trajectory polling, never inference replay.
      if (streaming && status === 200) finish();
      else finish(new Error(`${method}: desktop response uncertain; not replayed`));
    }, 12_000);
    session.on('error', e => finish(e));
    const binary = Buffer.isBuffer(data);
    const payload = binary ? data : Buffer.from(JSON.stringify(data));
    request = session.request({ ':method': 'POST', ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
      'content-type': binary ? 'application/proto' : 'application/json',
      'connect-protocol-version': '1', 'x-codeium-csrf-token': target.csrf });
    const chunks: Buffer[] = [];
    request.on('response', headers => { status = Number(headers[':status']); });
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('error', error => finish(error));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (status !== 200) return finish(new Error(`${method}: HTTP ${status}: ${body.toString().slice(0, 200)}`));
      if (streaming) {
        return finish();
      }
      try { finish(undefined, binary ? { bytes: body } : JSON.parse(body.toString() || '{}')); } catch (e) { finish(e as Error); }
    });
    request.end(payload);
  });
}

export async function gravityTargets(force = false): Promise<GravityTarget[]> {
  if (!force && cached && Date.now() - cached.at < 15_000) return cached.targets;
  const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter "Name='language_server.exe' OR Name='language_server_windows_x64.exe'"); $ids=@($p.ProcessId); $c=@(Get-NetTCPConnection -State Listen | Where-Object {$ids -contains $_.OwningProcess -and $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::')}); @($p | ForEach-Object { $m=[regex]::Match($_.CommandLine,'--csrf_token[=\\s]+([^\\s"]+)'); if($m.Success -and $_.CommandLine -notmatch '--enable_lsp'){[pscustomobject]@{pid=$_.ProcessId;csrf=$m.Groups[1].Value;ports=@($c|Where-Object OwningProcess -eq $_.ProcessId|Select-Object -ExpandProperty LocalPort)}} }) | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
  const raw = JSON.parse(stdout.trim() || '[]');
  const processes = Array.isArray(raw) ? raw : [raw];
  const found = await Promise.all(processes.map(async (process): Promise<GravityTarget | null> => {
    for (const port of [...new Set<number>(process.ports ?? [])]) {
      const target: GravityTarget = { pid: process.pid, port, csrf: process.csrf, account: `桌面进程 ${process.pid}` };
      try {
        const data = await gravityCall(target, 'GetUserStatus');
        if (!data.userStatus?.cascadeModelConfigData) continue;
        // Account email and credentials never cross into the renderer or repository.
        return target;
      } catch { /* Probe only; no inference or mutation. */ }
    }
    return null;
  }));
  const targets = found.filter((t): t is GravityTarget => !!t).sort((a, b) => a.pid - b.pid);
  targets.forEach((target, i) => { target.account = `反重力桌面 ${i + 1}`; });
  cached = { at: Date.now(), targets };
  return targets;
}

const enumValues = new Map<string, number>();
export function gravityModelNumber(name: string | number): number {
  if (typeof name === 'number' && Number.isInteger(name) && name > 0) return name;
  const key = String(name);
  if (!/^MODEL_[A-Z0-9_]+$/.test(key)) throw new Error(`Invalid desktop model enum: ${key}`);
  const known = enumValues.get(key); if (known) return known;
  const exe = findAntigravityExe(); if (!exe) throw new Error('Antigravity desktop language server is not installed');
  const binary = fs.readFileSync(exe), text = Buffer.from(key);
  const prefix = Buffer.concat([Buffer.from([10, text.length]), text, Buffer.from([16])]);
  const values = new Set<number>(); let offset = -1;
  while ((offset = binary.indexOf(prefix, offset + 1)) !== -1) {
    let value = 0, shift = 0, i = offset + prefix.length;
    while (i < binary.length && shift < 35) { const byte = binary[i++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) { values.add(value); break; } shift += 7; }
  }
  if (values.size !== 1) throw new Error(`Installed desktop cannot resolve model ${key}; refresh the model list`);
  const result = [...values][0]; enumValues.set(key, result); return result;
}

function varint(value: number): Buffer { const bytes: number[] = []; do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); }
function field(number: number, value: string | Buffer | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const metadata = Buffer.concat([field(1, 'antigravity'), field(2, '0.2.0'), field(5, 'win32'), field(10, 'agent-bot'), field(12, 'antigravity')]);

export async function gravityCreate(target: GravityTarget, workspaceUri: string): Promise<string> {
  // Unary JSON uses the same protobuf descriptor as the desktop application.
  const result = await gravityCall(target, 'StartCascade', { metadata: { ideName: 'antigravity', extensionName: 'antigravity', extensionVersion: '0.2.0', os: 'win32', sessionId: 'agent-bot' }, source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', workspaceUris: workspaceUri ? [workspaceUri] : [] });
  if (!result.cascadeId) throw new Error('Desktop did not confirm a conversation ID; creation will not be replayed');
  return String(result.cascadeId);
}

export async function gravitySend(target: GravityTarget, id: string, text: string, modelNumber: number, workspaceUri: string): Promise<void> {
  const conversational = Buffer.concat([field(14, 1), ...(workspaceUri ? [field(17, workspaceUri)] : [])]);
  const planner = Buffer.concat([field(2, conversational), field(15, field(1, modelNumber))]);
  const payload = Buffer.concat([field(1, id), field(2, field(1, text)), field(3, metadata), field(5, field(1, planner)), field(11, 1), field(18, 1)]);
  await gravityCall(target, 'SendUserCascadeMessage', payload, true);
}

export async function gravityModels(target?: GravityTarget): Promise<ModelOption[]> {
  const selected = target ?? (await gravityTargets())[0]; if (!selected) return [];
  const data = await gravityCall(selected, 'GetUserStatus');
  return (data.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? []).filter((c: Json) => c.modelOrAlias?.model && c.modelId && !c.disabled && !/-disabled$/.test(c.modelId)).map((c: Json): ModelOption => ({
    id: String(c.modelOrAlias.model), label: String(c.label ?? c.displayName ?? c.modelId), source: 'discovered',
    description: c.quotaInfo?.remainingFraction === 0 ? '该桌面账号当前额度已耗尽' : `反重力桌面模型 · ${c.modelId}`,
  }));
}

export async function gravitySessions(): Promise<DesktopSession[]> {
  const results = await Promise.all((await gravityTargets()).map(async target => {
    const data = await gravityCall(target, 'GetAllCascadeTrajectories');
    return Object.entries(data.trajectorySummaries ?? {}).map(([id, value]): DesktopSession => {
      const info = value as Json;
      return { id, engine: 'antigravity', title: info.summary ?? info.title ?? id, workspace: info.workspaces?.[0]?.workspaceFolderAbsoluteUri ?? '', account: target.account, target_id: String(target.pid), updated_at: info.lastModifiedTime ?? info.createdTime ?? '' };
    });
  }));
  return results.flat();
}
