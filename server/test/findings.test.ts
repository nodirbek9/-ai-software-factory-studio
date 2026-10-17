import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FindingSeverity } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { openDatabase, type Db } from '../src/db/database.ts';
import { createRepositories, type Repositories } from '../src/db/repositories.ts';
import { fingerprintOf, parseFindings, type ParsedFinding } from '../src/quality/findings.ts';
import { approvePlan, createRun, prepareSamples, projectOf, startStudio, taskByKey, tempDir, waitFor } from './helpers.ts';

const fence = (body: string): string => `\`\`\`asf-findings\n${body}\n\`\`\``;

describe('parseFindings', () => {
  test('reads the last asf-findings JSON block, maps severities and skips invalid items', () => {
    const text = `## Review\n\n${fence('[{"severity":"low","title":"old block"}]')}\n\nMore text.\n\n${fence(JSON.stringify([
      { severity: 'HIGH', title: 'SQL injection', file: 'src/db.js', line: 42, description: 'Query is concatenated.', recommendation: 'Use parameters.' },
      { severity: 'moderate', title: 'Missing CSRF token', file: null, line: '7' },
      { severity: 'informational', title: 'Verbose logging' },
      { severity: 'Note', title: 'Consider a linter', file: '' },
      { severity: 'urgent', title: 'unknown severity' },
      { severity: 'high', title: '   ' },
      { title: 'no severity' },
      'not an object',
    ]))}\n\nVERDICT: FAIL`;
    expect(parseFindings(text)).toEqual([
      { severity: 'high', title: 'SQL injection', file: 'src/db.js', line: 42, description: 'Query is concatenated.', recommendation: 'Use parameters.' },
      { severity: 'medium', title: 'Missing CSRF token', file: null, line: 7, description: '', recommendation: null },
      { severity: 'info', title: 'Verbose logging', file: null, line: null, description: '', recommendation: null },
      { severity: 'info', title: 'Consider a linter', file: null, line: null, description: '', recommendation: null },
    ]);
  });

  test('an empty block means no findings, even when bullet lines exist', () => {
    expect(parseFindings(`- HIGH: \`src/a.js\` something.\n\n${fence('[]')}\n\nVERDICT: PASS`)).toEqual([]);
  });

  test('falls back to the V1 bullet lines when there is no block or the block is not a JSON array', () => {
    const text = `## Security review

- Request bodies are capped at 64 KB (\`src/server.js\`) — OK.
- HIGH: \`src/server.js\` echoes raw errors to clients.
* **CRITICAL**: \`src/db.js:42\` SQL built by string concatenation. Use bound parameters.
- **MODERATE:** no CSRF token on forms
- LOW - no rate limiting; acceptable for a local sample.
- INFO: \`eval()\` is used in a dev-only script.
- HIGH: \`C:\\app\\web\\main.tsx:3:9\` innerHTML with user input.

${fence('{ not json')}

VERDICT: FAIL`;
    expect(parseFindings(text)).toEqual([
      { severity: 'high', title: 'echoes raw errors to clients', file: 'src/server.js', line: null, description: 'echoes raw errors to clients.', recommendation: null },
      { severity: 'critical', title: 'SQL built by string concatenation', file: 'src/db.js', line: 42,
        description: 'SQL built by string concatenation. Use bound parameters.', recommendation: null },
      { severity: 'medium', title: 'no CSRF token on forms', file: null, line: null, description: 'no CSRF token on forms', recommendation: null },
      { severity: 'low', title: 'no rate limiting; acceptable for a local sample', file: null, line: null,
        description: 'no rate limiting; acceptable for a local sample.', recommendation: null },
      { severity: 'info', title: '`eval()` is used in a dev-only script', file: null, line: null,
        description: '`eval()` is used in a dev-only script.', recommendation: null },
      { severity: 'high', title: 'innerHTML with user input', file: 'C:\\app\\web\\main.tsx', line: 3, description: 'innerHTML with user input.', recommendation: null },
    ]);
  });

  test('garbage and verdict-only replies produce no findings', () => {
    expect(parseFindings('')).toEqual([]);
    expect(parseFindings('Looks fine to me.\n\nVERDICT: PASS')).toEqual([]);
    expect(parseFindings('HIGH: not a bullet\n- URGENT: not a severity\n- high risk of nothing')).toEqual([]);
    expect(parseFindings(fence('"just a string"'))).toEqual([]);
  });

  test('redacts secrets in every text field and clamps lengths', () => {
    const [secret] = parseFindings(fence(JSON.stringify([{
      severity: 'critical', title: `Key sk-ant-abcdefghijklmnopqrstuvwxyz committed ${'t'.repeat(400)}`, file: `src/${'f'.repeat(400)}.js`,
      description: `api_key=supersecretvalue123 ${'d'.repeat(5000)}`, recommendation: `Rotate token: ghp_abcdefghijklmnopqrstuvwxyz0123 ${'r'.repeat(3000)}`,
    }])));
    expect(secret.title).toMatch(/^Key \[REDACTED\] committed t+$/);
    expect(secret.title).toHaveLength(200);
    expect(secret.file).toHaveLength(300);
    expect(secret.description.startsWith('api_key=[REDACTED] d')).toBe(true);
    expect(secret.description).toHaveLength(4000);
    expect(secret.recommendation!.startsWith('Rotate token: [REDACTED]')).toBe(true);
    expect(secret.recommendation).toHaveLength(2000);
    const [bullet] = parseFindings('- HIGH: `src/a.js` password=hunter2hunter2 is hard-coded.');
    expect(bullet.title).toBe('password=[REDACTED] is hard-coded');
  });

  test('fingerprints ignore case and whitespace', () => {
    expect(fingerprintOf({ source: 'security', file: 'src/Server.js', title: '  Echoes   raw\nerrors ' }))
      .toBe('security|src/server.js|echoes raw errors');
    expect(fingerprintOf({ source: 'review', file: null, title: 'X' })).toBe('review||x');
  });
});

// ------------------------------------------------------------------ repository

let dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
});

const finding = (severity: FindingSeverity, title: string, file: string | null = null, extra: Partial<ParsedFinding> = {}): ParsedFinding =>
  ({ severity, title, file, line: null, description: '', recommendation: null, ...extra });

function setup(): { repos: Repositories; projectId: string; newTask: (runId: string, key?: string) => string } {
  const db = openDatabase(path.join(tempDir('findings'), 'studio.db'));
  dbs.push(db);
  const repos = createRepositories(db);
  const projectId = repos.projects.create({ name: 'Q', slug: 'q', description: '', spec: 'spec', workspaceMode: 'new',
    workspacePath: '/tmp/q', testCommand: 'npm test' }).id;
  const newTask = (runId: string, key = 'security-review'): string => repos.tasks.create(projectId, { runId, key, title: key,
    description: '', role: 'security', kind: 'security', dependsOn: [], orderIndex: 1, maxAttempts: 2 }).id;
  return { repos, projectId, newTask };
}

describe('FindingRepository', () => {
  test('a re-run of the same task keeps status and note of reported findings and marks the others fixed', () => {
    const { repos, projectId, newTask } = setup();
    const runId = createRun(repos, projectId).id;
    const taskId = newTask(runId);
    const first = repos.findings.replaceForTask({ projectId, runId, taskId, source: 'security', findings: [
      finding('high', 'Raw errors', 'src/server.js', { description: 'v1' }), finding('medium', 'No CSRF'), finding('low', 'No rate limit'),
      finding('low', 'Accepted risk'), finding('high', 'raw   ERRORS', 'src/Server.js'), // same fingerprint as the first: dropped
    ] });
    expect(first.map((f) => [f.title, f.status, f.taskId, f.runId])).toEqual([
      ['Raw errors', 'open', taskId, runId], ['No CSRF', 'open', taskId, runId], ['No rate limit', 'open', taskId, runId],
      ['Accepted risk', 'open', taskId, runId],
    ]);
    const [raw, csrf, rate, accepted] = first;
    repos.findings.update(raw.id, { status: 'accepted', note: 'known, token=abcdef123456 kept' });
    repos.findings.update(csrf.id, { status: 'fix_planned', fixTaskId: 'fix-task' });
    repos.findings.update(accepted.id, { status: 'false_positive' });

    const second = repos.findings.replaceForTask({ projectId, runId, taskId, source: 'security', findings: [
      finding('critical', 'Raw errors', 'src/server.js', { line: 10, description: 'v2' }), finding('info', 'New one'),
    ] });
    expect(second.map((f) => f.title)).toEqual(['Raw errors', 'New one']);
    expect(second[0]).toMatchObject({ id: raw.id, status: 'accepted', note: 'known, token=[REDACTED] kept', severity: 'critical', line: 10, description: 'v2' });
    expect(repos.findings.get(csrf.id)).toMatchObject({ status: 'fixed', fixTaskId: 'fix-task' });
    expect(repos.findings.get(rate.id)!.status).toBe('fixed');
    expect(repos.findings.get(accepted.id)!.status).toBe('false_positive'); // user decisions are never overwritten

    // A fixed finding that is reported again reopens.
    repos.findings.replaceForTask({ projectId, runId, taskId, source: 'security', findings: [finding('low', 'No rate limit')] });
    expect(repos.findings.get(rate.id)!.status).toBe('open');
    expect(repos.findings.get(raw.id)!.status).toBe('accepted');
    expect(repos.findings.listByRun(runId)).toHaveLength(5);
  });

  test('matching is per run, task key and source', () => {
    const { repos, projectId, newTask } = setup();
    const run1 = createRun(repos, projectId, 'completed').id;
    const run2 = createRun(repos, projectId).id;
    const [old] = repos.findings.replaceForTask({ projectId, runId: run1, taskId: newTask(run1), source: 'security', findings: [finding('high', 'A')] });
    const otherKey = newTask(run2, 'other-review');
    const [review] = repos.findings.replaceForTask({ projectId, runId: run2, taskId: otherKey, source: 'review', findings: [finding('low', 'B')] });

    const [fresh] = repos.findings.replaceForTask({ projectId, runId: run2, taskId: newTask(run2), source: 'security', findings: [finding('high', 'A')] });
    expect(fresh.id).not.toBe(old.id); // a new run starts over
    expect(fresh.runId).toBe(run2);
    repos.findings.replaceForTask({ projectId, runId: run2, taskId: taskByKeyOf(repos, run2, 'security-review'), source: 'security', findings: [] });
    expect(repos.findings.get(fresh.id)!.status).toBe('fixed');
    expect(repos.findings.get(old.id)!.status).toBe('open'); // the earlier run is untouched
    expect(repos.findings.get(review.id)!.status).toBe('open'); // another task key / source is untouched
  });

  test('list filters, searches, orders by severity and counts without the severity filter', () => {
    const { repos, projectId, newTask } = setup();
    const runId = createRun(repos, projectId).id;
    repos.findings.replaceForTask({ projectId, runId, taskId: newTask(runId), source: 'security', findings: [
      finding('low', 'Low thing', 'src/a.js'), finding('critical', 'Critical thing', 'web/App.tsx'),
      finding('high', 'High thing', null, { description: 'uses 100% of CPU' }), finding('high', 'Another high', 'src/b.js'),
    ] });
    repos.findings.addAudit({ projectId, runId: null, findings: [finding('medium', 'lodash prototype pollution', 'package.json')] });

    const all = repos.findings.list({ projectId });
    expect(all.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'high', 'medium', 'low']);
    expect(all.counts).toEqual({ critical: 1, high: 2, medium: 1, low: 1, info: 0 });
    expect(all.truncated).toBe(false);

    const highs = repos.findings.list({ projectId, severity: 'high' });
    expect(highs.findings.map((f) => f.title).sort()).toEqual(['Another high', 'High thing']);
    expect(highs.counts).toEqual(all.counts);
    expect(repos.findings.list({ projectId, source: 'audit' }).findings.map((f) => f.title)).toEqual(['lodash prototype pollution']);
    expect(repos.findings.list({ runId }).findings).toHaveLength(4);
    expect(repos.findings.list({ projectId, q: 'APP.TSX' }).findings.map((f) => f.title)).toEqual(['Critical thing']);
    expect(repos.findings.list({ projectId, q: '100%' }).findings.map((f) => f.title)).toEqual(['High thing']);
    expect(repos.findings.list({ projectId, q: '%' }).findings.map((f) => f.title)).toEqual(['High thing']);
    expect(repos.findings.list({ projectId, q: 'thing', severity: 'low' }).counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1, info: 0 });
    expect(repos.findings.list({ projectId, status: 'fixed' }).findings).toEqual([]);

    const page = repos.findings.list({ projectId, limit: 2 });
    expect(page.findings.map((f) => f.severity)).toEqual(['critical', 'high']);
    expect(page.truncated).toBe(true);
    expect(repos.findings.list({ projectId: 'missing' })).toEqual({ findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, truncated: false });
  });

  test('a new audit replaces the open audit findings and keeps user decisions', () => {
    const { repos, projectId } = setup();
    const runId = createRun(repos, projectId).id;
    const [a, b, c] = repos.findings.addAudit({ projectId, runId: null, findings: [
      finding('high', 'minimist', 'package.json'), finding('low', 'debug', 'package.json'), finding('medium', 'semver', 'package.json'),
    ] });
    repos.findings.update(c.id, { status: 'accepted' });
    const next = repos.findings.addAudit({ projectId, runId, findings: [finding('critical', 'minimist', 'package.json')] });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: a.id, severity: 'critical', status: 'open', runId, taskId: null, source: 'audit' });
    expect(repos.findings.get(b.id)!.status).toBe('fixed');
    expect(repos.findings.get(c.id)!.status).toBe('accepted');
    expect(() => repos.findings.update('nope', { status: 'open' })).toThrow(/not found/);
  });
});

function taskByKeyOf(repos: Repositories, runId: string, key: string): string {
  return repos.tasks.listByRun(runId).find((t) => t.key === key)!.id;
}

// ------------------------------------------------------------------ end to end

let studios: Studio[] = [];
afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

describe('findings from the security agent', () => {
  test('the scripted FAIL finding is stored with severity and file, and becomes fixed after the passing re-review', async () => {
    const samples = prepareSamples((script) => {
      script.tasks['security-review'].text = '## Security review\n\n- HIGH: `src/server.js` echoes raw errors to clients.\n\nVERDICT: FAIL';
      // The scripted provider replays .asf-script.json from the integration worktree, so the fix task ships a script whose
      // security review passes: the re-review after the fix then reports no findings (with the unchanged sample script
      // the re-review would report the same HIGH finding again and it would stay open).
      const passing = structuredClone(script);
      passing.tasks['security-review'].text = `## Security review\n\nNo findings.\n\n${fence('[]')}\n\nVERDICT: PASS`;
      script.tasks['fix-security-review-1'] = { delayMs: 200, summary: 'Hid internal errors.',
        files: [{ path: '.asf-script.json', content: JSON.stringify(passing, null, 2) }] };
    });
    const studio = await startStudio(tempDir('findings-e2e'), samples);
    studios.push(studio);
    studio.ctx.repos.config.setSetting('studio', { maxFixRounds: 1 });
    const project = await studio.projects.create({ name: 'Findings', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id),
      120_000, 'completion');
    const tasks = studio.ctx.repos.tasks.listByProject(project.id);
    expect(done.status, JSON.stringify(tasks.map((t) => [t.key, t.status, t.error]))).toBe('completed');

    const review = taskByKey(studio, project.id, 'security-review')!;
    expect(review).toMatchObject({ status: 'completed', attempt: 2, dependsOn: ['fix-security-review-1'] });
    const { findings } = studio.ctx.repos.findings.list({ projectId: project.id, source: 'security' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', file: 'src/server.js', title: 'echoes raw errors to clients', source: 'security',
      runId: review.runId, taskId: review.id, status: 'fixed' });

    // First review recorded the finding (open), the passing re-review recorded none.
    const updates = studio.ctx.repos.events.list({ projectId: project.id, limit: 2000 })
      .filter((e) => e.type === 'findings.updated' && e.taskId === review.id);
    expect(updates.map((e) => e.data)).toEqual([
      { runId: review.runId, taskId: review.id, count: 1 }, { runId: review.runId, taskId: review.id, count: 0 },
    ]);
    // The final review's scripted text has no severity bullets: no review findings.
    expect(studio.ctx.repos.findings.list({ projectId: project.id, source: 'review' }).findings).toEqual([]);
  });
});
