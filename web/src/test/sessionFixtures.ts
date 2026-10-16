import type { AgentSession, ProcessBudgetSnapshot, Project, SessionTurn, StudioEvent, Task } from '@asf/shared';

// Fixtures for the Agent Workspace tests (kept apart from fixtures.ts, which other phases extend).

export function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1', name: 'Atlas', slug: 'atlas', description: 'Product search API', spec: '', status: 'running',
    workspaceMode: 'new', workspacePath: 'C:/work/atlas', integrationPath: 'C:/work/atlas-int', integrationBranch: 'asf/atlas/integration',
    baseCommit: null, testCommand: 'npm test', planMarkdown: null, reportMarkdown: null,
    createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z', ...overrides,
  };
}

/** An idle edit session in its own worktree. */
export function sessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1', projectId: 'project-1', number: 1, title: 'Backend work', role: 'backend', providerId: 'claude-code', model: 'claude-default',
    effort: '', allowFallback: false, mode: 'edit', cwdKind: 'own-worktree', branch: 'asf/atlas/session-1', worktreePath: 'C:/work/session-1',
    continuity: 'native', taskId: null, status: 'idle', queuePosition: null, lastError: null, lastActivityAt: null,
    createdAt: '2026-10-16T10:00:00Z', closedAt: null, ...overrides,
  };
}

export function turnFixture(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: 1, sessionId: 's1', seq: 1, author: 'user', text: 'Hello', activity: [], providerId: null, modelReported: null, usage: null,
    filesChanged: [], startedAt: '2026-10-16T10:01:00Z', finishedAt: '2026-10-16T10:01:00Z', outcome: null, error: null, ...overrides,
  };
}

export function budgetFixture(overrides: Partial<ProcessBudgetSnapshot> = {}): ProcessBudgetSnapshot {
  return { limit: 3, running: [], queued: [], ...overrides };
}

export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a', projectId: 'project-1', key: 'plan', title: 'Write the technical plan', description: '', role: 'architect', kind: 'architecture',
    status: 'completed', dependsOn: [], orderIndex: 0, attempt: 1, maxAttempts: 3, checkpoint: 'merged', branch: null, worktreePath: null,
    providerId: 'claude-code', model: 'claude-default', resultSummary: null, error: null, filesChanged: [], testResult: null, usage: null,
    startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T10:05:00Z', updatedAt: '2026-10-16T10:05:00Z', ...overrides,
  };
}

let nextEventId = 1;
export function eventFixture(overrides: Partial<StudioEvent> = {}): StudioEvent {
  return {
    id: nextEventId++, projectId: 'project-1', taskId: null, role: null, type: 'task.updated', level: 'info', message: '', data: null,
    createdAt: '2026-10-16T10:00:00Z', ...overrides,
  };
}
