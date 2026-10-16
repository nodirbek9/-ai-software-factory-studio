import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RepoBranch, RepoBranchKind, RepoOverview, RepoOwner } from '@asf/shared';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { Button, EmptyState, ErrorState, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { cn, timeAgo } from '@/lib/utils';
import { getRepo } from './projectsApi';
import { useLoad } from './ProjectTabs';

const COPIED_MS = 1500;
const BRANCH_KIND_LABELS: Record<RepoBranchKind, string> = {
  integration: 'Integration', task: 'Task', session: 'Session', partial: 'Partial', other: 'Other',
};
const BRANCH_KIND_TONES: Record<RepoBranchKind, string> = {
  integration: 'border-brand/50 text-brand-2', task: 'border-line text-muted', session: 'border-line text-muted',
  partial: 'border-st-waiting/50 text-st-waiting', other: 'border-line text-faint',
};

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  };
  const unavailable = typeof navigator === 'undefined' || !navigator.clipboard;
  return (
    <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label={`Copy ${label}`} disabled={unavailable}
      title={unavailable ? 'Clipboard is not available in this browser context' : state === 'failed' ? 'Could not copy' : state === 'copied' ? 'Copied' : `Copy ${label}`}
      onClick={() => void copy()}>
      {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </Button>
  );
}

function Value({ label, text, copy, title }: { label: string; text: string | null; copy?: string | null; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={title ?? text ?? undefined}>{text ?? '—'}</span>
        {copy && <CopyButton text={copy} label={label.toLowerCase()} />}
      </dd>
    </div>
  );
}

function Summary({ repo }: { repo: RepoOverview }) {
  return (
    <Panel>
      <PanelHeader title="Summary" />
      <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
        <Value label="Workspace path" text={repo.workspacePath} copy={repo.workspacePath} />
        <Value label="Integration path" text={repo.integrationPath} copy={repo.integrationPath} />
        <Value label="Integration branch" text={repo.integrationBranch} copy={repo.integrationBranch} />
        <Value label="Integration HEAD" text={shortSha(repo.integrationHead)} copy={repo.integrationHead} title={repo.integrationHead ?? undefined} />
        <Value label="Base commit" text={shortSha(repo.baseCommit)} copy={repo.baseCommit} title={repo.baseCommit ?? undefined} />
      </dl>
    </Panel>
  );
}

function Owner({ owner }: { owner: RepoOwner | null }) {
  if (!owner) return <span className="text-faint">—</span>;
  const href = owner.type === 'task' ? '#/tasks' : '#/workspace';
  return (
    <a href={href} className="text-brand-2 hover:underline" title={`${owner.type} · ${owner.status}`}>
      {owner.title}<span className="text-faint"> · {owner.status}</span>
    </a>
  );
}

function TableSection({ title, count, empty, head, children }: { title: string; count: number; empty: string; head: string[]; children: ReactNode }) {
  return (
    <Panel>
      <PanelHeader title={`${title} (${count})`} />
      {count === 0 ? <p className="px-4 py-5 text-[13px] text-muted">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]" aria-label={title}>
            <thead className="text-[11px] uppercase tracking-wide text-faint">
              <tr>{head.map((heading) => <th key={heading} className="px-3 py-1.5 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const cell = 'border-t border-line-soft px-3 py-1.5';

function AheadBehind({ branch }: { branch: RepoBranch }) {
  if (branch.ahead === null || branch.behind === null) return <span className="text-faint">—</span>;
  return <span title={`${branch.ahead} ahead, ${branch.behind} behind the integration branch`}>↑{branch.ahead} ↓{branch.behind}</span>;
}

function Branches({ branches }: { branches: RepoBranch[] }) {
  return (
    <TableSection title="Branches" count={branches.length} empty="No studio branches found."
      head={['Branch', 'Kind', 'Ahead / behind', 'Last commit', 'Owner']}>
      {branches.map((branch) => (
        <tr key={branch.name}>
          <td className={cn(cell, 'max-w-[280px] truncate font-mono')} title={branch.name}>{branch.name}</td>
          <td className={cell}>
            <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', BRANCH_KIND_TONES[branch.kind])}>{BRANCH_KIND_LABELS[branch.kind]}</span>
          </td>
          <td className={cell}><AheadBehind branch={branch} /></td>
          <td className={cn(cell, 'max-w-[320px] truncate')} title={branch.lastCommitSubject ?? undefined}>
            {branch.lastCommitSubject ?? '—'}
            {branch.lastCommitAt && <span className="text-faint" title={branch.lastCommitAt}> · {timeAgo(branch.lastCommitAt)}</span>}
          </td>
          <td className={cell}><Owner owner={branch.owner} /></td>
        </tr>
      ))}
    </TableSection>
  );
}

function Worktrees({ repo }: { repo: RepoOverview }) {
  return (
    <TableSection title="Worktrees" count={repo.worktrees.length} empty="No worktrees." head={['Path', 'Branch', 'Owner', 'Modified']}>
      {repo.worktrees.map((tree) => (
        <tr key={tree.path}>
          <td className={cell}>
            <span className="flex items-center gap-1"><span className="max-w-[360px] truncate font-mono" title={tree.path}>{tree.path}</span><CopyButton text={tree.path} label="worktree path" /></span>
          </td>
          <td className={cn(cell, 'font-mono')}>{tree.branch ?? <span className="text-faint">detached {shortSha(tree.head)}</span>}</td>
          <td className={cell}><Owner owner={tree.owner} /></td>
          <td className={cn(cell, 'whitespace-nowrap text-muted')} title={tree.modifiedAt ?? undefined}>{tree.modifiedAt ? timeAgo(tree.modifiedAt) : '—'}</td>
        </tr>
      ))}
    </TableSection>
  );
}

function RepoTables({ repo }: { repo: RepoOverview }) {
  return (
    <div className="space-y-4">
      <Branches branches={repo.branches} />
      <Worktrees repo={repo} />
      <TableSection title="Wip commits" count={repo.wipCommits.length} empty="No leftover wip commits." head={['Branch', 'Commit', 'Subject', 'When']}>
        {repo.wipCommits.map((commit) => (
          <tr key={`${commit.branch}-${commit.sha}`}>
            <td className={cn(cell, 'max-w-[240px] truncate font-mono')} title={commit.branch}>{commit.branch}</td>
            <td className={cn(cell, 'font-mono')} title={commit.sha}>{shortSha(commit.sha)}</td>
            <td className={cn(cell, 'max-w-[360px] truncate')} title={commit.subject}>{commit.subject}</td>
            <td className={cn(cell, 'whitespace-nowrap text-muted')} title={commit.at}>{timeAgo(commit.at)}</td>
          </tr>
        ))}
      </TableSection>
      <TableSection title="Conflicts seen" count={repo.conflicts.length} empty="No merge conflicts recorded." head={['When', 'Message', 'Task']}>
        {repo.conflicts.map((conflict, index) => (
          <tr key={`${conflict.at}-${index}`}>
            <td className={cn(cell, 'whitespace-nowrap text-muted')} title={conflict.at}>{timeAgo(conflict.at)}</td>
            <td className={cn(cell, 'max-w-[480px] break-words')}>{conflict.message}</td>
            <td className={cn(cell, 'font-mono text-faint')}>{conflict.taskId ?? '—'}</td>
          </tr>
        ))}
      </TableSection>
    </div>
  );
}

const hasContent = (repo: RepoOverview): boolean => repo.branches.length + repo.worktrees.length + repo.wipCommits.length + repo.conflicts.length > 0;

/** Read-only git overview of one project (`GET /api/v2/projects/:id/repo`). There is no delete/push/checkout action here. */
export function RepoView({ projectId }: { projectId: string }) {
  const load = useCallback(() => getRepo(projectId), [projectId]);
  const { data, error, loading, reload } = useLoad(load);

  if (error && !data) return <ErrorState title="Could not load the repository" message={error} onRetry={reload} />;
  if (!data) {
    return <div className="space-y-3" aria-busy="true" aria-label="Loading repository"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {error && <span role="alert" className="mr-auto text-[12px] text-st-failed">{error}</span>}
        <Button size="sm" disabled={loading} onClick={reload}><RefreshCw size={13} aria-hidden="true" className={cn(loading && 'animate-spin')} />Refresh</Button>
      </div>
      {data.error && (
        <Panel><div role="alert" className="p-4 text-[13px]"><p className="font-medium text-st-failed">Git could not be read</p><p className="mt-1 text-muted">{data.error}</p></div></Panel>
      )}
      <Summary repo={data} />
      {data.error && !hasContent(data) ? <Panel><EmptyState title="Nothing to show">Branches and worktrees are unavailable until git can be read.</EmptyState></Panel> : <RepoTables repo={data} />}
    </div>
  );
}
