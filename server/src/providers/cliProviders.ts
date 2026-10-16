import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../security/redact.ts';
import { childEnv, resolveExecutable, runProcess, type RunResult } from '../workspace/processRunner.ts';
import { looksLikeLimit, parseResetTime, ProviderError, ProviderLimitError, type ProviderAdapter, type ProviderDetection, type ProviderRunRequest, type ProviderRunResult } from './types.ts';

const DETECT_TIMEOUT_MS = 20_000;

async function detectCli(binary: string, env?: Record<string, string | undefined>): Promise<ProviderDetection> {
  if (!resolveExecutable(binary)) return { available: false, version: null, reason: `"${binary}" was not found on PATH` };
  try {
    const result = await runProcess(binary, { cwd: os.tmpdir(), args: ['--version'], timeoutMs: DETECT_TIMEOUT_MS, env });
    if (result.exitCode !== 0) return { available: false, version: null, reason: `"${binary} --version" exited with ${result.exitCode}` };
    return { available: true, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 80), reason: null };
  } catch (error) {
    return { available: false, version: null, reason: (error as Error).message };
  }
}

function failure(label: string, result: RunResult): ProviderError {
  if (result.aborted) return new ProviderError(`${label} run was cancelled`, false);
  if (result.timedOut) return new ProviderError(`${label} timed out`);
  const detail = redact((result.stderr || result.stdout).trim()).slice(-1500);
  return limitOr(label, detail) ?? new ProviderError(`${label} exited with code ${result.exitCode}: ${detail || 'no output'}`);
}

/** A ProviderLimitError when the text says a usage/session/rate limit was hit, otherwise null. */
function limitOr(label: string, text: string): ProviderLimitError | null {
  if (!looksLikeLimit(text)) return null;
  const reset = parseResetTime(text);
  const summary = /You've hit[^"\n]*/.exec(text)?.[0] ?? text.slice(-300);
  return new ProviderLimitError(`${label} hit its usage limit (${summary.trim()}); skipping it until ${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, reset);
}

const STUDIO_GUARD = 'You are running inside AI Software Factory Studio. Work only inside the current directory. '
  + 'Never push, never touch files outside this directory.';

// ------------------------------------------------------------------ Claude Code (any account)

export interface ClaudeAccountOptions {
  id: string;
  label: string;
  /** Claude Code config dir of another login (same mechanism the `claude2` shim uses). Null = default account. */
  defaultConfigDir: string | null;
  accountNumber: number | null;
}

/** Claude Code CLI in headless mode. Tools are limited to file reads/edits; Bash is never granted. */
export class ClaudeCodeProvider implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind = 'cli' as const;
  readonly editsFiles = true;
  readonly isAi = true;
  readonly reportsActivity = true;
  readonly models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku'];
  readonly defaultModel = 'claude-sonnet-5-5';

  constructor(private readonly options: ClaudeAccountOptions = { id: 'claude-code', label: 'Claude Code CLI', defaultConfigDir: null, accountNumber: null }) {
    this.id = options.id;
    this.label = options.label;
  }

  private env(settings: Record<string, string>): Record<string, string | undefined> | undefined {
    const configDir = settings.configDir || this.options.defaultConfigDir;
    if (!configDir) return undefined;
    return childEnv({ CLAUDE_CONFIG_DIR: configDir, ...(this.options.accountNumber ? { CLAUDE_ACCOUNT: String(this.options.accountNumber) } : {}) });
  }

  async detect(settings: Record<string, string> = {}): Promise<ProviderDetection> {
    const configDir = settings.configDir || this.options.defaultConfigDir;
    const loginHint = this.options.accountNumber ? `run "claude${this.options.accountNumber}" once and log in` : 'log in once with that account';
    if (configDir && !fs.existsSync(configDir)) {
      return { available: false, version: null, reason: `Not set up yet: ${configDir} does not exist (${loginHint})` };
    }
    if (configDir && !fs.existsSync(path.join(configDir, '.credentials.json'))) {
      return { available: false, version: null, reason: `Not logged in yet (${loginHint})` };
    }
    const detection = await detectCli('claude', this.env(settings));
    return configDir && detection.available ? { ...detection, version: `${detection.version} — ${path.basename(configDir)}` } : detection;
  }

  async run(request: ProviderRunRequest, settings: Record<string, string> = {}): Promise<ProviderRunResult> {
    const tools = request.mode === 'edit' ? 'Read,Edit,Write,Glob,Grep' : 'Read,Glob,Grep';
    // stream-json lets the dashboard show what the agent is doing (files read/edited) while it works.
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--model', request.model || this.defaultModel,
      '--permission-mode', request.mode === 'edit' ? 'acceptEdits' : 'default',
      '--allowedTools', tools, '--disallowedTools', 'Bash,WebFetch,WebSearch',
      // No setting sources: a repository's .claude/settings*.json could define hooks that run shell commands.
      '--setting-sources', '', '--no-session-persistence',
      ...(request.effort ? ['--effort', request.effort] : []),
      '--append-system-prompt', `${STUDIO_GUARD} Never run shell commands. ${request.systemPrompt}`.replace(/\s+/g, ' '),
    ];
    let pending = '';
    const result = await runProcess('claude', {
      cwd: request.cwd, args, input: request.prompt, timeoutMs: request.timeoutMs, signal: request.signal, env: this.env(settings),
      onOutput: (chunk, stream) => {
        request.onHeartbeat?.();
        if (stream !== 'stdout') return;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const activity = describeClaudeEvent(line, request.cwd);
          if (activity) request.onOutput?.(`${activity}\n`);
        }
      },
    });
    const parsed = findResultEvent(result.stdout);
    if (parsed?.is_error || result.exitCode !== 0) {
      const reported = redact(String(parsed?.result ?? ''));
      if (parsed?.api_error_status === 429 || looksLikeLimit(reported)) throw limitOr(this.label, reported || '429 rate limit')!;
      if (result.exitCode !== 0) throw failure(this.label, result);
    }
    if (!parsed) return { text: result.stdout, usage: null };
    if (parsed.is_error) throw new ProviderError(`${this.label} reported an error: ${redact(String(parsed.result)).slice(0, 1500)}`);
    const u = parsed.usage ?? {};
    return {
      text: parsed.result ?? '',
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        reasoningTokens: u.output_tokens_details?.thinking_tokens
          ?? parsed.modelUsage?.[mainModel(parsed.modelUsage) ?? '']?.thinkingTokens,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      },
      model: mainModel(parsed.modelUsage),
    };
  }
}

interface ClaudeResultEvent {
  type?: string; result?: string; is_error?: boolean; total_cost_usd?: number; api_error_status?: number; modelUsage?: Record<string, { outputTokens?: number; thinkingTokens?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number } };
}

/** The final `result` event of a stream-json run (or a plain json object from older CLIs). */
function findResultEvent(stdout: string): ClaudeResultEvent | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]) as ClaudeResultEvent;
      if (event.type === 'result' || (event.type === undefined && 'result' in event)) return event;
    } catch {
      // not JSON
    }
  }
  return null;
}

const TOOL_VERB: Record<string, string> = { Read: 'Reading', Edit: 'Editing', Write: 'Writing', MultiEdit: 'Editing', Glob: 'Listing', Grep: 'Searching' };

/** Turns one stream-json line into a short human activity line ("Editing src/app.ts"), or null. */
export function describeClaudeEvent(line: string, cwd: string): string | null {
  let event: { type?: string; message?: { content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[] } };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== 'assistant') return null;
  const parts: string[] = [];
  for (const item of event.message?.content ?? []) {
    if (item.type === 'tool_use' && item.name) {
      const target = String(item.input?.file_path ?? item.input?.path ?? item.input?.pattern ?? '');
      const shown = target.startsWith(cwd) ? path.relative(cwd, target) || '.' : target;
      parts.push(`${TOOL_VERB[item.name] ?? item.name} ${shown}`.trim());
    } else if (item.type === 'text' && item.text?.trim()) {
      parts.push(item.text.trim().split(/\r?\n/)[0].slice(0, 200));
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Claude reports every model it touched (it may use a small model for housekeeping); the main one wrote the most. */
function mainModel(usage: Record<string, { outputTokens?: number }> | undefined): string | undefined {
  const entries = Object.entries(usage ?? {});
  if (!entries.length) return undefined;
  return entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0][0];
}

// ------------------------------------------------------------------ OpenAI Codex (GPT)

interface CodexEvent { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  message?: string; error?: { message?: string } }

const CODEX_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

/** OpenAI Codex CLI (`codex exec --json`), sandboxed to the worktree. Uses whatever login the `codex` command has. */
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex';
  readonly label = 'OpenAI Codex CLI (GPT)';
  readonly kind = 'cli' as const;
  readonly editsFiles = true;
  readonly isAi = true;
  readonly reportsActivity = true;
  readonly models = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'];
  readonly defaultModel = 'gpt-6.1-sol';

  detect(): Promise<ProviderDetection> {
    return detectCli('codex');
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', request.mode === 'edit' ? 'workspace-write' : 'read-only'];
    if (request.model && request.model !== 'default') args.push('-m', request.model);
    if (request.effort) args.push('-c', `model_reasoning_effort=${CODEX_EFFORT[request.effort] ?? 'high'}`);
    args.push('-');
    const shellRule = request.mode === 'edit'
      ? 'You may run the project build/test commands inside this sandbox to check your work. Never run git push or destructive git commands.'
      : 'Read-only: do not modify files.';
    let pending = '';
    const result = await runProcess('codex', {
      cwd: request.cwd, args, input: `${STUDIO_GUARD} ${shellRule}\n${request.systemPrompt}\n\n${request.prompt}`,
      timeoutMs: request.timeoutMs, signal: request.signal,
      onOutput: (chunk, stream) => {
        request.onHeartbeat?.();
        if (stream !== 'stdout') return;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const activity = describeCodexEvent(line, request.cwd);
          if (activity) request.onOutput?.(`${activity}
`);
        }
      },
    });
    const events = result.stdout.split(/\r?\n/).flatMap((line): CodexEvent[] => {
      try { return [JSON.parse(line) as CodexEvent]; } catch { return []; }
    });
    const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item!.text ?? '');
    const errors = events.filter((e) => e.type === 'error' || e.type === 'turn.failed').map((e) => e.message || e.error?.message || 'error').join('; ');
    if (result.exitCode !== 0 || errors) {
      if (errors && !result.aborted) throw limitOr(this.label, errors) ?? new ProviderError(`${this.label}: ${redact(errors).slice(0, 1500)}`);
      throw failure(this.label, result);
    }
    const usage = events.find((e) => e.type === 'turn.completed')?.usage;
    return {
      text: messages.join('\n\n').trim(),
      usage: usage ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
        reasoningTokens: usage.reasoning_output_tokens, costUsd: null } : null,
    };
  }
}

interface CodexItemEvent { type?: string; item?: { type?: string; text?: string; command?: string; changes?: { path?: string; kind?: string }[] } }

/** Turns one `codex exec --json` line into a short activity line (file changes, commands, messages), or null. */
export function describeCodexEvent(line: string, cwd: string): string | null {
  let event: CodexItemEvent;
  try {
    event = JSON.parse(line) as CodexItemEvent;
  } catch {
    return null;
  }
  const item = event.item;
  if (!item || (event.type !== 'item.completed' && event.type !== 'item.started')) return null;
  const rel = (p: string): string => (p.startsWith(cwd) ? path.relative(cwd, p) : p);
  if (item.type === 'file_change' && event.type === 'item.completed') {
    return (item.changes ?? []).map((c) => `${c.kind === 'add' ? 'Writing' : c.kind === 'delete' ? 'Deleting' : 'Editing'} ${rel(c.path ?? '')}`).join(' · ') || null;
  }
  if (item.type === 'command_execution' && event.type === 'item.started') return `Running ${String(item.command ?? '').slice(0, 160)}`;
  if (item.type === 'agent_message' && event.type === 'item.completed') return (item.text ?? '').trim().split(/\r?\n/)[0].slice(0, 200) || null;
  return null;
}

// ------------------------------------------------------------------ Antigravity (Gemini, Claude 4.6)

const AGY_INLINE_PROMPT_MAX = 6000;
const AGY_LOG_POLL_MS = 15_000;
export const AGY_TASK_FILE_PREFIX = '.asf-agy-task-';

/**
 * Google Antigravity CLI (`agy`) — Gemini models (and Claude 4.6 on Google quota). It has no shell tool,
 * so tests are always run by the studio. Long prompts go through a temp file to stay under the Windows
 * command-line limit.
 */
export class AntigravityProvider implements ProviderAdapter {
  readonly id = 'antigravity';
  readonly label = 'Antigravity CLI (Gemini)';
  readonly kind = 'cli' as const;
  readonly editsFiles = true;
  readonly isAi = true;
  readonly reportsActivity = true;
  readonly models = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'];
  /** Models reported by `agy models` for this account (filled by detect). */
  private accountModels: string[] | null = null;
  readonly defaultModel = 'gemini-3.8-flash-high';

  async detect(): Promise<ProviderDetection> {
    const detection = await detectCli('agy');
    if (!detection.available) return detection;
    try {
      const list = await runProcess('agy', { cwd: os.tmpdir(), args: ['models'], timeoutMs: DETECT_TIMEOUT_MS });
      const models = list.stdout.split(/\r?\n/).map((line) => line.split('\t')[0].trim()).filter((id) => /^[a-z0-9][\w.-]+$/i.test(id));
      if (models.length) this.accountModels = models;
    } catch {
      // keep the static list when the model list cannot be fetched
    }
    return { ...detection, models: this.accountModels ?? undefined };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const prompt = `${STUDIO_GUARD}\nSHELL: you have NO shell/terminal access — any RunCommand/terminal call is denied and ends your session `
      + 'without a result. To inspect the project use only your file listing, search and view tools; to change it use only file edit tools. '
      + `The studio runs builds and tests itself.\n${request.systemPrompt}\n\n${request.prompt}`;
    // agy treats an extra --add-dir as its project root, so the task file lives inside cwd instead
    // (AGY_TASK_FILE_PREFIX files are excluded from studio commits and deleted afterwards).
    const taskFile = path.join(request.cwd, `${AGY_TASK_FILE_PREFIX}${randomUUID().slice(0, 8)}.md`);
    const logFile = path.join(os.tmpdir(), `asf-agy-${randomUUID().slice(0, 8)}.log`);
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      let text = prompt;
      if (prompt.length > AGY_INLINE_PROMPT_MAX) {
        fs.writeFileSync(taskFile, prompt);
        text = `Your complete task is in the file ${path.basename(taskFile)} in the project root. Read that whole file first and follow it exactly. `
          + 'Do not edit or delete that file.';
      }
      const timeoutSec = Math.max(60, Math.floor(request.timeoutMs / 1000) - 15);
      const model = request.model || this.defaultModel;
      if (this.accountModels && !this.accountModels.includes(model)) {
        throw new ProviderError(`${this.label}: model "${model}" is not available on this account. Available: ${this.accountModels.join(', ')}`, false);
      }
      const args = ['--model', model, '--output-format', 'json', '--print-timeout', `${timeoutSec}s`, '--log-file', logFile];
      if (request.mode === 'edit') args.push('--mode', 'accept-edits');
      args.push('-p', text); // -p must be last: agy stops flag parsing at the prompt
      // agy prints nothing until it finishes; a growing log file is its sign of life for the idle watchdog.
      let lastSize = -1;
      heartbeat = setInterval(() => {
        try {
          const size = fs.statSync(logFile).size;
          if (size !== lastSize) { lastSize = size; request.onHeartbeat?.(); }
        } catch { /* log not created yet */ }
      }, AGY_LOG_POLL_MS);
      const result = await runProcess('agy', { cwd: request.cwd, args, timeoutMs: request.timeoutMs, signal: request.signal });
      const json = parseLastJson(result.stdout) as { status?: string; response?: string; usage?: Record<string, number>;
        denied_actions?: { display_name?: string }[] } | null;
      const response = json?.response?.trim() ?? '';
      const denied = (json?.denied_actions ?? []).map((d) => d.display_name ?? 'tool').join(', ');
      if (denied && !response) {
        throw new ProviderError(`${this.label} stopped after its ${denied} request was denied (it has no shell). `
          + 'Models that insist on running commands suit Codex better; consider reassigning this agent.');
      }
      if (result.exitCode !== 0 || json?.status !== 'SUCCESS' || !response) {
        if (json?.status && json.status !== 'SUCCESS') {
          const detail = redact(json.response ?? '').slice(0, 800) || `no message (check that model "${request.model}" is available: run "agy models")`;
          throw limitOr(this.label, `${json.status} ${json.response ?? ''}`) ?? new ProviderError(`${this.label} status ${json.status}: ${detail}`);
        }
        throw failure(this.label, result);
      }
      request.onOutput?.(response.slice(0, 2000));
      const u = json.usage ?? {};
      return {
        text: response,
        usage: { inputTokens: u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0, outputTokens: u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0, costUsd: null },
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      fs.rmSync(taskFile, { force: true });
      fs.rmSync(logFile, { force: true });
    }
  }
}

function parseLastJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    try { return start >= 0 ? JSON.parse(trimmed.slice(start + 1)) : null; } catch { return null; }
  }
}

// ------------------------------------------------------------------ Gemini CLI

/** Google Gemini CLI in non-interactive mode (used when the `gemini` command is installed). */
export class GeminiProvider implements ProviderAdapter {
  readonly id = 'gemini';
  readonly label = 'Gemini CLI';
  readonly kind = 'cli' as const;
  readonly editsFiles = true;
  readonly isAi = true;
  readonly models = ['gemini-2.5-pro', 'gemini-2.5-flash'];
  readonly defaultModel = 'gemini-2.5-pro';

  detect(): Promise<ProviderDetection> {
    return detectCli('gemini');
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const args = ['--model', request.model || this.defaultModel, '--approval-mode', request.mode === 'edit' ? 'auto_edit' : 'default', '-p', 'Follow the instructions given on standard input.'];
    const result = await runProcess('gemini', {
      cwd: request.cwd, args, input: `${STUDIO_GUARD}\n${request.systemPrompt}\n\n${request.prompt}`,
      timeoutMs: request.timeoutMs, signal: request.signal, onOutput: (chunk) => request.onOutput?.(chunk),
    });
    if (result.exitCode !== 0) throw failure(this.label, result);
    return { text: result.stdout.trim(), usage: null };
  }
}
