import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { closePanel, minimizePanel, movePanel, splitPanel, swapPanels, toggleMaximize, type DropEdge } from './layout';
import { panelNumber } from './panelActions';
import { PanelMenu, type MenuItem } from './PanelMenu';
import { useSessions } from './sessionsStore';
import { updateLayout, useWorkspaceApi } from './workspaceContext';

const DRAG_TYPE = 'application/x-asf-panel';
/** Share of the panel (from each edge) that counts as an "edge drop"; the centre swaps. */
const EDGE_ZONE = 0.22;

type DropZone = DropEdge | 'center';

function zoneAt(event: DragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  const distances: [DropEdge, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]];
  const [edge, distance] = distances.reduce((best, item) => (item[1] < best[1] ? item : best));
  return distance <= EDGE_ZONE ? edge : 'center';
}

interface Props {
  panelId: string;
  /** Used as the "recently closed" title when the panel is closed. */
  titleText: string;
  icon: ReactNode;
  hue: string;
  title: ReactNode;
  pill?: ReactNode;
  actions?: ReactNode;
  menuItems?: MenuItem[];
  chips?: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
}

/** Shared chrome of every workspace panel: header, overflow menu, maximize/minimize/close and drag-to-rearrange. */
export function PanelFrame({ panelId, titleText, icon, hue, title, pill, actions, menuItems = [], chips, tabs, children }: Props) {
  const { activePanelId, setActivePanel } = useWorkspaceApi();
  const maximized = useSessions((s) => s.layout?.maximized === panelId);
  const number = useSessions((s) => (s.layout ? panelNumber(s.layout, panelId) : 0));
  const visibleCount = useSessions((s) => (s.layout ? Object.keys(s.layout.panels).filter((id) => !s.layout!.minimized.includes(id)).length : 0));
  const [zone, setZone] = useState<DropZone | null>(null);
  const active = activePanelId === panelId;

  const onHeaderDoubleClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('button, input, textarea, a, [role="menu"]')) return;
    updateLayout((layout) => toggleMaximize(layout, panelId));
  };

  const accepts = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE);
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    setZone(zoneAt(event));
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    const source = event.dataTransfer.getData(DRAG_TYPE);
    const target = zoneAt(event);
    setZone(null);
    if (!source || source === panelId) return;
    updateLayout((layout) => (target === 'center' ? swapPanels(layout, source, panelId) : movePanel(layout, source, panelId, target)));
  };

  const generic: MenuItem[] = [
    { id: 'split-right', label: 'Split right', separatorBefore: menuItems.length > 0, onSelect: () => updateLayout((l) => splitPanel(l, panelId, 'row')) },
    { id: 'split-down', label: 'Split down', onSelect: () => updateLayout((l) => splitPanel(l, panelId, 'col')) },
    { id: 'close-panel', label: 'Close panel (session stays)', onSelect: () => updateLayout((l) => closePanel(l, panelId, titleText)) },
  ];

  return (
    <section
      data-panel-frame={panelId} tabIndex={-1} aria-label={titleText}
      onFocusCapture={() => setActivePanel(panelId)} onMouseDownCapture={() => setActivePanel(panelId)}
      onDragOver={onDragOver} onDragLeave={() => setZone(null)} onDrop={onDrop}
      className={cn('relative flex h-full min-h-0 flex-col bg-surface outline-none', active ? 'ring-1 ring-inset ring-brand/60' : '')}
    >
      <header
        draggable onDoubleClick={onHeaderDoubleClick}
        onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, panelId); event.dataTransfer.effectAllowed = 'move'; }}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-line-soft px-2.5 py-1.5"
        style={{ boxShadow: `inset 2px 0 0 ${hue}` }}
      >
        <span className="shrink-0" style={{ color: hue }} aria-hidden="true">{icon}</span>
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</div>
        {number > 0 && number <= 8 && <span className="shrink-0 rounded border border-line px-1 text-[10px] text-faint" title={`Ctrl+${number} focuses this panel`}>{number}</span>}
        {pill}
        {actions}
        <PanelMenu label={`Panel actions for ${titleText}`} items={[...menuItems, ...generic]} />
        <button type="button" aria-label={`Minimize ${titleText}`} disabled={visibleCount <= 1}
          title={visibleCount <= 1 ? 'The last visible panel cannot be minimized' : 'Minimize to the dock'}
          onClick={() => updateLayout((l) => minimizePanel(l, panelId))}
          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-ink-800 hover:text-text disabled:pointer-events-none disabled:opacity-40">
          <Minus size={14} aria-hidden="true" />
        </button>
        <button type="button" aria-label={maximized ? `Restore ${titleText}` : `Maximize ${titleText}`}
          title={maximized ? 'Restore (Esc)' : 'Maximize (Ctrl+Shift+M)'}
          onClick={() => updateLayout((l) => toggleMaximize(l, panelId))}
          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-ink-800 hover:text-text">
          {maximized ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
        </button>
        <button type="button" aria-label={`Close ${titleText} panel`} title="Close panel (the session stays and can be reopened)"
          onClick={() => updateLayout((l) => closePanel(l, panelId, titleText))}
          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-ink-800 hover:text-text">
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {chips && <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-soft px-2.5 py-1 text-[11px] text-muted">{chips}</div>}
      {tabs}
      <div className="min-h-0 flex-1">{children}</div>
      {zone && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 border-2 border-brand/70 bg-brand/10"
          style={zone === 'center' ? undefined : {
            borderWidth: 0, background: 'color-mix(in srgb, var(--color-brand) 22%, transparent)',
            ...(zone === 'left' ? { right: '50%' } : zone === 'right' ? { left: '50%' } : zone === 'top' ? { bottom: '50%' } : { top: '50%' }),
          }} />
      )}
    </section>
  );
}
