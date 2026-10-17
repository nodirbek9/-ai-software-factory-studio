import { describe, expect, it } from 'vitest';
import type { StudioEvent } from '@asf/shared';
import { slimHistoryEvent } from '../src/orchestrator/projectService.ts';
import { startStudio, tempDir } from './helpers.ts';

const event = (data: Record<string, unknown> | null): StudioEvent => ({
  id: 1, projectId: 'p1', taskId: 't1', role: null, type: 'task.updated', level: 'info', message: 'm', data, createdAt: '2026-10-17T00:00:00.000Z',
});

describe('project snapshot payload', () => {
  it('drops the full project and task copies from history events and keeps the other data', () => {
    expect(slimHistoryEvent(event({ task: { id: 't1' }, attempt: 2 })).data).toEqual({ attempt: 2 });
    expect(slimHistoryEvent(event({ project: { id: 'p1' } })).data).toBeNull();
    const plain = event({ testResult: { passed: true } });
    expect(slimHistoryEvent(plain)).toBe(plain);
    expect(slimHistoryEvent(event(null)).data).toBeNull();
  });

  it('serves snapshot events without project/task copies while the stored events keep them', async () => {
    const studio = await startStudio(tempDir('snapshot'), tempDir('samples'));
    try {
      const project = await studio.projects.create({ name: 'Payload', spec: 'A spec', workspaceMode: 'new' });
      const stored = studio.ctx.repos.events.list({ projectId: project.id, limit: 50 });
      expect(stored.some((e) => e.data && 'project' in e.data)).toBe(true);
      const snapshot = (await studio.app.inject({ url: `/api/projects/${project.id}` })).json();
      expect(snapshot.recentEvents.length).toBe(stored.length);
      expect(snapshot.recentEvents.some((e: StudioEvent) => e.data && ('project' in e.data || 'task' in e.data))).toBe(false);
    } finally {
      await studio.close();
    }
  });
});
