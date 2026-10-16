import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { AgentExecutor } from './agents/agentExecutor.ts';
import { registerRoutes } from './api/routes.ts';
import { registerWorkflowRoutes } from './api/workflowRoutes.ts';
import { loadConfig, type AppConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { createRepositories } from './db/repositories.ts';
import { RunService } from './workflows/runService.ts';
import { STANDARD_WORKFLOW } from './workflows/standardTemplate.ts';
import { EventStream } from './events/eventStream.ts';
import { getSettings, KeyedMutex, type StudioContext } from './orchestrator/context.ts';
import { ProcessBudget, throttleBudgetUpdates } from './orchestrator/processBudget.ts';
import { ProjectService } from './orchestrator/projectService.ts';
import { TaskScheduler } from './orchestrator/scheduler.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { SessionManager } from './sessions/sessionManager.ts';
import type { ProviderAdapter } from './providers/types.ts';
import { registerSecret } from './security/redact.ts';
import { WorkspaceManager } from './workspace/workspaceManager.ts';
import { acquireInstanceLock } from './instanceLock.ts';

export interface Studio {
  app: FastifyInstance;
  ctx: StudioContext;
  scheduler: TaskScheduler;
  projects: ProjectService;
  /** Workflow runs (start/cancel/list/timeline/simulate). */
  runs: RunService;
  /** Crash recovery + scheduling; call after the HTTP port is bound. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createStudio(overrides: Partial<AppConfig> = {},
  options: { logger?: boolean; extraProviders?: ProviderAdapter[]; deferRecovery?: boolean } = {}): Promise<Studio> {
  const config = loadConfig(overrides);
  registerSecret(config.authToken);
  registerSecret(config.env.ASF_OPENAI_API_KEY);
  const releaseLock = await acquireInstanceLock(config.dataDir);
  const db = openDatabase(config.dbPath);
  const repos = createRepositories(db);
  repos.workflows.ensureBuiltin(STANDARD_WORKFLOW);
  const events = new EventStream(repos.events);
  const registry = new ProviderRegistry(repos.config, repos.usage, config.env, options.extraProviders);
  const workspace = new WorkspaceManager(config);
  workspace.setUserApprovedRoots(repos.config.getSetting<string[]>('approvedRoots', []));
  // `sessions` needs the finished context, so it is attached right after the rest is built.
  const ctx: StudioContext = {
    config, repos, events, registry, workspace,
    executor: new AgentExecutor(registry, repos, events),
    integrationLock: new KeyedMutex(),
    budget: new ProcessBudget(() => getSettings(ctx).maxAgentProcesses),
  } as StudioContext;
  ctx.sessions = new SessionManager(ctx);
  const stopBudgetEvents = throttleBudgetUpdates(ctx.budget, (snapshot) => {
    ctx.events.emit({ type: 'budget.updated', level: 'debug', data: { budget: snapshot },
      message: `Agent processes: ${snapshot.running.length}/${snapshot.limit} running, ${snapshot.queued.length} queued` });
  });
  const scheduler = new TaskScheduler(ctx, db);
  const runs = new RunService(ctx, scheduler, db);
  const projects = new ProjectService(ctx, scheduler, runs);

  const app = Fastify({ logger: options.logger ? { level: 'info' } : false, bodyLimit: 2 * 1024 * 1024,
    logController: new Fastify.LogController({ disableRequestLogging: true }) });
  // wildcard: true resolves files per request, so a rebuilt dashboard is served without a restart.
  if (fs.existsSync(config.webDistDir)) await app.register(fastifyStatic, { root: config.webDistDir, wildcard: true });
  registerRoutes(app, { ctx, projects, scheduler });
  // After registerRoutes: the security hooks and the error handler set there apply to these routes too.
  registerWorkflowRoutes(app, { ctx, runs });
  const recover = async (): Promise<void> => {
    await ctx.sessions.recover();
    await scheduler.recover();
  };
  // The server entry point defers recovery until the port is bound, so a second copy exits without touching state.
  if (!options.deferRecovery) await recover();

  return {
    app, ctx, scheduler, projects, runs,
    start: recover,
    close: async () => {
      await Promise.all([ctx.sessions.shutdown(), scheduler.shutdown()]);
      stopBudgetEvents();
      await app.close();
      db.close();
      releaseLock();
    },
  };
}
