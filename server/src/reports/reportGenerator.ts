import type { Project, Task } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { changedFiles, git } from '../workspace/git.ts';

const fmtDuration = (task: Task): string => {
  if (!task.startedAt || !task.finishedAt) return '—';
  const seconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

const cell = (text: string | null): string => (text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160);

/** Builds the delivery report purely from persisted, verified state (no model involved). */
export async function generateReport(ctx: StudioContext, project: Project): Promise<string> {
  const tasks = ctx.repos.tasks.listByProject(project.id);
  const approvals = ctx.repos.approvals.listByProject(project.id);
  const root = project.integrationPath!;
  const files = project.baseCommit ? await changedFiles(root, project.baseCommit) : [];
  const commits = project.baseCommit ? await git(root, ['log', '--oneline', `${project.baseCommit}..HEAD`]) : '';
  const usage = new Map<string, { input: number; output: number; cost: number; providers: Set<string> }>();
  for (const task of tasks) {
    const key = task.role;
    const entry = usage.get(key) ?? { input: 0, output: 0, cost: 0, providers: new Set<string>() };
    if (task.usage) {
      entry.input += task.usage.inputTokens;
      entry.output += task.usage.outputTokens;
      entry.cost += task.usage.costUsd ?? 0;
    }
    if (task.providerId) entry.providers.add(`${task.providerId}${task.model ? `/${task.model}` : ''}`);
    usage.set(key, entry);
  }
  const nonAi = tasks.some((t) => t.providerId === 'scripted');
  const tests = tasks.filter((t) => t.testResult);
  const reviews = tasks.filter((t) => t.kind === 'security' || t.kind === 'review');

  const lines: string[] = [
    `# Delivery report — ${project.name}`,
    '',
    `Generated: ${new Date().toISOString()}  `,
    `Integration branch: \`${project.integrationBranch}\` (base \`${project.baseCommit?.slice(0, 10)}\`)  `,
    `Workspace: \`${project.workspacePath}\``,
    '',
  ];
  if (nonAi) {
    lines.push('> **Note:** some tasks ran on the *Scripted (offline, not AI)* provider, which replays a fixed script.',
      '> Their code was produced by the script, not by a model. Git, merges and tests were real.', '');
  }
  lines.push('## Tasks', '', '| # | Task | Agent | Status | Attempts | Provider | Duration | Result |', '|---|---|---|---|---|---|---|---|');
  tasks.forEach((t, i) => lines.push(`| ${i + 1} | ${cell(t.title)} | ${AGENT_ROLE_INFO[t.role].name} | ${t.status} | ${t.attempt}/${t.maxAttempts} | ${t.providerId ?? '—'} | ${fmtDuration(t)} | ${cell(t.error ?? t.resultSummary)} |`));
  lines.push('', '## Tests', '');
  if (!tests.length) lines.push('No test run recorded.');
  for (const t of tests) {
    const r = t.testResult!;
    lines.push(`- \`${r.command}\` → **${r.passed ? 'PASSED' : 'FAILED'}** (${r.summary}, exit ${r.exitCode}, ${Math.round(r.durationMs / 100) / 10}s)`);
  }
  lines.push('', '## Reviews', '');
  for (const r of reviews) {
    lines.push(`### ${AGENT_ROLE_INFO[r.role].name} — ${r.status}`, '', (r.resultSummary ?? r.error ?? '—').slice(0, 6000), '');
  }
  lines.push('## Approvals', '');
  if (!approvals.length) lines.push('None.');
  for (const a of approvals) lines.push(`- ${a.title} — **${a.status}**${a.note ? ` (${a.note})` : ''}${a.decidedAt ? ` at ${a.decidedAt}` : ''}`);
  lines.push('', `## Files changed (${files.length})`, '', ...files.map((f) => `- \`${f}\``));
  lines.push('', '## Commits', '', '```', commits || '(none)', '```');
  lines.push('', '## Usage', '', '| Agent | Providers | Input tokens | Output tokens | Cost (USD) |', '|---|---|---|---|---|');
  for (const [role, u] of usage) {
    lines.push(`| ${AGENT_ROLE_INFO[role as Task['role']].name} | ${[...u.providers].join(', ') || '—'} | ${u.input} | ${u.output} | ${u.cost ? u.cost.toFixed(4) : '—'} |`);
  }
  lines.push('', '## Next steps', '', `Review the branch \`${project.integrationBranch}\` and merge it yourself. The studio never pushes or merges into your own branches.`, '');
  return lines.join('\n');
}
