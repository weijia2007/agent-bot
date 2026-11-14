import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ENGINE_MODELS, type EngineCatalogEntry, type EngineModelCatalog, type ModelOption } from '../src/types';

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
  const homes = candidateUserHomes();
  const roots = Array.from(new Set(homes.flatMap((h) => [
    path.join(h, 'AppData', 'Local', 'Claude-3p', 'claude-code'),
    path.join(h, '.rec', 'claude'),
  ])));
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

let cachedPoolBrains: { at: number; dirs: string[] } | null = null;

function discoverPoolBrainDirs(): string[] {
  const now = Date.now();
  if (cachedPoolBrains && now - cachedPoolBrains.at < 15_000) return cachedPoolBrains.dirs;
  const found: string[] = [];
  const searchRoots = [path.join(os.homedir(), 'Documents', 'Codex')];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'antigravity-pool') {
        try {
          for (const acct of fs.readdirSync(full, { withFileTypes: true })) {
            if (!acct.isDirectory()) continue;
            const brain = path.join(full, acct.name, 'home', '.gemini', 'antigravity', 'brain');
            if (fs.existsSync(brain)) found.push(path.resolve(brain));
          }
        } catch { /* ignore unreadable pool root */ }
      } else {
        walk(full, depth + 1);
      }
    }
  };
  searchRoots.forEach((r) => walk(r, 0));
  cachedPoolBrains = { at: now, dirs: found };
  return found;
}

/** Returns all candidate Antigravity brain directories, supporting both default ~/.gemini and antigravity-pool accounts. */
export function brainDirs(primary = brainDir()): string[] {
  const dirs: string[] = [];
  const push = (dir?: string): void => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  push(process.env.NEXUS_BOT_BRAIN_DIR);
  push(primary);
  if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'brain'));
  for (const poolBrain of discoverPoolBrainDirs()) push(poolBrain);
  return dirs;
}

/** Locates transcript.jsonl for a conversationId across default and pool account brain roots. */
export function findTranscriptFile(conversationId: string, primaryRoot?: string): string {
  const rel = path.join(conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const roots = brainDirs(primaryRoot ?? brainDir());
  for (const root of roots) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return file;
  }
  for (const root of roots) {
    if (fs.existsSync(path.join(root, conversationId))) return path.join(root, rel);
  }
  return path.join(primaryRoot ?? brainDir(), rel);
}

export interface DiscoverCatalogOptions {
  force?: boolean;
  /** Optional home directory overrides (used by tests to avoid reading the host user's ~/.codex / ~/.claude). */
  homes?: string[];
  /** Skip spawning local CLIs during unit tests. */
  skipCliProbe?: boolean;
}

const CATALOG_CACHE_TTL_MS = 60_000;
let cachedCatalog: { at: number; catalog: EngineModelCatalog } | null = null;

function candidateUserHomes(overrideHomes?: string[]): string[] {
  if (overrideHomes && overrideHomes.length > 0) {
    return Array.from(new Set(overrideHomes.map((h) => path.resolve(h))));
  }
  const homes: string[] = [];
  const push = (dir?: string): void => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!homes.includes(resolved)) homes.push(resolved);
  };
  push(os.homedir());
  push(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    push(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH));
  }
  return homes;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Reads only top-level `model` and `model_reasoning_effort` keys from Codex config.toml (never API keys/secrets). */
function readCodexTomlConfig(file: string): { model?: string; effort?: string } {
  try {
    if (!fs.existsSync(file)) return {};
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    let model: string | undefined;
    let effort: string | undefined;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[')) break; // Stop at first TOML table header
      const modelMatch = trimmed.match(/^model\s*=\s*"([^"]+)"/) ?? trimmed.match(/^model\s*=\s*'([^']+)'/);
      if (modelMatch) model = modelMatch[1].trim();
      const effortMatch = trimmed.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/)
        ?? trimmed.match(/^model_reasoning_effort\s*=\s*'([^']+)'/);
      if (effortMatch) effort = effortMatch[1].trim();
    }
    return { model, effort };
  } catch {
    return {};
  }
}

async function execHelpOutput(exe: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      windowsHide: true,
      timeout: 2500,
      maxBuffer: 512 * 1024,
    });
    return `${stdout ?? ''}\n${stderr ?? ''}`;
  } catch {
    return null;
  }
}

function discoverCodexCatalog(homes: string[], usesCustomHomes: boolean): EngineCatalogEntry {
  const dirs: string[] = [];
  if (!usesCustomHomes && process.env.CODEX_HOME) dirs.push(path.resolve(process.env.CODEX_HOME));
  for (const h of homes) {
    const d = path.join(h, '.codex');
    if (!dirs.includes(d)) dirs.push(d);
  }

  let defaultModel: string | undefined;
  let defaultEffort: string | undefined;
  const discoveredModels: ModelOption[] = [];
  const sources: string[] = [];

  for (const dir of dirs) {
    if (!defaultModel && !defaultEffort) {
      const tomlPath = path.join(dir, 'config.toml');
      if (fs.existsSync(tomlPath)) {
        const cfg = readCodexTomlConfig(tomlPath);
        defaultModel = cfg.model;
        defaultEffort = cfg.effort;
        if (cfg.model || cfg.effort) sources.push(tomlPath);
      }
    }
    if (discoveredModels.length === 0) {
      const cachePath = path.join(dir, 'models_cache.json');
      const cache = readJsonSafe(cachePath);
      if (cache && Array.isArray(cache.models)) {
        sources.push(cachePath);
        const rawList = cache.models
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
          .filter((item) => item.visibility !== 'hide')
          .sort((a, b) => {
            const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
            const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
            return pa - pb;
          });
        for (const item of rawList) {
          const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
          if (!slug) continue;
          const label = typeof item.display_name === 'string' && item.display_name.trim()
            ? item.display_name.trim()
            : slug;
          const description = typeof item.description === 'string' && item.description.trim()
            ? item.description.trim()
            : undefined;
          const defEffort = typeof item.default_reasoning_level === 'string' && item.default_reasoning_level.trim()
            ? item.default_reasoning_level.trim()
            : undefined;
          const efforts = Array.isArray(item.supported_reasoning_levels)
            ? item.supported_reasoning_levels
              .map((lvl) => (lvl && typeof lvl === 'object' && typeof (lvl as Record<string, unknown>).effort === 'string')
                ? ((lvl as Record<string, unknown>).effort as string).trim()
                : '')
              .filter(Boolean)
            : undefined;
          discoveredModels.push({
            id: slug,
            label,
            description,
            defaultEffort: defEffort,
            efforts: efforts && efforts.length > 0 ? efforts : undefined,
            source: 'discovered',
          });
        }
      }
    }
  }

  const baseModels = discoveredModels.length > 0
    ? discoveredModels
    : ENGINE_MODELS.codex.filter((m) => m.id !== '');

  const models = baseModels.map((m) => ({ ...m }));
  if (defaultModel && !models.some((m) => m.id.toLowerCase() === defaultModel!.toLowerCase())) {
    models.push({
      id: defaultModel,
      label: defaultModel,
      description: '来自本地 config.toml 默认配置',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'configured',
    });
  }

  const matchedDefault = defaultModel
    ? models.find((m) => m.id.toLowerCase() === defaultModel!.toLowerCase())
    : undefined;
  const allEfforts = Array.from(new Set(models.flatMap((m) => m.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])));
  const defaultOption: ModelOption = {
    id: '',
    label: defaultModel ? `默认模型 (${matchedDefault?.label ?? defaultModel})` : '默认模型',
    description: defaultEffort ? `当前本地 config.toml 默认强度：${defaultEffort}` : '使用 ~/.codex/config.toml 默认设置',
    defaultEffort: defaultEffort ?? matchedDefault?.defaultEffort,
    efforts: matchedDefault?.efforts ?? allEfforts,
    source: defaultModel ? 'configured' : 'preset',
  };

  return {
    models: [defaultOption, ...models],
    defaultModel,
    defaultEffort,
    supportsEffort: true,
    effortNote: '通过 --model 与 model_reasoning_effort 精准传入 Codex（按所选模型自动对齐支持等级）。',
    discoveredAt: new Date().toISOString(),
    sources: sources.length > 0 ? sources : ['preset'],
  };
}

function parseClaudeHelp(helpText: string | null): { aliases: string[]; efforts: string[] } {
  const defaultEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (!helpText) return { aliases: [], efforts: defaultEfforts };

  let efforts = defaultEfforts;
  const effortLine = helpText.match(/--effort\s+<level>[\s\S]{0,180}?\(([^)]+)\)/i);
  if (effortLine) {
    const parsed = effortLine[1]
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[a-z0-9_-]+$/.test(s));
    if (parsed.length > 0) efforts = parsed;
  }

  const aliases: string[] = [];
  const modelLine = helpText.match(/--model\s+<model>[\s\S]{0,240}/i);
  if (modelLine) {
    for (const m of modelLine[0].matchAll(/'([a-z0-9._-]+)'/gi)) {
      const alias = m[1].trim();
      if (alias && !aliases.includes(alias)) aliases.push(alias);
    }
  }
  return { aliases, efforts };
}

async function discoverClaudeCatalog(homes: string[], usesCustomHomes: boolean, skipCliProbe: boolean): Promise<EngineCatalogEntry> {
  const sources: string[] = [];
  let cliHelp: string | null = null;
  if (!skipCliProbe) {
    const claudeExe = findClaudeExe();
    if (claudeExe) {
      cliHelp = await execHelpOutput(claudeExe, ['--help']);
      if (cliHelp) sources.push(claudeExe);
    }
  }
  const { aliases: cliAliases, efforts } = parseClaudeHelp(cliHelp);

  const presetMap = new Map<string, ModelOption>();
  for (const m of ENGINE_MODELS.claude) {
    if (m.id) presetMap.set(m.id.toLowerCase(), { ...m, efforts });
  }

  const discovered = new Map<string, ModelOption>();
  const upsert = (opt: ModelOption): void => {
    const key = opt.id.toLowerCase();
    const existing = discovered.get(key);
    if (!existing) {
      discovered.set(key, opt);
      return;
    }
    discovered.set(key, {
      ...existing,
      label: existing.label !== existing.id ? existing.label : opt.label,
      description: existing.description ?? opt.description,
      efforts: opt.efforts ?? existing.efforts,
      source: existing.source === 'discovered' ? 'discovered' : opt.source,
    });
  };

  // Seed official aliases (fable / opus / sonnet / haiku) verified by CLI or presets
  for (const alias of cliAliases) {
    const preset = presetMap.get(alias.toLowerCase());
    upsert({
      id: alias,
      label: preset?.label ?? (alias.charAt(0).toUpperCase() + alias.slice(1)),
      description: preset?.description ?? 'Claude CLI 官方别名',
      efforts,
      source: 'discovered',
    });
  }
  for (const preset of presetMap.values()) {
    upsert({ ...preset, efforts });
  }

  let defaultModel: string | undefined;
  let defaultEffort: string | undefined;

  const claudeDirs: string[] = [];
  if (!usesCustomHomes && process.env.CLAUDE_CONFIG_DIR) {
    claudeDirs.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  }
  for (const h of homes) {
    const d = path.join(h, '.claude');
    if (!claudeDirs.includes(d)) claudeDirs.push(d);
  }

  // Inspect ~/.claude/settings.json for model & effort fields ONLY (never read tokens or secrets)
  for (const dir of claudeDirs) {
    const settingsPath = path.join(dir, 'settings.json');
    const settings = readJsonSafe(settingsPath);
    if (!settings) continue;
    sources.push(settingsPath);
    if (!defaultEffort && typeof settings.effortLevel === 'string' && settings.effortLevel.trim()) {
      defaultEffort = settings.effortLevel.trim();
    }
    if (!defaultModel && typeof settings.model === 'string' && settings.model.trim()) {
      defaultModel = settings.model.trim();
    }
    const envObj = settings.env && typeof settings.env === 'object'
      ? settings.env as Record<string, unknown>
      : null;
    if (envObj) {
      const envModelKeys = [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ] as const;
      for (const k of envModelKeys) {
        const val = typeof envObj[k] === 'string' ? (envObj[k] as string).trim() : '';
        if (!val) continue;
        if (k === 'ANTHROPIC_MODEL' && !defaultModel) defaultModel = val;
        upsert({
          id: val,
          label: val,
          description: k === 'ANTHROPIC_MODEL' ? '来自 settings.json 默认模型' : `来自 settings.json (${k})`,
          efforts,
          source: 'configured',
        });
      }
    }
    if (Array.isArray(settings.availableModels)) {
      for (const item of settings.availableModels) {
        if (typeof item === 'string' && item.trim()) {
          const val = item.trim();
          upsert({ id: val, label: val, description: '来自 settings.json availableModels', efforts, source: 'configured' });
        }
      }
    }
  }

  // Inspect ~/.claude.json for additionalModelOptionsCache (e.g. claude-fable-5-1[1m])
  for (const h of homes) {
    const rcPath = path.join(h, '.claude.json');
    const rc = readJsonSafe(rcPath);
    if (!rc) continue;
    const extra = rc.additionalModelOptionsCache;
    if (Array.isArray(extra)) {
      sources.push(rcPath);
      for (const entry of extra) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const value = typeof rec.value === 'string' ? rec.value.trim() : '';
        if (!value) continue;
        const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : value;
        const description = typeof rec.description === 'string' && rec.description.trim()
          ? rec.description.trim()
          : undefined;
        upsert({ id: value, label, description, efforts, source: 'discovered' });
      }
    }
  }

  const defaultOption: ModelOption = {
    id: '',
    label: defaultModel ? `默认模型 (${defaultModel})` : '默认模型',
    description: defaultEffort ? `当前本地默认强度：${defaultEffort}` : '跟随 ~/.claude/settings.json 默认设置',
    defaultEffort,
    efforts,
    source: defaultModel ? 'configured' : 'preset',
  };

  return {
    models: [defaultOption, ...Array.from(discovered.values())],
    defaultModel,
    defaultEffort,
    supportsEffort: true,
    effortNote: `通过 claude --model 与 --effort（${efforts.join(' / ')}）直接传参控制。`,
    discoveredAt: new Date().toISOString(),
    sources: sources.length > 0 ? sources : ['preset'],
  };
}

function readAntigravityIdeModelHint(homes: string[], usesCustomHomes: boolean): string | undefined {
  const candidates: string[] = [];
  if (!usesCustomHomes) {
    for (const brain of brainDirs()) {
      const antigravityDir = path.dirname(brain);
      candidates.push(path.join(antigravityDir, 'antigravity_state.pbtxt'));
      candidates.push(path.join(path.dirname(antigravityDir), 'antigravity_state.pbtxt'));
    }
  }
  for (const h of homes) {
    candidates.push(path.join(h, '.gemini', 'antigravity_state.pbtxt'));
    candidates.push(path.join(h, '.gemini', 'antigravity', 'antigravity_state.pbtxt'));
  }

  let newestMtime = -1;
  let hint: string | undefined;
  for (const file of Array.from(new Set(candidates))) {
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (stat.mtimeMs < newestMtime) continue;
      const text = fs.readFileSync(file, 'utf-8');
      const match = text.match(/last_selected_agent_model:\s*"?([A-Za-z0-9._-]+)"?/);
      if (match) {
        newestMtime = stat.mtimeMs;
        hint = match[1].trim();
      }
    } catch { /* ignore unreadable pbtxt */ }
  }
  return hint;
}

async function discoverAntigravityCatalog(
  homes: string[],
  usesCustomHomes: boolean,
  skipCliProbe: boolean,
): Promise<EngineCatalogEntry> {
  const sources: string[] = [];
  let cliHelp: string | null = null;
  if (!skipCliProbe) {
    const exe = (await discoverAntigravityTarget())?.agentapiExe ?? findAntigravityExe();
    if (exe) {
      cliHelp = await execHelpOutput(exe, ['agentapi', 'new-conversation', '--help']);
      if (cliHelp) sources.push(exe);
    }
  }

  const ideModelHint = readAntigravityIdeModelHint(homes, usesCustomHomes);
  const presetModels = ENGINE_MODELS.antigravity.filter((m) => m.id !== '');
  const presetById = new Map(presetModels.map((m) => [m.id.toLowerCase(), m]));

  const discoveredTiers: ModelOption[] = [];
  if (cliHelp) {
    const match = cliHelp.match(/--model=<([^>]+)>/i) ?? cliHelp.match(/--model=([a-z0-9_|]+)/i);
    if (match) {
      const tiers = match[1].split('|').map((s) => s.trim()).filter(Boolean);
      for (const id of [...tiers].reverse()) {
        // Reverse `flash_lite|flash|pro` so flagship `pro` stays first, matching preset order if standard
        const preset = presetById.get(id.toLowerCase());
        discoveredTiers.push(preset
          ? { ...preset, source: 'discovered' }
          : { id, label: id, description: `agentapi --model=${id}`, source: 'discovered' });
      }
    }
  }

  const models = discoveredTiers.length > 0 ? discoveredTiers : presetModels;
  const defaultOption: ModelOption = {
    id: '',
    label: '默认（跟随 IDE）',
    description: ideModelHint
      ? `跟随当前 Antigravity IDE 会话模型（检测到 IDE 状态：${ideModelHint}）`
      : '跟随当前 Antigravity IDE 页面选择的模型与 Turbo 档位',
    source: 'preset',
  };

  return {
    models: [defaultOption, ...models],
    ideModelHint,
    supportsEffort: false,
    effortNote: 'Antigravity CLI 仅暴露 Pro / Flash / Flash Lite 三个模型档位，无独立 --effort 参数；选“默认（跟随 IDE）”时会沿用 IDE 中的模型与强度设置。',
    discoveredAt: new Date().toISOString(),
    sources: sources.length > 0 ? sources : ['preset'],
  };
}

/** Auto-discovers installed/configured models & supported reasoning effort levels across Codex, Claude, and Antigravity. */
export async function discoverModelCatalog(options: DiscoverCatalogOptions = {}): Promise<EngineModelCatalog> {
  const usesCustomHomes = Boolean(options.homes && options.homes.length > 0);
  const now = Date.now();
  if (!usesCustomHomes && !options.force && cachedCatalog && now - cachedCatalog.at < CATALOG_CACHE_TTL_MS) {
    return cachedCatalog.catalog;
  }

  const homes = candidateUserHomes(options.homes);
  const skipCliProbe = Boolean(options.skipCliProbe || usesCustomHomes);

  const [claude, antigravity] = await Promise.all([
    discoverClaudeCatalog(homes, usesCustomHomes, skipCliProbe),
    discoverAntigravityCatalog(homes, usesCustomHomes, skipCliProbe),
  ]);
  const codex = discoverCodexCatalog(homes, usesCustomHomes);

  const catalog: EngineModelCatalog = { claude, codex, antigravity };
  if (!usesCustomHomes) {
    cachedCatalog = { at: now, catalog };
  }
  return catalog;
}
