import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads APP_ROOT/.env without touching process-wide or global environment files. */
function loadDotEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

export interface AppConfig {
  host: string;
  port: number;
  authToken: string | null;
  allowedOrigins: string[];
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  worktreesDir: string;
  approvedRoots: string[];
  /** Locations that can never be approved or imported (other tools, system folders, the studio itself). */
  protectedPaths: string[];
  samplesDir: string;
  webDistDir: string;
  /** Environment visible to the studio (dotenv overlaid by process env). Never sent to the client. */
  env: Record<string, string | undefined>;
}

/** Never offered for import: OS folders, other assistants' installations and their configs, and the studio itself. */
function defaultProtectedPaths(): string[] {
  const home = os.homedir();
  const list = [APP_ROOT, path.join(home, '.claude'), path.join(home, '.claude-account2'), path.join(home, '.claude-account3'), path.join(home, '.codex'),
    path.join(home, '.gemini'), path.join(home, 'AppData')];
  if (process.platform === 'win32') {
    list.push('C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData', 'D:/Jarvis', 'D:/AI-Stack');
  } else {
    list.push('/etc', '/usr', '/bin', '/sbin', '/System');
  }
  return list;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = { ...loadDotEnv(path.join(APP_ROOT, '.env')), ...process.env };
  const dataDir = path.resolve(APP_ROOT, overrides.dataDir ?? env.ASF_DATA_DIR ?? './data');
  const roots = (env.ASF_APPROVED_ROOTS ?? '').split(';').map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r));
  const config: AppConfig = {
    host: env.ASF_HOST || '127.0.0.1',
    port: Number(env.ASF_PORT || 4317),
    authToken: env.ASF_AUTH_TOKEN || null,
    allowedOrigins: (env.ASF_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    dataDir,
    dbPath: path.join(dataDir, 'studio.db'),
    workspacesDir: path.join(dataDir, 'workspaces'),
    worktreesDir: path.join(dataDir, 'worktrees'),
    approvedRoots: roots,
    protectedPaths: [...defaultProtectedPaths(), ...(env.ASF_PROTECTED_PATHS ?? '').split(';').map((p) => p.trim()).filter(Boolean)].map((p) => path.resolve(p)),
    samplesDir: path.join(APP_ROOT, 'sample-projects'),
    webDistDir: path.join(APP_ROOT, 'web', 'dist'),
    env,
    ...overrides,
  };
  if (!isLoopback(config.host) && !config.authToken) {
    throw new Error(`Refusing to bind ${config.host}: set ASF_AUTH_TOKEN before enabling remote access.`);
  }
  for (const dir of [config.dataDir, config.workspacesDir, config.worktreesDir]) fs.mkdirSync(dir, { recursive: true });
  return config;
}
