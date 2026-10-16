import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { TaskRow } from '@asf/shared';
import { StatusBadge } from '@/components/ui/primitives';
import { formatMs } from '@/features/workflows/RunPanel';
import { cn } from '@/lib/utils';
import { BOARD_STATUSES, RoleChip } from './TaskBoard';

export type SortKey = 'key' | 'title' | 'role' | 'status' | 'attempts' | 'provider' | 'duration';
export type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'key', label: 'Key' }, { key: 'title', label: 'Title' }, { key: 'role', label: 'Role' }, { key: 'status', label: 'Status' },
  { key: 'attempts', label: 'Attempts' }, { key: 'provider', label: 'Provider / model' }, { key: 'duration', label: 'Duration' },
];

const STATUS_ORDER = [...BOARD_STATUSES, 'cancelled'];

export const providerLabel = (task: TaskRow): string => [task.providerId, task.model].filter(Boolean).join(' / ');

function sortValue(task: TaskRow, key: SortKey): string | number | null {
  switch (key) {
    case 'key': return task.key;
    case 'title': return task.title;
    case 'role': return task.role;
    case 'status': return STATUS_ORDER.indexOf(task.status);
    case 'attempts': return task.attempt;
    case 'provider': return providerLabel(task) || null;
    case 'duration': return task.durationMs;
  }
}

/** Empty values (no provider yet, never started) sort last in both directions. */
export function sortTasks(tasks: TaskRow[], key: SortKey, dir: SortDir): TaskRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return tasks.slice().sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return order * sign;
  });
}

function TaskRowView({ task, showProject, selected, onOpen }: { task: TaskRow; showProject: boolean; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <tr data-task={task.id} tabIndex={0} aria-current={selected ? 'true' : undefined} onClick={() => onOpen(task.id)}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(task.id); }}
      className={cn('cursor-pointer border-t border-line-soft hover:bg-ink-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand', selected && 'bg-brand/10')}>
      <td className="px-3 py-1.5"><code className="text-[11.5px] text-faint">{task.key}</code></td>
      <td className="max-w-[320px] px-2 py-1.5">
        <span className="block truncate font-medium" title={task.title}>{task.title}</span>
        {showProject && <span className="block truncate text-[11px] text-faint">{task.projectName}</span>}
      </td>
      <td className="px-2 py-1.5"><RoleChip role={task.role} /></td>
      <td className="px-2 py-1.5"><StatusBadge status={task.status} /></td>
      <td className="px-2 py-1.5 tabular-nums text-muted">{task.attempt}/{task.maxAttempts}</td>
      <td className="max-w-[220px] truncate px-2 py-1.5 text-muted" title={providerLabel(task) || undefined}>{providerLabel(task) || '—'}</td>
      <td className="px-2 py-1.5 tabular-nums text-muted">{formatMs(task.durationMs)}</td>
    </tr>
  );
}

export interface TaskListProps {
  tasks: TaskRow[];
  showProject: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
}

export function TaskList({ tasks, showProject, selectedId, onOpen }: TaskListProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const rows = useMemo(() => (sort ? sortTasks(tasks, sort.key, sort.dir) : tasks), [tasks, sort]);
  const toggle = (key: SortKey) => setSort((current) => (current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-left text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface text-[11px] uppercase tracking-wide text-faint">
          <tr>
            {COLUMNS.map((column, index) => {
              const dir = sort?.key === column.key ? sort.dir : null;
              return (
                <th key={column.key} scope="col" aria-sort={dir === null ? 'none' : dir === 'asc' ? 'ascending' : 'descending'}
                  className={cn('py-1.5 font-medium', index === 0 ? 'px-3' : 'px-2')}>
                  <button type="button" onClick={() => toggle(column.key)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-text">
                    {column.label}
                    {dir === 'asc' && <ArrowUp size={11} aria-hidden="true" />}
                    {dir === 'desc' && <ArrowDown size={11} aria-hidden="true" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => <TaskRowView key={task.id} task={task} showProject={showProject} selected={task.id === selectedId} onOpen={onOpen} />)}
        </tbody>
      </table>
    </div>
  );
}
