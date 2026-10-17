import type { WorkspaceLayout, WorkspaceLayoutNode, WorkspacePanelTab } from '@asf/shared';

// Pure, immutable layout engine for the multi-agent workspace (AGENT_WORKSPACE_SPEC.md §9).
// Every function returns a new layout; inputs are never mutated (unchanged inputs may be returned as-is).

export type WorkspacePreset = 1 | 2 | 3 | 4 | 5 | 6 | 8;
export type SplitDir = 'row' | 'col';
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';
type PanelState = WorkspaceLayout['panels'][string];

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [1, 2, 3, 4, 5, 6, 8];
export const MAX_RECENTLY_CLOSED = 10;

const PRESET_ROWS: Record<WorkspacePreset, number[]> = { 1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 8: [4, 4] };
const TABS: readonly WorkspacePanelTab[] = ['chat', 'activity', 'changes', 'files', 'output', 'task', 'terminal'];
const DRAWER_TABS = ['coordination', 'context', 'artifacts'] as const;
const DEFAULT_DRAWER_WIDTH = 360;
const MAX_DEPTH = 16;

/** Own-key check: panel ids come from JSON, so 'constructor' / 'toString' must not count as existing panels. */
const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyPanel(): PanelState {
  return { sessionId: null, tab: 'chat', kind: 'session' };
}

/** `count` equal sizes that sum to exactly 100 (the last one takes the rounding remainder). */
function equalSizes(count: number): number[] {
  const each = round2(100 / count);
  const sizes = Array<number>(count).fill(each);
  sizes[count - 1] = round2(100 - each * (count - 1));
  return sizes;
}

/** Scales positive sizes so they sum to 100; falls back to equal sizes for unusable input. */
function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!sizes.length || !(total > 0) || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return equalSizes(sizes.length);
  const out = sizes.map((s) => round2((s * 100) / total));
  out[out.length - 1] = round2(100 - out.slice(0, -1).reduce((a, b) => a + b, 0));
  return out[out.length - 1] > 0 ? out : equalSizes(sizes.length);
}

/** Generated panel ids 'p<n>' that continue after the highest existing 'p<n>'. */
function freshIds(used: Iterable<string>, count: number): string[] {
  let max = 0;
  for (const id of used) {
    const m = /^p(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Array.from({ length: count }, (_, i) => `p${max + i + 1}`);
}

const leaf = (id: string): WorkspaceLayoutNode => ({ type: 'panel', id });

function split(dir: SplitDir, children: WorkspaceLayoutNode[]): WorkspaceLayoutNode {
  return { type: 'split', dir, sizes: equalSizes(children.length), children };
}

function buildTree(preset: WorkspacePreset, ids: string[]): WorkspaceLayoutNode {
  const rows = PRESET_ROWS[preset];
  let next = 0;
  const built = rows.map((count) => {
    const cells = ids.slice(next, next + count).map(leaf);
    next += count;
    return cells.length === 1 ? cells[0] : split('row', cells);
  });
  return built.length === 1 ? built[0] : split('col', built);
}

function pushClosed(list: WorkspaceLayout['recentlyClosed'], entry: WorkspaceLayout['recentlyClosed'][number]) {
  return [entry, ...list.filter((e) => e.sessionId !== entry.sessionId)].slice(0, MAX_RECENTLY_CLOSED);
}

/** Collapses single-child splits and merges a split into its parent when both run in the same direction. */
function simplify(node: WorkspaceLayoutNode): WorkspaceLayoutNode {
  if (node.type === 'panel') return node;
  const kids: { node: WorkspaceLayoutNode; size: number }[] = [];
  node.children.forEach((child, i) => {
    const s = simplify(child);
    const size = node.sizes[i];
    if (s.type === 'split' && s.dir === node.dir) s.children.forEach((g, j) => kids.push({ node: g, size: (size * s.sizes[j]) / 100 }));
    else kids.push({ node: s, size });
  });
  if (kids.length === 1) return kids[0].node;
  return { type: 'split', dir: node.dir, sizes: normalizeSizes(kids.map((k) => k.size)), children: kids.map((k) => k.node) };
}

/** Removes a panel leaf; the freed space is shared proportionally by its siblings. Null when nothing is left. */
function removeLeaf(node: WorkspaceLayoutNode, id: string): WorkspaceLayoutNode | null {
  if (node.type === 'panel') return node.id === id ? null : node;
  const kids: { node: WorkspaceLayoutNode; size: number }[] = [];
  node.children.forEach((child, i) => {
    const r = removeLeaf(child, id);
    if (r) kids.push({ node: r, size: node.sizes[i] });
  });
  if (!kids.length) return null;
  return simplify({ type: 'split', dir: node.dir, sizes: kids.map((k) => k.size), children: kids.map((k) => k.node) });
}

function replaceLeaf(node: WorkspaceLayoutNode, id: string, replacement: WorkspaceLayoutNode): WorkspaceLayoutNode {
  if (node.type === 'panel') return node.id === id ? replacement : node;
  return { ...node, children: node.children.map((c) => replaceLeaf(c, id, replacement)) };
}

function mapLeafIds(node: WorkspaceLayoutNode, map: (id: string) => string): WorkspaceLayoutNode {
  if (node.type === 'panel') return leaf(map(node.id));
  return { ...node, sizes: [...node.sizes], children: node.children.map((c) => mapLeafIds(c, map)) };
}

function collectIds(node: WorkspaceLayoutNode, out: string[]): string[] {
  if (node.type === 'panel') out.push(node.id);
  else node.children.forEach((c) => collectIds(c, out));
  return out;
}

/** Panel ids in reading order (left to right, top to bottom). */
export function panelIds(layout: WorkspaceLayout): string[] {
  return collectIds(layout.root, []);
}

const defaultDrawer = (): WorkspaceLayout['drawer'] => ({ open: false, tab: 'coordination', width: DEFAULT_DRAWER_WIDTH });

/**
 * Builds a layout from a preset. `panelIds` are used for the first panels (in reading order); missing ones are
 * generated as 'p1'…. Panels start empty ("Start a session").
 */
export function createLayout(preset: WorkspacePreset, panelIdsInput?: string[]): WorkspaceLayout {
  const given = (panelIdsInput ?? []).slice(0, preset);
  const ids = [...given, ...freshIds(given, preset - given.length)];
  return {
    version: 1,
    preset,
    root: buildTree(preset, ids),
    panels: Object.fromEntries(ids.map((id) => [id, emptyPanel()])),
    maximized: null,
    minimized: [],
    recentlyClosed: [],
    drawer: defaultDrawer(),
  };
}

/**
 * Re-tiles the layout into a preset, keeping existing panels (sessionId / tab / kind) in reading order. Missing
 * panels are added empty; extra panels are dropped, and those that had a session go to `recentlyClosed`.
 */
export function applyPreset(
  layout: WorkspaceLayout,
  preset: WorkspacePreset,
  opts: { titleOf?: (sessionId: string) => string; now?: Date } = {},
): WorkspaceLayout {
  const existing = panelIds(layout);
  const kept = existing.slice(0, preset);
  const dropped = existing.slice(preset);
  const fresh = freshIds(existing, preset - kept.length);
  const ids = [...kept, ...fresh];
  const closedAt = (opts.now ?? new Date()).toISOString();
  let recentlyClosed = layout.recentlyClosed;
  for (const id of dropped) {
    const sessionId = has(layout.panels, id) ? layout.panels[id].sessionId : null;
    if (sessionId) recentlyClosed = pushClosed(recentlyClosed, { sessionId, title: opts.titleOf?.(sessionId) ?? sessionId, closedAt });
  }
  const panels: WorkspaceLayout['panels'] = {};
  for (const id of ids) panels[id] = has(layout.panels, id) ? { ...layout.panels[id] } : emptyPanel();
  return {
    ...layout,
    preset,
    root: buildTree(preset, ids),
    panels,
    maximized: layout.maximized && has(panels, layout.maximized) ? layout.maximized : null,
    minimized: layout.minimized.filter((id) => has(panels, id)),
    recentlyClosed,
  };
}

/** Splits a panel in two (the new empty panel goes right of / below it). */
export function splitPanel(layout: WorkspaceLayout, panelId: string, dir: SplitDir): WorkspaceLayout {
  if (!has(layout.panels, panelId)) return layout;
  const [newId] = freshIds(Object.keys(layout.panels), 1);
  const root = simplify(replaceLeaf(layout.root, panelId, split(dir, [leaf(panelId), leaf(newId)])));
  return { ...layout, preset: 'custom', root, panels: { ...layout.panels, [newId]: emptyPanel() } };
}

/**
 * Closes a panel: removes it from the tree (siblings take its space, single-child splits collapse) and remembers its
 * session in `recentlyClosed`. The last remaining panel is never removed — it is emptied instead.
 */
export function closePanel(layout: WorkspaceLayout, panelId: string, title?: string, now: Date = new Date()): WorkspaceLayout {
  if (!has(layout.panels, panelId)) return layout;
  const panel = layout.panels[panelId];
  const recentlyClosed = panel.sessionId
    ? pushClosed(layout.recentlyClosed, { sessionId: panel.sessionId, title: title ?? panel.sessionId, closedAt: now.toISOString() })
    : layout.recentlyClosed;
  if (Object.keys(layout.panels).length === 1) {
    return { ...layout, panels: { [panelId]: { ...panel, sessionId: null } }, maximized: null, minimized: [], recentlyClosed };
  }
  const root = removeLeaf(layout.root, panelId);
  if (!root) return layout;
  const panels = Object.fromEntries(Object.entries(layout.panels).filter(([id]) => id !== panelId));
  return {
    ...layout,
    preset: 'custom',
    root,
    panels,
    maximized: layout.maximized === panelId ? null : layout.maximized,
    minimized: layout.minimized.filter((id) => id !== panelId),
    recentlyClosed,
  };
}

/** Puts a recently closed session back: into the first empty panel, otherwise into a new panel split off the last one. */
export function reopenSession(layout: WorkspaceLayout, sessionId: string): WorkspaceLayout {
  const recentlyClosed = layout.recentlyClosed.filter((e) => e.sessionId !== sessionId);
  if (Object.values(layout.panels).some((p) => p.sessionId === sessionId)) return { ...layout, recentlyClosed };
  const ids = panelIds(layout);
  const empty = ids.find((id) => layout.panels[id].sessionId === null && layout.panels[id].kind === 'session');
  if (empty) {
    return {
      ...layout,
      panels: { ...layout.panels, [empty]: { ...layout.panels[empty], sessionId } },
      maximized: null,
      minimized: layout.minimized.filter((id) => id !== empty),
      recentlyClosed,
    };
  }
  const grown = splitPanel(layout, ids[ids.length - 1], 'row');
  const newId = panelIds(grown).find((id) => !has(layout.panels, id));
  if (!newId) return { ...layout, recentlyClosed };
  return { ...grown, panels: { ...grown.panels, [newId]: { ...grown.panels[newId], sessionId } }, maximized: null, recentlyClosed };
}

/** Swaps the positions of two panels (sizes stay with the slots). */
export function swapPanels(layout: WorkspaceLayout, a: string, b: string): WorkspaceLayout {
  if (a === b || !has(layout.panels, a) || !has(layout.panels, b)) return layout;
  return { ...layout, root: mapLeafIds(layout.root, (id) => (id === a ? b : id === b ? a : id)) };
}

/** Moves a panel next to another one: it takes half of the target's space on the given edge. */
export function movePanel(layout: WorkspaceLayout, panelId: string, targetId: string, edge: DropEdge): WorkspaceLayout {
  if (panelId === targetId || !has(layout.panels, panelId) || !has(layout.panels, targetId)) return layout;
  const without = removeLeaf(layout.root, panelId);
  if (!without) return layout;
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const pair = before ? [leaf(panelId), leaf(targetId)] : [leaf(targetId), leaf(panelId)];
  return { ...layout, preset: 'custom', root: simplify(replaceLeaf(without, targetId, split(dir, pair))) };
}

/** Maximizes a panel (or restores when it already is maximized). A minimized panel is un-minimized. */
export function toggleMaximize(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!has(layout.panels, panelId)) return layout;
  if (layout.maximized === panelId) return { ...layout, maximized: null };
  return { ...layout, maximized: panelId, minimized: layout.minimized.filter((id) => id !== panelId) };
}

/** Minimizes a panel to the dock. The last visible panel cannot be minimized. */
export function minimizePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!has(layout.panels, panelId) || layout.minimized.includes(panelId)) return layout;
  const visible = Object.keys(layout.panels).filter((id) => id !== panelId && !layout.minimized.includes(id));
  if (!visible.length) return layout;
  return { ...layout, maximized: layout.maximized === panelId ? null : layout.maximized, minimized: [...layout.minimized, panelId] };
}

export function restorePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!layout.minimized.includes(panelId)) return layout;
  return { ...layout, minimized: layout.minimized.filter((id) => id !== panelId) };
}

export function setPanelSession(layout: WorkspaceLayout, panelId: string, sessionId: string | null): WorkspaceLayout {
  if (!has(layout.panels, panelId)) return layout;
  const panel = layout.panels[panelId];
  return { ...layout, panels: { ...layout.panels, [panelId]: { ...panel, sessionId } } };
}

export function setPanelTab(layout: WorkspaceLayout, panelId: string, tab: WorkspacePanelTab): WorkspaceLayout {
  if (!has(layout.panels, panelId)) return layout;
  const panel = layout.panels[panelId];
  return { ...layout, panels: { ...layout.panels, [panelId]: { ...panel, tab } } };
}

/**
 * Sets the sizes of the split found by following `path` (child indices from the root; [] = the root). The sizes must
 * match the number of children; they are rescaled to sum to 100. Invalid input leaves the layout unchanged.
 */
export function resizeSplit(layout: WorkspaceLayout, path: number[], sizes: number[]): WorkspaceLayout {
  const update = (node: WorkspaceLayoutNode, rest: number[]): WorkspaceLayoutNode | null => {
    if (node.type === 'panel') return null;
    if (!rest.length) {
      if (sizes.length !== node.children.length || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return null;
      return { ...node, sizes: normalizeSizes(sizes) };
    }
    const [index, ...tail] = rest;
    const child = node.children[index];
    const next = child ? update(child, tail) : null;
    if (!next) return null;
    return { ...node, children: node.children.map((c, i) => (i === index ? next : c)) };
  };
  const root = update(layout.root, path);
  return root ? { ...layout, root } : layout;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation of persisted JSON

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseNode(value: unknown, seen: Set<string>, depth: number): WorkspaceLayoutNode | null {
  if (!isObject(value) || depth > MAX_DEPTH) return null;
  if (value.type === 'panel') {
    if (typeof value.id !== 'string' || !value.id || value.id === '__proto__' || seen.has(value.id)) return null;
    seen.add(value.id);
    return leaf(value.id);
  }
  const { dir, children: rawChildren, sizes: rawSizes } = value;
  if (value.type !== 'split' || (dir !== 'row' && dir !== 'col') || !Array.isArray(rawChildren) || !rawChildren.length) return null;
  const children: WorkspaceLayoutNode[] = [];
  for (const raw of rawChildren) {
    const child = parseNode(raw, seen, depth + 1);
    if (!child) return null;
    children.push(child);
  }
  const sizesOk =
    Array.isArray(rawSizes) && rawSizes.length === children.length && rawSizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0);
  return { type: 'split', dir, sizes: sizesOk ? normalizeSizes(rawSizes as number[]) : equalSizes(children.length), children };
}

/** Validates a JSON value (e.g. from the server) into a usable layout; anything unusable becomes a fresh preset-1 layout. */
export function normalizeLayout(value: unknown): WorkspaceLayout {
  if (!isObject(value) || value.version !== 1) return createLayout(1);
  const parsed = parseNode(value.root, new Set(), 0);
  if (!parsed) return createLayout(1);
  const root = simplify(parsed);
  const ids = collectIds(root, []);
  const rawPanels = isObject(value.panels) ? value.panels : {};
  const panels: WorkspaceLayout['panels'] = {};
  for (const id of ids) {
    const p = has(rawPanels, id) ? rawPanels[id] : undefined;
    panels[id] = isObject(p)
      ? {
          sessionId: typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null,
          tab: TABS.includes(p.tab as WorkspacePanelTab) ? (p.tab as WorkspacePanelTab) : 'chat',
          kind: p.kind === 'orchestrator' ? 'orchestrator' : 'session',
        }
      : emptyPanel();
  }
  const minimized = Array.isArray(value.minimized)
    ? [...new Set(value.minimized.filter((id): id is string => typeof id === 'string' && has(panels, id)))]
    : [];
  const recentlyClosed = (Array.isArray(value.recentlyClosed) ? value.recentlyClosed : [])
    .filter(
      (e): e is WorkspaceLayout['recentlyClosed'][number] =>
        isObject(e) && typeof e.sessionId === 'string' && !!e.sessionId && typeof e.title === 'string' && typeof e.closedAt === 'string',
    )
    .map((e) => ({ sessionId: e.sessionId, title: e.title, closedAt: e.closedAt }))
    .slice(0, MAX_RECENTLY_CLOSED);
  const maximized = value.maximized;
  const rawDrawer = isObject(value.drawer) ? value.drawer : {};
  const drawer: WorkspaceLayout['drawer'] = {
    open: rawDrawer.open === true,
    tab: DRAWER_TABS.includes(rawDrawer.tab as (typeof DRAWER_TABS)[number]) ? (rawDrawer.tab as (typeof DRAWER_TABS)[number]) : 'coordination',
    width: typeof rawDrawer.width === 'number' && Number.isFinite(rawDrawer.width) && rawDrawer.width > 0 ? rawDrawer.width : DEFAULT_DRAWER_WIDTH,
  };
  return {
    version: 1,
    preset: WORKSPACE_PRESETS.includes(value.preset as WorkspacePreset) ? (value.preset as WorkspacePreset) : 'custom',
    root,
    panels,
    maximized: typeof maximized === 'string' && has(panels, maximized) ? maximized : null,
    // A layout with every panel minimized would render nothing, so such a value is discarded.
    minimized: minimized.length >= ids.length ? [] : minimized,
    recentlyClosed,
    drawer,
  };
}
