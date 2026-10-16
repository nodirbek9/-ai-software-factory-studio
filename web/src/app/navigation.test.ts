import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive } from './navigation';
import { VIEWS, hashForView, hashParam, viewFromHash, type View } from '@/store/studio';

describe('navigation model', () => {
  it('has 11 items with unique ids and labels', () => {
    expect(NAV_ITEMS).toHaveLength(11);
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) expect(item.label.trim()).not.toBe('');
  });

  it('opens the Home page from Home and keeps the Project board highlighted under it', () => {
    const home = NAV_ITEMS.find((item) => item.id === 'home')!;
    expect(home.view).toBe('home');
    expect(isActive(home, 'home')).toBe(true);
    expect(isActive(home, 'dashboard')).toBe(true);
    expect(isActive(home, 'monitor')).toBe(false);
  });

  it('opens the multi-agent workspace from Agent Workspace', () => {
    const workspace = NAV_ITEMS.find((item) => item.id === 'workspace')!;
    expect(workspace.view).toBe('workspace');
    expect(workspace.plannedReason).toBeUndefined();
    expect(isActive(workspace, 'workspace')).toBe(true);
  });

  it('opens the visual workflow builder from Workflow Builder', () => {
    const builder = NAV_ITEMS.find((item) => item.id === 'builder')!;
    expect(builder.view).toBe('builder');
    expect(builder.plannedReason).toBeUndefined();
    expect(isActive(builder, 'builder')).toBe(true);
    expect(isActive(builder, 'workflows')).toBe(false);
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
    ['#/home', 'home'], ['#/board', 'dashboard'], ['#/runs', 'monitor'], ['#/tasks', 'tasks'], ['#/task-graph', 'workflows'],
    ['#/repos', 'repos'], ['#/models', 'models'], ['#/workspace', 'workspace'], ['#/builder', 'builder'],
  ])('resolves the V2 slug %s', (hash, view) => {
    expect(viewFromHash(hash)).toBe(view);
  });

  it('keeps the builder view for #/builder/:workflowId and exposes the id', () => {
    expect(viewFromHash('#/builder/wf-standard')).toBe('builder');
    expect(hashParam('#/builder/wf-standard')).toBe('wf-standard');
    expect(hashParam('#/builder/my%20flow?x=1')).toBe('my flow');
    expect(hashParam('#/builder')).toBeNull();
    expect(hashParam('')).toBeNull();
  });

  it('writes #/board for the Project board and #/home for Home', () => {
    expect(hashForView('dashboard')).toBe('#/board');
    expect(hashForView('home')).toBe('#/home');
  });

  it('falls back to Home for unknown or empty hashes', () => {
    expect(viewFromHash('')).toBe('home');
    expect(viewFromHash('#')).toBe('home');
    expect(viewFromHash('#/nope')).toBe('home');
  });
});
