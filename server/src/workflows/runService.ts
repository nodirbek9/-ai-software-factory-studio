import type {
  Project, Run, RunNodeStatus, RunsPage, RunTimeline, RunTimelineEntry, SimulationResult, Task, TaskStatus, ValidationResult, Workflow,
  WorkflowGraph,
} from '@asf/shared';
import { AGENT_ROLES } from '@asf/shared';
import { transaction, type Db } from '../db/database.ts';
import { ACTIVE_RUN_STATUSES } from '../db/runRepositories.ts';
import { getSettings, type StudioContext } from '../orchestrator/context.ts';
import type { TaskScheduler } from '../orchestrator/scheduler.ts';
import { approvedCommands } from '../orchestrator/taskRunners.ts';
import { isAllowedCommand } from '../workspace/commandRunner.ts';
import { headCommit } from '../workspace/git.ts';
import { compileWorkflow, type CompileContext } from './compile.ts';
import { TASK_NODE_TYPES, validateWorkflow, type ValidationContext } from './validate.ts';

// RunService (WORKFLOW_ENGINE_SPEC.md §7): starts, cancels and reads workflow runs. A run is a compiled workflow snapshot
// whose tasks the V1 scheduler executes; the project row keeps one status (= the latest run's, P4-5).

/** A refusal the API maps to an HTTP status; `validation` is sent along for 400/422 workflow errors. */
export class RunError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 422, readonly validation: ValidationResult | null = null) {
    super(message);
  }
}

export interface StartRunOptions {
  trigger?: 'manual';
  /** Review diff base; absent = project.baseCommit. */
  baseCommit?: string | null;
  /** Provider and command checks for the validator; absent = not checked. */
  validation?: ValidationContext;
}

const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };
const MAX_RUNS_PAGE = 50;
const TIMELINE_LIMIT = 500;
/** Node status = the first of these its tasks have; 'completed' only when all are completed. */
const NODE_STATUS_PRIORITY: TaskStatus[] = ['running', 'waiting_approval', 'failed', 'ready', 'pending', 'blocked', 'cancelled'];
const UNFINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['pending', 'ready', 'running', 'waiting_approval']);
/** Runtime fix tasks (fixLoop.ts): fix-<verification key>-<round>. */
const FIX_KEY = /^fix-(.+)-\d+$/;

const firstErrorMessage = (validation: ValidationResult): string => validation.errors[0]?.message ?? 'unknown error';

// ------------------------------------------------------------------ timeline helpers

/** The node a task belongs to; fix tasks (no nodeId) map to the Fix node that loops back to their verification node. */
function nodeOfTask(task: Task, graph: WorkflowGraph, byKey: Map<string, Task>): string | null {
  if (task.nodeId) return task.nodeId;
  const match = FIX_KEY.exec(task.key);
  const verifiedNode = match ? byKey.get(match[1])?.nodeId : null;
  if (!verifiedNode) return null;
  return graph.edges.find((e) => e.kind === 'retry' && e.target === verifiedNode)?.source ?? null;
}

/** Tasks per node: every task-producing or Fix node of the graph (in graph order), plus nodes only tasks mention. */
function groupByNode(graph: WorkflowGraph, tasks: Task[], nodeOf: (task: Task) => string | null): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const node of graph.nodes) {
    if (TASK_NODE_TYPES.has(node.type) || node.type === 'fix') groups.set(node.id, []);
  }
  for (const task of tasks) {
    const nodeId = nodeOf(task);
    if (!nodeId) continue;
    if (!groups.has(nodeId)) groups.set(nodeId, []);
    groups.get(nodeId)!.push(task);
  }
  return groups;
}

function aggregateStatus(tasks: Task[]): RunNodeStatus['status'] {
  if (!tasks.length) return 'not_started';
  if (tasks.every((t) => t.status === 'completed')) return 'completed';
  return NODE_STATUS_PRIORITY.find((status) => tasks.some((t) => t.status === status)) ?? 'completed';
}

const earliest = (values: (string | null)[]): string | null =>
  values.filter((v): v is string => Boolean(v)).sort()[0] ?? null;
const latest = (values: (string | null)[]): string | null =>
  values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;

function nodeStatus(nodeId: string, tasks: Task[], costs: Map<string, number | null>): RunNodeStatus {
  const startedAt = earliest(tasks.map((t) => t.startedAt));
  const finishedAt = tasks.length && !tasks.some((t) => UNFINISHED.has(t.status)) ? latest(tasks.map((t) => t.finishedAt)) : null;
  const measured = tasks.map((t) => costs.get(t.id)).filter((c): c is number => typeof c === 'number');
  const lastRun = [...tasks].filter((t) => t.providerId).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).at(-1);
  return {
    nodeId,
    taskKeys: tasks.map((t) => t.key),
    status: aggregateStatus(tasks),
    startedAt,
    finishedAt,
    durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    attempts: tasks.reduce((sum, t) => sum + t.attempt, 0),
    providerId: lastRun?.providerId ?? null,
    model: lastRun?.model ?? null,
    costUsd: measured.length ? measured.reduce((sum, c) => sum + c, 0) : null,
    error: tasks.find((t) => t.status === 'failed')?.error ?? null,
  };
}

// ------------------------------------------------------------------ service

export class RunService {
  constructor(private readonly ctx: StudioContext, private readonly scheduler: TaskScheduler, private readonly db: Db) {}

  /**
   * The API start path: the review diff base is the integration HEAD right now, and the validator checks providers and
   * commands. Then the same synchronous start as the V1 "Start planning" button.
   */
  async startChecked(projectId: string, workflowId: string, trigger: 'manual' = 'manual'): Promise<Run> {
    const project = this.requireProject(projectId);
    const head = project.integrationPath ? await headCommit(project.integrationPath).catch(() => null) : null;
    const validation = await this.validationContext(projectId);
    return this.start(projectId, workflowId, { trigger, baseCommit: head ?? project.baseCommit, validation });
  }

  /** Creates run N of the project from the workflow, inserts its start tasks and lets the scheduler run them. */
  start(projectId: string, workflowId: string, options: StartRunOptions = {}): Run {
    const project = this.requireProject(projectId);
    const workflow = this.requireWorkflow(workflowId, projectId);
    if (workflow.archived) throw new RunError(`The workflow "${workflow.name}" is archived`, 409);
    this.assertNoActiveRun(project);
    const validation = validateWorkflow(workflow.graph, options.validation);
    if (!validation.ok) throw new RunError(`The workflow "${workflow.name}" is not valid: ${firstErrorMessage(validation)}`, 422, validation);
    const compiled = compileWorkflow(workflow.graph, this.compileContext(project));
    if (!compiled.tasks.length) {
      const empty: ValidationResult = { ok: false, warnings: validation.warnings,
        errors: [{ code: 'E_CONFIG', severity: 'error', message: 'The workflow has no steps that run (add an agent, tool or approval node)' }] };
      throw new RunError(`The workflow "${workflow.name}" is not valid: ${firstErrorMessage(empty)}`, 422, empty);
    }
    const planning = compiled.tasks.some((t) => t.kind === 'plan' || t.kind === 'architecture');
    const status = planning ? 'planning' : 'running';
    const created = transaction(this.db, () => {
      const run = this.ctx.repos.runs.create({
        projectId, workflowId: workflow.id, workflowName: workflow.name, workflowVersion: workflow.version, snapshot: workflow.graph,
        trigger: options.trigger ?? 'manual', baseCommit: options.baseCommit ?? project.baseCommit, status,
      });
      for (const task of compiled.tasks) this.ctx.repos.tasks.create(projectId, { ...task, runId: run.id });
      return run;
    });
    const run = this.ctx.repos.runs.get(created.id)!;
    this.ctx.events.emit({ projectId, type: 'run.created', message: `Run #${run.number} started: ${run.workflowName}`, data: { run } });
    this.scheduler.setProjectStatus(project, status, planning ? `Planning started (run #${run.number})` : `Run #${run.number} started`);
    this.scheduler.tick(projectId);
    return this.ctx.repos.runs.get(run.id)!;
  }

  /** V1 cancelProject semantics for the project's active run (aborts running tasks, cancels the rest). */
  cancel(runId: string): Run {
    const run = this.get(runId);
    const active = this.ctx.repos.runs.activeForProject(run.projectId);
    if (!active || active.id !== run.id) throw new RunError(`Run #${run.number} is not active (${run.status.replaceAll('_', ' ')})`, 409);
    this.scheduler.cancelProject(run.projectId);
    return this.get(runId);
  }

  list(projectId: string, options: { limit?: number; before?: number } = {}): RunsPage {
    this.requireProject(projectId);
    return this.ctx.repos.runs.listByProject(projectId, { limit: Math.min(options.limit ?? 20, MAX_RUNS_PAGE), before: options.before });
  }

  get(runId: string): Run {
    const run = this.ctx.repos.runs.get(runId);
    if (!run) throw new RunError('Run not found', 404);
    return run;
  }

  /** Per-node status aggregated from the run's tasks, plus the run's events (newest 500, in id order). */
  timeline(runId: string): RunTimeline {
    const run = this.get(runId);
    const graph = this.ctx.repos.runs.snapshot(runId) ?? EMPTY_GRAPH;
    const tasks = this.ctx.repos.tasks.listByRun(runId);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const nodeOf = (task: Task): string | null => nodeOfTask(task, graph, byKey);
    const costs = this.taskCosts(runId);
    const nodes = [...groupByNode(graph, tasks, nodeOf)].map(([nodeId, own]) => nodeStatus(nodeId, own, costs));
    return { run, graph, nodes, tasks, entries: this.timelineEntries(run, tasks, nodeOf) };
  }

  /** Validate + compile; nothing starts. Tasks = the start tasks followed by the skeleton tail. */
  simulate(workflowId: string, validation?: ValidationContext): SimulationResult {
    const workflow = this.requireWorkflow(workflowId);
    const result = validateWorkflow(workflow.graph, validation);
    if (!result.ok) return { validation: result, tasks: [], notes: [] };
    const project = workflow.projectId ? this.ctx.repos.projects.get(workflow.projectId) : null;
    const compiled = compileWorkflow(workflow.graph, {
      maxAttempts: getSettings(this.ctx).defaultMaxAttempts, testCommand: project?.testCommand ?? 'npm test',
    });
    const notes = [...compiled.notes];
    const { decomposeKey } = compiled.skeleton;
    if (decomposeKey) {
      notes.unshift(`The PM's tasks are added when "${decomposeKey}" completes; the steps after the implementation slots wait for them.`);
    }
    return { validation: result, tasks: [...compiled.tasks, ...compiled.skeleton.tail], notes };
  }

  /** Provider availability per role (fallback on = available) and the command allowlist (+ the project's approved commands). */
  async validationContext(projectId: string | null): Promise<ValidationContext> {
    const providers = await Promise.all(AGENT_ROLES.map(async (role) => {
      const config = this.ctx.registry.agentConfig(role);
      const available = !config || config.allowFallback || (await this.ctx.registry.unusableReason(config.providerId)) === null;
      return { role, available };
    }));
    const approved = projectId ? approvedCommands(this.ctx, projectId) : [];
    return { providers, isCommandAllowed: (command) => isAllowedCommand(command) || approved.includes(command.trim()) };
  }

  /** A workflow visible to the project (global or its own); unknown and foreign ones are 404. */
  requireWorkflow(workflowId: string, projectId?: string): Workflow {
    const workflow = this.ctx.repos.workflows.get(workflowId);
    if (!workflow || (projectId && workflow.projectId && workflow.projectId !== projectId)) throw new RunError('Workflow not found', 404);
    return workflow;
  }

  private requireProject(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId);
    if (!project) throw new RunError('Project not found', 404);
    return project;
  }

  /** One active run per project (P4-5); a completed, failed or cancelled project may start its next run. */
  private assertNoActiveRun(project: Project): void {
    const active = this.ctx.repos.runs.activeForProject(project.id);
    if (active) throw new RunError(`Run #${active.number} is still ${active.status.replaceAll('_', ' ')}; cancel it or wait for it to finish`, 409);
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(project.status)) {
      throw new RunError(`The project is ${project.status.replaceAll('_', ' ')}; a new run can start when it has stopped`, 409);
    }
    if (this.scheduler.hasActiveTasks(project.id)) throw new RunError('Tasks of the previous run are still stopping; try again shortly', 409);
  }

  private compileContext(project: Project): CompileContext {
    return { maxAttempts: getSettings(this.ctx).defaultMaxAttempts, testCommand: project.testCommand };
  }

  /** Measured cost per task of the run (null when no call of the task reported cost). */
  private taskCosts(runId: string): Map<string, number | null> {
    const rows = this.db.prepare(`SELECT task_id, SUM(cost_usd) AS c FROM usage_records
      WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) GROUP BY task_id`).all(runId) as { task_id: string; c: number | null }[];
    return new Map(rows.map((r) => [String(r.task_id), r.c === null ? null : Number(r.c)]));
  }

  /** Events of the run's tasks and of the run itself; streamed agent output is left out (it would crowd out the rest). */
  private timelineEntries(run: Run, tasks: Task[], nodeOf: (task: Task) => string | null): RunTimelineEntry[] {
    const rows = this.db.prepare(`SELECT id, created_at, type, level, message, task_id FROM events
      WHERE (task_id IN (SELECT id FROM tasks WHERE run_id = ?) AND type != 'agent.output')
        OR (project_id = ? AND type IN ('run.created', 'run.updated')
          AND CASE WHEN json_valid(data) THEN json_extract(data, '$.run.id') END = ?)
      ORDER BY id DESC LIMIT ?`).all(run.id, run.projectId, run.id, TIMELINE_LIMIT) as Record<string, unknown>[];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return rows.reverse().map((r) => {
      const taskId = r.task_id === null ? null : String(r.task_id);
      const task = taskId ? byId.get(taskId) : undefined;
      return {
        id: Number(r.id), at: String(r.created_at), type: String(r.type), level: r.level as RunTimelineEntry['level'],
        message: String(r.message), taskId, nodeId: task ? nodeOf(task) : null,
      };
    });
  }
}
