import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { AlertCircle, KeyRound, X } from 'lucide-react';
import { setToken } from '@/lib/api';
import { useStudio, type View } from '@/store/studio';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { CommandPalette } from '@/components/CommandPalette';
import { Button, Input, Skeleton } from '@/components/ui/primitives';

/** Each page is its own chunk, so the shell loads fast and heavy pages (graph, editors) load on first use. */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): LazyExoticComponent<ComponentType> {
  return lazy(async () => ({ default: (await load())[name] }));
}

const Models = page(() => import('@/pages/Models'), 'Models');
// The right panel renders Markdown (react-markdown + remark-gfm), so it loads only on the pages that show it.
const RightPanel = page(() => import('@/components/layout/RightPanel'), 'RightPanel');

const PAGES: Record<View, LazyExoticComponent<ComponentType>> = {
  dashboard: page(() => import('@/pages/Dashboard'), 'Dashboard'),
  monitor: page(() => import('@/pages/Monitor'), 'Monitor'),
  projects: page(() => import('@/pages/Projects'), 'Projects'),
  workflows: page(() => import('@/pages/Workflows'), 'Workflows'),
  files: page(() => import('@/pages/Files'), 'Files'),
  logs: page(() => import('@/pages/Logs'), 'Logs'),
  settings: page(() => import('@/pages/Settings'), 'Settings'),
  models: Models,
  providers: Models,
  agents: Models,
};

function PageLoading() {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** Shown only when the server runs with ASF_AUTH_TOKEN (remote access mode). */
function TokenGate() {
  const [value, setValue] = useState('');
  return (
    <div className="grid h-full place-items-center p-4">
      <form className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-ink-900 p-5"
        onSubmit={(e) => { e.preventDefault(); setToken(value.trim()); window.location.reload(); }}>
        <div className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound size={16} /> Access token required</div>
        <p className="text-[13px] text-muted">This studio is running in remote-access mode. Enter the token configured as ASF_AUTH_TOKEN on the server.</p>
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="Access token" />
        <Button variant="primary" type="submit" className="w-full" disabled={!value.trim()}>Unlock studio</Button>
      </form>
    </div>
  );
}

export function App() {
  const { view, init, error, setError, authRequired, info, toggleLeft } = useStudio();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => { void init(); }, [init]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'k') { event.preventDefault(); setPaletteOpen((open) => !open); }
      if ((event.ctrlKey || event.metaKey) && key === 'b') { event.preventDefault(); toggleLeft(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleLeft]);

  if (authRequired && !info) return <TokenGate />;
  const Page = PAGES[view];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <TopBar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          {error && (
            <div role="alert" className="flex items-start gap-2 border-b border-st-failed/30 bg-st-failed/10 px-4 py-2 text-[13px] text-st-failed">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={15} /></button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <main id="main-content" className="min-w-0 flex-1 overflow-hidden">
              <Suspense fallback={<PageLoading />}><Page /></Suspense>
            </main>
            {(view === 'dashboard' || view === 'workflows') && <Suspense fallback={null}><RightPanel /></Suspense>}
          </div>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
