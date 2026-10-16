import { useMemo, useState, type DragEvent } from 'react';
import { Search } from 'lucide-react';
import type { NodeCatalogEntry, NodeCategory, WorkflowNodeType } from '@asf/shared';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/primitives';
import { NODE_ICON, nodeHue } from './WorkflowNodeCard';

/** dataTransfer type of a palette drag; the value is the WorkflowNodeType. */
export const NODE_DRAG_TYPE = 'application/x-asf-node';

const CATEGORY_ORDER: NodeCategory[] = ['trigger', 'input', 'agent', 'control', 'tool', 'output'];
const CATEGORY_LABEL: Record<NodeCategory, string> = {
  trigger: 'Triggers',
  input: 'Inputs',
  agent: 'Agents',
  control: 'Control',
  tool: 'Tools',
  output: 'Output',
};

interface Props {
  catalog: NodeCatalogEntry[];
  /** Click / Enter on an entry: the page adds the node at the canvas centre. */
  onAdd: (type: WorkflowNodeType) => void;
  /** Built-in templates cannot be edited: every entry is disabled with this reason. */
  readOnlyReason?: string;
}

const matches = (entry: NodeCatalogEntry, query: string): boolean =>
  !query || `${entry.label} ${entry.type} ${entry.description}`.toLowerCase().includes(query);

function PaletteEntry({ entry, onAdd, lockedReason }: { entry: NodeCatalogEntry; onAdd: Props['onAdd']; lockedReason?: string }) {
  const Icon = NODE_ICON[entry.type];
  const planned = !entry.executable;
  const disabled = planned || lockedReason !== undefined;
  const hue = nodeHue(entry);
  const onDragStart = (event: DragEvent<HTMLButtonElement>): void => {
    event.dataTransfer.setData(NODE_DRAG_TYPE, entry.type);
    event.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        draggable={!disabled}
        onDragStart={onDragStart}
        onClick={() => onAdd(entry.type)}
        title={planned ? (entry.plannedReason ?? 'Planned — not executable yet') : (lockedReason ?? entry.description)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md border border-line-soft bg-ink-850 px-2 py-1.5 text-left transition-colors',
          disabled ? 'cursor-not-allowed opacity-55' : 'cursor-grab hover:border-line hover:bg-ink-800 active:cursor-grabbing',
        )}
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded" style={{ background: `color-mix(in srgb, ${hue} 18%, transparent)`, color: hue }}>
          <Icon size={13} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-text">{entry.label}</span>
          {planned ? (
            <span className="block text-[10.5px] leading-snug text-faint">Planned — {entry.plannedReason ?? 'not executable yet'}</span>
          ) : (
            <span className="block truncate text-[10.5px] text-faint">{entry.description}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export function NodePalette({ catalog, onAdd, readOnlyReason }: Props) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        entries: catalog.filter((entry) => entry.category === category && matches(entry, needle)),
      })).filter((group) => group.entries.length > 0),
    [catalog, needle],
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
        <Input aria-label="Search nodes" placeholder="Search nodes" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" />
      </div>
      {readOnlyReason && <p className="text-[11px] text-faint">{readOnlyReason}</p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
        {groups.map((group) => (
          <section key={group.category} aria-label={CATEGORY_LABEL[group.category]}>
            <h3 className="mb-1 px-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{CATEGORY_LABEL[group.category]}</h3>
            <ul className="space-y-1">
              {group.entries.map((entry) => (
                <PaletteEntry key={entry.type} entry={entry} onAdd={onAdd} lockedReason={readOnlyReason} />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="px-1 py-4 text-center text-[12px] text-muted">No node matches “{query.trim()}”.</p>}
      </div>
    </div>
  );
}
