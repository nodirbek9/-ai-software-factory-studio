# V2 Implementation Phases (master plan)

Owner: Opus 5.5. Each phase is detailed into ≤ 15-minute worker chunks (≤ 5 files each) by the
phase-planner role right before it starts (`docs/v2/phases/PHASE_<n>.md`); the phase-planner must not
change decisions in `DECISIONS.md`. Every phase ends with: `npm test`, `npm run typecheck`, `npm run build`
green, Playwright smoke for the phase's screens, an independent review, updated `CURRENT_STATE.md`, and
an Uzbek report to the owner. V1 on port 4317 keeps running untouched throughout (D-001).

Global acceptance for every phase: no V1 feature lost (checked against `FEATURE_INVENTORY.md`), no
fake data, every visible control works or is disabled with a reason, loading/empty/error states present.

---

## Phase 0 — Audit, backup, planning (this phase)
- **Objective**: understand V1, protect it, plan V2.
- **Done**: V1 file backup + DB snapshot (`D:\jarvis 2\backups\asf-v1-2026-10-16\`), web test suite (19),
  audit + inventory + baseline + architecture + decisions + specs in `docs/v2/`.
- **Remaining (needs owner approval)**: D-020 git baseline (`git init`, commit, tag `v1.0.0`), branch
  `feature/v2-studio`, worktree `D:\jarvis 2\asf-v2`, V2 dev ports 4327/5327 + fresh `ASF_DATA_DIR`.
- **Rollback**: none needed (read-only except docs).

## Phase 0b — V1 hardening (security + correctness), on `main` before branching
- **Objective**: close the HIGH risks found by the audit before V2 adds sessions, tool nodes and terminals;
  the owner's daily V1 benefits immediately.
- **Changes**: R1 nested-symlink path escape, R2 retry bypassing dependencies, R3 mandatory final
  verification after the last write, R4 Host allowlist (DNS rebinding), R5 sensitive-file policy +
  consistent redaction, R6/S1 untrusted-project boundary (no project-level Claude settings/hooks, git hooks
  disabled for studio git calls, trust flag per project), R7 never remove a worktree whose partial save failed,
  R8 protect every discovered `~/.claude-account<N>` (`V1_AUDIT.md` §4, `SECURITY_REVIEW.md` §2).
- **Acceptance**: one regression test per item (red before, green after); all existing tests green.
- **Rollback**: git revert of the hardening commits; V1 restart only when no agents run.
- **Size**: ≈ 6 worker chunks.

## Phase 1 — Design foundation + app shell
- **Objective**: the V2 look and navigation, with all V1 pages still working inside it.
- **Changes**: design tokens (`web/src/design/tokens.css`, Tailwind `@theme`), Inter + JetBrains Mono
  (self-hosted woff2, no CDN), primitives (Card, KPI, StatusPill, Tabs, SplitPane, Drawer, Menu,
  Tooltip, Kbd, Skeleton, EmptyState, ErrorState, VirtualList, Donut, Sparkline), `AppShell` (Header with
  project selector, search, ⌘K palette, notifications drawer, running-agents indicator; Sidebar with 11
  items, collapsible, keyboard nav; route outlet), hash router with params, `React.lazy` pages, store
  split into slices (no behaviour change), PWA manifest (optional).
- **Reused**: all V1 pages (re-hosted: Monitor, Agents, Files, Logs, Providers, Settings, Projects,
  Workflows-as-"Project graph"), `lib/api.ts`, SSE.
- **New pages as shells only when real data exists**; items without a page yet route to the closest V1
  page (e.g. Runs → Monitor "Recently finished") — no placeholder screens.
- **Acceptance**: 11 sidebar items reachable by mouse and keyboard; ⌘K opens palette with navigation +
  project switch + real actions (pause/resume/cancel, new project); notifications list real events
  (failures, approvals waiting, limit hits); initial JS ≤ 160 KB gzip; 1366×768 and 1920×1080 layouts.
- **Tests**: web component tests for shell/palette/router; existing 19 web + 53 server tests green;
  Playwright smoke (navigate every item).
- **Risks**: store split regressions → keep V1 store API, add slices beside it.
- **Rollback**: branch revert; V1 untouched.

## Phase 2 — Home dashboard + read models
- **Objective**: reference screen 1 on real data.
- **Backend**: `/api/v2/overview`, `/api/v2/usage/summary`, `/api/v2/system/health`, paginated
  `/api/v2/events`; `ProcessBudget` (D-006) introduced here (scheduler only) so "Running agents x / y" is
  real; migration framework with automatic pre-migration backup (D-018).
- **Frontend**: Home (greeting, KPI row, Current Project Workflow stages, Agents Health, Active Projects,
  Recent Runs (recent finished tasks until Phase 4), Model Usage donut + 7-day sparkline, Project
  Progress, quick-launch cards, sidebar System Status from health).
- **Reused**: `liveMonitor.ts`, `usage_records`, provider detection, project snapshot logic.
- **Acceptance**: every number traceable to a query; deltas vs previous period computed; empty project
  list and offline server states; first data ≤ 300 ms.
- **Tests**: server unit tests for read models (fixed DB fixtures); web tests for each card's states;
  Playwright: Home renders with the scripted sample project.
- **Risks**: heavy queries on events → indexes + summary endpoints.

## Phase 3 — Multi-agent workspace
- **3a Sessions backend**: `agent_sessions`, `session_turns`, `workspace_layouts` tables; `SessionManager`
  (turns via `AgentExecutor`/adapters, ProcessBudget shared with scheduler, resume capability detection
  for Claude/Codex, context replay fallback, readonly vs own-worktree edit mode, stop/restart, interrupt
  recovery, merge into integration via V1 merge path, discard with confirm); `session.*` SSE events;
  routes under `/api/v2/sessions`.
- **3b Workspace UI**: layouts 1/2/3/4/5/6/8, resize/split/move/swap/maximize/minimize/close/reopen,
  per-project saved layout, panel header (agent identity, status, cwd/branch, provider/model/effort,
  controls), sub-tabs (Chat, Plan/Timeline, Artifacts (diff), Files (read-only CodeMirror), Output
  (xterm.js read-only, ANSI), Tests, Findings), coordination drawer (current workflow, handoffs, shared
  artifacts, messages, approvals, blocked tasks, errors), bottom status bar (sessions running/queued,
  tokens today, budget if set, CPU/RAM).
- **3c (optional, owner approval)**: interactive PTY terminal (D-019).
- **Acceptance**: 8 panels open = 0 processes until a message is sent; 3 concurrent turns max by default,
  others visibly queued; one failing panel does not affect others; Claude session continues context
  across turns (verified with a real call), Codex verified or labelled replay; edit session changes
  visible as diff and mergeable; layout survives reload.
- **Tests**: SessionManager unit tests with the Scripted provider (queueing, abort, interrupt, merge);
  web tests for layout engine; Playwright: open 6 panels, send to 2, reorder, reload.
- **Risks**: CLI resume flags differ by version → detect at runtime; memory → ProcessBudget; Windows
  file handles on worktree removal → V1 background retry.

## Phase 4 — Visual workflow builder + runs
- **Backend**: `workflows`, `runs`, `tasks.run_id/node_id` migration with backfill; node catalog;
  validator; compiler (golden test: Standard template == V1 graph); RunService (start, cancel, one active
  run per project, simulate); run timeline endpoint; `run.*` events.
- **Frontend**: canvas (palette DnD, connect, typed handles, zoom/pan, mini-map, undo/redo, copy/paste,
  shortcuts, dagre auto-layout), inspector (name, description, agent/provider/model, inputs, output
  schema, timeout, retries, permissions that map to real enforcement, failure strategy, approval
  settings, cost cap when measurable), Validate, Simulate (compiled preview), Run, Save/autosave,
  duplicate, import/export JSON, bottom panel (Run History, Validation, Timeline, Logs, Agent Messages,
  Artifacts, failed steps, durations, measured costs), live node status during a run.
- **Acceptance**: Standard template run on the scripted sample == V1 result (10/10 tasks); a custom
  graph with fan-out/fan-in + Quality Gate fix loop runs and stops at the round limit; planned nodes
  cannot be run and say why; cancellation works mid-run.
- **Tests**: compiler/validator unit tests (cycles, unreachable, missing provider), end-to-end run with
  Scripted provider, web tests for inspector/undo, Playwright build-and-run flow.
- **Risks**: run scoping touches the scheduler core (~12 places, `WORKFLOW_ENGINE_SPEC.md` §3) and the `tasks` table rebuild — golden test + backup + rehearsal on a DB copy.

## Phase 5 — Projects, tasks, repos
- **Objective**: Linear-style project management on real task state.
- **Changes**: Projects list/detail (requirements, architecture artifact, milestones/phases from the PM
  plan's optional `phase`/`epic` fields, runs, artifacts, tests, reviews), Tasks Kanban + list with
  filters, task drawer (agent, attempts, last output, logs, git diff via `/api/v2/tasks/:id/diff`),
  Repos page (integration branch, task/session branches, worktrees, ahead/behind, conflicts) read-only.
- **Acceptance**: progress only from task states; diff matches `git diff`; no git write except V1's
  allowed operations.
- **Tests**: server tests for diff/branches endpoints (temp repo); web tests; Playwright task drawer.

## Phase 6 — Monitoring & quality
- **Changes**: QA & Security Center (build/test results per run, structured findings with severity,
  "Create fix task" → real fix task, quality gates, release readiness = all gates passed, scanners not run
  shown as "not run"), `QualityScanner` adapters (tests, security agent JSON findings, `npm audit` with
  approval), Guardian contract; Logs page (virtualized, filters by project/run/agent/level, search);
  Models & Providers upgrade (availability, auth status as reported by detect, CLI/API mode, supported
  actions, models, effort support, resume support, limit state, session health, usage/cost); usage
  analytics per day/project.
- **Tests**: findings parser tests, scanner adapter tests, web tests, Playwright QA center.

## Phase 7 — Stabilization and release
- Playwright E2E for every main interaction; performance check vs `PERFORMANCE_BASELINE.md` targets;
  security review (independent worker + Opus final authority); migration validation on a copy of the
  real V1 DB (scheduler disabled); Windows launch guide (`start-studio.cmd` V2), rollback drill; docs
  updated; merge `feature/v2-studio` → `main` only with owner approval; tag `v2.0.0`.

---

## Order and dependencies
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 2 introduces ProcessBudget (needed by 3). Phase 4's `runs` feed
Home "Recent Runs" (until then: recent finished tasks). Phases 5 and 6 are independent of each other and
can run in parallel worker batches after Phase 4.

## Size estimate
Phase 1 ≈ 8–10 worker chunks · Phase 2 ≈ 8 · Phase 3 ≈ 14 · Phase 4 ≈ 14 · Phase 5 ≈ 8 · Phase 6 ≈ 10 ·
Phase 7 ≈ 8. Worker time, not owner time; Opus reviews each phase.
