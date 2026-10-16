import type { AgentConfig, AgentRole, EffortLevel, ProviderInfo } from '@asf/shared';
import { AGENT_ROLES } from '@asf/shared';
import type { ConfigRepository, UsageRepository } from '../db/repositories.ts';
import { OpenAiCompatibleProvider, ScriptedProvider } from './apiProviders.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider, ClaudeCodeProvider, CodexProvider, GeminiProvider } from './cliProviders.ts';
import type { ProviderAdapter, ProviderDetection } from './types.ts';

const DETECTION_TTL_MS = 60_000;
const NON_SECRET_SETTINGS = new Set(['baseUrl', 'apiKeyEnv', 'models', 'configDir']);

export const DEFAULT_FALLBACK_ORDER = ['claude-code-2', 'claude-code-3', 'claude-code-4', 'codex', 'antigravity', 'claude-code', 'gemini', 'openai-compatible', 'scripted'];

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  model: string;
  /** The agent's requested reasoning effort ('' = provider default); adapters that cannot set it ignore it. */
  effort: EffortLevel;
  settings: Record<string, string>;
  fallbackFrom: string | null;
}

export class NoProviderError extends Error {}

const MAX_CLAUDE_ACCOUNTS = 9;

/**
 * One provider per extra Claude Code login folder (~/.claude-account2 … 9), the same CLAUDE_CONFIG_DIR mechanism
 * the user's `claude<N>` commands use — without running those shims. Accounts 2–4 are always listed.
 */
export function discoverClaudeAccounts(home = os.homedir()): ClaudeCodeProvider[] {
  const accounts: ClaudeCodeProvider[] = [];
  for (let n = 2; n <= MAX_CLAUDE_ACCOUNTS; n += 1) {
    const configDir = path.join(home, `.claude-account${n}`);
    if (n > 4 && !fs.existsSync(configDir)) continue;
    accounts.push(new ClaudeCodeProvider({ id: `claude-code-${n}`, label: `Claude Code CLI (account ${n})`, defaultConfigDir: configDir, accountNumber: n }));
  }
  return accounts;
}

/** Detects providers, holds their (non-secret) configuration and routes each agent to a usable one. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly detections = new Map<string, { at: number; value: ProviderDetection }>();
  /** Providers whose usage limit is used up, with the time they become usable again (in memory; cleared on restart). */
  private readonly limited = new Map<string, { until: number; message: string }>();

  constructor(private readonly config: ConfigRepository, private readonly usage: UsageRepository, env: Record<string, string | undefined>,
    extraAdapters: ProviderAdapter[] = []) {
    const adapters: ProviderAdapter[] = [
      new ClaudeCodeProvider(),
      // Extra Claude Pro logins (~/.claude-account<N>, the claude<N> commands) are discovered automatically.
      ...discoverClaudeAccounts(),
      new CodexProvider(), new AntigravityProvider(), new GeminiProvider(),
      new OpenAiCompatibleProvider(env), new ScriptedProvider(), ...extraAdapters];
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    for (const adapter of this.adapters.values()) {
      if (!this.config.getProviderConfig(adapter.id)) {
        // Only the offline replay provider starts enabled; AI providers are opt-in.
        this.config.upsertProviderConfig({ id: adapter.id, enabled: adapter.id === 'scripted', settings: {}, budgetUsd: null });
        if (/^claude-code-\d+$/.test(adapter.id)) this.joinFallbackOrder(adapter.id);
      }
    }
    const existing = new Set(this.config.getAgentConfigs().map((c) => c.role));
    for (const role of AGENT_ROLES) {
      if (!existing.has(role)) this.config.upsertAgentConfig({ role, providerId: 'claude-code', model: role === 'pm' || role === 'architect' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', allowFallback: true, effort: role === 'pm' || role === 'architect' ? 'high' : '' });
    }
  }

  /** A newly discovered Claude login joins the fallback order right after the other Claude logins (it is skipped while disabled). */
  private joinFallbackOrder(id: string): void {
    const studio = this.config.getSetting<{ fallbackOrder?: string[] }>('studio', {});
    const order = studio.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
    if (order.includes(id)) return;
    const afterLastClaude = order.reduce((at, providerId, index) => (/^claude-code-\d+$/.test(providerId) ? index + 1 : at), 0);
    this.config.setSetting('studio', { ...studio, fallbackOrder: [...order.slice(0, afterLastClaude), id, ...order.slice(afterLastClaude)] });
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async detect(id: string, force = false): Promise<ProviderDetection> {
    const adapter = this.adapters.get(id);
    if (!adapter) return { available: false, version: null, reason: 'Unknown provider' };
    const cached = this.detections.get(id);
    if (!force && cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.value;
    const settings = this.config.getProviderConfig(id)?.settings ?? {};
    const value = await adapter.detect(settings).catch((error: Error) => ({ available: false, version: null, reason: error.message }));
    this.detections.set(id, { at: Date.now(), value });
    return value;
  }

  async list(force = false): Promise<ProviderInfo[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => this.info(adapter, await this.detect(adapter.id, force))));
  }

  /**
   * For status read models (Home, system health): detects only enabled providers (cached, same TTL as list());
   * a disabled provider reports its last cached detection, or unavailable when it was never checked.
   */
  async statusList(): Promise<ProviderInfo[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      const enabled = this.config.getProviderConfig(adapter.id)?.enabled ?? false;
      const detection = enabled ? await this.detect(adapter.id)
        : this.detections.get(adapter.id)?.value ?? { available: false, version: null, reason: 'Disabled (not checked)' };
      return this.info(adapter, detection);
    }));
  }

  private info(adapter: ProviderAdapter, detection: ProviderDetection): ProviderInfo {
    const cfg = this.config.getProviderConfig(adapter.id)!;
    const customModels = (cfg.settings.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    return {
      id: adapter.id, label: adapter.label, kind: adapter.kind, editsFiles: adapter.editsFiles, isAi: adapter.isAi,
      enabled: cfg.enabled, available: detection.available, version: detection.version, reason: detection.reason,
      models: customModels.length ? customModels : detection.models ?? adapter.models, defaultModel: adapter.defaultModel,
      budgetUsd: cfg.budgetUsd, spentUsd: this.usage.spentByProvider(adapter.id),
      limitedUntil: this.limitedUntil(adapter.id)?.toISOString() ?? null,
      settings: Object.fromEntries(Object.entries(cfg.settings).filter(([k]) => NON_SECRET_SETTINGS.has(k))),
    };
  }

  updateProvider(id: string, patch: { enabled?: boolean; budgetUsd?: number | null; settings?: Record<string, string> }): void {
    const current = this.config.getProviderConfig(id);
    if (!current) throw new NoProviderError(`Unknown provider ${id}`);
    const settings = patch.settings
      ? Object.fromEntries(Object.entries(patch.settings).filter(([k]) => NON_SECRET_SETTINGS.has(k)))
      : current.settings;
    this.config.upsertProviderConfig({
      id, enabled: patch.enabled ?? current.enabled, settings,
      budgetUsd: patch.budgetUsd === undefined ? current.budgetUsd : patch.budgetUsd,
    });
    this.detections.delete(id);
  }

  agentConfig(role: AgentRole): AgentConfig {
    return this.config.getAgentConfigs().find((c) => c.role === role)!;
  }

  markLimited(id: string, until: Date, message: string): void {
    this.limited.set(id, { until: until.getTime(), message });
  }

  /** The time a limited provider becomes usable again, or null. Expired limits are dropped. */
  limitedUntil(id: string): Date | null {
    const entry = this.limited.get(id);
    if (!entry) return null;
    if (entry.until <= Date.now()) { this.limited.delete(id); return null; }
    return new Date(entry.until);
  }

  /** Why a provider cannot be used right now, or null when it can. */
  async unusableReason(id: string): Promise<string | null> {
    const adapter = this.adapters.get(id);
    if (!adapter) return 'unknown provider';
    const limitedUntil = this.limitedUntil(id);
    if (limitedUntil) return `${adapter.label} usage limit reached; usable again at ${limitedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const cfg = this.config.getProviderConfig(id);
    if (!cfg?.enabled) return `${adapter.label} is disabled (enable it in Model Providers)`;
    const detection = await this.detect(id);
    if (!detection.available) return `${adapter.label} is unavailable: ${detection.reason}`;
    if (cfg.budgetUsd !== null && this.usage.spentByProvider(id) >= cfg.budgetUsd) {
      return `${adapter.label} budget of $${cfg.budgetUsd.toFixed(2)} is exhausted`;
    }
    return null;
  }

  /** Routing policy: the agent's assigned provider, then (if allowed) the configured fallback order. */
  async resolveForRole(role: AgentRole, fallbackOrder: string[]): Promise<ResolvedProvider> {
    const assignment = this.agentConfig(role);
    const reasons: string[] = [];
    const candidates = [assignment.providerId, ...(assignment.allowFallback ? fallbackOrder.filter((id) => id !== assignment.providerId) : [])];
    for (const id of candidates) {
      const reason = await this.unusableReason(id);
      if (reason) { reasons.push(reason); continue; }
      const adapter = this.adapters.get(id)!;
      const settings = this.config.getProviderConfig(id)!.settings;
      // Keep the requested model on a fallback provider that offers it too (e.g. another Claude login), so a
      // fallback never silently downgrades Opus to the provider's default model.
      const offersRequested = Boolean(assignment.model) && adapter.models.includes(assignment.model);
      const model = (id === assignment.providerId && assignment.model) || offersRequested ? assignment.model : adapter.defaultModel;
      return { adapter, model, effort: assignment.effort ?? '', settings, fallbackFrom: id === assignment.providerId ? null : assignment.providerId };
    }
    throw new NoProviderError(`No usable provider for ${role}: ${reasons.join('; ')}`);
  }
}
