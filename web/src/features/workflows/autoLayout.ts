import type { WorkflowGraph, WorkflowNode } from '@asf/shared';

export const COLUMN_WIDTH = 240;
export const ROW_HEIGHT = 130;

/**
 * Rank of every node: the longest path from a root over non-retry edges. Retry edges are back edges (fix →
 * verification) and are ignored. Nodes caught in a cycle of normal edges (an invalid graph) are ranked after their
 * resolved predecessors, so the layout always terminates.
 */
function computeRanks(graph: WorkflowGraph): Map<string, number> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'retry' || edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }

  const ranks = new Map<string, number>();
  const pending = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
  const queue = graph.nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id);
  const settle = (id: string): void => {
    for (const next of outgoing.get(id)!) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, ranks.get(id)! + 1));
      pending.set(next, pending.get(next)! - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  };
  for (const id of queue) ranks.set(id, 0);
  for (let i = 0; i < queue.length; i += 1) settle(queue[i]);

  // Cycle leftovers: take them in document order, ranked after whatever is already placed.
  for (const node of graph.nodes) {
    if (ranks.has(node.id)) continue;
    const placed = incoming.get(node.id)!.filter((source) => ranks.has(source));
    ranks.set(node.id, placed.length ? Math.max(...placed.map((source) => ranks.get(source)!)) + 1 : 0);
  }
  return ranks;
}

const byCurrentPosition = (a: WorkflowNode, b: WorkflowNode): number =>
  a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Left → right layered layout: column x = rank * 240; rows are 130 apart, centred per column on a common axis and
 * ordered by the current y, then x, then id. Pure and deterministic; edges are returned untouched.
 */
export function layoutGraph(graph: WorkflowGraph): WorkflowGraph {
  if (graph.nodes.length === 0) return graph;
  const ranks = computeRanks(graph);
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of graph.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    columns.set(rank, [...(columns.get(rank) ?? []), node]);
  }
  const tallest = Math.max(...[...columns.values()].map((column) => column.length));
  const axis = ((tallest - 1) * ROW_HEIGHT) / 2;

  const positions = new Map<string, { x: number; y: number }>();
  for (const [rank, column] of columns) {
    const sorted = [...column].sort(byCurrentPosition);
    sorted.forEach((node, row) => {
      positions.set(node.id, { x: rank * COLUMN_WIDTH, y: axis + (row - (sorted.length - 1) / 2) * ROW_HEIGHT });
    });
  }
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: positions.get(node.id)! })) };
}
