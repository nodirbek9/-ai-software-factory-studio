import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Approval, Finding, FindingsResponse, Project, QualityGate, QualityOverview, Run, Task, TestResult } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { AUDIT_COMMAND, AUDIT_TIMEOUT_MS, parseNpmAudit, readLastAudit, type AuditCommandRunner } from '../src/quality/audit.ts';
import { approvePlan, createRun, prepareSamples, projectOf, startStudio, tempDir, waitFor } from './helpers.ts';

// Phase 6 QA & Security API (PHASE_6.md P6-2…P6-4): readiness gates of a Scripted run, the approval-gated npm audit with an
// injected runner (never the network), "Create fix task" on a completed project, and finding triage.

let studio: Studio;
let project: Project;
let run1: Run;

interface Reply<T> { status: number; body: T }

async function call<T = any>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await studio.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { status: res.statusCode, body: res.json() as T };
}

const overview = async (projectId: string, query = ''): Promise<QualityOverview> =>
  (await call<QualityOverview>('GET', `/api/v2/projects/${projectId}/quality${query}`)).body;
const gatesOf = (value: QualityOverview): Record<string, QualityGate['state']> =>
  Object.fromEntries(value.readiness!.gates.map((g) => [g.id, g.state]));
const auditFindings = async (): Promise<FindingsResponse> =>
  (await call<FindingsResponse>('GET', `/api/v2/findings?projectId=${project.id}&source=audit`)).body;
const findingTitled = async (prefix: string): Promise<Finding> => (await auditFindings()).findings.find((f) => f.title.startsWith(prefix))!;

/** npm 7+ `npm audit --json` output (trimmed real-world shape). */
const NPM7_AUDIT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    debug: { name: 'debug', severity: 'low', isDirect: true, range: '<2.6.9', nodes: ['node_modules/debug'], fixAvailable: false,
      via: [{ source: 1, name: 'debug', title: 'Regular Expression Denial of Service in debug', url: 'https://github.com/advisories/GHSA-gxpj-cx7g-858c', severity: 'low' }] },
    minimist: { name: 'minimist', severity: 'critical', isDirect: false, range: '<0.2.4', nodes: ['node_modules/minimist'], fixAvailable: true,
      via: [{ source: 2, name: 'minimist', title: 'Prototype Pollution in minimist', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', severity: 'critical' }] },
    mkdirp: { name: 'mkdirp', severity: 'high', isDirect: true, range: '0.4.1 - 0.5.1', nodes: ['node_modules/mkdirp'], via: ['minimist'],
      fixAvailable: { name: 'mkdirp', version: '3.0.1', isSemVerMajor: true } },
    semver: { name: 'semver', severity: 'moderate', isDirect: true, range: '<5.7.2', nodes: ['node_modules/semver'], fixAvailable: true,
      via: [{ source: 3, name: 'semver', title: 'semver vulnerable to Regular Expression Denial of Service', url: 'https://github.com/advisories/GHSA-c2qf-rxjj-qqgw', severity: 'moderate' }] },
  },
  metadata: { vulnerabilities: { info: 0, low: 1, moderate: 1, high: 1, critical: 1, total: 4 } },
});

const auditCalls: { command: string; cwd: string; timeoutMs: number; approved: boolean }[] = [];
const fakeAudit: AuditCommandRunner = async (command, cwd, options) => {
  auditCalls.push({ command, cwd, ...options });
  // npm exits 1 when vulnerabilities exist; the report is still on stdout.
  return { exitCode: 1, stdout: NPM7_AUDIT, stderr: '', timedOut: false };
};

/** A project with a hand-made run (no workspace, no agents) for gate and refusal checks. */
function syntheticProject(name: string, runStatus: Run['status']): { project: Project; run: Run } {
  const repos = studio.ctx.repos;
  const created = repos.projects.create({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, description: '', spec: 'spec',
    workspaceMode: 'new', workspacePath: tempDir('quality-synthetic'), testCommand: 'npm test' });
  return { project: created, run: createRun(repos, created.id, runStatus) };
}

function addTask(project: Project, run: Run, key: string, kind: Task['kind'], patch: Parameters<Studio['ctx']['repos']['tasks']['update']>[1],
  command?: string): Task {
  const repos = studio.ctx.repos;
  const task = repos.tasks.create(project.id, { runId: run.id, key, title: key, description: '', role: kind === 'review' ? 'reviewer' : 'qa',
    kind, dependsOn: [], orderIndex: repos.tasks.listByRun(run.id).length, maxAttempts: 1, options: command ? { command } : {} });
  return repos.tasks.update(task.id, { finishedAt: new Date().toISOString(), ...patch });
}

beforeAll(async () => {
  const samples = prepareSamples((script) => {
    script.tasks['fix-finding-1'] = { delayMs: 200, summary: 'Pinned minimist to a fixed version.',
      files: [{ path: 'SECURITY_NOTES.md', content: '# Security notes\n\nminimist upgraded (audit finding).\n' }] };
  });
  studio = await startStudio(tempDir('quality'), samples);
  studio.quality.auditDeps = { run: fakeAudit };
  project = await studio.projects.create({ name: 'Quality View', spec: '', workspaceMode: 'sample', sampleName: 'todo-service', testCommand: 'npm test' });
  studio.projects.startPlanning(project.id);
  await approvePlan(studio, project.id);
  const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id), 150_000, 'run 1');
  expect(done.status, JSON.stringify(studio.ctx.repos.tasks.listByProject(project.id).map((t) => [t.key, t.status, t.error]))).toBe('completed');
  project = done;
  run1 = studio.ctx.repos.runs.latestForProject(project.id)!;
}, 180_000);

afterAll(async () => { await studio?.close(); });

describe('parseNpmAudit', () => {
  test('npm 7+: one finding per package, severities mapped, titles/descriptions/recommendations from the report', () => {
    const findings = parseNpmAudit(NPM7_AUDIT);
    expect(findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', 'minimist: Prototype Pollution in minimist'],
      ['high', 'mkdirp: vulnerable dependency (via minimist)'],
      ['medium', 'semver: semver vulnerable to Regular Expression Denial of Service'],
      ['low', 'debug: Regular Expression Denial of Service in debug'],
    ]);
    expect(findings.every((f) => f.file === 'package-lock.json' && f.line === null)).toBe(true);
    expect(findings[0].description).toContain('https://github.com/advisories/GHSA-xvch-5gv4-984h');
    expect(findings[0].recommendation).toMatch(/npm audit fix/);
    expect(findings[1].description).toMatch(/Vulnerable through: minimist/);
    expect(findings[1].recommendation).toMatch(/mkdirp@3\.0\.1.*semver-major/);
    expect(findings[3].recommendation).toMatch(/No fix is available/);
    expect(parseNpmAudit(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }))).toEqual([]);
  });

  test('npm 6 advisories are grouped per module with the worst severity', () => {
    const findings = parseNpmAudit(JSON.stringify({ advisories: {
      1: { module_name: 'lodash', severity: 'moderate', title: 'Prototype Pollution', url: 'https://npmjs.com/advisories/1', vulnerable_versions: '<4.17.12',
        recommendation: 'Update to version 4.17.12 or later.' },
      2: { module_name: 'lodash', severity: 'high', title: 'Command Injection', url: 'https://npmjs.com/advisories/2', recommendation: 'Update to 4.17.21.' },
      3: { module_name: 'ms', severity: 'info', title: 'Inefficient regex' },
    } }));
    expect(findings.map((f) => [f.severity, f.title])).toEqual([['high', 'lodash: Prototype Pollution'], ['info', 'ms: Inefficient regex']]);
    expect(findings[0].description).toContain('Command Injection (https://npmjs.com/advisories/2)');
    expect(findings[0].recommendation).toBe('Update to version 4.17.12 or later.');
  });

  test('invalid JSON, npm error reports and unknown shapes throw clear errors', () => {
    expect(() => parseNpmAudit('npm ERR! something broke')).toThrow(/valid JSON/);
    expect(() => parseNpmAudit('')).toThrow(/no JSON/);
    expect(() => parseNpmAudit(JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } })))
      .toThrow(/npm audit failed: This command requires an existing lockfile/);
    expect(() => parseNpmAudit('{"hello":1}')).toThrow(/unrecognised/);
  });
});

describe('GET /api/v2/projects/:id/quality', () => {
  test('a completed Scripted run: tests/security/review passed, build/audit/coverage not run, never ready', async () => {
    const value = await overview(project.id);
    expect(value.readiness).toMatchObject({ runId: run1.id, runNumber: 1, ready: false });
    expect(gatesOf(value)).toEqual({ build: 'not_run', tests: 'passed', security: 'passed', review: 'passed', audit: 'not_run', coverage: 'not_run' });
    const gates = new Map(value.readiness!.gates.map((g) => [g.id, g]));
    expect(gates.get('tests')!.detail).toMatch(/^api-tests: \d+ passed, 0 failed/);
    expect(gates.get('security')).toMatchObject({ label: 'Security review', detail: 'security-review: VERDICT PASS' });
    expect(gates.get('review')!.taskId).toBe(studio.ctx.repos.tasks.listByRun(run1.id).find((t) => t.key === 'final-review')!.id);
    expect(gates.get('build')!.detail).toMatch(/No build step/);

    expect(value.testRuns.map((r) => [r.taskKey, r.result.passed, r.runId])).toEqual([['api-tests', true, run1.id]]);
    expect(value.pendingAuditApprovalId).toBeNull();
    const scanners = new Map(value.scanners.map((s) => [s.id, s]));
    expect([...scanners.keys()]).toEqual(['tests', 'security-agent', 'review-agent', 'npm-audit', 'guardian']);
    expect(scanners.get('tests')).toMatchObject({ available: true, version: null });
    expect(scanners.get('tests')!.lastRunAt).not.toBeNull();
    // Only the offline Scripted provider is enabled: it is not an AI, so the agent scanners are honestly unavailable.
    expect(scanners.get('security-agent')).toMatchObject({ available: false, note: expect.stringMatching(/No usable AI provider/) });
    expect(scanners.get('npm-audit')).toMatchObject({ available: true, version: null, lastRunAt: null });
    expect(scanners.get('guardian')).toMatchObject({ available: false, note: 'Not installed — integration contract ready' });

    expect(await overview(project.id, `?runId=${run1.id}`)).toEqual(value);
  });

  test('a FAIL verdict is "failed", any other review failure "error", a build command counts; unknown ids are 404', async () => {
    const { project: other, run } = syntheticProject('Gates', 'failed');
    const passed: TestResult = { command: 'npm test', exitCode: 0, passed: true, durationMs: 10, outputTail: '', summary: '3 passed, 0 failed' };
    addTask(other, run, 'build', 'command', { status: 'completed' }, 'npm run build');
    addTask(other, run, 'unit-tests', 'test', { status: 'completed', testResult: passed });
    addTask(other, run, 'security-review', 'security', { status: 'failed', error: 'No usable provider for security: Claude Code is disabled' });
    const review = addTask(other, run, 'final-review', 'review', { status: 'failed', error: 'Reviewer verdict: FAIL — see review findings' });

    const value = await overview(other.id);
    expect(gatesOf(value)).toEqual({ build: 'passed', tests: 'passed', security: 'error', review: 'failed', audit: 'not_run', coverage: 'not_run' });
    const reviewGate = value.readiness!.gates.find((g) => g.id === 'review')!;
    expect(reviewGate).toMatchObject({ detail: 'final-review: VERDICT FAIL', taskId: review.id });
    expect(value.readiness!.ready).toBe(false);
    // No package.json in this workspace: the audit is unavailable and cannot be requested.
    expect(value.scanners.find((s) => s.id === 'npm-audit')).toMatchObject({ available: false, note: 'No package.json in this project' });
    expect((await call('POST', `/api/v2/projects/${other.id}/quality/audit`, { confirm: true })).status).toBe(400);

    expect((await call('GET', `/api/v2/projects/${other.id}/quality?runId=${run1.id}`)).status).toBe(404);
    expect((await call('GET', `/api/v2/projects/${project.id}/quality?runId=${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', `/api/v2/projects/${randomUUID()}/quality`)).status).toBe(404);
    expect((await call('GET', '/api/v2/projects/not-a-uuid/quality')).status).toBe(400);
  });
});

describe('npm audit (approval-gated)', () => {
  test('approving the audit runs it once with the injected runner and stores mapped findings', async () => {
    expect((await call('POST', `/api/v2/projects/${project.id}/quality/audit`, {})).status).toBe(400); // no confirm
    const requested = await call<{ approval: Approval }>('POST', `/api/v2/projects/${project.id}/quality/audit`, { confirm: true });
    expect(requested.status).toBe(201);
    const { approval } = requested.body;
    expect(approval).toMatchObject({ kind: 'command', status: 'pending', taskId: null, details: { command: AUDIT_COMMAND, purpose: 'audit' } });
    expect((await call('POST', `/api/v2/projects/${project.id}/quality/audit`, { confirm: true })).status).toBe(409);
    expect((await overview(project.id)).pendingAuditApprovalId).toBe(approval.id);
    expect(auditCalls).toHaveLength(0);

    studio.projects.decideApproval(approval.id, 'approved', null);
    const audit = await waitFor(() => readLastAudit(studio.ctx, project.id), 10_000, 'audit result');
    expect(audit).toMatchObject({ ok: true, error: null, counts: { critical: 1, high: 1, medium: 1, low: 1, info: 0 } });
    expect(auditCalls).toEqual([{ command: AUDIT_COMMAND, cwd: project.integrationPath, timeoutMs: AUDIT_TIMEOUT_MS, approved: true }]);
    await waitFor(() => !studio.quality.isAuditRunning(project.id), 10_000, 'audit finished');
    // The audit is a one-off: it never joins the project's approved commands.
    expect(studio.ctx.repos.config.getSetting<string[]>(`approvedCommands:${project.id}`, [])).not.toContain(AUDIT_COMMAND);
    expect(studio.ctx.repos.events.list({ projectId: project.id, limit: 50 }).some((e) => e.type === 'quality.audit')).toBe(true);

    const { findings, counts } = await auditFindings();
    expect(findings.map((f) => [f.title.split(':')[0], f.severity, f.source, f.status, f.runId]).sort()).toEqual([
      ['debug', 'low', 'audit', 'open', run1.id],
      ['minimist', 'critical', 'audit', 'open', run1.id],
      ['mkdirp', 'high', 'audit', 'open', run1.id],
      ['semver', 'medium', 'audit', 'open', run1.id],
    ]);
    expect(counts).toMatchObject({ critical: 1, high: 1, medium: 1, low: 1 });
    const value = await overview(project.id);
    expect(value.pendingAuditApprovalId).toBeNull();
    expect(gatesOf(value).audit).toBe('failed');
    expect(value.readiness!.blockingFindings).toBe(2);
    expect(value.scanners.find((s) => s.id === 'npm-audit')!.lastRunAt).toBe(audit.at);
  });

  test('a rejected audit approval runs nothing', async () => {
    const before = readLastAudit(studio.ctx, project.id);
    const { approval } = (await call<{ approval: Approval }>('POST', `/api/v2/projects/${project.id}/quality/audit`, { confirm: true })).body;
    studio.projects.decideApproval(approval.id, 'rejected', 'not now');
    expect(auditCalls).toHaveLength(1);
    expect(studio.quality.isAuditRunning(project.id)).toBe(false);
    expect(readLastAudit(studio.ctx, project.id)).toEqual(before);
    expect(studio.ctx.repos.approvals.get(approval.id)!.status).toBe('rejected');
  });
});

describe('POST /api/v2/findings/:id/fix-task', () => {
  test('creates a fix task in the current run, reopens the completed project and the task completes', async () => {
    const finding = await findingTitled('minimist');
    expect((await call('POST', `/api/v2/findings/${finding.id}/fix-task`, {})).status).toBe(400); // no confirm
    const created = await call<{ task: Task }>('POST', `/api/v2/findings/${finding.id}/fix-task`, { confirm: true });
    expect(created.status).toBe(201);
    const { task } = created.body;
    expect(task).toMatchObject({ key: 'fix-finding-1', kind: 'implement', role: 'backend', dependsOn: [], runId: run1.id });
    expect(task.description).toContain('Prototype Pollution in minimist');
    expect(task.description).toContain('File: package-lock.json');
    expect(task.description).toMatch(/Recommendation:\nRun `npm audit fix`/);
    expect(projectOf(studio, project.id).status).toBe('running');
    expect(studio.ctx.repos.findings.get(finding.id)).toMatchObject({ status: 'fix_planned', fixTaskId: task.id });

    expect((await call('POST', `/api/v2/findings/${finding.id}/fix-task`, { confirm: true })).status).toBe(409);
    expect((await call('POST', `/api/v2/findings/${randomUUID()}/fix-task`, { confirm: true })).status).toBe(404);

    const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id), 60_000, 'fix task');
    const fixed = studio.ctx.repos.tasks.get(task.id)!;
    expect(fixed.status, fixed.error ?? '').toBe('completed');
    expect(fixed.filesChanged).toEqual(['SECURITY_NOTES.md']);
    expect(done.status).toBe('completed');
    expect(studio.ctx.repos.runs.get(run1.id)!.status).toBe('completed');
  }, 90_000);

  test('refused while the run is still being planned', async () => {
    const { project: planning, run } = syntheticProject('Planning', 'planning');
    studio.ctx.repos.projects.update(planning.id, { status: 'planning' });
    const [finding] = studio.ctx.repos.findings.addAudit({ projectId: planning.id, runId: run.id, findings: [{ severity: 'high', title: 'x: y',
      file: 'package-lock.json', line: null, description: 'd', recommendation: null }] });
    const refused = await call<{ error: string }>('POST', `/api/v2/findings/${finding.id}/fix-task`, { confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/planned/);
    expect(studio.ctx.repos.tasks.listByRun(run.id)).toEqual([]);
  });
});

describe('PATCH /api/v2/findings/:id', () => {
  test('sets the triage status and note; keeps the note when none is sent', async () => {
    const finding = await findingTitled('semver');
    const accepted = await call<{ finding: Finding }>('PATCH', `/api/v2/findings/${finding.id}`, { status: 'accepted', note: 'dev dependency only' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.finding).toMatchObject({ id: finding.id, status: 'accepted', note: 'dev dependency only' });
    const listed = (await call<FindingsResponse>('GET', `/api/v2/findings?projectId=${project.id}&status=accepted`)).body.findings;
    expect(listed.map((f) => f.id)).toEqual([finding.id]);

    const reopened = await call<{ finding: Finding }>('PATCH', `/api/v2/findings/${finding.id}`, { status: 'open' });
    expect(reopened.body.finding).toMatchObject({ status: 'open', note: 'dev dependency only' });
    const falsePositive = await call<{ finding: Finding }>('PATCH', `/api/v2/findings/${finding.id}`, { status: 'false_positive', note: null });
    expect(falsePositive.body.finding).toMatchObject({ status: 'false_positive', note: null });
  });

  test('rejects statuses the user cannot set, bad queries and unknown ids', async () => {
    const finding = await findingTitled('debug');
    expect((await call('PATCH', `/api/v2/findings/${finding.id}`, { status: 'fixed' })).status).toBe(400);
    expect((await call('PATCH', `/api/v2/findings/${finding.id}`, { status: 'fix_planned' })).status).toBe(400);
    expect((await call('PATCH', `/api/v2/findings/${randomUUID()}`, { status: 'accepted' })).status).toBe(404);
    expect((await call('GET', '/api/v2/findings?severity=urgent')).status).toBe(400);
    expect((await call('GET', `/api/v2/findings?projectId=${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', `/api/v2/findings?runId=${randomUUID()}`)).status).toBe(404);
  });
});
