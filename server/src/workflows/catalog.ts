import {
  EFFORT_LEVELS, WORKFLOW_LIMITS, type AgentRole, type CatalogField, type EffortLevel, type NodeCatalogEntry, type NodeCategory,
  type TaskNodeOptions, type WorkflowHandle, type WorkflowNode, type WorkflowNodeType,
} from '@asf/shared';

// Node catalog served by GET /api/v2/workflows/catalog (WORKFLOW_ENGINE_SPEC.md §5). The inspector form, the validator
// and the compiler all read the per-type config fields from here, so there is one definition of every option.

const ON_FAILURE: CatalogField = {
  key: 'onFailure', label: 'On failure', type: 'select', default: 'stop', options: [
    { value: 'stop', label: 'Stop: dependants are blocked' },
    { value: 'continue', label: 'Continue: dependants run, the run ends with failures' },
  ],
};

/** Agent overrides. Verification nodes (QA/Security/Reviewer) get no `onFailure`: their failure must stop the run. */
function agentFields(withOnFailure: boolean): CatalogField[] {
  const fields: CatalogField[] = [
    { key: 'providerId', label: 'Agent provider', type: 'provider', help: 'Empty = the provider configured for this role.' },
    { key: 'model', label: 'Model', type: 'model', help: 'Empty = the model configured for this role.' },
    { key: 'effort', label: 'Reasoning effort', type: 'effort', help: 'Empty = the effort configured for this role.' },
    { key: 'timeoutMinutes', label: 'Timeout (minutes)', type: 'number', min: 5, max: 480, help: 'Empty = the "Task timeout" setting.' },
    { key: 'maxAttempts', label: 'Max attempts', type: 'number', min: 1, max: WORKFLOW_LIMITS.maxAttempts,
      help: 'Empty = the "Default max attempts" setting.' },
  ];
  return withOnFailure ? [...fields, ON_FAILURE] : fields;
}

const slotFields = (role: 'backend' | 'frontend'): CatalogField[] => [
  { key: 'title', label: 'Task title', type: 'text', help: `Used only without a Task decomposition node (one ${role} task).` },
  { key: 'description', label: 'Task description', type: 'textarea', help: 'Used only without a Task decomposition node.' },
  ...agentFields(true),
];

interface EntryExtra {
  input?: boolean;
  outputs?: WorkflowHandle[];
  plannedReason?: string;
}

function entry(type: WorkflowNodeType, label: string, category: NodeCategory, description: string, role: AgentRole | null,
  fields: CatalogField[], extra: EntryExtra = {}): NodeCatalogEntry {
  return {
    type, label, category, description, role, fields,
    executable: !extra.plannedReason,
    plannedReason: extra.plannedReason ?? null,
    handles: { input: extra.input ?? true, outputs: extra.outputs ?? ['out'] },
  };
}

export const NODE_CATALOG: NodeCatalogEntry[] = [
  entry('trigger', 'Start', 'trigger', 'Starts the run when you press Run.', null, [
    { key: 'mode', label: 'Start mode', type: 'select', default: 'manual', options: [
      { value: 'manual', label: 'Manual (Run button)' },
      { value: 'schedule', label: 'Schedule (planned)' },
      { value: 'webhook', label: 'Webhook (planned)' },
    ], help: 'Schedule and webhook triggers need a scheduler service; not in V2.0.' },
  ], { input: false }),
  entry('requirement', 'Requirement', 'input', 'The project specification is the input of the run.', null, [
    { key: 'source', label: 'Source', type: 'select', default: 'project-spec', options: [
      { value: 'project-spec', label: 'Project specification' },
      { value: 'override', label: 'Custom text for this workflow' },
    ] },
    { key: 'specOverride', label: 'Specification override', type: 'textarea', help: 'Used only when the source is custom text (max 50 KB).' },
  ]),
  entry('architect', 'Architect', 'agent', 'Writes the technical implementation plan.', 'architect', agentFields(true)),
  entry('decompose', 'Task decomposition', 'agent',
    'The PM breaks the specification into Backend/Frontend/QA tasks that fill the slots after it.', 'pm', [
      ...agentFields(true),
      { key: 'requireQa', label: 'Require a QA step', type: 'boolean', default: true,
        help: 'Adds a QA verification task when the PM plans none.' },
    ]),
  entry('backend', 'Backend', 'agent', 'Backend implementation: the PM\'s backend tasks, or one task without decomposition.',
    'backend', slotFields('backend')),
  entry('frontend', 'Frontend', 'agent', 'Frontend implementation: the PM\'s frontend tasks, or one task without decomposition.',
    'frontend', slotFields('frontend')),
  entry('qa', 'QA verification', 'agent', 'Writes tests and runs the project test command.', 'qa', [
    { key: 'testCommand', label: 'Test command', type: 'text',
      help: 'Empty = the project test command. Commands outside the allowlist need your approval at run time.' },
    ...agentFields(false),
  ]),
  entry('security', 'Security review', 'agent', 'Reviews the integrated diff for vulnerabilities.', 'security', agentFields(false)),
  entry('reviewer', 'Code review', 'agent', 'Final review of correctness, quality and spec adherence.', 'reviewer', agentFields(false)),
  entry('approval', 'Approval', 'control', 'Pauses the run until you approve.', 'pm', [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'instructions', label: 'Instructions', type: 'textarea', help: 'What the approver should check.' },
  ]),
  entry('quality-gate', 'Quality gate', 'control',
    'Routes a failed QA/Security/Review verdict to a Fix node, up to the round limit.', null, [
      { key: 'maxRounds', label: 'Max fix rounds', type: 'number', min: 0, max: WORKFLOW_LIMITS.maxFixRounds,
        help: 'Empty = the "Max fix rounds" setting.' },
    ], { outputs: ['pass', 'fail'] }),
  entry('fix', 'Fix', 'control', 'Fixes what the verification found, then the verification runs again.', null, [
    { key: 'role', label: 'Fixed by', type: 'select', default: 'auto', options: [
      { value: 'auto', label: 'Automatic (from the failure)' },
      { value: 'backend', label: 'Backend agent' },
      { value: 'frontend', label: 'Frontend agent' },
    ] },
  ]),
  entry('retry', 'Retry', 'control', 'Sets how many attempts the step before it gets.', null, [
    { key: 'maxAttempts', label: 'Max attempts', type: 'number', min: 1, max: WORKFLOW_LIMITS.maxAttempts },
  ]),
  entry('tool', 'Run command', 'tool', 'Runs one command in the integration worktree.', 'qa', [
    { key: 'command', label: 'Command', type: 'text', help: 'Commands outside the allowlist need your approval at run time.' },
    { key: 'timeoutMinutes', label: 'Timeout (minutes)', type: 'number', min: 5, max: 480 },
  ]),
  // No file-name field: the V1 report runner writes a fixed file, and a field that changes nothing would mislead.
  entry('artifact', 'Delivery report', 'output', 'Generates the implementation report.', 'pm', []),
  entry('notify', 'Notification', 'output', 'Shows an in-app notification.', 'pm', [
    { key: 'message', label: 'Message', type: 'textarea', default: '{{project}}: run {{run}} is {{status}}',
      help: 'Placeholders: {{project}}, {{run}}, {{status}}.' },
  ]),
  entry('delay', 'Delay', 'control', 'Waits before the next step.', null, [],
    { plannedReason: 'Timers that survive restarts are not built yet' }),
  entry('deploy', 'Deploy', 'output', 'Deploys or pushes the result.', null, [],
    { plannedReason: 'The studio never deploys or pushes (security rule)' }),
  entry('condition', 'Condition', 'control', 'Branches on an expression.', null, [],
    { plannedReason: 'Only verification verdicts can be evaluated truthfully' }),
  entry('notify-external', 'External notification', 'output', 'Sends a Slack or email message.', null, [],
    { plannedReason: 'Needs credentials and an outbound integration' }),
];

const BY_TYPE = new Map(NODE_CATALOG.map((e) => [e.type, e]));

export function catalogEntry(type: WorkflowNodeType): NodeCatalogEntry {
  const found = BY_TYPE.get(type);
  if (!found) throw new Error(`Unknown workflow node type: ${type}`);
  return found;
}

// ------------------------------------------------------------------ field values

const TEXT_LIMITS: Record<string, number> = {
  providerId: 60, model: 120, title: 160, testCommand: 300, command: 300, fileName: 80, specOverride: 50_000,
};
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt)$/;

export const textLimit = (key: string): number => TEXT_LIMITS[key] ?? WORKFLOW_LIMITS.maxDescription;

export interface FieldProblem {
  code: 'E_CONFIG' | 'E_LIMIT';
  message: string;
}

/** Checks one config value against its field; absent (undefined/null) values are always fine. */
export function checkFieldValue(field: CatalogField, value: unknown): FieldProblem | null {
  if (value === undefined || value === null) return null;
  const bad = (message: string): FieldProblem => ({ code: 'E_CONFIG', message: `${field.label}: ${message}` });
  switch (field.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad('must be a whole number');
      if (value < (field.min ?? -Infinity) || value > (field.max ?? Infinity)) return bad(`must be between ${field.min} and ${field.max}`);
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : bad('must be true or false');
    case 'select':
      return typeof value === 'string' && (field.options ?? []).some((o) => o.value === value)
        ? null : bad(`must be one of ${(field.options ?? []).map((o) => o.value).join(', ')}`);
    case 'effort':
      return value === '' || (EFFORT_LEVELS as readonly unknown[]).includes(value) ? null : bad(`must be one of ${EFFORT_LEVELS.join(', ')}`);
    default: {
      if (typeof value !== 'string') return bad('must be text');
      const max = textLimit(field.key);
      if (value.length > max) return { code: 'E_LIMIT', message: `${field.label}: at most ${max} characters` };
      if (field.key === 'fileName' && value && !FILE_NAME.test(value)) return bad('use a plain file name ending in .md or .txt');
      return null;
    }
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

/** The node's config reduced to its catalog fields: invalid values dropped, numbers rounded and clamped. */
export function readNodeConfig(node: WorkflowNode): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of BY_TYPE.get(node.type)?.fields ?? []) {
    const value = node.config?.[field.key];
    if (field.type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) values[field.key] = clamp(value, field.min ?? 0, field.max ?? Number.MAX_SAFE_INTEGER);
    } else if (value !== undefined && value !== null && !checkFieldValue(field, value)) {
      values[field.key] = value;
    }
  }
  return values;
}

/** Trimmed non-empty text, or undefined. */
export function configText(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Task options a node compiles to (validated/clamped values only; absent = setting/role default). */
export function nodeOptionsFromConfig(node: WorkflowNode): TaskNodeOptions {
  const values = readNodeConfig(node);
  const options: TaskNodeOptions = {};
  const providerId = configText(values, 'providerId');
  const model = configText(values, 'model');
  const effort = configText(values, 'effort');
  if (providerId) options.providerId = providerId;
  if (model) options.model = model;
  if (effort) options.effort = effort as EffortLevel;
  const { timeoutMinutes, onFailure, maxRounds, role, requireQa } = values;
  if (typeof timeoutMinutes === 'number') options.timeoutMinutes = timeoutMinutes;
  if (onFailure === 'stop' || onFailure === 'continue') options.onFailure = onFailure;
  if (typeof maxRounds === 'number') options.fixRoundsMax = maxRounds;
  if (node.type === 'fix' && (role === 'auto' || role === 'backend' || role === 'frontend')) options.fixRole = role;
  const command = configText(values, node.type === 'qa' ? 'testCommand' : 'command');
  if (command) options.command = command;
  const message = configText(values, 'message');
  if (message) options.message = message;
  if (typeof requireQa === 'boolean') options.requireQa = requireQa;
  return options;
}

/** The node's own `maxAttempts` (agent and retry nodes), clamped to 1–5; undefined = setting. */
export function nodeMaxAttempts(node: WorkflowNode): number | undefined {
  const value = readNodeConfig(node).maxAttempts;
  return typeof value === 'number' ? value : undefined;
}
