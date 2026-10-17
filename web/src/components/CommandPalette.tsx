import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FolderGit2, Pause, Play, Plus, Sparkles, Square, type LucideIcon } from 'lucide-react';
import { Kbd } from '@/components/ui/primitives';
import { NAV_ITEMS } from '@/app/navigation';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

type Group = 'Navigate' | 'Projects' | 'Actions';

interface Command {
  id: string;
  group: Group;
  label: string;
  icon: LucideIcon;
  /** Why the command cannot run (shown instead of running it). */
  disabledReason?: string;
  /** Small marker after the label, e.g. the current project. */
  badge?: string;
  run: () => void;
}

const STOP_CONFIRM = 'Stop this project? Running tasks are cancelled; completed work stays on the integration branch.';

function buildCommands(): Command[] {
  const state = useStudio.getState();
  const commands: Command[] = [];
  for (const item of NAV_ITEMS) {
    const view = item.view;
    commands.push({
      id: `nav:${item.id}`, group: 'Navigate', label: item.label, icon: item.icon,
      disabledReason: view === null ? (item.plannedReason ?? 'Not available yet.') : undefined,
      run: () => { if (view !== null) useStudio.getState().setView(view); },
    });
  }
  for (const project of state.projects) {
    commands.push({
      id: `project:${project.id}`, group: 'Projects', label: `Switch to ${project.name}`, icon: FolderGit2,
      badge: project.id === state.currentProjectId ? 'Current' : undefined,
      run: () => {
        const store = useStudio.getState();
        void store.selectProject(project.id);
        store.setView('dashboard');
      },
    });
  }
  const status = state.snapshot?.project.status;
  if (status === 'draft') {
    commands.push({ id: 'action:plan', group: 'Actions', label: 'Generate plan', icon: Sparkles,
      run: () => void useStudio.getState().startPlanning() });
  }
  if (status === 'planning' || status === 'running' || status === 'awaiting_approval') {
    commands.push({ id: 'action:pause', group: 'Actions', label: 'Pause project', icon: Pause,
      run: () => void useStudio.getState().pause() });
  }
  if (status === 'paused') {
    commands.push({ id: 'action:resume', group: 'Actions', label: 'Resume project', icon: Play,
      run: () => void useStudio.getState().resume() });
  }
  if (status === 'planning' || status === 'running' || status === 'awaiting_approval' || status === 'paused') {
    commands.push({ id: 'action:stop', group: 'Actions', label: 'Stop project', icon: Square,
      run: () => { if (window.confirm(STOP_CONFIRM)) void useStudio.getState().cancelProject(); } });
  }
  commands.push({ id: 'action:new', group: 'Actions', label: 'New project', icon: Plus,
    run: () => useStudio.getState().setView('projects') });
  return commands;
}

function Palette({ onClose }: { onClose: () => void }) {
  // Subscribing keeps the list in step with the store; the commands themselves are rebuilt from it each render.
  useStudio((state) => state.projects);
  useStudio((state) => state.currentProjectId);
  useStudio((state) => state.snapshot?.project.status);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const needle = query.trim().toLowerCase();
  const items = buildCommands().filter((command) =>
    !needle || command.label.toLowerCase().includes(needle) || command.group.toLowerCase().includes(needle));
  const active = Math.min(activeIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, needle]);

  const execute = (command: Command | undefined) => {
    if (!command || command.disabledReason) return;
    command.run();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      execute(items[active]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 px-4 pt-[14vh]"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-modal">
        <input autoFocus value={query} aria-label="Search commands" placeholder="Type a command or search…"
          role="combobox" aria-expanded="true" aria-controls="command-palette-list" aria-autocomplete="list"
          aria-activedescendant={items.length ? `command-option-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          className="w-full shrink-0 border-b border-line-soft bg-transparent px-4 py-3 text-[13px] text-text outline-none placeholder:text-faint" />
        <ul ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && <li role="presentation" className="px-3 py-6 text-center text-[13px] text-muted">No matching commands</li>}
          {items.map((command, index) => {
            const Icon = command.icon;
            const disabled = Boolean(command.disabledReason);
            return (
              <li key={command.id} role="presentation">
                {command.group !== items[index - 1]?.group && (
                  <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-faint">{command.group}</div>
                )}
                <div id={`command-option-${index}`} role="option" aria-selected={index === active} aria-disabled={disabled || undefined}
                  onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)}
                  className={cn('flex items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px]',
                    disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-text',
                    index === active && 'bg-ink-800')}>
                  <Icon size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{command.label}</span>
                    {command.disabledReason && <span className="mt-0.5 block text-[12px] leading-snug text-faint">{command.disabledReason}</span>}
                  </span>
                  {command.badge && <span className="shrink-0 text-[11px] text-muted">{command.badge}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex shrink-0 items-center gap-4 border-t border-line-soft px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> Move</span>
          <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd> Run</span>
          <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> Close</span>
        </div>
      </div>
    </div>
  );
}

/** Ctrl+K palette: navigate, switch project and run project actions from the keyboard. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open, so the query and active row reset every time it opens.
  return open ? <Palette onClose={onClose} /> : null;
}
