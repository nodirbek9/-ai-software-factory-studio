import type { AgentRole } from '@asf/shared';
import { Blocks, ClipboardList, Code2, LayoutTemplate, ShieldCheck, TestTubes, Eye, type LucideIcon } from 'lucide-react';

export const ROLE_ICON: Record<AgentRole, LucideIcon> = {
  pm: ClipboardList,
  architect: Blocks,
  backend: Code2,
  frontend: LayoutTemplate,
  qa: TestTubes,
  security: ShieldCheck,
  reviewer: Eye,
};

/** A stable hue per role so agents are recognisable across cards, graph nodes and logs. */
export const ROLE_HUE: Record<AgentRole, string> = {
  pm: '#7c9cff',
  architect: '#b18cff',
  backend: '#3fd0d4',
  frontend: '#5fb3ff',
  qa: '#57d99a',
  security: '#ffb35c',
  reviewer: '#f58fb8',
};
