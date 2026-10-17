import { ArrowRight, Cpu, ListChecks, PlayCircle, type LucideIcon } from 'lucide-react';
import { useStudio, type View } from '@/store/studio';
import { Panel, PanelHeader } from '@/components/ui/primitives';

const CARDS: { title: string; text: string; icon: LucideIcon; view: View }[] = [
  { title: 'Open Runs (live monitor)', text: 'Every agent working right now, with its provider, model and effort.', icon: PlayCircle, view: 'monitor' },
  { title: 'Open Tasks', text: 'The task graph of the current project with results, tests and reviews.', icon: ListChecks, view: 'workflows' },
  { title: 'Models & Providers', text: 'Choose which provider, model and effort each agent role uses.', icon: Cpu, view: 'models' },
];

export function QuickLaunch() {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Quick launch" />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        {CARDS.map(({ title, text, icon: Icon, view }) => (
          <button key={title} type="button" onClick={() => setView(view)}
            className="group flex flex-col gap-2 rounded-xl border border-line-soft bg-raised/50 p-3 text-left transition-colors hover:border-brand/50 hover:bg-hover">
            <span className="flex items-center justify-between text-brand"><Icon size={18} /><ArrowRight size={15} className="opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" /></span>
            <span className="text-[13px] font-medium text-text">{title}</span>
            <span className="text-[11.5px] leading-snug text-muted">{text}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}
