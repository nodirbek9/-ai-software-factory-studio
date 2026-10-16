# V2 Architecture — Software Factory Agent Studio V2

Status: proposed 2026-10-16 (Opus 5.5 master plan), waiting for owner approval. Decisions are numbered in
`DECISIONS.md`; phases in `IMPLEMENTATION_PHASES.md`. Workers implement; they report — not change — any
decision they disagree with.

## 1. Principle: evolve V1, do not rewrite it

V1 already has the hard parts working and verified with real agents: Fastify API, `node:sqlite` state,
task state machine, DAG scheduler with parallel git worktrees, checkpoints and crash recovery,
pause/resume/cancel, approvals, bounded fix loop, merge-conflict resolution, multi-account Claude Code,
Codex, Antigravity, usage capture, limit failover, SSE live stream, security guards. V2 keeps this core
and adds four things on top of it:

1. a **design system + app shell** (the three reference screens' visual language),
2. **agent sessions** (interactive, turn-based, multi-panel workspace),
3. **user-defined workflows** compiled onto the existing scheduler, with **runs** history,
4. **read models** for dashboards (summaries, usage, health, quality) instead of shipping full snapshots.

Same stack, same process, same database file. No framework migration, no microservices (D-002, D-003).

## 2. System view

```
Browser (React 19 + Vite, lazy pages)          ─ one SSE stream + REST ─      Node 24 process (Fastify)
┌───────────────────────────────────────┐                                ┌────────────────────────────────────┐
│ AppShell: Sidebar · Header · ⌘K ·     │                                │ api/routes (V1, unchanged)          │
│   Notifications · StatusBar           │  /api/events (SSE, replay)     │ api/v2/* (new, summary endpoints)   │
│ Pages: Home · Projects · Workspace ·  │ ◄───────────────────────────── │                                    │
│   Builder · Tasks · Runs · Repos ·    │                                │ ProjectService ─ TaskScheduler ─┐   │
│   QA&Security · Logs · Models ·       │  /api/* , /api/v2/*            │ RunService (NEW) ─ WorkflowCompiler │
│   Settings (+ V1 Monitor/Agents/Files)│ ─────────────────────────────► │ SessionManager (NEW)            │   │
│ Zustand slices: core(V1) · sessions · │                                │        │                        ▼   │
│   workflows · runs · overview · ui    │                                │   ProcessBudget (NEW, shared) ◄─ AgentExecutor
└───────────────────────────────────────┘                                │        │            ProviderRegistry (V1)
                                                                         │ WorkspaceManager (V1 worktrees, guards)
                                                                         │ ReadModels (NEW): overview, usage,     │
                                                                         │   health, quality, system metrics      │
                                                                         │ Repositories (node:sqlite) ◄ EventStream│
                                                                         └────────────────────────────────────┘
                                data/studio.db · data/workspaces · data/worktrees · data/backups (NEW)
```

## 3. Backend additions

### 3.1 ProcessBudget (D-006)
One in-process semaphore for **every** agent CLI process: scheduler task runs and workspace session turns
acquire a slot before spawning and release it on exit (also on abort/timeout). Default
`maxAgentProcesses = 3` (Settings, 1–8). `maxParallelTasks` stays as the scheduler's own cap
(effective = min of both). Waiting work is visible ("waiting for a free agent slot", position in queue).
This is what makes "8 panels open" cheap: panels are views; only turns hold processes.

### 3.2 Agent sessions (D-005, D-007) — `server/src/sessions/`
- **Model**: `agent_sessions` (id, project_id, role, title, provider_id, model, effort, mode
  `readonly|edit`, cwd kind `integration|own-worktree`, branch, provider_session_ref, status
  `idle|queued|running|waiting_input|failed|stopped`, last_activity_at, created_at) and
  `session_turns` (id, session_id, seq, role `user|agent|system`, text, tool_activity JSON, usage JSON,
  model_reported, started_at, finished_at, exit_status, error).
- **Turn execution**: a user message → `SessionManager.send()` → acquire ProcessBudget slot → build
  request with the existing `AgentExecutor`/`ProviderAdapter.run()` (same flags, parsers, redaction, usage
  records, limit failover) → stream output lines as `session.output` events → persist the turn.
- **Continuity**: adapters gain an optional capability `resume`: Claude Code `--resume <session_id>`
  (session id taken from the stream-json `init`/`result` event), Codex `exec resume <id>` when the
  installed version supports it (verified in Phase 3 by `detect()`), otherwise **context replay** (last N
  turns + summary prepended to the prompt). The UI labels which one is used — never claims native resume
  it does not have.
- **Isolation**: `readonly` sessions run in the project's integration worktree with the read-only
  provider mode (as V1 chat does). `edit` sessions get their own worktree on `asf/<slug>/session-<n>`
  created from the integration branch (existing `WorkspaceManager`). Their changes reach the project
  only via an explicit **"Merge into integration"** action that reuses the V1 merge + conflict-resolution
  path under the per-project integration lock. Sessions never touch the user's checkout.
- **Lifecycle**: lazy — creating/opening a panel starts nothing; a process exists only during a turn.
  Stop = abort the turn (kills the process tree, as V1 cancel). Restart = new turn with replayed
  context. Idle edit worktrees are kept until the session is closed and merged or discarded (discard asks
  for confirmation). Server restart: running turns become `failed (interrupted)`, partial edits are
  committed `wip(session)` like V1 partial work.
- **Coordination**: sessions can be linked to a task (`task_id`), handoffs are derived from task
  dependency completions; "Message all agents" goes to the orchestrator inbox (`agent_messages` with
  role `orchestrator`) and can be forwarded by the user to selected sessions — no frontend-only chat.
- **Phase 3b (optional, owner approval)**: interactive PTY terminal per panel (`@xterm/xterm` in the
  browser + a prebuilt ConPTY binding on the server, e.g. `@lydell/node-pty`). User-initiated shell in a
  session worktree only, loopback-only, logged, off by default (D-019).

### 3.3 Workflows and runs (D-008 … D-010) — `server/src/workflows/`
- `workflows` (id, project_id NULL = global template, name, description, version, graph JSON, created_at,
  updated_at, archived) — graph = `{ nodes: [{id, type, position, config}], edges: [{id, source,
  sourceHandle, target}] }`, validated with zod.
- **Node catalog** served by `GET /api/v2/workflows/catalog`: each type has `executable: boolean`,
  config schema, allowed inputs/outputs and the V1 capability it maps to. Executable in V2.0: Trigger
  (manual), Requirement Input, Architect, Task Decomposition (PM plan, dynamic expansion), Backend Agent,
  Frontend Agent, QA Tests, Security Review, Reviewer, Human Approval (gate), Quality Gate (verdict-based
  → fix loop), Retry policy, Tool Execution (allowlisted command), Artifact Output (report), Notification
  (in-app). Planned (disabled, with reason): Deploy/Delivery, Delay/Wait, external notifications,
  generic expression branches.
- **Compiler** `compileWorkflow(graph, project) → TaskSpec[]`: validates (single trigger, DAG except
  Fix/Retry back-edges with `maxRounds ≤ 5`, every executable node reachable, roles have providers),
  topologically orders nodes and emits V1 task specs (role, kind, dependsOn, maxAttempts, timeouts,
  provider override). Task Decomposition keeps V1 semantics: the PM's JSON plan is inserted at runtime
  between the decomposition node and its downstream nodes; the plan's tasks are filtered by the
  downstream Backend/Frontend nodes' roles. Quality Gate + Fix nodes configure the existing fix loop
  (`maxFixRounds` per verification task). **The built-in "Standard Software Factory" template compiles
  to the exact V1 task graph** (golden test) — that is how V1 behaviour is preserved.
- `runs` (id, project_id, workflow_id, workflow_snapshot JSON, number, status, trigger, base_commit,
  started_at, finished_at, error_summary). `tasks` is rebuilt with `run_id`, `node_id` and
  `UNIQUE(run_id, key)`; the migration backfills one run per existing project (backup first). One active
  run per project (keeps the integration-lock model). The scheduler, runners and fix loop are scoped to the
  active run (D-009 revised; details `WORKFLOW_ENGINE_SPEC.md` §2–3).
- **Simulate** = validate + compile + return the task list preview; starts nothing.
- Live node status = task events mapped to node ids (`tasks.node_id`, nullable).

### 3.4 Read models and new endpoints (D-013)
Additive, under `/api/v2/` (V1 routes unchanged so V1 pages keep working during migration):
`overview` (KPIs, stage summary of the current project, agent/provider health, recent runs),
`usage/summary?range=24h|7d` (tokens/cost by provider/model/day from `usage_records`), `system/health`
(API, DB, SSE clients, provider detection age, git on PATH, data disk free, server RSS, system RAM, CPU %
sampled only while a client subscribes), `runs`, `runs/:id/timeline`, `sessions/*`, `workflows/*`,
`events?project=&before=&limit=` (paginated), `tasks/:id/diff` (git diff of the task/session branch vs
integration, read-only git), `quality/:projectId` (verification results, findings). Payload target
≤ 150 KB; snapshots no longer embed full event history for the new pages.

### 3.5 Quality & Security (D-016)
`QualityScanner` adapter interface (`detect()`, `scan(cwd) → { status, findings[], metrics }`) with a
JSON findings schema (id, severity, title, file, line, description, recommendation, source). Built-in:
test runner results (existing), security review agent (prompt asks for a fenced JSON findings block in
addition to the verdict; unparsable = "unstructured", never PASS), `npm audit --json` as an allowlisted
command (network → one-time approval). Coverage only when a coverage run actually produced a report.
"Guardian" plugs in as another scanner when it exists (contract in `QUALITY_SECURITY_CONTRACT` section
of `SECURITY_REVIEW.md`).

## 4. Frontend architecture

- **Shell**: `AppShell` = Header (project selector, search/⌘K, notifications, running-agents
  indicator, quick actions) · Sidebar (11 items, collapsible, keyboard reachable) · content · optional
  right inspector · bottom StatusBar (Workspace). Routing: hash routes with params
  (`#/projects/:id`, `#/workspace/:projectId`, `#/builder/:workflowId`, `#/runs/:id`, …) via a tiny router
  in the UI slice; every page is `React.lazy` (D-004).
- **Design system** (`web/src/design/`): CSS variables (Tailwind 4 `@theme`) for color, radius, spacing,
  type scale, elevation, motion; primitives extended (Button, IconButton, Card, KPI, StatusPill, Tabs,
  SplitPane, Drawer, Dialog, Menu/ContextMenu, Tooltip, Kbd, EmptyState, ErrorState, Skeleton,
  VirtualList, Donut, Sparkline, ProgressBar). Details in `DESIGN_SYSTEM.md`.
- **New dependencies** (all small, permissive licences; installed into `web/` only): `react-resizable-panels`
  (split panes), `cmdk` (command palette), `@tanstack/react-virtual` (logs/lists), `@dagrejs/dagre`
  (auto-layout), `@xterm/xterm` + `@xterm/addon-fit` (ANSI output; lazy). Charts are own SVG components
  (donut, sparkline, bars) — no chart library. File viewer: CodeMirror 6 lazy-loaded (read-only). Dev:
  `@playwright/test` using the installed Microsoft Edge (`channel: 'msedge'`, no browser download).
- **State**: split `store/studio.ts` into slices (core V1 behaviour unchanged first, then `sessions`,
  `workflows`, `runs`, `overview`, `ui` with persisted layout prefs). SSE stays the single live channel;
  new event types: `session.*`, `run.*`, `workflow.*`, `system.health`. The fixed 3 s `/api/live` poll
  becomes a 15 s safety poll + event-driven refresh.
- **Workspace layout engine**: presets 1, 2, 3, 4, 5, 6, 8 panels built from nested
  `react-resizable-panels` groups; panel = `{ sessionId | null, view }`; actions resize, split h/v, move
  (drag handle), swap, maximize (fullscreen within the page), minimize (to a dock strip), close, reopen
  (recently closed list). Layout saved per project (`workspace_layouts` table, also exportable JSON).
- **Builder**: React Flow (already in V1) with palette drag-and-drop, typed handles, mini-map, zoom/pan,
  undo/redo (command stack), copy/paste, keyboard shortcuts, dagre auto-layout, inspector forms generated
  from the catalog's config schema, import/export JSON, duplicate, autosave drafts.

## 5. Security (unchanged guarantees + additions)
Loopback bind, token for remote, CSRF guard, path guard, protected paths (studio itself, `~/.claude*`,
`~/.codex`, `~/.gemini`, AppData, `D:\Jarvis`, `D:\AI-Stack`), git subcommand allowlist (no push/reset/
clean/branch delete), command allowlist, redaction, secrets never sent to the browser. New: audit log
events for session merge/discard, workflow runs, approvals and terminal sessions; destructive actions
(discard worktree, delete workflow/project, merge) require a confirm dialog; no deploy node is
executable; PTY terminal only after explicit owner opt-in.

## 6. Performance budget
See `PERFORMANCE_BASELINE.md`: initial JS ≤ 160 KB gzip via lazy pages, server idle ≤ 150 MB, routine
payloads ≤ 150 KB, virtualized logs, no new fixed polls, process budget default 3, CPU sampling only while
viewed, SSE reconnect with replay (V1), graceful shutdown aborts turns and saves partial work.

## 7. Delivery model
V2 is built on branch `feature/v2-studio` in a separate git worktree (`D:\jarvis 2\asf-v2`) running on
ports 4327/5327 with `ASF_DATA_DIR` pointing at its own data copy, so the owner's daily V1 on 4317 is
never interrupted. Each phase ends with tests green and a short report; the branch is merged into `main`
only after Phase 7 acceptance. Rollback = run the `v1.0.0` tag with the pre-migration DB backup
(`MIGRATION_PLAN.md`).
