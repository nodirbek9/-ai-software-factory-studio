import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn, statusMeta } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-gradient-to-r from-accent-from to-accent-to text-white shadow-glow hover:brightness-110',
        secondary: 'bg-ink-800 text-text border border-line hover:bg-ink-700',
        ghost: 'text-muted hover:text-text hover:bg-ink-800',
        danger: 'bg-st-failed/15 text-st-failed border border-st-failed/30 hover:bg-st-failed/25',
        success: 'bg-st-completed/15 text-st-completed border border-st-completed/30 hover:bg-st-completed/25',
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-[13px]', icon: 'h-8 w-8' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line-soft bg-surface', className)} {...props} />;
}

export function PanelHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5', className)}>
      <h2 className="text-[13px] font-semibold text-text">{title}</h2>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', meta.bg, meta.live && 'animate-rail', className)} />;
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', meta.text, className)}
      style={{ borderColor: `color-mix(in srgb, ${meta.color} 35%, transparent)`, background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}>
      <StatusDot status={status} className="h-1.5 w-1.5" />
      {meta.label}
    </span>
  );
}

export function Progress({ value, color = 'var(--color-brand)', className }: { value: number; color?: string; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-ink-700', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('h-8 w-full rounded-md border border-line bg-ink-950 px-2.5 text-[13px] text-text placeholder:text-faint focus:border-brand focus:outline-none', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('w-full rounded-md border border-line bg-ink-950 px-2.5 py-2 text-[13px] text-text placeholder:text-faint focus:border-brand focus:outline-none', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn('h-8 w-full rounded-md border border-line bg-ink-950 px-2 text-[13px] text-text focus:border-brand focus:outline-none', className)} {...props} />
));
Select.displayName = 'Select';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, wide }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm" />
        <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-ink-900 p-5 shadow-2xl shadow-black/40', wide ? 'max-w-3xl' : 'max-w-lg')}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-1 text-[13px] text-muted">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-muted hover:bg-ink-800 hover:text-text" aria-label="Close"><X size={16} /></DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="text-sm font-medium text-text">{title}</p>
      {children && <div className="max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  );
}

/** Keyboard key cap, e.g. <Kbd>Ctrl</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-ink-850 px-1 font-sans text-[10.5px] text-muted', className)}>{children}</kbd>;
}

/** Error panel with a retry action — every data view uses it instead of failing silently. */
export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="text-sm font-medium text-st-failed">{title}</p>
      <p className="max-w-md text-[13px] text-muted">{message}</p>
      {onRetry && <Button size="sm" className="mt-1" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** Placeholder block shown while data loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-ink-800/70', className)} />;
}
