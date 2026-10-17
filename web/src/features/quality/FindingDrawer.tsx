import { useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertCircle, X } from 'lucide-react';
import type { Finding, FindingStatus, UpdateFindingInput } from '@asf/shared';
import { Button, Field, Textarea } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/utils';
import { SOURCE_LABEL, SeverityPill, STATUS_LABEL, formatLocation } from './FindingsTable';
import { createFixTask, updateFinding } from './qualityApi';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const TRIAGED: FindingStatus[] = ['accepted', 'false_positive'];

export type ActionId = 'fix' | 'accepted' | 'false_positive' | 'open';

/** Why an action is unavailable for `finding`, or null when it can run. Shown next to the disabled button. */
export function actionBlocker(finding: Finding, action: ActionId, fixCreated: boolean): string | null {
  const { status } = finding;
  if (action === 'fix') {
    if (fixCreated || status === 'fix_planned') return 'A fix task is already planned for this finding.';
    return status === 'open' ? null : `Only open findings can get a fix task (this one is ${STATUS_LABEL[status].toLowerCase()}).`;
  }
  if (action === 'open') return TRIAGED.includes(status) ? null : 'Only accepted or false-positive findings can be reopened.';
  if (status === 'fix_planned' || status === 'fixed') return `This finding is ${STATUS_LABEL[status].toLowerCase()} — its fix task decides the outcome.`;
  return status === action ? `Already marked as ${STATUS_LABEL[status].toLowerCase()}.` : null;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1 border-b border-line-soft px-4 py-3">
      <h3 className="text-[12px] font-semibold text-muted">{title}</h3>
      <div className="whitespace-pre-wrap break-words text-[13px]">{children}</div>
    </section>
  );
}

const None = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;

function Header({ finding }: { finding: Finding }) {
  return (
    <div className="space-y-2 px-4 pb-3 pt-4">
      <div className="flex items-start justify-between gap-3">
        <DialogPrimitive.Title className="text-[15px] font-semibold leading-snug">{finding.title}</DialogPrimitive.Title>
        <DialogPrimitive.Close className="rounded-md p-1 text-muted hover:bg-ink-800 hover:text-text" aria-label="Close"><X size={16} /></DialogPrimitive.Close>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <SeverityPill severity={finding.severity} />
        <span>{SOURCE_LABEL[finding.source]}</span>
        <span>· {STATUS_LABEL[finding.status]}</span>
        <span>· found {timeAgo(finding.createdAt)}</span>
      </div>
    </div>
  );
}

function Details({ finding }: { finding: Finding }) {
  const fixLabel = finding.fixTaskId ? `task ${finding.fixTaskId.slice(0, 8)}` : null;
  return (
    <>
      <Block title="Description">{finding.description || <None>No description.</None>}</Block>
      <Block title="Recommendation">{finding.recommendation || <None>No recommendation given.</None>}</Block>
      <Block title="Location"><code className="font-mono text-[12px]">{formatLocation(finding)}</code></Block>
      <Block title="Source">
        {finding.taskId
          ? <a href="#/tasks" className="text-brand-2 hover:underline">From task {finding.taskId.slice(0, 8)}</a>
          : <None>{finding.source === 'audit' ? 'npm audit (no task)' : 'No source task recorded.'}</None>}
        {fixLabel && <p className="mt-1">Fix: <a href="#/tasks" className="text-brand-2 hover:underline">{fixLabel}</a></p>}
      </Block>
    </>
  );
}

interface ActionsProps { finding: Finding; onChanged: (updated: Finding | null) => void }

function Actions({ finding, onChanged }: ActionsProps) {
  const [note, setNote] = useState(finding.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixKey, setFixKey] = useState<string | null>(null);
  const fixCreated = fixKey !== null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const triage = (status: UpdateFindingInput['status']) => run(async () => {
    onChanged(await updateFinding(finding.id, { status, note: note.trim() || null }));
  });
  const fix = () => {
    if (!window.confirm(`Create a fix task for "${finding.title}"? It is added to the project's current run and starts automatically.`)) return;
    void run(async () => { const task = await createFixTask(finding.id); setFixKey(task.key); onChanged(null); });
  };

  const buttons: { id: ActionId; label: string; variant: 'primary' | 'secondary' | 'ghost'; onClick: () => void }[] = [
    { id: 'fix', label: 'Create fix task', variant: 'primary', onClick: fix },
    { id: 'accepted', label: 'Accept', variant: 'secondary', onClick: () => void triage('accepted') },
    { id: 'false_positive', label: 'False positive', variant: 'secondary', onClick: () => void triage('false_positive') },
    { id: 'open', label: 'Reopen', variant: 'ghost', onClick: () => void triage('open') },
  ];
  const blockers = buttons.map((button) => ({ ...button, reason: actionBlocker(finding, button.id, fixCreated) }));

  return (
    <section aria-label="Actions" className="space-y-3 px-4 py-3">
      <Field label="Note (kept with Accept / False positive)">
        <Textarea rows={3} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Why is this accepted or a false positive?" />
      </Field>
      <div className="flex flex-wrap gap-2">
        {blockers.map(({ id, label, variant, onClick, reason }) => (
          <Button key={id} size="sm" variant={variant} disabled={busy || reason !== null} title={reason ?? undefined} onClick={onClick}>{label}</Button>
        ))}
      </div>
      <ul className="space-y-0.5 text-[11.5px] text-faint">
        {blockers.filter((b) => b.reason).map((b) => <li key={b.id}>{b.label}: {b.reason}</li>)}
      </ul>
      {fixKey && <p role="status" className="text-[12.5px] text-st-completed">Fix task {fixKey} created — it starts with the current run.</p>}
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-st-failed/30 bg-st-failed/10 px-3 py-2 text-[12.5px] text-st-failed">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{error}
        </div>
      )}
    </section>
  );
}

export interface FindingDrawerProps {
  finding: Finding;
  onClose: () => void;
  /** After an action: the updated finding, or null when only a re-fetch is needed (fix task created). */
  onChanged: (updated: Finding | null) => void;
}

export function FindingDrawer({ finding, onClose, onChanged }: FindingDrawerProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink-950/50" />
        <DialogPrimitive.Content aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col overflow-y-auto border-l border-line bg-ink-900 shadow-2xl shadow-black/40">
          <Header finding={finding} />
          <Details finding={finding} />
          <Actions key={finding.id} finding={finding} onChanged={onChanged} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
