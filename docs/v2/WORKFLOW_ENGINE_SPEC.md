# Workflow Engine Spec — workflows, runs, compiler (Phase 4)

Implements `V2_ARCHITECTURE.md` §3.3 and decisions D-008, D-009 (revised 2026-10-16), D-010. One execution
engine: the V1 `TaskScheduler` (`server/src/orchestrator/scheduler.ts`). A workflow is a stored graph that is
**compiled into V1 task rows**; the scheduler, runners, checkpoints, recovery and fix loop run them unchanged.

## 1. What V1 does today (facts the design depends on)

| Fact | Evidence |
|---|---|
| Planning creates 3 fixed tasks `plan` → `architecture` → `plan-approval` (gate) only when the project is `draft`. | `orchestrator/projectService.ts:61-77` |
| The PM's JSON plan is expanded at runtime: PM tasks (default dependency = the gate), `qa-verify` if the PM planned no QA task, then the fixed tail `security-review` → `final-review` → `delivery-report`. Reserved keys are rejected. | `orchestrator/taskRunners.ts:113-160` |
| Runner per task kind: `plan, architecture, implement, test, security, review, report`; `gate` is completed by an approval. | `taskRunners.ts:390-398`, `projectService.ts:80-101` |
| The fix loop inserts `fix-<key>-<round>` before a failed verification task; budget per verification task in setting `fixRounds:<projectId>:<taskKey>`; a re-run after a fix is detected by a dependency starting with `fix-<key>-`. | `orchestrator/fixLoop.ts:15-68`, `taskRunners.ts:281` |
| The scheduler, gate, status derivation, "plan already expanded" check, architecture prompt, test summary and review diff all read **every task of the project**. | `scheduler.ts:84-88,120,129-138,154`, `taskRunners.ts:177,343,362` |
| Review diff is `baseCommit..HEAD` of the integration worktree; `baseCommit` is set once at project creation. | `taskRunners.ts:362`, `projectService.ts:55-57` |
| `tasks` has `UNIQUE(project_id, key)`; nothing references `tasks.id` with a foreign key. | `db/database.ts:22-48,63-108` |

Consequence: a second pipeline in the same project needs **run scoping** in exactly those places. Key
prefixes alone would not be enough (status derivation and the plan-skip check would still see old runs).

## 2. Data model (migration v6 in `MIGRATION_PLAN.md`, additive except the `tasks` rebuild)

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = global template
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  graph TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, workflow_id TEXT, workflow_version INTEGER, workflow_snapshot TEXT NOT NULL,
  status TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'manual', base_commit TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, error_summary TEXT, UNIQUE(project_id, number));
CREATE INDEX idx_runs_project ON runs(project_id, number);
-- tasks rebuild (D-009 revised): same columns + run_id, node_id; uniqueness per run
CREATE TABLE tasks_v3 ( …all V1 columns…, run_id TEXT NOT NULL, node_id TEXT, UNIQUE(run_id, key));
INSERT INTO tasks_v3 SELECT …, 'run-' || project_id, NULL FROM tasks;   -- after inserting one run per project
DROP TABLE tasks; ALTER TABLE tasks_v3 RENAME TO tasks;
CREATE INDEX idx_tasks_project ON tasks(project_id, status); CREATE INDEX idx_tasks_run ON tasks(run_id, status);
ALTER TABLE usage_records ADD COLUMN run_id TEXT;   -- session_id comes with v5 (sessions)
```

Backfill: one `runs` row per existing project (`id = 'run-' || project_id`, `number = 1`, status mapped from
the project status, `workflow_snapshot` = the Standard template, `base_commit = projects.base_commit`). The
migration runner first writes `data/backups/studio-before-v6.db` (`VACUUM INTO`, D-018) and runs in one
transaction with `PRAGMA foreign_keys=OFF` during the rebuild, then `PRAGMA foreign_key_check`.

**Why rebuild instead of key prefixes** (revises D-009): code keeps its literal keys (`plan`, `plan-approval`,
`qa-verify`, `fix-<key>-<n>`…) and only gains a run filter; fix-round settings become
`fixRounds:<runId>:<taskKey>`; no key parsing anywhere. The table is small (88 rows today) and the backup
makes it reversible.

## 3. Run scoping (Phase 4, chunk 1 — must land before multi-run is enabled)

| Place | Change |
|---|---|
| `TaskRepository` | `listByRun(runId)`; `create()` requires `runId` (+ optional `nodeId`). |
| `ProjectService.startPlanning` → `RunService.start(projectId, workflowId?)` | allowed when the project has no active run (status not `planning/running/awaiting_approval/paused`). Creates `runs` row, records `base_commit = HEAD` of integration, compiles the workflow, inserts tasks. The V1 button "Start planning" calls it with the Standard template. |
| `scheduler.tick/promote/openGate/deriveStatus/execute(plan-skip)` | use the project's **active run** tasks only. Project status = derived from the active run; run status mirrors it; `completed/failed/cancelled` set `runs.finished_at`. |
| `expandPlan`, `runArchitecture`, `latestTestSummary`, `isRerunAfterFix` | scope to `task.runId`. |
| `runReview` diff | `run.base_commit..HEAD` (run 1 keeps `projects.base_commit`). |
| `fixLoop` rounds key | `fixRounds:<runId>:<taskKey>`; migration copies old values to `run-<projectId>`. |
| `agentViews`, snapshot | default to the active (or latest) run; V1 UI unchanged. |
| Recovery | unchanged (it already works per task). |

## 4. Graph schema

```ts
type WorkflowGraph = {
  schemaVersion: 1;
  nodes: { id: string /* [a-z0-9-]{1,40} */; type: NodeType; label?: string; position: { x: number; y: number };
           config: Record<string, unknown> /* validated per type */ }[];
  edges: { id: string; source: string; sourceHandle?: 'out' | 'pass' | 'fail'; target: string;
           kind?: 'normal' | 'retry' }[];
};
```
Limits: ≤ 60 nodes, ≤ 120 edges, graph JSON ≤ 200 KB, labels ≤ 80 chars, descriptions ≤ 2 000 chars.

## 5. Node catalog (`GET /api/v2/workflows/catalog`)

| Type | Executable | Compiles to | Config (defaults, limits) |
|---|---|---|---|
| `trigger` | yes (manual only) | nothing (run start) | `mode: 'manual'`; `schedule`/`webhook` planned — "needs a scheduler service; not in V2.0" |
| `requirement` | yes | nothing (project spec is the input; optional `specOverride` text ≤ 50 KB stored on the run) | `source: 'project-spec' \| 'override'` |
| `architect` | yes | task kind `architecture`, role `architect` | `provider?`, `model?`, `effort?`, `timeoutMinutes 5–480`, `maxAttempts 1–5` |
| `decompose` | yes | task kind `plan`, role `pm` (dynamic expansion §6.3) | same as above + `requireQa: true` |
| `backend` / `frontend` | yes | **implementation slot**: PM-planned tasks with that role (§6.3); standalone (no decompose upstream) = one `implement` task with `title/description` from config | `title?`, `description?`, agent overrides |
| `qa` | yes | task kind `test`, role `qa` (writes tests + runs project test command) | `rerunOnly: false`, `testCommand?` (must be allowlisted or approved) |
| `security` | yes | task kind `security`, role `security` | agent overrides |
| `reviewer` | yes | task kind `review`, role `reviewer` | agent overrides |
| `approval` | yes | task kind `gate` (approval kind `plan` before code, `release` after review) | `title`, `instructions` |
| `quality-gate` | yes | no task; marks the upstream verification task(s) as fix-loop enabled with `maxRounds 0–5` and routes `fail` edge to a `fix` node | `maxRounds` (default = setting `maxFixRounds`) |
| `fix` | yes | V1 fix loop (tasks are created at runtime by `insertFixTask`) | `role: 'auto' \| 'backend' \| 'frontend'` |
| `retry` | yes | sets `maxAttempts` on the upstream node's task | `maxAttempts 1–5` |
| `tool` | yes | NEW task kind `command`: runs one allowlisted command (`commandRunner.ts`) on the integration worktree; non-allowlisted = approval request (V1 flow) | `command`, `timeoutMinutes` |
| `artifact` | yes | task kind `report` (delivery report) | `fileName: 'ASF_REPORT.md'` |
| `notify` | yes | NEW task kind `notify`: emits an in-app notification event | `message` template (`{{project}}`, `{{run}}`, `{{status}}`) |
| `delay` | planned | — | "Timers that survive restarts are not built yet" |
| `deploy` / `delivery` | planned | — | "The studio never deploys or pushes (security rule)" |
| `condition` (expression) | planned | — | "Only verification verdicts can be evaluated truthfully" |
| `notify-external` (Slack/email) | planned | — | "Needs credentials and an outbound integration" |

## 6. Compiler `compileWorkflow(graph, ctx) → CompiledRun`

### 6.1 Validation (error codes returned by `POST /api/v2/workflows/validate`)
`E_TRIGGER` exactly one trigger · `E_UNREACHABLE` node not reachable from the trigger · `E_PLANNED` planned
node present · `E_CYCLE` cycle not made only of `kind:'retry'` edges into a `fix`→verification loop ·
`E_HANDLE` `pass/fail` handles only on `quality-gate` · `E_FIX_TARGET` `fix` must lead back to a verification
node (`qa/security/reviewer`) · `E_SLOT` `backend/frontend` slot after `decompose` has no `decompose`
upstream · `E_PROVIDER` role has no enabled+available provider and fallback is off · `E_COMMAND` tool command
not allowlisted and not approved (warning, becomes an approval at run time) · `E_LIMIT` size limits ·
`E_CONFIG` per-type schema error. Warnings do not block Run; errors do.

### 6.2 Ordering
Topological sort over normal edges (Kahn). Each executable node gets a task key = `node.id` (stable, so live
status maps back to the canvas) except the Standard template, which uses the V1 keys (`plan`, `architecture`,
`plan-approval`, `security-review`, `final-review`, `delivery-report`). `dependsOn` = keys of the nearest
upstream task-producing nodes (non-task nodes like `quality-gate`, `retry`, `requirement` are transparent).
Fan-out = several nodes depending on one key; fan-in = one node depending on several keys (V1
`dependenciesMet` already waits for all).

### 6.3 Dynamic expansion (Task Decomposition)
When a `decompose` node exists, its task is a V1 `plan` task. At runtime `expandPlan` (run-scoped) inserts the
PM tasks. V2 change: instead of the hardcoded tail it receives the compiled **downstream skeleton**: PM tasks
whose role matches a downstream `backend`/`frontend` slot get that slot's agent overrides; PM tasks of roles
with no slot are still created (nothing the PM plans is dropped) and flagged in the run timeline; every
downstream node that depended on a slot now depends on the slot's PM leaf tasks. `requireQa` keeps V1's
`qa-verify` rule. The approval node between decomposition and implementation keeps V1's plan approval.

### 6.4 Fix loop mapping
`qa/security/reviewer → quality-gate(maxRounds=N) —fail→ fix —retry edge→ back to the verification node`
compiles to: verification task with `fixRoundsMax = N` (new nullable task column `fix_rounds_max`, NULL =
setting) and fix role from the `fix` node. Runtime is V1's `insertFixTask`, unchanged except the run-scoped
budget key and per-task max. `pass` edge = normal dependency. No other cycles exist after compilation, so the
DAG check (`validateGraph`) still holds.

### 6.5 Standard template (golden test)
```
trigger → requirement → decompose(key plan) → architect(key architecture) → approval(key plan-approval)
       → backend slot + frontend slot → qa(slot qa-verify rule) → quality-gate → security(key security-review)
       → quality-gate → reviewer(key final-review) → quality-gate → artifact(key delivery-report)
       (each quality-gate —fail→ fix —retry→ its verification node; maxRounds = setting)
```
Golden test: for the sample project and a fixed PM plan fixture, the task rows produced by
`RunService.start(Standard)` + `expandPlan` equal V1's rows (keys, roles, kinds, dependsOn, orderIndex,
maxAttempts). Runs on every phase (`TEST_PLAN.md`). The Standard template is `builtin=1`, read-only;
"Duplicate" makes an editable copy.

## 7. RunService API (`/api/v2`)

| Method + path | Behaviour |
|---|---|
| `GET /workflows?projectId=` | templates (global + project), without graphs |
| `GET/PUT/DELETE /workflows/:id`, `POST /workflows` | CRUD; PUT bumps `version`; builtin is read-only; DELETE = archive (confirm in UI) |
| `POST /workflows/:id/duplicate`, `GET /workflows/:id/export`, `POST /workflows/import` | JSON in/out; import re-validates and never imports ids of other projects |
| `POST /workflows/validate` | `{ errors[], warnings[] }` |
| `POST /workflows/:id/simulate` | validate + compile → `{ tasks: [{key,title,role,kind,dependsOn,nodeId}], notes[] }`; starts nothing |
| `POST /projects/:id/runs` `{ workflowId }` | 409 when a run is active; creates the run and starts it |
| `GET /projects/:id/runs?limit=&before=` | run list (number, workflow name, status, trigger, duration, measured cost, error summary) |
| `GET /runs/:id` / `GET /runs/:id/timeline` | run + per-node status `{ nodeId, taskKeys[], status, startedAt, finishedAt, durationMs, attempts, providerId, model, costUsd, error }` and ordered timeline entries from `events` |
| `POST /runs/:id/cancel` | V1 `cancelProject` semantics scoped to the run |

SSE: `run.created`, `run.updated` (status, finishedAt), plus existing `task.*` events carrying `runId` and
`nodeId` so the canvas updates without polling.

## 8. Execution semantics
- **Parallelism**: scheduler `maxParallelTasks` ∩ `ProcessBudget` (D-006). Merges and test runs stay serial
  under the integration lock.
- **Retry**: `maxAttempts` per node (V1 retry on retryable errors). **Timeout**: node `timeoutMinutes` →
  task-level override of `taskTimeoutMinutes`; idle timeout stays global.
- **Failure strategy** (node config `onFailure`): `stop` (default, V1: dependants blocked) · `continue`
  (dependants run; the run ends `completed_with_failures`). `continue` is not allowed on verification nodes.
- **Cancellation**: aborts running tasks, cancels pending ones, run → `cancelled`.
- **Checkpoints/resume**: V1 per-task checkpoints and `recover()`; interrupted tasks continue from saved
  partial work (`wip(...)`). A paused run resumes where it stopped.
- **Limits**: fix rounds ≤ 5 per verification node, attempts ≤ 5, nodes ≤ 60 → bounded work per run.

## 9. Builder UI behaviours
Palette drag-and-drop (planned nodes greyed with their reason), typed handles (`pass/fail` only on quality
gates), connect validation on drop, undo/redo command stack (max 100; add/move/delete/connect/config),
copy/paste (Ctrl+C/V, new ids), delete (Del), select-all (Ctrl+A), save (Ctrl+S), autosave draft to
`workflows` every 5 s after edits (debounced; "Auto-saved hh:mm"), dagre auto-layout (left→right),
fit/zoom/mini-map, import/export JSON, duplicate, inspector form generated from the catalog config schema
(Agent/Model selects use the live provider list; "Cost limit" only for providers that report cost and maps
to the provider budget check; "Permissions" shows only real controls: command allowlist/approval for `tool`).
During a run: node border/status from `/runs/:id/timeline` + SSE; bottom panel tabs Run History, Validation,
Timeline, Logs (events filtered by run, virtualized), Agent Messages, Artifacts (files changed per task).

## 10. Test cases
WF-01 Standard template golden test · WF-02 validator: each error code · WF-03 fan-out/fan-in custom graph
on the Scripted provider completes · WF-04 quality gate maxRounds=1 with red tests → one fix task, then
failed + blocked · WF-05 planned node → `E_PLANNED`, Run disabled · WF-06 second run on the same project
after a completed run → new task rows, old run untouched, statuses independent · WF-07 cancel mid-run ·
WF-08 restart during a run → recovery continues the same run · WF-09 migration v6 on a copy of the real V1
DB: row counts equal, every task has a run, `foreign_key_check` empty · WF-10 import/export round trip ·
WF-11 tool node with a non-allowlisted command → approval, then runs after approval.

## SUMMARY
Workflows are graphs compiled to V1 tasks; the V1 scheduler runs them. Multi-run support needs run-scoped
queries in ~12 places and a `tasks` table rebuild to `UNIQUE(run_id, key)` (revised D-009), backed up first.
The Standard template reproduces V1 exactly (golden test). Executable nodes are only those V1 can really run;
Delay, Deploy, expression conditions and external notifications are visible but disabled with a reason.
