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

export type TaskKind = 'plan' | 'architecture' | 'gate' | 'implement' | 'test' | 'security' | 'review' | 'report';

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
