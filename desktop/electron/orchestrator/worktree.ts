import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WORKTREE_ROOT } from '../config';
import type { BotConfig, DiffEntry } from '../../src/types';

const execFileAsync = promisify(execFile);

async function git<T = string>(cwd: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
  });
  return stdout as T;
}

export function worktreePath(room: string, botId: string): string {
  return path.join(WORKTREE_ROOT, room.replace(/[^a-zA-Z0-9_-]/g, '_'), botId);
}

export function worktreeBranch(room: string, botId: string): string {
  return `nexusbot/${room}/${botId}`.replace(/[^a-zA-Z0-9_/-]/g, '-');
}

/** Mode 1: one git worktree + branch per bot, so parallel bots never overwrite each other.
 *  Returns null when the project is not a git repo (caller falls back to shared + EditGuard). */
export async function createWorktree(bot: BotConfig, projectPath: string): Promise<{ workspace: string; branch: string } | null> {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  try { await git(projectPath, ['rev-parse', '--is-inside-work-tree']); } catch { return null; }
  const destination = worktreePath(bot.room, bot.bot_id);
  const branch = worktreeBranch(bot.room, bot.bot_id);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) {
    try {
      await git(projectPath, ['worktree', 'add', '-b', branch, destination, 'HEAD']);
    } catch (e) {
      // A leftover registration from a previous run: prune and retry once.
      await git(projectPath, ['worktree', 'prune']).catch(() => undefined);
      try { await git(projectPath, ['worktree', 'add', '-b', branch, destination, 'HEAD']); }
      catch { return null; }
    }
  }
  return { workspace: destination, branch };
}

export async function removeWorktree(bot: BotConfig, projectPath: string): Promise<void> {
  if (!bot.worktree_branch || !projectPath) return;
  try { await git(projectPath, ['worktree', 'remove', bot.workspace, '--force']); } catch { /* best effort */ }
  try { await git(projectPath, ['worktree', 'prune']); } catch { /* best effort */ }
  try { await git(projectPath, ['branch', '-D', bot.worktree_branch]); } catch { /* best effort */ }
}

export async function worktreeStatus(bot: BotConfig): Promise<string> {
  try { return await git<string>(bot.workspace, ['status', '--short', '--branch']); }
  catch (e) { return `git status unavailable: ${(e as Error).message}`; }
}

async function resolveDiffBase(root: string, projectPath?: string): Promise<string | null> {
  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const mainHead = (await git<string>(projectPath, ['rev-parse', '--verify', 'HEAD'])).trim();
      if (mainHead) {
        try {
          const base = (await git<string>(root, ['merge-base', 'HEAD', mainHead])).trim();
          if (base) return base;
        } catch {
          return mainHead;
        }
      }
    } catch { /* fallback below */ }
  }
  try {
    return (await git<string>(root, ['rev-parse', '--verify', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** Side-by-side & unified diff data: compares against branch base/HEAD and includes staged + untracked files. */
export async function collectDiffs(bot: BotConfig, projectPath?: string): Promise<DiffEntry[]> {
  const root = bot.workspace_mode === 'worktree' ? bot.workspace : projectPath;
  if (!root || !fs.existsSync(root)) return [];
  try {
    const baseRef = await resolveDiffBase(root, projectPath);
    const changes = new Map<string, DiffEntry['status']>();

    if (baseRef) {
      const nameStatus = await git<string>(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', baseRef, '--']);
      for (const line of nameStatus.split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        const [codeRaw, ...rest] = raw.split('\t');
        const file = rest.at(-1)?.trim();
        if (!file) continue;
        const code = codeRaw?.[0] ?? 'M';
        changes.set(file, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
      }
    } else {
      const cached = await git<string>(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall']);
      for (const line of cached.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (file) changes.set(file, code.includes('D') ? 'deleted' : code.includes('A') || code.includes('?') ? 'added' : 'modified');
      }
    }

    const untracked = await git<string>(root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard']);
    for (const line of untracked.split(/\r?\n/)) {
      const file = line.trim();
      if (file && !changes.has(file)) changes.set(file, 'added');
    }

    const entries: DiffEntry[] = [];
    for (const [file, status] of changes) {
      let patch = '';
      if (baseRef) {
        try { patch = await git<string>(root, ['-c', 'core.quotePath=false', 'diff', baseRef, '--', file]); } catch { /* untracked */ }
      }
      if (!patch && status === 'added') {
        const full = path.join(root, file);
        if (fs.existsSync(full)) {
          try {
            const content = fs.readFileSync(full, 'utf8').slice(0, 200_000);
            const lines = content.split(/\r?\n/);
            patch = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
          } catch { /* binary */ }
        }
      }
      const parts = patch.split(/\r?\n/);
      entries.push({
        path: file,
        status,
        before: parts.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)).join('\n'),
        after: parts.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n'),
        patch: patch.slice(0, 120_000),
      });
      if (entries.length >= 60) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export async function mergeToMain(bot: BotConfig, projectPath: string): Promise<{ ok: boolean; message: string }> {
  if (!bot.worktree_branch) return { ok: false, message: 'This bot has no isolated branch' };
  try {
    await git(projectPath, ['merge', '--no-ff', bot.worktree_branch, '-m', `Merge ${bot.bot_id} work`]);
    return { ok: true, message: `Merged ${bot.worktree_branch} into the main worktree` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function resetWorktree(bot: BotConfig): Promise<{ ok: boolean; message: string }> {
  try {
    await git(bot.workspace, ['reset', '--hard', 'HEAD']);
    await git(bot.workspace, ['clean', '-fd']);
    return { ok: true, message: `${bot.bot_id} worktree reset to HEAD` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
