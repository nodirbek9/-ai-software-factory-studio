import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { AgentExecutor } from './agents/agentExecutor.ts';
import { registerRoutes } from './api/routes.ts';
import { loadConfig, type AppConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { createRepositories } from './db/repositories.ts';
import { EventStream } from './events/eventStream.ts';
import { KeyedMutex, type StudioContext } from './orchestrator/context.ts';
import { ProjectService } from './orchestrator/projectService.ts';
import { TaskScheduler } from './orchestrator/scheduler.ts';
import { ProviderRegistry } from './providers/registry.ts';
import type { ProviderAdapter } from './providers/types.ts';
import { registerSecret } from './security/redact.ts';
import { WorkspaceManager } from './workspace/workspaceManager.ts';
import { acquireInstanceLock } from './instanceLock.ts';

export interface Studio {
  app: FastifyInstance;
  ctx: StudioContext;
  scheduler: TaskScheduler;
  projects: ProjectService;
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
  const events = new EventStream(repos.events);
  const registry = new ProviderRegistry(repos.config, repos.usage, config.env, options.extraProviders);
  const workspace = new WorkspaceManager(config);
  workspace.setUserApprovedRoots(repos.config.getSetting<string[]>('approvedRoots', []));
  const ctx: StudioContext = {
    config, repos, events, registry, workspace,
    executor: new AgentExecutor(registry, repos, events),
    integrationLock: new KeyedMutex(),
  };
  const scheduler = new TaskScheduler(ctx, db);
  const projects = new ProjectService(ctx, scheduler, db);

  const app = Fastify({ logger: options.logger ? { level: 'info' } : false, bodyLimit: 2 * 1024 * 1024,
    logController: new Fastify.LogController({ disableRequestLogging: true }) });
  // wildcard: true resolves files per request, so a rebuilt dashboard is served without a restart.
  if (fs.existsSync(config.webDistDir)) await app.register(fastifyStatic, { root: config.webDistDir, wildcard: true });
  registerRoutes(app, { ctx, projects, scheduler });
  // The server entry point defers recovery until the port is bound, so a second copy exits without touching state.
  if (!options.deferRecovery) await scheduler.recover();

  return {
    app, ctx, scheduler, projects,
    start: () => scheduler.recover(),
    close: async () => {
      await scheduler.shutdown();
      await app.close();
      db.close();
      releaseLock();
    },
  };
}
