# V2 Decisions (log)

Owner of decisions: Opus 5.5 (main session). Workers may propose changes in their report; they do not
change a decision themselves. Status: **proposed 2026-10-16**, awaiting owner approval unless marked.

| ID | Decision | Why (evidence) | Rejected alternatives |
|---|---|---|---|
| D-001 | Evolve V1 in place (same repo, same stack); develop V2 on branch `feature/v2-studio` in a separate git worktree `D:\jarvis 2\asf-v2`, ports 4327/5327, own `ASF_DATA_DIR`. | V1 core is verified with real agents; `ASF_PORT`/`ASF_DATA_DIR` already exist (`server/src/config.ts:59,63`); owner keeps using V1 daily. | New project folder (duplicates the verified engine); editing the running V1 folder directly (breaks daily use). |
| D-002 | Stay a local web app served by the Node server; optional PWA manifest for an app window. No Electron/Tauri in V2.0. | Server idle 98 MB + one browser tab; agents are CLIs spawned by the server anyway; only 3.8 GB RAM free on the owner's PC. | Electron (+250–400 MB, second runtime); Tauri (Rust toolchain + WebView2 build chain, no gain for a localhost tool). |
| D-003 | Keep Fastify, `node:sqlite`, SSE, React 19, Vite, Zustand, Tailwind 4, React Flow. Add only: react-resizable-panels, cmdk, @tanstack/react-virtual, @dagrejs/dagre, @xterm/xterm(+fit), CodeMirror 6 (lazy); dev: @playwright/test on installed Edge. | All small, maintained, MIT/Apache; no native builds (ADR 0001 rule). | Monaco (≈3 MB), chart libraries, MUI/AntD (fight the design system), Redux. |
| D-004 | Hash router with params + `React.lazy` per page. | V1 uses hash views (`store/studio.ts`); single 784 KB chunk today. | React Router data APIs (unneeded weight). |
| D-005 | Workspace panels are **turn-based agent sessions** over the existing `ProviderAdapter`s (headless CLI per turn, native resume where the CLI supports it, otherwise labelled context replay). | Reuses verified flags, parsers, usage capture, limit failover, redaction; structured output gives real status/tools/artifacts; a process lives only during a turn. | Raw interactive TUIs in PTYs as the main mechanism (heavy, unparseable status, interactive permission prompts, native dependency). |
| D-006 | One global `ProcessBudget` (default 3, setting 1–8) shared by scheduler tasks and session turns. | 16 GB RAM, 3.8 GB free; Claude CLI ≈300–500 MB each (to be measured). | Separate limits per subsystem (can exceed RAM together). |
| D-007 | Edit sessions work in their own worktree `asf/<slug>/session-<n>`; merge into integration only by explicit user action via the V1 merge/conflict path; read-only sessions use the integration worktree read-only. | V1 worktree isolation + conflict resolver are verified; the user's checkout is never touched. | Shared working tree with file locks; automatic merges. |
| D-008 | Workflows are stored graph documents compiled onto the V1 task DAG; the built-in "Standard Software Factory" template compiles to the exact V1 graph (golden test). | Keeps one execution engine (scheduler, checkpoints, recovery, fix loop) and V1 behaviour. | A second workflow engine; executing nodes directly from the UI. |
| D-009 (revised 2026-10-16) | `runs` table; `tasks` rebuilt with `run_id NOT NULL`, `node_id`, `UNIQUE(run_id, key)`; one run backfilled per existing project; one active run per project; scheduler/runners/fix loop scoped to the active run (~12 places, `WORKFLOW_ENGINE_SPEC.md` §3). | Code review found the scheduler, gate, status derivation, plan-skip check, architecture prompt, test summary and review diff read **all** project tasks (`scheduler.ts:84-154`, `taskRunners.ts:177,343,362`), so key prefixes alone would break run 2; nothing references `tasks.id` by FK; 88 rows; backup first. | Key prefixes `r<N>.` (needs key parsing everywhere and still needs run scoping). |
| D-010 | Conditions limited to what the backend evaluates truthfully: verification verdicts → bounded fix loop (≤ 5 rounds) and Retry policy; generic expressions are "planned". Compiler rejects other cycles. | No infinite loops; V1 fix loop is tested. | Free-form expression engine in V2.0. |
| D-011 | Metrics honesty: tokens/cost only from `usage_records`; no subscription quota unless a provider reports it; every percentage is a named metric; no demo mode in V2.0 (the scripted sample project remains the safe demo). | Owner requirement §4/§13.16. | Estimated quotas; decorative "health %". |
| D-012 | System metrics from Node `os` + `process`; CPU sampled only while a client subscribes; per-agent RSS sampled at most every 10 s while Workspace/Home is visible. | No new native deps; no idle cost. | `systeminformation` polling (heavy on Windows). |
| D-013 | New read endpoints under `/api/v2/*` with summary payloads and pagination; V1 routes unchanged until Phase 7. | 725 KB snapshot / 157 KB project list today. | Changing V1 routes in place (breaks V1 UI during migration). |
| D-014 | Strangler UI migration: shell + tokens first, V1 pages re-hosted, then replaced page by page; every visible control works or is disabled with a reason. | Keeps the app usable after every phase. | Big-bang UI rewrite. |
| D-015 | Jarvis and ECC are never modified. Optional ECC-router `ProviderAdapter` (calls its public CLI) stays design-only; Jarvis appears only if it exposes a CLI/API, evaluated later. The "Orchestrator" panel is the studio's own scheduler. | Owner rule; V1 `ARCHITECTURE.md` "ECC / Jarvis". | Faked Jarvis/ECC panels. |
| D-016 | Quality via a `QualityScanner` adapter + JSON findings schema; built-ins: test runner, security agent (structured findings), `npm audit --json` (allowlisted, approval for network). Guardian plugs in later. Unrun scanner ≠ PASS. | Owner §8. | Showing PASS without a run. |
| D-017 | Tests: vitest (server, web), Playwright E2E against a temp-data test server with the Scripted provider (no real quota) on installed Edge; reference screenshots are a manual review aid, not a pixel gate. | Real usability over pixel copy (owner §11). | Pixel-diff gating. |
| D-018 | Forward-only additive migrations; automatic `VACUUM INTO data/backups/studio-before-v<N>.db` before each; rollback = V1 tag + that backup. | Proven today (`backups/asf-v1-2026-10-16/studio.db`). | Down-migrations. |
| D-019 | Interactive PTY terminal (xterm.js + prebuilt ConPTY binding) is optional Phase 3b, off by default, user-initiated, loopback-only, worktree-scoped, logged; needs owner approval for the native dependency. | Owner wants terminals; security rule "no arbitrary untrusted execution". | PTY for agents; terminals reachable remotely. |
| D-020 | Git baseline: `git init` the studio folder, commit V1 as `chore: V1 baseline`, tag `v1.0.0`, then branch/worktree for V2. Needs owner approval (first commit). | Folder is not a git repo today; a branch/worktree workflow needs one. File backup already exists. | Developing without version control. |

## Answers to worker open questions (Opus, 2026-10-16)

| Question (doc) | Answer |
|---|---|
| Avatar/profile block (DESIGN_SYSTEM, PRD) | No avatar or role. Header shows a display name from Settings, default = Windows user name. |
| 44 px touch targets (DESIGN_SYSTEM) | No — desktop app. Minimum hit area 28 px (compact) / 32 px (comfortable); icon buttons 32 px. |
| Reviewer hue pink vs blue (DESIGN_SYSTEM) | Keep V1 role hues (users know them); adjust lightness for AA. Provider identity is shown by a provider icon/chip, not by the role hue. |
| Primary button contrast (Opus addition) | Saturated fill gradient `#2563EB → #4F46E5` with white text (≥ 4.5:1); pastel accent tokens are for text/borders only. |
| "Delivery" naming (PRD) | UI says "Delivery report (approved)" until a deploy capability exists; Deploy node stays planned. |
| Interactive terminal timing (PRD) | Phase 3c, optional; decided by the owner at the Phase 3 review (D-019). |
| Coverage provider (TEST_PLAN) | Add `@vitest/coverage-v8` (dev) in Phase 1; release metric = line coverage ≥ 80 % for new server modules; branch coverage reported only. |
| Minimum Edge version (TEST_PLAN) | Whatever stable Edge is installed; Phase 1 records the version in `TEST_PLAN.md`. |
| Where P7 performance data lives (TEST_PLAN) | Checked in as `docs/v2/PERFORMANCE_RESULTS.md` next to the baseline. |

## Phase 4 additions (Opus, 2026-10-17)
P4-1…P4-5 are recorded in `docs/v2/phases/PHASE_4.md` (migration index 3 = spec "v6"; new repositories in
`runRepositories.ts`; no dagre (own layered layout); run status mirrors the project status, with
`completed_with_failures` only for tolerated failures; V1 "Start planning" = `RunService.start(wf-standard)`).
P4-6: a completed run stays completed if the project is later cancelled/failed; only a retry reopens it.
P4-7: the artifact node has no file-name field (the report runner writes a fixed file).

## V2.1 additions (Opus, 2026-10-17, owner approved "hammasiga ruhsat")
| ID | Decision | Why | Rejected |
|---|---|---|---|
| D-021 | D-019 accepted and built: `@lydell/node-pty` (prebuilt ConPTY, installed with `--ignore-scripts`, verified on Node 24) + `@fastify/websocket` + `@xterm/xterm`. A terminal opens only from the **Terminal tab of an edit session** (its own worktree), never for read-only sessions (they share the integration worktree); max 2; idle kill 15 min; env = `commandEnv()` (secrets stripped); killed before the session worktree is removed; WebSocket Origin checked in the route (the upgrade is a GET), Host/token by the global hook; `audit.terminal.opened/closed` with the redacted transcript (≤ 64 KB). The disabled toolbar button is gone. | A terminal that can change the shared integration worktree would bypass the merge path; per-session worktrees keep the V1 safety model. | Terminal for read-only sessions or the project root; SSE+POST transport. |
| D-022 | P7-S8: package installs (`npm ci/install/i`, `pnpm install/i`, `yarn install`) always run with `--ignore-scripts` unless the owner allows scripts for that project (Project → Settings, confirm dialog, `audit.install_scripts`). Setting key `project:installScripts:<id>` in `settings`, no migration. | Lifecycle scripts run with the owner's file access; most projects install fine without them. | Global switch; per-command approvals. |
| D-023 | Payload: `GET /api/projects/:id` returns history events without the `data.project` / `data.task` copies (`slimHistoryEvent`); live SSE events and `/api/v2/events` (Logs detail view) keep full data. Real DB: 701 KB → 273 KB. | The snapshot already holds the current project and tasks; nothing reads those copies from history. | Removing the snapshot from the V2 shell (large refactor of V1 board/monitor pages). |
