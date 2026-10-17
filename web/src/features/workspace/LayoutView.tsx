import { Fragment, useEffect, type ReactNode } from 'react';
import { Group, Panel, Separator, useGroupRef, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import type { WorkspaceLayout, WorkspaceLayoutNode } from '@asf/shared';
import { cn } from '@/lib/utils';
import { panelIds } from './layout';

type SplitNode = Extract<WorkspaceLayoutNode, { type: 'split' }>;

interface LayoutViewProps {
  layout: WorkspaceLayout;
  renderPanel: (panelId: string) => ReactNode;
  /** Called after a user resize with the path of the split (child indices from the root) and its full sizes array. */
  onResize: (path: number[], sizes: number[]) => void;
}

const MIN_PANEL_SIZE = '15%';

function leafIds(node: WorkspaceLayoutNode, out: string[] = []): string[] {
  if (node.type === 'panel') out.push(node.id);
  else node.children.forEach((c) => leafIds(c, out));
  return out;
}

function hasVisible(node: WorkspaceLayoutNode, hidden: ReadonlySet<string>): boolean {
  return node.type === 'panel' ? !hidden.has(node.id) : node.children.some((c) => hasVisible(c, hidden));
}

/** Stable id of a node inside its parent group: the panel id, or the panel ids under a nested split. */
function nodeKey(node: WorkspaceLayoutNode): string {
  return node.type === 'panel' ? `panel:${node.id}` : `split:${leafIds(node).join(',')}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface NodeProps {
  node: WorkspaceLayoutNode;
  path: number[];
  hidden: ReadonlySet<string>;
  renderPanel: (panelId: string) => ReactNode;
  onResize: (path: number[], sizes: number[]) => void;
}

function NodeView({ node, path, hidden, renderPanel, onResize }: NodeProps) {
  if (node.type === 'panel') {
    if (hidden.has(node.id)) return null;
    return (
      <div className="h-full min-h-0 w-full min-w-0 overflow-hidden" data-panel-id={node.id}>
        {renderPanel(node.id)}
      </div>
    );
  }
  const visible = node.children.map((_, i) => i).filter((i) => hasVisible(node.children[i], hidden));
  if (!visible.length) return null;
  // A split with a single visible child (the rest are minimized) needs no group — the child takes the whole area.
  if (visible.length === 1) {
    return <NodeView node={node.children[visible[0]]} path={[...path, visible[0]]} hidden={hidden} renderPanel={renderPanel} onResize={onResize} />;
  }
  const signature = `${node.dir}|${visible.map((i) => nodeKey(node.children[i])).join('|')}`;
  return <SplitGroup key={signature} node={node} visible={visible} path={path} hidden={hidden} renderPanel={renderPanel} onResize={onResize} />;
}

interface SplitGroupProps extends Omit<NodeProps, 'node'> {
  node: SplitNode;
  visible: number[];
}

function SplitGroup({ node, visible, path, hidden, renderPanel, onResize }: SplitGroupProps) {
  const groupRef = useGroupRef();
  const horizontal = node.dir === 'row';
  const keys = visible.map((i) => nodeKey(node.children[i]));
  const visibleTotal = visible.reduce((sum, i) => sum + node.sizes[i], 0);
  const sizes = visible.map((i) => round2((node.sizes[i] * 100) / visibleTotal));
  const sizesSignature = sizes.join(',');

  // Sizes changed from outside (preset applied, layout imported, a panel minimized/restored): push them into the
  // group. After a user drag the reported sizes already match the group, so nothing happens.
  useEffect(() => {
    try {
      const group = groupRef.current;
      if (!group) return;
      const current = group.getLayout();
      if (keys.every((key, j) => Math.abs((current[key] ?? Number.NaN) - sizes[j]) <= 0.5)) return;
      group.setLayout(Object.fromEntries(keys.map((key, j) => [key, sizes[j]])));
    } catch {
      // The group is not measurable yet (e.g. hidden or zero-sized); the defaultSize values still apply.
    }
  }, [sizesSignature]);

  const handleLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const reported = keys.map((key) => layout[key]);
    if (reported.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return;
    // Hidden (minimized) children keep their share; the visible ones divide what is left.
    const full = [...node.sizes];
    visible.forEach((i, j) => {
      full[i] = (reported[j] * visibleTotal) / 100;
    });
    onResize(path, full);
  };

  return (
    <Group
      orientation={horizontal ? 'horizontal' : 'vertical'}
      groupRef={groupRef}
      onLayoutChanged={handleLayoutChanged}
      className="h-full w-full"
    >
      {visible.map((childIndex, j) => (
        <Fragment key={keys[j]}>
          {j > 0 && (
            <Separator
              aria-label="Resize panels"
              className={cn(
                'shrink-0 bg-line-soft transition-colors hover:bg-brand/40 focus-visible:bg-brand/60 data-[separator=active]:bg-brand/60',
                horizontal ? 'w-px' : 'h-px',
              )}
            />
          )}
          <Panel id={keys[j]} defaultSize={`${sizes[j]}%`} minSize={MIN_PANEL_SIZE} style={{ overflow: 'hidden' }}>
            <NodeView
              node={node.children[childIndex]}
              path={[...path, childIndex]}
              hidden={hidden}
              renderPanel={renderPanel}
              onResize={onResize}
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

/**
 * Renders the layout tree with nested resizable groups. A maximized panel is rendered alone at full size; minimized
 * panels are not rendered at all (the workspace page shows them in its dock).
 */
export function LayoutView({ layout, renderPanel, onResize }: LayoutViewProps) {
  const maximized = layout.maximized && panelIds(layout).includes(layout.maximized) ? layout.maximized : null;
  const hidden = new Set(layout.minimized);
  return (
    <div className="h-full min-h-0 w-full min-w-0" data-testid="layout-view">
      {maximized ? (
        <div className="h-full min-h-0 w-full min-w-0 overflow-hidden" data-panel-id={maximized}>
          {renderPanel(maximized)}
        </div>
      ) : (
        <NodeView node={layout.root} path={[]} hidden={hidden} renderPanel={renderPanel} onResize={onResize} />
      )}
    </div>
  );
}
