# Software Factory Agent Studio V2 — Product Requirements

**Status:** Proposed; see `docs/v2/DECISIONS.md` for decision ownership and approval status.  
**Last updated:** 2026-10-16  
**Scope:** V2.0 requirements for the existing local Studio application.

## 1. Vision and product boundary

Software Factory Agent Studio is a local AI software engineering control center. It lets one owner define a project requirement, coordinate real specialist agents, inspect workflow progress and artifacts, review quality and security, approve consequential steps, and deliver a report. V2 evolves the verified V1 engine and preserves V1 workflows and data (D-001, D-008, D-013, D-014); it does not introduce a second orchestration engine.

| Users | Goals | Non-goals |
|---|---|---|
| One local owner, using the studio on their Windows workstation. | Keep projects, agents, sessions, workflows, runs, tasks, logs, quality findings, and provider configuration understandable in one place. | Multi-tenant/team collaboration, hosted service, cloud sharing, or replacing human approval. |
| Agents are configured provider-backed roles; their output/status must come from actual execution. | Safely run the existing Requirement → Architect → Task Breakdown → Backend + Frontend parallel work → QA → Security → Reviewer → Human Approval → Delivery flow. | Rewriting the V1 scheduler/providers, modifying Jarvis or ECC, or pretending unsupported integrations exist. |
| Human approval remains with the owner. | Preserve V1 and allow rollback to the V1 tag and pre-migration database backup. | Deploying software from a workflow in V2.0. |

The sequence above is the product workflow. V1 already has provider-backed plan execution, approval decisions, task scheduling/cancellation, tests, and report generation (`server/src/orchestrator/taskRunners.ts:149,331,387`; `server/src/orchestrator/projectService.ts:79`; `server/src/orchestrator/scheduler.ts:275`). V2 workflow nodes compile onto that scheduler. “Delivery” in V2.0 means owner-approved completion/report and available project artifacts. A deploy node is **planned**, not executable (D-008, D-010).

## 2. Requirements and delivery phases

Phase numbers refer to `docs/v2/IMPLEMENTATION_PHASES.md`. “Planned” identifies behavior not backed by V2.0 execution; it must be disabled with a reason, not presented as working. All controls that are visible must perform the stated action or be disabled with an explanation (D-014).

### Home

| ID | Requirement | Phase |
|---|---|---|
| FR-HOME-01 | Show project, running-agent/process-budget, active-run, open-task, and usage KPIs from persisted/live backend data; show deltas only when comparable data exists. | 2 |
| FR-HOME-02 | Show selected-project workflow stages, real agent/provider state, active projects, recent runs (recent finished tasks until runs exist), usage, and progress. | 2 |
| FR-HOME-03 | Offer working quick actions to create a project, open its workspace, and open the standard workflow. | 1–2 |
| FR-HOME-04 | Show loading, empty, degraded, and error states; never substitute decorative or demo metrics. | 2 |

### Projects

| ID | Requirement | Phase |
|---|---|---|
| FR-PROJ-01 | List and select projects; show requirement/specification, plan, status, task progress, artifacts and available report. | 1 (V1 pages), 5 |
| FR-PROJ-02 | Create new, imported, copied, or scripted sample projects using existing approval/path protections; do not modify an imported source checkout. | 1 (V1 pages) |
| FR-PROJ-03 | Start planning, approve/reject a plan, pause/resume/cancel, retry, and delete only through real backend actions and applicable confirmation. | 1 (V1 pages) |
| FR-PROJ-04 | Show phases/milestones only when returned by a PM plan; do not synthesize them. | 5 |

### Agent Workspace

| ID | Requirement | Phase |
|---|---|---|
| FR-WS-01 | Open real provider-backed agent sessions associated with project and role; opening panels alone starts no process. | 3 |
| FR-WS-02 | Support 1, 2, 3, 4, 5, 6, or 8 panels; resize, split, move, swap, maximize, minimize, close/reopen, and save layout per project. | 3 |
| FR-WS-03 | Persist turns and show truthful queued/running/waiting/failed/stopped status, provider/model/effort, output, and session continuity mode (native resume or labelled replay). | 3 |
| FR-WS-04 | Support read-only project sessions and isolated edit worktrees; explicitly merge through the existing conflict path or confirm discard. Never edit the owner's checkout. | 3 |
| FR-WS-05 | Show linked task timeline, diffs/artifacts, read-only files, tests/findings when available, and actual handoffs/messages. “Message all agents” enters the orchestrator inbox. | 3 |
| FR-WS-06 | Show process queue position and shared process budget; stop aborts the active turn. Eight idle panels consume zero agent processes. | 2–3 |
| FR-WS-07 | Interactive PTY terminal is optional Phase 3b, off by default and **planned pending owner approval** (D-019). V2.0 workspace output is read-only. | 3b planned |

### Workflow Builder

| ID | Requirement | Phase |
|---|---|---|
| FR-BLD-01 | Edit workflow graphs using catalog-backed nodes, typed connections, inspector configuration, undo/redo, copy/paste, auto-layout, and import/export. | 4 |
| FR-BLD-02 | Validate graph constraints and provider assignments; simulate by returning a compiled task preview without starting agents. | 4 |
| FR-BLD-03 | Run a saved workflow by compiling it to the existing V1 DAG scheduler; display live node/task state and permit cancellation. | 4 |
| FR-BLD-04 | Ship a Standard Software Factory template whose compiled graph is golden-tested against the V1 task graph. | 4 |
| FR-BLD-05 | Execute manual trigger, requirement input, architect, task decomposition, backend/frontend agents, QA, security review, reviewer, human approval, bounded quality/fix loop, retry, allowlisted tool, artifact, and in-app notification nodes only where catalog says executable. | 4 |
| FR-BLD-06 | Mark deployment/delivery execution, delay/wait, external notifications, and generic expression branches **planned/disabled** with explanation. Do not imply they run. | 4 |
| FR-BLD-07 | Save drafts/autosave; keep validation, run history, timeline, logs, messages, artifacts, failures, durations, and measured costs tied to real run data. | 4 |

### Tasks and Runs

| ID | Requirement | Phase |
|---|---|---|
| FR-TASK-01 | Show task list/Kanban, status filters, dependencies, role/provider, attempts, output, test result, usage, logs, and task drawer. | 5 |
| FR-TASK-02 | Support real retry/cancel and show a task diff against integration when available. | 1 (V1 controls), 5 |
| FR-RUN-01 | Persist run identity, workflow snapshot, trigger, lifecycle, error summary, and task/node links; backfill existing projects as specified by D-009. | 4 |
| FR-RUN-02 | Show run list and per-run timeline with real events/status; allow at most one active run per project. | 4 |
| FR-RUN-03 | Report only costs/tokens measured in usage records; unavailable cost is absent/unknown, never estimated. | 2, 4 |

### Repos

| ID | Requirement | Phase |
|---|---|---|
| FR-REPO-01 | Read-only view of integration/task/session branches, worktrees, ahead/behind, and conflicts when git reports them. | 5 |
| FR-REPO-02 | Show diffs from actual git state; preserve V1 git allowlist and never offer push, reset, clean, or branch deletion as V2 actions. | 5 |

### QA & Security

| ID | Requirement | Phase |
|---|---|---|
| FR-QA-01 | Show test/build results and structured findings per project/run, with severity, source, file/line where supplied, and recommendation. | 6 |
| FR-QA-02 | Support test runner, structured security-agent result, and approved `npm audit --json`; an unrun/unparseable scanner is “not run”/“unstructured”, never PASS. | 6 |
| FR-QA-03 | Allow a finding to create a real fix task; show quality gates and release readiness only when all required gates passed. | 6 |
| FR-QA-04 | Display Guardian only when an implemented scanner satisfies its contract; otherwise it is unavailable/planned. | 6 |

### Logs

| ID | Requirement | Phase |
|---|---|---|
| FR-LOG-01 | Show persisted, paginated, filterable/searchable events by project, run, agent, and level; virtualize long lists. | 1 (V1 logs), 6 |
| FR-LOG-02 | Surface execution output, failures, approvals, provider limits, and session/run lifecycle with timestamps and useful error detail. | 1, 3–4, 6 |

### Models & Providers

| ID | Requirement | Phase |
|---|---|---|
| FR-MOD-01 | Preserve provider discovery/configuration, role assignments, model/effort, enablement, budgets, fallback ordering, usage/limits, and real agent Test action. | 1 (V1 Agents/Providers), 6 |
| FR-MOD-02 | Show availability/auth state only as reported by provider detection; show supported mode/actions/resume capability and actual reported model where known. Never expose credentials. | 6 |
| FR-MOD-03 | Report token/cost from usage records and provider-reported values only; do not invent subscription quota or health percentages. | 2, 6 |

### Settings and shell

| ID | Requirement | Phase |
|---|---|---|
| FR-SET-01 | Preserve V1 task/idle timeout, attempt/fix-round, parallelism, fallback, approved-root, allowed-command, and server settings. | 1 (V1 Settings), 6 |
| FR-SET-02 | Add shared max-agent-process setting (1–8, default 3) used by scheduler and sessions, with visible queue state. | 2–3 |
| FR-SET-03 | Provide a working project selector, sidebar navigation, notifications from real events, status indicator, and Ctrl+K search/action palette. | 1 |
| FR-SET-04 | Preserve V1 Monitor, Agents, Files, Logs, Providers, Projects, Workflows, Dashboard, Settings capabilities in the shell during migration. | 1 |

## 3. Non-functional requirements

| ID | Requirement | Target / acceptance |
|---|---|---|
| NFR-PERF-01 | Keep server idle working set within measured V1 headroom. | ≤150 MB. |
| NFR-PERF-02 | Lazy-load page code and keep initial JavaScript small. | ≤160 KB gzip. |
| NFR-PERF-03 | Make Home responsive on localhost. | First dashboard data ≤300 ms. |
| NFR-PERF-04 | Use summary APIs and paginate routine payloads. | Largest routine payload ≤150 KB. |
| NFR-PERF-05 | Bound idle browser memory and long logs. | Home heap ≤40 MB; 50k-line log view smooth via virtualization. |
| NFR-PERF-06 | Avoid additional fixed polling; use the existing single SSE channel, replay, and one 15-second safety poll. Sample CPU only while subscribed/visible. | No hidden high-frequency polling; eight idle panels spawn zero processes. |
| NFR-SEC-01 | Preserve loopback default, remote token/CSRF protections, path guard, protected locations, command/git allowlists, redaction, and secret-free browser payloads. Reuse existing auth safely; do not weaken it for V2 routes/sessions. | Authenticated backend/API tests cover V1 and V2 paths. (`server/src/api/routes.ts:103,108`; `server/src/workspace/workspaceManager.ts:89,109`; `server/src/workspace/commandRunner.ts:70`) |
| NFR-SEC-02 | Isolate edit sessions in owned worktrees; destructive merge/discard/delete actions require confirmation and are auditable. | User checkout and unrelated git/project data remain intact. |
| NFR-ACCESS-01 | Support keyboard-first navigation, visible focus, semantic controls, and accessible names; Ctrl+K opens palette and Escape closes it. | All main actions reachable without pointer. |
| NFR-WIN-01 | Fit and remain usable at 1366×768 and 1920×1080, including Windows high-DPI scaling. | No clipped primary controls; panels and dialogs remain operable. |
| NFR-DATA-01 | Use forward-only additive migrations with a database backup before each; V1 routes remain compatible until migration acceptance. | Rollback procedure is documented and exercised in Phase 7 (D-013, D-018). |
| NFR-TRUTH-01 | Distinguish actual, unavailable, and planned data/capabilities. No fake/demo data or inferred success/health/cost. | Scripted sample remains explicitly identified as a test/sample project. |

## 4. Critical acceptance criteria from the owner brief

Each criterion is a release gate; linked requirements define expected behavior.

| # | Acceptance criterion | Requirement IDs |
|---:|---|---|
| 1 | V1 remains usable and no V1 capability is lost. | FR-SET-04, FR-PROJ-01–03, FR-MOD-01, FR-SET-01 |
| 2 | Home, Agent Workspace, and Workflow Builder exist and are reachable. | FR-HOME-01–04, FR-WS-01–07, FR-BLD-01–07 |
| 3 | Agents are real provider-backed executions, not visual stand-ins. | FR-WS-01, FR-MOD-01–02, FR-BLD-03–05 |
| 4 | Agent sessions are managed separately, with persisted turns and independent lifecycle. | FR-WS-01, FR-WS-03–06 |
| 5 | Multi-panel layout works and is saved per project. | FR-WS-02 |
| 6 | Builder validates, simulates, and runs real workflows. | FR-BLD-01–07, FR-RUN-01–02 |
| 7 | Progress and statuses reflect real events/task/run/session state. | FR-HOME-02, FR-WS-03, FR-BLD-03, FR-RUN-02, FR-LOG-02 |
| 8 | Logs and actionable errors are visible. | FR-LOG-01–02, FR-QA-01 |
| 9 | Tasks, projects, and agents are linked in views and backend records. | FR-PROJ-01, FR-WS-05, FR-TASK-01, FR-RUN-01 |
| 10 | Every visible button/control performs a real action or explains why it is disabled. | All FRs; D-014 |
| 11 | Backend/frontend integration tests cover V2 flows and existing behavior. | FR-WS-01–06, FR-BLD-01–07, NFR-SEC-01; Phase 7 release gate |
| 12 | V2 agents use existing provider authentication safely; secrets never reach UI. | FR-MOD-02, NFR-SEC-01 |
| 13 | Git and project data are not lost or modified outside explicit supported operations. | FR-PROJ-02–03, FR-REPO-01–02, FR-WS-04, NFR-SEC-02, NFR-DATA-01 |
| 14 | A Windows launch guide provides working V2 startup instructions. | Phase 7 documentation gate; NFR-WIN-01 |
| 15 | Rollback to V1 with the pre-migration database backup is possible and drilled. | NFR-DATA-01 |
| 16 | Demo/sample data is never represented as real owner or provider data. | FR-HOME-04, FR-QA-02, FR-MOD-03, NFR-TRUTH-01 |

## 5. Out of scope for V2.0

- Electron/Tauri packaging; hosted, multi-user, or cloud collaboration/sharing.
- Deploy/Delivery execution, external notification integrations, Delay/Wait nodes, and generic expression/branch execution (planned/disabled; D-010).
- PTY interactive terminal unless separately approved for Phase 3b; V2.0 agent output is read-only (D-019).
- Jarvis/ECC integration or modification; the Orchestrator view represents this studio's scheduler (D-015).
- Guardian scanner until an implementation satisfies the defined scanner contract.
- Claims about model quota, cost, quality, health, or coverage without a provider report or actual measurement.
- Replacing the existing V1 scheduler/provider/auth stack or changing a decision in `DECISIONS.md`.

## 6. Open questions for Opus

- Should “Delivery” in the product workflow be named “Human-approved report/artifacts” in the UI until a later deploy capability exists?
- Which identity source should Settings use for the Home greeting: Windows account name or an owner-configured display name?
- Should V2 expose interactive terminal as a post-2.0 opt-in, or keep the Phase 3b approval gate unresolved until implementation review?

## SUMMARY

V2 retains V1’s verified orchestration and adds real sessions, compiled workflows/runs, read models, and a truthful control-center UI. Requirements are phased and mapped to all 16 owner acceptance gates. Unsupported deploy, external notification, expression, and PTY capabilities are clearly marked planned/out of scope.
