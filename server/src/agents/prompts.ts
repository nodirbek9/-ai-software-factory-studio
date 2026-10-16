import type { AgentRole, Project, Task } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';

export const ROLE_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  pm: 'You are the Project Manager agent. You split specifications into small, verifiable, dependency-aware tasks. You do not write code.',
  architect: 'You are the Architect agent. You make concise, concrete technical decisions: structure, modules, data model, APIs, testing approach.',
  backend: 'You are the Backend agent. You implement server-side code (Java/Spring Boot or Node.js as the project dictates) with tests, following the approved plan.',
  frontend: 'You are the Frontend agent. You implement React/TypeScript or plain web UI following the approved plan. Keep components small and accessible.',
  qa: 'You are the QA agent. You write focused automated tests that verify the specification and make the project test command meaningful.',
  security: 'You are the Security agent. You review code changes for vulnerabilities (injection, XSS, path traversal, secrets, authz, unsafe deserialization).',
  reviewer: 'You are the Reviewer agent. You give the final code-review verdict on correctness, readability and adherence to the plan.',
};

const MAX_SPEC = 20_000;
const MAX_PLAN = 12_000;

const clip = (text: string | null, max: number): string => (!text ? '' : text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text);

export function planPrompt(project: Project): string {
  return `Create the implementation task list for this project.

# Specification
${clip(project.spec, MAX_SPEC)}

# Output format
Reply with ONLY one JSON object, no prose, in this shape:
{"tasks":[{"key":"kebab-case-id","title":"short title","description":"what exactly to build and how it is verified","role":"backend|frontend|qa","dependsOn":["other-key"]}]}

Rules:
- 2 to 10 tasks, each finishable by one engineer in under an hour.
- role is one of backend, frontend, qa. Security review, final review and reporting are added automatically — do not include them.
- dependsOn only references keys from this list; tasks without dependencies can run in parallel.
- The project test command is: ${project.testCommand}`;
}

export function architecturePrompt(project: Project, tasks: Task[]): string {
  const list = tasks.map((t) => `- [${t.role}] ${t.key}: ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('\n');
  return `Write the technical implementation plan (Markdown) for this project. Inspect the existing files in the current directory first if there are any.

# Specification
${clip(project.spec, MAX_SPEC)}

# Planned tasks
${list}

Cover: architecture overview, modules/files to create, data model, API/interfaces, testing strategy (test command: ${project.testCommand}), risks.
Reply with the Markdown document only.`;
}

export const FILE_PROTOCOL = `Reply with ONLY one JSON object, no prose, in this shape:
{"summary":"one paragraph describing what you changed","files":[{"path":"relative/path.ext","content":"FULL new file content"}]}
Paths are relative to the project root. Always send complete file contents, never diffs.`;

export function implementPrompt(project: Project, task: Task, editsFiles: boolean): string {
  const role = AGENT_ROLE_INFO[task.role].name;
  return `You are implementing one task of an approved plan as the ${role} agent.

# Task ${task.key}: ${task.title}
${task.description}

# Specification
${clip(project.spec, MAX_SPEC)}

# Approved technical plan
${clip(project.planMarkdown, MAX_PLAN)}

Work only on this task. Keep the project's existing conventions. The project test command is: ${project.testCommand}
${editsFiles ? 'Edit the files in the current directory directly. When done, reply with a short summary of what you changed.' : FILE_PROTOCOL}`;
}

export function testPrompt(project: Project, task: Task, editsFiles: boolean): string {
  return `As the QA agent, make sure the project's automated tests verify the specification.

# Task ${task.key}: ${task.title}
${task.description}

# Specification
${clip(project.spec, MAX_SPEC)}

Add or improve tests so that \`${project.testCommand}\` exercises the implemented behaviour. Do not weaken existing tests.
The studio will run \`${project.testCommand}\` itself after your change; you do not run it.
${editsFiles ? 'Edit the files directly. When done, reply with a short summary.' : FILE_PROTOCOL}`;
}

export type FailureSource = 'tests' | 'review';

const MAX_FINDINGS = 8000;

/** Description of a Backend fix task created by the fix loop; implementPrompt() carries it to the agent. */
export function fixTaskDescription(failed: Task, source: FailureSource, findings: string, round: number): string {
  const what = source === 'tests'
    ? `The automated tests run by "${failed.title}" (${failed.key}) failed. Fix the implementation so they pass. Do not weaken or delete tests unless a test is clearly wrong.`
    : `The ${AGENT_ROLE_INFO[failed.role].name} agent rejected the integrated change in "${failed.title}" (${failed.key}). Fix every CRITICAL/HIGH finding below.`;
  return `Fix round ${round}. ${what}
After this fix merges, "${failed.key}" runs again automatically.

# ${source === 'tests' ? 'Test output' : 'Review findings'}
${clip(findings, MAX_FINDINGS)}`;
}

export function reviewPrompt(project: Project, task: Task, diff: string, testSummary: string): string {
  const focus = task.role === 'security'
    ? 'Review this change for security vulnerabilities. Severity levels: CRITICAL, HIGH, MEDIUM, LOW.'
    : 'Review this change for correctness, readability, tests and adherence to the specification.';
  return `${focus}

# Specification
${clip(project.spec, 6000)}

# Test result
${testSummary}

# Diff of the integrated change
\`\`\`diff
${diff}
\`\`\`

Reply in Markdown: findings with file references, then a final line exactly "VERDICT: PASS" or "VERDICT: FAIL".
Use FAIL only for CRITICAL/HIGH problems that must be fixed before delivery.`;
}

export function chatPrompt(project: Project, role: AgentRole, history: { direction: string; content: string }[], message: string, context: string): string {
  const transcript = history.slice(-10).map((m) => `${m.direction === 'user' ? 'User' : 'Agent'}: ${m.content}`).join('\n');
  return `You are the ${AGENT_ROLE_INFO[role].name} agent of project "${project.name}". Answer the user's question about the project.
You cannot run commands or change files from chat; if the user asks for changes, explain which task should do it.

# Current project state
${context}

# Conversation so far
${transcript}

User: ${message}`;
}

export const RESUME_NOTE = `NOTE: A previous attempt at this task was interrupted (time limit, usage limit or restart) after doing part of the work.
Its changes are already in the current directory. Review what exists, keep what is correct, and finish the remaining work —
do not start over and do not delete good work.`;

export function conflictPrompt(task: Task, files: string[]): string {
  return `While you worked on task "${task.title}", other agents finished and changed some of the same files.
Their work has now been merged into your working tree and git reports conflicts in these files:
${files.map((f) => `- ${f}`).join('\n')}

Resolve every conflict: open each file, remove all conflict markers (<<<<<<<, =======, >>>>>>>) and produce one version
that keeps the intent of BOTH sides (your task's changes and the other agents' changes). Do not drop either side's
features, endpoints, docs sections or tests unless they are true duplicates. Change nothing else.
When done, reply with a one-paragraph summary of how you resolved each file.`;
}
