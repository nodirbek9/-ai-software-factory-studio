import { Plus } from 'lucide-react';
import { useStudio } from '@/store/studio';
import { Button } from '@/components/ui/primitives';
import { UI_LOCALE } from './format';

export function Greeting() {
  const userName = useStudio((s) => s.info?.userName.trim() ?? '');
  const setView = useStudio((s) => s.setView);
  const today = new Date().toLocaleDateString(UI_LOCALE, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[22px] font-semibold leading-tight">{userName ? `Welcome back, ${userName}` : 'Welcome back'}</h1>
        <p className="text-[13px] text-muted">Your AI software engineering control center</p>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden text-[12.5px] text-muted sm:block">{today}</span>
        <Button variant="primary" onClick={() => setView('projects')}><Plus size={15} /> New Project</Button>
      </div>
    </div>
  );
}
