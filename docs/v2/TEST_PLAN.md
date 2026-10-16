# V2 Test Plan

**Status:** proposed with the V2 plan · **Last updated:** 2026-10-16

## Purpose and rules

Keep the V1 behavior green through the additive V2 migration, and verify V2 against real backend state. Tests use the Scripted provider or fixed fixtures; they do not call real model providers. No fake data in product flows. The owner-supplied screenshots are manual visual references, not pixel gates (`docs/v2/DECISIONS.md`, D-011 and D-017).

Every phase exit runs the V1 regression suite, typecheck, build, and that phase's focused tests. Phase 7 runs the complete matrix and acceptance review. Current root scripts are `npm test`, `npm run typecheck`, and `npm run build`; phase E2E commands below require the planned Playwright setup. Existing suite structure: `server/vitest.config.ts` includes `test/**/*.test.ts` with serialized files and long timeouts; `web/vitest.config.ts` runs `src/**/*.test.{ts,tsx}` in jsdom.

## Test levels

| Level | Harness and isolation | Gate |
|---|---|---|
| Server unit | Vitest; pure modules, fixed DB/graph fixtures, injected providers, temp filesystem/git repo where needed. | Each changed module and edge cases pass. |
| Server API/integration | Fastify `app.inject()` via `createStudio`; unique `tempDir()` for DB, workspaces, worktrees and samples. Close every studio in teardown. Cover routes, migrations, persistence, guards and event replay. | No V1 data touched; temp dirs removed or isolated. Existing helpers: `server/test/helpers.ts` (`tempDir`, `prepareSamples`, `startStudio`, `waitFor`, `approvePlan`). |
| Scripted workflow E2E | Start a studio on temp data; use bundled `todo-service` sample with `.asf-script.json` and Scripted provider. Await state via `waitFor`, not arbitrary sleeps where possible. | Deterministic graph, tasks, approvals, outputs, retries, tests and final result. |
| Web component | Vitest + jsdom + Testing Library; shared `installFetchMock()` and typed fixtures; assert requests and rendered loading/empty/error/success states. The mock returns 404 for unconfigured routes. | User-visible state and API calls verified; no real network. |
| Browser E2E | Playwright on installed Microsoft Edge `channel: 'msedge'`; launch a test server on a free port and set a unique temporary `ASF_DATA_DIR`; seed only Scripted provider/sample. Server readiness check before browser. No provider credentials or real agent quota. | Critical paths at 1366×768; wider viewport smoke at 1920×1080. Close browser/server and clean temp data even on failure. |

V1 test inventory to preserve: `server/test/{unit,api,workflow,resilience}.test.ts`; web `Agents.test.tsx`, `Monitor.test.tsx`, `Settings.test.tsx`, and `fetchMock.test.ts`. Helpers and test intent are summarized in `docs/v2/FEATURE_INVENTORY.md` §7. `HANDOFF.md` reports the current baseline as 53 server and 19 web tests; count changes are acceptable when coverage is retained.

## Per-phase test matrix

Run every applicable row as the feature lands; `V1-*` checks are mandatory after every phase.

| Phase | IDs | Concrete cases and expected result |
|---|---|---|
| 1 · Shell | P1-01 | Render shell with existing V1 store/API; navigate all 11 sidebar items and hash routes, back/forward and unknown route. No route loses V1 page access. |
|  | P1-02 | Keyboard reach sidebar, project selector, search/⌘K palette, notifications and actions; palette escape/close and focus return. |
|  | P1-03 | Loading, empty, API error and real-event notification states; no placeholder/demo content. Lazy page chunks build; initial gzip bundle measured. |
|  | P1-04 | Playwright visits every nav item at desktop and narrow supported viewport; no fatal console errors. |
| 2 · Home/read models | P2-01 | Fixed DB fixtures: KPI counts, stages, provider/role health labels, recent activity, usage totals and prior-period delta match source rows; zero-data state is honest. |
|  | P2-02 | API pagination/filter boundaries and summary payload shape/size; system health reports unavailable checks as degraded/down, not 100%. |
|  | P2-03 | ProcessBudget capacity, FIFO queue, abort/timeout release, and scheduler admission; configured cap is never exceeded. |
|  | P2-04 | Cards render success/empty/loading/error from fetch mock; Playwright dashboard uses Scripted sample and verifies values against API. |
| 3 · Workspace | P3-01 | Session create/open is lazy: eight panels start zero processes; turn acquires/releases one shared slot, queued turn is visible, abort releases it. |
|  | P3-02 | Scripted turns persist ordered user/agent/system messages and status; interrupted turn recovers as failed/interrupted; restart uses labelled context replay where native resume is absent. |
|  | P3-03 | Read-only session cannot edit; edit session writes only its own worktree; merge requires explicit action and uses integration path; discard is audited and confirmed. |
|  | P3-04 | Layout presets, resize/split/move/swap/maximize/minimize/close/reopen and per-project reload persistence. Failure in one panel does not break another. |
|  | P3-05 | Playwright opens six panels, sends scripted turns to two, reorders panels and reloads; no provider process is spawned except the scripted turn harness. |
| 4 · Builder/runs | P4-01 | Validator rejects malformed nodes/edges, duplicate IDs, missing trigger/provider, cycles, unreachable executable nodes and invalid retry bounds; accepts supported bounded fix back-edge. |
|  | P4-02 | **Golden:** Standard Software Factory template compiles to the exact canonical V1 task graph (roles, keys, kinds, dependencies, order, retries/verification). Snapshot/assert field-by-field; any intentional difference requires decision review, not fixture refresh alone. |
|  | P4-03 | Simulate validates and previews without creating run/tasks or starting provider; run persists immutable workflow snapshot and node/task mapping. |
|  | P4-04 | Scripted run covers fan-out/fan-in, approval, quality fix loop/round cap, cancellation, one-active-run constraint and run-scoped tasks for run ≥ 2 (same keys, `UNIQUE(run_id, key)`). Migration backs up and backfills existing projects. |
|  | P4-05 | Builder tests undo/redo, import/export validation, autosave, disabled planned nodes with reason; Playwright build → validate → simulate → run → timeline. |
| 5 · Projects/tasks/repos | P5-01 | Diff and branch/worktree endpoints use a temp git repo; diff is read-only and matches `git diff`; unknown IDs return bounded errors. |
|  | P5-02 | Requirements, artifacts, run/task filters, milestones only from stored plan fields; empty and failed states do not invent content. |
|  | P5-03 | Playwright opens task drawer, filters task list, inspects output/diff and navigates back without losing selection. |
| 6 · QA/security/logs/providers | P6-01 | Findings JSON parser accepts schema-valid findings and rejects malformed/unstructured verdict as PASS; severity and file/line survive API/UI. |
|  | P6-02 | Scanner reports distinguish passed, failed, not run, unavailable and approval-required; `npm audit` cannot run until approved. Fix action creates a real task. |
|  | P6-03 | Log pagination/filters and 50k-line virtual list; provider detection/usage displays only measured values; Playwright QA center and log search. |
| 7 · Stabilize/release | P7-01 | Full suites, phase Playwright flows, migration rehearsal on copied V1 DB with scheduler disabled, backup existence and rollback drill. |
|  | P7-02 | Repeat performance protocol below; independent security review; keyboard/accessibility and manual screenshot checklist signed off. |
|  | P7-03 | Windows launch/build/test commands and clean shutdown; release acceptance has no unexplained V1 regression or test skip. |

## Mandatory V1 regression suite (`V1-*`, every phase)

| ID | Regression assertions (existing tests unless noted) |
|---|---|
| V1-01 | State machine/DAG validation, planning output parsing, review verdicts, usage parsing and redaction: `server/test/unit.test.ts`. |
| V1-02 | Full Scripted sample lifecycle: approval → parallel implementation → retry → tests → security/review → report; all three fix-loop paths, pause/resume, crash recovery, unavailable real-AI provider: `server/test/workflow.test.ts`. |
| V1-03 | Idle timeout, partial-work preservation, merge conflict resolution and no conflict markers on integration: `server/test/resilience.test.ts`. |
| V1-04 | REST validation, auth, CSRF/content type, secret non-disclosure, protected/approved path import, deletion, fallback/limits, single-instance lock: `server/test/api.test.ts`. |
| V1-05 | Existing Agents, Monitor, Settings behavior and fetch mock contract: all web tests. V1 pages remain reachable throughout migration. |
| V1-06 | SSE replay/reconnect, token, event filtering, redaction and new V1-compatible route behavior: retain current API/event assertions; add explicit replay integration coverage because the inventory identifies it as a gap. |

V1 guarantees grounded in code: mutation origin/content-type checks and SSE replay are in `server/src/api/routes.ts:105,114,121,255-269`; command/git restrictions in `server/src/workspace/git.ts:17`; protected path/import guards in `server/src/workspace/workspaceManager.ts:89-110`; secret scrubbing in `server/src/security/redact.ts:20-34`; recovery and cancellation in `server/src/orchestrator/scheduler.ts:52-63,275-285`; partial work preservation in `server/src/orchestrator/taskRunners.ts:63-85`.

## Performance checks (Phase 7; compare same machine and comparable fixture)

Use a temp test data set with 8 projects, 88 tasks and about 2,652 events, then record five warm runs and report median plus max. Capture process working set (PowerShell `Get-Process`), browser Navigation/Resource Timing and heap, response bytes (`Content-Length` or serialized body), Vite build gzip chunk sizes, and process count. Record machine, Node version, viewport, DB size and agent state. No real providers.

| Metric | Target / pass condition | Measurement |
|---|---|---|
| Idle server working set | ≤150 MB | `Get-Process` after startup/warm-up, no active agent process. |
| Initial JS gzip | ≤160 KB | `npm run build`; sum gzip bytes of shell's initial entry/import graph, exclude lazy routes. |
| Home first data | ≤300 ms localhost | Browser navigation start to first real Home data rendered; 5 warm Scripted-data runs. |
| Largest routine API response | ≤150 KB | Measure overview, usage, health, paginated events, run list and task list; snapshots are not routine dashboard payloads. |
| Idle Home heap | ≤40 MB | Chromium/Edge `performance.memory` when available after load and GC; otherwise record unsupported and use DevTools heap snapshot, do not claim a pass from unavailable data. |
| Eight idle workspace panels | 0 agent processes | OS child-process inspection after layout settles; confirm panels are lazy. |
| 50k log lines | Smooth virtualized scroll | Seed test-only log fixture, scroll top-to-bottom and back; no full 50k-row DOM; record frame/long-task evidence and browser. |

Baseline context/targets: `docs/v2/PERFORMANCE_BASELINE.md`. Treat unavailable browser heap APIs as a measurement limitation, not a numeric pass.

## Security checks

- API: reject cross-origin mutation, non-JSON mutation, missing/invalid bearer token; verify allowed loopback origin behavior and SSE auth/replay handling.
- Secrets: inject recognizable fake tokens into provider settings, errors, events, logs, session output and findings; assert they are redacted and never returned in config/read models.
- Filesystem/git: traversal, symlink escape, protected path and ancestor-of-protected import rejection; only approved roots; session edit writes confined to its worktree; forbidden git subcommands rejected.
- Workflow execution: reject unknown node types/config keys, executable disconnected nodes, unsupported cycles/conditions and over-limit retries; planned nodes remain non-executable with an explanation; no arbitrary shell command or deploy execution.
- Authorization/audit: destructive merge/discard/delete and network scanner require confirmation/approval; audit events record actor/action/result without secret values. PTY remains disabled unless separately approved under D-019.
- Robustness: oversized/paginated requests, malformed graph/import JSON, aborted turns, shutdown and migration failure preserve DB/workspace integrity; migration backup is restorable.

## Accessibility and visual review

- Keyboard paths: Tab/Shift+Tab through shell, sidebar, dialogs, command palette, builder canvas controls, workspace panels and run controls; Enter/Space activate; Escape closes overlays; arrow keys where widgets define them; focus is visible, trapped in modal, restored on close. No keyboard trap.
- Screen reader semantics: landmarks, headings, labels, button names, dialog names, status announcements for run/session changes; status is not color-only. Automated axe scan is optional and advisory; fix serious/critical findings or document a specific exception.
- Contrast: check normal text ≥4.5:1, large text/UI boundaries ≥3:1 against actual dark tokens; inspect semantic status colors and focus rings.
- Manual visual checklist against `docs/v2/reference/01-home-dashboard.webp`, `02-multi-agent-workspace.webp`, `03-workflow-builder.webp`: deep navy shell, sidebar/header hierarchy, spacing/card borders/radii, typography, status colors, panel selection, builder canvas density, responsive fit at 1366×768 and 1920×1080. Verify empty/loading/error states and real-data labels. Images are directional; never gate on pixel diffs or reproduce illustrative screenshot numbers.

## Real-AI smoke (opt-in only)

`scripts/real-ai-smoke.mjs` changes provider/agent configuration unless invoked with `current`, creates a project, starts planning and waits up to 25 minutes. It spends real model quota. Run only with explicit owner approval immediately before invocation; use a low-cost approved model/provider, dedicated disposable data/server, and capture provider/model, run ID, duration, result and reported cost. Do not run in CI or as a phase gate. `current` preserves assignments but still spends quota. The script defaults to `http://127.0.0.1:4317`; set `ASF_URL` to an explicitly approved isolated server. Never put credentials in command arguments or this document.

## Coverage and local Windows commands

New server modules target **≥80% statements, branches, functions and lines** where meaningful; exclude only generated/bootstrap glue with a documented reason. Add per-file coverage thresholds once coverage instrumentation is configured. Critical security, migration, compiler and budget branches require direct tests even if aggregate coverage passes. Current Vitest scripts do not expose coverage yet.

PowerShell, from repository root:

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run test -w @asf/server
npm run test -w @asf/web
```

Planned browser gate after adding `@playwright/test`, config and temp-server fixture: `npx playwright test --project=msedge`. The fixture must select a free port, set `ASF_DATA_DIR` to a fresh temp directory, configure Scripted provider only, wait for readiness, and tear down. For an explicitly approved real-AI smoke only: `$env:ASF_URL='http://127.0.0.1:<isolated-port>'; node scripts/real-ai-smoke.mjs <providerId> <model>`; clear the variable after use.

## Open questions for Opus

- Add a maintained coverage provider/config and decide whether branch or line coverage is the release metric; this plan requires 80% across all four measures.
- Which installed Edge version/build is the minimum supported Playwright channel on the owner's Windows machine?
- Should P7 performance data be retained as a checked-in report artifact or only summarized in the phase report?

## SUMMARY

V1 Vitest suites are the mandatory regression gate at every phase. V2 adds isolated Scripted integration and Edge E2E coverage. Standard workflow compilation has a field-by-field V1 golden test. Phase 7 checks performance, security, accessibility and visual references. Real-AI smoke is owner-approved and quota-spending only.
