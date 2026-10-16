import fs from 'node:fs';
import path from 'node:path';
import { redact, registerSecret } from '../security/redact.ts';
import { ProviderError, type ProviderAdapter, type ProviderDetection, type ProviderRunRequest, type ProviderRunResult } from './types.ts';

const DETECT_TIMEOUT_MS = 5_000;

/**
 * Any OpenAI-compatible chat-completions endpoint. The API key is read from the server environment
 * variable named in settings.apiKeyEnv; it is never stored in the database or returned to the client.
 */
export class OpenAiCompatibleProvider implements ProviderAdapter {
  readonly id = 'openai-compatible';
  readonly label = 'OpenAI-compatible API';
  readonly kind = 'api' as const;
  readonly editsFiles = false;
  readonly isAi = true;
  readonly models = ['gpt-4.1', 'gpt-4.1-mini'];
  readonly defaultModel = 'gpt-4.1-mini';

  constructor(private readonly env: Record<string, string | undefined>) {}

  private resolve(settings: Record<string, string>): { baseUrl: string; key: string } | string {
    const baseUrl = (settings.baseUrl || this.env.ASF_OPENAI_BASE_URL || '').replace(/\/+$/, '');
    const keyEnv = settings.apiKeyEnv || 'ASF_OPENAI_API_KEY';
    const key = this.env[keyEnv] ?? '';
    if (!baseUrl) return 'No base URL configured (settings.baseUrl or ASF_OPENAI_BASE_URL in .env)';
    if (!/^https?:\/\//.test(baseUrl)) return 'Base URL must start with http:// or https://';
    if (!key) return `API key env var ${keyEnv} is not set in the studio .env`;
    registerSecret(key);
    return { baseUrl, key };
  }

  async detect(settings: Record<string, string>): Promise<ProviderDetection> {
    const resolved = this.resolve(settings);
    if (typeof resolved === 'string') return { available: false, version: null, reason: resolved };
    try {
      const response = await fetch(`${resolved.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${resolved.key}` }, signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      });
      if (!response.ok) return { available: false, version: null, reason: `GET /models returned HTTP ${response.status}` };
      return { available: true, version: 'reachable', reason: null };
    } catch (error) {
      return { available: false, version: null, reason: redact((error as Error).message) };
    }
  }

  async run(request: ProviderRunRequest, settings: Record<string, string>): Promise<ProviderRunResult> {
    const resolved = this.resolve(settings);
    if (typeof resolved === 'string') throw new ProviderError(resolved, false);
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.key}` },
      body: JSON.stringify({
        model: request.model || this.defaultModel,
        messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.prompt }],
      }),
      signal: AbortSignal.any([request.signal, timeout]),
    }).catch((error: Error) => {
      if (request.signal.aborted) throw new ProviderError('Request cancelled', false);
      throw new ProviderError(`Request failed: ${redact(error.message)}`);
    });
    const body = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string };
    };
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(`HTTP ${response.status}: ${redact(body.error?.message ?? 'request failed').slice(0, 800)}`, retryable);
    }
    const text = body.choices?.[0]?.message?.content ?? '';
    request.onOutput?.(text);
    return {
      text,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, costUsd: null },
    };
  }
}

interface ScriptTask {
  summary?: string;
  files?: { path: string; content: string }[];
  failAttempts?: number;
  delayMs?: number;
  text?: string;
}

interface StudioScript {
  plan?: { tasks: unknown[] };
  architecture?: string;
  tasks?: Record<string, ScriptTask>;
  chat?: string;
}

const SCRIPT_FILE = '.asf-script.json';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('cancelled', false));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new ProviderError('cancelled', false)); }, { once: true });
  });
}

/**
 * Deterministic offline provider — NOT an AI. It replays `.asf-script.json` committed in the
 * workspace so the whole pipeline (worktrees, merges, real tests, reviews) can be exercised
 * without spending any model quota. Without a script it fails loudly instead of inventing output.
 */
export class ScriptedProvider implements ProviderAdapter {
  readonly id = 'scripted';
  readonly label = 'Scripted (offline, not AI)';
  readonly kind = 'builtin' as const;
  readonly editsFiles = false;
  readonly isAi = false;
  readonly models = ['replay'];
  readonly defaultModel = 'replay';

  async detect(): Promise<ProviderDetection> {
    return { available: true, version: 'built-in', reason: null };
  }

  async run(request: ProviderRunRequest): Promise<ProviderRunResult> {
    const file = path.join(request.cwd, SCRIPT_FILE);
    if (!fs.existsSync(file)) {
      throw new ProviderError(`Scripted provider needs ${SCRIPT_FILE} in the workspace; it cannot do real AI work. Assign an AI provider to this agent.`, false);
    }
    const script = JSON.parse(fs.readFileSync(file, 'utf8')) as StudioScript;
    const task = request.task;
    if (!task) {
      return { text: script.chat ?? 'I am the offline scripted provider. I can only replay the scripted plan for this project.', usage: null };
    }
    if (task.kind === 'plan') {
      if (!script.plan) throw new ProviderError('Script has no "plan" section', false);
      return this.emit(request, JSON.stringify(script.plan, null, 2));
    }
    if (task.kind === 'architecture') {
      if (!script.architecture) throw new ProviderError('Script has no "architecture" section', false);
      return this.emit(request, script.architecture);
    }
    const entry = script.tasks?.[task.key];
    if (!entry) throw new ProviderError(`Script has no entry for task "${task.key}"`, false);
    if (entry.delayMs) await sleep(Math.min(entry.delayMs, 30_000), request.signal);
    if (entry.failAttempts && task.attempt <= entry.failAttempts) {
      throw new ProviderError(`Scripted failure on attempt ${task.attempt} (script failAttempts=${entry.failAttempts})`);
    }
    if (entry.text) return this.emit(request, entry.text);
    return this.emit(request, JSON.stringify({ summary: entry.summary ?? `Completed ${task.key}`, files: entry.files ?? [] }));
  }

  private emit(request: ProviderRunRequest, text: string): ProviderRunResult {
    request.onOutput?.(text.length > 400 ? `${text.slice(0, 400)}…` : text);
    return { text, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
