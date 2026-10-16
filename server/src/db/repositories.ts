import { randomUUID } from 'node:crypto';
import type {
  AgentConfig, AgentMessage, AgentRole, Approval, ApprovalKind, ApprovalStatus, CheckpointStage, EventLevel,
  Project, ProjectStatus, StudioEvent, Task, TaskKind, TaskStatus, TestResult, UsageInfo,
} from '@asf/shared';
import type { Db } from './database.ts';
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
    id: String(r.id), projectId: String(r.project_id), key: String(r.key), title: String(r.title),
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
  key: string; title: string; description: string; role: AgentRole; kind: TaskKind;
  dependsOn: string[]; orderIndex: number; maxAttempts: number; status?: TaskStatus;
}

export type TaskPatch = Partial<Pick<Task,
  'status' | 'attempt' | 'maxAttempts' | 'checkpoint' | 'branch' | 'worktreePath' | 'providerId' | 'model' | 'resultSummary'
  | 'error' | 'filesChanged' | 'testResult' | 'usage' | 'startedAt' | 'finishedAt' | 'dependsOn' | 'orderIndex'>>;

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status', attempt: 'attempt', maxAttempts: 'max_attempts', checkpoint: 'checkpoint', branch: 'branch',
  worktreePath: 'worktree_path', providerId: 'provider_id', model: 'model', resultSummary: 'result_summary', error: 'error',
  filesChanged: 'files_changed', testResult: 'test_result', usage: 'usage', startedAt: 'started_at', finishedAt: 'finished_at',
  dependsOn: 'depends_on', orderIndex: 'order_index',
};
const JSON_TASK_FIELDS = new Set<keyof TaskPatch>(['filesChanged', 'testResult', 'usage', 'dependsOn']);

export class TaskRepository {
  constructor(private readonly db: Db) {}

  create(projectId: string, input: NewTask): Task {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO tasks (id, project_id, key, title, description, role, kind, status, depends_on, order_index,
      max_attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, input.key, input.title, input.description, input.role, input.kind, input.status ?? 'pending',
        JSON.stringify(input.dependsOn), input.orderIndex, input.maxAttempts, now());
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  listByProject(projectId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY order_index, rowid').all(projectId) as Row[]).map(toTask);
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
}

export interface UsageRecord {
  projectId: string | null; taskId: string | null; role: AgentRole | null; providerId: string; model: string | null; usage: UsageInfo;
}

export class UsageRepository {
  constructor(private readonly db: Db) {}

  record(input: UsageRecord): void {
    this.db.prepare(`INSERT INTO usage_records (project_id, task_id, role, provider_id, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.projectId, input.taskId, input.role, input.providerId, input.model,
      input.usage.inputTokens, input.usage.outputTokens, input.usage.costUsd, now());
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
}

export interface Repositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  events: EventRepository;
  approvals: ApprovalRepository;
  messages: MessageRepository;
  config: ConfigRepository;
  usage: UsageRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    projects: new ProjectRepository(db), tasks: new TaskRepository(db), events: new EventRepository(db),
    approvals: new ApprovalRepository(db), messages: new MessageRepository(db), config: new ConfigRepository(db),
    usage: new UsageRepository(db),
  };
}
