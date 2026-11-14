// Launch the desktop app with a clean Electron environment. Some Electron-based hosts export
// ELECTRON_RUN_AS_NODE=1 into every child process; inherited, it makes electron.exe behave like
// plain node and require('electron') returns a path string instead of the main-process API.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(exe)) {
  console.error(`Electron runtime not found: ${exe}\nRun: npm install`);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, ['.', ...process.argv.slice(2)], {
  cwd: dir,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => { console.error(err); process.exit(1); });
