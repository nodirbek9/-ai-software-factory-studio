import type { TestResult } from '@asf/shared';
import { redact } from '../security/redact.ts';
import { runProcess } from './processRunner.ts';

/** Commands the QA agent may run without an approval. Exact argv match after whitespace split. */
export const ALLOWED_COMMANDS: readonly string[] = [
  'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm ci', 'npm install',
  'npx vitest run', 'node --test', 'pnpm test', 'yarn test',
  'mvn test', 'mvn -q test', 'mvn verify', 'gradle test', 'mvnw test', 'gradlew test',
  'python -m pytest', 'pytest', 'go test ./...', 'cargo test',
];

const SAFE_TOKEN = /^[\w@./:=+-]+$/;
const OUTPUT_TAIL = 6000;

export class CommandNotAllowedError extends Error {}

export function parseCommand(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new CommandNotAllowedError('Empty command');
  const unsafe = tokens.find((t) => !SAFE_TOKEN.test(t));
  if (unsafe) throw new CommandNotAllowedError(`Command contains a forbidden token: ${unsafe}`);
  return tokens;
}

export function isAllowedCommand(command: string): boolean {
  try {
    const normalized = parseCommand(command).join(' ');
    return ALLOWED_COMMANDS.includes(normalized);
  } catch {
    return false;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
const DIGEST_MAX = 3000;

/**
 * The lines that say what failed (FAIL headers with their first error line, npm workspace failures),
 * pulled from the whole output so they survive when the tail is filled with a rendered DOM dump.
 */
export function failureDigest(output: string): string {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const picked: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*FAIL\s/.test(line)) picked.push(line.trim(), ...lines.slice(i + 1, i + 3).map((l) => `  ${l.trim()}`));
    else if (/^\s*(×|✗)\s/.test(line) || /npm (error|ERR!) (workspace|location) /.test(line)) picked.push(line.trim());
  });
  return [...new Set(picked)].join('\n').slice(0, DIGEST_MAX);
}

/** Summarises common test runner output (node --test, vitest, jest, maven surefire). */
export function summarizeTestOutput(raw: string): string {
  const output = raw.replace(ANSI, '');
  // npm workspaces print one summary per package: report every one, failures first.
  const vitestAll = [...output.matchAll(/^\s*Tests\s+([^\n]*(?:passed|failed)[^\n]*)/gm)].map((m) => m[1].trim());
  if (vitestAll.length > 1) return [...vitestAll.filter((l) => /failed/.test(l)), ...vitestAll.filter((l) => !/failed/.test(l))].join('; ');
  const nodeTest = /[#ℹ] pass (\d+)[\s\S]*?[#ℹ] fail (\d+)/.exec(output);
  if (nodeTest) return `${nodeTest[1]} passed, ${nodeTest[2]} failed`;
  const vitest = /Tests\s+([^\n]*(?:passed|failed)[^\n]*)/.exec(output);
  if (vitest) return vitest[1].trim();
  const maven = /Tests run: (\d+), Failures: (\d+), Errors: (\d+)/.exec(output);
  if (maven) return `${maven[1]} run, ${maven[2]} failures, ${maven[3]} errors`;
  const mocha = /(\d+ passing[^\n]*)/.exec(output);
  return mocha ? mocha[1] : 'see output';
}

export async function runAllowedCommand(command: string, cwd: string, options: { signal?: AbortSignal; timeoutMs: number; approved?: boolean;
  onOutput?: (chunk: string) => void }): Promise<TestResult> {
  if (!options.approved && !isAllowedCommand(command)) throw new CommandNotAllowedError(`Command is not in the allowlist: ${command}`);
  const [exe, ...args] = parseCommand(command);
  const result = await runProcess(exe, { cwd, args, signal: options.signal, timeoutMs: options.timeoutMs, onOutput: (c) => options.onOutput?.(c) });
  const output = redact(`${result.stdout}\n${result.stderr}`.trim());
  const passed = result.exitCode === 0 && !result.timedOut && !result.aborted;
  const digest = passed ? '' : failureDigest(output);
  let summary = summarizeTestOutput(output);
  if (result.timedOut) summary = `timed out after ${Math.round(options.timeoutMs / 1000)}s`;
  if (result.aborted) summary = 'cancelled';
  return {
    command, exitCode: result.exitCode, passed, durationMs: result.durationMs,
    outputTail: digest ? `What failed:\n${digest}\n\n--- output tail ---\n${output.slice(-OUTPUT_TAIL)}` : output.slice(-OUTPUT_TAIL), summary,
  };
}
