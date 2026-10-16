import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { AgentStatus, ProjectStatus, TaskStatus } from '@asf/shared';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type AnyStatus = AgentStatus | TaskStatus | ProjectStatus;

interface StatusMeta { label: string; color: string; text: string; bg: string; live: boolean }

const META: Record<string, StatusMeta> = {
  idle: { label: 'Idle', color: 'var(--color-st-idle)', text: 'text-st-idle', bg: 'bg-st-idle', live: false },
  draft: { label: 'Draft', color: 'var(--color-st-idle)', text: 'text-st-idle', bg: 'bg-st-idle', live: false },
  pending: { label: 'Pending', color: 'var(--color-st-idle)', text: 'text-st-idle', bg: 'bg-st-idle', live: false },
  ready: { label: 'Ready', color: 'var(--color-brand-2)', text: 'text-brand-2', bg: 'bg-brand-2', live: false },
  planning: { label: 'Planning', color: 'var(--color-st-planning)', text: 'text-st-planning', bg: 'bg-st-planning', live: true },
  running: { label: 'Running', color: 'var(--color-st-running)', text: 'text-st-running', bg: 'bg-st-running', live: true },
  waiting_approval: { label: 'Needs approval', color: 'var(--color-st-waiting)', text: 'text-st-waiting', bg: 'bg-st-waiting', live: false },
  awaiting_approval: { label: 'Needs approval', color: 'var(--color-st-waiting)', text: 'text-st-waiting', bg: 'bg-st-waiting', live: false },
  blocked: { label: 'Blocked', color: 'var(--color-st-blocked)', text: 'text-st-blocked', bg: 'bg-st-blocked', live: false },
  paused: { label: 'Paused', color: 'var(--color-st-waiting)', text: 'text-st-waiting', bg: 'bg-st-waiting', live: false },
  completed: { label: 'Completed', color: 'var(--color-st-completed)', text: 'text-st-completed', bg: 'bg-st-completed', live: false },
  failed: { label: 'Failed', color: 'var(--color-st-failed)', text: 'text-st-failed', bg: 'bg-st-failed', live: false },
  cancelled: { label: 'Cancelled', color: 'var(--color-st-cancelled)', text: 'text-st-cancelled', bg: 'bg-st-cancelled', live: false },
};

export function statusMeta(status: string): StatusMeta {
  return META[status] ?? META.idle;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const end = endIso ? Date.parse(endIso) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(startIso)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
