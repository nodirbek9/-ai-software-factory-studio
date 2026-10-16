import type { AgentConfig, AgentTestResult, FsRoots, LiveSnapshot, ProviderInfo, ServerInfo, StudioSettings } from '@asf/shared';

export function provider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'claude-code', label: 'Claude Code', kind: 'cli', editsFiles: true,
    enabled: true, available: true, version: '1.0', reason: null,
    models: ['claude-default', 'claude-saved'], defaultModel: 'claude-default',
    budgetUsd: null, spentUsd: 0, limitedUntil: null, settings: {}, isAi: true,
    ...overrides,
  };
}

export const providers: ProviderInfo[] = [
  provider(),
  provider({ id: 'codex', label: 'Codex', models: ['codex-default', 'codex-fast'], defaultModel: 'codex-default' }),
];

export const agentConfig: AgentConfig = {
  role: 'pm', providerId: 'claude-code', model: 'claude-saved', allowFallback: false, effort: 'high',
};

export function agentResult(overrides: Partial<AgentTestResult> = {}): AgentTestResult {
  return {
    role: 'pm', providerId: 'claude-code', providerLabel: 'Claude Code',
    requestedModel: 'claude-saved', actualModel: 'claude-saved', effort: 'high', effortApplied: true,
    ok: true, answer: '42', correct: true, reasoningTokens: 123, outputTokens: 8,
    durationMs: 1500, error: null, ...overrides,
  };
}

export const settings: StudioSettings = {
  maxParallelTasks: 4, defaultMaxAttempts: 3, taskTimeoutMinutes: 30,
  idleTimeoutMinutes: 15, maxFixRounds: 2, fallbackOrder: ['claude-code', 'codex'],
};

export const serverInfo: ServerInfo = {
  version: 'test', host: 'localhost', port: 0, authRequired: false,
  approvedRoots: [], dataDir: 'test-data', allowedCommands: [], settings,
};

export const fsRoots: FsRoots = { drives: [], approvedRoots: [], protectedPaths: [] };

export function liveSnapshot(): LiveSnapshot {
  const first: LiveSnapshot['running'][number] = {
    taskId: 'task-1', projectId: 'project-1', projectName: 'Atlas', role: 'pm',
    taskKey: 'plan', taskTitle: 'Plan Unicode 🚀', kind: 'plan', providerId: 'claude-code',
    providerLabel: 'Claude Code', model: 'claude-saved', effort: 'high', isAi: true,
    fallbackFrom: null, startedAt: '2026-10-16T10:00:00Z', attempt: 1, maxAttempts: 3,
    checkpoint: 'none', lastOutput: 'Planning', lastOutputAt: null,
  };
  return {
    generatedAt: '2026-10-16T10:00:00Z', maxParallel: 4,
    running: [first, {
      ...first, taskId: 'task-2', projectId: 'project-2', projectName: 'Orion', role: 'backend',
      taskTitle: 'Implement search', kind: 'implement', providerId: 'codex', providerLabel: 'Codex',
      model: 'codex-default', effort: '', fallbackFrom: 'claude-code',
    }],
    queued: [
      { taskId: 'q1', projectId: 'project-1', projectName: 'Atlas', role: 'pm', taskTitle: 'Approve plan', status: 'waiting_approval' },
      { taskId: 'q2', projectId: 'project-2', projectName: 'Orion', role: 'backend', taskTitle: 'Build index', status: 'ready' },
    ],
    providers: providers.map((p) => ({
      id: p.id, label: p.label, enabled: true, available: true, isAi: true,
      running: p.id === 'claude-code' ? 1 : 0, limitedUntil: null,
      callsToday: 2, tokensToday: 120, costToday: 0,
    })),
    recent: [{
      taskId: 'finished', projectId: 'project-1', projectName: 'Atlas', role: 'pm',
      taskTitle: 'Gather requirements', status: 'completed', providerId: 'claude-code',
      model: 'claude-saved', effort: 'high', durationMs: 2500,
      finishedAt: '2026-10-16T09:59:00Z', error: null,
    }],
  };
}
