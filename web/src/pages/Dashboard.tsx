import { useState } from 'react';
import { FolderPlus, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { AgentCard } from '@/components/AgentCard';
import { WorkflowGraph } from '@/components/WorkflowGraph';
import { Button, EmptyState, Panel, PanelHeader } from '@/components/ui/primitives';

const GRAPH_MODES = [{ id: 'tasks', label: 'Tasks' }, { id: 'agents', label: 'Agents' }] as const;

export function Dashboard() {
  const { snapshot, providers, selectedRole, selectedTaskId, selectAgent, selectTask, setView, startPlanning } = useStudio();
  const [graphMode, setGraphMode] = useState<'tasks' | 'agents'>('tasks');
  const [graphOpen, setGraphOpen] = useState(true);

  if (!snapshot) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState icon={<FolderPlus size={28} />} title="Start with a project">
          <p>Create a project from a specification, import a repository or try the bundled sample.</p>
          <Button variant="primary" className="mt-4" onClick={() => setView('projects')}>Create project</Button>
        </EmptyState>
      </div>
    );
  }

  const { project, tasks, agents } = snapshot;
  const counts = {
    completed: tasks.filter((t) => t.status === 'completed').length,
    running: tasks.filter((t) => t.status === 'running').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{project.name}</h1>
          <p className="truncate text-[12px] text-muted">
            {project.integrationBranch ? <>Work lands on <code className="text-text">{project.integrationBranch}</code></> : 'No integration branch yet'}
            {' '}— tests run with <code className="text-text">{project.testCommand}</code>
          </p>
        </div>
        <div className="flex gap-4 text-[12px] text-muted">
          <span><b className="text-st-completed tabular-nums">{counts.completed}</b> completed</span>
          <span><b className="text-st-running tabular-nums">{counts.running}</b> running</span>
          <span><b className="text-st-failed tabular-nums">{counts.failed}</b> failed</span>
          <span><b className="text-st-blocked tabular-nums">{counts.blocked}</b> blocked</span>
        </div>
      </div>

      {project.status === 'draft' && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 border-brand/30 px-4 py-3">
          <p className="text-[13px] text-muted">The specification is saved. The Project Manager will split it into tasks and the Architect will write the plan for your approval.</p>
          <Button variant="primary" onClick={() => void startPlanning()}><Sparkles size={15} /> Generate plan</Button>
        </Panel>
      )}

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3 overflow-y-auto pr-1">
        {agents.map((agent) => (
          <AgentCard key={agent.role} agent={agent} provider={providers.find((p) => p.id === agent.providerId)} selected={agent.role === selectedRole}
            lastTask={tasks.filter((t) => t.role === agent.role && t.providerId).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]}
            providers={providers}
            onSelect={() => { selectAgent(agent.role); selectTask(null); }}
            onChat={() => { selectAgent(agent.role); selectTask(null); }} />
        ))}
      </div>

      <Panel className={cn('flex shrink-0 flex-col overflow-hidden transition-[height] duration-200', graphOpen ? 'h-[clamp(260px,38vh,420px)]' : 'h-[45px]')}>
        <PanelHeader title="Workflow">
          <div className="flex rounded-md border border-line p-0.5" role="tablist">
            {GRAPH_MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={graphMode === m.id} onClick={() => setGraphMode(m.id)}
                className={cn('rounded px-2 py-0.5 text-[12px]', graphMode === m.id ? 'bg-ink-700 text-text' : 'text-muted hover:text-text')}>{m.label}</button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setGraphOpen((v) => !v)}>{graphOpen ? 'Collapse' : 'Expand'}</Button>
        </PanelHeader>
        {graphOpen && (
          <div className="min-h-0 flex-1">
            {tasks.length ? (
              <WorkflowGraph tasks={tasks} agents={agents} mode={graphMode} selectedTaskId={selectedTaskId} selectedRole={selectedRole}
                onSelectTask={(id) => { selectTask(id); selectAgent(tasks.find((t) => t.id === id)?.role ?? null); }}
                onSelectRole={(role) => { selectAgent(role); selectTask(null); }} />
            ) : <EmptyState title="No tasks yet">Generate the plan to see the task graph.</EmptyState>}
          </div>
        )}
      </Panel>
    </div>
  );
}
