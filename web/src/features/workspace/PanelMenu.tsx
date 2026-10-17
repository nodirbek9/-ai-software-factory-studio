import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Why the item cannot run (shown under the label). */
  disabledReason?: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  label: string;
  items: MenuItem[];
  icon?: ReactNode;
  className?: string;
}

/**
 * Small dropdown menu. The list is `position: fixed` so the panel's `overflow: hidden` cannot clip it.
 * Closes on Escape, on an outside press, and on resize/scroll.
 */
export function PanelMenu({ label, items, icon, className }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); button.current?.focus(); }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: Math.max(4, window.innerWidth - rect.right) });
    setOpen((value) => !value);
  };

  return (
    <div ref={root} className={cn('relative', className)}>
      <button ref={button} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}
        className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-ink-800 hover:text-text">
        {icon ?? <MoreHorizontal size={15} aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" aria-label={label} style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
          className="z-40 min-w-[210px] rounded-lg border border-line bg-ink-900 p-1 shadow-2xl shadow-black/40">
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore && <div role="separator" className="my-1 h-px bg-line-soft" />}
              <button type="button" role="menuitem" aria-disabled={item.disabledReason ? true : undefined} title={item.disabledReason}
                onClick={() => { if (item.disabledReason) return; setOpen(false); item.onSelect(); }}
                className={cn('block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px]',
                  item.disabledReason ? 'cursor-not-allowed text-faint' : item.danger ? 'text-st-failed hover:bg-st-failed/10' : 'text-text hover:bg-ink-800')}>
                {item.label}
                {item.disabledReason && <span className="block text-[11px] text-faint">{item.disabledReason}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
