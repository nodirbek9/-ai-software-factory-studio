import { useEffect, useState } from 'react';
import { RunDetail } from '@/features/runs/RunDetail';
import { RunHistory } from '@/features/runs/RunHistory';
import { hashParam, viewFromHash } from '@/store/studio';
import { Monitor } from './Monitor';

export default function Runs() {
  const [runId, setRunId] = useState(() => hashParam(window.location.hash));
  const [tab, setTab] = useState<'history' | 'live'>('history');
  useEffect(() => {
    const onHash = () => {
      if (viewFromHash(window.location.hash) !== 'runs') return;
      setRunId(hashParam(window.location.hash));
      setTab('history');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <div className="h-full overflow-auto p-4">
    <h1 className="mb-3 text-lg font-semibold">Runs</h1>
    <div role="tablist" aria-label="Runs" className="mb-4 flex gap-2 border-b border-line-soft">
      {(['history', 'live'] as const).map((value) => <button key={value} id={`runs-${value}-tab`} role="tab" aria-selected={tab === value} aria-controls="runs-panel" type="button"
        className={`border-b-2 px-3 py-2 text-sm ${tab === value ? 'border-brand text-text' : 'border-transparent text-muted'}`}
        onClick={() => setTab(value)}>{value === 'history' ? 'History' : 'Live'}</button>)}
    </div>
    <div id="runs-panel" role="tabpanel" aria-labelledby={`runs-${tab}-tab`}>
      {tab === 'live' ? <Monitor /> : runId ? <RunDetail key={runId} runId={runId} /> : <RunHistory />}
    </div>
  </div>;
}
