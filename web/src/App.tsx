import { useEffect, useState, type ComponentType } from 'react';
import { AlertCircle, KeyRound, X } from 'lucide-react';
import { setToken } from '@/lib/api';
import { useStudio, type View } from '@/store/studio';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { RightPanel } from '@/components/layout/RightPanel';
import { Button, Input } from '@/components/ui/primitives';
import { Dashboard } from '@/pages/Dashboard';
import { Monitor } from '@/pages/Monitor';
import { Projects } from '@/pages/Projects';
import { Agents } from '@/pages/Agents';
import { Workflows } from '@/pages/Workflows';
import { Files } from '@/pages/Files';
import { Logs } from '@/pages/Logs';
import { Providers } from '@/pages/Providers';
import { Settings } from '@/pages/Settings';

const PAGES: Record<View, ComponentType> = {
  dashboard: Dashboard, monitor: Monitor, projects: Projects, agents: Agents, workflows: Workflows,
  files: Files, logs: Logs, providers: Providers, settings: Settings,
};

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
  const { view, init, error, setError, authRequired, info } = useStudio();
  useEffect(() => { void init(); }, [init]);

  if (authRequired && !info) return <TokenGate />;
  const Page = PAGES[view];

  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {error && (
          <div role="alert" className="flex items-start gap-2 border-b border-st-failed/30 bg-st-failed/10 px-4 py-2 text-[13px] text-st-failed">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={15} /></button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-hidden"><Page /></main>
          {(view === 'dashboard' || view === 'workflows') && <RightPanel />}
        </div>
      </div>
    </div>
  );
}
