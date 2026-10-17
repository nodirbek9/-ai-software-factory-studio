import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_ROLE_INFO, type AgentRole, type Approval, type Finding, type FindingQuery, type FindingsResponse, type GateState, type Project,
  type QualityGate, type QualityGateId, type QualityOverview, type ReleaseReadiness, type Run, type ScannerInfo, type Task,
  type TestRunRow, type UpdateFindingInput,
} from '@asf/shared';
import { transaction, type Db } from '../db/database.ts';
import { emitTask, getSettings, type StudioContext } from '../orchestrator/context.ts';
import { ProjectError, type AuditStarter } from '../orchestrator/projectService.ts';
import type { TaskScheduler } from '../orchestrator/scheduler.ts';
import { AUDIT_COMMAND, DEFAULT_AUDIT_DEPS, readLastAudit, runAudit, type AuditDeps, type LastAudit } from './audit.ts';

// QA & Security read model and actions (PHASE_6.md P6-2…P6-4, UI_SCREEN_SPECIFICATIONS.md §8): release-readiness gates
// per run, test runs, scanners, findings triage, "Create fix task" and the approval-gated npm audit.

const GATE_LABELS: Record<QualityGateId, string> = {
  build: 'Build', tests: 'Tests', security: 'Security review', review: 'Code review', audit: 'Dependency audit', coverage: 'Coverage',
};
/** The state a group of tasks shows: the first of these any task has; 'passed' only when all passed. */
const STATE_PRIORITY: GateState[] = ['failed', 'error', 'not_run', 'passed'];
const PLANNING_STATUSES: ReadonlySet<string> = new Set(['planning', 'awaiting_approval']);
const REOPEN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const DETAIL_MAX = 160;
const TITLE_MAX = 200;

interface TaskState {
  task: Task;
  state: GateState;
  detail: string;
}

const clip = (value: string, max = DETAIL_MAX): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function gate(id: QualityGateId, state: GateState, detail: string, taskId: string | null = null, at: string | null = null): QualityGate {
  return { id, label: GATE_LABELS[id], state, detail, taskId, at };
}

/** One gate from per-task states: the worst state wins; its tasks give the detail, the last of them the task and time. */
function combine(id: QualityGateId, states: TaskState[], none: string): QualityGate {
  if (!states.length) return gate(id, 'not_run', none);
  const state = STATE_PRIORITY.find((s) => states.some((t) => t.state === s)) ?? 'not_run';
  const deciding = states.filter((t) => t.state === state);
  const last = deciding.at(-1)!.task;
  return gate(id, state, deciding.map((t) => t.detail).join('; '), last.id, last.finishedAt);
}

function unfinished(task: Task): string {
  return `${task.key}: ${task.status.replaceAll('_', ' ')}`;
}

function buildState(task: Task): TaskState {
  if (task.status === 'completed') return { task, state: 'passed', detail: `${task.key}: ${task.options.command ?? ''} passed`.trim() };
  if (task.status !== 'failed') return { task, state: 'not_run', detail: unfinished(task) };
  const failed = /^Command failed/.test(task.error ?? '');
  return { task, state: failed ? 'failed' : 'error', detail: clip(`${task.key}: ${task.error ?? 'failed'}`) };
}

function testState(task: Task): TaskState {
  const result = task.testResult;
  if (result) return { task, state: result.passed ? 'passed' : 'failed', detail: `${task.key}: ${result.summary}` };
  if (task.status === 'failed') return { task, state: 'error', detail: clip(`${task.key}: ${task.error ?? 'failed before the tests ran'}`) };
  return { task, state: 'not_run', detail: unfinished(task) };
}

/** completed = PASS verdict; failed with the FAIL verdict (VerificationFailedError) = failed; any other failure = error. */
function verdictState(task: Task): TaskState {
  if (task.status === 'completed') return { task, state: 'passed', detail: `${task.key}: VERDICT PASS` };
  if (task.status !== 'failed') return { task, state: 'not_run', detail: unfinished(task) };
  if (/verdict: FAIL/i.test(task.error ?? '')) return { task, state: 'failed', detail: `${task.key}: VERDICT FAIL` };
  return { task, state: 'error', detail: clip(`${task.key}: ${task.error ?? 'failed'}`) };
}

function auditGate(run: Run, tasks: Task[], audit: LastAudit | null): QualityGate {
  if (!audit || Date.parse(audit.at) < Date.parse(run.startedAt)) {
    return gate('audit', 'not_run', 'No npm audit since this run started (it needs your approval: network access)');
  }
  // An audit only speaks for the code it saw: code changed by this run after it makes it stale (P7-S9).
  const changedAt = latestFinish(tasks.filter((t) => t.kind === 'implement' && t.status === 'completed'));
  if (changedAt && Date.parse(audit.at) < Date.parse(changedAt)) {
    return gate('audit', 'not_run', "The last npm audit is older than this run's latest code change; run it again", null, audit.at);
  }
  if (!audit.ok) return gate('audit', 'error', clip(`npm audit failed: ${audit.error ?? 'unknown error'}`), null, audit.at);
  const { critical, high, medium, low, info } = audit.counts;
  const detail = `npm audit: ${critical} critical, ${high} high, ${medium} medium, ${low} low, ${info} info`;
  return gate('audit', critical + high > 0 ? 'failed' : 'passed', detail, null, audit.at);
}

const isBuild = (task: Task): boolean => task.kind === 'command' && (task.options.command ?? '').includes('build');
const latestFinish = (tasks: Task[]): string | null => tasks.map((t) => t.finishedAt).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;

/** Frontend owns web/ and component files; everything else goes to Backend (P6-4). */
function fixRoleOf(file: string | null): 'frontend' | 'backend' {
  const normalized = (file ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return /^web\//i.test(normalized) || /\.(tsx|jsx|vue)$/i.test(normalized) ? 'frontend' : 'backend';
}

function fixDescription(finding: Finding): string {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : 'not given';
  return [
    `Fix this ${finding.source} finding (severity: ${finding.severity}).`,
    '',
    `Title: ${finding.title}`,
    `File: ${location}`,
    '',
    'Description:',
    finding.description || '(none)',
    '',
    'Recommendation:',
    finding.recommendation ?? '(none given — choose the smallest safe fix)',
    '',
    'Keep the change focused on this finding and keep the existing tests passing.',
  ].join('\n');
}

function nextFixKey(tasks: Task[]): string {
  const keys = new Set(tasks.map((t) => t.key));
  let n = 1;
  while (keys.has(`fix-finding-${n}`)) n += 1;
  return `fix-finding-${n}`;
}

export class QualityService implements AuditStarter {
  /** Injectable command runner for `npm audit` (tests replace it; they never reach the network). */
  auditDeps: AuditDeps = DEFAULT_AUDIT_DEPS;
  private readonly auditing = new Set<string>();

  constructor(private readonly ctx: StudioContext, private readonly scheduler: TaskScheduler, private readonly db: Db) {}

  // ---------------------------------------------------------------- overview

  async overview(projectId: string, runId?: string): Promise<QualityOverview> {
    const project = this.requireProject(projectId);
    const run = runId ? this.requireRun(project, runId) : this.scheduler.currentRun(project.id);
    const tasks = run ? this.ctx.repos.tasks.listByRun(run.id) : [];
    const audit = readLastAudit(this.ctx, project.id);
    return {
      projectId: project.id,
      readiness: run ? this.readiness(run, tasks, audit) : null,
      testRuns: this.testRuns(tasks),
      scanners: await this.scanners(project, tasks, audit),
      pendingAuditApprovalId: this.pendingAudit(project.id)?.id ?? null,
    };
  }

  private readiness(run: Run, tasks: Task[], audit: LastAudit | null): ReleaseReadiness {
    const ofKind = (kind: Task['kind']): Task[] => tasks.filter((t) => t.kind === kind);
    const gates = [
      combine('build', tasks.filter(isBuild).map(buildState), 'No build step in this run'),
      combine('tests', ofKind('test').map(testState), 'No test task in this run'),
      combine('security', ofKind('security').map(verdictState), 'No security review in this run'),
      combine('review', ofKind('review').map(verdictState), 'No code review in this run'),
      auditGate(run, tasks, audit),
      gate('coverage', 'not_run', 'No coverage scanner is configured yet, so no run is marked ready'),
    ];
    const blockingFindings = this.ctx.repos.findings.listByRun(run.id)
      .filter((f) => f.status === 'open' && (f.severity === 'critical' || f.severity === 'high')).length;
    return { runId: run.id, runNumber: run.number, gates, ready: gates.every((g) => g.state === 'passed'), blockingFindings };
  }

  private testRuns(tasks: Task[]): TestRunRow[] {
    return tasks.filter((t) => t.kind === 'test' && t.testResult)
      .map((t) => ({ taskId: t.id, taskKey: t.key, title: t.title, runId: t.runId, result: t.testResult!, finishedAt: t.finishedAt }))
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
  }

  private async scanners(project: Project, tasks: Task[], audit: LastAudit | null): Promise<ScannerInfo[]> {
    const ofKind = (kind: Task['kind']): Task[] => tasks.filter((t) => t.kind === kind);
    const hasPackageJson = this.hasPackageJson(project);
    return [
      { id: 'tests', label: 'Project tests', available: true, version: null, lastRunAt: latestFinish(ofKind('test').filter((t) => t.testResult)),
        note: `Runs with each QA task (${project.testCommand || 'no test command set'})` },
      await this.agentScanner('security-agent', 'security', 'Security agent', latestFinish(ofKind('security'))),
      await this.agentScanner('review-agent', 'reviewer', 'Review agent', latestFinish(ofKind('review'))),
      { id: 'npm-audit', label: 'npm audit', available: hasPackageJson, version: null, lastRunAt: audit?.at ?? null,
        note: hasPackageJson
          ? 'Needs your approval each time (network access to the npm registry); the npm version is not checked'
          : 'No package.json in this project' },
      { id: 'guardian', label: 'Guardian', available: false, version: null, lastRunAt: null, note: 'Not installed — integration contract ready' },
    ];
  }

  /** Available when the role's provider, or (fallback on) one of the fallback order, is a usable AI provider. */
  private async agentScanner(id: 'security-agent' | 'review-agent', role: AgentRole, label: string, lastRunAt: string | null): Promise<ScannerInfo> {
    const config = this.ctx.registry.agentConfig(role);
    const order = getSettings(this.ctx).fallbackOrder.filter((p) => p !== config.providerId);
    for (const providerId of [config.providerId, ...(config.allowFallback ? order : [])]) {
      const adapter = this.ctx.registry.get(providerId);
      if (!adapter?.isAi || (await this.ctx.registry.unusableReason(providerId)) !== null) continue;
      const step = id === 'security-agent' ? 'security review' : 'code review';
      return { id, label, available: true, version: null, lastRunAt, note: `Runs with each ${step} task (${adapter.label})` };
    }
    return { id, label, available: false, version: null, lastRunAt,
      note: `No usable AI provider for the ${AGENT_ROLE_INFO[role].name} agent — assign or enable one in Models & Providers` };
  }

  // ---------------------------------------------------------------- findings

  listFindings(query: FindingQuery): FindingsResponse {
    if (query.projectId) this.requireProject(query.projectId);
    if (query.runId && !this.ctx.repos.runs.get(query.runId)) throw new ProjectError('Run not found', 404);
    return this.ctx.repos.findings.list(query);
  }

  updateFinding(id: string, input: UpdateFindingInput): Finding {
    this.requireFinding(id);
    const updated = this.ctx.repos.findings.update(id, { status: input.status, ...(input.note !== undefined ? { note: input.note } : {}) });
    this.emitFinding(updated, `Finding "${clip(updated.title, 80)}" marked ${updated.status.replaceAll('_', ' ')}`);
    return updated;
  }

  /** P6-4: an implement task `fix-finding-<n>` in the project's current run; the project reopens so the scheduler runs it. */
  createFixTask(findingId: string): Task {
    const finding = this.requireFinding(findingId);
    if (finding.status !== 'open') throw new ProjectError(`Only open findings get a fix task (this one is ${finding.status.replaceAll('_', ' ')})`, 409);
    const project = this.requireProject(finding.projectId);
    const run = this.scheduler.currentRun(project.id);
    if (!run) throw new ProjectError('The project has no run yet', 409);
    if (PLANNING_STATUSES.has(project.status) || PLANNING_STATUSES.has(run.status)) {
      throw new ProjectError('The run is still being planned; create the fix task after the plan is approved', 409);
    }
    const tasks = this.ctx.repos.tasks.listByRun(run.id);
    const key = nextFixKey(tasks);
    const task = transaction(this.db, () => {
      const created = this.ctx.repos.tasks.create(project.id, {
        runId: run.id, nodeId: null, key, title: clip(`Fix finding: ${finding.title}`, TITLE_MAX), description: fixDescription(finding),
        role: fixRoleOf(finding.file), kind: 'implement', dependsOn: [], orderIndex: Math.max(-1, ...tasks.map((t) => t.orderIndex)) + 1,
        maxAttempts: getSettings(this.ctx).defaultMaxAttempts,
      });
      this.ctx.repos.findings.update(finding.id, { status: 'fix_planned', fixTaskId: created.id });
      return created;
    });
    emitTask(this.ctx, task, `Fix task ${key} planned for finding "${clip(finding.title, 80)}"`);
    this.emitFinding(this.ctx.repos.findings.get(finding.id)!, `Finding "${clip(finding.title, 80)}": fix planned (${key})`);
    // A paused project stays paused (the task runs on resume); a finished one reopens.
    if (REOPEN_STATUSES.has(project.status)) this.scheduler.setProjectStatus(project, 'running', `Project reopened for ${key}`);
    this.scheduler.tick(project.id);
    return this.ctx.repos.tasks.get(task.id)!;
  }

  // ---------------------------------------------------------------- audit

  /** P6-3: the audit needs network access, so it is only requested here; approving it runs it (startAudit). */
  requestAudit(projectId: string): Approval {
    const project = this.requireProject(projectId);
    if (!this.hasPackageJson(project)) throw new ProjectError('This project has no package.json, so npm audit cannot run', 400);
    if (this.pendingAudit(project.id)) throw new ProjectError('An npm audit is already waiting for your approval', 409);
    if (this.auditing.has(project.id)) throw new ProjectError('An npm audit is already running for this project', 409);
    const approval = this.ctx.repos.approvals.create({
      projectId: project.id, taskId: null, kind: 'command',
      title: `Run "${AUDIT_COMMAND}" for "${project.name}"? (network access to the npm registry)`,
      details: { command: AUDIT_COMMAND, purpose: 'audit' },
    });
    this.ctx.events.emit({ projectId: project.id, type: 'approval.updated', level: 'warn', message: approval.title, data: { approval } });
    return approval;
  }

  /** Runs an approved audit once, in the background (one at a time per project). */
  startAudit(projectId: string): void {
    const project = this.ctx.repos.projects.get(projectId);
    if (!project || this.auditing.has(projectId)) return;
    this.auditing.add(projectId);
    this.ctx.events.emit({ projectId, type: 'quality.audit_started', message: `Running ${AUDIT_COMMAND}` });
    void runAudit(this.ctx, project, this.auditDeps).catch(() => undefined).finally(() => this.auditing.delete(projectId));
  }

  isAuditRunning(projectId: string): boolean {
    return this.auditing.has(projectId);
  }

  // ---------------------------------------------------------------- helpers

  private pendingAudit(projectId: string): Approval | null {
    return this.ctx.repos.approvals.listByProject(projectId)
      .find((a) => a.kind === 'command' && a.status === 'pending' && a.details.purpose === 'audit') ?? null;
  }

  private hasPackageJson(project: Project): boolean {
    return fs.existsSync(path.join(project.integrationPath ?? project.workspacePath, 'package.json'));
  }

  private requireProject(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId);
    if (!project) throw new ProjectError('Project not found', 404);
    return project;
  }

  private requireRun(project: Project, runId: string): Run {
    const run = this.ctx.repos.runs.get(runId);
    if (!run || run.projectId !== project.id) throw new ProjectError('Run not found', 404);
    return run;
  }

  private requireFinding(id: string): Finding {
    const finding = this.ctx.repos.findings.get(id);
    if (!finding) throw new ProjectError('Finding not found', 404);
    return finding;
  }

  private emitFinding(finding: Finding, message: string): void {
    this.ctx.events.emit({ projectId: finding.projectId, taskId: finding.taskId, type: 'finding.updated', message, data: { finding } });
  }
}
