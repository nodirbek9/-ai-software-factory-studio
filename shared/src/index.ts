// Shared API contract between the orchestration server and the web dashboard.

export const AGENT_ROLES = ['pm', 'architect', 'backend', 'frontend', 'qa', 'security', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_INFO: Record<AgentRole, { name: string; title: string; description: string }> = {
  pm: { name: 'Project Manager', title: 'Planning & coordination', description: 'Breaks the specification into a dependency-aware task plan.' },
  architect: { name: 'Architect', title: 'Architecture & technical decisions', description: 'Produces the technical plan the team implements.' },
  backend: { name: 'Backend', title: 'Java / Spring Boot / Node services', description: 'Implements server-side tasks in an isolated worktree.' },
  frontend: { name: 'Frontend', title: 'React / TypeScript UI', description: 'Implements user-interface tasks in an isolated worktree.' },
  qa: { name: 'QA', title: 'Testing & verification', description: 'Writes tests and runs the real project test command.' },
  security: { name: 'Security', title: 'Security review', description: 'Reviews the integrated diff for vulnerabilities.' },
  reviewer: { name: 'Reviewer', title: 'Final code review', description: 'Gives the final verdict on the integrated change.' },
};

export type ProjectStatus =
  | 'draft' | 'planning' | 'awaiting_approval' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type TaskStatus =
  | 'pending' | 'ready' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export type TaskKind =
  | 'plan' | 'architecture' | 'gate' | 'implement' | 'test' | 'security' | 'review' | 'report'
  /** V2 workflow nodes (Phase 4): `command` runs one allowlisted command, `notify` emits an in-app notification. */
  | 'command' | 'notify';

export type CheckpointStage = 'none' | 'worktree' | 'agent_done' | 'committed' | 'merged';

export type AgentStatus = 'idle' | 'planning' | 'running' | 'blocked' | 'completed' | 'failed';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd: number | null;
}

export interface TestResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  outputTail: string;
  summary: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  spec: string;
  status: ProjectStatus;
  workspaceMode: 'new' | 'import' | 'sample';
  workspacePath: string;
  integrationPath: string | null;
  integrationBranch: string | null;
  baseCommit: string | null;
  testCommand: string;
  planMarkdown: string | null;
  reportMarkdown: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  /** Run this task belongs to (V2 Phase 4, D-009). Task keys are unique per run. */
  runId: string;
  /** Workflow node that produced the task (null for backfilled V1 tasks and runtime fix tasks). */
  nodeId: string | null;
  /** Per-node options compiled from the workflow; `{}` for V1-style tasks. */
  options: TaskNodeOptions;
  key: string;
  title: string;
  description: string;
  role: AgentRole;
  kind: TaskKind;
  status: TaskStatus;
  dependsOn: string[]; // task keys
  orderIndex: number;
  attempt: number;
  maxAttempts: number;
  checkpoint: CheckpointStage;
  branch: string | null;
  worktreePath: string | null;
  providerId: string | null;
  model: string | null;
  resultSummary: string | null;
  error: string | null;
  filesChanged: string[];
  testResult: TestResult | null;
  usage: UsageInfo | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StudioEvent {
  id: number;
  projectId: string | null;
  taskId: string | null;
  role: AgentRole | null;
  type: string;
  level: EventLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type ApprovalKind = 'plan' | 'command' | 'delivery';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: ApprovalKind;
  status: ApprovalStatus;
  title: string;
  details: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AgentMessage {
  id: number;
  projectId: string;
  role: AgentRole;
  taskId: string | null;
  direction: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** '' means "provider default". */
export type EffortLevel = (typeof EFFORT_LEVELS)[number] | '';

export interface AgentConfig {
  role: AgentRole;
  providerId: string;
  model: string;
  allowFallback: boolean;
  effort: EffortLevel;
}

export interface AgentTestResult {
  role: AgentRole;
  providerId: string;
  providerLabel: string;
  requestedModel: string;
  actualModel: string | null;
  effort: EffortLevel;
  effortApplied: boolean;
  ok: boolean;
  answer: string | null;
  correct: boolean | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  error: string | null;
}

export interface AgentView extends AgentConfig {
  name: string;
  title: string;
  status: AgentStatus;
  currentTask: { id: string; title: string; status: TaskStatus } | null;
  tasksTotal: number;
  tasksCompleted: number;
  progress: number; // 0..1, verified completions only
  lastActivity: { message: string; at: string } | null;
  usage: UsageInfo;
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: 'cli' | 'api' | 'builtin';
  editsFiles: boolean;
  enabled: boolean;
  available: boolean;
  version: string | null;
  reason: string | null;
  models: string[];
  defaultModel: string;
  budgetUsd: number | null;
  spentUsd: number;
  /** Set while the provider's usage limit is used up (ISO time it resets). */
  limitedUntil: string | null;
  settings: Record<string, string>; // non-secret settings only
  isAi: boolean;
}

export interface StudioSettings {
  maxParallelTasks: number;
  defaultMaxAttempts: number;
  /** Hard cap for one agent turn, however busy the agent is. */
  taskTimeoutMinutes: number;
  /** Stop an agent only after this many minutes without any activity (output, file edits, log writes). */
  idleTimeoutMinutes: number;
  fallbackOrder: string[];
  /** Automatic fix rounds per project when tests go red or a review says FAIL (0 = off). */
  maxFixRounds: number;
  /** Agent CLI processes allowed at once across task runs and workspace sessions (1–8, ProcessBudget, D-006). */
  maxAgentProcesses: number;
}

export interface ServerInfo {
  version: string;
  host: string;
  port: number;
  authRequired: boolean;
  approvedRoots: string[];
  dataDir: string;
  allowedCommands: string[];
  settings: StudioSettings;
  /** Windows/OS account name of the person running the studio (Home greeting). */
  userName: string;
}

export interface ProjectSnapshot {
  project: Project;
  tasks: Task[];
  agents: AgentView[];
  approvals: Approval[];
  recentEvents: StudioEvent[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  spec: string;
  workspaceMode: 'new' | 'import' | 'sample';
  importPath?: string;
  /**
   * worktree: work on a studio branch inside the existing git repo (your checkout is not touched).
   * copy: copy the folder into a studio workspace (the original folder is never modified). Required for non-git folders.
   */
  importStrategy?: 'worktree' | 'copy';
  sampleName?: string;
  testCommand?: string;
}

/** One agent turn that is executing right now, across all projects. */
export interface LiveAgent {
  taskId: string;
  projectId: string;
  projectName: string;
  role: AgentRole;
  taskKey: string;
  taskTitle: string;
  kind: TaskKind;
  providerId: string | null;
  providerLabel: string | null;
  model: string | null;
  effort: string | null;
  isAi: boolean;
  fallbackFrom: string | null;
  startedAt: string | null;
  attempt: number;
  maxAttempts: number;
  checkpoint: CheckpointStage;
  lastOutput: string | null;
  lastOutputAt: string | null;
}

export interface LiveQueued {
  taskId: string;
  projectId: string;
  projectName: string;
  role: AgentRole;
  taskTitle: string;
  status: TaskStatus;
}

export interface LiveProvider {
  id: string;
  label: string;
  enabled: boolean;
  available: boolean;
  isAi: boolean;
  running: number;
  limitedUntil: string | null;
  callsToday: number;
  tokensToday: number;
  costToday: number;
}

export interface LiveFinished {
  taskId: string;
  projectId: string;
  projectName: string;
  role: AgentRole;
  taskTitle: string;
  status: TaskStatus;
  providerId: string | null;
  model: string | null;
  effort: string | null;
  durationMs: number | null;
  finishedAt: string;
  error: string | null;
}

export interface LiveSnapshot {
  generatedAt: string;
  maxParallel: number;
  running: LiveAgent[];
  queued: LiveQueued[];
  providers: LiveProvider[];
  recent: LiveFinished[];
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  isGitRepo: boolean;
  /** Inside an approved root, so it can be imported. */
  approved: boolean;
  /** Inside a protected location (e.g. other tools' installations) — can never be approved or imported. */
  protected: boolean;
  truncated: boolean;
}

export interface FsRoots {
  drives: string[];
  approvedRoots: string[];
  protectedPaths: string[];
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ------------------------------------------------------------------ V2 read models (/api/v2/*, Phase 2)

/** One pipeline stage of the current project on Home (tasks grouped by role). */
export interface OverviewStage {
  role: AgentRole;
  /** 'none' = the project has no task for this role. */
  status: 'none' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'blocked';
  tasksTotal: number;
  tasksCompleted: number;
  /** Running task, else the first unfinished one, else the last one. */
  currentTask: { id: string; title: string; status: TaskStatus } | null;
  providerId: string | null;
  model: string | null;
  /** Sum of finished attempts' wall time plus the running task's elapsed time, in ms. */
  durationMs: number;
  /** Files changed by the latest completed task of this stage. */
  latestFiles: string[];
  /** Error of the latest failed task of this stage. */
  error: string | null;
}

export interface OverviewAgentHealth {
  role: AgentRole;
  /** disconnected = the assigned provider is disabled or not available. */
  status: 'running' | 'idle' | 'failed' | 'blocked' | 'disconnected';
  currentTask: { id: string; title: string; projectName: string } | null;
  lastActivityAt: string | null;
  providerId: string;
  providerLabel: string | null;
  model: string;
  effort: EffortLevel;
  /** Completed / (completed + failed) tasks of this role finished in the last 7 days; null when none finished. */
  successRate7d: number | null;
  finished7d: number;
}

export interface OverviewProject {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  workspacePath: string;
  integrationBranch: string | null;
  updatedAt: string;
  tasksTotal: number;
  tasksCompleted: number;
  activeAgents: number;
  failedTasks: number;
}

export interface OverviewResponse {
  generatedAt: string;
  projects: { total: number; active: number; createdLast7d: number };
  agents: { running: number; slots: number; queued: number };
  tasks: { open: number; failedLast24h: number; completedLast24h: number };
  approvals: { pending: number };
  /** Only when ?projectId= names an existing project. */
  currentProject: null | {
    id: string; name: string; status: ProjectStatus;
    stages: OverviewStage[];
    progress: { total: number; completed: number; running: number; blocked: number; failed: number };
  };
  agentHealth: OverviewAgentHealth[];
  /** Most recently updated first, at most 6. */
  activeProjects: OverviewProject[];
  /** Same shape as the live monitor, at most 8. */
  recentRuns: LiveFinished[];
}

export interface UsageModelRow {
  providerId: string;
  providerLabel: string | null;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of reported costs; null when no record of this row reported a cost. */
  costUsd: number | null;
}

export interface UsageSummary {
  range: '24h' | '7d';
  from: string;
  to: string;
  totalTokens: number;
  /** Same-length window right before `from`, for the delta on Home. */
  previousTotalTokens: number;
  calls: number;
  costUsd: number | null;
  byModel: UsageModelRow[];
  /** One entry per local day in the range (7 for 7d, 1–2 for 24h), oldest first. */
  byDay: { date: string; totalTokens: number }[];
}

export type HealthState = 'ok' | 'degraded' | 'down';

export interface SystemHealth {
  generatedAt: string;
  overall: HealthState;
  checks: { id: 'api' | 'database' | 'events' | 'providers' | 'git' | 'disk'; label: string; state: HealthState; detail: string }[];
  server: { rssBytes: number; uptimeSec: number; version: string };
  system: { totalMemBytes: number; freeMemBytes: number; cpuPercent: number | null };
  eventClients: number;
}

export interface EventsPage {
  events: StudioEvent[];
  /** Pass as ?before= to load the next (older) page; null when there is no older event. */
  nextBefore: number | null;
}

// ------------------------------------------------------------------ V2 agent sessions (Phase 3, AGENT_WORKSPACE_SPEC.md)

export type SessionMode = 'readonly' | 'edit';
export type SessionStatus = 'idle' | 'queued' | 'running' | 'failed' | 'stopped' | 'closed';
export type SessionContinuity = 'native' | 'replay';

export interface AgentSession {
  id: string;
  projectId: string;
  number: number;
  title: string;
  role: AgentRole;
  providerId: string;
  model: string;
  effort: EffortLevel;
  allowFallback: boolean;
  mode: SessionMode;
  /** integration = the project's integration worktree (read-only); own-worktree = branch asf/<slug>/session-<n>. */
  cwdKind: 'integration' | 'own-worktree';
  branch: string | null;
  worktreePath: string | null;
  continuity: SessionContinuity;
  taskId: string | null;
  status: SessionStatus;
  /** Position in the ProcessBudget queue while status is 'queued'. */
  queuePosition: number | null;
  lastError: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface SessionTurn {
  id: number;
  sessionId: string;
  seq: number;
  author: 'user' | 'agent' | 'system';
  text: string;
  /** Tool activity lines ("Editing src/app.ts"), redacted. */
  activity: string[];
  providerId: string | null;
  modelReported: string | null;
  usage: UsageInfo | null;
  filesChanged: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: 'ok' | 'error' | 'stopped' | 'interrupted' | null;
  error: string | null;
}

export interface CreateSessionInput {
  title?: string;
  role: AgentRole;
  providerId: string;
  model: string;
  effort: EffortLevel;
  mode: SessionMode;
  taskId?: string | null;
}

export interface ProcessBudgetOwner {
  kind: 'task' | 'session';
  id: string;
  projectId: string;
  label: string;
}

export interface ProcessBudgetSnapshot {
  limit: number;
  running: ProcessBudgetOwner[];
  queued: (ProcessBudgetOwner & { position: number; since: string })[];
}

/** Saved multi-panel layout of a project's workspace (AGENT_WORKSPACE_SPEC.md §9). */
export type WorkspaceLayoutNode =
  | { type: 'panel'; id: string }
  | { type: 'split'; dir: 'row' | 'col'; sizes: number[]; children: WorkspaceLayoutNode[] };

export type WorkspacePanelTab = 'chat' | 'activity' | 'changes' | 'files' | 'output' | 'task' | 'terminal';

export interface WorkspaceLayout {
  version: 1;
  preset: 1 | 2 | 3 | 4 | 5 | 6 | 8 | 'custom';
  root: WorkspaceLayoutNode;
  panels: Record<string, { sessionId: string | null; tab: WorkspacePanelTab; kind: 'session' | 'orchestrator' }>;
  maximized: string | null;
  minimized: string[];
  recentlyClosed: { sessionId: string; title: string; closedAt: string }[];
  drawer: { open: boolean; tab: 'coordination' | 'context' | 'artifacts'; width: number };
}

// ------------------------------------------------------------------ V2 workflows and runs (Phase 4, WORKFLOW_ENGINE_SPEC.md)

/** Options a workflow node compiles onto its task row (JSON column `tasks.options`; `{}` for V1 tasks). */
export interface TaskNodeOptions {
  /** Agent overrides; absent = the role's AgentConfig. */
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  /** Task-level hard cap in minutes; absent = setting taskTimeoutMinutes. */
  timeoutMinutes?: number;
  /** 'continue' lets dependants run after a failure (not allowed on verification tasks). */
  onFailure?: 'stop' | 'continue';
  /** Fix-loop rounds for this verification task (0–5); absent = setting maxFixRounds. */
  fixRoundsMax?: number;
  /** Who fixes a failed verification; 'auto' (default) = V1 fixRoleFor(). */
  fixRole?: 'auto' | 'backend' | 'frontend';
  /** `command` tasks: the one command to run in the integration worktree; `test` tasks: test-command override (qa node). */
  command?: string;
  /** `notify` tasks: message template ({{project}}, {{run}}, {{status}}). */
  message?: string;
  /** decompose (`plan`) tasks: add V1's qa-verify task when the PM planned no QA task (default true). */
  requireQa?: boolean;
}

export const WORKFLOW_NODE_TYPES = [
  'trigger', 'requirement', 'architect', 'decompose', 'backend', 'frontend', 'qa', 'security', 'reviewer',
  'approval', 'quality-gate', 'fix', 'retry', 'tool', 'artifact', 'notify',
  // planned: visible in the palette, disabled with a reason
  'delay', 'deploy', 'condition', 'notify-external',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export type WorkflowHandle = 'out' | 'pass' | 'fail';

export interface WorkflowNode {
  /** [a-z0-9-]{1,40}; becomes the task key (the Standard template uses the V1 keys). */
  id: string;
  type: WorkflowNodeType;
  label?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  /** Absent = 'out'. 'pass'/'fail' only on quality gates. */
  sourceHandle?: WorkflowHandle;
  target: string;
  /** 'retry' only for fix → verification back edges. Absent = 'normal'. */
  kind?: 'normal' | 'retry';
}

export interface WorkflowGraph {
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const WORKFLOW_LIMITS = {
  maxNodes: 60, maxEdges: 120, maxGraphBytes: 200_000, maxLabel: 80, maxDescription: 2000, maxFixRounds: 5, maxAttempts: 5,
} as const;

/** Id of the built-in, read-only "Standard Software Factory" template (compiles to the V1 graph). */
export const STANDARD_WORKFLOW_ID = 'wf-standard';

export interface WorkflowSummary {
  id: string;
  /** null = global template. */
  projectId: string | null;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  archived: boolean;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Workflow extends WorkflowSummary {
  graph: WorkflowGraph;
}

export interface SaveWorkflowInput {
  name: string;
  description?: string;
  /** Used on create only (null = global); PUT keeps the stored project. */
  projectId?: string | null;
  graph: WorkflowGraph;
}

export type CatalogFieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'provider' | 'model' | 'effort';

export interface CatalogField {
  key: string;
  label: string;
  type: CatalogFieldType;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  help?: string;
}

export type NodeCategory = 'trigger' | 'input' | 'agent' | 'control' | 'tool' | 'output';

export interface NodeCatalogEntry {
  type: WorkflowNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  executable: boolean;
  /** Why a planned node cannot run yet (null when executable). */
  plannedReason: string | null;
  /** Agent role the node runs as, if any. */
  role: AgentRole | null;
  /** Whether the node accepts incoming edges, and its output handles. */
  handles: { input: boolean; outputs: WorkflowHandle[] };
  fields: CatalogField[];
}

export type WorkflowIssueCode =
  | 'E_TRIGGER' | 'E_UNREACHABLE' | 'E_PLANNED' | 'E_CYCLE' | 'E_HANDLE' | 'E_FIX_TARGET' | 'E_SLOT'
  | 'E_PROVIDER' | 'E_COMMAND' | 'E_LIMIT' | 'E_CONFIG' | 'E_EDGE';

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  /** true when there are no errors (warnings do not block a run). */
  ok: boolean;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
}

/** One task row the compiler produces. */
export interface CompiledTask {
  key: string;
  title: string;
  description: string;
  role: AgentRole;
  kind: TaskKind;
  dependsOn: string[];
  orderIndex: number;
  maxAttempts: number;
  nodeId: string | null;
  options: TaskNodeOptions;
}

/** Placeholder in a skeleton tail task's dependsOn: replaced at expansion time by the PM tasks' leaf keys. */
export const SLOT_DEPENDENCY = '@slots';

/**
 * How the PM's tasks are placed when the graph has a `decompose` node (WORKFLOW_ENGINE_SPEC.md §6.3). The tail is
 * inserted by expandPlan after the PM plan is known, together with the PM tasks.
 */
export interface CompiledSkeleton {
  /** Key of the decompose (`plan`) task; null when the graph has no decompose node. */
  decomposeKey: string | null;
  /** Key PM tasks without dependencies depend on (Standard: 'plan-approval'). */
  entryKey: string | null;
  /** Implementation slots: PM tasks with that role get the slot's options. */
  slots: { nodeId: string; role: 'backend' | 'frontend'; options: TaskNodeOptions }[];
  /** Tasks inserted after the PM tasks (Standard: security-review, final-review, delivery-report). */
  tail: CompiledTask[];
  /** Add V1's qa-verify task when the PM planned no QA task. */
  requireQa: boolean;
  /** Options for the qa-verify task (from the qa node), when one exists. */
  qaOptions: TaskNodeOptions | null;
}

export interface CompiledRun {
  /** Tasks inserted when the run starts. */
  tasks: CompiledTask[];
  skeleton: CompiledSkeleton;
  notes: string[];
}

export interface SimulationResult {
  validation: ValidationResult;
  /** Start tasks followed by the skeleton tail; empty when validation failed. */
  tasks: CompiledTask[];
  notes: string[];
}

export type RunStatus =
  | 'planning' | 'awaiting_approval' | 'running' | 'paused' | 'completed' | 'completed_with_failures' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  number: number;
  workflowId: string | null;
  workflowName: string;
  workflowVersion: number | null;
  status: RunStatus;
  trigger: 'manual' | 'backfill';
  baseCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
  durationMs: number | null;
  /** Sum of measured usage_records cost of the run's tasks; null when no provider reported cost. */
  costUsd: number | null;
  tasksTotal: number;
  tasksCompleted: number;
}

export interface RunsPage {
  runs: Run[];
  /** Pass as `before` (a run number) for the next page; null at the end. */
  nextBefore: number | null;
}

/** Runs of every project, newest start first (`GET /api/v2/runs`, Runs page). */
export interface RunsListPage {
  runs: Run[];
  /** Pass as `before` (a run's startedAt) for the next page; null at the end. */
  nextBefore: string | null;
}

export interface RunNodeStatus {
  nodeId: string;
  taskKeys: string[];
  status: TaskStatus | 'not_started';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  attempts: number;
  providerId: string | null;
  model: string | null;
  costUsd: number | null;
  error: string | null;
}

export interface RunTimelineEntry {
  id: number;
  at: string;
  type: string;
  level: EventLevel;
  message: string;
  taskId: string | null;
  nodeId: string | null;
}

export interface RunTimeline {
  run: Run;
  graph: WorkflowGraph;
  nodes: RunNodeStatus[];
  tasks: Task[];
  entries: RunTimelineEntry[];
}

export interface StartRunInput {
  workflowId: string;
}

// ------------------------------------------------------------------ V2 projects, tasks, repos (Phase 5, UI_SCREEN_SPECIFICATIONS.md §4, §5, §7)

/** A task row across projects for the Tasks board/list (`GET /api/v2/tasks`). */
export interface TaskRow extends Task {
  projectName: string;
  runNumber: number | null;
  /** finishedAt − startedAt, or now − startedAt while running; null when never started. */
  durationMs: number | null;
}

export interface TaskQuery {
  projectId?: string;
  /** 'active' = each project's current run (default), 'all' = every run, or a run id. */
  runId?: string;
  role?: AgentRole;
  status?: TaskStatus;
  q?: string;
  limit?: number;
}

export interface TasksResponse {
  tasks: TaskRow[];
  /** True when more rows matched than `limit` (default 500, max 2000). */
  truncated: boolean;
}

/** `GET /api/v2/tasks/:id` — everything the task drawer shows. */
export interface TaskDetail {
  task: TaskRow;
  run: Run | null;
  /** The task's events, newest last (max 300). */
  events: StudioEvent[];
  /** Fix rounds of a verification task (null for other kinds). */
  fixRounds: { used: number; max: number } | null;
  /** Review/verification text the agent returned (security/review tasks), when stored. */
  reviewText: string | null;
}

/** `GET /api/v2/tasks/:id/diff` — the task's committed change. */
export interface TaskDiff {
  taskId: string;
  /** Commit range the diff covers (`base..head`), null when the task has no commits. */
  base: string | null;
  head: string | null;
  files: string[];
  /** Unified diff, sensitive files (.env, keys) omitted; ≤ 300 KB. */
  diff: string;
  truncated: boolean;
  /** Why the diff is empty or partial ("branch removed", "no commits", "omitted 1 sensitive file"…). */
  note: string | null;
}

export type RepoBranchKind = 'integration' | 'task' | 'session' | 'partial' | 'other';

export interface RepoOwner {
  type: 'task' | 'session';
  id: string;
  title: string;
  status: string;
}

export interface RepoBranch {
  name: string;
  kind: RepoBranchKind;
  head: string;
  /** Commits ahead of / behind the integration branch (null for the integration branch itself). */
  ahead: number | null;
  behind: number | null;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  owner: RepoOwner | null;
}

export interface RepoWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  owner: RepoOwner | null;
  /** Folder modification time. */
  modifiedAt: string | null;
}

export interface RepoWipCommit {
  branch: string;
  sha: string;
  subject: string;
  at: string;
}

export interface RepoConflict {
  at: string;
  message: string;
  taskId: string | null;
}

/** `GET /api/v2/projects/:id/repo` — read-only git overview of one project. */
export interface RepoOverview {
  projectId: string;
  workspacePath: string;
  integrationPath: string | null;
  integrationBranch: string | null;
  integrationHead: string | null;
  baseCommit: string | null;
  branches: RepoBranch[];
  worktrees: RepoWorktree[];
  wipCommits: RepoWipCommit[];
  conflicts: RepoConflict[];
  /** Set when git could not be read (missing folder, not a repository). */
  error: string | null;
}

// ------------------------------------------------------------------ V2 quality, logs, usage (Phase 6, UI_SCREEN_SPECIFICATIONS.md §8–§10, D-016)

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingSource = 'security' | 'review' | 'audit';
export type FindingStatus = 'open' | 'accepted' | 'false_positive' | 'fix_planned' | 'fixed';

/** One structured finding (security/review agent output or `npm audit`). */
export interface Finding {
  id: string;
  projectId: string;
  runId: string | null;
  /** Task whose output produced it (security/review), null for audits. */
  taskId: string | null;
  source: FindingSource;
  severity: FindingSeverity;
  title: string;
  file: string | null;
  line: number | null;
  description: string;
  recommendation: string | null;
  status: FindingStatus;
  note: string | null;
  /** Fix task created from this finding. */
  fixTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FindingQuery {
  projectId?: string;
  runId?: string;
  severity?: FindingSeverity;
  source?: FindingSource;
  status?: FindingStatus;
  q?: string;
  limit?: number;
}

export interface FindingsResponse {
  findings: Finding[];
  /** Counts over the same filter without severity (for the counter strip). */
  counts: Record<FindingSeverity, number>;
  truncated: boolean;
}

export interface UpdateFindingInput {
  status: 'open' | 'accepted' | 'false_positive';
  note?: string | null;
}

export type GateState = 'passed' | 'failed' | 'error' | 'not_run';
export type QualityGateId = 'build' | 'tests' | 'security' | 'review' | 'audit' | 'coverage';

export interface QualityGate {
  id: QualityGateId;
  label: string;
  state: GateState;
  /** What the state is based on ("api-tests: 12 passed", "no build step in this run"). */
  detail: string;
  /** Task or audit the state comes from. */
  taskId: string | null;
  at: string | null;
}

/** Release readiness of one run: ready only when every gate passed (not_run is never a pass, D-016). */
export interface ReleaseReadiness {
  runId: string;
  runNumber: number;
  gates: QualityGate[];
  ready: boolean;
  /** Open findings with severity critical or high. */
  blockingFindings: number;
}

export interface TestRunRow {
  taskId: string;
  taskKey: string;
  title: string;
  runId: string;
  result: TestResult;
  finishedAt: string | null;
}

export interface ScannerInfo {
  id: 'tests' | 'security-agent' | 'review-agent' | 'npm-audit' | 'guardian';
  label: string;
  /** Detected/usable on this machine and project. */
  available: boolean;
  /** Version string when known (npm version for npm-audit). */
  version: string | null;
  lastRunAt: string | null;
  /** Why it is unavailable, or how it runs ("runs with each QA task", "needs your approval — network access"). */
  note: string;
}

/** `GET /api/v2/projects/:id/quality?runId=` */
export interface QualityOverview {
  projectId: string;
  readiness: ReleaseReadiness | null;
  testRuns: TestRunRow[];
  scanners: ScannerInfo[];
  /** Audit waiting for approval (approval id), if one was requested. */
  pendingAuditApprovalId: string | null;
}

export interface LogQuery {
  projectId?: string;
  runId?: string;
  sessionId?: string;
  taskId?: string;
  role?: AgentRole;
  level?: EventLevel;
  /** Exact type, or a prefix ending in '.*' ("task.*"). */
  type?: string;
  /** Case-insensitive search in message (server side). */
  q?: string;
  /** ISO times, inclusive. */
  from?: string;
  to?: string;
  before?: number;
  limit?: number;
}

/** One row of usage analytics (`GET /api/v2/usage/daily?days=&projectId=`), grouped by day × provider × model × project. */
export interface UsageDailyRow {
  /** YYYY-MM-DD (server local time). */
  day: string;
  providerId: string;
  model: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  outputTokens: number;
  /** null when no record of the group reported a cost. */
  costUsd: number | null;
  calls: number;
}

export interface UsageDailyResponse {
  days: number;
  rows: UsageDailyRow[];
}
