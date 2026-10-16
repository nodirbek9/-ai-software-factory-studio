import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { Agents } from './Agents';
import { Providers } from './Providers';

const TABS = [
  { id: 'providers', label: 'Providers', hint: 'Which CLIs and APIs the studio can use, their models, limits and usage' },
  { id: 'agents', label: 'Agents', hint: 'Which provider, model and effort each agent role runs on' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** Models & Providers: the V1 Providers and Agents pages under one destination (tabs). */
export function Models() {
  const view = useStudio((state) => state.view);
  const [tab, setTab] = useState<Tab>(view === 'agents' ? 'agents' : 'providers');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end gap-1 border-b border-line-soft px-4 pt-3" role="tablist" aria-label="Models and providers">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" id={`models-tab-${item.id}`} aria-selected={tab === item.id}
            aria-controls="models-panel" title={item.hint} onClick={() => setTab(item.id)}
            className={cn('-mb-px rounded-t-md border border-b-0 px-3.5 py-2 text-[13px] transition-colors',
              tab === item.id ? 'border-line-soft bg-surface font-medium text-text' : 'border-transparent text-muted hover:text-text')}>
            {item.label}
          </button>
        ))}
      </div>
      <div id="models-panel" role="tabpanel" aria-labelledby={`models-tab-${tab}`} className="min-h-0 flex-1">
        {tab === 'providers' ? <Providers /> : <Agents />}
      </div>
    </div>
  );
}
