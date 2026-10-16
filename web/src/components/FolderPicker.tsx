import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirListing, FsRoots } from '@asf/shared';
import { ArrowUp, Folder } from 'lucide-react';
import { Button, Dialog, Field, Input } from '@/components/ui/primitives';
import { api, post } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

function breadcrumbs(path: string) {
  const separator = path.includes('\\') ? '\\' : '/';
  const root = path.match(/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?|\/)/)?.[0] ?? '';
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  return [{ label: root || path, path: root || path }, ...parts.map((label, index) => ({
    label, path: root + (root.endsWith(separator) ? '' : separator) + parts.slice(0, index + 1).join(separator),
  }))];
}

export function FolderPicker({ open, onOpenChange, onSelect }: {
  open: boolean; onOpenChange(v: boolean): void; onSelect(listing: DirListing): void;
}) {
  const [roots, setRoots] = useState<FsRoots | null>(null);
  const [current, setCurrent] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirListing | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const showError = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : 'Could not load folders.';
    setError(message);
    useStudio.getState().setError(message);
  }, []);

  const load = useCallback(async (target: string, navigate = true) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    setSelected(null);
    setSelectedPath(target);
    try {
      const listing = await api<DirListing>(`/api/fs/list?path=${encodeURIComponent(target)}`);
      if (id !== request.current) return;
      setSelected(listing);
      if (navigate) { setCurrent(listing); setPath(listing.path); }
    } catch (cause) {
      if (id === request.current) showError(cause);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRoots(null);
    setCurrent(null);
    setSelected(null);
    setSelectedPath('');
    setPath('');
    setError(null);
    setLoading(true);
    void api<FsRoots>('/api/fs/roots', { signal: controller.signal }).then(async (value) => {
      if (controller.signal.aborted) return;
      setRoots(value);
      const initial = value.drives.find((drive) => /^D:\\$/i.test(drive)) ?? value.drives[0];
      if (initial) await load(initial);
      else setLoading(false);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { showError(cause); setLoading(false); }
    });
    return () => { controller.abort(); ++request.current; };
  }, [open, load, showError]);

  async function approve() {
    if (!selected || approving) return;
    const target = selected.path;
    const id = request.current;
    setApproving(true);
    setError(null);
    try {
      const result = await post<Pick<FsRoots, 'approvedRoots'>>('/api/fs/approved-roots', { path: target });
      if (id !== request.current) return;
      setRoots((value) => value && { ...value, ...result });
      await load(target, target === current?.path);
    } catch (cause) {
      if (id === request.current) showError(cause);
    } finally { setApproving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Choose a folder" wide
      description="Select a folder; double-click or press Enter to open it.">
      <div className="space-y-3 text-[13px]">
        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
          <aside className="max-h-80 space-y-3 overflow-y-auto rounded-md border border-line-soft p-2">
            <div className="space-y-1">
              <h3 className="px-2 text-[12px] text-muted">Drives</h3>
              {roots?.drives.map((drive) => <Button key={drive} type="button" variant="ghost" disabled={approving}
                className="w-full justify-start font-mono" onClick={() => void load(drive)}>{drive}</Button>)}
            </div>
            <div className="space-y-1">
              <h3 className="px-2 text-[12px] text-muted">Approved folders</h3>
              {roots?.approvedRoots.map((root) => <Button key={root} type="button" variant="ghost" disabled={approving}
                title={root} className="h-auto w-full justify-start whitespace-normal break-all py-1.5 text-left font-mono"
                onClick={() => void load(root)}>{root}</Button>)}
              {roots && !roots.approvedRoots.length && <p className="px-2 text-[12px] text-faint">No approved folders yet.</p>}
            </div>
          </aside>
          <div className="min-w-0 space-y-2">
            <div className="flex items-start gap-2">
              <Button type="button" disabled={!current?.parent || approving} onClick={() => current?.parent && void load(current.parent)}>
                <ArrowUp size={14} />Up
              </Button>
              <nav aria-label="Folder breadcrumbs" className="flex min-w-0 flex-wrap gap-1">
                {current && breadcrumbs(current.path).map((part, index) => <span key={part.path} className="flex min-w-0 items-center gap-1">
                  {index > 0 && <span className="text-faint">/</span>}
                  <Button type="button" size="sm" variant="ghost" disabled={approving} aria-current={part.path === current.path ? 'location' : undefined}
                    className="h-auto whitespace-normal break-all py-1 font-mono" onClick={() => void load(part.path)}>{part.label}</Button>
                </span>)}
              </nav>
            </div>
            <div aria-busy={loading} aria-label="Subfolders" className="h-64 overflow-y-auto rounded-md border border-line bg-ink-950 p-1">
              {current?.entries.map((entry) => <button key={entry.path} type="button" disabled={approving}
                aria-pressed={selectedPath === entry.path}
                className={cn('flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-ink-800', selectedPath === entry.path && 'bg-ink-800 text-brand')}
                onClick={() => void load(entry.path, false)} onDoubleClick={() => void load(entry.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void load(entry.path); }
                }}>
                <Folder size={16} className="shrink-0" /><span className="min-w-0 break-all">{entry.name}</span>
                {entry.isGitRepo && <span className="rounded border border-line px-1 text-[11px] text-muted">git</span>}
              </button>)}
              {!loading && current && !current.entries.length && <p className="p-3 text-muted">No subfolders.</p>}
            </div>
            {loading && <p role="status" className="text-[12px] text-muted">Loading folders…</p>}
            {current?.truncated && <p className="text-[12px] text-muted">This listing is truncated. Type a path to open a folder that is not shown.</p>}
            <Field label="Folder path">
              <div className="flex gap-2">
                <Input value={path} className="font-mono" onChange={(event) => setPath(event.target.value)} disabled={approving}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (path.trim()) void load(path.trim()); } }} />
                <Button type="button" disabled={!path.trim() || approving} onClick={() => void load(path.trim())}>Go</Button>
              </div>
            </Field>
          </div>
        </div>
        {error && <p role="alert" className="text-st-failed">{error}</p>}
        <div className="space-y-2 border-t border-line-soft pt-3">
          <p className="break-all font-mono">{selected?.path ?? selectedPath}</p>
          {selected && !loading && (selected.protected
            ? <p className="text-st-failed">Protected — cannot be used</p>
            : selected.approved ? <p className="text-st-completed">Approved</p>
              : <div className="flex flex-wrap items-center gap-2"><span className="text-muted">Not approved yet</span>
                <Button type="button" disabled={approving} onClick={() => void approve()}>{approving ? 'Approving…' : 'Approve this folder'}</Button></div>)}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" variant="primary" disabled={loading || approving || !selected?.approved || selected.protected}
              onClick={() => { if (selected) { onSelect(selected); onOpenChange(false); } }}>Use this folder</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
