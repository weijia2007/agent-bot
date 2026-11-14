import { shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeExe, findAntigravityExe } from '../discovery';
import type { EngineType } from '../../src/types';

/** These launchers only open the original desktop; they never run a terminal inference session. */
export async function launchDesktop(engine: EngineType, workspace?: string): Promise<void> {
  if (!['claude', 'codex', 'antigravity'].includes(engine)) throw new Error('未知的 Agent 类型');
  const cwd = workspace && fs.existsSync(workspace) && fs.statSync(workspace).isDirectory() ? workspace : os.homedir();
  if (engine === 'codex') { await shell.openExternal('codex://'); return; }
  if (engine === 'claude') {
    const exe = findClaudeExe(); if (!exe) throw new Error('未找到 Claude 安装，请先打开原 Claude 桌面应用');
    // Anthropic's --desktop exits after handing the directory to Desktop and accepts no prompt.
    await promisify(execFile)(exe, ['--desktop'], { cwd, windowsHide: true, timeout: 20_000 }); return;
  }
  const server = findAntigravityExe();
  const exe = server ? path.join(path.dirname(path.dirname(path.dirname(server))), 'Antigravity.exe') : '';
  if (!exe || !fs.existsSync(exe)) throw new Error('未找到反重力桌面安装');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, [cwd], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
