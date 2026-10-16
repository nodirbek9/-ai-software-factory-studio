import { Fragment } from 'react';
import type { AgentRole, OverviewResponse, OverviewStage } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { ArrowRight, Ban, CheckCircle2, Circle, FolderGit2, Hourglass, LoaderCircle, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { Button, EmptyState, Panel, PanelHeader, StatusBadge } from '@/components/ui/primitives';
import { formatMs } from './format';

/** The pipeline shown on Home, in order (the PM only plans; it is not a stage). */
export const STAGE_ROLES: readonly AgentRole[] = ['architect', 'backend', 'frontend', 'qa', 'security', 'reviewer'];
const STAGE_LABEL: Partial<Record<AgentRole, string>> = { reviewer: 'Review' };

const STATUS_VIEW: Record<OverviewStage['status'], { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  none: { label: 'No tasks', icon: Circle, tone: 'text-faint' },
  pending: { label: 'Pending', icon: Circle, tone: 'text-st-idle' },
  running: { label: 'Running', icon: LoaderCircle, tone: 'text-st-running', spin: true },
  waiting: { label: 'Needs approval', icon: Hourglass, tone: 'text-st-waiting' },
  completed: { label: 'Done', icon: CheckCircle2, tone: 'text-st-completed' },
  failed: { label: 'Failed', icon: XCircle, tone: 'text-st-failed' },
  blocked: { label: 'Blocked', icon: Ban, tone: 'text-st-blocked' },
};

const EMPTY_STAGE = (role: AgentRole): OverviewStage => ({
  role, status: 'none', tasksTotal: 0, tasksCompleted: 0, currentTask: null, providerId: null, model: null, durationMs: 0, latestFiles: [], error: null,
});

function StageCard({ stage }: { stage: OverviewStage }) {
  const Icon = ROLE_ICON[stage.role];
  const hue = ROLE_HUE[stage.role];
  const view = STATUS_VIEW[stage.status];
  const StatusIcon = view.icon;
  const label = STAGE_LABEL[stage.role] ?? AGENT_ROLE_INFO[stage.role].name;
  const running = stage.status === 'running';
  return (
    <div role="group" aria-label={`${label} stage`}
      className={cn('flex h-full min-w-0 flex-1 flex-col gap-1.5 rounded-xl border bg-raised/60 p-3',
        running ? 'border-brand-violet shadow-glow' : 'border-line-soft', stage.status === 'none' && 'opacity-70')}>
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${hue} 16%, transparent)`, color: hue }}>
          <Icon size={17} />
        </div>
        <span className="truncate text-[13px] font-semibold">{label}</span>
      </div>
      <p className="line-clamp-2 min-h-[32px] text-[12px] leading-snug text-muted" title={stage.currentTask?.title}>
        {stage.currentTask?.title ?? 'No task for this stage'}
      </p>
      {(stage.providerId || stage.model) && (
        <p className="truncate font-mono text-[11px] text-faint" title={`${stage.providerId ?? ''} ${stage.model ?? ''}`}>
          {[stage.providerId, stage.model].filter(Boolean).join(' · ')}
        </p>
      )}
      {stage.error && <p className="line-clamp-2 text-[11px] text-st-failed" title={stage.error}>{stage.error}</p>}
      {!stage.error && stage.latestFiles.length > 0 && (
        <p className="truncate text-[11px] text-faint" title={stage.latestFiles.join('\n')}>{stage.latestFiles.length} file{stage.latestFiles.length === 1 ? '' : 's'} changed</p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[11.5px]">
        <span className={cn('inline-flex items-center gap-1 font-medium', view.tone)}>
          <StatusIcon size={14} className={cn(view.spin && 'animate-spin')} aria-hidden="true" />{view.label}
        </span>
        <span className="tabular-nums text-faint">{stage.tasksCompleted}/{stage.tasksTotal} · {formatMs(stage.durationMs)}</span>
      </div>
    </div>
  );
}

export function ProjectWorkflow({ current }: { current: OverviewResponse['currentProject'] }) {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Current Project Workflow">
        {current && (
          <>
            <span className="inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-md border border-line bg-ink-950/60 px-2 py-0.5 text-[12px]">
              <FolderGit2 size={12} className="shrink-0 text-muted" /><span className="truncate">{current.name}</span>
            </span>
            <StatusBadge status={current.status} />
            <button type="button" onClick={() => setView('dashboard')} className="rounded text-[12px] text-brand hover:underline">Open project board →</button>
          </>
        )}
      </PanelHeader>
      {current ? (
        <ol className="flex gap-1 overflow-x-auto p-4" aria-label="Pipeline stages">
          {STAGE_ROLES.map((role, index) => (
            <Fragment key={role}>
              <li className="flex min-w-[132px] flex-1">
                <StageCard stage={current.stages.find((s) => s.role === role) ?? EMPTY_STAGE(role)} />
              </li>
              {index < STAGE_ROLES.length - 1 && (
                <li aria-hidden="true" className="flex shrink-0 items-center text-brand"><ArrowRight size={16} /></li>
              )}
            </Fragment>
          ))}
        </ol>
      ) : (
        <EmptyState icon={<FolderGit2 size={26} />} title="No project selected">
          <p>Select or create a project to follow its pipeline here.</p>
          <Button variant="primary" className="mt-3" onClick={() => setView('projects')}>Open Projects</Button>
        </EmptyState>
      )}
    </Panel>
  );
}
