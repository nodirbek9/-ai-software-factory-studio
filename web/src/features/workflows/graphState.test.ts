import type { NodeCatalogEntry, WorkflowGraph, WorkflowNodeType } from '@asf/shared';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  copy,
  createEditorState,
  deleteEdge,
  deleteSelection,
  HISTORY_LIMIT,
  markSaved,
  moveNodes,
  parseWorkflowJson,
  paste,
  redo,
  replaceGraph,
  select,
  selectAll,
  undo,
  updateNode,
  type EditorState,
} from './graphState';

const entry = (
  type: WorkflowNodeType,
  input: boolean,
  outputs: ('out' | 'pass' | 'fail')[],
  fields: NodeCatalogEntry['fields'] = [],
): NodeCatalogEntry => ({
  type,
  label: type,
  category: 'agent',
  description: '',
  executable: true,
  plannedReason: null,
  role: null,
  handles: { input, outputs },
  fields,
});

const CATALOG: NodeCatalogEntry[] = [
  entry('trigger', false, ['out']),
  entry('qa', true, ['out'], [
    { key: 'maxAttempts', label: 'Attempts', type: 'number', default: 2 },
    { key: 'rerunOnly', label: 'Rerun only', type: 'boolean', default: false },
    { key: 'testCommand', label: 'Command', type: 'text' },
  ]),
  entry('quality-gate', true, ['pass', 'fail'], [{ key: 'maxRounds', label: 'Rounds', type: 'number', default: 2 }]),
  entry('fix', true, ['out']),
  entry('backend', true, ['out']),
];

const node = (id: string, type: WorkflowNodeType, x = 0, y = 0) => ({ id, type, position: { x, y }, config: {} });

function sample(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [node('trigger-1', 'trigger'), node('backend-1', 'backend', 200, 0), node('qa-1', 'qa', 400, 0)],
    edges: [
      { id: 'trigger-1->backend-1', source: 'trigger-1', target: 'backend-1' },
      { id: 'backend-1->qa-1', source: 'backend-1', target: 'qa-1' },
    ],
  };
}

const fresh = (): EditorState => createEditorState(sample());
const ids = (state: EditorState): string[] => state.graph.nodes.map((n) => n.id);

describe('createEditorState / markSaved / replaceGraph', () => {
  it('starts clean with empty history, selection and clipboard', () => {
    const state = fresh();
    expect(state).toMatchObject({ selection: [], past: [], future: [], clipboard: [], dirty: false });
    expect(state.graph).toEqual(sample());
  });

  it('markSaved clears dirty and is a no-op when already clean', () => {
    const state = fresh();
    expect(markSaved(state)).toBe(state);
    const dirty = addNode(state, 'qa', { x: 0, y: 0 });
    expect(dirty.dirty).toBe(true);
    const saved = markSaved(dirty);
    expect(saved.dirty).toBe(false);
    expect(saved.graph).toBe(dirty.graph);
    expect(saved.past).toEqual(dirty.past);
  });

  it('replaceGraph resets history and selection, keeps the clipboard, and can mark the graph dirty', () => {
    let state = select(fresh(), ['qa-1']);
    state = copy(state);
    state = addNode(state, 'qa', { x: 0, y: 0 });
    const next = replaceGraph(state, { schemaVersion: 1, nodes: [], edges: [] });
    expect(next).toMatchObject({ selection: [], past: [], future: [], dirty: false });
    expect(next.graph.nodes).toEqual([]);
    expect(next.clipboard).toHaveLength(1);
    expect(replaceGraph(state, sample(), { dirty: true }).dirty).toBe(true);
  });
});

describe('addNode', () => {
  it('creates a unique type-n id that matches the id pattern and selects the new node', () => {
    let state = fresh();
    state = addNode(state, 'qa', { x: 10, y: 20 });
    expect(ids(state)).toContain('qa-2');
    state = addNode(state, 'qa', { x: 10, y: 20 });
    expect(state.selection).toEqual(['qa-3']);
    for (const id of ids(state)) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(new Set(ids(state)).size).toBe(ids(state).length);
    expect(state.graph.nodes.at(-1)!.position).toEqual({ x: 10, y: 20 });
  });

  it('fills the config from catalog defaults and skips fields without one', () => {
    const state = addNode(fresh(), 'quality-gate', { x: 0, y: 0 }, CATALOG);
    expect(state.graph.nodes.at(-1)!.config).toEqual({ maxRounds: 2 });
    const qa = addNode(fresh(), 'qa', { x: 0, y: 0 }, CATALOG).graph.nodes.at(-1)!;
    expect(qa.config).toEqual({ maxAttempts: 2, rerunOnly: false });
    expect(addNode(fresh(), 'qa', { x: 0, y: 0 }).graph.nodes.at(-1)!.config).toEqual({});
  });

  it('records history and clears redo', () => {
    const base = fresh();
    const added = addNode(base, 'fix', { x: 0, y: 0 });
    expect(added.past).toEqual([base.graph]);
    expect(added.dirty).toBe(true);
    expect(redo(undo(added)).future).toEqual([]);
    expect(addNode(undo(added), 'fix', { x: 0, y: 0 }).future).toEqual([]);
  });

  it('does not mutate the previous state', () => {
    const base = fresh();
    addNode(base, 'qa', { x: 0, y: 0 });
    expect(base.graph).toEqual(sample());
  });
});

describe('moveNodes', () => {
  it('drag ticks change the graph without history; the drop records one step back to the pre-drag position', () => {
    let state = fresh();
    state = moveNodes(state, [{ id: 'qa-1', position: { x: 410, y: 5 } }], { record: false });
    state = moveNodes(state, [{ id: 'qa-1', position: { x: 450, y: 30 } }], { record: false });
    expect(state.past).toHaveLength(0);
    expect(state.graph.nodes[2].position).toEqual({ x: 450, y: 30 });
    expect(state.dirty).toBe(true);
    state = moveNodes(state, [{ id: 'qa-1', position: { x: 460, y: 40 } }], { record: true });
    expect(state.past).toHaveLength(1);
    expect(state.graph.nodes[2].position).toEqual({ x: 460, y: 40 });
    state = undo(state);
    expect(state.graph).toEqual(sample());
  });

  it('moves several nodes in one recorded step', () => {
    const state = moveNodes(
      fresh(),
      [
        { id: 'trigger-1', position: { x: 1, y: 1 } },
        { id: 'qa-1', position: { x: 2, y: 2 } },
      ],
      { record: true },
    );
    expect(state.past).toHaveLength(1);
    expect(state.graph.nodes.map((n) => n.position)).toEqual([{ x: 1, y: 1 }, { x: 200, y: 0 }, { x: 2, y: 2 }]);
  });

  it('is a no-op for unchanged positions and unknown ids', () => {
    const state = fresh();
    expect(moveNodes(state, [{ id: 'qa-1', position: { x: 400, y: 0 } }], { record: true })).toBe(state);
    expect(moveNodes(state, [{ id: 'nope', position: { x: 1, y: 1 } }], { record: false })).toBe(state);
  });

  it('dropping back on the start position adds no history', () => {
    let state = moveNodes(fresh(), [{ id: 'qa-1', position: { x: 500, y: 0 } }], { record: false });
    state = moveNodes(state, [{ id: 'qa-1', position: { x: 400, y: 0 } }], { record: true });
    expect(state.past).toHaveLength(0);
    expect(state.graph).toEqual(sample());
    expect(state.dragBase).toBeUndefined();
  });
});

describe('updateNode', () => {
  it('sets and clears the label', () => {
    let state = updateNode(fresh(), 'qa-1', { label: 'Run tests' });
    expect(state.graph.nodes[2].label).toBe('Run tests');
    state = updateNode(state, 'qa-1', { label: '' });
    expect(state.graph.nodes[2]).not.toHaveProperty('label');
    expect(state.past).toHaveLength(2);
  });

  it('merges config and removes keys set to undefined', () => {
    let state = updateNode(fresh(), 'qa-1', { config: { a: 1, b: 2 } });
    state = updateNode(state, 'qa-1', { config: { b: 3, a: undefined } });
    expect(state.graph.nodes[2].config).toEqual({ b: 3 });
  });

  it('is a no-op for unknown ids and unchanged values', () => {
    const state = updateNode(fresh(), 'qa-1', { label: 'X', config: { a: 1 } });
    expect(updateNode(state, 'missing', { label: 'Y' })).toBe(state);
    expect(updateNode(state, 'qa-1', { label: 'X', config: { a: 1 } })).toBe(state);
    expect(updateNode(state, 'qa-1', {})).toBe(state);
  });
});

describe('deleteSelection', () => {
  it('removes the selected nodes with every connected edge and clears the selection', () => {
    const state = deleteSelection(select(fresh(), ['backend-1']));
    expect(ids(state)).toEqual(['trigger-1', 'qa-1']);
    expect(state.graph.edges).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(undo(state).graph).toEqual(sample());
  });

  it('is a no-op with an empty selection', () => {
    const state = fresh();
    expect(deleteSelection(state)).toBe(state);
  });
});

describe('connect', () => {
  const base = (): EditorState => addNode(fresh(), 'quality-gate', { x: 0, y: 0 });

  it('adds a normal edge with a deterministic id and records history', () => {
    const { state, error } = connect(base(), { source: 'qa-1', target: 'quality-gate-1' }, CATALOG);
    expect(error).toBeUndefined();
    const edge = state.graph.edges.at(-1)!;
    expect(edge).toEqual({ id: 'qa-1->quality-gate-1', source: 'qa-1', target: 'quality-gate-1' });
    expect(state.past).toHaveLength(base().past.length + 1);
  });

  it('keeps a pass/fail handle that the source offers', () => {
    let state = addNode(base(), 'fix', { x: 0, y: 0 });
    state = connect(state, { source: 'quality-gate-1', sourceHandle: 'fail', target: 'fix-1' }, CATALOG).state;
    expect(state.graph.edges.at(-1)).toEqual({
      id: 'quality-gate-1:fail->fix-1',
      source: 'quality-gate-1',
      sourceHandle: 'fail',
      target: 'fix-1',
    });
  });

  it('normalises an explicit "out" handle away', () => {
    const { state } = connect(fresh(), { source: 'trigger-1', sourceHandle: 'out', target: 'qa-1' }, CATALOG);
    expect(state.graph.edges.at(-1)).toEqual({ id: 'trigger-1->qa-1', source: 'trigger-1', target: 'qa-1' });
  });

  it('marks an edge leaving a fix node as retry', () => {
    let state = addNode(fresh(), 'fix', { x: 0, y: 0 });
    state = connect(state, { source: 'fix-1', target: 'qa-1' }, CATALOG).state;
    expect(state.graph.edges.at(-1)).toMatchObject({ source: 'fix-1', target: 'qa-1', kind: 'retry' });
  });

  it('rejects a self loop, a duplicate edge and missing nodes without changing the state', () => {
    const state = fresh();
    for (const input of [
      { source: 'qa-1', target: 'qa-1' },
      { source: 'trigger-1', target: 'backend-1' },
      { source: 'ghost', target: 'qa-1' },
      { source: 'qa-1', target: 'ghost' },
    ]) {
      const result = connect(state, input, CATALOG);
      expect(result.error).toEqual(expect.any(String));
      expect(result.state).toBe(state);
    }
  });

  it('rejects a handle the source type does not offer', () => {
    const state = fresh();
    const result = connect(state, { source: 'qa-1', sourceHandle: 'fail', target: 'backend-1' }, CATALOG);
    expect(result.error).toMatch(/no "fail" output/);
    expect(result.state).toBe(state);
    const gate = base();
    expect(connect(gate, { source: 'quality-gate-1', target: 'qa-1' }, CATALOG).error).toMatch(/no "out" output/);
  });

  it('rejects an input on a node without an input handle', () => {
    const state = fresh();
    const result = connect(state, { source: 'qa-1', target: 'trigger-1' }, CATALOG);
    expect(result.error).toMatch(/incoming/);
    expect(result.state).toBe(state);
  });

  it('allows the same nodes on a different handle but not twice on the same one', () => {
    let state = addNode(addNode(fresh(), 'quality-gate', { x: 0, y: 0 }), 'fix', { x: 0, y: 0 });
    state = connect(state, { source: 'quality-gate-1', sourceHandle: 'fail', target: 'fix-1' }, CATALOG).state;
    state = connect(state, { source: 'quality-gate-1', sourceHandle: 'pass', target: 'fix-1' }, CATALOG).state;
    expect(state.graph.edges.filter((e) => e.target === 'fix-1')).toHaveLength(2);
    expect(connect(state, { source: 'quality-gate-1', sourceHandle: 'pass', target: 'fix-1' }, CATALOG).error).toBeDefined();
  });

  it('skips catalog checks when no catalog is passed', () => {
    expect(connect(fresh(), { source: 'qa-1', target: 'trigger-1' }).error).toBeUndefined();
  });
});

describe('deleteEdge', () => {
  it('removes one edge and records history', () => {
    const state = deleteEdge(fresh(), 'backend-1->qa-1');
    expect(state.graph.edges.map((e) => e.id)).toEqual(['trigger-1->backend-1']);
    expect(undo(state).graph.edges).toHaveLength(2);
  });

  it('is a no-op for an unknown edge', () => {
    const state = fresh();
    expect(deleteEdge(state, 'nope')).toBe(state);
  });
});

describe('select / selectAll', () => {
  it('keeps existing unique ids only and never touches history or dirty', () => {
    const state = select(fresh(), ['qa-1', 'ghost', 'qa-1']);
    expect(state.selection).toEqual(['qa-1']);
    expect(state.past).toHaveLength(0);
    expect(state.dirty).toBe(false);
  });

  it('returns the same object when the selection does not change', () => {
    const state = select(fresh(), ['qa-1']);
    expect(select(state, ['qa-1'])).toBe(state);
    expect(select(fresh(), [])).toEqual(fresh());
  });

  it('selectAll selects every node', () => {
    expect(selectAll(fresh()).selection).toEqual(['trigger-1', 'backend-1', 'qa-1']);
  });
});

describe('copy / paste', () => {
  it('copy needs a selection and stores deep copies', () => {
    const state = fresh();
    expect(copy(state)).toBe(state);
    const copied = copy(select(state, ['backend-1', 'qa-1']));
    expect(copied.clipboard.map((n) => n.id)).toEqual(['backend-1', 'qa-1']);
    expect(copied.clipboard[0]).not.toBe(state.graph.nodes[1]);
    expect(copied.past).toHaveLength(0);
  });

  it('paste remaps ids, offsets positions, keeps internal edges only and selects the pasted nodes', () => {
    let state = copy(select(fresh(), ['backend-1', 'qa-1']));
    state = paste(state, { x: 30, y: 60 });
    expect(ids(state)).toEqual(['trigger-1', 'backend-1', 'qa-1', 'backend-2', 'qa-2']);
    expect(state.selection).toEqual(['backend-2', 'qa-2']);
    expect(state.graph.nodes[3].position).toEqual({ x: 230, y: 60 });
    expect(state.graph.nodes[4].position).toEqual({ x: 430, y: 60 });
    const pastedEdges = state.graph.edges.slice(2);
    expect(pastedEdges).toEqual([{ id: 'backend-2->qa-2', source: 'backend-2', target: 'qa-2' }]);
    expect(state.graph.edges.some((e) => e.source === 'trigger-1' && e.target === 'backend-2')).toBe(false);
    expect(state.dirty).toBe(true);
  });

  it('pasting twice gives fresh ids each time and keeps edge kinds and handles', () => {
    let state = addNode(addNode(fresh(), 'quality-gate', { x: 0, y: 0 }), 'fix', { x: 0, y: 0 });
    state = connect(state, { source: 'quality-gate-1', sourceHandle: 'fail', target: 'fix-1' }, CATALOG).state;
    state = connect(state, { source: 'fix-1', target: 'qa-1' }, CATALOG).state;
    state = copy(select(state, ['quality-gate-1', 'fix-1', 'qa-1']));
    state = paste(paste(state, { x: 10, y: 10 }), { x: 20, y: 20 });
    expect(new Set(ids(state)).size).toBe(ids(state).length);
    expect(state.graph.edges).toContainEqual({
      id: 'quality-gate-2:fail->fix-2',
      source: 'quality-gate-2',
      sourceHandle: 'fail',
      target: 'fix-2',
    });
    expect(state.graph.edges).toContainEqual({ id: 'fix-3->qa-3', source: 'fix-3', target: 'qa-3', kind: 'retry' });
  });

  it('paste still keeps the internal edges after the originals were deleted', () => {
    let state = copy(select(fresh(), ['backend-1', 'qa-1']));
    state = deleteSelection(state);
    state = paste(state, { x: 0, y: 0 });
    expect(state.graph.edges).toEqual([{ id: 'backend-1->qa-1', source: 'backend-1', target: 'qa-1' }]);
  });

  it('paste is a no-op with an empty clipboard and the pasted copy is independent of the clipboard', () => {
    const state = fresh();
    expect(paste(state, { x: 1, y: 1 })).toBe(state);
    const withConfig = updateNode(state, 'qa-1', { config: { a: 1 } });
    const pasted = paste(copy(select(withConfig, ['qa-1'])), { x: 0, y: 0 });
    pasted.graph.nodes.at(-1)!.config.a = 99;
    expect(pasted.clipboard[0].config.a).toBe(1);
  });

  it('paste is one undo step', () => {
    const copied = copy(select(fresh(), ['qa-1']));
    const pasted = paste(copied, { x: 0, y: 0 });
    expect(undo(pasted).graph).toEqual(sample());
  });
});

describe('undo / redo', () => {
  it('walks back and forward through changes', () => {
    let state = fresh();
    state = addNode(state, 'qa', { x: 0, y: 0 });
    state = updateNode(state, 'qa-2', { label: 'Second' });
    const afterEdits = state;
    state = undo(state);
    expect(state.graph.nodes.at(-1)!).not.toHaveProperty('label');
    state = undo(state);
    expect(state.graph).toEqual(sample());
    expect(state.future).toHaveLength(2);
    state = redo(redo(state));
    expect(state.graph).toEqual(afterEdits.graph);
    expect(state.past).toHaveLength(2);
    expect(state.future).toHaveLength(0);
  });

  it('is a no-op at the ends of the history', () => {
    const state = fresh();
    expect(undo(state)).toBe(state);
    expect(redo(state)).toBe(state);
  });

  it('a new change drops the redo stack', () => {
    let state = addNode(fresh(), 'qa', { x: 0, y: 0 });
    state = undo(state);
    expect(state.future).toHaveLength(1);
    state = addNode(state, 'fix', { x: 0, y: 0 });
    expect(state.future).toHaveLength(0);
    expect(redo(state)).toBe(state);
  });

  it('drops selected ids that no longer exist and marks the graph dirty', () => {
    let state = addNode(markSaved(fresh()), 'qa', { x: 0, y: 0 });
    state = markSaved(state);
    expect(state.selection).toEqual(['qa-2']);
    state = undo(state);
    expect(state.selection).toEqual([]);
    expect(state.dirty).toBe(true);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps (oldest dropped)`, () => {
    let state = fresh();
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) state = addNode(state, 'backend', { x: i, y: 0 });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) state = undo(state);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(HISTORY_LIMIT);
    // the 20 oldest steps are gone: undo bottoms out 20 nodes above the original graph
    expect(state.graph.nodes).toHaveLength(sample().nodes.length + 20);
  });
});

describe('parseWorkflowJson', () => {
  const text = (value: unknown): string => JSON.stringify(value);

  it('accepts a bare graph and an exported workflow', () => {
    const graph = sample();
    expect(parseWorkflowJson(text(graph))).toEqual({ graph });
    expect(parseWorkflowJson(text({ id: 'wf-1', name: 'X', graph }))).toEqual({ graph });
  });

  it('defaults a missing config and drops unknown fields', () => {
    const result = parseWorkflowJson(
      text({ schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger', position: { x: 1, y: 2 }, extra: true }], edges: [] }),
    );
    expect(result).toEqual({ graph: { schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger', position: { x: 1, y: 2 }, config: {} }], edges: [] } });
  });

  it('reports invalid JSON, wrong schema version and non-objects', () => {
    expect(parseWorkflowJson('{nope')).toEqual({ error: expect.stringMatching(/valid JSON/) });
    expect(parseWorkflowJson('42')).toEqual({ error: expect.any(String) });
    expect(parseWorkflowJson(text({ schemaVersion: 2, nodes: [], edges: [] }))).toEqual({ error: expect.stringMatching(/schemaVersion/) });
    expect(parseWorkflowJson(text({ schemaVersion: 1, nodes: {}, edges: [] }))).toEqual({ error: expect.stringMatching(/arrays/) });
  });

  it('reports bad nodes and edges', () => {
    const bad = (nodes: unknown[], edges: unknown[] = []) => parseWorkflowJson(text({ schemaVersion: 1, nodes, edges }));
    const good = { id: 'a', type: 'trigger', position: { x: 0, y: 0 }, config: {} };
    expect(bad([{ ...good, id: 'Bad Id' }])).toEqual({ error: expect.stringMatching(/invalid id/) });
    expect(bad([{ ...good, type: 'warp' }])).toEqual({ error: expect.stringMatching(/unknown type/) });
    expect(bad([{ ...good, position: { x: 'a', y: 0 } }])).toEqual({ error: expect.stringMatching(/position/) });
    expect(bad([{ ...good, config: [] }])).toEqual({ error: expect.stringMatching(/config/) });
    expect(bad([good, good])).toEqual({ error: expect.stringMatching(/twice/) });
    expect(bad([good], [{ id: 'e', source: 'a', target: 'zzz' }])).toEqual({ error: expect.stringMatching(/missing node/) });
    expect(bad([good], [{ id: 'e', source: 'a', target: 'a', sourceHandle: 'sideways' }])).toEqual({ error: expect.stringMatching(/handle/) });
    expect(bad([good], [{ id: 'e', source: 'a', target: 'a', kind: 'weird' }])).toEqual({ error: expect.stringMatching(/kind/) });
    expect(bad([good], [{ source: 'a', target: 'a' }])).toEqual({ error: expect.stringMatching(/needs an id/) });
  });

  it('rejects a file over the graph size limit', () => {
    expect(parseWorkflowJson(' '.repeat(200_001))).toEqual({ error: expect.stringMatching(/200 KB/) });
  });
});
