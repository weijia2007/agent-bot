import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from './orchestrator';
import { DEV_SERVER } from './config';
import { StudioWebSocketServer } from './ws';
import { launchDesktop } from './desktop/launch';

delete process.env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'win32') app.setAppUserModelId('com.agentbot.app');

let win: BrowserWindow | null = null;
let quitting = false;
let initialization: Promise<void> = Promise.resolve();
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
    stopBot: async (botId: string) => o.stopBot(botId),
    reconnectBot: async (botId: string) => o.reconnectBot(botId),
    setBotModel: async (botId: string, model: string, reasoningEffort?: string) => o.setBotModel(botId, model, reasoningEffort),
    listModels: async (refresh?: boolean) => o.listModels(Boolean(refresh)),
    listDesktopSessions: async (engine: never) => o.listDesktopSessions(engine),
    listDesktopTargets: async () => o.listDesktopTargets(),
    launchDesktop: async (engine: never, roomId: string) => launchDesktop(engine, o.getState().rooms.find(r => r.id === roomId)?.project_path),
    setBotPermission: async (id: string, mode: never) => o.setBotPermission(id, mode),
    setSupervisor: async (botId: string) => { await o.setSupervisor(botId); return true; },
    sendMessage: async (room: string, text: string, target: string | null, attachments?: string[]) => o.sendMessage(room, text, target ?? undefined, attachments),
    sendDirect: async (botId: string, text: string, room: string, attachments?: string[]) => o.sendDirect(botId, text, room, attachments),
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
    openHelp: async () => {
      const file = app.isPackaged ? path.join(process.resourcesPath, 'README.zh-CN.md') : path.resolve(__dirname, '../../README.md');
      const error = await shell.openPath(file); if (error) throw new Error(error); return true;
    },
    openPath: async (target: string) => { await shell.openPath(target); return true; },
    openSession: async (botId: string) => {
      const bot = o.getState().bots.find(b => b.bot_id === botId);
      if (!bot?.external_session_id) throw new Error('尚未绑定真实对话');
      if (bot.engine_type === 'codex') await shell.openExternal(`codex://threads/${encodeURIComponent(bot.external_session_id)}`);
      else throw new Error('请在原 Agent 的任务历史中打开绑定的会话 ID：' + bot.external_session_id);
      return true;
    },
    openCodexConversation: async (id: string) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效会话 ID');
      await shell.openExternal(`codex://threads/${id}`); return true;
    },
    pickAttachments: async () => {
      if (!win) return [];
      const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '上传任务文件 / 截图' });
      return result.canceled ? [] : result.filePaths.slice(0, 8);
    },
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
      ipcMain.handle(`studio:${name}`, async (_event, ...args: unknown[]) => {
        // No task can enter an uninitialized scheduler while the engine is still starting.
        if (!['wsEndpoint', 'pickProject', 'pickAttachments', 'openPath', 'listDesktopSessions', 'listDesktopTargets', 'listModels'].includes(name)) await initialization;
        return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      });
    }
    orchestrator.setEmitter(send);
    initialization = orchestrator.init();
    // Attach a rejection handler immediately, even if loading the renderer takes longer.
    void initialization.catch(() => undefined);
    await createWindow();
    try {
      await initialization;
    } catch (e) {
      send('error', { message: `引擎启动失败：${(e as Error).message}` });
    }
  });
}

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
});
app.on('will-quit', (event) => {
  if (!quitting) return;
  event.preventDefault(); quitting = false;
  void Promise.allSettled([wsServer.stop(), orchestrator.dispose()]).then(() => app.exit(0));
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
