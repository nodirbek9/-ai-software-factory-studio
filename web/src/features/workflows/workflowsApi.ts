import type {
  NodeCatalogEntry,
  Run,
  RunsPage,
  RunTimeline,
  SaveWorkflowInput,
  SimulationResult,
  ValidationResult,
  Workflow,
  WorkflowGraph,
  WorkflowSummary,
} from '@asf/shared';
import { api, post, put } from '@/lib/api';

const WORKFLOWS = '/api/v2/workflows';
const enc = encodeURIComponent;

// ------------------------------------------------------------------ workflows

export async function listWorkflows(projectId?: string): Promise<WorkflowSummary[]> {
  const query = projectId ? `?projectId=${enc(projectId)}` : '';
  return (await api<{ workflows: WorkflowSummary[] }>(`${WORKFLOWS}${query}`)).workflows;
}

export async function getWorkflow(id: string): Promise<Workflow> {
  return (await api<{ workflow: Workflow }>(`${WORKFLOWS}/${enc(id)}`)).workflow;
}

export async function createWorkflow(input: SaveWorkflowInput): Promise<Workflow> {
  return (await post<{ workflow: Workflow }>(WORKFLOWS, input)).workflow;
}

export async function saveWorkflow(id: string, input: SaveWorkflowInput): Promise<Workflow> {
  return (await put<{ workflow: Workflow }>(`${WORKFLOWS}/${enc(id)}`, input)).workflow;
}

/** Archives the workflow (the server requires the explicit confirmation flag). */
export function archiveWorkflow(id: string): Promise<void> {
  return api<void>(`${WORKFLOWS}/${enc(id)}`, { method: 'DELETE', json: { confirm: true } });
}

export async function duplicateWorkflow(id: string): Promise<Workflow> {
  return (await post<{ workflow: Workflow }>(`${WORKFLOWS}/${enc(id)}/duplicate`)).workflow;
}

export function exportWorkflow(id: string): Promise<Workflow> {
  return api<Workflow>(`${WORKFLOWS}/${enc(id)}/export`);
}

/** `json` is an exported workflow or a bare graph, already parsed; the server re-validates it. */
export async function importWorkflow(json: unknown, projectId: string): Promise<Workflow> {
  return (await post<{ workflow: Workflow }>(`${WORKFLOWS}/import`, { json, projectId })).workflow;
}

export async function getCatalog(): Promise<NodeCatalogEntry[]> {
  return (await api<{ nodes: NodeCatalogEntry[] }>(`${WORKFLOWS}/catalog`)).nodes;
}

export function validateWorkflow(graph: WorkflowGraph): Promise<ValidationResult> {
  return post<ValidationResult>(`${WORKFLOWS}/validate`, { graph });
}

export function simulateWorkflow(id: string): Promise<SimulationResult> {
  return post<SimulationResult>(`${WORKFLOWS}/${enc(id)}/simulate`);
}

// ------------------------------------------------------------------ runs

export async function startRun(projectId: string, workflowId: string): Promise<Run> {
  return (await post<{ run: Run }>(`/api/v2/projects/${enc(projectId)}/runs`, { workflowId })).run;
}

export function listRuns(projectId: string, before?: number): Promise<RunsPage> {
  const query = before !== undefined ? `?before=${before}` : '';
  return api<RunsPage>(`/api/v2/projects/${enc(projectId)}/runs${query}`);
}

export function getRunTimeline(runId: string): Promise<RunTimeline> {
  return api<RunTimeline>(`/api/v2/runs/${enc(runId)}/timeline`);
}

export function cancelRun(runId: string): Promise<unknown> {
  return post<unknown>(`/api/v2/runs/${enc(runId)}/cancel`, { confirm: true });
}
