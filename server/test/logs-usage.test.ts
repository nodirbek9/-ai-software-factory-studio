import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentRole, EventLevel, EventsPage, Project, Run, Task, UsageDailyResponse, UsageDailyRow } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { localDate } from '../src/db/repositories.ts';
import { readDb } from '../src/readModels/logs.ts';
import { createRun, prepareSamples, startStudio, tempDir } from './helpers.ts';

// Phase 6 read routes: GET /api/v2/events (full LogQuery) and GET /api/v2/usage/daily. Nothing here runs an agent.

let studio: Studio;

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await studio.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

/** Runs `work` with the clock set to `date`, so inserted rows get a controlled created_at. */
function at<T>(date: Date, work: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(date);
  try {
    return work();
  } finally {
    vi.useRealTimers();
  }
}

const query = (params: Record<string, string | number | undefined>): string =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

const newProject = (name: string): Project => studio.ctx.repos.projects.create({ name, slug: name.toLowerCase().replace(/\W+/g, '-'),
  description: '', spec: 'spec', workspaceMode: 'new', workspacePath: tempDir('logs-ws'), testCommand: 'npm test' });

function newTask(project: Project, run: Run, key: string, role: AgentRole): Task {
  return studio.ctx.repos.tasks.create(project.id, { runId: run.id, key, title: key, description: '', role, kind: 'implement',
    dependsOn: [], orderIndex: 0, maxAttempts: 1 });
}

/** Local noon today: day arithmetic around it never crosses a date boundary. */
const noon = (dayOffset = 0): Date => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, 12, 0, 0);
};
const minutesAfter = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * 60_000);

beforeAll(async () => {
  studio = await startStudio(tempDir('logs-usage'), prepareSamples());
}, 60_000);

afterAll(async () => { await studio?.close(); });

// ------------------------------------------------------------------ events

describe('GET /api/v2/events', () => {
  const base = noon();
  let alpha: Project;
  let beta: Project;
  let runA: Run;
  let runB: Run;
  let taskA: Task;
  let taskB: Task;
  /** Seeded messages in insertion order (ids ascend with insertion). */
  const order: string[] = [];

  interface Seed {
    message: string; project: Project | null; task?: Task; role?: AgentRole; type: string; level?: EventLevel; data?: Record<string, unknown>;
  }

  function seed(entries: Seed[]): void {
    entries.forEach((entry, index) => at(minutesAfter(base, index), () => {
      studio.ctx.events.emit({ projectId: entry.project?.id ?? null, taskId: entry.task?.id ?? null, role: entry.role ?? null,
        type: entry.type, level: entry.level ?? 'info', message: entry.message, data: entry.data });
      order.push(entry.message);
    }));
  }

  /** Messages of the matching events, newest first. */
  async function messages(params: Record<string, string | number> = {}): Promise<string[]> {
    const { status, body } = await get<EventsPage>(`/api/v2/events?${query(params)}`);
    expect(status).toBe(200);
    return body.events.map((e) => e.message);
  }
  const newestFirst = (...names: string[]): string[] => order.filter((m) => names.includes(m)).reverse();

  beforeAll(() => {
    // Start from an empty log: the studio may have written start-up events.
    readDb(studio.ctx).prepare('DELETE FROM events').run();
    alpha = newProject('Logs Alpha');
    beta = newProject('Logs Beta');
    runA = createRun(studio.ctx.repos, alpha.id);
    runB = createRun(studio.ctx.repos, beta.id);
    taskA = newTask(alpha, runA, 'a1', 'backend');
    taskB = newTask(beta, runB, 'b1', 'frontend');
    seed([
      { message: 'started: build api', project: alpha, task: taskA, role: 'backend', type: 'task.updated' },
      { message: 'compiling 100% done', project: alpha, task: taskA, role: 'backend', type: 'task.output', level: 'debug' },
      { message: 'Retrying a_b task', project: beta, task: taskB, role: 'frontend', type: 'task.updated', level: 'warn' },
      { message: 'Session failed', project: alpha, type: 'session.message', level: 'error', data: { sessionId: 'sess-1' } },
      { message: 'Run finished', project: beta, type: 'run.updated', data: { run: { id: runB.id } } },
      { message: 'Run started', project: alpha, type: 'run.updated', data: { runId: runA.id } },
      { message: 'Nested session', project: alpha, type: 'session.message', data: { session: { id: 'sess-2' } } },
      { message: 'Studio booted', project: null, type: 'system.boot' },
    ]);
  });

  test('without filters returns everything newest first', async () => {
    expect(await messages()).toEqual([...order].reverse());
  });

  test('filters by project, task, role, level and exact type', async () => {
    expect(await messages({ projectId: alpha.id })).toEqual(newestFirst('started: build api', 'compiling 100% done', 'Session failed', 'Run started', 'Nested session'));
    expect(await messages({ projectId: beta.id })).toEqual(newestFirst('Retrying a_b task', 'Run finished'));
    expect(await messages({ taskId: taskA.id })).toEqual(newestFirst('started: build api', 'compiling 100% done'));
    expect(await messages({ role: 'frontend' })).toEqual(['Retrying a_b task']);
    expect(await messages({ role: 'qa' })).toEqual([]);
    expect(await messages({ level: 'error' })).toEqual(['Session failed']);
    expect(await messages({ level: 'debug' })).toEqual(['compiling 100% done']);
    expect(await messages({ type: 'task.updated' })).toEqual(newestFirst('started: build api', 'Retrying a_b task'));
  });

  test('type ending in .* matches the prefix, and only the prefix', async () => {
    expect(await messages({ type: 'task.*' })).toEqual(newestFirst('started: build api', 'compiling 100% done', 'Retrying a_b task'));
    expect(await messages({ type: 'run.*' })).toEqual(newestFirst('Run finished', 'Run started'));
    expect(await messages({ type: 'task*' })).toEqual([]);
    expect(await messages({ type: 'tas.*' })).toEqual([]);
  });

  test('q searches the message case-insensitively and treats % _ \\ literally', async () => {
    expect(await messages({ q: 'RETRYING' })).toEqual(['Retrying a_b task']);
    expect(await messages({ q: 'run ' })).toEqual(newestFirst('Run finished', 'Run started'));
    expect(await messages({ q: '%' })).toEqual(['compiling 100% done']);
    expect(await messages({ q: '_' })).toEqual(['Retrying a_b task']);
    expect(await messages({ q: 'a_b' })).toEqual(['Retrying a_b task']);
    expect(await messages({ q: '\\' })).toEqual([]);
    expect(await messages({ q: 'no such text' })).toEqual([]);
  });

  test('from and to are inclusive, with or without milliseconds', async () => {
    const third = minutesAfter(base, 2).toISOString();
    const fifth = minutesAfter(base, 4).toISOString();
    expect(await messages({ from: third, to: fifth })).toEqual(newestFirst('Retrying a_b task', 'Session failed', 'Run finished'));
    expect(await messages({ from: third.replace('.000Z', 'Z'), to: fifth.replace('.000Z', 'Z') }))
      .toEqual(newestFirst('Retrying a_b task', 'Session failed', 'Run finished'));
    expect(await messages({ from: minutesAfter(base, 6).toISOString() })).toEqual(newestFirst('Nested session', 'Studio booted'));
    expect(await messages({ to: base.toISOString() })).toEqual(['started: build api']);
    expect(await messages({ from: minutesAfter(base, 60).toISOString() })).toEqual([]);
  });

  test('runId matches the run\'s tasks and run ids in the event data', async () => {
    expect(await messages({ runId: runA.id })).toEqual(newestFirst('started: build api', 'compiling 100% done', 'Run started'));
    expect(await messages({ runId: runB.id })).toEqual(newestFirst('Retrying a_b task', 'Run finished'));
    expect(await messages({ runId: 'no-such-run' })).toEqual([]);
  });

  test('sessionId matches sessionId and session.id in the event data', async () => {
    expect(await messages({ sessionId: 'sess-1' })).toEqual(['Session failed']);
    expect(await messages({ sessionId: 'sess-2' })).toEqual(['Nested session']);
    expect(await messages({ sessionId: 'sess-3' })).toEqual([]);
  });

  test('filters combine', async () => {
    expect(await messages({ projectId: alpha.id, type: 'task.*' })).toEqual(newestFirst('started: build api', 'compiling 100% done'));
    expect(await messages({ projectId: alpha.id, runId: runB.id })).toEqual([]);
    expect(await messages({ runId: runA.id, level: 'debug', q: 'compiling' })).toEqual(['compiling 100% done']);
  });

  test('pages with before/limit and reports nextBefore only while older rows exist', async () => {
    const first = (await get<EventsPage>(`/api/v2/events?${query({ limit: 3 })}`)).body;
    expect(first.events.map((e) => e.message)).toEqual([...order].reverse().slice(0, 3));
    expect(first.nextBefore).toBe(first.events[2].id);

    const second = (await get<EventsPage>(`/api/v2/events?${query({ limit: 3, before: first.nextBefore! })}`)).body;
    expect(second.events.map((e) => e.message)).toEqual([...order].reverse().slice(3, 6));
    expect(second.nextBefore).toBe(second.events[2].id);

    const last = (await get<EventsPage>(`/api/v2/events?${query({ limit: 3, before: second.nextBefore! })}`)).body;
    expect(last.events.map((e) => e.message)).toEqual([...order].reverse().slice(6));
    expect(last.nextBefore).toBeNull();
  });

  test('nextBefore follows the filter, not the whole log', async () => {
    const page = (await get<EventsPage>(`/api/v2/events?${query({ projectId: alpha.id, limit: 2 })}`)).body;
    expect(page.events.map((e) => e.message)).toEqual(newestFirst('started: build api', 'compiling 100% done', 'Session failed', 'Run started', 'Nested session').slice(0, 2));
    expect(page.nextBefore).toBe(page.events[1].id);
    const rest = (await get<EventsPage>(`/api/v2/events?${query({ projectId: alpha.id, limit: 10, before: page.nextBefore! })}`)).body;
    expect(rest.events).toHaveLength(3);
    expect(rest.nextBefore).toBeNull();
  });

  test('rejects invalid filters with 400', async () => {
    for (const bad of [{ level: 'loud' }, { role: 'wizard' }, { from: 'yesterday' }, { to: '2026-13-45' }, { projectId: 'not-a-uuid' },
      { limit: 0 }, { limit: 501 }, { q: 'x'.repeat(201) }, { type: 'x'.repeat(61) }, { runId: 'x'.repeat(81) }]) {
      expect((await get(`/api/v2/events?${query(bad)}`)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  test('empty parameters count as not set', async () => {
    expect(await messages({ q: '', type: '', runId: '' })).toEqual([...order].reverse());
  });
});

// ------------------------------------------------------------------ usage

describe('GET /api/v2/usage/daily', () => {
  const today = noon();
  const yesterday = noon(-1);
  const longAgo = noon(-40);
  let keep: Project;
  let gone: Project;

  function record(date: Date, project: Project | null, providerId: string, model: string | null, inputTokens: number, outputTokens: number,
    costUsd: number | null): void {
    at(date, () => studio.ctx.repos.usage.record({ projectId: project?.id ?? null, taskId: null, role: null, providerId, model,
      usage: { inputTokens, outputTokens, costUsd } }));
  }

  const daily = async (params: Record<string, string | number> = {}): Promise<UsageDailyResponse> => {
    const { status, body } = await get<UsageDailyResponse>(`/api/v2/usage/daily?${query(params)}`);
    expect(status).toBe(200);
    return body;
  };
  const find = (rows: UsageDailyRow[], day: Date, providerId: string, model: string | null, projectId: string | null): UsageDailyRow | undefined =>
    rows.find((r) => r.day === localDate(day) && r.providerId === providerId && r.model === model && r.projectId === projectId);

  beforeAll(() => {
    keep = newProject('Usage Keep');
    gone = newProject('Usage Gone');
    record(today, keep, 'scripted', 'm1', 100, 50, 0.5);
    record(minutesAfter(today, 5), keep, 'scripted', 'm1', 10, 5, null);
    record(today, keep, 'scripted', 'm2', 7, 3, null);
    record(today, keep, 'codex', 'm1', 20, 10, 0);
    record(today, null, 'scripted', null, 5, 5, null);
    record(yesterday, gone, 'scripted', 'm1', 1, 1, null);
    record(longAgo, keep, 'scripted', 'm1', 400, 100, 2);
    studio.ctx.repos.projects.delete(gone.id);
  });

  test('groups by local day, provider, model and project', async () => {
    const { days, rows } = await daily();
    expect(days).toBe(30);
    expect(rows).toHaveLength(5);
    expect(find(rows, today, 'scripted', 'm1', keep.id)).toMatchObject({ projectName: 'Usage Keep', inputTokens: 110, outputTokens: 55, calls: 2 });
    expect(find(rows, today, 'scripted', 'm2', keep.id)).toMatchObject({ inputTokens: 7, outputTokens: 3, calls: 1 });
    expect(find(rows, today, 'codex', 'm1', keep.id)).toMatchObject({ inputTokens: 20, outputTokens: 10, calls: 1 });
    expect(rows.map((r) => r.day)).toEqual([...rows.map((r) => r.day)].sort());
  });

  test('cost is null only when no record of the group reported one; 0 stays 0; mixed groups sum the known costs', async () => {
    const { rows } = await daily();
    expect(find(rows, today, 'scripted', 'm1', keep.id)?.costUsd).toBe(0.5);
    expect(find(rows, today, 'scripted', 'm2', keep.id)?.costUsd).toBeNull();
    expect(find(rows, today, 'codex', 'm1', keep.id)?.costUsd).toBe(0);
  });

  test('records without a project, and of deleted projects, have no project name', async () => {
    const { rows } = await daily();
    expect(find(rows, today, 'scripted', null, null)).toMatchObject({ projectId: null, projectName: null, model: null, calls: 1 });
    expect(find(rows, yesterday, 'scripted', 'm1', gone.id)).toMatchObject({ projectName: null, inputTokens: 1, outputTokens: 1 });
  });

  test('days limits the window to the last N local days, today included', async () => {
    const one = await daily({ days: 1 });
    expect(one.days).toBe(1);
    expect(one.rows.every((r) => r.day === localDate(today))).toBe(true);
    expect(one.rows).toHaveLength(4);

    const two = await daily({ days: 2 });
    expect(find(two.rows, yesterday, 'scripted', 'm1', gone.id)).toBeDefined();
    expect(two.rows).toHaveLength(5);

    expect(find((await daily({ days: 30 })).rows, longAgo, 'scripted', 'm1', keep.id)).toBeUndefined();
    const wide = await daily({ days: 45 });
    expect(find(wide.rows, longAgo, 'scripted', 'm1', keep.id)).toMatchObject({ inputTokens: 400, outputTokens: 100, costUsd: 2 });
    expect(wide.rows).toHaveLength(6);
  });

  test('projectId restricts the rows to one project', async () => {
    const { rows } = await daily({ projectId: keep.id });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.projectId === keep.id)).toBe(true);
    expect((await daily({ projectId: gone.id })).rows.map((r) => r.projectName)).toEqual([null]);
    expect((await daily({ projectId: '00000000-0000-4000-8000-000000000000' })).rows).toEqual([]);
  });

  test('rejects days outside 1–90 and a malformed projectId', async () => {
    for (const bad of [{ days: 0 }, { days: 91 }, { days: 'many' }, { days: 1.5 }, { projectId: 'nope' }]) {
      expect((await get(`/api/v2/usage/daily?${query(bad)}`)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await daily({ days: 90 })).days).toBe(90);
    expect((await daily({ days: '' })).days).toBe(30);
  });
});
