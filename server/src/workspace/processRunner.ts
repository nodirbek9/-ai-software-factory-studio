import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const SAFE_ARG = /^[\w@./:=+,%~\\-]+$/;
const MAX_CAPTURE = 2 * 1024 * 1024;

export interface RunOptions {
  cwd: string;
  args?: string[];
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Finds an executable on PATH (honouring Windows extensions) without invoking a shell. */
export function resolveExecutable(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const extensions = IS_WINDOWS ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this PATH entry
      }
    }
  }
  return null;
}

/** Child environment: the user's environment minus the studio's own secrets. */
export function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ASF_')) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Environment names that usually hold credentials (FOO_API_KEY, GITHUB_TOKEN, DB_PASSWORD, …). */
const SECRET_ENV_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)$/i;

/** Environment for project commands (tests, builds): like childEnv(), minus anything that looks like a credential. */
export function commandEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(childEnv()).filter(([key]) => !SECRET_ENV_NAME.test(key)));
}

function killTree(pid: number): void {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/** Batch shims (.cmd/.bat) on Windows need cmd.exe, so their arguments must be metacharacter-free. */
function buildCommand(resolved: string, args: string[]): { file: string; argv: string[]; verbatim: boolean } {
  if (!IS_WINDOWS || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, argv: args, verbatim: false };
  const unsafe = args.find((a) => !SAFE_ARG.test(a));
  if (unsafe !== undefined) throw new Error(`Unsafe argument for batch shim: ${unsafe}`);
  const line = [`"${resolved}"`, ...args].join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** Runs an executable with argv only (no shell). Prompts go through stdin, never the command line. */
export function runProcess(executable: string, options: RunOptions): Promise<RunResult> {
  const resolved = resolveExecutable(executable);
  if (!resolved) return Promise.reject(new Error(`Executable not found on PATH: ${executable}`));
  let command: ReturnType<typeof buildCommand>;
  try {
    command = buildCommand(resolved, options.args ?? []);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command.file, command.argv, {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      detached: !IS_WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = appendCapped(stdout, chunk); options.onOutput?.(chunk, 'stdout'); });
    child.stderr.on('data', (chunk: string) => { stderr = appendCapped(stderr, chunk); options.onOutput?.(chunk, 'stderr'); });

    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, options.timeoutMs)
      : null;
    const onAbort = (): void => { aborted = true; if (child.pid) killTree(child.pid); };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      cleanup();
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut, aborted });
    });
    child.stdin.on('error', () => { /* the process may exit before reading stdin */ });
    child.stdin.end(options.input ?? '');
  });
}
