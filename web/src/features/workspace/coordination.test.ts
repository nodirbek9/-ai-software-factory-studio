import { describe, expect, it } from 'vitest';
import { eventFixture, budgetFixture, sessionFixture, taskFixture } from '@/test/sessionFixtures';
import { deriveArtifacts, deriveHandoffs, latestTasks } from './coordination';
import { applyPreset, createLayout, setPanelSession } from './layout';
import { formatElapsed, pickableSessions, placeSession, queuePosition, setPanelKind, stripAnsi } from './panelActions';
import { parseDiff } from './SessionTabs';

const plan = taskFixture();
const implement = taskFixture({
  id: 'task-b', key: 'impl', title: 'Implement search', role: 'backend', kind: 'implement', status: 'running', dependsOn: ['plan'],
  startedAt: '2026-10-16T10:06:00Z', finishedAt: null, updatedAt: '2026-10-16T10:06:00Z',
});

describe('deriveHandoffs', () => {
  it('lists B after A when A completed before B started and A is in B.dependsOn', () => {
    const handoffs = deriveHandoffs([plan, implement]);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ from: { role: 'architect', title: 'Write the technical plan' }, to: { role: 'backend', status: 'running' }, at: '2026-10-16T10:06:00Z' });
  });

  it('ignores tasks that have not started, unfinished dependencies and tasks that started before the dependency finished', () => {
    expect(deriveHandoffs([plan, { ...implement, startedAt: null }])).toEqual([]);
    expect(deriveHandoffs([{ ...plan, status: 'running', finishedAt: null }, implement])).toEqual([]);
    expect(deriveHandoffs([plan, { ...implement, startedAt: '2026-10-16T10:01:00Z' }])).toEqual([]);
    expect(deriveHandoffs([plan, { ...implement, dependsOn: [] }])).toEqual([]);
  });

  it('sorts the newest handoff first', () => {
    const review = taskFixture({ id: 'task-c', key: 'review', role: 'reviewer', status: 'running', dependsOn: ['impl'], startedAt: '2026-10-16T10:30:00Z' });
    const done = { ...implement, status: 'completed' as const, finishedAt: '2026-10-16T10:20:00Z' };
    expect(deriveHandoffs([plan, done, review]).map((h) => h.to.role)).toEqual(['reviewer', 'backend']);
  });
});

describe('latestTasks', () => {
  it('lets newer task events override the snapshot and ignores other projects', () => {
    const events = [
      eventFixture({ data: { task: { ...implement, status: 'completed', updatedAt: '2026-10-16T10:40:00Z' } } }),
      eventFixture({ data: { task: { ...taskFixture({ id: 'foreign', projectId: 'other' }) } } }),
    ];
    const tasks = latestTasks([plan, implement], events, 'project-1');
    expect(tasks.map((t) => [t.id, t.status])).toEqual([['task-a', 'completed'], ['task-b', 'completed']]);
  });

  it('works from events alone', () => {
    const tasks = latestTasks([], [eventFixture({ data: { task: plan } }), eventFixture({ data: { task: implement } })], 'project-1');
    expect(deriveHandoffs(tasks)).toHaveLength(1);
  });
});

describe('deriveArtifacts', () => {
  it('lists merged files newest first, once each, for the project', () => {
    const events = [
      eventFixture({ type: 'git.merge', role: 'backend', taskId: 'task-b', createdAt: '2026-10-16T10:10:00Z', data: { files: ['a.ts', 'b.ts'] } }),
      eventFixture({ type: 'git.merge', role: 'frontend', createdAt: '2026-10-16T10:20:00Z', data: { files: ['b.ts', 'c.ts'] } }),
      eventFixture({ type: 'git.merge', projectId: 'other', data: { files: ['z.ts'] } }),
      eventFixture({ type: 'task.updated', data: { files: ['nope.ts'] } }),
    ];
    expect(deriveArtifacts(events, 'project-1').map((a) => [a.path, a.role])).toEqual([['b.ts', 'frontend'], ['c.ts', 'frontend'], ['a.ts', 'backend']]);
  });
});

describe('panel helpers', () => {
  it('strips ANSI colors, cursor moves and OSC titles', () => {
    expect(stripAnsi('\u001b[32mPASS\u001b[0m src/a.test.ts \u001b[1;31mFAIL\u001b[39m\u001b[2K\r')).toBe('PASS src/a.test.ts FAIL\r');
    expect(stripAnsi('\u001b]0;title\u0007plain')).toBe('plain');
    expect(stripAnsi('no codes')).toBe('no codes');
  });

  it('prefers the live budget position over the session field', () => {
    const queued = sessionFixture({ status: 'queued', queuePosition: 5 });
    expect(queuePosition(queued, null)).toBe(5);
    const budget = budgetFixture({ queued: [{ kind: 'session', id: 's1', projectId: 'project-1', label: 'x', position: 2, since: '2026-10-16T10:00:00Z' }] });
    expect(queuePosition(queued, budget)).toBe(2);
    expect(queuePosition(sessionFixture({ id: 's2' }), budget)).toBeNull();
  });

  it('formats elapsed time as m:ss', () => {
    expect(formatElapsed('2026-10-16T10:00:00Z', Date.parse('2026-10-16T10:02:05Z'))).toBe('2:05');
    expect(formatElapsed(null, Date.now())).toBe('0:00');
  });

  it('offers only open sessions that are not shown yet', () => {
    const layout = setPanelSession(createLayout(2), 'p1', 's1');
    const sessions = [sessionFixture(), sessionFixture({ id: 's2', number: 2 }), sessionFixture({ id: 's3', number: 3, status: 'closed' })];
    expect(pickableSessions(layout, sessions).map((s) => s.id)).toEqual(['s2']);
  });

  it('places a session in the target panel, else the first empty panel, else a new split', () => {
    const base = createLayout(2);
    expect(placeSession(base, 's1', 'p2').panels.p2.sessionId).toBe('s1');
    expect(placeSession(base, 's1').panels.p1.sessionId).toBe('s1');
    const full = setPanelSession(setPanelSession(base, 'p1', 'a'), 'p2', 'b');
    const grown = placeSession(full, 's3');
    expect(Object.keys(grown.panels)).toHaveLength(3);
    expect(Object.values(grown.panels).map((p) => p.sessionId)).toContain('s3');
  });

  it('turns a panel into the orchestrator and keeps it through a preset change', () => {
    const layout = setPanelKind(createLayout(2), 'p2', 'orchestrator');
    expect(layout.panels.p2.kind).toBe('orchestrator');
    expect(applyPreset(layout, 4).panels.p2.kind).toBe('orchestrator');
  });
});

describe('parseDiff', () => {
  it('splits a unified diff into files with added/removed counts', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more',
      'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-x', '+y',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files.map((f) => [f.name, f.added, f.removed])).toEqual([['src/a.ts', 2, 1], ['README.md', 1, 1]]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('\n\n')).toEqual([]);
  });
});
