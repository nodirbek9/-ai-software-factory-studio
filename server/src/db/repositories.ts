import { randomUUID } from 'node:crypto';
import type {
  AgentConfig, AgentMessage, AgentRole, AgentSession, Approval, ApprovalKind, ApprovalStatus, CheckpointStage, EffortLevel,
  EventLevel, EventsPage, Project, ProjectStatus, SessionContinuity, SessionMode, SessionStatus, SessionTurn, StudioEvent,
  Task, TaskKind, TaskNodeOptions, TaskStatus, TestResult, UsageInfo, WorkspaceLayout,
} from '@asf/shared';
import type { Db } from './database.ts';
import { FindingRepository } from './findingRepository.ts';
import { RunRepository, WorkflowRepository } from './runRepositories.ts';
import { redact } from '../security/redact.ts';

type Row = Record<string, unknown>;

const now = (): string => new Date().toISOString();
const json = <T>(value: unknown, fallback: T): T => (typeof value === 'string' && value ? (JSON.parse(value) as T) : fallback);
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// ---------------------------------------------------------------- projects

function toProject(r: Row): Project {
  return {
    id: String(r.id), name: String(r.name), slug: String(r.slug), description: String(r.description),
    spec: String(r.spec), status: r.status as ProjectStatus, workspaceMode: r.workspace_mode as Project['workspaceMode'],
    workspacePath: String(r.workspace_path), integrationPath: str(r.integration_path), integrationBranch: str(r.integration_branch),
    baseCommit: str(r.base_commit), testCommand: String(r.test_command), planMarkdown: str(r.plan_md),
    reportMarkdown: str(r.report_md), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export interface NewProject {
  name: string; slug: string; description: string; spec: string;
  workspaceMode: Project['workspaceMode']; workspacePath: string; testCommand: string;
}

export type ProjectPatch = Partial<Pick<Project,
  'status' | 'integrationPath' | 'integrationBranch' | 'baseCommit' | 'planMarkdown' | 'reportMarkdown' | 'workspacePath'>>;

const PROJECT_COLUMNS: Record<keyof ProjectPatch, string> = {
  status: 'status', integrationPath: 'integration_path', integrationBranch: 'integration_branch',
  baseCommit: 'base_commit', planMarkdown: 'plan_md', reportMarkdown: 'report_md', workspacePath: 'workspace_path',
};

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  create(input: NewProject): Project {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`INSERT INTO projects (id, name, slug, description, spec, status, workspace_mode, workspace_path,
      test_command, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.slug, input.description, input.spec, input.workspaceMode, input.workspacePath, input.testCommand, ts, ts);
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Row[]).map(toProject);
  }

  slugExists(slug: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug));
  }

  update(id: string, patch: ProjectPatch): Project {
    const keys = Object.keys(patch) as (keyof ProjectPatch)[];
    if (keys.length) {
      const sets = keys.map((k) => `${PROJECT_COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => (patch[k] ?? null) as string | null);
      this.db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    }
    return this.get(id)!;
  }

  /** Deletes the project with its tasks, approvals and messages (FK cascade) and its event log. Usage records are kept for budgets. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------- tasks

function toTask(r: Row): Task {
  return {
    id: String(r.id), projectId: String(r.project_id), runId: String(r.run_id), nodeId: str(r.node_id),
    options: safeJson<TaskNodeOptions>(r.options, {}), key: String(r.key), title: String(r.title),
    description: String(r.description), role: r.role as AgentRole, kind: r.kind as TaskKind, status: r.status as TaskStatus,
    dependsOn: json<string[]>(r.depends_on, []), orderIndex: Number(r.order_index), attempt: Number(r.attempt),
    maxAttempts: Number(r.max_attempts), checkpoint: r.checkpoint as CheckpointStage, branch: str(r.branch),
    worktreePath: str(r.worktree_path), providerId: str(r.provider_id), model: str(r.model),
    resultSummary: str(r.result_summary), error: str(r.error), filesChanged: json<string[]>(r.files_changed, []),
    testResult: json<TestResult | null>(r.test_result, null), usage: json<UsageInfo | null>(r.usage, null),
    startedAt: str(r.started_at), finishedAt: str(r.finished_at), updatedAt: String(r.updated_at),
  };
}

export interface NewTask {
  /** Run the task belongs to; task keys are unique per run. */
  runId: string;
  /** Workflow node that produced the task (null for runtime tasks such as fix rounds). */
  nodeId?: string | null;
  options?: TaskNodeOptions;
  key: string; title: string; description: string; role: AgentRole; kind: TaskKind;
  dependsOn: string[]; orderIndex: number; maxAttempts: number; status?: TaskStatus;
}

export type TaskPatch = Partial<Pick<Task,
  'status' | 'attempt' | 'maxAttempts' | 'checkpoint' | 'branch' | 'worktreePath' | 'providerId' | 'model' | 'resultSummary'
  | 'error' | 'filesChanged' | 'testResult' | 'usage' | 'startedAt' | 'finishedAt' | 'dependsOn' | 'orderIndex' | 'options'>>;

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status', attempt: 'attempt', maxAttempts: 'max_attempts', checkpoint: 'checkpoint', branch: 'branch',
  worktreePath: 'worktree_path', providerId: 'provider_id', model: 'model', resultSummary: 'result_summary', error: 'error',
  filesChanged: 'files_changed', testResult: 'test_result', usage: 'usage', startedAt: 'started_at', finishedAt: 'finished_at',
  dependsOn: 'depends_on', orderIndex: 'order_index', options: 'options',
};
const JSON_TASK_FIELDS = new Set<keyof TaskPatch>(['filesChanged', 'testResult', 'usage', 'dependsOn']);

export class TaskRepository {
  constructor(private readonly db: Db) {}

  create(projectId: string, input: NewTask): Task {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO tasks (id, project_id, run_id, node_id, options, key, title, description, role, kind, status,
      depends_on, order_index, max_attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, input.runId, input.nodeId ?? null, JSON.stringify(input.options ?? {}), input.key, input.title,
        input.description, input.role, input.kind, input.status ?? 'pending', JSON.stringify(input.dependsOn), input.orderIndex,
        input.maxAttempts, now());
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  /** Every task of the project, across all of its runs (V1 views). */
  listByProject(projectId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY order_index, rowid').all(projectId) as Row[]).map(toTask);
  }

  listByRun(runId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY order_index, rowid').all(runId) as Row[]).map(toTask);
  }

  listByStatus(status: TaskStatus): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE status = ?').all(status) as Row[]).map(toTask);
  }

  update(id: string, patch: TaskPatch): Task {
    const keys = Object.keys(patch) as (keyof TaskPatch)[];
    if (keys.length) {
      const sets = keys.map((k) => `${TASK_COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => {
        const value = patch[k];
        if (k === 'options') return JSON.stringify(value ?? {});
        if (JSON_TASK_FIELDS.has(k)) return value === null || value === undefined ? null : JSON.stringify(value);
        return (value ?? null) as string | number | null;
      });
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    }
    return this.get(id)!;
  }

  listRecentlyFinished(limit: number): Task[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE finished_at IS NOT NULL AND status IN ('completed', 'failed', 'cancelled')
      AND kind != 'gate' ORDER BY finished_at DESC LIMIT ?`).all(limit) as Row[]).map(toTask);
  }

  maxOrderIndex(projectId: string): number {
    const row = this.db.prepare('SELECT MAX(order_index) AS m FROM tasks WHERE project_id = ?').get(projectId) as { m: number | null };
    return row.m ?? 0;
  }

  maxOrderIndexForRun(runId: string): number {
    const row = this.db.prepare('SELECT MAX(order_index) AS m FROM tasks WHERE run_id = ?').get(runId) as { m: number | null };
    return row.m ?? 0;
  }
}

// ---------------------------------------------------------------- events

function toEvent(r: Row): StudioEvent {
  return {
    id: Number(r.id), projectId: str(r.project_id), taskId: str(r.task_id), role: (r.role as AgentRole) ?? null,
    type: String(r.type), level: r.level as EventLevel, message: String(r.message),
    data: json<Record<string, unknown> | null>(r.data, null), createdAt: String(r.created_at),
  };
}

export type NewEvent = Omit<StudioEvent, 'id' | 'createdAt'>;

export class EventRepository {
  constructor(private readonly db: Db) {}

  insert(event: NewEvent): StudioEvent {
    const result = this.db.prepare(`INSERT INTO events (project_id, task_id, role, type, level, message, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(event.projectId, event.taskId, event.role, event.type, event.level, event.message,
      event.data ? JSON.stringify(event.data) : null, now());
    return toEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(result.lastInsertRowid)) as Row);
  }

  list(filter: { projectId?: string; taskId?: string; afterId?: number; limit?: number; level?: EventLevel }): StudioEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.taskId) { where.push('task_id = ?'); params.push(filter.taskId); }
    if (filter.afterId !== undefined) { where.push('id > ?'); params.push(filter.afterId); }
    if (filter.level) { where.push('level = ?'); params.push(filter.level); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? 200, 2000);
    const order = filter.afterId !== undefined ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY id ${order} LIMIT ${limit}`).all(...params) as Row[];
    const events = rows.map(toEvent);
    return order === 'DESC' ? events.reverse() : events;
  }

  /** Newest first; `before` returns ids < before. nextBefore is the smallest returned id while older rows exist. */
  page(filter: { projectId?: string; before?: number; limit: number; level?: EventLevel; type?: string }): EventsPage {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.before !== undefined) { where.push('id < ?'); params.push(filter.before); }
    if (filter.level) { where.push('level = ?'); params.push(filter.level); }
    if (filter.type) { where.push('type = ?'); params.push(filter.type); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Math.trunc(filter.limit) || 1, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1) as Row[];
    const events = rows.slice(0, limit).map(toEvent);
    return { events, nextBefore: rows.length > limit ? events[events.length - 1].id : null };
  }

  latestForTask(taskId: string, type: string): StudioEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE task_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(taskId, type) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  lastForRole(projectId: string, role: AgentRole): StudioEvent | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE project_id = ? AND role = ? AND type != 'agent.output'
      ORDER BY id DESC LIMIT 1`).get(projectId, role) as Row | undefined;
    return row ? toEvent(row) : null;
  }
}

// ---------------------------------------------------------------- approvals

function toApproval(r: Row): Approval {
  return {
    id: String(r.id), projectId: String(r.project_id), taskId: str(r.task_id), kind: r.kind as ApprovalKind,
    status: r.status as ApprovalStatus, title: String(r.title), details: json(r.details, {}), note: str(r.note),
    createdAt: String(r.created_at), decidedAt: str(r.decided_at),
  };
}

export class ApprovalRepository {
  constructor(private readonly db: Db) {}

  create(input: { projectId: string; taskId: string | null; kind: ApprovalKind; title: string; details: Record<string, unknown> }): Approval {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO approvals (id, project_id, task_id, kind, status, title, details, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, input.projectId, input.taskId, input.kind, input.title, JSON.stringify(input.details), now());
    return this.get(id)!;
  }

  get(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  listByProject(projectId: string): Approval[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Row[]).map(toApproval);
  }

  pendingForTask(taskId: string): Approval | null {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE task_id = ? AND status = 'pending'`).get(taskId) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  decide(id: string, status: ApprovalStatus, note: string | null): Approval {
    this.db.prepare('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(status, note, now(), id);
    return this.get(id)!;
  }
}

// ---------------------------------------------------------------- agent messages

export class MessageRepository {
  constructor(private readonly db: Db) {}

  add(input: Omit<AgentMessage, 'id' | 'createdAt'>): AgentMessage {
    const result = this.db.prepare(`INSERT INTO agent_messages (project_id, role, task_id, direction, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(input.projectId, input.role, input.taskId, input.direction, redact(input.content), now());
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as Row;
    return this.map(row);
  }

  list(projectId: string, role: AgentRole, limit = 200): AgentMessage[] {
    const rows = this.db.prepare(`SELECT * FROM agent_messages WHERE project_id = ? AND role = ? ORDER BY id DESC LIMIT ?`)
      .all(projectId, role, limit) as Row[];
    return rows.map((r) => this.map(r)).reverse();
  }

  private map(r: Row): AgentMessage {
    return {
      id: Number(r.id), projectId: String(r.project_id), role: r.role as AgentRole, taskId: str(r.task_id),
      direction: r.direction as AgentMessage['direction'], content: String(r.content), createdAt: String(r.created_at),
    };
  }
}

// ---------------------------------------------------------------- configuration & usage

export interface ProviderConfigRow { id: string; enabled: boolean; settings: Record<string, string>; budgetUsd: number | null }

export class ConfigRepository {
  constructor(private readonly db: Db) {}

  getAgentConfigs(): AgentConfig[] {
    return (this.db.prepare('SELECT * FROM agent_configs').all() as Row[]).map((r) => ({
      role: r.role as AgentRole, providerId: String(r.provider_id), model: String(r.model), allowFallback: Boolean(r.allow_fallback),
      effort: (String(r.effort ?? '') as AgentConfig['effort']),
    }));
  }

  upsertAgentConfig(config: AgentConfig): void {
    this.db.prepare(`INSERT INTO agent_configs (role, provider_id, model, allow_fallback, effort) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, allow_fallback = excluded.allow_fallback,
      effort = excluded.effort`)
      .run(config.role, config.providerId, config.model, config.allowFallback ? 1 : 0, config.effort ?? '');
  }

  getProviderConfig(id: string): ProviderConfigRow | null {
    const r = this.db.prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return { id, enabled: Boolean(r.enabled), settings: json(r.settings, {}), budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd) };
  }

  upsertProviderConfig(config: ProviderConfigRow): void {
    this.db.prepare(`INSERT INTO provider_configs (id, enabled, settings, budget_usd) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, settings = excluded.settings, budget_usd = excluded.budget_usd`)
      .run(config.id, config.enabled ? 1 : 0, JSON.stringify(config.settings), config.budgetUsd);
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  /** Health check: true when the database answers a trivial query. */
  ping(): boolean {
    const r = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return Number(r?.ok) === 1;
  }
}

export interface UsageWindowRow {
  providerId: string; model: string | null; calls: number; inputTokens: number; outputTokens: number;
  /** SUM(cost_usd): null when no record reported a cost. */
  costUsd: number | null;
  /** COUNT(cost_usd): records that reported a cost. */
  costRows: number;
}

/** YYYY-MM-DD of an instant in the server's local time zone. */
export function localDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface UsageRecord {
  projectId: string | null; taskId: string | null; role: AgentRole | null; providerId: string; model: string | null; usage: UsageInfo;
  /** Workspace session that made the call (V2); null for task runs, chat and tests. */
  sessionId?: string | null;
  /** Workflow run of the task that made the call (V2 Phase 4); null without a task. */
  runId?: string | null;
}

export class UsageRepository {
  constructor(private readonly db: Db) {}

  record(input: UsageRecord): void {
    this.db.prepare(`INSERT INTO usage_records (project_id, task_id, role, provider_id, model, input_tokens, output_tokens, cost_usd, created_at,
      session_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.projectId, input.taskId, input.role, input.providerId, input.model,
      input.usage.inputTokens, input.usage.outputTokens, input.usage.costUsd, now(), input.sessionId ?? null, input.runId ?? null);
  }

  /** Summed usage of one workspace session; null when it made no recorded call. */
  totalsForSession(sessionId: string): UsageInfo | null {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, SUM(cost_usd) AS c
      FROM usage_records WHERE session_id = ?`).get(sessionId) as { n: number; i: number; o: number; c: number | null };
    if (!Number(r.n)) return null;
    return { inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: r.c === null ? null : Number(r.c) };
  }

  /** Calls, tokens and cost per provider since the given ISO time (e.g. local midnight). */
  sinceByProvider(sinceIso: string): Map<string, { calls: number; tokens: number; cost: number }> {
    const rows = this.db.prepare(`SELECT provider_id, COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens), 0) AS t,
      COALESCE(SUM(cost_usd), 0) AS c FROM usage_records WHERE created_at >= ? GROUP BY provider_id`).all(sinceIso) as Row[];
    return new Map(rows.map((r) => [String(r.provider_id), { calls: Number(r.n), tokens: Number(r.t), cost: Number(r.c) }]));
  }

  spentByProvider(providerId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_records WHERE provider_id = ?').get(providerId) as { s: number };
    return Number(r.s);
  }

  totalsForTask(taskId: string): UsageInfo | null {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, SUM(cost_usd) AS c
      FROM usage_records WHERE task_id = ?`).get(taskId) as { n: number; i: number; o: number; c: number | null };
    if (!Number(r.n)) return null;
    return { inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: r.c === null ? null : Number(r.c) };
  }

  totalsForRole(projectId: string, role: AgentRole): UsageInfo {
    const r = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, SUM(cost_usd) AS c
      FROM usage_records WHERE project_id = ? AND role = ?`).get(projectId, role) as { i: number; o: number; c: number | null };
    return { inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: r.c === null ? null : Number(r.c) };
  }

  summary(): { providerId: string; model: string | null; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[] {
    return (this.db.prepare(`SELECT provider_id, model, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
      COALESCE(SUM(cost_usd),0) AS c FROM usage_records GROUP BY provider_id, model ORDER BY c DESC`).all() as Row[]).map((r) => ({
      providerId: String(r.provider_id), model: str(r.model), calls: Number(r.n), inputTokens: Number(r.i),
      outputTokens: Number(r.o), costUsd: Number(r.c),
    }));
  }

  /** Usage per provider + model with from <= created_at <= to (ISO UTC strings compare chronologically). */
  window(fromIso: string, toIso: string): UsageWindowRow[] {
    return (this.db.prepare(`SELECT provider_id, model, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i,
      COALESCE(SUM(output_tokens), 0) AS o, SUM(cost_usd) AS c, COUNT(cost_usd) AS cn FROM usage_records
      WHERE created_at >= ? AND created_at <= ? GROUP BY provider_id, model`).all(fromIso, toIso) as Row[]).map((r) => ({
      providerId: String(r.provider_id), model: str(r.model), calls: Number(r.n), inputTokens: Number(r.i),
      outputTokens: Number(r.o), costUsd: r.c === null ? null : Number(r.c), costRows: Number(r.cn),
    }));
  }

  /** Input + output tokens with from <= created_at < to (an earlier window that ends where the next one starts). */
  tokensBetween(fromIso: string, toIso: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM usage_records
      WHERE created_at >= ? AND created_at < ?`).get(fromIso, toIso) as { t: number };
    return Number(r.t);
  }

  /**
   * Tokens per server-local day with from <= created_at <= to, oldest first; days without usage are omitted.
   * created_at is ISO UTC, so SQL groups by UTC minute (every real time-zone offset is a whole number of minutes)
   * and each minute is assigned to its local day here — exact, and at most 1440 rows per day.
   */
  byDay(fromIso: string, toIso: string): { date: string; totalTokens: number }[] {
    const rows = this.db.prepare(`SELECT substr(created_at, 1, 16) AS m, SUM(input_tokens + output_tokens) AS t FROM usage_records
      WHERE created_at >= ? AND created_at <= ? GROUP BY m ORDER BY m`).all(fromIso, toIso) as Row[];
    const days = new Map<string, number>();
    for (const r of rows) {
      const date = localDate(new Date(`${String(r.m)}:00.000Z`));
      days.set(date, (days.get(date) ?? 0) + Number(r.t));
    }
    return [...days].map(([date, totalTokens]) => ({ date, totalTokens }));
  }
}

// ---------------------------------------------------------------- V2 agent sessions

/** A session row with the two persisted columns the shared API type does not expose. */
export interface StoredSession extends AgentSession {
  baseCommit: string | null;
  /** Claude session id / Codex thread id; null until the provider reports one (or after a provider change). */
  providerSessionRef: string | null;
}

const MAX_TURN_TEXT = 200 * 1024;

/** Safe against hand-edited or corrupt JSON columns: falls back instead of throwing. */
function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toSession(r: Row): StoredSession {
  return {
    id: String(r.id), projectId: String(r.project_id), number: Number(r.number), title: String(r.title), role: r.role as AgentRole,
    providerId: String(r.provider_id), model: String(r.model), effort: String(r.effort ?? '') as EffortLevel,
    allowFallback: Boolean(r.allow_fallback), mode: r.mode as SessionMode, cwdKind: r.cwd_kind as AgentSession['cwdKind'],
    branch: str(r.branch), worktreePath: str(r.worktree_path), baseCommit: str(r.base_commit),
    continuity: r.continuity as SessionContinuity, providerSessionRef: str(r.provider_session_ref), taskId: str(r.task_id),
    status: r.status as SessionStatus, queuePosition: null, lastError: str(r.last_error), lastActivityAt: str(r.last_activity_at),
    createdAt: String(r.created_at), closedAt: str(r.closed_at),
  };
}

function toTurn(r: Row): SessionTurn {
  return {
    id: Number(r.id), sessionId: String(r.session_id), seq: Number(r.seq), author: r.author as SessionTurn['author'],
    text: String(r.text), activity: safeJson<string[]>(r.activity, []), providerId: str(r.provider_id),
    modelReported: str(r.model_reported), usage: safeJson<UsageInfo | null>(r.usage, null),
    filesChanged: safeJson<string[]>(r.files_changed, []), startedAt: String(r.started_at), finishedAt: str(r.finished_at),
    outcome: (str(r.outcome) as SessionTurn['outcome']), error: str(r.error),
  };
}

/** Redacts, then caps the text of a turn at 200 KB with a visible note. */
function turnText(text: string): string {
  const clean = redact(text);
  return clean.length > MAX_TURN_TEXT ? `${clean.slice(0, MAX_TURN_TEXT)}\n\n[truncated: the text exceeded 200 KB]` : clean;
}

export interface NewSession {
  projectId: string;
  /** Defaults to "Session <number>". */
  title?: string;
  role: AgentRole;
  providerId: string;
  model: string;
  effort?: EffortLevel;
  allowFallback?: boolean;
  mode: SessionMode;
  cwdKind: AgentSession['cwdKind'];
  branch?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  continuity?: SessionContinuity;
  taskId?: string | null;
  status?: SessionStatus;
}

export type SessionPatch = Partial<Pick<StoredSession,
  'title' | 'role' | 'providerId' | 'model' | 'effort' | 'allowFallback' | 'mode' | 'cwdKind' | 'branch' | 'worktreePath' | 'baseCommit'
  | 'continuity' | 'providerSessionRef' | 'taskId' | 'status' | 'lastError' | 'lastActivityAt' | 'closedAt'>>;

const SESSION_COLUMNS: Record<keyof SessionPatch, string> = {
  title: 'title', role: 'role', providerId: 'provider_id', model: 'model', effort: 'effort', allowFallback: 'allow_fallback',
  mode: 'mode', cwdKind: 'cwd_kind', branch: 'branch', worktreePath: 'worktree_path', baseCommit: 'base_commit',
  continuity: 'continuity', providerSessionRef: 'provider_session_ref', taskId: 'task_id', status: 'status', lastError: 'last_error',
  lastActivityAt: 'last_activity_at', closedAt: 'closed_at',
};

export interface NewTurn {
  sessionId: string;
  author: SessionTurn['author'];
  text: string;
  activity?: string[];
  providerId?: string | null;
  modelReported?: string | null;
  usage?: UsageInfo | null;
  filesChanged?: string[];
  startedAt?: string;
  finishedAt?: string | null;
  outcome?: SessionTurn['outcome'];
  error?: string | null;
}

export type TurnPatch = Partial<Pick<SessionTurn,
  'text' | 'activity' | 'providerId' | 'modelReported' | 'usage' | 'filesChanged' | 'finishedAt' | 'outcome' | 'error'>>;

const TURN_COLUMNS: Record<keyof TurnPatch, string> = {
  text: 'text', activity: 'activity', providerId: 'provider_id', modelReported: 'model_reported', usage: 'usage',
  filesChanged: 'files_changed', finishedAt: 'finished_at', outcome: 'outcome', error: 'error',
};

export class SessionRepository {
  constructor(private readonly db: Db) {}

  /** Inserts the session with the next per-project number (closed sessions keep their number). */
  create(input: NewSession): StoredSession {
    const id = randomUUID();
    const row = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM agent_sessions WHERE project_id = ?').get(input.projectId) as { n: number };
    const number = Number(row.n);
    this.db.prepare(`INSERT INTO agent_sessions (id, project_id, number, title, role, provider_id, model, effort, allow_fallback, mode,
      cwd_kind, branch, worktree_path, base_commit, continuity, task_id, status, last_activity_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, number, redact(input.title?.trim() || `Session ${number}`), input.role, input.providerId, input.model,
        input.effort ?? '', input.allowFallback ? 1 : 0, input.mode, input.cwdKind, input.branch ?? null, input.worktreePath ?? null,
        input.baseCommit ?? null, input.continuity ?? 'replay', input.taskId ?? null, input.status ?? 'idle', null, now());
    return this.get(id)!;
  }

  get(id: string): StoredSession | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSession(row) : null;
  }

  /** Oldest session first; closed sessions are left out unless `includeClosed` is set. */
  listByProject(projectId: string, options: { includeClosed?: boolean } = {}): StoredSession[] {
    const closed = options.includeClosed ? '' : " AND status != 'closed'";
    return (this.db.prepare(`SELECT * FROM agent_sessions WHERE project_id = ?${closed} ORDER BY number`).all(projectId) as Row[]).map(toSession);
  }

  /** Across all projects (crash recovery of queued/running sessions). */
  listByStatus(...statuses: SessionStatus[]): StoredSession[] {
    if (!statuses.length) return [];
    const marks = statuses.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM agent_sessions WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses) as Row[]).map(toSession);
  }

  update(id: string, patch: SessionPatch): StoredSession {
    const keys = (Object.keys(patch) as (keyof SessionPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length) {
      const sets = keys.map((k) => `${SESSION_COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => {
        const value = patch[k];
        if (k === 'allowFallback') return value ? 1 : 0;
        if ((k === 'title' || k === 'lastError') && typeof value === 'string') return redact(value);
        return (value ?? null) as string | number | null;
      });
      this.db.prepare(`UPDATE agent_sessions SET ${sets} WHERE id = ?`).run(...values, id);
    }
    return this.get(id)!;
  }

  addTurn(input: NewTurn): SessionTurn {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM session_turns WHERE session_id = ?').get(input.sessionId) as { s: number };
    const result = this.db.prepare(`INSERT INTO session_turns (session_id, seq, author, text, activity, provider_id, model_reported, usage,
      files_changed, started_at, finished_at, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.sessionId, Number(row.s), input.author, turnText(input.text), JSON.stringify((input.activity ?? []).map(redact)),
        input.providerId ?? null, input.modelReported ?? null, input.usage ? JSON.stringify(input.usage) : null,
        JSON.stringify(input.filesChanged ?? []), input.startedAt ?? now(), input.finishedAt ?? null, input.outcome ?? null,
        input.error ? redact(input.error) : null);
    return this.getTurn(Number(result.lastInsertRowid))!;
  }

  getTurn(id: number): SessionTurn | null {
    const row = this.db.prepare('SELECT * FROM session_turns WHERE id = ?').get(id) as Row | undefined;
    return row ? toTurn(row) : null;
  }

  updateTurn(id: number, patch: TurnPatch): SessionTurn {
    const keys = (Object.keys(patch) as (keyof TurnPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length) {
      const sets = keys.map((k) => `${TURN_COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => {
        const value = patch[k];
        if (k === 'text') return turnText(String(value));
        if (k === 'activity') return JSON.stringify((value as string[]).map(redact));
        if (k === 'filesChanged' || k === 'usage') return value === null ? null : JSON.stringify(value);
        if (k === 'error') return value === null ? null : redact(String(value));
        return (value ?? null) as string | number | null;
      });
      this.db.prepare(`UPDATE session_turns SET ${sets} WHERE id = ?`).run(...values, id);
    }
    return this.getTurn(id)!;
  }

  /**
   * One page of turns, oldest first within the page. Without `before` it is the newest `limit` turns; with `before`
   * (a turn `seq`) it is the `limit` turns just older than that. Load the next older page with the first seq returned.
   */
  listTurns(sessionId: string, options: { before?: number; limit: number }): SessionTurn[] {
    const limit = Math.min(Math.max(Math.trunc(options.limit) || 1, 1), 500);
    const rows = options.before === undefined
      ? this.db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, limit)
      : this.db.prepare('SELECT * FROM session_turns WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(sessionId, options.before, limit);
    return (rows as Row[]).map(toTurn).reverse();
  }

  /** Turns that never finished (a crash or restart interrupted them), across all sessions. */
  listUnfinishedTurns(): SessionTurn[] {
    return (this.db.prepare("SELECT * FROM session_turns WHERE finished_at IS NULL AND author = 'agent' ORDER BY id").all() as Row[]).map(toTurn);
  }

  /** The saved layout of a project's workspace; null when none was saved or the stored JSON is unreadable. */
  getLayout(projectId: string): WorkspaceLayout | null {
    const row = this.db.prepare('SELECT layout FROM workspace_layouts WHERE project_id = ?').get(projectId) as { layout: string } | undefined;
    return row ? safeJson<WorkspaceLayout | null>(row.layout, null) : null;
  }

  saveLayout(projectId: string, layout: WorkspaceLayout): void {
    this.db.prepare(`INSERT INTO workspace_layouts (project_id, layout, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`)
      .run(projectId, JSON.stringify(layout), now());
  }
}

export interface Repositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  messages: MessageRepository;
  config: ConfigRepository;
  usage: UsageRepository;
  sessions: SessionRepository;
  runs: RunRepository;
  workflows: WorkflowRepository;
  findings: FindingRepository;
  /** Read-only queries of the V2 read models (readModels/logs.ts, usage.ts); writes go through the repositories. */
  db: Db;
}

export function createRepositories(db: Db): Repositories {
  return {
    projects: new ProjectRepository(db), tasks: new TaskRepository(db), events: new EventRepository(db),
    approvals: new ApprovalRepository(db), messages: new MessageRepository(db), config: new ConfigRepository(db),
    usage: new UsageRepository(db), sessions: new SessionRepository(db), runs: new RunRepository(db),
    workflows: new WorkflowRepository(db), findings: new FindingRepository(db), db,
  };
}
