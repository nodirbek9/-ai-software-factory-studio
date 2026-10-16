import type { UsageInfo } from '@asf/shared';

export type RunMode = 'edit' | 'readonly';

export interface ProviderRunRequest {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  mode: RunMode;
  model: string;
  /** Reasoning effort ('' = provider default). Adapters without an effort knob ignore it. */
  effort?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Context for providers that replay deterministic scripts (task key, kind, attempt). */
  task?: { key: string; kind: string; role: string; attempt: number };
  onOutput?: (chunk: string) => void;
  /** Called on any sign of life (stdout/stderr bytes, log writes) so the idle watchdog knows the agent is working. */
  onHeartbeat?: () => void;
}

export interface ProviderRunResult {
  text: string;
  usage: UsageInfo | null;
  /** The model id the provider reports it actually used (may differ from the requested alias). */
  model?: string;
}

export interface ProviderDetection {
  available: boolean;
  version: string | null;
  reason: string | null;
  /** Models the account can actually use, when the CLI can list them (overrides the adapter's static list). */
  models?: string[];
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: 'cli' | 'api' | 'builtin';
  /** True when the provider edits files in cwd itself; otherwise the executor applies the JSON file protocol. */
  readonly editsFiles: boolean;
  readonly isAi: boolean;
  /** True when the adapter reports heartbeats while it works; otherwise only the hard time cap applies. */
  readonly reportsActivity?: boolean;
  readonly models: string[];
  readonly defaultModel: string;
  detect(settings: Record<string, string>): Promise<ProviderDetection>;
  run(request: ProviderRunRequest, settings: Record<string, string>): Promise<ProviderRunResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

/** The provider refused because a subscription/session/usage limit is used up. Routing skips it until `resetsAt`. */
export class ProviderLimitError extends ProviderError {
  constructor(message: string, readonly resetsAt: Date) {
    super(message, true);
  }
}

const LIMIT_PATTERN = /(hit your [a-z ]*limit|usage limit|rate limit|session limit|weekly limit|quota|RESOURCE_EXHAUSTED|\b429\b|too many requests)/i;
const DEFAULT_COOLDOWN_MS = 60 * 60_000;

export function looksLikeLimit(text: string): boolean {
  return LIMIT_PATTERN.test(text);
}

/** Parses "resets 9:20pm" / "resets at 21:20" (local time) from a provider message; defaults to one hour from now. */
export function parseResetTime(text: string, now = new Date()): Date {
  const match = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!match) return new Date(now.getTime() + DEFAULT_COOLDOWN_MS);
  let hours = Number(match[1]) % 24;
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  const reset = new Date(now);
  reset.setHours(hours, minutes, 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset;
}
