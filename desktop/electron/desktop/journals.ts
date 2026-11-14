import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { DesktopSession } from '../../src/types';
import type { DesktopObservation } from '../adapters/types';

export const codexHome = (): string => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export function jsonFile(file: string): Record<string, any> | undefined { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } }
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function walk(dir: string, match: (file: string) => boolean, depth = 0): string[] {
  if (depth > 6) return [];
  try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), match, depth + 1) : match(e.name) ? [path.join(dir, e.name)] : []); } catch { return []; }
}

export function listCodexSessions(): DesktopSession[] {
  try {
    const entries = fs.readFileSync(path.join(codexHome(), 'session_index.jsonl'), 'utf8').trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const byId = new Map<string, DesktopSession>();
    for (const e of entries) if (e.id && e.id !== process.env.CODEX_THREAD_ID) byId.set(e.id, { id: e.id, engine: 'codex', title: e.thread_name ?? e.id, workspace: '', updated_at: e.updated_at });
    return [...byId.values()].reverse().slice(0, 100);
  } catch { return []; }
}

export function listClaudeSessions(): DesktopSession[] {
  const dir = path.join(claudeHome(), 'sessions');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(file => {
      const e = jsonFile(path.join(dir, file));
      // A desktop host ID is mandatory. A CLI session in the same registry is not a desktop conversation.
      if (!e?.hostSessionId || !e.sessionId || !e.messagingSocketPath || !alive(Number(e.pid))) return [];
      return [{ id: e.sessionId, engine: 'claude' as const, title: e.name || e.hostSessionId, workspace: e.cwd ?? '', target_id: String(e.pid), updated_at: new Date(e.updatedAt ?? Date.now()).toISOString() }];
    });
  } catch { return []; }
}

export function claudeJournal(id: string): string | undefined {
  return walk(path.join(claudeHome(), 'projects'), f => f === `${id}.jsonl`)[0];
}

/** Reads only appended bytes and retains incomplete UTF-8 and JSON lines between polls. */
export class JournalTail {
  private offset = 0;
  private remainder = '';
  private decoder = new StringDecoder('utf8');
  constructor(readonly file: string) {}
  read(): Record<string, any>[] {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r'); const stat = fs.fstatSync(fd);
      if (stat.size < this.offset) { this.offset = 0; this.remainder = ''; this.decoder = new StringDecoder('utf8'); }
      if (this.offset === 0 && stat.size > 8 * 1024 * 1024) { this.offset = stat.size - 8 * 1024 * 1024; this.remainder = ''; }
      const bytes = Buffer.alloc(Math.min(stat.size - this.offset, 8 * 1024 * 1024));
      const n = fs.readSync(fd, bytes, 0, bytes.length, this.offset); this.offset += n;
      this.remainder += this.decoder.write(bytes.subarray(0, n));
      const lines = this.remainder.split('\n'); this.remainder = lines.pop() ?? '';
      return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } catch { return []; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

export function journalObservations(entry: Record<string, any>, engine: 'codex' | 'claude'): DesktopObservation[] {
  const at = entry.timestamp ?? new Date().toISOString(), out: DesktopObservation[] = [];
  const id = String(entry.uuid ?? entry.payload?.id ?? `${at}:${entry.type}`);
  if (engine === 'claude') {
    if (entry.isSidechain) return [];
    const message = entry.message;
    if ((entry.type === 'assistant' || entry.type === 'user') && message) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
      const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text && !text.includes('[Agent Bot ·')) out.push({ type: 'message', id, role: entry.type === 'user' ? 'user' : 'assistant', text, at });
      for (const block of blocks) {
        if (block.type === 'tool_use') out.push({ type: 'activity', event: { type: 'tool_call_start', tool: String(block.name), args: JSON.stringify(block.input).slice(0, 4000) } });
        if (block.type === 'tool_result') out.push({ type: 'activity', event: { type: 'tool_call_result', tool: String(block.tool_use_id), output: typeof block.content === 'string' ? block.content.slice(0, 8000) : JSON.stringify(block.content).slice(0, 8000), ok: !block.is_error } });
      }
    }
    if (entry.type === 'assistant' && message?.stop_reason === 'end_turn') out.push({ type: 'activity', event: { type: 'turn_completed' } });
    if (entry.type === 'system' && entry.subtype === 'stop_hook_summary' && !entry.preventedContinuation) out.push({ type: 'activity', event: { type: 'turn_completed' } });
    return out;
  }
  const p = entry.payload ?? {};
  if (entry.type === 'response_item') {
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && (!p.channel || p.channel !== 'analysis')) {
      const text = (p.content ?? []).map((b: any) => b.text ?? '').join('');
      if (text && !text.includes('[Agent Bot ·')) out.push({ type: 'message', id, role: p.role, text, at });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') out.push({ type: 'activity', event: { type: 'tool_call_start', tool: String(p.name), args: String(p.arguments ?? p.input ?? '').slice(0, 4000) } });
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') out.push({ type: 'activity', event: { type: 'tool_call_result', tool: String(p.call_id), output: String(p.output ?? '').slice(0, 8000) } });
  }
  if (entry.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_complete')) out.push({ type: 'activity', event: { type: 'turn_completed', summary: p.last_agent_message } });
  if (entry.type === 'event_msg' && p.type === 'turn_aborted') out.push({ type: 'activity', event: { type: 'error', message: '原 Agent 已中断本轮执行' } });
  return out;
}
