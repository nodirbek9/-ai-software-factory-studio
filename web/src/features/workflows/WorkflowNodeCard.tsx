import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  AGENT_ROLE_INFO,
  type NodeCatalogEntry,
  type NodeCategory,
  type RunNodeStatus,
  type WorkflowHandle,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@asf/shared';
import {
  Bell, Blocks, Code2, Eye, FileText, Gauge, GitBranch, LayoutTemplate, ListTree, Package, RotateCw, Rocket, Send,
  ShieldCheck, Terminal, TestTubes, Timer, TriangleAlert, UserCheck, Wrench, Zap, type LucideIcon,
} from 'lucide-react';
import { cn, statusMeta } from '@/lib/utils';
import { ROLE_HUE } from '@/components/agentMeta';

export const NODE_ICON: Record<WorkflowNodeType, LucideIcon> = {
  trigger: Zap,
  requirement: FileText,
  architect: Blocks,
  decompose: ListTree,
  backend: Code2,
  frontend: LayoutTemplate,
  qa: TestTubes,
  security: ShieldCheck,
  reviewer: Eye,
  approval: UserCheck,
  'quality-gate': Gauge,
  fix: Wrench,
  retry: RotateCw,
  tool: Terminal,
  artifact: Package,
  notify: Bell,
  delay: Timer,
  deploy: Rocket,
  condition: GitBranch,
  'notify-external': Send,
};

const CATEGORY_HUE: Record<NodeCategory, string> = {
  trigger: '#f5b04a',
  input: '#7c9cff',
  agent: '#5fb3ff',
  control: '#a78bfa',
  tool: '#3fd0d4',
  output: '#34d399',
};

/** Accent colour of a node: the role hue for agent nodes, the category hue otherwise. */
export function nodeHue(entry: NodeCatalogEntry | undefined): string {
  if (!entry) return CATEGORY_HUE.control;
  return entry.role ? ROLE_HUE[entry.role] : CATEGORY_HUE[entry.category];
}

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  entry?: NodeCatalogEntry;
  status?: RunNodeStatus;
  /** Issues of this node only. */
  issues: WorkflowIssue[];
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;

const HANDLE_COLOR: Record<WorkflowHandle, string> = {
  out: 'var(--color-brand)',
  pass: 'var(--color-st-completed)',
  fail: 'var(--color-st-failed)',
};

const HANDLE_LABEL: Record<WorkflowHandle, string> = { out: '', pass: 'pass', fail: 'fail' };

/** Statuses that get a ring around the card; idle/pending nodes stay plain. */
const RING_STATUSES = new Set(['running', 'completed', 'failed', 'waiting_approval', 'blocked']);

const handleTop = (index: number, count: number): string => `${((index + 1) / (count + 1)) * 100}%`;

function IssueBadge({ issues }: { issues: WorkflowIssue[] }) {
  if (issues.length === 0) return null;
  const hasError = issues.some((issue) => issue.severity === 'error');
  return (
    <span
      className={cn('ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-semibold', hasError ? 'bg-st-failed/20 text-st-failed' : 'bg-st-waiting/20 text-st-waiting')}
      title={issues.map((issue) => issue.message).join('\n')}
      aria-label={`${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`}
    >
      <TriangleAlert size={10} aria-hidden />
      {issues.length}
    </span>
  );
}

function OutputHandles({ outputs }: { outputs: WorkflowHandle[] }) {
  return (
    <>
      {outputs.map((handle, index) => {
        const top = handleTop(index, outputs.length);
        return (
          <span key={handle}>
            <Handle
              type="source"
              id={handle}
              position={Position.Right}
              style={{ top, background: HANDLE_COLOR[handle] }}
              className="!h-2.5 !w-2.5 !border-2 !border-ink-950"
              title={HANDLE_LABEL[handle] || 'output'}
            />
            {HANDLE_LABEL[handle] && (
              <span className="pointer-events-none absolute right-3 -translate-y-1/2 text-[9.5px] font-medium" style={{ top, color: HANDLE_COLOR[handle] }}>
                {HANDLE_LABEL[handle]}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

function WorkflowNodeCardImpl({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { node, entry, status, issues } = data;
  const Icon = NODE_ICON[node.type] ?? Zap;
  const hue = nodeHue(entry);
  const planned = entry !== undefined && !entry.executable;
  const title = node.label?.trim() || entry?.label || node.type;
  const meta = status && RING_STATUSES.has(status.status) ? statusMeta(status.status) : null;
  const outputs = entry?.handles.outputs ?? ['out'];
  const hasInput = entry ? entry.handles.input : true;
  return (
    <div
      className={cn('relative w-[200px] rounded-lg border bg-ink-850 px-2.5 py-2 text-left shadow-lg shadow-black/20', selected ? 'border-brand' : 'border-line', planned && 'opacity-60')}
      title={planned ? (entry?.plannedReason ?? 'Planned node — not executable yet') : undefined}
      data-node-id={node.id}
      data-status={status?.status ?? 'none'}
    >
      {meta && (
        <span
          aria-hidden
          className={cn('pointer-events-none absolute -inset-[3px] rounded-[11px] border-2', status?.status === 'running' && 'animate-pulse')}
          style={{ borderColor: meta.color }}
        />
      )}
      {hasInput && <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-ink-950 !bg-line" />}
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${hue} 18%, transparent)`, color: hue }}>
          <Icon size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-text">{title}</div>
          <div className="truncate text-[10.5px] text-faint">{node.label && entry ? entry.label : node.id}</div>
        </div>
        <IssueBadge issues={issues} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {entry?.role && (
          <span className="rounded-full border px-1.5 py-px text-[10px]" style={{ borderColor: `color-mix(in srgb, ${ROLE_HUE[entry.role]} 40%, transparent)`, color: ROLE_HUE[entry.role] }}>
            {AGENT_ROLE_INFO[entry.role].name}
          </span>
        )}
        {planned && <span className="rounded-full border border-line px-1.5 py-px text-[10px] text-muted">Planned</span>}
        {status && status.status !== 'not_started' && (
          <span className={cn('text-[10.5px]', statusMeta(status.status).text)}>{statusMeta(status.status).label}</span>
        )}
      </div>
      <OutputHandles outputs={outputs} />
    </div>
  );
}

export const WorkflowNodeCard = memo(WorkflowNodeCardImpl);
WorkflowNodeCard.displayName = 'WorkflowNodeCard';
