import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, test } from 'vitest';
import type { EventsPage, OverviewResponse, SystemHealth, UsageSummary } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/db/database.ts';
import { localDate } from '../src/db/repositories.ts';
import { buildUsageSummary } from '../src/readModels/usage.ts';
import { createRun, prepareSamples, tempDir } from './helpers.ts';

const studios: Studio[] = [];
afterAll(async () => { for (const s of studios) await s.close(); });

const fakeProvider = (id: string) => ({
  id, label: `Fake ${id}`, kind: 'builtin' as const, editsFiles: false, isAi: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }),
  run: async () => ({ text: '', usage: null }),
});

async function studio(): Promise<Studio> {
  const dataDir = tempDir('v2api');
  const s = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
  { extraProviders: [fakeProvider('fake-ok')] });
  studios.push(s);
  s.ctx.registry.updateProvider('fake-ok', { enabled: true });
  return s;
}

const BASE = Date.now();
const ago = (minutes: number): string => new Date(BASE - minutes * 60_000).toISOString();

function seedProjects(s: Studio) {
  const { repos } = s.ctx;
  const newProject = (name: string) => repos.projects.create({ name, slug: name.toLowerCase(), description: `${name} project`, spec: 'spec',
    workspaceMode: 'new', workspacePath: tempDir('v2ws'), testCommand: '' });
  const alpha = repos.projects.update(newProject('Alpha').id, { status: 'running' });
  const beta = repos.projects.update(newProject('Beta').id, { status: 'completed' });
  let order = 0;
  const runs = new Map([alpha, beta].map((p) => [p.id, createRun(repos, p.id, p.status === 'completed' ? 'completed' : 'running').id]));
  const task = (projectId: string, key: string, role: 'architect' | 'backend' | 'frontend' | 'qa' | 'reviewer',
    kind: 'architecture' | 'implement' | 'test' | 'review', status: 'pending' | 'ready' | 'running' | 'completed' | 'failed') =>
    repos.tasks.create(projectId, { runId: runs.get(projectId)!, key, title: `${key} task`, description: '', role, kind, dependsOn: [],
      orderIndex: order++, maxAttempts: 2, status });
  const arch = task(alpha.id, 'arch', 'architect', 'architecture', 'completed');
  repos.tasks.update(arch.id, { startedAt: ago(10), finishedAt: ago(5), filesChanged: ['docs/plan.md'], providerId: 'fake-ok', model: 'm' });
  const be = task(alpha.id, 'be', 'backend', 'implement', 'running');
  repos.tasks.update(be.id, { startedAt: ago(1), providerId: 'fake-ok', model: 'm' });
  task(alpha.id, 'fe', 'frontend', 'implement', 'ready');
  const qa = task(alpha.id, 'qa', 'qa', 'test', 'failed');
  repos.tasks.update(qa.id, { startedAt: ago(70), finishedAt: ago(60), error: 'tests red' });
  const review = task(beta.id, 'review', 'reviewer', 'review', 'completed');
  repos.tasks.update(review.id, { startedAt: ago(130), finishedAt: ago(120) });
  repos.approvals.create({ projectId: alpha.id, taskId: null, kind: 'command', title: 'Run npm test', details: {} });
  return { alpha, beta, be };
}

describe('GET /api/v2/overview', () => {
  test('counts projects, agents, tasks and approvals and builds the current project stages', async () => {
    const s = await studio();
    const { alpha, be } = seedProjects(s);
    const { config } = s.ctx.repos;
    for (const role of ['architect', 'qa', 'frontend'] as const) config.upsertAgentConfig({ role, providerId: 'fake-ok', model: 'm', allowFallback: true, effort: '' });
    config.upsertAgentConfig({ role: 'security', providerId: 'scripted', model: '', allowFallback: true, effort: 'low' });
    s.ctx.registry.updateProvider('scripted', { enabled: false });

    const response = await s.app.inject({ url: `/api/v2/overview?projectId=${alpha.id}` });
    expect(response.statusCode).toBe(200);
    const overview = response.json() as OverviewResponse;
    expect(overview.projects).toEqual({ total: 2, active: 1, createdLast7d: 2 });
    expect(overview.agents).toEqual({ running: 1, slots: 2, queued: 1 });
    expect(overview.tasks).toEqual({ open: 2, failedLast24h: 1, completedLast24h: 2 });
    expect(overview.approvals).toEqual({ pending: 1 });

    const project = overview.currentProject!;
    expect(project).toMatchObject({ id: alpha.id, name: 'Alpha', status: 'running' });
    expect(project.progress).toEqual({ total: 4, completed: 1, running: 1, blocked: 0, failed: 1 });
    const stage = Object.fromEntries(project.stages.map((st) => [st.role, st]));
    expect(project.stages.map((st) => st.role)).toEqual(['architect', 'backend', 'frontend', 'qa', 'security', 'reviewer']);
    expect(stage.architect).toMatchObject({ status: 'completed', tasksTotal: 1, tasksCompleted: 1, latestFiles: ['docs/plan.md'], providerId: 'fake-ok' });
    expect(stage.architect.durationMs).toBe(5 * 60_000);
    expect(stage.backend).toMatchObject({ status: 'running', currentTask: { id: be.id, title: 'be task', status: 'running' } });
    expect(stage.backend.durationMs).toBeGreaterThan(0);
    expect(stage.frontend).toMatchObject({ status: 'pending', providerId: 'fake-ok', model: 'm' });
    expect(stage.qa).toMatchObject({ status: 'failed', error: 'tests red' });
    expect(stage.security).toMatchObject({ status: 'none', tasksTotal: 0, currentTask: null, providerId: null });
    expect(stage.reviewer.status).toBe('none'); // the reviewer task belongs to the other project

    const health = Object.fromEntries(overview.agentHealth.map((a) => [a.role, a]));
    expect(overview.agentHealth).toHaveLength(7);
    expect(health.backend).toMatchObject({ status: 'running', currentTask: { id: be.id, projectName: 'Alpha' } });
    expect(health.security).toMatchObject({ status: 'disconnected', providerId: 'scripted', providerLabel: s.ctx.registry.get('scripted')!.label, effort: 'low' });
    expect(health.qa).toMatchObject({ status: 'failed', successRate7d: 0, finished7d: 1, providerLabel: 'Fake fake-ok' });
    expect(health.architect).toMatchObject({ status: 'idle', successRate7d: 1, finished7d: 1 });
    expect(health.architect.lastActivityAt).not.toBeNull();
    expect(health.pm).toMatchObject({ successRate7d: null, finished7d: 0, lastActivityAt: null });

    expect(overview.activeProjects.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
    const updated = overview.activeProjects.map((p) => p.updatedAt);
    expect(updated).toEqual([...updated].sort().reverse());
    expect(overview.activeProjects.find((p) => p.name === 'Alpha')).toMatchObject({ tasksTotal: 4, tasksCompleted: 1, activeAgents: 1, failedTasks: 1 });
    expect(overview.recentRuns.map((r) => r.taskTitle)).toEqual(['arch task', 'qa task', 'review task']);
    expect(overview.recentRuns[1]).toMatchObject({ projectName: 'Alpha', role: 'qa', status: 'failed', error: 'tests red', durationMs: 10 * 60_000 });
    expect(typeof overview.recentRuns[0].finishedAt).toBe('string');
  });

  test('an unknown project gives no current project; a malformed id is rejected', async () => {
    const s = await studio();
    const unknown = await s.app.inject({ url: `/api/v2/overview?projectId=${randomUUID()}` });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ currentProject: null, projects: { total: 0 } });
    expect((await s.app.inject({ url: '/api/v2/overview' })).json().currentProject).toBeNull();
    expect((await s.app.inject({ url: '/api/v2/overview?projectId=not-a-uuid' })).statusCode).toBe(400);
  });

  test('the loopback Host check still applies', async () => {
    const s = await studio();
    const response = await s.app.inject({ url: '/api/v2/overview', headers: { host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/v2/usage/summary', () => {
  test('totals, previous window, cost null vs number, models and days', async () => {
    const s = await studio();
    const { usage } = s.ctx.repos;
    usage.record({ projectId: null, taskId: null, role: 'pm', providerId: 'scripted', model: 'replay', usage: { inputTokens: 100, outputTokens: 50, costUsd: null } });
    usage.record({ projectId: null, taskId: null, role: 'qa', providerId: 'fake-ok', model: 'm', usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.25 } });

    const day = (await s.app.inject({ url: '/api/v2/usage/summary' })).json() as UsageSummary;
    expect(day).toMatchObject({ range: '24h', totalTokens: 1650, previousTotalTokens: 0, calls: 2, costUsd: 0.25 });
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(24 * 3_600_000);
    expect(day.byModel).toEqual([
      { providerId: 'fake-ok', providerLabel: 'Fake fake-ok', model: 'm', calls: 1, inputTokens: 1000, outputTokens: 500, costUsd: 0.25 },
      { providerId: 'scripted', providerLabel: s.ctx.registry.get('scripted')!.label, model: 'replay', calls: 1, inputTokens: 100, outputTokens: 50, costUsd: null },
    ]);
    expect(day.byDay.length).toBeGreaterThanOrEqual(1);
    expect(day.byDay.length).toBeLessThanOrEqual(2);

    const week = (await s.app.inject({ url: '/api/v2/usage/summary?range=7d' })).json() as UsageSummary;
    expect(week.range).toBe('7d');
    expect(week.byDay).toHaveLength(7);
    expect(week.byDay.at(-1)!.date).toBe(localDate(new Date()));
    expect([...week.byDay].map((d) => d.date).sort()).toEqual(week.byDay.map((d) => d.date));
    expect(week.byDay.reduce((n, d) => n + d.totalTokens, 0)).toBe(1650);

    // A day later the same records fall into the previous window and nothing reported a cost.
    const later = buildUsageSummary(s.ctx, '24h', new Date(Date.now() + 25 * 3_600_000));
    expect(later).toMatchObject({ totalTokens: 0, previousTotalTokens: 1650, calls: 0, costUsd: null, byModel: [] });

    expect((await s.app.inject({ url: '/api/v2/usage/summary?range=30d' })).statusCode).toBe(400);
  });
});

describe('GET /api/v2/system/health', () => {
  test('reports six checks with valid states and the worst one as overall', async () => {
    const s = await studio();
    await s.app.inject({ url: '/api/v2/system/health' });
    const response = await s.app.inject({ url: '/api/v2/system/health' });
    expect(response.statusCode).toBe(200);
    const health = response.json() as SystemHealth;
    expect(health.checks.map((c) => c.id)).toEqual(['api', 'database', 'events', 'providers', 'git', 'disk']);
    const rank = { ok: 0, degraded: 1, down: 2 } as const;
    for (const check of health.checks) {
      expect(['ok', 'degraded', 'down']).toContain(check.state);
      expect(check.label.length).toBeGreaterThan(0);
    }
    const worst = health.checks.reduce((w, c) => (rank[c.state] > rank[w] ? c.state : w), 'ok' as keyof typeof rank);
    expect(health.overall).toBe(worst);
    const byId = Object.fromEntries(health.checks.map((c) => [c.id, c]));
    expect(byId.api.state).toBe('ok');
    expect(byId.database.state).toBe('ok');
    expect(byId.providers).toMatchObject({ state: 'ok', detail: '1 of 1 usable' }); // fake-ok is the only enabled AI provider
    expect(health.server.version).toBe('0.1.0');
    expect(health.server.rssBytes).toBeGreaterThan(0);
    expect(health.system.totalMemBytes).toBeGreaterThan(0);
    expect(health.eventClients).toBe(0);
    expect(health.system.cpuPercent === null || (health.system.cpuPercent >= 0 && health.system.cpuPercent <= 100)).toBe(true);
  });
});

describe('GET /api/v2/events', () => {
  test('pages newest first with a nextBefore chain, filters by level and type, and bounds the limit', async () => {
    const s = await studio();
    const projectId = randomUUID();
    for (let i = 0; i < 25; i += 1) {
      s.ctx.events.emit({ projectId, type: i === 7 ? 'other.event' : 'test.event', level: i % 5 === 0 ? 'error' : 'info', message: `event ${i}` });
    }
    const seen: number[] = [];
    let before: number | null = null;
    const sizes: number[] = [];
    do {
      const query: string = `/api/v2/events?projectId=${projectId}&limit=10${before ? `&before=${before}` : ''}`;
      const page = (await s.app.inject({ url: query })).json() as EventsPage;
      sizes.push(page.events.length);
      const ids = page.events.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      if (seen.length) expect(Math.max(...ids)).toBeLessThan(Math.min(...seen));
      seen.push(...ids);
      before = page.nextBefore;
      if (before !== null) expect(before).toBe(Math.min(...ids));
    } while (before !== null);
    expect(sizes).toEqual([10, 10, 5]);
    expect(new Set(seen).size).toBe(25);

    const errors = (await s.app.inject({ url: `/api/v2/events?projectId=${projectId}&level=error` })).json() as EventsPage;
    expect(errors.events).toHaveLength(5);
    expect(errors.nextBefore).toBeNull();
    expect(errors.events.every((e) => e.level === 'error')).toBe(true);
    const typed = (await s.app.inject({ url: `/api/v2/events?projectId=${projectId}&type=other.event` })).json() as EventsPage;
    expect(typed.events.map((e) => e.message)).toEqual(['event 7']);

    expect(s.ctx.repos.events.page({ projectId, limit: 0 }).events).toHaveLength(1);
    expect(s.ctx.repos.events.page({ projectId, limit: 10_000 }).events).toHaveLength(25);
    expect((await s.app.inject({ url: '/api/v2/events?limit=501' })).statusCode).toBe(400);
    expect((await s.app.inject({ url: '/api/v2/events?before=-3' })).statusCode).toBe(400);
    expect((await s.app.inject({ url: '/api/v2/events?level=fatal' })).statusCode).toBe(400);
  });
});

describe('migration backup', () => {
  test('an existing database is copied before pending migrations run; a fresh one is not', () => {
    const dir = tempDir('migrate');
    const file = path.join(dir, 'studio.db');
    const latest = SCHEMA_VERSION;
    // A database one schema version behind, so reopening has one migration pending.
    const fresh = openDatabase(file, { upToVersion: latest - 1 });
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    expect((fresh.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(latest - 1);
    fresh.close();

    const upgraded = openDatabase(file);
    expect((upgraded.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(latest);
    upgraded.close();
    const backup = path.join(dir, 'backups', `studio-before-v${latest}.db`);
    expect(fs.existsSync(backup)).toBe(true);
    const copy = new DatabaseSync(backup);
    expect((copy.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(latest - 1);
    copy.close();
  });
});
