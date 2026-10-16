import { useMemo } from 'react';
import { AGENT_ROLE_INFO, type AgentRole, type TaskRow, type TaskStatus } from '@asf/shared';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { Progress, StatusBadge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/** Kanban columns in spec order; Cancelled is appended only when the "Show cancelled" toggle is on. */
export const BOARD_STATUSES: TaskStatus[] = ['pending', 'ready', 'running', 'waiting_approval', 'blocked', 'failed', 'completed'];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending', ready: 'Ready', running: 'Running', waiting_approval: 'Waiting approval',
  blocked: 'Blocked', failed: 'Failed', completed: 'Completed', cancelled: 'Cancelled',
};

export function groupByStatus(tasks: TaskRow[]): Record<TaskStatus, TaskRow[]> {
  const groups = Object.fromEntries((Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => [status, [] as TaskRow[]])) as Record<TaskStatus, TaskRow[]>;
  for (const task of tasks) groups[task.status]?.push(task);
  return groups;
}

export interface ProjectProgress {
  projectId: string;
  projectName: string;
  completed: number;
  total: number;
}

/** Progress comes from task states only: completed tasks over the tasks in view. */
export function progressByProject(tasks: TaskRow[]): ProjectProgress[] {
  const byProject = new Map<string, ProjectProgress>();
  for (const task of tasks) {
    const entry = byProject.get(task.projectId) ?? { projectId: task.projectId, projectName: task.projectName, completed: 0, total: 0 };
    entry.total += 1;
    if (task.status === 'completed') entry.completed += 1;
    byProject.set(task.projectId, entry);
  }
  return [...byProject.values()];
}

export function RoleChip({ role }: { role: AgentRole }) {
  const Icon = ROLE_ICON[role];
  const hue = ROLE_HUE[role];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium" style={{
      color: hue, borderColor: `color-mix(in srgb, ${hue} 35%, transparent)`, background: `color-mix(in srgb, ${hue} 12%, transparent)`,
    }}>
      {Icon && <Icon size={11} aria-hidden="true" />}{AGENT_ROLE_INFO[role]?.name ?? role}
    </span>
  );
}

export function ProviderChip({ providerId, model }: { providerId: string | null; model?: string | null }) {
  if (!providerId) return null;
  return (
    <span className="inline-flex max-w-full items-center truncate rounded border border-line bg-ink-850 px-1.5 py-0.5 text-[11px] text-muted" title={model ? `${providerId} · ${model}` : providerId}>
      {providerId}
    </span>
  );
}

export function ProgressStrip({ tasks }: { tasks: TaskRow[] }) {
  const projects = useMemo(() => progressByProject(tasks), [tasks]);
  if (projects.length === 0) return null;
  return (
    <ul aria-label="Progress per project" className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line-soft px-4 py-2.5">
      {projects.map((project) => (
        <li key={project.projectId} className="w-52 space-y-1" title="Completed tasks over the tasks shown">
          <p className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="truncate font-medium">{project.projectName}</span>
            <span className="shrink-0 tabular-nums text-muted">{project.completed} / {project.total}</span>
          </p>
          <Progress value={project.total ? project.completed / project.total : 0} color="var(--color-st-completed)" />
        </li>
      ))}
    </ul>
  );
}

function TaskCard({ task, showProject, selected, onOpen }: { task: TaskRow; showProject: boolean; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button type="button" data-task={task.id} aria-current={selected ? 'true' : undefined} onClick={() => onOpen(task.id)}
      className={cn('block w-full space-y-1.5 rounded-lg border border-line-soft border-l-[3px] bg-surface p-2.5 text-left transition-colors hover:bg-ink-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
        selected && 'bg-brand/10')}
      style={{ borderLeftColor: ROLE_HUE[task.role] }}>
      <span className="line-clamp-2 block text-[13px] font-medium">{task.title}</span>
      <span className="flex items-center gap-1.5">
        <code className="truncate text-[11px] text-faint">{task.key}</code>
        {task.runNumber !== null && <span className="shrink-0 text-[11px] text-faint">run #{task.runNumber}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <RoleChip role={task.role} />
        <StatusBadge status={task.status} />
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <span className="tabular-nums">Attempt {task.attempt}/{task.maxAttempts}</span>
        <ProviderChip providerId={task.providerId} model={task.model} />
      </span>
      {showProject && <span className="block truncate text-[11px] text-faint">{task.projectName}</span>}
    </button>
  );
}

export interface TaskBoardProps {
  tasks: TaskRow[];
  showCancelled: boolean;
  /** Show the project name on each card (the "All projects" view). */
  showProject: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
}

export function TaskBoard({ tasks, showCancelled, showProject, selectedId, onOpen }: TaskBoardProps) {
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);
  const columns = showCancelled ? [...BOARD_STATUSES, 'cancelled' as const] : BOARD_STATUSES;
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {columns.map((status) => {
        const list = groups[status];
        return (
          <section key={status} aria-label={STATUS_LABEL[status]} data-column={status}
            className="flex min-h-0 w-64 shrink-0 flex-col rounded-xl border border-line-soft bg-ink-900/40">
            <h3 className="flex items-center justify-between border-b border-line-soft px-3 py-2 text-[12px] font-semibold text-muted">
              {STATUS_LABEL[status]}
              <span aria-label={`${list.length} tasks`} className="rounded-full bg-ink-800 px-1.5 text-[10.5px] tabular-nums">{list.length}</span>
            </h3>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {list.map((task) => (
                <li key={task.id}><TaskCard task={task} showProject={showProject} selected={task.id === selectedId} onOpen={onOpen} /></li>
              ))}
              {list.length === 0 && <li className="px-1 py-3 text-center text-[12px] text-faint">No tasks</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
