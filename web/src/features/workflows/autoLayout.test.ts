import type { WorkflowEdge, WorkflowGraph, WorkflowNodeType } from '@asf/shared';
import { describe, expect, it } from 'vitest';
import { COLUMN_WIDTH, layoutGraph, ROW_HEIGHT } from './autoLayout';

const node = (id: string, type: WorkflowNodeType, x = 0, y = 0) => ({ id, type, position: { x, y }, config: {} });
const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id: `${source}->${target}${extra.sourceHandle ? `:${extra.sourceHandle}` : ''}`,
  source,
  target,
  ...extra,
});

/** Standard-like chain: fan-out after the approval, fan-in at qa, quality gate with a fix retry loop. */
function standardLike(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      node('trigger-1', 'trigger'),
      node('requirement-1', 'requirement'),
      node('decompose-1', 'decompose'),
      node('architect-1', 'architect'),
      node('approval-1', 'approval'),
      node('backend-1', 'backend', 0, 100),
      node('frontend-1', 'frontend', 0, 0),
      node('qa-1', 'qa'),
      node('quality-gate-1', 'quality-gate'),
      node('security-1', 'security'),
      node('fix-1', 'fix'),
      node('artifact-1', 'artifact'),
    ],
    edges: [
      edge('trigger-1', 'requirement-1'),
      edge('requirement-1', 'decompose-1'),
      edge('decompose-1', 'architect-1'),
      edge('architect-1', 'approval-1'),
      edge('approval-1', 'backend-1'),
      edge('approval-1', 'frontend-1'),
      edge('backend-1', 'qa-1'),
      edge('frontend-1', 'qa-1'),
      edge('qa-1', 'quality-gate-1'),
      edge('quality-gate-1', 'security-1', { sourceHandle: 'pass' }),
      edge('quality-gate-1', 'fix-1', { sourceHandle: 'fail' }),
      edge('fix-1', 'qa-1', { kind: 'retry' }),
      edge('security-1', 'artifact-1'),
    ],
  };
}

const positions = (graph: WorkflowGraph): Record<string, { x: number; y: number }> =>
  Object.fromEntries(graph.nodes.map((n) => [n.id, n.position]));

describe('layoutGraph', () => {
  it('uses the longest non-retry path as the column and 240 px per column', () => {
    const laid = positions(layoutGraph(standardLike()));
    const columns = {
      'trigger-1': 0, 'requirement-1': 1, 'decompose-1': 2, 'architect-1': 3, 'approval-1': 4,
      'backend-1': 5, 'frontend-1': 5, 'qa-1': 6, 'quality-gate-1': 7, 'security-1': 8, 'fix-1': 8, 'artifact-1': 9,
    };
    for (const [id, column] of Object.entries(columns)) expect(laid[id].x).toBe(column * COLUMN_WIDTH);
    expect(COLUMN_WIDTH).toBe(240);
  });

  it('ignores retry edges when ranking (fix → qa does not push qa to the right)', () => {
    const laid = positions(layoutGraph(standardLike()));
    expect(laid['qa-1'].x).toBeLessThan(laid['fix-1'].x);
  });

  it('spaces rows 130 apart, centres every column on a common axis and orders by current y', () => {
    const laid = positions(layoutGraph(standardLike()));
    expect(ROW_HEIGHT).toBe(130);
    // two-row columns: frontend (y 0) above backend (y 100), straddling the single-node axis
    expect(laid['frontend-1'].y).toBe(0);
    expect(laid['backend-1'].y).toBe(130);
    for (const id of ['trigger-1', 'requirement-1', 'approval-1', 'qa-1', 'quality-gate-1', 'artifact-1']) {
      expect(laid[id].y).toBe(65);
    }
    // equal y and x → id order: fix-1 before security-1
    expect(laid['fix-1'].y).toBe(0);
    expect(laid['security-1'].y).toBe(130);
  });

  it('is deterministic, idempotent and independent of the node array order', () => {
    const graph = standardLike();
    const once = layoutGraph(graph);
    expect(layoutGraph(graph)).toEqual(once);
    expect(layoutGraph(once)).toEqual(once);
    const shuffled: WorkflowGraph = { ...graph, nodes: [...graph.nodes].reverse() };
    expect(positions(layoutGraph(shuffled))).toEqual(positions(once));
  });

  it('changes only positions and does not mutate the input', () => {
    const graph = standardLike();
    const before = JSON.stringify(graph);
    const laid = layoutGraph(graph);
    expect(JSON.stringify(graph)).toBe(before);
    expect(laid.edges).toBe(graph.edges);
    expect(laid.nodes.map(({ position: _p, ...rest }) => rest)).toEqual(graph.nodes.map(({ position: _p, ...rest }) => rest));
  });

  it('puts a node behind the longest of several paths', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node('a', 'trigger'), node('b', 'backend'), node('c', 'backend'), node('d', 'qa')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('c', 'd')],
    };
    expect(positions(layoutGraph(graph)).d.x).toBe(3 * COLUMN_WIDTH);
  });

  it('keeps unconnected nodes in column 0 and ignores edges to missing nodes', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node('a', 'trigger'), node('lonely', 'notify', 500, 500)],
      edges: [edge('a', 'ghost'), edge('ghost', 'lonely')],
    };
    const laid = positions(layoutGraph(graph));
    expect(laid.a.x).toBe(0);
    expect(laid.lonely.x).toBe(0);
    expect(laid.a.y).toBe(0);
    expect(laid.lonely.y - laid.a.y).toBe(ROW_HEIGHT);
  });

  it('terminates on a cycle of normal edges and still gives every node a finite position', () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node('a', 'trigger'), node('b', 'backend'), node('c', 'qa')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
    };
    const laid = layoutGraph(graph);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    expect(positions(laid).a.x).toBe(0);
  });

  it('returns an empty graph unchanged', () => {
    const empty: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };
    expect(layoutGraph(empty)).toBe(empty);
  });
});
