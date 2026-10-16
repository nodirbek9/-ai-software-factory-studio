import { Activity, Bot, Cpu, FolderGit2, FolderTree, Home, ListChecks, PlayCircle, Settings, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import type { View } from '@/store/studio';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The page this item opens, or null while the feature is still being built. */
  view: View | null;
  /** Shown instead of navigating when `view` is null: what is missing, when it arrives and where to go meanwhile. */
  plannedReason?: string;
  /** Extra views that highlight this item (V1 pages reached through it). */
  alsoActiveFor?: View[];
}

/** The 11 V2 destinations (docs/v2/phases/PHASE_1.md). Order matches the reference design. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: Home, view: 'dashboard' },
  { id: 'projects', label: 'Projects', icon: FolderGit2, view: 'projects' },
  { id: 'workspace', label: 'Agent Workspace', icon: Bot, view: null,
    plannedReason: 'Multi-panel agent sessions arrive in Phase 3. Until then, chat with an agent from its card on Home.' },
  { id: 'builder', label: 'Workflow Builder', icon: Workflow, view: null,
    plannedReason: 'Visual workflow editing arrives in Phase 4. The current task graph is under Tasks.' },
  { id: 'tasks', label: 'Tasks', icon: ListChecks, view: 'workflows' },
  { id: 'runs', label: 'Runs', icon: PlayCircle, view: 'monitor' },
  { id: 'repos', label: 'Repos', icon: FolderTree, view: 'files' },
  { id: 'quality', label: 'QA & Security', icon: ShieldCheck, view: null,
    plannedReason: 'The quality center arrives in Phase 6. Test and review results are on each task under Tasks.' },
  { id: 'logs', label: 'Logs', icon: Activity, view: 'logs' },
  { id: 'models', label: 'Models & Providers', icon: Cpu, view: 'models', alsoActiveFor: ['providers', 'agents'] },
  { id: 'settings', label: 'Settings', icon: Settings, view: 'settings' },
];

export function isActive(item: NavItem, view: View): boolean {
  return item.view === view || Boolean(item.alsoActiveFor?.includes(view));
}
