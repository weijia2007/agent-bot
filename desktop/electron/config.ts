import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

/** Everything the desktop client owns lives here. The original NexusRelay keeps ~/.nexus/relay
 *  and port 16181; we never read or write either. */
export const DATA_HOME = process.env.NEXUS_BOT_DATA_HOME ? path.resolve(process.env.NEXUS_BOT_DATA_HOME) : path.join(os.homedir(), '.nexus-bot-studio');
export const RELAY_HOME = path.join(DATA_HOME, 'relay');
export const MCP_CONFIG_DIR = path.join(DATA_HOME, 'mcp-configs');
export const WORKTREE_ROOT = path.join(DATA_HOME, 'worktrees');
export const LOG_DIR = path.join(DATA_HOME, 'logs');
export const STATE_FILE = path.join(DATA_HOME, 'studio-state.json');
const configuredPort = Number(process.env.NEXUS_BOT_ENGINE_PORT ?? '16191');
export const ENGINE_PORT = Number.isInteger(configuredPort) && configuredPort > 1024 && configuredPort < 65536 && configuredPort !== 16181 ? configuredPort : 16191;
export const DEV_SERVER = 'http://127.0.0.1:5173';

export function ensureDirs(): void {
  for (const dir of [DATA_HOME, RELAY_HOME, MCP_CONFIG_DIR, WORKTREE_ROOT, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** A fresh 256-bit token per launch; it is never persisted and only the engine child and the
 *  per-bot MCP config files (created in the isolated data home) ever see it. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** The AOT engine binary is shipped in extraResources/engine. During development we also accept
 *  a plain Release publish folder, so `npm start` works before a package is built. */
export function engineExecutable(): string {
  const packaged = app.isPackaged
    ? path.join(process.resourcesPath, 'engine', 'NexusRelay.exe')
    : '';
  const candidates = [
    packaged,
    path.resolve(__dirname, '../../engine/publish/NexusRelay.exe'),
    path.resolve(__dirname, '../../engine/native/bin/Release/net10.0-windows/win-x64/publish/NexusRelay.exe'),
    path.resolve(__dirname, '../../engine/native/bin/Release/net10.0-windows/NexusRelay.exe'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `NexusBot Studio engine binary not found. Expected one of:\n${candidates.join('\n')}\n` +
        'Run scripts/build-engine.ps1 first.',
    );
  }
  return found;
}

export function engineEnvironment(token: string, maxHops: number, spawnEnabled: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXUS_RELAY_HOME: RELAY_HOME,
    // Antigravity transcripts are read from the user's real Antigravity data (read-only).
    NEXUS_RELAY_GEMINI_HOME: path.join(os.homedir(), '.gemini'),
    NEXUS_BOT_PORT: String(ENGINE_PORT),
    NEXUS_MCP_TOKEN: token,
    NEXUS_RELAY_HOST: 'all',
    NEXUS_BOT_ALLOW_PEER_SEND: '1',
    NEXUS_BOT_SPAWN_ENABLED: spawnEnabled ? '1' : '0',
    NEXUS_BOT_MAX_HOPS: String(maxHops),
    NEXUS_RELAY_UPDATE_CHECK: '0',
  };
}

export function mcpUrl(botId: string): string {
  return `http://127.0.0.1:${ENGINE_PORT}/mcp?bot=${encodeURIComponent(botId)}`;
}
