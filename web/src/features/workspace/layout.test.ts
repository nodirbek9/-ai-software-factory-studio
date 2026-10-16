import type { WorkspaceLayout, WorkspaceLayoutNode } from '@asf/shared';
import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  closePanel,
  createLayout,
  movePanel,
  minimizePanel,
  normalizeLayout,
  panelIds,
  reopenSession,
  resizeSplit,
  restorePanel,
  setPanelSession,
  setPanelTab,
  splitPanel,
  swapPanels,
  toggleMaximize,
  WORKSPACE_PRESETS,
} from './layout';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** Compact tree notation: `col(row(p1,p2),row(p3,p4))`. */
function shape(node: WorkspaceLayoutNode): string {
  return node.type === 'panel' ? node.id : `${node.dir}(${node.children.map(shape).join(',')})`;
}

function splits(node: WorkspaceLayoutNode): Extract<WorkspaceLayoutNode, { type: 'split' }>[] {
  return node.type === 'panel' ? [] : [node, ...node.children.flatMap(splits)];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function expectValidSizes(layout: WorkspaceLayout) {
  for (const s of splits(layout.root)) {
    expect(s.sizes).toHaveLength(s.children.length);
    expect(sum(s.sizes)).toBeCloseTo(100, 5);
    s.sizes.forEach((size) => expect(size).toBeGreaterThan(0));
  }
}

/** A 4-panel layout whose panels p1, p2 and p4 hold sessions s1, s2 and s4 (p3 is empty). */
function filled4(): WorkspaceLayout {
  let layout = createLayout(4);
  layout = setPanelSession(layout, 'p1', 's1');
  layout = setPanelSession(layout, 'p2', 's2');
  return setPanelSession(layout, 'p4', 's4');
}

describe('createLayout', () => {
  const shapes: Record<number, string> = {
    1: 'p1',
    2: 'row(p1,p2)',
    3: 'row(p1,p2,p3)',
    4: 'col(row(p1,p2),row(p3,p4))',
    5: 'col(row(p1,p2,p3),row(p4,p5))',
    6: 'col(row(p1,p2,p3),row(p4,p5,p6))',
    8: 'col(row(p1,p2,p3,p4),row(p5,p6,p7,p8))',
  };

  it.each(WORKSPACE_PRESETS.map((p) => [p]))('builds the spec tree for preset %i', (preset) => {
    const layout = createLayout(preset);
    expect(shape(layout.root)).toBe(shapes[preset]);
    expect(layout.version).toBe(1);
    expect(layout.preset).toBe(preset);
    expect(Object.keys(layout.panels)).toHaveLength(preset);
    expect(panelIds(layout)).toEqual(Array.from({ length: preset }, (_, i) => `p${i + 1}`));
  });

  it('uses equal sizes that sum to 100 in every split', () => {
    for (const preset of WORKSPACE_PRESETS) {
      const layout = createLayout(preset);
      expectValidSizes(layout);
      for (const s of splits(layout.root)) {
        s.sizes.forEach((size) => expect(size).toBeCloseTo(100 / s.sizes.length, 1));
      }
    }
  });

  it('starts with empty session panels on the chat tab and no UI state', () => {
    const layout = createLayout(2);
    expect(layout.panels.p1).toEqual({ sessionId: null, tab: 'chat', kind: 'session' });
    expect(layout.maximized).toBeNull();
    expect(layout.minimized).toEqual([]);
    expect(layout.recentlyClosed).toEqual([]);
    expect(layout.drawer).toEqual({ open: false, tab: 'coordination', width: 360 });
  });

  it('uses the given panel ids in reading order and generates the missing ones', () => {
    expect(panelIds(createLayout(3, ['a', 'b']))).toEqual(['a', 'b', 'p1']);
    expect(panelIds(createLayout(2, ['x', 'y', 'z']))).toEqual(['x', 'y']);
    expect(Object.keys(createLayout(2, ['x', 'y']).panels)).toEqual(['x', 'y']);
  });

  it('does not share state between calls', () => {
    const a = createLayout(2);
    const b = createLayout(2);
    expect(a).toEqual(b);
    expect(a.panels).not.toBe(b.panels);
    expect(a.drawer).not.toBe(b.drawer);
  });
});

describe('applyPreset', () => {
  it('keeps existing panels (session + tab) in reading order and adds empty panels', () => {
    let layout = createLayout(2);
    layout = setPanelSession(layout, 'p1', 's1');
    layout = setPanelSession(layout, 'p2', 's2');
    layout = setPanelTab(layout, 'p2', 'changes');
    const next = applyPreset(layout, 4);
    expect(next.preset).toBe(4);
    expect(shape(next.root)).toBe('col(row(p1,p2),row(p3,p4))');
    expect(next.panels.p1.sessionId).toBe('s1');
    expect(next.panels.p2).toEqual({ sessionId: 's2', tab: 'changes', kind: 'session' });
    expect(next.panels.p3).toEqual({ sessionId: null, tab: 'chat', kind: 'session' });
    expect(Object.keys(next.panels).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expectValidSizes(next);
  });

  it('keeps panels in reading order after moves and generates ids that do not collide', () => {
    let layout = createLayout(3);
    layout = movePanel(layout, 'p1', 'p3', 'right'); // reading order: p2, p3, p1
    const next = applyPreset(layout, 5);
    expect(panelIds(next).slice(0, 3)).toEqual(['p2', 'p3', 'p1']);
    expect(new Set(panelIds(next)).size).toBe(5);
    expect(shape(next.root)).toBe('col(row(p2,p3,p1),row(p4,p5))');
  });

  it('moves extra panels with a session to recentlyClosed and drops empty ones silently', () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const next = applyPreset(filled4(), 2, { titleOf: (id) => `Title ${id}`, now });
    expect(shape(next.root)).toBe('row(p1,p2)');
    expect(Object.keys(next.panels)).toEqual(['p1', 'p2']);
    // p3 was empty (nothing recorded); p4 held s4.
    expect(next.recentlyClosed).toEqual([{ sessionId: 's4', title: 'Title s4', closedAt: now.toISOString() }]);
  });

  it('falls back to the session id as title and keeps recentlyClosed within 10', () => {
    let layout = createLayout(8);
    for (let i = 1; i <= 8; i++) layout = setPanelSession(layout, `p${i}`, `s${i}`);
    layout = { ...layout, recentlyClosed: Array.from({ length: 8 }, (_, i) => ({ sessionId: `old${i}`, title: 'old', closedAt: 'x' })) };
    const next = applyPreset(layout, 1);
    expect(next.recentlyClosed).toHaveLength(10);
    expect(next.recentlyClosed[0].title).toBe('s8');
    expect(next.recentlyClosed.slice(0, 7).map((e) => e.sessionId)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3', 's2']);
  });

  it('clears maximized / minimized references to removed panels', () => {
    let layout = filled4();
    layout = toggleMaximize(layout, 'p4');
    layout = { ...layout, minimized: ['p1', 'p3'] };
    const next = applyPreset(layout, 2);
    expect(next.maximized).toBeNull();
    expect(next.minimized).toEqual(['p1']);
    const kept = applyPreset({ ...layout, maximized: 'p1' }, 2);
    expect(kept.maximized).toBe('p1');
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze(filled4());
    expect(() => applyPreset(frozen, 2)).not.toThrow();
    expect(() => applyPreset(frozen, 8)).not.toThrow();
  });
});

describe('splitPanel', () => {
  it('splits next to the panel when the direction matches the parent', () => {
    const next = splitPanel(createLayout(2), 'p1', 'row');
    expect(shape(next.root)).toBe('row(p1,p3,p2)');
    expect(next.root.type === 'split' && next.root.sizes).toEqual([25, 25, 50]);
    expect(next.preset).toBe('custom');
    expect(next.panels.p3).toEqual({ sessionId: null, tab: 'chat', kind: 'session' });
  });

  it('nests when the direction differs', () => {
    const next = splitPanel(createLayout(2), 'p2', 'col');
    expect(shape(next.root)).toBe('row(p1,col(p2,p3))');
    expectValidSizes(next);
  });

  it('splits a single panel into a 50/50 split', () => {
    const next = splitPanel(createLayout(1), 'p1', 'col');
    expect(shape(next.root)).toBe('col(p1,p2)');
    expect(next.root.type === 'split' && next.root.sizes).toEqual([50, 50]);
  });

  it('generates ids that do not collide with existing panels', () => {
    let layout = splitPanel(createLayout(2), 'p1', 'row'); // p1, p2, p3
    layout = closePanel(layout, 'p2');
    layout = splitPanel(layout, 'p1', 'row');
    expect(Object.keys(layout.panels).sort()).toEqual(['p1', 'p3', 'p4']);
  });

  it('ignores unknown panels and does not mutate its input', () => {
    const layout = deepFreeze(createLayout(2));
    expect(splitPanel(layout, 'nope', 'row')).toBe(layout);
    expect(() => splitPanel(layout, 'p1', 'col')).not.toThrow();
  });
});

describe('closePanel', () => {
  it('removes the panel, collapses single-child splits and gives the space to siblings', () => {
    const next = closePanel(createLayout(4), 'p2');
    expect(shape(next.root)).toBe('col(p1,row(p3,p4))');
    expect(Object.keys(next.panels).sort()).toEqual(['p1', 'p3', 'p4']);
    expect(next.preset).toBe('custom');
    expectValidSizes(next);
  });

  it('collapses down to a single panel root', () => {
    const next = closePanel(createLayout(2), 'p1');
    expect(next.root).toEqual({ type: 'panel', id: 'p2' });
  });

  it('shares freed space proportionally', () => {
    let layout = createLayout(3);
    layout = resizeSplit(layout, [], [50, 30, 20]);
    const next = closePanel(layout, 'p1');
    expect(next.root.type === 'split' && next.root.sizes).toEqual([60, 40]);
  });

  it('merges a collapsed split into a parent running in the same direction', () => {
    const layout = splitPanel(splitPanel(createLayout(1), 'p1', 'row'), 'p2', 'col'); // row(p1,col(p2,p3))
    expect(shape(layout.root)).toBe('row(p1,col(p2,p3))');
    expect(shape(closePanel(layout, 'p3').root)).toBe('row(p1,p2)');
    expect(shape(closePanel(layout, 'p1').root)).toBe('col(p2,p3)');
  });

  it('records the session with the given title and time, newest first', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    let layout = filled4();
    layout = closePanel(layout, 'p1', 'Frontend', now);
    layout = closePanel(layout, 'p2', 'Backend', now);
    expect(layout.recentlyClosed).toEqual([
      { sessionId: 's2', title: 'Backend', closedAt: now.toISOString() },
      { sessionId: 's1', title: 'Frontend', closedAt: now.toISOString() },
    ]);
  });

  it('does not record empty panels', () => {
    expect(closePanel(filled4(), 'p3').recentlyClosed).toEqual([]);
  });

  it('keeps at most 10 entries, newest first, one per session', () => {
    let layout = createLayout(8);
    for (let i = 1; i <= 8; i++) layout = setPanelSession(layout, `p${i}`, `s${i}`);
    layout = { ...layout, recentlyClosed: Array.from({ length: 9 }, (_, i) => ({ sessionId: `old${i}`, title: 'old', closedAt: 'x' })) };
    layout = closePanel(layout, 'p1', 'one');
    layout = closePanel(layout, 'p2', 'two');
    layout = closePanel(layout, 'p3', 'three');
    expect(layout.recentlyClosed).toHaveLength(10);
    expect(layout.recentlyClosed.slice(0, 3).map((e) => e.sessionId)).toEqual(['s3', 's2', 's1']);
    const again = closePanel(setPanelSession(createLayout(2), 'p1', 'dup'), 'p1', 'x');
    expect(closePanel(setPanelSession(again, 'p2', 'dup'), 'p2', 'y').recentlyClosed).toEqual([
      expect.objectContaining({ sessionId: 'dup', title: 'y' }),
    ]);
  });

  it('never removes the last panel — it is emptied instead', () => {
    const layout = setPanelSession(createLayout(1), 'p1', 's1');
    const next = closePanel(layout, 'p1', 'Solo');
    expect(panelIds(next)).toEqual(['p1']);
    expect(next.panels.p1.sessionId).toBeNull();
    expect(next.recentlyClosed).toEqual([expect.objectContaining({ sessionId: 's1', title: 'Solo' })]);
  });

  it('clears maximized / minimized for the closed panel', () => {
    let layout = toggleMaximize(createLayout(4), 'p2');
    layout = { ...layout, minimized: ['p3', 'p4'] };
    const next = closePanel(layout, 'p2');
    expect(next.maximized).toBeNull();
    expect(closePanel(layout, 'p3').minimized).toEqual(['p4']);
  });

  it('ignores unknown panels and does not mutate its input', () => {
    const layout = deepFreeze(filled4());
    expect(closePanel(layout, 'nope')).toBe(layout);
    expect(() => closePanel(layout, 'p1', 'T')).not.toThrow();
  });
});

describe('reopenSession', () => {
  it('fills the first empty panel and removes the entry from the list', () => {
    const closed = closePanel(filled4(), 'p1', 'Frontend'); // p3 is the first empty panel in reading order
    const next = reopenSession(closed, 's1');
    expect(next.panels.p3.sessionId).toBe('s1');
    expect(next.recentlyClosed).toEqual([]);
    expect(panelIds(next)).toEqual(panelIds(closed));
  });

  it('splits the last panel when no panel is empty', () => {
    let layout = createLayout(2);
    layout = setPanelSession(layout, 'p1', 's1');
    layout = setPanelSession(layout, 'p2', 's2');
    layout = { ...layout, recentlyClosed: [{ sessionId: 's9', title: 'Nine', closedAt: 'x' }] };
    const next = reopenSession(layout, 's9');
    expect(shape(next.root)).toBe('row(p1,p2,p3)');
    expect(next.panels.p3.sessionId).toBe('s9');
    expect(next.recentlyClosed).toEqual([]);
    expectValidSizes(next);
  });

  it('restores a minimized empty panel and leaves maximized mode so the session is visible', () => {
    let layout = createLayout(2);
    layout = setPanelSession(layout, 'p1', 's1');
    layout = minimizePanel(layout, 'p2');
    layout = toggleMaximize(layout, 'p1');
    const next = reopenSession(layout, 's7');
    expect(next.panels.p2.sessionId).toBe('s7');
    expect(next.minimized).toEqual([]);
    expect(next.maximized).toBeNull();
  });

  it('does nothing but drop the entry when the session is already open', () => {
    const layout = { ...filled4(), recentlyClosed: [{ sessionId: 's1', title: 'x', closedAt: 'y' }] };
    const next = reopenSession(layout, 's1');
    expect(next.recentlyClosed).toEqual([]);
    expect(next.panels).toEqual(layout.panels);
  });

  it('does not mutate its input', () => {
    const full = deepFreeze(setPanelSession(setPanelSession(createLayout(2), 'p1', 'a'), 'p2', 'b'));
    expect(() => reopenSession(full, 'c')).not.toThrow();
    expect(() => reopenSession(deepFreeze(createLayout(2)), 'c')).not.toThrow();
  });
});

describe('swapPanels', () => {
  it('exchanges the positions of two panels and keeps sizes', () => {
    let layout = createLayout(2);
    layout = resizeSplit(layout, [], [30, 70]);
    const next = swapPanels(layout, 'p1', 'p2');
    expect(shape(next.root)).toBe('row(p2,p1)');
    expect(next.root.type === 'split' && next.root.sizes).toEqual([30, 70]);
    expect(next.panels).toEqual(layout.panels);
  });

  it('swaps across nested splits', () => {
    expect(shape(swapPanels(createLayout(4), 'p2', 'p3').root)).toBe('col(row(p1,p3),row(p2,p4))');
  });

  it('ignores identical or unknown ids and does not mutate', () => {
    const layout = deepFreeze(createLayout(3));
    expect(swapPanels(layout, 'p1', 'p1')).toBe(layout);
    expect(swapPanels(layout, 'p1', 'nope')).toBe(layout);
    expect(() => swapPanels(layout, 'p1', 'p3')).not.toThrow();
  });
});

describe('movePanel', () => {
  it('moves to the right edge of another panel', () => {
    const next = movePanel(createLayout(3), 'p1', 'p3', 'right');
    expect(shape(next.root)).toBe('row(p2,p3,p1)');
    const sizes = next.root.type === 'split' ? next.root.sizes : [];
    [50, 25, 25].forEach((expected, i) => expect(sizes[i]).toBeCloseTo(expected, 1));
    expect(next.preset).toBe('custom');
  });

  it('moves to the top edge (nested split in the other direction)', () => {
    const next = movePanel(createLayout(3), 'p1', 'p2', 'top');
    expect(shape(next.root)).toBe('row(col(p1,p2),p3)');
    expectValidSizes(next);
  });

  it('moves to the left and bottom edges', () => {
    expect(shape(movePanel(createLayout(2), 'p1', 'p2', 'bottom').root)).toBe('col(p2,p1)');
    expect(shape(movePanel(createLayout(2), 'p2', 'p1', 'left').root)).toBe('row(p2,p1)');
    expect(shape(movePanel(createLayout(4), 'p4', 'p1', 'left').root)).toBe('col(row(p4,p1,p2),p3)');
  });

  it('keeps every panel exactly once', () => {
    const next = movePanel(createLayout(6), 'p1', 'p6', 'bottom');
    expect(panelIds(next).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expectValidSizes(next);
  });

  it('ignores moving onto itself or unknown panels and does not mutate', () => {
    const layout = deepFreeze(createLayout(3));
    expect(movePanel(layout, 'p1', 'p1', 'left')).toBe(layout);
    expect(movePanel(layout, 'p1', 'nope', 'left')).toBe(layout);
    expect(() => movePanel(layout, 'p3', 'p1', 'top')).not.toThrow();
  });
});

describe('maximize / minimize / restore', () => {
  it('toggles maximize', () => {
    const layout = createLayout(4);
    const max = toggleMaximize(layout, 'p3');
    expect(max.maximized).toBe('p3');
    expect(toggleMaximize(max, 'p3').maximized).toBeNull();
    expect(toggleMaximize(max, 'p1').maximized).toBe('p1');
    expect(toggleMaximize(layout, 'nope')).toBe(layout);
  });

  it('un-minimizes a panel when it is maximized', () => {
    const layout = minimizePanel(createLayout(2), 'p2');
    expect(toggleMaximize(layout, 'p2')).toMatchObject({ maximized: 'p2', minimized: [] });
  });

  it('minimizes and restores panels', () => {
    let layout = createLayout(3);
    layout = minimizePanel(layout, 'p1');
    layout = minimizePanel(layout, 'p3');
    expect(layout.minimized).toEqual(['p1', 'p3']);
    expect(minimizePanel(layout, 'p1')).toBe(layout);
    layout = restorePanel(layout, 'p1');
    expect(layout.minimized).toEqual(['p3']);
    expect(restorePanel(layout, 'p1')).toBe(layout);
    expect(panelIds(layout)).toEqual(['p1', 'p2', 'p3']);
  });

  it('minimizing the maximized panel leaves maximized mode', () => {
    expect(minimizePanel(toggleMaximize(createLayout(2), 'p1'), 'p1')).toMatchObject({ maximized: null, minimized: ['p1'] });
  });

  it('never minimizes the last visible panel', () => {
    let layout = minimizePanel(createLayout(2), 'p1');
    expect(minimizePanel(layout, 'p2')).toBe(layout);
    layout = createLayout(1);
    expect(minimizePanel(layout, 'p1')).toBe(layout);
  });

  it('does not mutate its input', () => {
    const layout = deepFreeze(createLayout(3));
    expect(() => minimizePanel(layout, 'p1')).not.toThrow();
    expect(() => toggleMaximize(layout, 'p1')).not.toThrow();
    expect(() => restorePanel(deepFreeze({ ...createLayout(2), minimized: ['p1'] }), 'p1')).not.toThrow();
  });
});

describe('setPanelSession / setPanelTab', () => {
  it('updates one panel immutably', () => {
    const layout = deepFreeze(createLayout(2));
    const a = setPanelSession(layout, 'p2', 's5');
    const b = setPanelTab(a, 'p2', 'files');
    expect(a.panels.p2).toEqual({ sessionId: 's5', tab: 'chat', kind: 'session' });
    expect(b.panels.p2).toEqual({ sessionId: 's5', tab: 'files', kind: 'session' });
    expect(b.panels.p1).toBe(layout.panels.p1);
    expect(setPanelSession(b, 'p2', null).panels.p2.sessionId).toBeNull();
  });

  it('ignores unknown panels', () => {
    const layout = createLayout(1);
    expect(setPanelSession(layout, 'nope', 's')).toBe(layout);
    expect(setPanelTab(layout, 'nope', 'files')).toBe(layout);
  });
});

describe('resizeSplit', () => {
  it('sets sizes of the root split', () => {
    const next = resizeSplit(createLayout(3), [], [20, 30, 50]);
    expect(next.root.type === 'split' && next.root.sizes).toEqual([20, 30, 50]);
    expect(next.preset).toBe(3);
  });

  it('sets sizes of a nested split by path', () => {
    const next = resizeSplit(createLayout(4), [1], [30, 70]);
    const second = next.root.type === 'split' ? next.root.children[1] : null;
    expect(second && second.type === 'split' && second.sizes).toEqual([30, 70]);
    const first = next.root.type === 'split' ? next.root.children[0] : null;
    expect(first && first.type === 'split' && first.sizes).toEqual([50, 50]);
  });

  it('rescales sizes that do not sum to 100', () => {
    const next = resizeSplit(createLayout(2), [], [1, 3]);
    expect(next.root.type === 'split' && next.root.sizes).toEqual([25, 75]);
  });

  it('leaves the layout unchanged for invalid input', () => {
    const layout = createLayout(4);
    expect(resizeSplit(layout, [], [100])).toBe(layout);
    expect(resizeSplit(layout, [], [50, 0])).toBe(layout);
    expect(resizeSplit(layout, [], [50, Number.NaN])).toBe(layout);
    expect(resizeSplit(layout, [5], [50, 50])).toBe(layout);
    expect(resizeSplit(layout, [0, 0], [50, 50])).toBe(layout); // path ends on a panel
    expect(resizeSplit(createLayout(1), [], [100])).toEqual(createLayout(1));
  });

  it('does not mutate its input', () => {
    const layout = deepFreeze(createLayout(4));
    expect(() => resizeSplit(layout, [0], [10, 90])).not.toThrow();
  });
});

describe('panelIds', () => {
  it('returns ids in reading order', () => {
    expect(panelIds(createLayout(5))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(panelIds(swapPanels(createLayout(3), 'p1', 'p3'))).toEqual(['p3', 'p2', 'p1']);
  });
});

describe('normalizeLayout', () => {
  const fresh = createLayout(1);

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'layout'],
    ['an array', []],
    ['an empty object', {}],
    ['a wrong version', { ...createLayout(2), version: 2 }],
    ['a missing root', { version: 1 }],
    ['an unknown node type', { ...createLayout(2), root: { type: 'grid' } }],
    ['a split without children', { ...createLayout(2), root: { type: 'split', dir: 'row', sizes: [], children: [] } }],
    ['a bad direction', { ...createLayout(2), root: { type: 'split', dir: 'diag', sizes: [50, 50], children: [{ type: 'panel', id: 'a' }, { type: 'panel', id: 'b' }] } }],
    ['an empty panel id', { ...createLayout(1), root: { type: 'panel', id: '' } }],
    ['a numeric panel id', { ...createLayout(1), root: { type: 'panel', id: 7 } }],
    ['a __proto__ panel id', { ...createLayout(1), root: { type: 'panel', id: '__proto__' } }],
    [
      'duplicate panel ids',
      { ...createLayout(2), root: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'panel', id: 'a' }, { type: 'panel', id: 'a' }] } },
    ],
  ])('returns a fresh preset-1 layout for %s', (_name, value) => {
    expect(normalizeLayout(value)).toEqual(fresh);
  });

  it('accepts a valid layout unchanged (also after a JSON round trip)', () => {
    let layout = applyPreset(filled4(), 6);
    layout = setPanelTab(layout, 'p2', 'output');
    layout = toggleMaximize(layout, 'p5');
    layout = { ...layout, minimized: ['p1'], recentlyClosed: [{ sessionId: 's9', title: 'Nine', closedAt: '2026-10-16T10:00:00.000Z' }] };
    expect(normalizeLayout(layout)).toEqual(layout);
    expect(normalizeLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    for (const preset of WORKSPACE_PRESETS) expect(normalizeLayout(JSON.parse(JSON.stringify(createLayout(preset))))).toEqual(createLayout(preset));
  });

  it('does not mutate its input and does not alias it', () => {
    const input = deepFreeze(createLayout(4));
    const out = normalizeLayout(input);
    expect(out).toEqual(input);
    expect(out.panels).not.toBe(input.panels);
  });

  it('repairs unusable split sizes with equal sizes and rescales usable ones', () => {
    const root = (sizes: unknown) => ({
      type: 'split',
      dir: 'row',
      sizes,
      children: [{ type: 'panel', id: 'a' }, { type: 'panel', id: 'b' }],
    });
    const sizesOf = (value: unknown) => {
      const node = normalizeLayout(value).root;
      return node.type === 'split' ? node.sizes : [];
    };
    const base = createLayout(2, ['a', 'b']);
    expect(sizesOf({ ...base, root: root([0, 10]) })).toEqual([50, 50]);
    expect(sizesOf({ ...base, root: root([50]) })).toEqual([50, 50]);
    expect(sizesOf({ ...base, root: root('x') })).toEqual([50, 50]);
    expect(sizesOf({ ...base, root: root([1, 3]) })).toEqual([25, 75]);
  });

  it('collapses single-child splits', () => {
    const value = { ...createLayout(1, ['a']), root: { type: 'split', dir: 'row', sizes: [100], children: [{ type: 'panel', id: 'a' }] } };
    expect(normalizeLayout(value).root).toEqual({ type: 'panel', id: 'a' });
  });

  it('repairs panel entries: adds missing ones, drops unknown ones, fixes bad fields', () => {
    const value = {
      ...createLayout(2),
      panels: {
        p1: { sessionId: 7, tab: 'nonsense', kind: 'weird' },
        p2: { sessionId: 's2', tab: 'files', kind: 'orchestrator' },
        ghost: { sessionId: 'g', tab: 'chat', kind: 'session' },
      },
    };
    const out = normalizeLayout(value);
    expect(Object.keys(out.panels).sort()).toEqual(['p1', 'p2']);
    expect(out.panels.p1).toEqual({ sessionId: null, tab: 'chat', kind: 'session' });
    expect(out.panels.p2).toEqual({ sessionId: 's2', tab: 'files', kind: 'orchestrator' });
    const missing = normalizeLayout({ ...createLayout(2), panels: undefined });
    expect(missing.panels.p1).toEqual({ sessionId: null, tab: 'chat', kind: 'session' });
  });

  it('repairs the preset, maximized and minimized fields', () => {
    expect(normalizeLayout({ ...createLayout(2), preset: 7 }).preset).toBe('custom');
    expect(normalizeLayout({ ...createLayout(2), preset: 'custom' }).preset).toBe('custom');
    expect(normalizeLayout({ ...createLayout(2), maximized: 'ghost' }).maximized).toBeNull();
    expect(normalizeLayout({ ...createLayout(2), maximized: 'constructor' }).maximized).toBeNull();
    expect(normalizeLayout({ ...createLayout(2), maximized: 'p2' }).maximized).toBe('p2');
    expect(normalizeLayout({ ...createLayout(3), minimized: ['p1', 'p1', 'ghost', 4, 'p2'] }).minimized).toEqual(['p1', 'p2']);
    expect(normalizeLayout({ ...createLayout(2), minimized: 'p1' }).minimized).toEqual([]);
    // every panel minimized would render nothing
    expect(normalizeLayout({ ...createLayout(2), minimized: ['p1', 'p2'] }).minimized).toEqual([]);
  });

  it('keeps only well-formed recentlyClosed entries, at most 10', () => {
    const good = (i: number) => ({ sessionId: `s${i}`, title: `T${i}`, closedAt: 'x' });
    const out = normalizeLayout({
      ...createLayout(1),
      recentlyClosed: [{ sessionId: 1 }, null, { sessionId: '', title: 't', closedAt: 'x' }, ...Array.from({ length: 14 }, (_, i) => ({ ...good(i), extra: true }))],
    });
    expect(out.recentlyClosed).toHaveLength(10);
    expect(out.recentlyClosed[0]).toEqual(good(0));
    expect(normalizeLayout({ ...createLayout(1), recentlyClosed: 'nope' }).recentlyClosed).toEqual([]);
  });

  it('repairs the drawer', () => {
    expect(normalizeLayout({ ...createLayout(1), drawer: undefined }).drawer).toEqual({ open: false, tab: 'coordination', width: 360 });
    expect(normalizeLayout({ ...createLayout(1), drawer: { open: true, tab: 'bogus', width: -5 } }).drawer).toEqual({ open: true, tab: 'coordination', width: 360 });
    expect(normalizeLayout({ ...createLayout(1), drawer: { open: true, tab: 'artifacts', width: 420 } }).drawer).toEqual({ open: true, tab: 'artifacts', width: 420 });
  });

  it('always yields sizes that sum to 100 and consistent panels', () => {
    const out = normalizeLayout({ ...createLayout(6), panels: {} });
    expectValidSizes(out);
    expect(Object.keys(out.panels).sort()).toEqual(panelIds(out).sort());
  });
});
