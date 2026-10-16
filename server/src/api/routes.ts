import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGENT_ROLES, EFFORT_LEVELS, type AgentRole, type AgentTestResult, type FsRoots, type ServerInfo, type StudioEvent } from '@asf/shared';
import { ProviderLimitError } from '../providers/types.ts';
import { redact } from '../security/redact.ts';
import { isLoopback } from '../config.ts';
import { getSettings, type StudioContext } from '../orchestrator/context.ts';
import { buildLiveSnapshot } from '../orchestrator/liveMonitor.ts';
import { ProjectError, type ProjectService } from '../orchestrator/projectService.ts';
import type { TaskScheduler } from '../orchestrator/scheduler.ts';
import { ALLOWED_COMMANDS } from '../workspace/commandRunner.ts';
import { WorkspaceError } from '../workspace/workspaceManager.ts';

const VERSION = '0.1.0';
const SSE_HEARTBEAT_MS = 20_000;

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  spec: z.string().max(200_000).default(''),
  workspaceMode: z.enum(['new', 'import', 'sample']),
  importPath: z.string().max(1000).optional(),
  importStrategy: z.enum(['worktree', 'copy']).optional(),
  sampleName: z.string().max(100).optional(),
  testCommand: z.string().max(200).optional(),
});
const agentConfigSchema = z.object({ providerId: z.string().min(1).max(60), model: z.string().max(120), allowFallback: z.boolean(),
  effort: z.enum(['', ...EFFORT_LEVELS]).default('') });
const providerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  budgetUsd: z.number().min(0).max(100_000).nullable().optional(),
  settings: z.record(z.string().max(500)).optional(),
});
const settingsSchema = z.object({
  maxParallelTasks: z.number().int().min(1).max(8),
  defaultMaxAttempts: z.number().int().min(1).max(5),
  taskTimeoutMinutes: z.number().int().min(5).max(480),
  idleTimeoutMinutes: z.number().int().min(2).max(120),
  fallbackOrder: z.array(z.string().max(60)).max(20),
  maxFixRounds: z.number().int().min(0).max(5),
}).partial();
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(2000).nullable().optional() });
const chatSchema = z.object({ message: z.string().trim().min(1).max(8000) });
const idParam = z.object({ id: z.string().uuid() });

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RouteDeps {
  ctx: StudioContext;
  projects: ProjectService;
  scheduler: TaskScheduler;
}

async function testAgent(ctx: StudioContext, role: AgentRole): Promise<AgentTestResult> {
  const started = Date.now();
  const config = ctx.registry.agentConfig(role);
  const adapter = ctx.registry.get(config.providerId);
  const result: AgentTestResult = {
    role, providerId: config.providerId, providerLabel: adapter?.label ?? config.providerId,
    requestedModel: config.model || adapter?.defaultModel || '', actualModel: null, effort: config.effort,
    effortApplied: config.providerId === 'codex' || config.providerId.startsWith('claude-code'),
    ok: false, answer: null, correct: null, reasoningTokens: null, outputTokens: null, durationMs: 0, error: null,
  };
  try {
    const reason = await ctx.registry.unusableReason(config.providerId);
    if (reason) throw new Error(reason);
    const cwd = path.join(ctx.config.dataDir, 'agent-test');
    fs.mkdirSync(cwd, { recursive: true });
    if (fs.existsSync(path.join(cwd, '.git'))) throw new Error('Agent test scratch folder must not be a git repository');
    const output = await adapter!.run({
      prompt: 'What is 37 * 43? Think it through, then reply with only the number.',
      systemPrompt: 'Answer the arithmetic question without accessing files or using tools.',
      cwd, mode: 'readonly', model: result.requestedModel, effort: config.effort,
      timeoutMs: 180_000, signal: new AbortController().signal,
    }, ctx.repos.config.getProviderConfig(config.providerId)?.settings ?? {});
    result.actualModel = output.model ?? null;
    result.answer = output.text.trim().slice(0, 200);
    result.correct = result.answer.includes('1591');
    result.reasoningTokens = output.usage?.reasoningTokens ?? null;
    result.outputTokens = output.usage?.outputTokens ?? null;
    result.ok = true;
    if (output.usage) ctx.repos.usage.record({ projectId: null, taskId: null, role, providerId: config.providerId,
      model: result.actualModel, usage: output.usage });
  } catch (error) {
    result.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (error instanceof ProviderLimitError) ctx.registry.markLimited(config.providerId, error.resetsAt, result.error);
  }
  result.durationMs = Date.now() - started;
  ctx.events.emit({ role, type: 'agent.test', message: `${role} test: ${result.providerLabel} / ${result.actualModel ?? 'unknown'} · effort ${result.effort || 'default'} · ${result.reasoningTokens ?? 'unknown'} thinking tokens · ${result.ok ? 'ok' : 'failed'}` });
  return result;
}

export function registerRoutes(app: FastifyInstance, { ctx, projects, scheduler }: RouteDeps): void {
  const { config } = ctx;
  const authRequired = Boolean(config.authToken);

  // ---- security hooks: token auth (always when configured) and CSRF origin check for mutations
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;
    if (authRequired) {
      const header = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const query = (request.query as Record<string, string> | undefined)?.token;
      if (!tokenMatches(config.authToken!, header ?? query)) return reply.code(401).send({ error: 'Authentication required' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin) {
        const host = request.headers.host ?? '';
        const allowed = origin === `http://${host}` || origin === `https://${host}` || config.allowedOrigins.includes(origin)
          || (isLoopback(config.host) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
        if (!allowed) return reply.code(403).send({ error: 'Cross-origin request rejected' });
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        return reply.code(415).send({ error: 'Mutating requests must use application/json' });
      }
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: error.issues });
    if (error instanceof ProjectError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof WorkspaceError) return reply.code(400).send({ error: error.message });
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.code(status).send({ error: status === 500 ? `Internal error: ${error.message}` : error.message });
  });

  // ---- server info & settings
  app.get('/api/info', async (): Promise<ServerInfo> => ({
    version: VERSION, host: config.host, port: config.port, authRequired, approvedRoots: ctx.workspace.approvedRoots,
    dataDir: config.dataDir, allowedCommands: [...ALLOWED_COMMANDS], settings: getSettings(ctx),
  }));
  app.put('/api/settings', async (request) => {
    const patch = settingsSchema.parse(request.body);
    ctx.repos.config.setSetting('studio', { ...getSettings(ctx), ...patch });
    scheduler.tickAll();
    return getSettings(ctx);
  });

  // ---- providers & agents
  app.get('/api/providers', async (request) => ctx.registry.list((request.query as { refresh?: string }).refresh === '1'));
  app.patch('/api/providers/:providerId', async (request) => {
    const { providerId } = request.params as { providerId: string };
    if (!ctx.registry.get(providerId)) throw new ProjectError('Unknown provider', 404);
    ctx.registry.updateProvider(providerId, providerPatchSchema.parse(request.body));
    ctx.events.emit({ type: 'provider.updated', message: `Provider ${providerId} configuration updated` });
    return (await ctx.registry.list()).find((p) => p.id === providerId);
  });
  app.get('/api/usage', async () => ctx.repos.usage.summary());
  app.get('/api/agents/config', async () => ctx.repos.config.getAgentConfigs());
  const agentTests = new Set<AgentRole>();
  app.post('/api/agents/:role/test', async (request, reply) => {
    const role = z.enum(AGENT_ROLES).parse((request.params as { role: string }).role);
    z.object({}).strict().parse(request.body);
    if (agentTests.has(role)) return reply.code(409).send({ error: `A test for ${role} is already running` });
    agentTests.add(role);
    try {
      return await testAgent(ctx, role);
    } finally {
      agentTests.delete(role);
    }
  });
  app.put('/api/agents/:role/config', async (request) => {
    const role = z.enum(AGENT_ROLES).parse((request.params as { role: string }).role);
    const body = agentConfigSchema.parse(request.body);
    if (!ctx.registry.get(body.providerId)) throw new ProjectError('Unknown provider');
    ctx.repos.config.upsertAgentConfig({ role, ...body });
    ctx.events.emit({ role, type: 'agent.config', message: `${role} agent now uses ${body.providerId}${body.model ? ` / ${body.model}` : ''}` });
    return { role, ...body };
  });

  // ---- live monitor (all projects)
  app.get('/api/live', async () => buildLiveSnapshot(ctx));

  // ---- folder picker (names of folders only; approval is an explicit user action)
  const folderSchema = z.object({ path: z.string().trim().min(1).max(1000) });
  const persistRoots = (roots: string[]): void => ctx.repos.config.setSetting('approvedRoots', roots);
  app.get('/api/fs/roots', async (): Promise<FsRoots> => ({
    drives: ctx.workspace.listDrives(), approvedRoots: ctx.workspace.userApprovedRoots, protectedPaths: config.protectedPaths,
  }));
  app.get('/api/fs/list', async (request) => ctx.workspace.listDirectory(folderSchema.parse(request.query).path));
  app.post('/api/fs/approved-roots', async (request) => {
    const roots = ctx.workspace.approveRoot(folderSchema.parse(request.body).path);
    persistRoots(roots);
    ctx.events.emit({ type: 'workspace.approved', level: 'warn', message: `Folder approved for import: ${roots.at(-1)}` });
    return { approvedRoots: roots };
  });
  app.post('/api/fs/approved-roots/remove', async (request) => {
    const target = folderSchema.parse(request.body).path;
    const roots = ctx.workspace.revokeRoot(target);
    persistRoots(roots);
    ctx.events.emit({ type: 'workspace.revoked', message: `Folder approval removed: ${target}` });
    return { approvedRoots: roots };
  });

  // ---- projects
  app.get('/api/samples', async () => ctx.workspace.listSamples().map((name) => ({ name, spec: ctx.workspace.readSampleSpec(name) })));
  app.get('/api/projects', async () => ctx.repos.projects.list());
  app.post('/api/projects', async (request, reply) => reply.code(201).send(await projects.create(createProjectSchema.parse(request.body))));
  app.get('/api/projects/:id', async (request) => projects.snapshot(idParam.parse(request.params).id));
  app.post('/api/projects/:id/plan', async (request) => projects.startPlanning(idParam.parse(request.params).id));
  app.post('/api/projects/:id/pause', async (request) => scheduler.pause(projects.require(idParam.parse(request.params).id).id));
  app.post('/api/projects/:id/resume', async (request) => scheduler.resume(projects.require(idParam.parse(request.params).id).id));
  app.post('/api/projects/:id/cancel', async (request) => scheduler.cancelProject(projects.require(idParam.parse(request.params).id).id));
  app.post('/api/projects/:id/delete', async (request) => projects.deleteProject(idParam.parse(request.params).id));
  app.get('/api/projects/:id/report.md', async (request, reply) => {
    const project = projects.require(idParam.parse(request.params).id);
    if (!project.reportMarkdown) throw new ProjectError('The report has not been generated yet', 404);
    return reply.header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${project.slug}-report.md"`).send(project.reportMarkdown);
  });
  app.get('/api/projects/:id/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = request.query as { limit?: string; level?: string; taskId?: string };
    return ctx.repos.events.list({ projectId: id, limit: Number(q.limit ?? 500), taskId: q.taskId,
      level: q.level ? z.enum(['debug', 'info', 'warn', 'error']).parse(q.level) : undefined });
  });
  app.get('/api/projects/:id/files', async (request) => {
    const project = projects.require(idParam.parse(request.params).id);
    return ctx.workspace.listFiles(project.integrationPath ?? project.workspacePath);
  });
  app.get('/api/projects/:id/file', async (request) => {
    const project = projects.require(idParam.parse(request.params).id);
    const filePath = z.string().min(1).max(500).parse((request.query as { path?: string }).path);
    return ctx.workspace.readFile(project.integrationPath ?? project.workspacePath, filePath);
  });
  app.get('/api/projects/:id/agents/:role/messages', async (request) => {
    const { id } = idParam.parse({ id: (request.params as { id: string }).id });
    const role = z.enum(AGENT_ROLES).parse((request.params as { role: string }).role);
    return ctx.repos.messages.list(id, role);
  });
  app.post('/api/projects/:id/agents/:role/messages', async (request, reply) => {
    const { id } = idParam.parse({ id: (request.params as { id: string }).id });
    const role = z.enum(AGENT_ROLES).parse((request.params as { role: string }).role);
    projects.sendChat(id, role, chatSchema.parse(request.body).message);
    return reply.code(202).send({ accepted: true });
  });

  // ---- tasks & approvals
  app.post('/api/tasks/:id/retry', async (request) => scheduler.retryTask(idParam.parse(request.params).id));
  app.post('/api/tasks/:id/cancel', async (request) => scheduler.cancelTask(idParam.parse(request.params).id));
  app.post('/api/approvals/:id/decision', async (request) => {
    const { decision, note } = decisionSchema.parse(request.body);
    return projects.decideApproval(idParam.parse(request.params).id, decision, note ?? null);
  });

  // ---- live events (SSE with Last-Event-ID replay)
  app.get('/api/events', (request, reply) => {
    const q = request.query as { projectId?: string; after?: string };
    const lastId = Number(request.headers['last-event-id'] ?? q.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: StudioEvent): void => {
      if (q.projectId && event.projectId && event.projectId !== q.projectId) return;
      res.write(`id: ${event.id}\nevent: studio\ndata: ${JSON.stringify(event)}\n\n`);
    };
    res.write('retry: 2000\n\n');
    if (lastId > 0) for (const event of ctx.events.replay(lastId, q.projectId)) send(event);
    const unsubscribe = ctx.events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    request.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // ---- built dashboard (production mode)
  if (fs.existsSync(config.webDistDir)) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
}
