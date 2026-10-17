import { afterEach, describe, expect, it } from 'vitest';
import type { RunsListPage } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { createRun, startStudio, tempDir } from './helpers.ts';

let studio: Studio | null = null;
afterEach(async () => {
  await studio?.close();
  studio = null;
});

describe('runs across projects (Runs page, V2.2)', () => {
  it('lists every project newest first, filters by project and status, and pages by start time', async () => {
    studio = await startStudio(tempDir('runs-list'), tempDir('samples'));
    const alpha = await studio.projects.create({ name: 'Alpha', spec: 's', workspaceMode: 'new' });
    const beta = await studio.projects.create({ name: 'Beta', spec: 's', workspaceMode: 'new' });
    const db = (studio.ctx.repos as unknown as { runs: { db: import('node:sqlite').DatabaseSync } }).runs.db;
    const made = [
      createRun(studio.ctx.repos, alpha.id, 'completed'),
      createRun(studio.ctx.repos, beta.id, 'failed'),
      createRun(studio.ctx.repos, alpha.id, 'running'),
    ];
    made.forEach((run, index) => db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(`2026-10-17T10:0${index}:00.000Z`, run.id));

    const get = async (query = ''): Promise<RunsListPage> => (await studio!.app.inject({ url: `/api/v2/runs${query}` })).json();
    expect((await get()).runs.map((r) => r.id)).toEqual([made[2].id, made[1].id, made[0].id]);
    expect((await get(`?projectId=${alpha.id}`)).runs.map((r) => r.id)).toEqual([made[2].id, made[0].id]);
    expect((await get('?status=failed')).runs.map((r) => r.projectId)).toEqual([beta.id]);

    const first = await get('?limit=2');
    expect(first.runs).toHaveLength(2);
    expect(first.nextBefore).toBe('2026-10-17T10:01:00.000Z');
    const second = await get(`?limit=2&before=${encodeURIComponent(first.nextBefore!)}`);
    expect(second.runs.map((r) => r.id)).toEqual([made[0].id]);
    expect(second.nextBefore).toBeNull();

    expect((await studio.app.inject({ url: '/api/v2/runs?status=nope' })).statusCode).toBe(400);
  });
});
