import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, ProjectSnapshot } from '@asf/shared';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Button, EmptyState, Field, Input, Panel } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

interface TreeNode {
  name: string;
  path: string;
  type: FileEntry['type'];
  size: number;
  children: Map<string, TreeNode>;
}

interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const roots = new Map<string, TreeNode>();
  for (const entry of entries) {
    const parts = normalizePath(entry.path).split('/').filter(Boolean);
    let siblings = roots;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const last = index === parts.length - 1;
      let node = siblings.get(name);
      if (!node) {
        node = { name, path, type: last ? entry.type : 'dir', size: 0, children: new Map() };
        siblings.set(name, node);
      }
      if (last) node.size = entry.size;
      siblings = node.children;
    });
  }
  return [...roots.values()];
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFiles({ snapshot }: { snapshot: ProjectSnapshot }) {
  const { project, tasks } = snapshot;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError(null);
    void api<FileEntry[]>(`/api/projects/${encodeURIComponent(project.id)}/files`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setEntries(result);
        setSelectedPath((path) => result.some((entry) => entry.type === 'file' && normalizePath(entry.path) === path) ? path : null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Could not load files.';
        setListError(message);
        useStudio.getState().setError(message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, completedCount, refresh]);

  useEffect(() => {
    setFile(null);
    setFileError(null);
    if (!selectedPath) {
      setFileLoading(false);
      return;
    }
    const controller = new AbortController();
    setFileLoading(true);
    void api<FileContent>(`/api/projects/${encodeURIComponent(project.id)}/file?path=${encodeURIComponent(selectedPath)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setFile(result); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Could not load this file.';
        setFileError(message);
        useStudio.getState().setError(message);
      })
      .finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [project.id, selectedPath, completedCount, refresh]);

  const changedPaths = useMemo(() => new Set(tasks.flatMap((task) => task.filesChanged.map(normalizePath))), [tasks]);
  const query = normalizePath(filter.trim()).toLowerCase();
  const tree = useMemo(() => buildTree(entries.filter((entry) => {
    const path = normalizePath(entry.path);
    return (!changedOnly || (entry.type === 'file' && changedPaths.has(path))) && path.toLowerCase().includes(query);
  })), [entries, changedOnly, changedPaths, query]);

  function renderTree(nodes: TreeNode[], depth = 0) {
    return nodes.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
      .map((node) => {
        const directory = node.type === 'dir';
        const open = Boolean(query) || (expanded[node.path] ?? depth < 1);
        const Icon = directory ? (open ? FolderOpen : Folder) : FileText;
        return (
          <li key={node.path}>
            <button type="button" title={node.path} aria-expanded={directory ? open : undefined}
              aria-current={!directory && selectedPath === node.path ? 'true' : undefined}
              className={cn('flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[12px] hover:bg-ink-800',
                selectedPath === node.path && !directory ? 'bg-brand/10 text-brand' : 'text-muted')}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (directory) setExpanded((current) => ({ ...current, [node.path]: !open }));
                else { setSelectedPath(node.path); setPreview(false); }
              }}>
              {directory ? (open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />)
                : <span className="w-3 shrink-0" />}
              <Icon size={14} className="shrink-0" />
              <span className="truncate">{node.name}</span>
              {!directory && changedPaths.has(node.path) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" title="Changed by agents" aria-label="Changed by agents" />}
              {!directory && <span className="ml-auto shrink-0 text-[10px] text-faint">{formatSize(node.size)}</span>}
            </button>
            {directory && open && <ul>{renderTree([...node.children.values()], depth + 1)}</ul>}
          </li>
        );
      });
  }

  const isMarkdown = selectedPath?.toLowerCase().endsWith('.md');

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Files</h1>
          <p className="mt-1 break-words text-[12px] text-muted">
            Files are shown from the integration worktree, read-only.
            {' '}<span className="font-mono text-faint">{project.integrationPath ?? 'Integration worktree not created yet.'}</span>
          </p>
        </div>
        <Button className="shrink-0" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} /> Refresh
        </Button>
      </div>
      <div className="flex min-h-[360px] flex-1 gap-3">
        <Panel className="flex w-72 shrink-0 flex-col overflow-hidden">
          <div className="space-y-3 border-b border-line-soft p-3">
            <Field label="Filter files"><Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search paths…" /></Field>
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" className="accent-brand" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} />
              Changed by agents only
            </label>
            <p className="flex items-center gap-1.5 text-[11px] text-faint"><span className="h-1.5 w-1.5 rounded-full bg-brand" /> Changed by agents</p>
          </div>
          <nav aria-label="Project files" aria-busy={loading} className="min-h-0 flex-1 overflow-auto p-1.5">
            {listError ? <EmptyState title="Could not load files">{listError} Use Refresh to try again.</EmptyState>
              : loading && entries.length === 0 ? <p role="status" className="p-3 text-[12px] text-muted">Loading files…</p>
                : tree.length ? <ul>{renderTree(tree)}</ul>
                  : <EmptyState title={entries.length ? 'No matching files' : 'No files yet'}>
                    {entries.length ? 'Adjust the path filter or turn off the changed files filter.' : 'Run project tasks, then refresh to see integrated files.'}
                  </EmptyState>}
          </nav>
        </Panel>
        <Panel className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedPath ? <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-2.5">
              <h2 className="min-w-0 break-all font-mono text-[12px]">{selectedPath}</h2>
              {isMarkdown && !file?.binary && <div className="flex gap-1" aria-label="Markdown view">
                <Button size="sm" variant={preview ? 'secondary' : 'ghost'} aria-pressed={preview} onClick={() => setPreview(true)}>Preview</Button>
                <Button size="sm" variant={!preview ? 'secondary' : 'ghost'} aria-pressed={!preview} onClick={() => setPreview(false)}>Source</Button>
              </div>}
            </div>
            {fileLoading ? <p role="status" className="p-4 text-[12px] text-muted">Loading file…</p>
              : fileError ? <EmptyState title="Could not load file">{fileError} Use Refresh to try again.</EmptyState>
                : file && <>
                  {file.truncated && <p role="status" className="border-b border-line-soft px-4 py-2 text-[12px] text-st-waiting">This file is truncated. Only the beginning is shown.</p>}
                  {file.binary ? <EmptyState icon={<FileText size={24} />} title="Binary file">Binary content cannot be displayed in the text viewer.</EmptyState>
                    : <div className="min-h-0 flex-1 overflow-auto">
                      {isMarkdown && preview ? <Markdown className="break-words p-4">{file.content}</Markdown>
                        : <pre className="min-w-full w-max py-3 font-mono text-[12px] leading-5 text-text"><code>
                          {file.content.split('\n').map((line, index) => <span key={index} className="block">
                            <span aria-hidden="true" className="mr-4 inline-block min-w-[4ch] select-none pl-3 text-right text-faint">{index + 1}</span>
                            <span className="pr-4">{line || '\u200b'}</span>
                          </span>)}
                        </code></pre>}
                    </div>}
                </>}
          </> : <EmptyState icon={<FileText size={28} />} title="Select a file">Choose a file in the explorer to view its contents.</EmptyState>}
        </Panel>
      </div>
    </div>
  );
}

export function Files() {
  const snapshot = useStudio((state) => state.snapshot);
  if (!snapshot) return (
    <div className="grid h-full place-items-center">
      <EmptyState icon={<FolderOpen size={28} />} title="Select a project">Open or create a project to explore its integration worktree.
        <Button className="mt-4" onClick={() => useStudio.getState().setView('projects')}>Open projects</Button>
      </EmptyState>
    </div>
  );
  return <ProjectFiles key={snapshot.project.id} snapshot={snapshot} />;
}
