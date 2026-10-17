// Starts the API server (tsx watch) and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '-w', 'server'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev', '-w', 'web'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
];

// Same port sources as the server (ASF_PORT) and web/vite.config.ts (ASF_WEB_PORT): environment, then the root .env.
const envFile = path.join(root, '.env');
const fileEnv = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((line) => /^\s*(ASF_[A-Z_]+)\s*=\s*(.*)$/.exec(line))
    .filter(Boolean).map((match) => [match[1], match[2].trim()]))
  : {};
const setting = (name, fallback) => process.env[name] ?? fileEnv[name] ?? fallback;
console.log(`\nAI Software Factory Studio — dashboard: http://127.0.0.1:${setting('ASF_WEB_PORT', 5317)}  (API: http://127.0.0.1:${setting('ASF_PORT', 4317)})\n`);

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) stop(); });
