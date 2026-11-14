import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopPkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetExe = path.join(desktopPkgDir, 'release', 'win-unpacked', 'Agent Bot.exe');
const iconPath = path.join(desktopPkgDir, 'release', 'win-unpacked', 'resources', 'icon.ico');

if (!fs.existsSync(targetExe)) {
  throw new Error(`Packaged executable not found: ${targetExe}\nRun "npm run dist" first.`);
}

// Resolve the real interactive Windows Desktop directory (even under redirected USERPROFILE sessions).
const candidates = [
  process.env.NEXUS_BOT_DESKTOP_DIR,
  path.join(os.homedir(), 'Desktop'),
  'C:\\Users\\17839\\Desktop',
].filter(Boolean);
const windowsDesktop = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
  { encoding: 'utf8', windowsHide: true },
).trim();
const desktopDir = [windowsDesktop, ...candidates].find((dir) => dir && fs.existsSync(dir));
if (!desktopDir) throw new Error('Unable to locate Desktop directory');

const shortcutPath = path.join(desktopDir, 'Agent Bot.lnk');
const legacyShortcut = path.join(desktopDir, 'NexusBot Studio.lnk');
if (fs.existsSync(legacyShortcut)) {
  try { fs.unlinkSync(legacyShortcut); } catch { /* ignore if locked */ }
}
const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($env:NBS_SHORTCUT_PATH)
$sc.TargetPath = $env:NBS_TARGET_EXE
$sc.WorkingDirectory = $env:NBS_WORK_DIR
if (Test-Path $env:NBS_ICON_PATH) { $sc.IconLocation = "$env:NBS_ICON_PATH,0" }
$sc.Description = 'Agent Bot - Multi-Agent Desktop'
$sc.Save()
`;

execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
  windowsHide: true,
  env: {
    ...process.env,
    NBS_SHORTCUT_PATH: shortcutPath,
    NBS_TARGET_EXE: targetExe,
    NBS_WORK_DIR: path.dirname(targetExe),
    NBS_ICON_PATH: iconPath,
  },
});

console.log('SHORTCUT_CREATED:', shortcutPath);
console.log('TARGET_EXE:', targetExe);
