import { AGENT_ROLES } from '@asf/shared';
import type {
  AgentConfig, AgentTestResult, FsRoots, LiveSnapshot, OverviewAgentHealth, OverviewResponse, OverviewStage, ProviderInfo, ServerInfo,
  StudioSettings, SystemHealth, UsageSummary,
} from '@asf/shared';

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
  approvedRoots: [], dataDir: 'test-data', allowedCommands: [], settings, userName: 'tester',
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

// ------------------------------------------------------------------ V2 read models (/api/v2/*)

function stage(role: OverviewStage['role'], overrides: Partial<OverviewStage> = {}): OverviewStage {
  return {
    role, status: 'none', tasksTotal: 0, tasksCompleted: 0, currentTask: null, providerId: null, model: null,
    durationMs: 0, latestFiles: [], error: null, ...overrides,
  };
}

/** Atlas is the current project: Architect done, Backend running, QA failed, Security waiting, Review has no task. */
export function overviewFixture(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  const health = (role: OverviewAgentHealth['role'], extra: Partial<OverviewAgentHealth> = {}): OverviewAgentHealth => ({
    role, status: 'idle', currentTask: null, lastActivityAt: '2026-10-16T09:50:00Z', providerId: 'claude-code', providerLabel: 'Claude Code',
    model: 'claude-saved', effort: 'high', successRate7d: null, finished7d: 0, ...extra,
  });
  const overridesByRole: Partial<Record<OverviewAgentHealth['role'], Partial<OverviewAgentHealth>>> = {
    architect: { successRate7d: 1, finished7d: 2 },
    backend: {
      status: 'running', currentTask: { id: 'task-2', title: 'Implement search', projectName: 'Atlas' },
      providerId: 'codex', providerLabel: 'Codex', model: 'codex-default', successRate7d: 0.83, finished7d: 6,
    },
    frontend: { status: 'disconnected', providerId: 'gemini', providerLabel: 'Gemini', model: 'gemini-pro' },
  };
  return {
    generatedAt: '2026-10-16T10:00:00Z',
    projects: { total: 3, active: 2, createdLast7d: 1 },
    agents: { running: 2, slots: 4, queued: 3 },
    tasks: { open: 12, failedLast24h: 2, completedLast24h: 5 },
    approvals: { pending: 1 },
    currentProject: {
      id: 'project-1', name: 'Atlas', status: 'running',
      stages: [
        stage('architect', { status: 'completed', tasksTotal: 2, tasksCompleted: 2, durationMs: 125_000, providerId: 'claude-code', model: 'claude-saved',
          currentTask: { id: 'task-1', title: 'Write the technical plan', status: 'completed' }, latestFiles: ['docs/PLAN.md'] }),
        stage('backend', { status: 'running', tasksTotal: 3, tasksCompleted: 1, durationMs: 42_000, providerId: 'codex', model: 'codex-default',
          currentTask: { id: 'task-2', title: 'Implement search', status: 'running' } }),
        stage('frontend', { status: 'pending', tasksTotal: 2, currentTask: { id: 'task-3', title: 'Build the search page', status: 'pending' } }),
        stage('qa', { status: 'failed', tasksTotal: 1, durationMs: 9_000, error: 'Tests failed: 3 failing',
          currentTask: { id: 'task-4', title: 'Run the test suite', status: 'failed' } }),
        stage('security', { status: 'waiting', tasksTotal: 1, currentTask: { id: 'task-5', title: 'Review the integrated diff', status: 'waiting_approval' } }),
      ],
      progress: { total: 9, completed: 3, running: 1, blocked: 1, failed: 1 },
    },
    agentHealth: AGENT_ROLES.map((role) => health(role, overridesByRole[role])),
    activeProjects: [
      { id: 'project-1', name: 'Atlas', description: 'Product search API', status: 'running', workspacePath: 'C:/work/atlas', integrationBranch: 'asf/atlas/integration',
        updatedAt: '2026-10-16T09:58:00Z', tasksTotal: 9, tasksCompleted: 3, activeAgents: 2, failedTasks: 1 },
      { id: 'project-2', name: 'Orion', description: 'Billing dashboard', status: 'paused', workspacePath: 'C:/work/orion', integrationBranch: null,
        updatedAt: '2026-10-16T08:00:00Z', tasksTotal: 4, tasksCompleted: 0, activeAgents: 0, failedTasks: 0 },
    ],
    recentRuns: [
      { taskId: 'finished-1', projectId: 'project-1', projectName: 'Atlas', role: 'architect', taskTitle: 'Write the technical plan', status: 'completed',
        providerId: 'claude-code', model: 'claude-saved', effort: 'high', durationMs: 125_000, finishedAt: '2026-10-16T09:55:00Z', error: null },
      { taskId: 'finished-2', projectId: 'project-1', projectName: 'Atlas', role: 'qa', taskTitle: 'Run the test suite', status: 'failed',
        providerId: 'claude-code', model: 'claude-saved', effort: 'high', durationMs: 9_000, finishedAt: '2026-10-16T09:50:00Z', error: 'Tests failed: 3 failing' },
    ],
    ...overrides,
  };
}

/** 24 h: 18.4k tokens against 24 864 before (−26 %), two models, reported cost for one of them. 7 d: one entry per day. */
export function usageFixture(range: UsageSummary['range'] = '24h', overrides: Partial<UsageSummary> = {}): UsageSummary {
  const byModel: UsageSummary['byModel'] = [
    { providerId: 'claude-code', providerLabel: 'Claude Code', model: 'claude-saved', calls: 5, inputTokens: 9_000, outputTokens: 3_000, costUsd: 0.42 },
    { providerId: 'codex', providerLabel: 'Codex', model: 'codex-default', calls: 3, inputTokens: 4_000, outputTokens: 2_400, costUsd: null },
  ];
  if (range === '7d') {
    const totals = [3_000, 8_000, 0, 12_500, 9_000, 6_100, 18_400];
    return {
      range, from: '2026-10-10T00:00:00Z', to: '2026-10-16T10:00:00Z', totalTokens: 57_000, previousTotalTokens: 40_000, calls: 30, costUsd: 1.5, byModel,
      byDay: totals.map((totalTokens, index) => ({ date: `2026-10-${String(10 + index).padStart(2, '0')}`, totalTokens })), ...overrides,
    };
  }
  return {
    range, from: '2026-10-15T10:00:00Z', to: '2026-10-16T10:00:00Z', totalTokens: 18_400, previousTotalTokens: 24_864, calls: 8, costUsd: 0.42, byModel,
    byDay: [{ date: '2026-10-15', totalTokens: 5_000 }, { date: '2026-10-16', totalTokens: 13_400 }], ...overrides,
  };
}

export function healthFixture(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    generatedAt: '2026-10-16T10:00:00Z', overall: 'degraded',
    checks: [
      { id: 'api', label: 'API', state: 'ok', detail: 'Responding' },
      { id: 'database', label: 'Database', state: 'ok', detail: 'Schema v7' },
      { id: 'events', label: 'Event stream', state: 'ok', detail: '2 clients' },
      { id: 'providers', label: 'Providers', state: 'degraded', detail: '1 of 2 available' },
      { id: 'git', label: 'Git', state: 'ok', detail: 'git 2.51' },
      { id: 'disk', label: 'Disk', state: 'ok', detail: '120 GB free' },
    ],
    server: { rssBytes: 150_000_000, uptimeSec: 3_600, version: 'test' },
    system: { totalMemBytes: 16_000_000_000, freeMemBytes: 8_000_000_000, cpuPercent: 12 },
    eventClients: 2, ...overrides,
  };
}
