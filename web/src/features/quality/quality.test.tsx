import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Finding, FindingsResponse, QualityGate, QualityGateId, QualityOverview, ReleaseReadiness, Run, ScannerInfo, GateState } from '@asf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Quality, { auditBlocker, buildFindingQuery } from '@/pages/Quality';
import * as workflowsApi from '@/features/workflows/workflowsApi';
import { useStudio } from '@/store/studio';
import { eventFixture, projectFixture, taskFixture } from '@/test/sessionFixtures';
import { actionBlocker } from './FindingDrawer';
import { isReady, readinessReasons } from './ReadinessStrip';
import * as api from './qualityApi';

vi.mock('./qualityApi');
vi.mock('@/features/workflows/workflowsApi');

const mocked = vi.mocked(api);
const mockedRuns = vi.mocked(workflowsApi);

const LABEL: Record<QualityGateId, string> = {
  build: 'Build', tests: 'Tests', security: 'Security review', review: 'Code review', audit: 'Dependency audit', coverage: 'Coverage',
};
const IDS = Object.keys(LABEL) as QualityGateId[];

function gate(id: QualityGateId, state: GateState, detail = `${id} detail`): QualityGate {
  return { id, label: LABEL[id], state, detail, taskId: null, at: null };
}

function readiness(states: Partial<Record<QualityGateId, GateState>> = {}, overrides: Partial<ReleaseReadiness> = {}): ReleaseReadiness {
  const gates = IDS.map((id) => gate(id, states[id] ?? 'not_run'));
  return { runId: 'run-1', runNumber: 1, gates, ready: gates.every((g) => g.state === 'passed'), blockingFindings: 0, ...overrides };
}

const SCANNERS: ScannerInfo[] = [
  { id: 'tests', label: 'Test runner', available: true, version: null, lastRunAt: null, note: 'runs with each QA task' },
  { id: 'npm-audit', label: 'npm audit', available: true, version: '10.9.0', lastRunAt: null, note: 'needs your approval — network access' },
  { id: 'guardian', label: 'Guardian', available: false, version: null, lastRunAt: null, note: 'internal note' },
];

function overviewOf(overrides: Partial<QualityOverview> = {}): QualityOverview {
  return { projectId: 'project-1', readiness: readiness(), testRuns: [], scanners: SCANNERS, pendingAuditApprovalId: null, ...overrides };
}

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id, projectId: 'project-1', runId: 'run-1', taskId: 'task-security-1', source: 'security', severity: 'high', title: `Finding ${id}`, file: 'src/auth.ts', line: 12,
    description: `Description ${id}`, recommendation: `Fix ${id}`, status: 'open', note: null, fixTaskId: null,
    createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', ...overrides,
  };
}

const FINDINGS: Finding[] = [
  finding('f1', { severity: 'critical', title: 'SQL injection' }),
  finding('f2', { severity: 'high', title: 'Weak hash', file: null, line: null }),
  finding('f3', { severity: 'medium', title: 'Missing CSRF token', status: 'accepted', note: 'known' }),
];

function response(findings: Finding[] = FINDINGS): FindingsResponse {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return { findings, counts, truncated: false };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', projectId: 'project-1', number: 1, workflowId: 'wf', workflowName: 'Standard', workflowVersion: 1, status: 'running', trigger: 'manual',
    baseCommit: null, startedAt: '2026-10-16T10:00:00Z', finishedAt: null, errorSummary: null, durationMs: null, costUsd: null, tasksTotal: 3, tasksCompleted: 1, ...overrides,
  };
}

function setup(overview: QualityOverview = overviewOf(), findings: Finding[] = FINDINGS) {
  mocked.getQuality.mockResolvedValue(overview);
  mocked.listFindings.mockResolvedValue(response(findings));
  mocked.updateFinding.mockImplementation(async (id, input) => ({ ...(findings.find((f) => f.id === id) ?? findings[0]), status: input.status, note: input.note ?? null }));
  mocked.createFixTask.mockResolvedValue(taskFixture({ key: 'fix-finding-1' }));
  mocked.requestAudit.mockResolvedValue({ id: 'ap-1', projectId: 'project-1', taskId: null, kind: 'command', status: 'pending', title: 'npm audit', details: {}, note: null, createdAt: '', decidedAt: null });
  mockedRuns.listRuns.mockResolvedValue({ runs: [run(), run({ id: 'run-2', number: 2 })], nextBefore: null });
}

async function openPage(overview?: QualityOverview, findings?: Finding[]) {
  setup(overview, findings);
  render(<Quality />);
  await screen.findByRole('region', { name: 'Release readiness' });
  await waitFor(() => expect(screen.queryByLabelText('Loading findings')).toBeNull());
}

const lastQuery = () => mocked.listFindings.mock.lastCall?.[0];
const gateCard = (id: QualityGateId) => document.querySelector(`[data-gate="${id}"]`) as HTMLElement;

async function openDrawer(id: string) {
  fireEvent.click(await waitFor(() => {
    const row = document.querySelector(`tr[data-finding="${id}"]`);
    expect(row).toBeTruthy();
    return row as Element;
  }));
  const dialog = await screen.findByRole('dialog');
  return within(dialog);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ currentProjectId: 'project-1', projects: [projectFixture()] });
});

describe('release readiness', () => {
  it('shows Not run in grey and never as a pass', async () => {
    await openPage(overviewOf({ readiness: readiness({ build: 'passed', tests: 'failed', security: 'error' }) }));
    expect(gateCard('build').dataset.state).toBe('passed');
    expect(within(gateCard('build')).getByText('Passed').className).toContain('text-st-completed');
    expect(within(gateCard('tests')).getByText('Failed').className).toContain('text-st-failed');
    expect(within(gateCard('security')).getByText('Error').className).toContain('text-st-waiting');
    const idle = within(gateCard('coverage')).getByText('Not run');
    expect(idle.className).toContain('text-st-idle');
    expect(idle.className).not.toContain('text-st-completed');
    expect(document.querySelectorAll('[data-state="passed"]').length).toBe(1);
    expect(document.querySelectorAll('[data-state="not_run"]').length).toBe(3);
  });

  it('is ready only when every gate passed', async () => {
    const all = Object.fromEntries(IDS.map((id) => [id, 'passed'])) as Record<QualityGateId, GateState>;
    await openPage(overviewOf({ readiness: readiness(all) }));
    expect(screen.getByText('Ready for release')).toBeTruthy();
    expect(screen.queryByText(/Not ready for release/)).toBeNull();
  });

  it('explains why a run is not ready', async () => {
    const states = { build: 'passed', tests: 'passed', security: 'passed', review: 'passed', audit: 'passed' } as const;
    await openPage(overviewOf({ readiness: readiness(states, { blockingFindings: 2 }) }));
    const status = screen.getByText(/Not ready for release/).closest('p') as HTMLElement;
    expect(status.dataset.ready).toBe('false');
    expect(status.textContent).toContain('2 blocking findings');
    expect(status.textContent).toContain('Coverage not measured');
    expect(screen.queryByText('Ready for release')).toBeNull();
  });

  it('does not trust a ready flag while a gate is not passed', () => {
    const inconsistent = readiness({ build: 'passed' }, { ready: true });
    expect(isReady(inconsistent)).toBe(false);
    expect(readinessReasons(readiness({ coverage: 'not_run', tests: 'failed', audit: 'error' }, { blockingFindings: 1 }))).toEqual([
      '1 blocking finding', 'Build not run', 'Tests failed', 'Security review not run', 'Code review not run', 'Dependency audit errored', 'Coverage not measured',
    ]);
  });

  it('says so when there is no run yet', async () => {
    await openPage(overviewOf({ readiness: null }));
    expect(screen.getByText(/No run yet/)).toBeTruthy();
    expect(document.querySelector('[data-state="passed"]')).toBeNull();
  });
});

describe('test runs', () => {
  it('lists runs and expands the output tail', async () => {
    const testRuns = [{
      taskId: 't1', taskKey: 'api-tests', title: 'API tests', runId: 'run-1', finishedAt: '2026-10-16T10:05:00Z',
      result: { command: 'npm test', exitCode: 1, passed: false, durationMs: 4000, outputTail: 'FAIL src/a.test.ts', summary: '1 failed' },
    }];
    await openPage(overviewOf({ testRuns }));
    const region = within(screen.getByRole('region', { name: 'Test runs' }));
    expect(region.getByText('npm test')).toBeTruthy();
    expect(region.getByText(/exit 1/)).toBeTruthy();
    expect(region.getByText('4s')).toBeTruthy();
    expect(region.queryByText('FAIL src/a.test.ts')).toBeNull();
    fireEvent.click(region.getByRole('button', { name: 'Output' }));
    expect(region.getByText('FAIL src/a.test.ts').tagName).toBe('PRE');
  });

  it('shows an empty state', async () => {
    await openPage();
    expect(screen.getByText('No test run recorded for this run yet.')).toBeTruthy();
  });
});

describe('findings filters', () => {
  it('shows counters and filters by severity when a chip is clicked', async () => {
    await openPage();
    const group = within(screen.getByRole('group', { name: 'Severity' }));
    expect(group.getByRole('button', { name: 'Critical 1' })).toBeTruthy();
    expect(group.getByRole('button', { name: 'Low 0' })).toBeTruthy();
    expect(group.queryByRole('button', { name: /Info/ })).toBeNull();
    expect(lastQuery()).toEqual({ projectId: 'project-1', runId: 'run-1', limit: 200 });

    fireEvent.click(group.getByRole('button', { name: 'High 1' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ severity: 'high' }));
    expect(group.getByRole('button', { name: 'High 1' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(group.getByRole('button', { name: 'High 1' }));
    await waitFor(() => expect(lastQuery()).not.toHaveProperty('severity'));
  });

  it('sends source, status and debounced search filters', async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'audit' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ source: 'audit' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'open' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ source: 'audit', status: 'open' }));
    const calls = mocked.listFindings.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Search findings'), { target: { value: ' csrf ' } });
    expect(mocked.listFindings.mock.calls.length).toBe(calls);
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'csrf' }));
  });

  it('follows the run selector and builds queries with only the set filters', async () => {
    await openPage();
    await screen.findByRole('option', { name: 'Run #2' });
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'run-2' } });
    await waitFor(() => expect(mocked.getQuality).toHaveBeenLastCalledWith('project-1', 'run-2'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ runId: 'run-2' }));
    expect(buildFindingQuery('p', '', { severity: '', source: '', status: '' }, ' ')).toEqual({ projectId: 'p', limit: 200 });
  });

  it('renders title, severity, file:line, source and status', async () => {
    await openPage();
    const row = document.querySelector('tr[data-finding="f1"]') as HTMLElement;
    expect(row.textContent).toContain('SQL injection');
    expect(row.textContent).toContain('Critical');
    expect(row.textContent).toContain('src/auth.ts:12');
    expect(row.textContent).toContain('Security review');
    expect(row.textContent).toContain('Open');
    expect((document.querySelector('tr[data-finding="f2"]') as HTMLElement).textContent).toContain('—');
  });
});

describe('finding drawer', () => {
  it('shows the details and the source task link', async () => {
    await openPage();
    const drawer = await openDrawer('f1');
    expect(drawer.getByText('Description f1')).toBeTruthy();
    expect(drawer.getByText('Fix f1')).toBeTruthy();
    expect(drawer.getByText('src/auth.ts:12')).toBeTruthy();
    expect(drawer.getByRole('link', { name: /From task task-sec/ }).getAttribute('href')).toBe('#/tasks');
  });

  it('creates a fix task only after the confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await openPage();
    const drawer = await openDrawer('f1');
    fireEvent.click(drawer.getByRole('button', { name: 'Create fix task' }));
    expect(mocked.createFixTask).not.toHaveBeenCalled();
    fireEvent.click(drawer.getByRole('button', { name: 'Create fix task' }));
    await waitFor(() => expect(mocked.createFixTask).toHaveBeenCalledWith('f1'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await drawer.findByText(/Fix task fix-finding-1 created/)).toBeTruthy();
    expect((drawer.getByRole('button', { name: 'Create fix task' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Create fix task with the reason unless the finding is open', async () => {
    await openPage();
    const drawer = await openDrawer('f3');
    const button = drawer.getByRole('button', { name: 'Create fix task' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('Only open findings');
    expect(drawer.getByText(/Create fix task: Only open findings can get a fix task \(this one is accepted\)/)).toBeTruthy();
    expect((drawer.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('accepts a finding with a note', async () => {
    await openPage();
    const drawer = await openDrawer('f1');
    expect((drawer.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(drawer.getByLabelText(/Note/), { target: { value: ' internal tool ' } });
    fireEvent.click(drawer.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mocked.updateFinding).toHaveBeenCalledWith('f1', { status: 'accepted', note: 'internal tool' }));
    await waitFor(() => expect(mocked.listFindings.mock.calls.length).toBeGreaterThan(1));
  });

  it('marks a false positive and reopens an accepted finding', async () => {
    await openPage();
    let drawer = await openDrawer('f1');
    fireEvent.click(drawer.getByRole('button', { name: 'False positive' }));
    await waitFor(() => expect(mocked.updateFinding).toHaveBeenCalledWith('f1', { status: 'false_positive', note: null }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    drawer = await openDrawer('f3');
    fireEvent.click(drawer.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(mocked.updateFinding).toHaveBeenCalledWith('f3', { status: 'open', note: 'known' }));
  });

  it('shows the error when an action fails', async () => {
    await openPage();
    mocked.updateFinding.mockRejectedValue(new Error('finding is locked'));
    const drawer = await openDrawer('f1');
    fireEvent.click(drawer.getByRole('button', { name: 'Accept' }));
    expect(await drawer.findByText('finding is locked')).toBeTruthy();
  });

  it('explains every blocked action', () => {
    const base = finding('x');
    expect(actionBlocker(base, 'fix', false)).toBeNull();
    expect(actionBlocker(base, 'fix', true)).toContain('already planned');
    expect(actionBlocker({ ...base, status: 'fix_planned' }, 'accepted', false)).toContain('fix planned');
    expect(actionBlocker({ ...base, status: 'accepted' }, 'accepted', false)).toBe('Already marked as accepted.');
    expect(actionBlocker({ ...base, status: 'accepted' }, 'false_positive', false)).toBeNull();
    expect(actionBlocker(base, 'open', false)).toContain('Only accepted or false-positive');
  });
});

describe('dependency audit', () => {
  it('lists scanners including the Guardian contract row', async () => {
    await openPage();
    const scanners = within(screen.getByRole('region', { name: 'Scanners' }));
    expect(scanners.getByText('Not installed — integration contract ready')).toBeTruthy();
    expect(scanners.queryByText('internal note')).toBeNull();
    expect(within(document.querySelector('[data-scanner="npm-audit"]') as HTMLElement).getByText('10.9.0')).toBeTruthy();
    expect(within(document.querySelector('[data-scanner="tests"]') as HTMLElement).getByText('never run')).toBeTruthy();
    expect(within(document.querySelector('[data-scanner="tests"]') as HTMLElement).getByText('—')).toBeTruthy();
  });

  it('asks for confirmation, requests the approval and then waits', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await openPage();
    const button = screen.getByRole('button', { name: 'Run dependency audit' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(mocked.requestAudit).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mocked.requestAudit).toHaveBeenCalledWith('project-1'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Waiting for your approval in Approvals')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run dependency audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled while an audit approval is pending', async () => {
    await openPage(overviewOf({ pendingAuditApprovalId: 'ap-9' }));
    expect(screen.getByText('Waiting for your approval in Approvals')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run dependency audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled with the scanner note when npm audit is unavailable', async () => {
    const scanners = SCANNERS.map((s) => (s.id === 'npm-audit' ? { ...s, available: false, version: null, note: 'npm was not found on PATH' } : s));
    await openPage(overviewOf({ scanners }));
    const button = screen.getByRole('button', { name: 'Run dependency audit' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('npm was not found on PATH');
    expect(screen.getAllByText('npm was not found on PATH').length).toBeGreaterThan(0);
  });

  it('reports why when the request fails and computes blockers', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openPage();
    mocked.requestAudit.mockRejectedValue(new Error('no integration worktree'));
    fireEvent.click(screen.getByRole('button', { name: 'Run dependency audit' }));
    expect(await screen.findByText('no integration worktree')).toBeTruthy();
    expect(auditBlocker(overviewOf({ scanners: [] }), false)).toContain('not reported');
    expect(auditBlocker(overviewOf(), false)).toBeNull();
  });
});

describe('page states', () => {
  it('asks for a project when none is selected', () => {
    useStudio.setState({ currentProjectId: null });
    render(<Quality />);
    expect(screen.getByText('No project selected')).toBeTruthy();
    expect(mocked.getQuality).not.toHaveBeenCalled();
  });

  it('shows the empty findings state and the filtered empty state', async () => {
    await openPage(undefined, []);
    expect(screen.getByText('No findings for this run')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'fixed' } });
    expect(await screen.findByText('No findings match these filters')).toBeTruthy();
  });

  it('shows an error with Retry when the quality status cannot be loaded', async () => {
    setup();
    mocked.getQuality.mockRejectedValueOnce(new Error('quality down'));
    render(<Quality />);
    expect(await screen.findByText('quality down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Release readiness' })).toBeTruthy();
  });

  it('shows an error with Retry when findings cannot be loaded', async () => {
    setup();
    mocked.listFindings.mockRejectedValueOnce(new Error('findings down'));
    render(<Quality />);
    expect(await screen.findByText('findings down')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Findings' })).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('SQL injection')).toBeTruthy();
  });

  it('re-fetches on quality events of its project only', async () => {
    await openPage();
    const before = mocked.getQuality.mock.calls.length;
    act(() => { useStudio.setState({ events: [eventFixture({ type: 'findings.updated', projectId: 'project-2' })] }); });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocked.getQuality.mock.calls.length).toBe(before);
    act(() => { useStudio.setState({ events: [...useStudio.getState().events, eventFixture({ type: 'findings.updated', projectId: 'project-1' })] }); });
    await waitFor(() => expect(mocked.getQuality.mock.calls.length).toBe(before + 1));
    expect(mocked.listFindings.mock.calls.length).toBeGreaterThan(1);
  });
});
