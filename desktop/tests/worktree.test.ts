import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { tempHome } = vi.hoisted(() => {
  const f = require('node:fs') as typeof import('node:fs');
  const o = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  return { tempHome: f.mkdtempSync(p.join(o.tmpdir(), 'nbs-wt-')) };
});

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../electron/config', async () => {
  const p = await import('node:path');
  return {
    DATA_HOME: tempHome,
    RELAY_HOME: p.join(tempHome, 'relay'),
    MCP_CONFIG_DIR: p.join(tempHome, 'mcp'),
    WORKTREE_ROOT: p.join(tempHome, 'worktrees'),
    LOG_DIR: p.join(tempHome, 'logs'),
    STATE_FILE: p.join(tempHome, 'state.json'),
    ENGINE_PORT: 16199,
    DEV_SERVER: 'http://127.0.0.1:5173',
    ensureDirs: () => {},
    generateToken: () => 'test-token',
    engineExecutable: () => '',
    engineEnvironment: () => ({}),
  };
});

import { collectDiffs, createWorktree, mergeToMain, removeWorktree, resetWorktree } from '../electron/orchestrator/worktree';
import type { BotConfig } from '../src/types';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
}

describe('worktree lifecycle and collectDiffs', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('creates isolated worktree, collects committed + unstaged + untracked diffs, merges and cleans up', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nbs-repo-'));
    cleanupDirs.push(repo);

    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf8');
    git(repo, 'add', 'app.ts');
    git(repo, 'commit', '-q', '--no-verify', '-m', 'init');

    const bot: BotConfig = {
      bot_id: 'coder-1',
      display_name: 'Coder',
      engine_type: 'claude',
      role: 'worker',
      system_prompt: '',
      permission_mode: 'auto',
      workspace_mode: 'worktree',
      room: 'room-diff',
      workspace: repo,
      is_supervisor: false,
      status: 'idle',
      color: '#e9a23b',
      created_at: new Date().toISOString(),
    };

    const created = await createWorktree(bot, repo);
    expect(created).not.toBeNull();
    bot.workspace = created!.workspace;
    bot.worktree_branch = created!.branch;
    expect(fs.existsSync(path.join(bot.workspace, 'app.ts'))).toBe(true);

    // 1. Committed change inside bot branch
    fs.writeFileSync(path.join(bot.workspace, 'app.ts'), 'export const a = 10;\nexport const b = 2;\n', 'utf8');
    git(bot.workspace, 'add', 'app.ts');
    git(bot.workspace, '-c', 'user.name=Bot', '-c', 'user.email=bot@example.invalid', 'commit', '-q', '--no-verify', '-m', 'bot change');

    // 2. Untracked new file in bot worktree
    fs.writeFileSync(path.join(bot.workspace, 'new-file.ts'), 'export const created = true;\n', 'utf8');

    const diffs = await collectDiffs(bot, repo);
    expect(diffs.map((d) => d.path).sort()).toEqual(['app.ts', 'new-file.ts']);
    const modified = diffs.find((d) => d.path === 'app.ts')!;
    expect(modified.status).toBe('modified');
    expect(modified.before).toContain('export const a = 1;');
    expect(modified.after).toContain('export const a = 10;');
    expect(modified.patch).toContain('@@');

    const untracked = diffs.find((d) => d.path === 'new-file.ts')!;
    expect(untracked.status).toBe('added');
    expect(untracked.after).toContain('export const created = true;');

    // Reset clears untracked new-file.ts
    const resetRes = await resetWorktree(bot);
    expect(resetRes.ok).toBe(true);
    expect(fs.existsSync(path.join(bot.workspace, 'new-file.ts'))).toBe(false);

    // Merge committed change back into main repo, then remove worktree cleanly
    const mergeRes = await mergeToMain(bot, repo);
    expect(mergeRes.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toContain('export const a = 10;');

    await removeWorktree(bot, repo);
    expect(fs.existsSync(bot.workspace)).toBe(false);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});
