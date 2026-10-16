import { useState } from 'react';
import { AGENT_ROLE_INFO, type TaskStatus } from '@asf/shared';
import { FolderPlus } from 'lucide-react';
import { ROLE_HUE } from '@/components/agentMeta';
import { WorkflowGraph } from '@/components/WorkflowGraph';
import { Button, EmptyState, Panel, PanelHeader, StatusBadge } from '@/components/ui/primitives';
import { cn, formatDuration, statusMeta } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const GRAPH_MODES = [{ id: 'tasks', label: 'Tasks' }, { id: 'agents', label: 'Agents' }] as const;
const LEGEND_STATUSES = ['completed', 'running', 'ready', 'waiting_approval', 'blocked', 'failed', 'pending'] as const;
const TASK_STATUSES: readonly TaskStatus[] = [...LEGEND_STATUSES, 'cancelled'];
const CANCELLABLE_STATUSES: readonly TaskStatus[] = ['pending', 'ready', 'running', 'blocked', 'waiting_approval'];

export function Workflows() {
  const { snapshot, selectedTaskId, selectedRole, selectTask, selectAgent, retryTask, cancelTask, setView } = useStudio();
  const [graphMode, setGraphMode] = useState<'tasks' | 'agents'>('tasks');

  if (!snapshot) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState icon={<FolderPlus size={28} />} title="Select a project to view workflows">
          <p>Create or select a project to explore its task dependencies and progress.</p>
          <Button variant="primary" className="mt-4" onClick={() => setView('projects')}>View projects</Button>
        </EmptyState>
      </div>
    );
  }

  const { project, tasks, agents } = snapshot;
  const orderedTasks = [...tasks].sort((a, b) => a.orderIndex - b.orderIndex);
  const selectTaskAndAgent = (id: string) => {
    selectTask(id);
    selectAgent(tasks.find((task) => task.id === id)?.role ?? null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="shrink-0">
        <h1 className="text-lg font-semibold">Workflows</h1>
        <p className="text-[12px] text-muted">{project.name}</p>
      </div>

      <Panel className="flex h-[45%] min-h-[280px] shrink-0 flex-col overflow-hidden">
        <PanelHeader title="Workflow">
          <div className="flex rounded-md border border-line p-0.5" role="tablist" aria-label="Workflow mode">
            {GRAPH_MODES.map((mode) => (
              <button key={mode.id} type="button" role="tab" aria-selected={graphMode === mode.id}
                onClick={() => setGraphMode(mode.id)}
                className={cn('rounded px-2 py-0.5 text-[12px]', graphMode === mode.id ? 'bg-ink-700 text-text' : 'text-muted hover:text-text')}>
                {mode.label}
              </button>
            ))}
          </div>
        </PanelHeader>
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-line-soft px-4 py-2 text-[11px] text-muted" aria-label="Task status legend">
          {LEGEND_STATUSES.map((status) => {
            const meta = statusMeta(status);
            return (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', meta.bg)} />
                {meta.label}
              </span>
            );
          })}
        </div>
        <div className="min-h-0 flex-1">
          {tasks.length ? (
            <WorkflowGraph tasks={orderedTasks} agents={agents} mode={graphMode}
              selectedTaskId={selectedTaskId} selectedRole={selectedRole}
              onSelectTask={selectTaskAndAgent}
              onSelectRole={(role) => { selectAgent(role); selectTask(null); }} />
          ) : (
            <EmptyState title="No tasks yet">Generate a plan from the Dashboard to see the workflow.</EmptyState>
          )}
        </div>
      </Panel>

      <Panel className="shrink-0 overflow-hidden">
        <PanelHeader title="Tasks" />
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line-soft px-4 py-2 text-[12px] text-muted">
          <span className="tabular-nums">{tasks.length} total</span>
          {TASK_STATUSES.map((status) => (
            <span key={status}>
              <b className={cn('font-medium tabular-nums', statusMeta(status).text)}>{tasks.filter((task) => task.status === status).length}</b>
              {' '}{statusMeta(status).label.toLowerCase()}
            </span>
          ))}
        </div>
        {orderedTasks.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Tasks for {project.name}. Select a task to view its details.</caption>
              <thead className="border-b border-line-soft bg-ink-850 text-[11px] text-muted">
                <tr>
                  {['#', 'Key', 'Title', 'Agent', 'Kind', 'Status', 'Attempts', 'Provider / model', 'Duration', 'Depends on', 'Actions'].map((heading) => (
                    <th key={heading} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {orderedTasks.map((task) => (
                  <tr key={task.id} tabIndex={0} aria-label={`Select task ${task.key}: ${task.title}`}
                    onClick={() => selectTaskAndAgent(task.id)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        selectTaskAndAgent(task.id);
                      }
                    }}
                    className={cn('cursor-pointer transition-colors hover:bg-ink-800', selectedTaskId === task.id && 'bg-brand/10 ring-1 ring-inset ring-brand/40')}>
                    <td className="px-3 py-2.5 tabular-nums text-faint">{task.orderIndex}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono">{task.key}</td>
                    <td className="min-w-[220px] px-3 py-2.5 text-[13px] font-medium">{task.title}</td>
                    <td className="whitespace-nowrap px-3 py-2.5" style={{ color: ROLE_HUE[task.role] }}>{AGENT_ROLE_INFO[task.role].name}</td>
                    <td className="px-3 py-2.5 text-muted">{task.kind}</td>
                    <td className="whitespace-nowrap px-3 py-2.5"><StatusBadge status={task.status} /></td>
                    <td className="px-3 py-2.5 tabular-nums text-muted">{task.attempt}/{task.maxAttempts}</td>
                    <td className="px-3 py-2.5 text-muted">
                      <div>{task.providerId ?? '—'}</div>
                      <div className="text-[11px] text-faint">{task.model ?? '—'}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted">{formatDuration(task.startedAt, task.finishedAt)}</td>
                    <td className="min-w-[120px] px-3 py-2.5 font-mono text-[11px] text-muted">{task.dependsOn.join(', ') || '—'}</td>
                    <td className="px-3 py-2.5">
                      {(task.status === 'failed' || task.status === 'cancelled') && (
                        <Button size="sm" aria-label={`Retry ${task.key}`} onClick={(event) => { event.stopPropagation(); void retryTask(task.id); }}>Retry</Button>
                      )}
                      {CANCELLABLE_STATUSES.includes(task.status) && (
                        <Button size="sm" variant="danger" aria-label={`Cancel ${task.key}`} onClick={(event) => { event.stopPropagation(); void cancelTask(task.id); }}>Cancel</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tasks yet">Generate a plan from the Dashboard to populate the task table.</EmptyState>
        )}
      </Panel>
    </div>
  );
}
