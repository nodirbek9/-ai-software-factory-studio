import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './navigation';
import { VIEWS, hashForView, viewFromHash, type View } from '@/store/studio';

describe('navigation model', () => {
  it('has 11 items with unique ids and labels', () => {
    expect(NAV_ITEMS).toHaveLength(11);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) expect(item.label.trim()).not.toBe('');
  });

  it('explains every planned item with the phase that delivers it', () => {
    const planned = NAV_ITEMS.filter((item) => item.view === null);
    expect(planned.length).toBeGreaterThan(0);
    for (const item of planned) {
      expect(item.plannedReason?.trim()).toBeTruthy();
      expect(item.plannedReason).toMatch(/phase/i);
    }
  });
});

describe('hash routing', () => {
  it.each<View>([...VIEWS])('round-trips %s through its hash', (view) => {
    expect(viewFromHash(hashForView(view))).toBe(view);
  });

  it.each<[string, View]>([
    ['#/dashboard', 'dashboard'], ['#/monitor', 'monitor'], ['#/workflows', 'workflows'],
    ['#/files', 'files'], ['#/providers', 'providers'], ['#/agents', 'agents'],
  ])('keeps the V1 alias %s', (hash, view) => {
    expect(viewFromHash(hash)).toBe(view);
  });

  it.each<[string, View]>([
    ['#/home', 'dashboard'], ['#/runs', 'monitor'], ['#/tasks', 'workflows'],
    ['#/repos', 'files'], ['#/models', 'models'],
  ])('resolves the V2 slug %s', (hash, view) => {
    expect(viewFromHash(hash)).toBe(view);
  });

  it('falls back to the dashboard for unknown or empty hashes', () => {
    expect(viewFromHash('')).toBe('dashboard');
    expect(viewFromHash('#')).toBe('dashboard');
    expect(viewFromHash('#/nope')).toBe('dashboard');
  });
});
