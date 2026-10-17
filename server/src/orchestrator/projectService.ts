import type { AgentRole, AgentStatus, AgentView, Approval, CreateProjectInput, Project, ProjectSnapshot, Task } from '@asf/shared';
import { AGENT_ROLE_INFO, AGENT_ROLES, STANDARD_WORKFLOW_ID } from '@asf/shared';
import { chatPrompt } from '../agents/prompts.ts';
import { redact } from '../security/redact.ts';
import type { RunService } from '../workflows/runService.ts';
import { emitProject, getSettings, type StudioContext } from './context.ts';
import type { TaskScheduler } from './scheduler.ts';
import { approvedCommands } from './taskRunners.ts';

export class ProjectError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

/** Runs an approved dependency audit in the background (quality/qualityService.ts, PHASE_6.md P6-3). */
export interface AuditStarter {
  startAudit(projectId: string): void;
}

const CHAT_TIMEOUT_MS = 5 * 60_000;

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

export class ProjectService {
  private readonly chats = new Set<string>();

  constructor(private readonly ctx: StudioContext, private readonly scheduler: TaskScheduler, private readonly runs: RunService,
    private readonly audits: AuditStarter | null = null) {}

  require(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId);
    if (!project) throw new ProjectError('Project not found', 404);
    return project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    let slug = slugify(input.name);
    for (let i = 2; this.ctx.repos.projects.slugExists(slug); i += 1) slug = `${slugify(input.name)}-${i}`;
    let workspacePath: string;
    let spec = input.spec;
    if (input.workspaceMode === 'sample') {
      const sample = input.sampleName ?? '';
      spec = spec.trim() || (this.ctx.workspace.readSampleSpec(sample) ?? '');
      workspacePath = await this.ctx.workspace.createFromSample(slug, sample);
    } else if (input.workspaceMode === 'import') {
      if (!input.importPath) throw new ProjectError('importPath is required for imported repositories');
      workspacePath = input.importStrategy === 'copy'
        ? await this.ctx.workspace.importByCopy(slug, input.importPath)
        : await this.ctx.workspace.validateImport(input.importPath);
    } else {
      workspacePath = await this.ctx.workspace.createNewWorkspace(slug, spec);
    }
    if (!spec.trim()) throw new ProjectError('A technical specification is required');
    const project = this.ctx.repos.projects.create({
      name: input.name.trim(), slug, description: input.description?.trim() ?? '', spec, workspaceMode: input.workspaceMode,
      workspacePath, testCommand: input.testCommand?.trim() || 'npm test',
    });
    const integration = await this.ctx.workspace.setupIntegration(project);
    const updated = this.ctx.repos.projects.update(project.id, integration);
    emitProject(this.ctx, updated, `Project "${updated.name}" created (${input.workspaceMode} workspace)`);
    return updated;
  }

  /**
   * V1 "Start planning": run 1 of a draft project with the Standard template (PM plan → Architect plan → approval gate,
   * P4-5). Later runs start through RunService (POST /api/v2/projects/:id/runs).
   */
  startPlanning(projectId: string): Project {
    const project = this.require(projectId);
    if (project.status !== 'draft') throw new ProjectError(`Planning already started (status: ${project.status})`, 409);
    this.runs.start(project.id, STANDARD_WORKFLOW_ID);
    return this.require(project.id);
  }

  /** Tasks of the run the project shows: its active run, else its latest run (none for a draft). */
  private currentTasks(projectId: string): Task[] {
    const run = this.scheduler.currentRun(projectId);
    return run ? this.ctx.repos.tasks.listByRun(run.id) : [];
  }

  decideApproval(approvalId: string, decision: 'approved' | 'rejected', note: string | null): Approval {
    const approval = this.ctx.repos.approvals.get(approvalId);
    if (!approval) throw new ProjectError('Approval not found', 404);
    if (approval.status !== 'pending') throw new ProjectError(`Approval already ${approval.status}`, 409);
    const decided = this.ctx.repos.approvals.decide(approvalId, decision, note);
    this.ctx.events.emit({ projectId: approval.projectId, taskId: approval.taskId, type: 'approval.updated',
      level: decision === 'approved' ? 'info' : 'warn', message: `${approval.title} — ${decision}${note ? `: ${note}` : ''}`, data: { approval: decided } });
    const task = approval.taskId ? this.ctx.repos.tasks.get(approval.taskId) : null;

    if (approval.kind === 'plan' && task?.status === 'waiting_approval') {
      if (decision === 'approved') {
        this.scheduler.transition(task, 'completed', { finishedAt: new Date().toISOString(), resultSummary: note ? `Approved: ${note}` : 'Approved by user' }, 'Plan approved');
      } else {
        this.scheduler.transition(task, 'failed', { finishedAt: new Date().toISOString(), error: `Plan rejected${note ? `: ${note}` : ''}` }, 'Plan rejected', 'warn');
      }
    }
    // An approved audit runs once; `npm audit` never joins the project's approved commands and no task is retried.
    const audit = approval.kind === 'command' && approval.details.purpose === 'audit';
    if (audit && decision === 'approved') this.audits?.startAudit(approval.projectId);
    if (!audit && approval.kind === 'command' && decision === 'approved') {
      const command = String(approval.details.command);
      this.ctx.repos.config.setSetting(`approvedCommands:${approval.projectId}`, [...new Set([...approvedCommands(this.ctx, approval.projectId), command])]);
      if (task && (task.status === 'failed' || task.status === 'cancelled')) this.scheduler.retryTask(task.id);
    }
    this.scheduler.tick(approval.projectId);
    return decided;
  }

  agentViews(projectId: string): AgentView[] {
    const tasks = this.currentTasks(projectId);
    const configs = this.ctx.repos.config.getAgentConfigs();
    return AGENT_ROLES.map((role) => {
      const own = tasks.filter((t) => t.role === role);
      const config = configs.find((c) => c.role === role)!;
      const current = own.find((t) => t.status === 'running') ?? own.find((t) => t.status === 'waiting_approval')
        ?? own.find((t) => t.status === 'ready') ?? null;
      const last = this.ctx.repos.events.lastForRole(projectId, role);
      const completed = own.filter((t) => t.status === 'completed').length;
      return {
        ...config, name: AGENT_ROLE_INFO[role].name, title: AGENT_ROLE_INFO[role].title,
        status: this.agentStatus(own),
        currentTask: current ? { id: current.id, title: current.title, status: current.status } : null,
        tasksTotal: own.length, tasksCompleted: completed, progress: own.length ? completed / own.length : 0,
        lastActivity: last ? { message: last.message, at: last.createdAt } : null,
        usage: this.ctx.repos.usage.totalsForRole(projectId, role),
      };
    });
  }

  private agentStatus(tasks: Task[]): AgentStatus {
    const running = tasks.find((t) => t.status === 'running');
    if (running) return running.kind === 'plan' || running.kind === 'architecture' ? 'planning' : 'running';
    if (tasks.some((t) => t.status === 'failed')) return 'failed';
    if (tasks.some((t) => t.status === 'blocked' || t.status === 'waiting_approval')) return 'blocked';
    if (tasks.length && tasks.every((t) => t.status === 'completed')) return 'completed';
    return 'idle';
  }

  /** Deletes a stopped project: studio worktrees, studio-owned workspace folder and its records. Imported repos are kept. */
  async deleteProject(projectId: string): Promise<{ removedWorkspace: boolean }> {
    const project = this.require(projectId);
    if (['planning', 'running', 'awaiting_approval'].includes(project.status) || this.scheduler.hasActiveTasks(projectId)) {
      throw new ProjectError('Stop the project (Stop button) before deleting it', 409);
    }
    const result = await this.ctx.workspace.removeProjectFiles(project);
    this.ctx.repos.projects.delete(projectId);
    this.ctx.events.emit({ type: 'project.deleted', level: 'warn', message: `Project "${project.name}" deleted`,
      data: { projectId, removedWorkspace: result.removedWorkspace } });
    return result;
  }

  snapshot(projectId: string): ProjectSnapshot {
    const project = this.require(projectId);
    return {
      project,
      tasks: this.currentTasks(projectId),
      agents: this.agentViews(projectId),
      approvals: this.ctx.repos.approvals.listByProject(projectId),
      recentEvents: this.ctx.repos.events.list({ projectId, limit: 300 }),
    };
  }

  /** Read-only conversation with an agent; the provider runs without edit or shell tools. */
  sendChat(projectId: string, role: AgentRole, text: string): void {
    const project = this.require(projectId);
    const key = `${projectId}:${role}`;
    if (this.chats.has(key)) throw new ProjectError('This agent is still answering the previous message', 409);
    const history = this.ctx.repos.messages.list(projectId, role, 20);
    const userMessage = this.ctx.repos.messages.add({ projectId, role, taskId: null, direction: 'user', content: redact(text) });
    this.ctx.events.emit({ projectId, role, type: 'agent.message', message: `User → ${AGENT_ROLE_INFO[role].name}`, data: { message: userMessage } });
    const tasks = this.currentTasks(projectId);
    const context =`Status: ${project.status}\nTasks:\n${tasks.map((t) => `- ${t.key} [${t.role}] ${t.status}${t.error ? ` (error: ${t.error.slice(0, 160)})` : ''}`).join('\n')}`;
    this.chats.add(key);
    const controller = new AbortController();
    const owner = { kind: 'session' as const, id: key, projectId, label: 'chat' };
    void this.ctx.budget.acquire(owner, controller.signal).then(async (release) => {
      try {
        return await this.ctx.executor.run({
          project, task: null, role, prompt: () => chatPrompt(project, role, history, text, context),
          cwd: project.integrationPath ?? project.workspacePath, mode: 'readonly', signal: controller.signal,
          timeoutMs: CHAT_TIMEOUT_MS, fallbackOrder: getSettings(this.ctx).fallbackOrder,
        });
      } finally {
        release();
      }
    }).then((out) => {
      const reply = this.ctx.repos.messages.add({ projectId, role, taskId: null, direction: 'agent', content: out.text.trim() || '(empty reply)' });
      this.ctx.events.emit({ projectId, role, type: 'agent.message', message: `${AGENT_ROLE_INFO[role].name} replied`, data: { message: reply } });
    }).catch((error: Error) => {
      const note = this.ctx.repos.messages.add({ projectId, role, taskId: null, direction: 'system', content: `Agent unavailable: ${redact(error.message)}` });
      this.ctx.events.emit({ projectId, role, type: 'agent.message', level: 'warn', message: `${AGENT_ROLE_INFO[role].name} could not answer`, data: { message: note } });
    }).finally(() => this.chats.delete(key));
  }
}
