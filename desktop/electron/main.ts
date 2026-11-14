import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from './orchestrator';
import { DEV_SERVER } from './config';
import { StudioWebSocketServer } from './ws';

delete process.env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'win32') app.setAppUserModelId('com.agentbot.app');

let win: BrowserWindow | null = null;
const orchestrator = new Orchestrator();
const wsServer = new StudioWebSocketServer();

function resolveAppIcon(): string | undefined {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.resolve(__dirname, '..', 'build', 'icon.ico'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function send(channel: string, payload: unknown): void {
  if (wsServer.clientCount > 0) {
    wsServer.broadcast(channel, payload);
    return;
  }
  if (win && !win.isDestroyed()) win.webContents.send('studio:event', { channel, payload });
}

async function createWindow(): Promise<void> {
  const icon = resolveAppIcon();
  win = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#0b0d12',
    title: 'Agent Bot',
    ...(icon ? { icon } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  const dev = !app.isPackaged && process.env.NEXUS_BOT_DEV === '1';
  if (dev) await win.loadURL(DEV_SERVER);
  else await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function handlers(): Record<string, (...args: never[]) => Promise<unknown>> {
  const o = orchestrator;
  return {
    getState: async () => o.getState(),
    createRoom: async (name: string, projectPath: string) => o.createRoom(name, projectPath),
    setRoomProject: async (roomId: string, projectPath: string) => { o.setRoomProject(roomId, projectPath); return true; },
    createBot: async (input: never) => o.createBot(input as never),
    deleteBot: async (botId: string) => { await o.deleteBot(botId); return true; },
    reconnectBot: async (botId: string) => o.reconnectBot(botId),
    setBotModel: async (botId: string, model: string) => o.setBotModel(botId, model),
    setSupervisor: async (botId: string) => { await o.setSupervisor(botId); return true; },
    sendMessage: async (room: string, text: string, target: string | null) => o.sendMessage(room, text, target ?? undefined),
    sendDirect: async (botId: string, text: string, room: string) => o.sendDirect(botId, text, room),
    emergencyStop: async (active: boolean) => { await o.emergencyStop(active); return true; },
    respondApproval: async (id: string, approved: boolean, reason: string | null) => { await o.respondApproval(id, approved, reason ?? undefined); return true; },
    resolveHopPause: async (id: string, resume: boolean) => { o.resolveHopPause(id, resume); return true; },
    releaseLock: async (id: string) => { await o.releaseLock(id); return true; },
    searchMessages: async (query: string, room: string | null, limit: number | null) =>
      o.searchMessages(query, room ?? undefined, undefined, limit ?? 25),
    wsEndpoint: async () => wsServer.url,
    getDiffs: async (botId: string) => o.getDiffs(botId),
    worktreeStatus: async (botId: string) => o.worktreeStatus(botId),
    mergeWorktree: async (botId: string) => o.mergeWorktree(botId),
    resetWorktree: async (botId: string) => o.resetWorktree(botId),
    setMaxHops: async (value: number) => { o.setMaxHops(value); return true; },
    setSpawnEnabled: async (enabled: boolean) => { o.setSpawnEnabled(enabled); return true; },
    health: async () => o.health(),
    quotas: async () => o.quotas(),
    dataHome: async () => o.dataHome,
    openPath: async (target: string) => { await shell.openPath(target); return true; },
    pickProject: async () => {
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目根目录' });
      return result.canceled ? null : result.filePaths[0];
    },
  } as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await wsServer.start();
    for (const [name, fn] of Object.entries(handlers())) {
      ipcMain.handle(`studio:${name}`, (_event, ...args: unknown[]) =>
        (fn as (...a: unknown[]) => Promise<unknown>)(...args));
    }
    orchestrator.setEmitter(send);
    await createWindow();
    try {
      await orchestrator.init();
    } catch (e) {
      send('error', { message: `引擎启动失败：${(e as Error).message}` });
    }
  });
}

app.on('before-quit', () => {
  void wsServer.stop();
  void orchestrator.dispose();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
