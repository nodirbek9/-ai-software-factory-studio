import { memo, useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AgentRole, AgentView, Task } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { cn, statusMeta } from '@/lib/utils';
import { ROLE_HUE, ROLE_ICON } from './agentMeta';

const COL_WIDTH = 206;
const ROW_HEIGHT = 74;

type TaskNodeData = { title: string; status: string; role: AgentRole; attempt: number; maxAttempts: number; selected: boolean };
type AgentNodeData = { role: AgentRole; status: string; done: number; total: number; selected: boolean };

const TaskNode = memo(({ data }: NodeProps<Node<TaskNodeData>>) => {
  const meta = statusMeta(data.status);
  const Icon = ROLE_ICON[data.role];
  return (
    <div className={cn('w-[180px] rounded-lg border bg-ink-850 px-2.5 py-2 text-left shadow-lg shadow-black/20', data.selected ? 'border-brand' : 'border-line')}
      style={{ boxShadow: meta.live ? `0 0 0 1px ${meta.color}, 0 0 18px -4px ${meta.color}` : undefined }}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line" />
      <div className="flex items-center gap-1.5">
        <Icon size={12} style={{ color: ROLE_HUE[data.role] }} />
        <span className="truncate text-[11px] text-muted">{AGENT_ROLE_INFO[data.role].name}</span>
        <span className={cn('ml-auto h-2 w-2 shrink-0 rounded-full', meta.bg, meta.live && 'animate-rail')} title={meta.label} />
      </div>
      <div className="mt-0.5 truncate text-[12px] font-medium text-text" title={data.title}>{data.title}</div>
      <div className={cn('text-[10.5px]', meta.text)}>{meta.label}{data.attempt > 1 ? ` (attempt ${data.attempt}/${data.maxAttempts})` : ''}</div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line" />
    </div>
  );
});
TaskNode.displayName = 'TaskNode';

const AgentNode = memo(({ data }: NodeProps<Node<AgentNodeData>>) => {
  const meta = statusMeta(data.status);
  const Icon = ROLE_ICON[data.role];
  return (
    <div className={cn('flex w-[180px] items-center gap-2 rounded-lg border bg-ink-850 px-2.5 py-2', data.selected ? 'border-brand' : 'border-line')}
      style={{ boxShadow: meta.live ? `0 0 0 1px ${meta.color}` : undefined }}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line" />
      <Icon size={16} style={{ color: ROLE_HUE[data.role] }} />
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium">{AGENT_ROLE_INFO[data.role].name}</div>
        <div className={cn('text-[10.5px]', meta.text)}>{meta.label} — {data.done}/{data.total}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line" />
    </div>
  );
});
AgentNode.displayName = 'AgentNode';

const nodeTypes = { task: TaskNode, agent: AgentNode };

/** Longest-path layering keeps every dependency pointing left-to-right. */
function layer<T>(items: T[], key: (t: T) => string, deps: (t: T) => string[]): Map<string, number> {
  const byKey = new Map(items.map((t) => [key(t), t]));
  const depth = new Map<string, number>();
  const visit = (k: string, guard: Set<string>): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (guard.has(k)) return 0;
    guard.add(k);
    const item = byKey.get(k);
    const d = item ? Math.max(-1, ...deps(item).filter((x) => byKey.has(x)).map((x) => visit(x, guard))) + 1 : 0;
    depth.set(k, d);
    return d;
  };
  items.forEach((t) => visit(key(t), new Set()));
  return depth;
}

function edgeStyle(sourceStatus: string, targetStatus: string): Pick<Edge, 'animated' | 'style' | 'markerEnd'> {
  const color = targetStatus === 'running' ? 'var(--color-st-running)'
    : sourceStatus === 'failed' || targetStatus === 'blocked' ? 'var(--color-st-failed)'
    : sourceStatus === 'completed' ? 'var(--color-st-completed)' : 'var(--color-line)';
  return { animated: targetStatus === 'running', style: { stroke: color, strokeWidth: 1.5, opacity: sourceStatus === 'completed' ? 0.7 : 1 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 } };
}

interface Props {
  tasks: Task[];
  agents: AgentView[];
  mode: 'tasks' | 'agents';
  selectedTaskId: string | null;
  selectedRole: AgentRole | null;
  onSelectTask: (id: string) => void;
  onSelectRole: (role: AgentRole) => void;
}

export function WorkflowGraph({ tasks, agents, mode, selectedTaskId, selectedRole, onSelectTask, onSelectRole }: Props) {
  const { nodes, edges } = useMemo(() => {
    if (mode === 'tasks') {
      const depth = layer(tasks, (t) => t.key, (t) => t.dependsOn);
      const rows = new Map<number, number>();
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      const nodes: Node[] = tasks.map((t) => {
        const d = depth.get(t.key) ?? 0;
        const row = rows.get(d) ?? 0;
        rows.set(d, row + 1);
        return { id: t.id, type: 'task', position: { x: d * COL_WIDTH, y: row * ROW_HEIGHT },
          data: { title: t.title, status: t.status, role: t.role, attempt: t.attempt, maxAttempts: t.maxAttempts, selected: t.id === selectedTaskId } };
      });
      const edges: Edge[] = tasks.flatMap((t) => t.dependsOn.filter((k) => byKey.has(k)).map((k) => {
        const source = byKey.get(k)!;
        return { id: `${source.id}-${t.id}`, source: source.id, target: t.id, ...edgeStyle(source.status, t.status) };
      }));
      return { nodes, edges };
    }
    // Agent dependency view: role A → role B when a task of B depends on a task of A.
    const roleOf = new Map(tasks.map((t) => [t.key, t.role]));
    const links = new Set<string>();
    for (const t of tasks) for (const k of t.dependsOn) {
      const from = roleOf.get(k);
      if (from && from !== t.role) links.add(`${from}>${t.role}`);
    }
    const roles = agents.filter((a) => a.tasksTotal > 0 || !tasks.length);
    const depsOf = (role: string) => [...links].filter((l) => l.endsWith(`>${role}`)).map((l) => l.split('>')[0]);
    const depth = layer(roles, (a) => a.role, (a) => depsOf(a.role).filter((r) => r !== a.role));
    const rows = new Map<number, number>();
    const nodes: Node[] = roles.map((a) => {
      const d = depth.get(a.role) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return { id: a.role, type: 'agent', position: { x: d * 220, y: row * 64 },
        data: { role: a.role, status: a.status, done: a.tasksCompleted, total: a.tasksTotal, selected: a.role === selectedRole } };
    });
    const status = new Map(agents.map((a) => [a.role, a.status]));
    const edges: Edge[] = [...links].map((l) => {
      const [from, to] = l.split('>');
      return { id: l, source: from, target: to, ...edgeStyle(status.get(from as AgentRole) ?? 'idle', status.get(to as AgentRole) ?? 'idle') };
    });
    return { nodes, edges };
  }, [tasks, agents, mode, selectedTaskId, selectedRole]);

  return (
    <ReactFlow key={`${mode}-${nodes.length}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.12, minZoom: 0.55, maxZoom: 1.1 }}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable minZoom={0.3} maxZoom={1.6} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => (mode === 'tasks' ? onSelectTask(node.id) : onSelectRole(node.id as AgentRole))}>
      <Background color="#1e2b49" gap={22} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
