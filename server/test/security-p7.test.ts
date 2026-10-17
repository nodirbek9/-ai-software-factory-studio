import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Run, Task, WorkflowGraph, WorkflowNode } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { lastAuditKey, type LastAudit } from '../src/quality/audit.ts';
import { ingestTaskFindings, parseFindingsReport } from '../src/quality/findings.ts';
import { isSensitivePath } from '../src/security/sensitiveFiles.ts';
import { SessionError, SessionManager } from '../src/sessions/sessionManager.ts';
import { commitAll, git } from '../src/workspace/git.ts';
import { readHead, SensitiveFileError, WorkspaceManager } from '../src/workspace/workspaceManager.ts';
import { createRun, prepareSamples, startStudio, tempDir, waitFor } from './helpers.ts';

let fixtureRoot: string;
const studios: Studio[] = [];
const managers: SessionManager[] = [];

beforeEach(() => {
  // Keep helpers' temporary files inside the project, including copied samples.
  fixtureRoot = fs.mkdtempSync(path.resolve('.security-p7-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(fixtureRoot);
});

afterEach(async () => {
  try {
    for (const manager of managers.splice(0)) await manager.shutdown();
    for (const studio of studios.splice(0)) await studio.close();
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function setup(samples = prepareSamples()): Promise<Studio> {
  const studio = await startStudio(tempDir('p7-studio'), samples);
  studios.push(studio);
  return studio;
}

function workspace(): { root: string; manager: WorkspaceManager } {
  const root = tempDir('p7-files');
  return { root, manager: new WorkspaceManager(loadConfig({ dataDir: root, approvedRoots: [] })) };
}

function seed(studio: Studio): { project: Project; run: Run } {
  const project = studio.ctx.repos.projects.create({ name: 'P7', slug: 'p7', description: '', spec: 'Security regression',
    workspaceMode: 'new', workspacePath: tempDir('p7-project'), testCommand: 'node --test' });
  return { project, run: createRun(studio.ctx.repos, project.id, 'completed') };
}

function task(studio: Studio, project: Project, run: Run, kind: Task['kind']): Task {
  return studio.ctx.repos.tasks.create(project.id, { runId: run.id, key: kind, title: kind, description: '',
    role: kind === 'security' ? 'security' : 'backend', kind, dependsOn: [], orderIndex: 1, maxAttempts: 1 });
}

const fence = (body: string): string => `\`\`\`asf-findings\n${body}\n\`\`\``;

describe('Phase 7 security regressions', () => {
  it('P7-S1: diff and show cannot execute a repository textconv driver that plain git executes', async (ctx) => {
    // Arrange: a real repository-local driver with a harmless marker as its observable side effect.
    const dir = tempDir('p7-textconv');
    const marker = path.join(dir, 'textconv-ran');
    await git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'before\n');
    await commitAll(dir, 'initial');
    const configured = spawnSync('git', ['config', 'diff.evil.textconv', `touch '${marker.replace(/\\/g, '/')}'`],
      { cwd: dir, encoding: 'utf8' });
    expect(configured.status, configured.stderr).toBe(0);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'after\n');
    const control = spawnSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
    if (!fs.existsSync(marker)) {
      ctx.skip(`Plain git textconv did not create the control marker on this machine (exit ${control.status})`);
      return;
    }
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    // Act / Assert: studio reads return the real patch without running the configured command.
    expect(await git(dir, ['diff'])).toContain('+after');
    expect(fs.existsSync(marker)).toBe(false);
    await commitAll(dir, 'change');
    const showControl = spawnSync('git', ['show', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    expect(showControl.status, showControl.stderr).toBe(0);
    expect(fs.existsSync(marker), 'plain show must execute the same driver').toBe(true);
    fs.unlinkSync(marker);
    expect(await git(dir, ['show', 'HEAD'])).toContain('+after');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('P7-S3: readFile rejects a harmless-looking symlink to an in-root sensitive file', (ctx) => {
    // Arrange
    const { root, manager } = workspace();
    const target = path.join(root, 'private.pem');
    const link = path.join(root, 'public.txt');
    fs.writeFileSync(target, 'test fixture only');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      ctx.skip('File symlinks require Windows Developer Mode or symlink privileges (EPERM)');
      return;
    }

    // Act / Assert
    expect(manager.isSensitiveTarget(root, 'public.txt', link)).toBe(true);
    expect(() => manager.readFile(root, 'public.txt')).toThrow(SensitiveFileError);
  });

  it('P7-S4: credential stores and credential directories are sensitive, ordinary source and examples are safe', () => {
    // Arrange
    const sensitive = ['.npmrc', 'credentials.json', 'sub/.credentials.json', '.git-credentials', '.netrc', '.pypirc',
      '.ssh/config', 'x/.aws/credentials', 'x\\.aws\\credentials'];
    const safe = ['src/credentials.ts', 'docs/npmrc.md', '.env.example', 'src/app.ts'];

    // Act / Assert
    for (const file of sensitive) expect(isSensitivePath(file), file).toBe(true);
    for (const file of safe) expect(isSensitivePath(file), file).toBe(false);
  });

  it('P7-S7: file reads truncate a 2 MB text file at 512 KiB and readHead preserves small files and boundaries', () => {
    // Arrange
    const { root, manager } = workspace();
    const limit = 512 * 1024;
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
    const small = path.join(root, 'small.txt');
    const bytes = Buffer.from('hello Unicode: \u2603\n');
    fs.writeFileSync(small, bytes);

    // Act
    const large = manager.readFile(root, 'large.txt');
    const head = readHead(small, limit);

    // Assert
    expect(large).toEqual({ content: 'x'.repeat(limit), truncated: true, binary: false });
    expect(large.content).toHaveLength(limit);
    expect(head).toEqual({ bytes, truncated: false });
    expect(readHead(small, bytes.length)).toEqual({ bytes, truncated: false });
    expect(readHead(small, bytes.length - 1)).toEqual({ bytes: bytes.subarray(0, -1), truncated: true });
    fs.writeFileSync(small, '');
    expect(readHead(small, limit)).toEqual({ bytes: Buffer.alloc(0), truncated: false });
  });

  it('P7-S2: discard keeps uncommitted work on a WIP commit failure, then preserves it on the branch after retry', async () => {
    // Arrange: use the real SessionManager and a real git index lock, without invoking an agent.
    const studio = await setup();
    const project = await studio.projects.create({ name: 'P7 discard', spec: 'test', workspaceMode: 'new' });
    const sessions = new SessionManager(studio.ctx);
    managers.push(sessions);
    const session = await sessions.create(project.id, { role: 'backend', providerId: 'scripted', model: '', effort: '', mode: 'edit' });
    const worktree = session.worktreePath!;
    const changed = path.join(worktree, 'SPEC.md');
    fs.appendFileSync(changed, '\nUncommitted P7 work\n');
    const contents = fs.readFileSync(changed, 'utf8');
    const gitdir = /^gitdir: (.+)\r?$/m.exec(fs.readFileSync(path.join(worktree, '.git'), 'utf8'))![1];
    const lock = path.join(path.resolve(worktree, gitdir), 'index.lock');
    fs.writeFileSync(lock, '');

    // Act / Assert: a failed save must reject before removing any work.
    const failure = await sessions.discard(session.id).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionError);
    expect(failure).toMatchObject({ statusCode: 409 });
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.readFileSync(changed, 'utf8')).toBe(contents);
    expect(sessions.get(session.id).worktreePath).toBe(worktree);

    fs.unlinkSync(lock);
    const discarded = await sessions.discard(session.id);
    expect(discarded.worktreePath).toBeNull();
    expect(fs.existsSync(worktree)).toBe(false);
    expect(await git(project.integrationPath!, ['log', '-1', '--format=%s', session.branch!])).toContain(`wip(session-${session.number})`);
    expect(await git(project.integrationPath!, ['show', `${session.branch}:SPEC.md`])).toBe(contents.trim());
  });

  it('P7-S5: malformed and empty failing reviews keep open findings until a valid empty passing report', async () => {
    // Arrange
    const studio = await setup();
    const { project, run } = seed(studio);
    const security = task(studio, project, run, 'security');
    const valid = fence(JSON.stringify([{ severity: 'high', title: 'Unsafe query', file: 'src/db.ts' }]));
    const malformed = fence('{not valid JSON');
    const [finding] = ingestTaskFindings(studio.ctx, security, valid, 'security', 'fail');
    const status = () => studio.ctx.repos.findings.listByRun(run.id).find((f) => f.id === finding.id)?.status;
    expect(status()).toBe('open');

    // Act / Assert: unreliable replies must never close the earlier finding.
    expect(parseFindingsReport(valid)).toMatchObject({ malformed: false, findings: [{ title: 'Unsafe query' }] });
    expect(parseFindingsReport(malformed)).toEqual({ malformed: true, findings: [] });
    expect(parseFindingsReport(fence('[]'))).toEqual({ malformed: false, findings: [] });
    expect(parseFindingsReport('VERDICT: FAIL')).toEqual({ malformed: false, findings: [] });
    ingestTaskFindings(studio.ctx, security, malformed, 'security', 'pass');
    expect(status()).toBe('open');
    expect(studio.ctx.repos.events.list({ projectId: project.id, limit: 100 }).some((event) =>
      event.type === 'findings.error' && event.taskId === security.id)).toBe(true);
    ingestTaskFindings(studio.ctx, security, 'VERDICT: FAIL', 'security', 'fail');
    expect(status()).toBe('open');
    ingestTaskFindings(studio.ctx, security, fence('[]'), 'security', 'pass');
    expect(status()).toBe('fixed');
  });

  it('P7-S6: a custom sec-1 security node runs project tests before emitting its review output', async () => {
    // Arrange: a minimal real workflow exercises scheduling, runReview, commands and the scripted provider.
    const samples = prepareSamples((script) => {
      script.tasks['sec-1'] = { delayMs: 1, summary: 'P7 custom security review.\nVERDICT: PASS', files: [] };
    });
    const studio = await setup(samples);
    const project = await studio.projects.create({ name: 'P7 custom security', spec: '', workspaceMode: 'sample',
      sampleName: 'todo-service', testCommand: 'node --test' });
    fs.mkdirSync(path.join(project.integrationPath!, 'test'), { recursive: true });
    fs.writeFileSync(path.join(project.integrationPath!, 'test/p7.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('p7', () => assert.equal(2 + 2, 4));\n");
    await commitAll(project.integrationPath!, 'passing project test');
    const node = (id: string, type: WorkflowNode['type']): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, config: {} });
    const graph: WorkflowGraph = { schemaVersion: 1, nodes: [node('start', 'trigger'), node('sec-1', 'security'), node('done', 'notify')],
      edges: [{ id: 'a', source: 'start', target: 'sec-1' }, { id: 'b', source: 'sec-1', target: 'done' }] };
    const workflow = studio.ctx.repos.workflows.create({ name: 'P7 security', projectId: project.id, graph });

    // Act
    const run = studio.runs.start(project.id, workflow.id);
    const finished = await waitFor(() => {
      const current = studio.ctx.repos.runs.get(run.id)!;
      return current.finishedAt ? current : null;
    }, 60_000, 'custom security run');

    // Assert
    const security = studio.ctx.repos.tasks.listByRun(run.id).find((t) => t.key === 'sec-1')!;
    expect(finished.status, security.error ?? '').toBe('completed');
    expect(security).toMatchObject({ kind: 'security', status: 'completed', testResult: { passed: true, command: 'node --test' } });
    expect(security.resultSummary).toContain('VERDICT: PASS');
    const events = studio.ctx.repos.events.list({ projectId: project.id, limit: 1000 }).filter((e) => e.taskId === security.id);
    const result = events.find((e) => e.type === 'test.result');
    const output = events.find((e) => e.type === 'agent.output');
    expect(result).toBeDefined();
    expect(output).toBeDefined();
    expect(result!.id).toBeLessThan(output!.id);
  });

  it('P7-S9: an audit becomes stale after this run implements code and a newer audit is judged by counts', async () => {
    // Arrange: deterministic timestamps and stored audit results; no npm audit or network access.
    const studio = await setup();
    const { project, run } = seed(studio);
    const base = Date.parse(run.startedAt);
    const at = (offset: number) => new Date(base + offset).toISOString();
    const audit: LastAudit = { at: at(1000), ok: true, error: null, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } };
    const gate = async () => (await studio.quality.overview(project.id, run.id)).readiness!.gates.find((g) => g.id === 'audit')!;
    studio.ctx.repos.config.setSetting(lastAuditKey(project.id), audit);
    expect((await gate()).state).toBe('passed');
    const implement = task(studio, project, run, 'implement');

    // Act / Assert
    studio.ctx.repos.tasks.update(implement.id, { status: 'completed', finishedAt: at(2000) });
    expect(await gate()).toMatchObject({ state: 'not_run', detail: expect.stringContaining("older than this run's latest code change") });
    studio.ctx.repos.config.setSetting(lastAuditKey(project.id), { ...audit, at: at(3000) });
    expect((await gate()).state).toBe('passed');
    studio.ctx.repos.config.setSetting(lastAuditKey(project.id), { ...audit, at: at(4000), counts: { ...audit.counts, high: 1 } });
    expect((await gate()).state).toBe('failed');
  });
});
