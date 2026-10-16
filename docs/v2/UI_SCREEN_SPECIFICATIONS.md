# UI Screen Specifications — V2

Visual language: `DESIGN_SYSTEM.md` (tokens `canvas/sidebar/surface/raised`, status colors). Reference
mapping: `reference/REFERENCE_NOTES.md`. Data endpoints: V1 routes (`server/src/api/routes.ts`) and the new
`/api/v2/*` routes (`V2_ARCHITECTURE.md` §3.4, `AGENT_WORKSPACE_SPEC.md` §8, `WORKFLOW_ENGINE_SPEC.md` §7).
Every screen has: Skeleton loading, EmptyState with a real next action, ErrorState with Retry, and works at
1366×768 (compact) and 1920×1080 (comfortable). No number is shown without a data source; images'
illustrative numbers are never used.

## 0. App shell

| Region | Compact 1366×768 | Comfortable 1920×1080 | Content |
|---|---|---|---|
| Header | 56 px | 64 px | logo + "Software Factory Agent Studio" + `V2`; project selector; search (opens ⌘K); running-agents pill "2 working · 1 queued" (`/api/v2/system/health` budget + `/api/live`); notifications bell (unread count); display name (Settings, default Windows user name — no avatar, no role) |
| Sidebar | 56 px icons (auto-collapsed) or 208 px | 224 px | Home, Projects, Agent Workspace, Workflow Builder, Tasks, Runs, Repos, QA & Security, Logs, Models & Providers, Settings; collapse toggle (Ctrl+B); footer **System Status** card |
| Content | fluid, 16 px gutters | fluid, 24 px gutters, max 1680 px for dashboards | routed page (lazy) |
| Right inspector | drawer over content | docked 360–420 px | page-specific (node config, task details, coordination) |
| Status bar | Workspace only, 28 px | 28 px | `AGENT_WORKSPACE_SPEC.md` §12 |

- **Command palette (Ctrl+K)**: groups Navigate (11 pages), Projects (switch), Actions (New project, Start
  run with workflow…, Pause/Resume/Cancel active run, New session, Open workspace preset…), Recent (tasks,
  runs, sessions). Fuzzy search over `/api/projects`, `/api/v2/projects/:id/runs`, sessions, tasks of the
  current project. Enter runs; disabled actions show the reason inline.
- **Notifications drawer**: from SSE events with level warn/error and approvals: task failed, fix rounds
  exhausted, approval waiting, provider limit hit, run finished. Mark read (local preference), click → deep
  link. Badge = unread count. No external notifications.
- **System Status card** (sidebar footer): rows API, Database, Event stream, Providers (n available / n
  enabled), Git, Disk (`data/` free), each OK / Degraded / Down with a tooltip (source:
  `/api/v2/system/health`). Never a constant 100 %.
- **Keyboard**: Ctrl+K palette, Ctrl+B sidebar, `g h/p/w/b/t/r` go-to shortcuts, Esc closes drawers,
  focus-visible rings everywhere, skip-to-content link.
- **Routes** (hash): `#/home`, `#/projects`, `#/projects/:id`, `#/workspace/:projectId`,
  `#/builder/:workflowId?`, `#/tasks`, `#/runs`, `#/runs/:id`, `#/repos`, `#/quality`, `#/logs`,
  `#/models`, `#/settings`; V1 hashes (`#/dashboard`, `#/monitor`, `#/agents`, `#/workflows`, `#/files`,
  `#/providers`) redirect to their V2 homes so bookmarks keep working.

## 1. Home dashboard (`#/home`, Phase 2) — reference image 1

Layout (comfortable): greeting row · KPI row (6 cards) · [Project Workflow 8 col | Agent Health 4 col] ·
[Active Projects 4 | Recent Runs 4 | Model Usage 4] · [Project Progress 6 | Quick launch 6]. Compact: KPI
row wraps 3×2; three-column rows become two columns + one full-width.

| Element | Data source | Notes |
|---|---|---|
| Greeting "Welcome back, <name>", date, "+ New Project" | Settings `displayName`; client clock | button opens the V1 new-project dialog (Projects) |
| KPI Active projects (+delta vs 7 days ago) | `/api/v2/overview` → `projects.active`, `projects.activeDelta7d` | click → Projects filtered |
| KPI Running agents "x / slots" + Healthy/Degraded pill | overview `agents.running`, `budget.limit`, provider health | pill = all enabled providers available |
| KPI Active runs + "n queued" | overview `runs.active`, `budget.queued` | Phase 2: active pipelines; Phase 4: `runs` |
| KPI Open tasks (+delta 24 h) | overview `tasks.open`, `tasks.openDelta24h` | non-terminal tasks |
| KPI Failed (24 h) / Pending approvals | overview `tasks.failed24h`, `approvals.pending` | two small cards in one slot at compact |
| KPI Tokens (24 h) ±% vs previous 24 h | `/api/v2/usage/summary?range=24h` | cost shown only if any record has cost: "reported cost $x" |
| Project Workflow stages Architect → Backend → Frontend → QA → Security → Review | overview `currentProject.stages[]` = tasks of the active run grouped by role/kind: status, current task title, provider/model, duration, latest artifact (files of last merge), error | stage card click → Tasks drawer; empty project → "Start planning" button |
| Agent Health (7 roles + providers tab) | overview `agents[]`: role, status (running/idle/failed/disconnected), current task, last activity, provider/model, **success rate 7 d** (completed / finished attempts) labelled as such | "Disconnected" = assigned provider unavailable |
| Active Projects list | `/api/v2/overview` `projects[]`: name, workspace/repo path, integration branch, last activity, status pill, tasks completed/total bar, active agents, errors count | row → project detail |
| Recent Runs | Phase 2: `/api/live` `recent`; Phase 4: `/api/v2/projects/:id/runs` across projects: id/number, project, workflow, status, duration, started, error summary | row → run detail |
| Model Usage donut + 7-day sparkline | usage summary by provider/model | legend shows tokens and share; "unknown cost" when null |
| Project Progress | current project task counts: total, completed, running, blocked, failed + bar | replaces "Sprint progress" (no sprints in V2.0) |
| Quick launch | "Open Agent Workspace" (project preset), "Open Workflow Builder" (Standard template), "Run tests on integration" (allowlisted command) | real actions only |

States: no projects → onboarding EmptyState with New project / Try the sample (scripted, labelled "not AI").
Server offline → full-page ErrorState with Retry and the V1 connection banner.

## 2. Multi-Agent Workspace (`#/workspace/:projectId`, Phase 3) — reference image 2
Full spec: `AGENT_WORKSPACE_SPEC.md` §9–12. Page regions: title row (preset select 1/2/3/4/5/6/8, layout
toggles, Export layout, "+ New Session") · tab strip (Workspace, Files, Shared Artifacts, Run History) ·
panel grid · coordination drawer (collapsible, 360 px; Ctrl+.) · status bar.
- New Session dialog: role, provider (enabled+available only; disabled with reason), model buttons (V1 Agents
  pattern), effort, mode (Read-only / Edit in own worktree), link task (optional), title.
- Empty panel: "Start a session" picker listing existing idle sessions + New.
- Planned items shown disabled: "Interactive terminal (optional, needs approval)".
- Keyboard: Ctrl+1…8 focus panel, Ctrl+Enter send, Ctrl+Shift+M maximize, Esc restore.

## 3. Visual Workflow Builder (`#/builder/:workflowId`, Phase 4) — reference image 3
Full spec: `WORKFLOW_ENGINE_SPEC.md` §5, §9. Regions: title row + toolbar (Undo, Redo, zoom −/100 %/+, Fit,
Auto-layout, Validate, Simulate, Run (disabled with reason when errors or a run is active), Save, More:
Duplicate/Export/Import/Archive) · breadcrumb (project › workflow ▾ · Draft/Saved chip · "Auto-saved hh:mm")
· left palette (220 px, collapsible; groups Agents, Control, Tools, Output; planned nodes greyed with reason
tooltip) · canvas (React Flow, dotted grid, mini-map bottom-right) · inspector (380 px; tabs Configuration /
Inputs / Outputs) · bottom panel (resizable 240 px; tabs Run History, Validation (n), Timeline, Logs, Agent
Messages, Artifacts). Node card: type color, icon tile, title, subtitle, status dot (idle/running/done/failed
during runs), up to 3 config bullets, agent/model chip.

## 4. Projects (`#/projects`, `#/projects/:id`, Phase 5; V1 Projects re-hosted in Phase 1)
- List: table/cards with name, mode (new/import/sample), repo path, integration branch, status, progress,
  last activity, active agents, errors; filters (status), search; actions New, Import (V1 folder picker),
  Delete (stopped only, typed confirm).
- Detail tabs: Overview (spec excerpt, status, controls Start run ▾ / Pause / Resume / Cancel), Requirements
  (spec Markdown), Architecture (`docs/IMPLEMENTATION_PLAN.md` artifact), Plan (PM tasks grouped by optional
  phase/epic), Runs, Tasks (embedded Kanban), Files (V1 Files page), Report (V1 report.md), Settings
  (test command, trust flag from Phase 0b, workspace preset).

## 5. Tasks (`#/tasks`, Phase 5)
Kanban columns Pending · Ready · Running · Waiting approval · Blocked · Failed · Completed (Cancelled hidden
behind a filter) and a List view (sortable: key, title, role, status, attempts, provider/model, duration).
Filters: project, run, role, status, search. Card: title, role hue, status, attempt n/max, provider chip.
Task drawer: header (title, status, role, run), actions Retry / Cancel (V1 rules), sections Description,
Result summary, Test result (command, exit code, summary, output tail), Review text, Files changed, Git diff
(`/api/v2/tasks/:id/diff`), Usage, Events (filtered log), Fix rounds. Progress always from task states.

## 6. Runs (`#/runs`, `#/runs/:id`, Phase 4)
List: number, project, workflow (+version), status, trigger, started, duration, measured cost, error summary.
Detail: header with controls (Cancel), node timeline (Gantt-like bars per node, attempts as segments), failed
steps first, Logs (run-scoped events, virtualized), Agent messages, Artifacts. Read-only canvas preview with
live node status links to the Builder.

## 7. Repos (`#/repos`, Phase 5)
Per project: workspace path, integration branch + HEAD, base commit, task branches (`asf/<slug>/*`) and
session branches with ahead/behind vs integration, existing worktrees (path, owner task/session, age),
leftover `wip(...)` commits, conflicts seen (from `git.conflict` events). Read-only; copy-path buttons; "Open
in Explorer" uses the desktop shell only when the server is loopback. No delete/push actions (studio rule).

## 8. QA & Security (`#/quality`, Phase 6; V1 test results visible from Phase 1 via Tasks)
Top: release-readiness strip per run: Build, Tests, Security review, Code review, Dependency audit, Coverage —
each Passed / Failed / Error / **Not run** (grey, never green). Sections: Test runs (command, exit, summary,
duration, output), Findings table (severity counters Critical/High/Medium/Low, filters, columns title,
severity, file:line, source, status), finding drawer (description, recommendation, "Create fix task" → real
fix task, "Accept" / "False positive" with note), Scanners (detected scanners, versions, last run), Guardian
row "Not installed — integration contract ready" (until it exists).

## 9. Logs (`#/logs`, V1 Logs re-hosted in Phase 1, upgraded in Phase 6)
Virtualized event list (50k+ rows), filters: project, run, session, role, level, type; full-text search
(server-side `q`), time range; live tail toggle; row expand shows `data` JSON (redacted); export filtered
JSON. Paginated `/api/v2/events?before=&limit=`.

## 10. Models & Providers (`#/models`, V1 Providers + Agents merged, Phase 6; re-hosted in Phase 1)
Tabs: **Providers** (V1 provider cards: enable, availability + reason, version, account dir, models, effort
support, resume support (Phase 3), limit state "limit until hh:mm", budget, usage today, "Test") ·
**Agents** (V1 Agents page unchanged: per-role provider, model buttons, effort, fallback, Save, Test result
line) · **Usage** (by day/provider/model/project from `usage_records`; unknown cost shown as "—") ·
**Fallback order** (moved from Settings, same control). API and subscription CLIs are labelled separately
("CLI login" vs "API key"); no secret values are ever displayed.

## 11. Settings (`#/settings`, V1 re-hosted Phase 1)
Sections: Execution (V1 fields + `maxAgentProcesses`), Sessions (continuity native/replay, default modes),
Workflows (default template), Display (display name, density compact/comfortable, reduced motion), Server
(V1 info, approved folders, protected paths, allowlist), Security (V1 bullets + trust flags), Access token
(remote mode only). Every save shows "Saved" only after the server confirms (V1 behaviour).

## 12. Cross-screen acceptance
- Every interactive control reachable by keyboard and labelled (fixes audit R18).
- No page subscribes to the whole store (selectors only; audit §3.1).
- Each page lazy-loaded; initial JS ≤ 160 KB gzip.
- Visual review against the three reference images with the checklist in `TEST_PLAN.md`.

## SUMMARY
Eleven sidebar destinations in one shell with ⌘K, notifications and a real System Status card. Home,
Workspace and Builder follow the reference images but every element is bound to a named V1 or `/api/v2`
source. V1 pages are re-hosted in Phase 1 and replaced or merged later (Providers+Agents → Models &
Providers, Monitor → Home/Runs, Workflows graph → Runs/Builder), so no V1 feature disappears.
