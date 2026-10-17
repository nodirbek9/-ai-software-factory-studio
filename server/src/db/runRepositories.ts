import { randomUUID } from 'node:crypto';
import type { Run, RunsListPage, RunsPage, RunStatus, SaveWorkflowInput, Workflow, WorkflowGraph, WorkflowSummary } from '@asf/shared';
import { STANDARD_WORKFLOW_ID } from '@asf/shared';
import type { Db } from './database.ts';

// Workflow runs and stored workflow graphs (WORKFLOW_ENGINE_SPEC.md §2, PHASE_4 P4-2).

type Row = Record<string, unknown>;

const now = (): string => new Date().toISOString();
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };
const STANDARD_NAME = 'Standard Software Factory';

/** Run statuses that block a new run of the same project (P4-5). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['planning', 'awaiting_approval', 'running', 'paused'];

function parseGraph(value: unknown): WorkflowGraph {
  if (typeof value !== 'string' || !value) return EMPTY_GRAPH;
  try {
    return JSON.parse(value) as WorkflowGraph;
  } catch {
    return EMPTY_GRAPH;
  }
}

/** A workflow store refusal the API maps to an HTTP status. */
export class WorkflowStoreError extends Error {
  constructor(message: string, readonly statusCode: 403 | 404) {
    super(message);
  }
}

// ---------------------------------------------------------------- runs

const RUN_SELECT = `SELECT r.*, w.name AS live_name,
  (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id) AS tasks_total,
  (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.status = 'completed') AS tasks_completed,
  (SELECT SUM(u.cost_usd) FROM usage_records u WHERE u.run_id = r.id) AS cost
  FROM runs r LEFT JOIN workflows w ON w.id = r.workflow_id`;

function runWorkflowName(r: Row): string {
  const live = str(r.live_name);
  if (live) return live;
  const stored = String(r.workflow_name ?? '');
  if (stored) return stored;
  return r.workflow_id === STANDARD_WORKFLOW_ID ? STANDARD_NAME : 'Workflow';
}

function toRun(r: Row): Run {
  const startedAt = String(r.started_at);
  const finishedAt = str(r.finished_at);
  return {
    id: String(r.id), projectId: String(r.project_id), number: Number(r.number), workflowId: str(r.workflow_id),
    workflowName: runWorkflowName(r), workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
    status: r.status as RunStatus, trigger: r.trigger as Run['trigger'], baseCommit: str(r.base_commit), startedAt, finishedAt,
    errorSummary: str(r.error_summary), durationMs: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    costUsd: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    tasksTotal: Number(r.tasks_total), tasksCompleted: Number(r.tasks_completed),
  };
}

export interface NewRun {
  projectId: string;
  workflowId: string | null;
  /** Defaults to the stored workflow's name. */
  workflowName?: string;
  workflowVersion: number | null;
  snapshot: WorkflowGraph;
  trigger: Run['trigger'];
  baseCommit: string | null;
  /** Defaults to 'planning'. */
  status?: RunStatus;
}

export type RunPatch = Partial<Pick<Run, 'status' | 'finishedAt' | 'errorSummary' | 'baseCommit'>>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: 'status', finishedAt: 'finished_at', errorSummary: 'error_summary', baseCommit: 'base_commit',
};

export class RunRepository {
  constructor(private readonly db: Db) {}

  /** Inserts the run with the next per-project number. */
  create(input: NewRun): Run {
    const id = randomUUID();
    const row = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM runs WHERE project_id = ?').get(input.projectId) as { n: number };
    const name = input.workflowName ?? this.storedWorkflowName(input.workflowId);
    this.db.prepare(`INSERT INTO runs (id, project_id, number, workflow_id, workflow_name, workflow_version, workflow_snapshot, status,
      "trigger", base_commit, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, Number(row.n), input.workflowId, name, input.workflowVersion, JSON.stringify(input.snapshot),
        input.status ?? 'planning', input.trigger, input.baseCommit, now());
    return this.get(id)!;
  }

  get(id: string): Run | null {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Newest first; `before` is a run number. nextBefore is the smallest returned number while older runs exist. */
  listByProject(projectId: string, options: { limit?: number; before?: number } = {}): RunsPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 1, 1), 200);
    const rows = (options.before === undefined
      ? this.db.prepare(`${RUN_SELECT} WHERE r.project_id = ? ORDER BY r.number DESC LIMIT ?`).all(projectId, limit + 1)
      : this.db.prepare(`${RUN_SELECT} WHERE r.project_id = ? AND r.number < ? ORDER BY r.number DESC LIMIT ?`)
        .all(projectId, options.before, limit + 1)) as Row[];
    const runs = rows.slice(0, limit).map(toRun);
    return { runs, nextBefore: rows.length > limit ? runs[runs.length - 1].number : null };
  }

  /** Runs across projects, newest start first, optionally one project and/or one status; `before` is a startedAt cursor. */
  listAll(options: { projectId?: string; status?: RunStatus; limit?: number; before?: string } = {}): RunsListPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 1, 1), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.projectId) { where.push('r.project_id = ?'); params.push(options.projectId); }
    if (options.status) { where.push('r.status = ?'); params.push(options.status); }
    if (options.before) { where.push('r.started_at < ?'); params.push(options.before); }
    const sql = `${RUN_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.started_at DESC, r.number DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as Row[];
    const runs = rows.slice(0, limit).map(toRun);
    return { runs, nextBefore: rows.length > limit ? runs[runs.length - 1].startedAt : null };
  }

  latestForProject(projectId: string): Run | null {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.project_id = ? ORDER BY r.number DESC LIMIT 1`).get(projectId) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** The newest run that is still planning, running, awaiting approval or paused. */
  activeForProject(projectId: string): Run | null {
    const marks = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.project_id = ? AND r.status IN (${marks}) ORDER BY r.number DESC LIMIT 1`)
      .get(projectId, ...ACTIVE_RUN_STATUSES) as Row | undefined;
    return row ? toRun(row) : null;
  }

  update(id: string, patch: RunPatch): Run {
    const keys = (Object.keys(patch) as (keyof RunPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length) {
      const sets = keys.map((k) => `${RUN_COLUMNS[k]} = ?`).join(', ');
      this.db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
    }
    return this.get(id)!;
  }

  /** The graph the run was started with (later edits of the workflow do not change it). */
  snapshot(id: string): WorkflowGraph | null {
    const row = this.db.prepare('SELECT workflow_snapshot FROM runs WHERE id = ?').get(id) as { workflow_snapshot: string } | undefined;
    return row ? parseGraph(row.workflow_snapshot) : null;
  }

  private storedWorkflowName(workflowId: string | null): string {
    if (!workflowId) return '';
    const row = this.db.prepare('SELECT name FROM workflows WHERE id = ?').get(workflowId) as { name: string } | undefined;
    return row?.name ?? (workflowId === STANDARD_WORKFLOW_ID ? STANDARD_NAME : '');
  }
}

// ---------------------------------------------------------------- workflows

function toSummary(r: Row, graph: WorkflowGraph): WorkflowSummary {
  return {
    id: String(r.id), projectId: str(r.project_id), name: String(r.name), description: String(r.description),
    version: Number(r.version), builtin: Boolean(r.builtin), archived: Boolean(r.archived), nodeCount: graph.nodes?.length ?? 0,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toWorkflow(r: Row): Workflow {
  const graph = parseGraph(r.graph);
  return { ...toSummary(r, graph), graph };
}

export interface BuiltinWorkflow {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
}

export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  /** Global templates plus the project's own (globals only without a project); builtin first, then by name. */
  list(options: { projectId?: string | null; includeArchived?: boolean } = {}): WorkflowSummary[] {
    const archived = options.includeArchived ? '' : ' AND archived = 0';
    const rows = (options.projectId
      ? this.db.prepare(`SELECT * FROM workflows WHERE (project_id IS NULL OR project_id = ?)${archived} ORDER BY builtin DESC, name, created_at`)
        .all(options.projectId)
      : this.db.prepare(`SELECT * FROM workflows WHERE project_id IS NULL${archived} ORDER BY builtin DESC, name, created_at`).all()) as Row[];
    return rows.map((r) => toSummary(r, parseGraph(r.graph)));
  }

  get(id: string): Workflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row | undefined;
    return row ? toWorkflow(row) : null;
  }

  create(input: SaveWorkflowInput): Workflow {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`INSERT INTO workflows (id, project_id, name, description, version, graph, builtin, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`)
      .run(id, input.projectId ?? null, input.name, input.description ?? '', JSON.stringify(input.graph), ts, ts);
    return this.get(id)!;
  }

  /** Saves a new version (version + 1); the stored project is kept. Builtin templates are read-only. */
  update(id: string, input: SaveWorkflowInput): Workflow {
    const current = this.editable(id);
    this.db.prepare('UPDATE workflows SET name = ?, description = ?, graph = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name, input.description ?? current.description, JSON.stringify(input.graph), now(), id);
    return this.get(id)!;
  }

  /** Hides the workflow from lists; runs keep its snapshot and name. Builtin templates cannot be archived. */
  archive(id: string): Workflow {
    this.editable(id);
    this.db.prepare('UPDATE workflows SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id);
    return this.get(id)!;
  }

  /** Inserts or re-syncs a builtin template from code; the version moves only when the graph changed. */
  ensureBuiltin(template: BuiltinWorkflow): Workflow {
    const graph = JSON.stringify(template.graph);
    const ts = now();
    const row = this.db.prepare('SELECT graph FROM workflows WHERE id = ?').get(template.id) as { graph: string } | undefined;
    if (!row) {
      this.db.prepare(`INSERT INTO workflows (id, project_id, name, description, version, graph, builtin, archived, created_at, updated_at)
        VALUES (?, NULL, ?, ?, 1, ?, 1, 0, ?, ?)`).run(template.id, template.name, template.description, graph, ts, ts);
    } else {
      const bump = row.graph === graph ? 0 : 1;
      this.db.prepare(`UPDATE workflows SET name = ?, description = ?, graph = ?, builtin = 1, archived = 0, project_id = NULL,
        version = version + ?, updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END WHERE id = ?`)
        .run(template.name, template.description, graph, bump, bump, ts, template.id);
    }
    return this.get(template.id)!;
  }

  private editable(id: string): Workflow {
    const workflow = this.get(id);
    if (!workflow) throw new WorkflowStoreError('Workflow not found', 404);
    if (workflow.builtin) throw new WorkflowStoreError('The built-in template is read-only; duplicate it to make changes', 403);
    return workflow;
  }
}
