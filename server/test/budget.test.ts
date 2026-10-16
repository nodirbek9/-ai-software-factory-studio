import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ProcessBudgetOwner, ProcessBudgetSnapshot } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import { ProcessBudget, throttleBudgetUpdates, type ProcessSlotRelease } from '../src/orchestrator/processBudget.ts';
import { ProviderError, type ProviderAdapter, type ProviderRunRequest } from '../src/providers/types.ts';
import { approvePlan, prepareSamples, projectOf, tempDir, waitFor } from './helpers.ts';

const owner = (kind: ProcessBudgetOwner['kind'], id: string): ProcessBudgetOwner => ({ kind, id, projectId: 'p1', label: id });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Tracked { release: ProcessSlotRelease | null; error: Error | null }
function track(pending: Promise<ProcessSlotRelease>): Tracked {
  const state: Tracked = { release: null, error: null };
  pending.then((release) => { state.release = release; }, (error: Error) => { state.error = error; });
  return state;
}

describe('ProcessBudget', () => {
  test('limit 1 grants one slot at a time in arrival order', async () => {
    const budget = new ProcessBudget(() => 1);
    const a = track(budget.acquire(owner('task', 'a')));
    const b = track(budget.acquire(owner('task', 'b')));
    const c = track(budget.acquire(owner('task', 'c')));
    await tick();
    expect([a.release !== null, b.release !== null, c.release !== null]).toEqual([true, false, false]);
    a.release!();
    await tick();
    expect([b.release !== null, c.release !== null]).toEqual([true, false]);
    b.release!();
    await tick();
    expect(c.release).not.toBeNull();
    expect(budget.snapshot().running.map((o) => o.id)).toEqual(['c']);
  });

  test('limit 3 runs three at once and queues the fourth', async () => {
    const budget = new ProcessBudget(() => 3);
    const all = ['a', 'b', 'c', 'd'].map((id) => track(budget.acquire(owner('task', id))));
    await tick();
    expect(all.map((t) => t.release !== null)).toEqual([true, true, true, false]);
    const snapshot = budget.snapshot();
    expect(snapshot.limit).toBe(3);
    expect(snapshot.running.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(snapshot.queued).toMatchObject([{ id: 'd', position: 1, kind: 'task', projectId: 'p1', label: 'd' }]);
    expect(Number.isNaN(Date.parse(snapshot.queued[0].since))).toBe(false);
    all[1].release!();
    await tick();
    expect(all[3].release).not.toBeNull();
    expect(budget.snapshot().queued).toEqual([]);
  });

  test('alternates tasks and sessions when both kinds wait', async () => {
    const budget = new ProcessBudget(() => 1);
    const holder = track(budget.acquire(owner('task', 't0')));
    const waiting = ['t1', 't2'].map((id) => ({ id, state: track(budget.acquire(owner('task', id))) }))
      .concat(['s1', 's2'].map((id) => ({ id, state: track(budget.acquire(owner('session', id))) })));
    await tick();
    // The last grant was a task, so the first session jumps ahead of the second task; the queue then alternates.
    expect(budget.snapshot().queued.map((q) => [q.id, q.position])).toEqual([['s1', 1], ['t1', 2], ['s2', 3], ['t2', 4]]);
    expect(budget.queuePosition({ kind: 'task', id: 't2' })).toBe(4);
    expect(budget.queuePosition({ kind: 'session', id: 't2' })).toBeNull();

    const order: string[] = [];
    let current = holder;
    for (let i = 0; i < 4; i += 1) {
      current.release!();
      await tick();
      const next = waiting.find((w) => w.state.release !== null && !order.includes(w.id))!;
      order.push(next.id);
      current = next.state;
    }
    expect(order).toEqual(['s1', 't1', 's2', 't2']);
  });

  test('stays first-come first-served when only one kind waits', async () => {
    const budget = new ProcessBudget(() => 1);
    const holder = track(budget.acquire(owner('session', 's0')));
    const s1 = track(budget.acquire(owner('session', 's1')));
    const s2 = track(budget.acquire(owner('session', 's2')));
    await tick();
    holder.release!();
    await tick();
    expect([s1.release !== null, s2.release !== null]).toEqual([true, false]);
  });

  test('an aborted queued acquire rejects with AbortError and never takes a slot', async () => {
    const budget = new ProcessBudget(() => 1);
    const holder = track(budget.acquire(owner('task', 'a')));
    const controller = new AbortController();
    const aborted = track(budget.acquire(owner('task', 'b'), controller.signal));
    const next = track(budget.acquire(owner('task', 'c')));
    await tick();
    controller.abort();
    await tick();
    expect(aborted.error).toBeInstanceOf(Error);
    expect(aborted.error!.name).toBe('AbortError');
    expect(budget.snapshot().queued.map((q) => q.id)).toEqual(['c']);
    holder.release!();
    await tick();
    expect(next.release).not.toBeNull();
    expect(aborted.release).toBeNull();
    expect(budget.snapshot().running.map((o) => o.id)).toEqual(['c']);
  });

  test('rejects at once when the signal is already aborted, and ignores an abort after the grant', async () => {
    const budget = new ProcessBudget(() => 1);
    const done = new AbortController();
    done.abort();
    const early = track(budget.acquire(owner('task', 'x'), done.signal));
    await tick();
    expect(early.error?.name).toBe('AbortError');
    expect(budget.snapshot()).toMatchObject({ running: [], queued: [] });

    const live = new AbortController();
    const granted = track(budget.acquire(owner('task', 'y'), live.signal));
    await tick();
    live.abort();
    await tick();
    expect(granted.release).not.toBeNull();
    expect(granted.error).toBeNull();
    expect(budget.snapshot().running.map((o) => o.id)).toEqual(['y']);
  });

  test('release is idempotent', async () => {
    const budget = new ProcessBudget(() => 1);
    const a = track(budget.acquire(owner('task', 'a')));
    const b = track(budget.acquire(owner('task', 'b')));
    const c = track(budget.acquire(owner('task', 'c')));
    await tick();
    a.release!();
    a.release!();
    await tick();
    expect([b.release !== null, c.release !== null]).toEqual([true, false]);
    expect(budget.snapshot().running.map((o) => o.id)).toEqual(['b']);
  });

  test('limit changes apply at the next acquire or release', async () => {
    let limit = 1;
    const budget = new ProcessBudget(() => limit);
    const a = track(budget.acquire(owner('task', 'a')));
    const b = track(budget.acquire(owner('task', 'b')));
    await tick();
    limit = 2;
    await tick();
    expect(b.release).toBeNull();
    expect(budget.snapshot().limit).toBe(2);
    const c = track(budget.acquire(owner('task', 'c')));
    await tick();
    expect([b.release !== null, c.release !== null]).toEqual([true, false]);
    limit = 1;
    a.release!();
    await tick();
    expect(c.release).toBeNull();
    b.release!();
    await tick();
    expect(c.release).not.toBeNull();
  });

  test('a nonsense limit still allows one process', async () => {
    const budget = new ProcessBudget(() => Number.NaN);
    const a = track(budget.acquire(owner('task', 'a')));
    await tick();
    expect(a.release).not.toBeNull();
    expect(budget.snapshot().limit).toBe(1);
  });

  test('onChange fires for queueing, granting, aborting and releasing until unsubscribed', async () => {
    const budget = new ProcessBudget(() => 1);
    const calls: number[] = [];
    const off = budget.onChange(() => { calls.push(budget.snapshot().queued.length); });
    const a = track(budget.acquire(owner('task', 'a')));
    const controller = new AbortController();
    track(budget.acquire(owner('task', 'b'), controller.signal));
    await tick();
    controller.abort();
    a.release!();
    expect(calls.length).toBe(4);
    off();
    track(budget.acquire(owner('task', 'c')));
    expect(calls.length).toBe(4);
  });

  test('throttled updates send the first change at once and merge the rest into one trailing call', async () => {
    vi.useFakeTimers();
    try {
      const budget = new ProcessBudget(() => 1);
      const sent: ProcessBudgetSnapshot[] = [];
      const stop = throttleBudgetUpdates(budget, (snapshot) => sent.push(snapshot), 250);
      const a = track(budget.acquire(owner('task', 'a')));
      track(budget.acquire(owner('task', 'b')));
      await Promise.resolve();
      expect(sent.length).toBe(1);
      expect(sent[0].running.map((o) => o.id)).toEqual(['a']);
      a.release?.();
      await vi.advanceTimersByTimeAsync(250);
      expect(sent.length).toBe(2);
      expect(sent[1].running.map((o) => o.id)).toEqual(['b']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.length).toBe(2);
      stop();
      track(budget.acquire(owner('task', 'c')));
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------------- scheduler integration

let studios: Studio[] = [];
afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

const base = { kind: 'builtin' as const, editsFiles: true, isAi: true, reportsActivity: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }) };

const ROLES = ['pm', 'architect', 'backend', 'qa', 'security', 'reviewer'] as const;
const PLAN = JSON.stringify({ tasks: [
  { key: 'a', title: 'Part A', role: 'backend', dependsOn: [] },
  { key: 'b', title: 'Part B', role: 'backend', dependsOn: [] },
  { key: 'c', title: 'Part C', role: 'backend', dependsOn: [] },
  { key: 'check', title: 'Tests', role: 'qa', dependsOn: ['a', 'b', 'c'] }] });

/** Rejects when the signal aborts — also when it was already aborted (a task can get its slot after a shutdown began). */
const holdUntilAborted = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  if (signal.aborted) reject(new ProviderError('aborted', false));
  else signal.addEventListener('abort', () => reject(new ProviderError('aborted', false)), { once: true });
});

/** Fake agent for the planned pipeline; `implement` decides what the three implement tasks do. */
function fakeAgent(id: string, implement: (request: ProviderRunRequest) => Promise<string>): { adapter: ProviderAdapter; stats: { current: number; peak: number } } {
  const stats = { current: 0, peak: 0 };
  const adapter: ProviderAdapter = { ...base, id, label: id, run: async (r) => {
    stats.current += 1;
    stats.peak = Math.max(stats.peak, stats.current);
    try {
      const kind = r.task?.kind;
      if (kind === 'plan') return { text: PLAN, usage: null };
      if (kind === 'architecture') return { text: '# Plan\n\nThree independent parts, then tests that cover all of them.', usage: null };
      if (kind === 'security' || kind === 'review') return { text: 'ok\nVERDICT: PASS', usage: null };
      if (kind === 'test') {
        fs.mkdirSync(path.join(r.cwd, 'test'), { recursive: true });
        fs.writeFileSync(path.join(r.cwd, 'test', 'ok.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
        return { text: 'tests', usage: null };
      }
      return { text: await implement(r), usage: null };
    } finally {
      stats.current -= 1;
    }
  } };
  return { adapter, stats };
}

async function studioWith(adapter: ProviderAdapter, settings: { maxParallelTasks: number; maxAgentProcesses: number }): Promise<Studio> {
  const dataDir = tempDir('budget');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
  { extraProviders: [adapter] });
  studios.push(studio);
  studio.ctx.registry.updateProvider(adapter.id, { enabled: true });
  for (const role of ROLES) studio.ctx.repos.config.upsertAgentConfig({ role, providerId: adapter.id, model: 'm', allowFallback: false, effort: '' });
  studio.ctx.repos.config.setSetting('studio', settings);
  return studio;
}

const waitingEvents = (studio: Studio) => studio.ctx.repos.events.list({ limit: 2000 }).filter((e) => e.type === 'task.waiting_slot');

describe('scheduler and the process budget', () => {
  test.each([
    { agentProcesses: 1, minPeak: 1, maxPeak: 1 },
    { agentProcesses: 3, minPeak: 2, maxPeak: 3 },
  ])('maxParallelTasks 3 with maxAgentProcesses $agentProcesses keeps $minPeak-$maxPeak agents running at once', async ({ agentProcesses, minPeak, maxPeak }) => {
    const { adapter, stats } = fakeAgent(`budget-${agentProcesses}`, async (r) => {
      fs.writeFileSync(path.join(r.cwd, `${r.task!.key}.txt`), r.task!.key);
      await new Promise((ok) => setTimeout(ok, 1000));
      return `done ${r.task!.key}`;
    });
    const studio = await studioWith(adapter, { maxParallelTasks: 3, maxAgentProcesses: agentProcesses });
    const project = await studio.projects.create({ name: `Budget ${agentProcesses}`, spec: 'Three parts', workspaceMode: 'new', testCommand: 'node --test' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 90_000, 'project end');
    const tasks = studio.ctx.repos.tasks.listByProject(project.id);
    expect(projectOf(studio, project.id).status, JSON.stringify(tasks.map((t) => [t.key, t.status, t.error]))).toBe('completed');
    expect(stats.peak).toBeGreaterThanOrEqual(minPeak);
    expect(stats.peak).toBeLessThanOrEqual(maxPeak);
    if (agentProcesses === 1) {
      expect(waitingEvents(studio).length).toBeGreaterThanOrEqual(2);
      expect(waitingEvents(studio)[0].data).toMatchObject({ position: expect.any(Number), limit: 1 });
    } else {
      expect(waitingEvents(studio)).toEqual([]);
    }
    expect(studio.ctx.repos.events.list({ limit: 2000 }).some((e) => e.type === 'budget.updated')).toBe(true);
    expect(studio.ctx.budget.snapshot()).toMatchObject({ running: [], queued: [] });
  });

  test('cancel and shutdown while waiting for a slot end like a normal cancel and shutdown', async () => {
    const { adapter } = fakeAgent('budget-hold', async (r) => {
      fs.writeFileSync(path.join(r.cwd, `${r.task!.key}.txt`), r.task!.key);
      return holdUntilAborted(r.signal);
    });
    const studio = await studioWith(adapter, { maxParallelTasks: 3, maxAgentProcesses: 1 });
    const project = await studio.projects.create({ name: 'Waiting', spec: 'Three parts', workspaceMode: 'new', testCommand: 'node --test' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    const waiting = await waitFor(() => { const events = waitingEvents(studio); return events.length >= 2 ? events : null; }, 60_000, 'two tasks waiting for a slot');
    const [first, second] = waiting.map((e) => e.taskId!);
    expect(studio.ctx.budget.snapshot().queued.map((q) => q.id).sort()).toEqual([first, second].sort());

    studio.scheduler.cancelTask(first);
    const cancelled = await waitFor(() => { const t = studio.ctx.repos.tasks.get(first)!; return t.status === 'cancelled' ? t : null; }, 10_000, 'cancelled while waiting');
    expect(cancelled.error).toBe('Cancelled by user');
    expect(studio.ctx.budget.snapshot().queued.map((q) => q.id)).toEqual([second]);
    expect(studio.scheduler.isRunning(first)).toBe(false);

    await studio.scheduler.shutdown();
    const interrupted = studio.ctx.repos.tasks.get(second)!;
    expect(interrupted.status).toBe('ready');
    expect(interrupted.error).toBe('Interrupted by shutdown');
    // The slot holder was mid-run: shutdown() waits only 10 s, while saving its partial work (git) can take longer on
    // Windows, so wait for its own interruption to land instead of asserting at once.
    const holderOf = () => studio.ctx.repos.tasks.listByProject(project.id).filter((t) => ['a', 'b', 'c'].includes(t.key) && t.id !== first && t.id !== second);
    const holders = await waitFor(() => (holderOf().every((t) => t.status === 'ready') ? holderOf() : null), 30_000, 'holder interrupted');
    expect(holders.map((t) => [t.status, t.error])).toEqual([['ready', 'Interrupted by shutdown']]);
    expect(studio.ctx.budget.snapshot()).toMatchObject({ running: [], queued: [] });
  });
});

describe('maxAgentProcesses setting', () => {
  test('defaults to 3 and accepts 1 to 8 only', async () => {
    const { adapter } = fakeAgent('budget-settings', async () => 'x');
    const studio = await studioWith(adapter, { maxParallelTasks: 2, maxAgentProcesses: 3 });
    studio.ctx.repos.config.setSetting('studio', {});
    expect((await studio.app.inject({ url: '/api/info' })).json().settings.maxAgentProcesses).toBe(3);
    const put = (value: unknown) => studio.app.inject({ method: 'PUT', url: '/api/settings', payload: { maxAgentProcesses: value } });
    const ok = await put(5);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().maxAgentProcesses).toBe(5);
    expect(studio.ctx.budget.snapshot().limit).toBe(5);
    for (const bad of [0, 9, 2.5, '3']) expect((await put(bad)).statusCode).toBe(400);
    expect(studio.ctx.budget.snapshot().limit).toBe(5);
  });
});
