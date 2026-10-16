# V1 audit — AI Software Factory Studio

## 1. Summary

V1 is a working local orchestration application: a React dashboard controls a single Fastify process, SQLite-backed tasks, real CLI/API provider turns, git worktrees, tests, approvals and bounded fix loops (`server/src/app.ts:29`, `server/src/orchestrator/taskRunners.ts:394`). It is not yet an interactive agent workspace: there is no PTY, persistent provider session, editable workflow definition or independent run entity (`server/src/workspace/processRunner.ts:94`, `server/src/db/database.ts:3`, `web/src/components/WorkflowGraph.tsx:137`). V2 should preserve those execution primitives while fixing the concrete ordering, containment and disclosure problems below before expanding access or autonomy.

**Scope and method, 2026-10-16:** Read the four requested documents first; inspected source, manifests/lockfile, scripts and existing build assets. No `.context/` or applicable `AGENTS.md` was found; this supplied folder has no root git repository, so no commit-history comparison was possible. No secrets, `.env` values, live database records or external assistant configuration contents were read. This report is the only file written.

**Validation:** Both `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` and the equivalent web command exited 0. Source-import probes using SQLite `:memory:`, Fastify injection and a virtual filesystem confirmed the findings marked **probe** below; no provider was invoked or HTTP listener opened. Full Vitest, build and paid smoke runs were not executed: they create artifacts/workspaces, and test helpers default to OS temporary directories (`server/test/helpers.ts:8`). Existing build measurements are not a new-build guarantee.

## 2. Architecture analysis

### 2.1 Stack and versions — Q1

Versions below are resolved lockfile versions, not claims about current upstream releases. Workspace packages are all `0.1.0`; npm workspaces are `shared`, `server`, `web` (`package.json:3`, `package.json:6`).

| Layer | Verified implementation and version | Evidence |
|---|---|---|
| Frontend | React/React DOM 19.3.1; TypeScript 5.9.3; Zustand 5.0.15; React Flow (`@xyflow/react`) 12.12.0 | `package-lock.json:5952`, `package-lock.json:5961`, `package-lock.json:6707`, `package-lock.json:7220`, `package-lock.json:3007` |
| UI | Tailwind CSS 4.3.3; lucide-react 1.57.0; Radix Dialog 1.3.1/Tabs 1.2.1; react-markdown 10.1.0 + remark-gfm 4.0.1; CVA/clsx/tailwind-merge helpers | `web/package.json:13`, `package-lock.json:1394`, `package-lock.json:1716`, `package-lock.json:4733`, `package-lock.json:5981`, `package-lock.json:6093`, `package-lock.json:6505` |
| Backend | Fastify 5.12.7, `@fastify/static` 8.3.0, Zod 3.25.76, tsx 4.23.15; ESM TypeScript executed directly, no server compilation stage | `server/package.json:5`, `package-lock.json:3946`, `package-lock.json:1146`, `package-lock.json:7211`, `package-lock.json:6689` |
| Database | Built-in synchronous `node:sqlite`; WAL, foreign keys, 5 s busy timeout; two migrations, no ORM | `server/src/db/database.ts:1`, `server/src/db/database.ts:114`, `server/src/db/database.ts:119` |
| Build | Vite 7.3.7 + React plugin 5.2.0 + Tailwind Vite plugin; web build first runs `tsc --noEmit`; shared exports TS source directly | `package-lock.json:6936`, `package-lock.json:2871`, `web/package.json:8`, `web/vite.config.ts:9`, `shared/package.json:6` |
| Tests | Vitest 3.2.7; web jsdom 30.1.3 + Testing Library React 16.3.3; server forks, test files sequential | `package-lock.json:7034`, `package-lock.json:4321`, `package-lock.json:2634`, `server/vitest.config.ts:4`, `web/vitest.config.ts:8` |
| Runtime | Manifest requires Node `>=22.13`; ADR specifies Node 24. Observed audit runtime: Node 24.19.0, npm 11.17.0, embedded SQLite 3.53.3. Locked jsdom requires `^22.22.2 || ^24.15.0 || >=26.0.0`, so the advertised floor is insufficient for the complete toolchain | `package.json:7`, `docs/adr/0001-single-process-sqlite-worktrees.md:10`, `package-lock.json:4321`; read-only version probes |
| Launch | `npm start` rebuilds web then runs server through tsx; dev spawns tsx watch + Vite; Windows launcher changes into this directory and calls `npm.cmd start` | `package.json:9`, `server/package.json:7`, `scripts/dev.mjs:8`, `start-studio.cmd:5` |

### 2.2 Frontend — Q2

The SPA mounts in React StrictMode. Nine views are selected by a hand-written hash router (`#/dashboard`, `#/monitor`, `#/projects`, `#/agents`, `#/workflows`, `#/files`, `#/logs`, `#/providers`, `#/settings`); invalid hashes fall back to Dashboard. There is no router library or URL-addressable project/task/session route (`web/src/main.tsx:6`, `web/src/store/studio.ts:8`, `web/src/store/studio.ts:69`, `web/src/store/studio.ts:185`).

| View | Implemented responsibility | Evidence |
|---|---|---|
| Dashboard | Selected project, task counts, seven role cards, task/agent dependency graph | `web/src/pages/Dashboard.tsx:27` |
| Live monitor | Cross-project running tasks, queue/plan gates, provider usage today, 12 recently finished tasks | `web/src/pages/Monitor.tsx:169`, `server/src/orchestrator/liveMonitor.ts:20` |
| Projects | New/sample/import, copy vs git-worktree import, folder approval, requirements upload, spec/plan/report viewing, deletion | `web/src/pages/Projects.tsx:23`, `web/src/pages/Projects.tsx:95`, `web/src/components/FolderPicker.tsx:77` |
| Agents | Global role-to-provider/model/effort/fallback configuration, custom model text, real saved-config test call | `web/src/pages/Agents.tsx:22`, `web/src/pages/Agents.tsx:137`, `server/src/api/routes.ts:62` |
| Workflows | Read-only dependency graph and task table with retry/cancel; no workflow authoring | `web/src/pages/Workflows.tsx:30`, `web/src/components/WorkflowGraph.tsx:135` |
| Files | Integration tree, changed-file filtering, text/Markdown preview, binary/truncation notices; no editor | `web/src/pages/Files.tsx:70`, `web/src/pages/Files.tsx:111`, `web/src/pages/Files.tsx:183` |
| Logs | Persisted history + SSE events, filters, follow mode, JSON export; latest 800 rendered rows | `web/src/pages/Logs.tsx:43`, `web/src/pages/Logs.tsx:78`, `web/src/pages/Logs.tsx:97` |
| Providers | Detection/enabling, lifetime provider budgets, safe settings, aggregate usage fetched on page mount | `web/src/pages/Providers.tsx:21`, `web/src/pages/Providers.tsx:133` |
| Settings | Execution limits, fallback ordering, approved-root removal, server details and token sign-out | `web/src/pages/Settings.tsx:16`, `web/src/pages/Settings.tsx:140` |

One Zustand store mixes server snapshots, project selection, events, chat, provider state, errors and layout. It applies SSE patches, refreshes snapshots after 600 ms, refreshes live state after 400 ms of relevant events and polls `/api/live` every 3 s; events are capped at 1,500. Project selection and access token live in localStorage; most other UI state is ephemeral (`web/src/store/studio.ts:17`, `web/src/store/studio.ts:103`, `web/src/store/studio.ts:193`, `web/src/lib/api.ts:1`).

Shared components include Sidebar/TopBar, AgentCard, WorkflowGraph, FolderPicker, Markdown, Radix-backed Dialog and form/status primitives. RightPanel appears only on Dashboard/Workflows and contains details, chat, logs and approvals (`web/src/App.tsx:48`, `web/src/components/layout/RightPanel.tsx:211`, `web/src/components/ui/primitives.tsx:24`).

Styling uses Tailwind v4 `@theme`: ink backgrounds `#0a1020`…`#1e2b49`, line/line-soft, text/muted/faint, brand `#6d8cff`, brand-2 `#3fd0d4`, and named status colors. Instrument Sans/JetBrains Mono are requested from Google Fonts. Actual body size is 14 px, with radial gradients, visible focus and reduced-motion rules (`web/src/index.css:3`, `web/src/index.css:39`, `web/index.html:7`).

**Bundle:** All nine pages are eagerly imported; no dynamic imports, manual chunking or route splitting was found (`web/src/App.tsx:9`, `web/vite.config.ts:8`). Existing `web/dist/index.html:10` loads one JS asset: **783,767 bytes / 244,979 gzip**; one CSS asset is **54,642 bytes / 10,137 gzip**, measured from the referenced files. This is a single application JS chunk, not nine page chunks.

### 2.3 Backend, validation, SSE and instance ownership — Q3

`createStudio` wires config → instance lock → SQLite/repositories → event stream/provider registry/workspace/executor → scheduler/ProjectService → Fastify. Fastify has a 2 MiB body limit, optional built static assets and an SPA fallback. Approval handling is inside ProjectService and task runners; there is no separate `ApprovalService` implementation (`server/src/app.ts:29`, `server/src/api/routes.ts:273`, `server/src/orchestrator/projectService.ts:79`).

All **32 explicit routes** in `server/src/api/routes.ts` are listed below. Framework-generated HEAD/static handling is additional.

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/api/info` | Version, host/port, auth-required flag, approved paths, commands and settings | `server/src/api/routes.ts:137` |
| PUT | `/api/settings` | Validate/merge global execution settings, tick scheduler | `server/src/api/routes.ts:141` |
| GET | `/api/providers` | Provider detection/config/usage; `refresh=1` bypasses detection cache | `server/src/api/routes.ts:149` |
| PATCH | `/api/providers/:providerId` | Enable/disable, budget and safe provider settings | `server/src/api/routes.ts:150` |
| GET | `/api/usage` | Lifetime aggregates grouped by provider/model | `server/src/api/routes.ts:157` |
| GET | `/api/agents/config` | Global configurations for the seven roles | `server/src/api/routes.ts:158` |
| POST | `/api/agents/:role/test` | Fixed arithmetic probe on exact saved assignment, no fallback | `server/src/api/routes.ts:160` |
| PUT | `/api/agents/:role/config` | Save provider/model/effort/fallback for a role | `server/src/api/routes.ts:171` |
| GET | `/api/live` | Cross-project monitor snapshot | `server/src/api/routes.ts:181` |
| GET | `/api/fs/roots` | Drives, user-approved roots and protected paths | `server/src/api/routes.ts:186` |
| GET | `/api/fs/list` | List subdirectories/git badges for absolute `path` | `server/src/api/routes.ts:189` |
| POST | `/api/fs/approved-roots` | Approve an import root and persist it | `server/src/api/routes.ts:190` |
| POST | `/api/fs/approved-roots/remove` | Revoke a persisted root approval | `server/src/api/routes.ts:196` |
| GET | `/api/samples` | Available sample names/specifications | `server/src/api/routes.ts:205` |
| GET | `/api/projects` | All project records | `server/src/api/routes.ts:206` |
| POST | `/api/projects` | Create workspace/import/sample, project and integration worktree; 201 | `server/src/api/routes.ts:207` |
| GET | `/api/projects/:id` | Project/tasks/agents/approvals/recent-events snapshot | `server/src/api/routes.ts:208` |
| POST | `/api/projects/:id/plan` | Start the initial planning pipeline | `server/src/api/routes.ts:209` |
| POST | `/api/projects/:id/pause` | Stop dispatching; drain running work | `server/src/api/routes.ts:210` |
| POST | `/api/projects/:id/resume` | Resume a paused project | `server/src/api/routes.ts:211` |
| POST | `/api/projects/:id/cancel` | Abort active tasks and cancel queued tasks | `server/src/api/routes.ts:212` |
| POST | `/api/projects/:id/delete` | Remove stopped project's owned files/records; preserve external repo | `server/src/api/routes.ts:213` |
| GET | `/api/projects/:id/report.md` | Download stored Markdown report | `server/src/api/routes.ts:214` |
| GET | `/api/projects/:id/events` | Project event history filtered by limit/level/taskId | `server/src/api/routes.ts:220` |
| GET | `/api/projects/:id/files` | List integration/workspace files | `server/src/api/routes.ts:226` |
| GET | `/api/projects/:id/file` | Read relative `path`, with binary/truncation flags | `server/src/api/routes.ts:230` |
| GET | `/api/projects/:id/agents/:role/messages` | Last 200 persisted messages for project/role | `server/src/api/routes.ts:235` |
| POST | `/api/projects/:id/agents/:role/messages` | Start asynchronous readonly chat; 202 | `server/src/api/routes.ts:240` |
| POST | `/api/tasks/:id/retry` | Manually retry failed/cancelled task | `server/src/api/routes.ts:248` |
| POST | `/api/tasks/:id/cancel` | Abort/cancel a task | `server/src/api/routes.ts:249` |
| POST | `/api/approvals/:id/decision` | Approve/reject with optional note | `server/src/api/routes.ts:250` |
| GET | `/api/events` | SSE, optional project filter, cursor replay | `server/src/api/routes.ts:256` |

Zod validates creation/config/settings/chat/approval bodies, UUIDs and roles; unknown provider IDs are rejected. Bounds include 200,000 specification characters, 8,000 chat characters, parallelism 1–8, attempts 1–5 and fix rounds 0–5. Validation is manual rather than shared runtime response schemas; some queries (`limit`, `after`, `projectId`) are casts/coercions, not fully validated (`server/src/api/routes.ts:20`, `server/src/api/routes.ts:127`, `server/src/api/routes.ts:220`).

SSE persists redacted events before broadcasting, sends `id` + `event: studio`, uses `Last-Event-ID` or `after`, requests 2 s retries and emits 20 s heartbeats. Replay returns at most 1,000 events once; writes ignore backpressure. Disconnect removes the subscription (`server/src/events/eventStream.ts:23`, `server/src/events/eventStream.ts:48`, `server/src/api/routes.ts:256`).

`data/studio.pid` is exclusively created with `wx`; live foreign PIDs get 5 s grace, stale PIDs are replaced, and release verifies ownership. The production entry point binds before recovery; `createStudio` itself defaults to immediate recovery unless deferred. This is single-host/process coordination, not a distributed lease (`server/src/instanceLock.ts:21`, `server/src/index.ts:7`, `server/src/index.ts:15`, `server/src/app.ts:54`).

### 2.4 Orchestration — Q4

| Mechanism | Actual behavior | Evidence |
|---|---|---|
| Scheduler | Synchronous DB graph evaluation, asynchronous dispatch; one global active-task cap (default 2), not per-role/provider. Active projects scanned on ticks; no external queue, fairness policy or scheduled retry timer | `server/src/orchestrator/scheduler.ts:72`, `server/src/orchestrator/scheduler.ts:87`, `server/src/orchestrator/context.ts:9` |
| State machine | `pending→ready→running→completed/failed`; pending may block; gate `ready→waiting_approval→completed/failed`; failed/cancelled can retry, blocked can return pending. Transitions checked by scheduler; repository updates remain available to recovery/fix logic | `server/src/domain/taskStateMachine.ts:3`, `server/src/orchestrator/scheduler.ts:37`, `server/src/db/repositories.ts:139` |
| Graph | Fixed `plan→architecture→plan-approval`; PM supplies 1–20 backend/frontend/QA tasks with keys/dependencies. Zod + duplicate/unknown/cycle checks; roots depend on approval. Append QA only if no QA task exists; always append security→review→report. Dynamic within a fixed pipeline, not a visual-workflow engine | `server/src/orchestrator/projectService.ts:62`, `server/src/agents/parsers.ts:24`, `server/src/domain/taskGraph.ts:4`, `server/src/orchestrator/taskRunners.ts:102` |
| Checkpoints | `none→worktree→agent_done→committed→merged`; branches/checkpoints persisted. Interrupted edits saved as WIP with `partial:<taskId>`; next attempt uses that branch and a continuation prompt | `server/src/orchestrator/taskRunners.ts:53`, `server/src/orchestrator/taskRunners.ts:175`, `server/src/workspace/workspaceManager.ts:257` |
| Recovery | Only a merged **implement** task is auto-completed; others save partial work, remove worktree and return ready. Merged QA re-executes, rather than assuming tests passed. Active projects resume; paused projects stay paused | `server/src/orchestrator/scheduler.ts:53` |
| Pause/resume/cancel | Pause drains existing work; resume accepts paused only. Cancellation aborts process trees; completed work remains. Manual retry increases attempt allowance and unblocks descendants. Shutdown aborts and waits at most 10 s | `server/src/orchestrator/scheduler.ts:230`, `server/src/orchestrator/scheduler.ts:260`, `server/src/orchestrator/scheduler.ts:287`, `server/src/workspace/processRunner.ts:55` |
| Approvals | User plan gate; unsupported test commands create command approvals and fail the task until approved/retried. Approved command strings persist per project. `delivery` exists in shared types but no delivery gate is created | `server/src/orchestrator/projectService.ts:79`, `server/src/orchestrator/taskRunners.ts:331`, `shared/src/index.ts:105` |
| Fix loop | Failed tests or last parsed `VERDICT: FAIL` insert `fix-<task>-<round>` transactionally, inherit dependencies and put verification behind the fix. Budget is **per verification task**, default 2. Frontend-only test findings route to frontend, otherwise backend; QA reruns existing tests; review fixes rerun tests before review | `server/src/orchestrator/fixLoop.ts:14`, `server/src/orchestrator/fixLoop.ts:36`, `server/src/orchestrator/taskRunners.ts:344`, `server/src/orchestrator/taskRunners.ts:361`, `server/src/agents/parsers.ts:59` |
| Integration/conflicts | Per-project promise mutex serializes document commits, merges and test commands; separate repository mutex covers task-worktree add/remove. Failed integration merge aborts; merge integration into task, ask same role to resolve, reject leftover markers, commit/retry up to two conflict-resolution rounds | `server/src/orchestrator/context.ts:19`, `server/src/orchestrator/taskRunners.ts:232`, `server/src/orchestrator/taskRunners.ts:278`, `server/src/orchestrator/taskRunners.ts:316`, `server/src/workspace/workspaceManager.ts:265` |
| Monitor/report | Monitor derives from task/event/usage rows (including test/report tasks, not just a live CLI PID). Today means server-local midnight. Report is deterministic Markdown from DB/git, written to DB and integration `ASF_REPORT.md` | `server/src/orchestrator/liveMonitor.ts:7`, `server/src/orchestrator/liveMonitor.ts:20`, `server/src/reports/reportGenerator.ts:15`, `server/src/orchestrator/taskRunners.ts:384` |

Idle timeout defaults to 15 min; hard timeout defaults to 120 min **per adapter invocation**, so failover/conflict turns can extend a whole task beyond that. Idle watchdog runs only for adapters declaring `reportsActivity` (Claude, Codex, Antigravity); normal failures retry without backoff and do not automatically switch providers (`server/src/orchestrator/context.ts:9`, `server/src/agents/agentExecutor.ts:93`, `server/src/agents/agentExecutor.ts:109`, `server/src/orchestrator/scheduler.ts:197`).

### 2.5 Providers and process/session behavior — Q5

Arguments below are the source's actual construction; `<...>` denotes a substituted value, square brackets optional arguments, and mode alternatives are explicit. No live login/model availability was reverified.

| Provider | Invocation / transport | Evidence |
|---|---|---|
| Claude Code, all accounts | `claude -p --output-format stream-json --verbose --model <model> --permission-mode <acceptEdits or default> --allowedTools <Read,Edit,Write,Glob,Grep or Read,Glob,Grep> --disallowedTools Bash,WebFetch,WebSearch --setting-sources project,local --no-session-persistence [--effort <effort>] --append-system-prompt <guard+role>`; prompt on stdin | `server/src/providers/cliProviders.ts:85` |
| Codex CLI | `codex exec --json --skip-git-repo-check --sandbox <workspace-write or read-only> [-m <model>] [-c model_reasoning_effort=<effort>] -`; guard/role/prompt on stdin; no explicit approval-policy argument; edit prompt permits project build/test commands | `server/src/providers/cliProviders.ts:207` |
| Antigravity | `agy --model <model> --output-format json --print-timeout <seconds>s --log-file <temp-log> [--mode accept-edits] -p <prompt>`; `-p` last. Timeout is max(60, hard-seconds−15). Prompts over 6,000 characters use `.asf-agy-task-<id>.md` inside cwd; temp log growth polled every 15 s; both files removed afterward. Readonly omits `--mode` rather than specifying a readonly sandbox | `server/src/providers/cliProviders.ts:273`, `server/src/providers/cliProviders.ts:307` |
| Gemini CLI | `gemini --model <model> --approval-mode <auto_edit or default> -p "Follow the instructions given on standard input."`; guard/role/prompt on stdin; plain stdout, no JSON usage flag or explicit shell-tool exclusion | `server/src/providers/cliProviders.ts:381` |
| OpenAI-compatible HTTP | Authenticated `GET <base>/models` for detection (5 s timeout); `POST <base>/chat/completions` with model and system/user messages, combined abort/timeout. No streaming/tools/effort parameter; returned JSON file-edit protocol applied by studio | `server/src/providers/apiProviders.ts:23`, `server/src/providers/apiProviders.ts:48`, `server/src/orchestrator/taskRunners.ts:197` |
| Scripted | In-process `.asf-script.json` replay: plan, architecture, task files/text, optional delay/failAttempts and canned chat. Explicitly `isAi=false`; absent script/task fails; git and verification commands still real | `server/src/providers/apiProviders.ts:110`, `scripts/build-sample-script.mjs:25` |

Claude accounts 2–4 are always registered; 5–9 appear if their `~/.claude-account<N>` directory exists at registry construction. The same `claude` executable receives `CLAUDE_CONFIG_DIR` and `CLAUDE_ACCOUNT`; saved `configDir` overrides the default. Extra accounts require a credentials-file existence check, not credential inspection; all CLI detection is PATH resolution + `--version` (20 s), with a 60 s cache (`server/src/providers/registry.ts:27`, `server/src/providers/registry.ts:93`, `server/src/providers/cliProviders.ts:11`, `server/src/providers/cliProviders.ts:66`).

| Models / controls | Actual support | Evidence |
|---|---|---|
| Claude | Static `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `opus`, `sonnet`, `haiku`; default Sonnet; effort passed unchanged | `server/src/providers/cliProviders.ts:58`, `server/src/providers/cliProviders.ts:93` |
| Codex | Static `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`; default Sol; low/medium/high/xhigh, with max mapped to xhigh | `server/src/providers/cliProviders.ts:190` |
| Antigravity | Static Gemini 3.8 Flash high/medium, Claude Sonnet 4.6/Opus 4.6 thinking; `agy models` overrides list for account and enforces membership; no effort flag | `server/src/providers/cliProviders.ts:289`, `server/src/providers/cliProviders.ts:294`, `server/src/providers/cliProviders.ts:325` |
| Gemini / HTTP / Scripted | Gemini 2.5 Pro/Flash (default Pro); HTTP gpt-4.1/gpt-4.1-mini (default mini); Scripted replay. No effort support. HTTP detection checks reachability without importing returned model IDs | `server/src/providers/cliProviders.ts:388`, `server/src/providers/apiProviders.ts:18`, `server/src/providers/apiProviders.ts:38`, `server/src/providers/apiProviders.ts:116` |

Provider settings can override displayed comma-separated models. Agent configs accept custom IDs; fallback preserves a requested model only when present in the adapter's **static** model list. Fresh AI providers are disabled; Scripted alone starts enabled. Default role configs select Claude (PM/Architect Opus/high, others Sonnet); live handoff assignments are not factory defaults (`server/src/providers/registry.ts:62`, `server/src/providers/registry.ts:108`, `server/src/providers/registry.ts:166`).

Usage: Claude captures input plus cache-read/cache-creation tokens, output, optional thinking tokens, reported USD and main model inferred by greatest output tokens. Codex captures input/output/reasoning tokens, no USD or actual model; Antigravity captures optional usage fields with zero defaults; Gemini returns null usage; HTTP captures input/output only; Scripted emits zero usage. Only successful result usage is recorded; SQLite drops reasoningTokens. Executor falls back to the requested model when none is reported, so monitor model/effort are not always measured facts (`server/src/providers/cliProviders.ts:119`, `server/src/providers/cliProviders.ts:241`, `server/src/providers/cliProviders.ts:355`, `server/src/providers/apiProviders.ts:73`, `server/src/agents/agentExecutor.ts:125`, `server/src/db/repositories.ts:330`).

Limit failover catches only `ProviderLimitError`: CLI error text/429/quota heuristics park a provider until parsed local reset time, default one hour, then re-route the turn in the same worktree. Cooldowns are memory-only; all-unusable raises permanent `NoProviderError`, with no reset-time wakeup. HTTP 429 produces ordinary retryable `ProviderError`, so it **does not** use limit failover. Budgets check lifetime recorded USD before a call, with no reservation for concurrent/in-flight cost (`server/src/providers/types.ts:65`, `server/src/agents/agentExecutor.ts:45`, `server/src/providers/registry.ts:47`, `server/src/providers/registry.ts:150`, `server/src/providers/apiProviders.ts:67`, `server/src/orchestrator/scheduler.ts:197`).

**Real processes, no interactive subsystem:** CLI adapters spawn child processes with piped stdin/stdout/stderr, close stdin after sending the initial prompt, cap each output stream at 2 MiB, and kill process trees on abort/timeout. Windows batch shims use a guarded `cmd.exe` bridge. No PTY, terminal input/resize API, xterm, WebSocket or persistent process/session ID exists in the inspected implementation. Claude explicitly disables session persistence; other adapters never pass a resume argument. `task.resume` means git partial-work continuation, not provider conversation/session resume (`server/src/workspace/processRunner.ts:67`, `server/src/workspace/processRunner.ts:73`, `server/src/workspace/processRunner.ts:94`, `server/src/workspace/processRunner.ts:128`, `server/src/providers/cliProviders.ts:92`, `server/src/orchestrator/taskRunners.ts:183`).

### 2.6 Agent chat — Q6

Chat is project-and-role scoped: POST persists the user message, returns 202, launches a fresh readonly executor turn against the integration directory, and persists reply/error with SSE notification. One in-memory busy key prevents overlapping messages for the same project/role; timeout is five minutes. It loads 20 stored messages but prompts only the last ten plus task/status context; GET returns the last 200. MessageRepository redacts content before storage (`server/src/orchestrator/projectService.ts:158`, `server/src/agents/prompts.ts:122`, `server/src/db/repositories.ts:258`).

Readonly is provider-dependent: Claude gets read tools, Codex gets its readonly sandbox but no shell exclusion; Antigravity/Gemini use default permission modes plus prompt instructions; HTTP/Scripted edits are not applied by the chat path. Thus UI text “Chat cannot run commands” is stronger than enforcement. Chat does not steer a running task, has no durable turn/session status, and is outside scheduler concurrency/cancellation/shutdown tracking (`server/src/providers/cliProviders.ts:86`, `server/src/providers/cliProviders.ts:208`, `server/src/providers/cliProviders.ts:329`, `server/src/providers/cliProviders.ts:396`, `server/src/orchestrator/projectService.ts:169`, `web/src/components/layout/RightPanel.tsx:105`).

### 2.7 SQLite schema and storage — Q7

Complete schema after migration 2; columns below use SQL names. JSON is stored as TEXT, not separate relational entities. Migrations live inside `database.ts`; `schema_version` is created before them, and each migration uses `BEGIN IMMEDIATE`/commit/rollback (`server/src/db/database.ts:3`, `server/src/db/database.ts:119`).

| Table | Every column | Evidence |
|---|---|---|
| projects | id, name, slug, description, spec, status, workspace_mode, workspace_path, integration_path, integration_branch, base_commit, test_command, plan_md, report_md, created_at, updated_at | `server/src/db/database.ts:4` |
| tasks | id, project_id, key, title, description, role, kind, status, depends_on, order_index, attempt, max_attempts, checkpoint, branch, worktree_path, provider_id, model, result_summary, error, files_changed, test_result, usage, started_at, finished_at, updated_at | `server/src/db/database.ts:22` |
| events | id, project_id, task_id, role, type, level, message, data, created_at | `server/src/db/database.ts:51` |
| approvals | id, project_id, task_id, kind, status, title, details, note, created_at, decided_at | `server/src/db/database.ts:63` |
| agent_messages | id, project_id, role, task_id, direction, content, created_at | `server/src/db/database.ts:75` |
| agent_configs | role, provider_id, model, allow_fallback, effort | `server/src/db/database.ts:85`, `server/src/db/database.ts:114` |
| provider_configs | id, enabled, settings, budget_usd | `server/src/db/database.ts:91` |
| usage_records | id, project_id, task_id, role, provider_id, model, input_tokens, output_tokens, cost_usd, created_at | `server/src/db/database.ts:97` |
| settings | key, value | `server/src/db/database.ts:109` |
| schema_version | version | `server/src/db/database.ts:122` |
| sqlite_sequence (SQLite internal) | name, seq | Created by AUTOINCREMENT declarations, e.g. `server/src/db/database.ts:52`; confirmed in in-memory schema |

Projects use UUID PKs/unique slug; tasks have UUID PK and unique `(project_id,key)`. Tasks, approvals and messages cascade on project deletion; events/usage have no FK. Explicit indexes cover tasks(project_id,status), events(project_id,id), messages(project_id,role,id). Deletion explicitly removes project events, retains usage for budgets, and leaves auxiliary settings (`server/src/db/database.ts:4`, `server/src/db/database.ts:48`, `server/src/db/database.ts:62`, `server/src/db/database.ts:84`, `server/src/db/repositories.ts:75`).

| Location | Contents / lifecycle | Evidence |
|---|---|---|
| `data/studio.db`, `-wal`, `-shm`; `data/studio.pid` | Database/journal/shared memory and instance ownership; data root configurable | `server/src/config.ts:59`, `server/src/db/database.ts:121`, `server/src/instanceLock.ts:22` |
| `data/workspaces/<slug>/` | Studio-owned new/sample/copied repositories; initial SPEC/.gitignore where applicable | `server/src/workspace/workspaceManager.ts:138`, `server/src/workspace/workspaceManager.ts:148`, `server/src/workspace/workspaceManager.ts:160` |
| `data/worktrees/<projectId>/integration`, `<taskKey>-a<attempt>` | Integration tree plus temporary attempt trees; git branches remain after worktree removal | `server/src/workspace/workspaceManager.ts:245`, `server/src/workspace/workspaceManager.ts:257`, `server/src/workspace/workspaceManager.ts:269` |
| `data/agent-test/` | Shared scratch directory for agent arithmetic probes | `server/src/api/routes.ts:75` |
| settings JSON rows | `studio`, `approvedRoots`, `approvedCommands:<projectId>`, `fixRounds:<projectId>:<taskKey>`, `partial:<taskId>` | `server/src/api/routes.ts:143`, `server/src/api/routes.ts:185`, `server/src/orchestrator/projectService.ts:97`, `server/src/orchestrator/fixLoop.ts:15`, `server/src/orchestrator/taskRunners.ts:53` |

There are no runs, attempts-history, workflow-definitions or provider-sessions tables: retries overwrite task timestamps/results, while events/usage append. Process controllers, locks, chat busy flags, detection cache and cooldowns are memory-only. External CLI login/config state remains outside `data/`; Antigravity logs use OS temp. An existing `data/test-tmp/` was observed, but it is not a production persistence contract (`server/src/db/database.ts:3`, `server/src/orchestrator/scheduler.ts:144`, `server/src/providers/registry.ts:45`, `server/src/providers/cliProviders.ts:314`).

### 2.8 Workspace and git safety — Q8

Branch import works from the repository's committed HEAD, preserving the user's checkout but adding refs/worktree metadata. Integration is `asf/<slug>/integration`; attempts are `asf/<slug>/<taskKey>-a<attempt>`. Copy import measures 20,000 files/500 MiB and skips `.git`, node_modules, dist, build, target, .next and coverage; no automatic dependency-install stage exists (`server/src/workspace/workspaceManager.ts:19`, `server/src/workspace/workspaceManager.ts:160`, `server/src/workspace/workspaceManager.ts:232`, `server/src/workspace/workspaceManager.ts:245`, `server/src/orchestrator/taskRunners.ts:331`).

Import roots combine studio workspace/worktree directories, environment-approved roots and persisted user roots. Imports reject protected paths and ancestors containing them. Relative file protocol/read paths reject absolute paths, `..`, invalid segments and top-level `.git`; realpath containment is attempted but has the missing-ancestor defect R1. Folder browsing intentionally lists names outside approved roots; approval is needed for import, not browsing (`server/src/workspace/workspaceManager.ts:72`, `server/src/workspace/workspaceManager.ts:107`, `server/src/workspace/workspaceManager.ts:123`, `server/src/workspace/workspaceManager.ts:191`).

Protected defaults: application root; home `.claude`, `.claude-account2`, `.claude-account3`, `.codex`, `.gemini`, AppData; Windows/Program Files/ProgramData, `D:/Jarvis`, `D:/AI-Stack` (or listed Unix system roots), plus configured extras. **Not all `.claude*` accounts are protected** (`server/src/config.ts:39`).

Git wrapper allows `init/add/commit/rev-parse/worktree/merge/diff/status/log/ls-files/show`; worktree actions `add/remove/prune/list`; merges require `--no-ff` except abort. No studio push/reset/clean/rebase/branch-delete API. Commit exclusions cover Antigravity task files, node_modules and package caches, not a universal secret-file denylist (`server/src/workspace/git.ts:17`, `server/src/workspace/git.ts:51`).

Command allowlist: `npm test`, `npm run test/build/lint/typecheck`, `npm ci/install`, `npx vitest run`, `node --test`, `pnpm test`, `yarn test`, `mvn test`, `mvn -q test`, `mvn verify`, `gradle test`, `mvnw test`, `gradlew test`, `python -m pytest`, `pytest`, `go test ./...`, `cargo test`. Exact normalized tokens are checked; approved exceptions still pass token validation. This governs studio test execution, not Codex's own shell or the contents of npm scripts/git hooks (`server/src/workspace/commandRunner.ts:6`, `server/src/workspace/commandRunner.ts:18`, `server/src/workspace/commandRunner.ts:68`, `server/src/providers/cliProviders.ts:212`).

### 2.9 Security and disclosure boundaries — Q9

Default bind is `127.0.0.1:4317`; non-loopback requires `ASF_AUTH_TOKEN`. If configured, token checks also apply on loopback; comparison is length-checked/timing-safe. Bearer headers or `?token=` are accepted on **all** `/api/` routes, not only SSE. Browser stores token in localStorage and SSE uses the URL parameter (`server/src/config.ts:51`, `server/src/config.ts:77`, `server/src/api/routes.ts:49`, `server/src/api/routes.ts:106`, `web/src/lib/api.ts:49`).

Mutations require JSON content type. Present Origins must match request Host, configured origins, or HTTP localhost/127.0.0.1 when bound locally; absent Origin is accepted. No Host allowlist, per-user authorization, rate limit or application TLS configuration appears in this server setup (`server/src/api/routes.ts:113`, `server/src/app.ts:49`, `server/src/index.ts:15`).

Registered token/key literals and common credential patterns are redacted in events, messages, captured test output and many provider errors. Child environments remove `ASF_*`, but retain other inherited environment variables. Markdown rendering does not enable raw HTML (`server/src/security/redact.ts:1`, `server/src/app.ts:32`, `server/src/events/eventStream.ts:23`, `server/src/db/repositories.ts:258`, `server/src/workspace/processRunner.ts:47`, `web/src/components/Markdown.tsx:5`).

**What dedicated configuration APIs do not return:** the configured auth token, environment object or resolved HTTP key; provider settings accept/return only `baseUrl`, `apiKeyEnv`, `models`, `configDir` (`server/src/api/routes.ts:137`, `server/src/providers/registry.ts:12`, `server/src/providers/registry.ts:115`, `server/src/providers/apiProviders.ts:23`). **This is not a global “API never returns secrets” guarantee:** project file contents, spec/plan/report, task result summaries, approval notes and generic error messages lack universal response redaction; project files named `.env` are not denied (`server/src/workspace/workspaceManager.ts:369`, `server/src/db/repositories.ts:17`, `server/src/api/routes.ts:127`, `server/src/api/routes.ts:208`). No real secret was used to test this.

### 2.10 Jarvis / ECC — Q10

No Jarvis service call, ECC router adapter or `ai.mjs` invocation was found in server/shared/web/scripts. Registry constructs only Claude accounts, Codex, Antigravity, Gemini, HTTP and Scripted; the sole runtime Jarvis reference is a protected path. The proposed external-router adapter in the architecture doc remains a proposal, and live installations were not inspected (`server/src/providers/registry.ts:52`, `server/src/config.ts:44`, `docs/ARCHITECTURE.md:135`).

## 3. Quality assessment

### 3.1 Tests and gaps — Q11

Source AST counting, including parameterized cases, finds **49 server + 19 web cases**. These are coverage inventories, not a claim that this audit reran them.

| File / cases | Covered behavior | Evidence |
|---|---|---|
| server unit / 21 | Claude/Codex usage parsing with mocked processes; state transitions, DAG validity, JSON/plan/verdict parsing, redaction, command parsing/test summaries/frontend fix routing, git guards/exclusions, basic path/import guards, remote config, limit recognition | `server/test/unit.test.ts:17`, `server/test/unit.test.ts:39`, `server/test/unit.test.ts:84`, `server/test/unit.test.ts:140` |
| server API / 17 | Saved agent tests/overlap/limits, create/snapshot, request validation, safe provider settings, fix settings, auth/CSRF, folder approval/copy/protection, deletion, fallback/model preservation/discovery, limit failover, instance lock | `server/test/api.test.ts:19`, `server/test/api.test.ts:136`, `server/test/api.test.ts:209`, `server/test/api.test.ts:275` |
| server workflow / 7 | Scripted end-to-end with real git/npm tests, retry, plan gate/report, three fix-loop cases, graceful pause/resume, restart recovery and unavailable AI | `server/test/workflow.test.ts:22`, `server/test/workflow.test.ts:69`, `server/test/workflow.test.ts:153` |
| server resilience / 4 | Fake adapters: idle heartbeat watchdog, partial-work continuation, concurrent merge conflict resolution, removal of leftover markers | `server/test/resilience.test.ts:30`, `server/test/resilience.test.ts:49`, `server/test/resilience.test.ts:93`, `server/test/resilience.test.ts:143` |
| web / 19 | Agents 8, Monitor 3, Settings 5 TSX cases; fetch-mock helper 3 TS cases. Real Zustand state with mocked fetch/jsdom; not browser-to-server E2E | `web/src/pages/Agents.test.tsx:1`, `web/src/pages/Monitor.test.tsx:13`, `web/src/pages/Settings.test.tsx:28`, `web/src/test/fetchMock.test.ts:4`, `web/vitest.config.ts:8` |

Gaps in these suites: real provider compatibility/auth and Windows shim variants; SSE reconnect/backpressure/large replay; missing-ancestor symlinks; hostile Host; retry dependency bypass; QA before later writes; shutdown/cancel races across chat/tests/tasks; migration fixtures; run history; browser routing, project/files/chat/approval flows; accessibility/responsiveness and load. Paid scripts are separate, not part of `npm test`; smoke scripts also omit auth headers and may mutate global routing (`package.json:12`, `scripts/real-ai-smoke.mjs:10`, `scripts/real-ai-smoke.mjs:43`, `scripts/check-planning-models.mjs:5`).

Strict TypeScript and shared contracts are useful foundations, but runtime schemas are duplicated separately from shared types, several views subscribe to the entire store, errors are inconsistently typed, and tests assert selected scenarios rather than system invariants (`server/tsconfig.json:6`, `web/tsconfig.json:8`, `shared/src/index.ts:1`, `server/src/api/routes.ts:20`, `web/src/App.tsx:41`).

### 3.2 Real, partial and placeholder UI — Q12

| Classification | Finding | Evidence |
|---|---|---|
| Real | Projects/import/delete, role config/tests, approvals, worktree files, task graph/status/progress, logs, provider detection and available usage all call the backend. Progress is completed-task ratio; no random/simulated production metric generator was found | `web/src/pages/Dashboard.tsx:27`, `server/src/orchestrator/projectService.ts:104`, `web/src/store/studio.ts:249`, `web/src/pages/Files.tsx:74` |
| Deliberately scripted | Sample provider supplies canned plan/code/review/chat, synthetic delays and failures; labeled “not AI”. Its actual git merges/tests are real. The arithmetic question/expected `1591` is a fixed diagnostic fixture with an actual provider call | `server/src/providers/apiProviders.ts:123`, `scripts/build-sample-script.mjs:25`, `server/src/api/routes.ts:78` |
| Partial analytics | “Agents working” counts running task rows, including system/test work; USD can be unknown but aggregate to zero; model often means requested model; effort means requested effort. Provider usage table only refreshes on mount | `server/src/orchestrator/liveMonitor.ts:28`, `server/src/agents/agentExecutor.ts:125`, `server/src/db/repositories.ts:361`, `web/src/pages/Providers.tsx:138` |
| Partial interaction | Workflow viewer has no edit/connect/drag persistence; file viewer has no editor; chat cannot attach to an active CLI turn; progress weights all task kinds equally. One card per fixed role can hide multiple simultaneous tasks of that role | `web/src/components/WorkflowGraph.tsx:137`, `web/src/pages/Files.tsx:183`, `server/src/orchestrator/projectService.ts:110` |
| Absent V2 features | No terminal panes, user-defined workflow save/run API, independent runs/history comparison, time-series dashboard or configurable agent instances; these are missing capabilities, not implemented hidden screens | `web/src/store/studio.ts:8`, `server/src/api/routes.ts:137`, `server/src/db/database.ts:3`, `shared/src/index.ts:3` |

### 3.3 Documentation disagreements — code wins

| Documentation claim | Verified correction |
|---|---|
| Eight pages; 53 server tests (`HANDOFF.md:25`, `HANDOFF.md:28`) | Nine hash views; source contains 49 server/19 web cases (`web/src/store/studio.ts:8`; test inventory above) |
| Project-wide fix budget / backend-only fixes (`docs/ARCHITECTURE.md:79`) | Per-verification-task counters and frontend-only failure routing (`server/src/orchestrator/fixLoop.ts:15`, `server/src/orchestrator/fixLoop.ts:36`) |
| Any merged checkpoint auto-completes; earlier work discarded (`docs/ARCHITECTURE.md:93`) | Auto-complete only implement; partial work preservation and QA rerun (`server/src/orchestrator/scheduler.ts:57`) |
| Merge conflicts fail immediately; agents have no shell (`docs/adr/0001-single-process-sqlite-worktrees.md:16`, `docs/adr/0001-single-process-sqlite-worktrees.md:29`) | Two agent-resolution rounds; Codex edit turns explicitly permit commands (`server/src/orchestrator/taskRunners.ts:224`, `server/src/providers/cliProviders.ts:212`) |
| All providers initially disabled / credentials only in `.env` (`docs/ARCHITECTURE.md:106`, `docs/ARCHITECTURE.md:122`) | Scripted initially enabled; CLI account config/login state external (`server/src/providers/registry.ts:66`, `server/src/providers/cliProviders.ts:66`) |
| All `~/.claude*` protected (`HANDOFF.md:13`) | Only default, account2 and account3 explicitly protected (`server/src/config.ts:41`) |
| 13 px base and no gradients (`docs/FRONTEND_BRIEF.md:19`) | Body is 14 px with gradients; sidebar logo also gradient (`web/src/index.css:39`, `web/src/components/layout/Sidebar.tsx:25`) |
| Fallback/real-run claims and installation status (`HANDOFF.md:11`, `HANDOFF.md:30`) | Historical claims are not fresh availability evidence; source proves adapters, while live accounts/models were intentionally not exercised (`server/src/providers/registry.ts:93`) |

## 4. Risk matrix — Q13

No CRITICAL issue was established within this audit. HIGH items below have concrete failure paths; exploit prerequisites and unexecuted scenarios are stated rather than assumed. “Probe” refers to the isolated checks described in §1.

| ID / severity | Specific defect or limit, impact and evidence | Required response |
|---|---|---|
| R1 HIGH | **Probe, virtual FS:** `resolveInside` resolves only the target or immediate parent. For `link/new/file` with `link` pointing outside and `new` absent, realpath falls back to lexical path and the existence check skips containment. `applyEdits` then recursively creates directories through the link (`server/src/workspace/workspaceManager.ts:123`, `server/src/workspace/workspaceManager.ts:334`) | Walk/resolve existing ancestors, reject unsafe links/reparse points, recheck writes; add nested-missing-parent regression |
| R2 HIGH | **Probe:** cancel a pending child, then retry; `retryTask` sets ready despite unmet prerequisites, and dispatch trusts ready. This can run implementation before plan approval or predecessor completion (`server/src/orchestrator/scheduler.ts:88`, `server/src/orchestrator/scheduler.ts:244`) | Retry via dependency promotion; enforce prerequisites at dispatch too |
| R3 HIGH | **Probe:** PM DAG `QA→implementation` is accepted; any QA suppresses appended QA. Later writes can reach PASS reviews/report without tests on final code (`server/src/orchestrator/taskRunners.ts:113`, `server/src/orchestrator/taskRunners.ts:125`) | Mandatory final verification barrier tied to integrated commit; test all DAG shapes |
| R4 HIGH | **Probe, HTTP injection only:** unauthenticated loopback accepts attacker-chosen matching Host/Origin on settings mutation. No Host allowlist makes DNS-rebinding a plausible browser attack path; an end-to-end browser exploit was not performed (`server/src/api/routes.ts:103`, `server/src/api/routes.ts:117`) | Strict expected-host/origin policy and authenticated local sessions; regression against hostile Host |
| R5 HIGH | Raw project file API can return `.env`/other sensitive text; spec/plan/report/task summaries and generic errors bypass uniform redaction. Copy import + commit-all can also commit unignored secret files (`server/src/workspace/workspaceManager.ts:170`, `server/src/workspace/workspaceManager.ts:369`, `server/src/workspace/git.ts:56`, `server/src/api/routes.ts:133`) | Sensitive-file policy for read/import/commit; consistent DTO/error redaction; synthetic-secret regression |
| R6 HIGH | Untrusted project execution is not contained by worktrees/argv allowlists: `npm test/install` executes repository code, git hooks are not disabled, most user env survives, and provider permissions differ. Applies when importing untrusted code or exposing V2 multiuser execution (`server/src/workspace/commandRunner.ts:72`, `server/src/workspace/git.ts:29`, `server/src/workspace/processRunner.ts:47`) | Explicit trust/capability boundary, isolated worker environment and sandbox where required |
| R7 HIGH | Failed partial-save commit is caught/logged, but caller still removes the worktree; interruption can therefore destroy unsaved edits despite the preservation claim (`server/src/orchestrator/taskRunners.ts:63`, `server/src/orchestrator/taskRunners.ts:216`, `server/src/orchestrator/scheduler.ts:62`) | Make preservation failure block cleanup; retain/quarantine recoverable workspace |
| R8 MEDIUM | Discovered account4–9/custom Claude config directories are absent from default protected list (`server/src/config.ts:41`, `server/src/providers/registry.ts:33`) | Derive protection from discovered/configured credential roots |
| R9 MEDIUM | **Probe:** replay sends first 1,000 after cursor then jumps to live, dropping larger backlog; event `limit=-1` escapes the upper-only cap. No backpressure or gap repair (`server/src/events/eventStream.ts:48`, `server/src/api/routes.ts:267`, `server/src/db/repositories.ts:194`) | Validated bounded cursor pagination, replay continuation and resnapshot protocol |
| R10 MEDIUM | **Probe:** unknown USD becomes zero in aggregates; failed calls may consume quota without records; reasoning tokens discarded; requested models/efforts presented as real. Budgets can overshoot or never bind for null-cost providers (`server/src/db/repositories.ts:330`, `server/src/db/repositories.ts:343`, `server/src/agents/agentExecutor.ts:125`) | Preserve unknowns, per-turn usage/status/provenance, reservations and explicit estimated costs |
| R11 MEDIUM | HTTP 429 does not park/fail over; ordinary errors retry same provider immediately; cooldowns reset at restart and cannot automatically wake a permanently failed task (`server/src/providers/apiProviders.ts:67`, `server/src/providers/registry.ts:47`, `server/src/orchestrator/scheduler.ts:197`) | Typed error classification, persisted cooldown/backoff and scheduled wakeup |
| R12 MEDIUM | Chats/agent tests bypass global task cap and lifecycle tracking; shutdown waits only 10 s before app/DB close. In-flight work may outlive project deletion or DB availability; cancellation is not a transaction with merge (`server/src/orchestrator/projectService.ts:137`, `server/src/orchestrator/projectService.ts:169`, `server/src/api/routes.ts:159`, `server/src/orchestrator/scheduler.ts:288`, `server/src/app.ts:59`) | Unified execution supervisor, cancellation checks at commit boundaries, await owned work before close |
| R13 MEDIUM | Blocking SQLite/fs and large payloads limit responsiveness: file read loads whole file before 512 KiB slicing; project list returns specs/reports; monitor performs task/type queries without corresponding index; events lack retention (`server/src/workspace/workspaceManager.ts:372`, `server/src/db/repositories.ts:57`, `server/src/db/repositories.ts:201`, `server/src/db/database.ts:62`) | Bounded reads, summary DTOs, pagination/indexes/retention and measured worker offload |
| R14 MEDIUM | Store init has no cleanup/idempotency, so StrictMode can install duplicate timers/listeners; message fetch lacks project-switch guard; RightPanel role logs lack project filter (`web/src/main.tsx:7`, `web/src/store/studio.ts:193`, `web/src/store/studio.ts:274`, `web/src/components/layout/RightPanel.tsx:162`) | Single connection lifecycle, scoped query keys/abort guards, project-filtered logs |
| R15 MEDIUM | Creation writes workspace before checking blank spec, persists project before integration setup, and lacks rollback/slug reservation. Failed creation leaves artifacts; reimporting a deleted project's slug can collide with retained `asf/*` branches (`server/src/orchestrator/projectService.ts:33`, `server/src/workspace/workspaceManager.ts:251`, `server/src/workspace/workspaceManager.ts:300`) | Validate first; transactional metadata plus compensating cleanup and run-unique branch identity |
| R16 MEDIUM | Windows `.cmd/.bat` bridge rejects arguments containing spaces; Claude system prompts, Gemini fixed prompt and Antigravity prompts contain spaces. Executable-only installs may work while standard shim installations fail (`server/src/workspace/processRunner.ts:73`, `server/src/providers/cliProviders.ts:94`, `server/src/providers/cliProviders.ts:330`, `server/src/providers/cliProviders.ts:396`) | Tested executable/shim resolution without unsafe shell quoting |
| R17 MEDIUM | Delivery report captures task rows while its own task is running, then stores/commits before completion; report can permanently list delivery as running and omit its own final commit (`server/src/reports/reportGenerator.ts:16`, `server/src/reports/reportGenerator.ts:50`, `server/src/orchestrator/taskRunners.ts:384`, `server/src/orchestrator/scheduler.ts:158`) | Defined report snapshot boundary; exclude system report task or finalize after durable terminal state |
| R18 LOW | Accessibility/responsiveness incomplete: AgentCard article and monitor table rows are click-only, chat/approval textareas rely on placeholders, expanded sidebars consume 580 px before main content at narrow widths (`web/src/components/AgentCard.tsx:34`, `web/src/pages/Monitor.tsx:151`, `web/src/components/layout/RightPanel.tsx:117`, `web/src/components/layout/RightPanel.tsx:200`, `web/src/components/layout/Sidebar.tsx:23`) | Keyboard semantics, labels, responsive panels and browser/a11y checks |
| R19 LOW | Agent arithmetic correctness uses substring `includes('1591')`; invalid task actions throw generic errors rendered as 500/internal messages. Specification upload allows 1 MiB while API accepts 200,000 chars and prompts clip at 20,000 (`server/src/api/routes.ts:86`, `server/src/orchestrator/scheduler.ts:247`, `web/src/pages/Projects.tsx:103`, `server/src/api/routes.ts:23`, `server/src/agents/prompts.ts:14`) | Exact diagnostic validation, typed 4xx errors, consistent limits and visible prompt truncation |

Further limits: fixed seven global role configs, no per-project config snapshot, no immutable attempts/runs, no graph editing, static model catalogs, 60,000-character review-diff clipping, no automatic dependency installation, no session recovery, and no GitHub push/delivery integration. These are visible product/architecture boundaries, not proof of a mock application (`shared/src/index.ts:3`, `server/src/db/database.ts:85`, `server/src/orchestrator/taskRunners.ts:40`, `server/src/orchestrator/taskRunners.ts:331`, `server/src/providers/types.ts:37`).

## 5. V2 recommendations and stable core — Q14

Complexities are planning estimates for one engineer, excluding product-design/provider-compatibility uncertainty: S ≈ 1–3 days, M ≈ 4–10 days, L ≈ 2–4 weeks. Items overlap and are not an additive delivery commitment.

| Priority / size | Refactor or addition | Acceptance boundary / trade-off |
|---|---|---|
| P0 / M | Repair R1–R7 before expanding privileges; add invariant tests for prerequisites, final verified commit, Host policy, secret files and preservation failure | Retain scheduler/worktree architecture; close specific defects instead of treating existing docs as guarantees |
| P1 / L | Add migrations for runs, task attempts, workflow definitions/versions, agent instances/sessions/turns and artifact/usage provenance | Backfill each V1 project as one legacy run; retain old IDs/events, snapshot config/model/effort per attempt; never overwrite history on retry. Current schema lacks these entities (`server/src/db/database.ts:3`) |
| P1 / L | Introduce a session/execution supervisor beside the headless ProviderAdapter: start/send/resize/interrupt/exit/reconnect, capabilities, durable IDs and bounded transcripts | Preserve `run(request)` for automation. Use supervised PTY workers and authenticated duplex transport for terminal input; keep SSE for domain events. Provider-native resume only where demonstrably supported (`server/src/providers/types.ts:37`, `server/src/workspace/processRunner.ts:94`) |
| P1 / L | Separate editable visual workflow definitions from execution DAG snapshots; support node/edge/version persistence and compile to validated tasks | Reuse React Flow and DAG checks; add authoring interactions, typed node schemas, approval and final-verification policy. A general loop/branch engine is larger than a versioned DAG editor (`web/src/components/WorkflowGraph.tsx:90`, `server/src/domain/taskGraph.ts:4`) |
| P1 / M–L | Refactor frontend around project/run/session routes, per-session workspace panes, scoped server queries and small UI-state slices; lazy-load heavy views | Preserve tokens/primitives/Markdown and existing actions behind compatibility adapters; fix initialization/subscription lifetime before adding more panels (`web/src/store/studio.ts:17`, `web/src/App.tsx:9`) |
| P2 / M | Build history/dashboard APIs with pagination, time buckets, explicit unknown cost/token values, requested-vs-reported models and artifact/report links | Index real query paths; dashboard totals must derive from immutable attempts, not current task rows or fabricated metrics (`server/src/db/repositories.ts:330`, `server/src/orchestrator/liveMonitor.ts:20`) |
| P2 / M–L | Add provider/account concurrency, fairness, persistent backoff, unified cancellation/deletion/shutdown ownership and workspace reconciliation | Keep single coordinator initially; move blocking/interactive work into supervised workers as measurements justify it. Separate processes improve isolation without requiring Redis/microservices (`server/src/orchestrator/scheduler.ts:20`, `server/src/orchestrator/context.ts:19`) |
| P2 / M | Expand regression suite: migrations/backfill, merge/checkpoint crash windows, session lifecycle, provider contracts, SSE gaps, browser workflow/chat/files and a11y | Keep deterministic Scripted/fake providers for CI; opt-in real-provider smoke checks must preserve assignments and support auth (`server/test/workflow.test.ts:22`, `server/test/resilience.test.ts:30`, `scripts/real-ai-smoke.mjs:43`) |

**Preserve as the stable core:** task transition rules and DAG validation; transactional repository/migration patterns; checkpoint/WIP continuation semantics; isolated attempt worktrees and serialized integration; plan/command approvals; bounded fix-loop verification; provider adapter separation; persisted event IDs/redaction; real exit-code test results; explicit Scripted labeling. Repair identified bugs with regression coverage rather than freezing defective code (`server/src/domain/taskStateMachine.ts:3`, `server/src/db/database.ts:136`, `server/src/orchestrator/taskRunners.ts:63`, `server/src/orchestrator/fixLoop.ts:45`, `server/src/events/eventStream.ts:23`, `server/src/workspace/commandRunner.ts:74`).

**Do not disturb external state or established safety contracts:** preserve existing project data/branches and API consumers through additive migrations/versioning; keep the user checkout untouched, retain path/token protections, and never introduce automatic pushes or credential copying. Jarvis/ECC integration is a separate opt-in provider project, not a prerequisite for V2. Keep SQLite for local single-coordinator operation unless measured contention or multi-host requirements justify a database/queue migration; a wholesale distributed rewrite would add migration and recovery risk before delivering interactive workflows (`docs/adr/0001-single-process-sqlite-worktrees.md:20`, `server/src/workspace/git.ts:17`, `server/src/providers/registry.ts:52`).

## SUMMARY
1. V1 has real CLI/API orchestration, SQLite persistence, worktrees, approvals, tests and fix loops.
2. The frontend has nine hash views and one existing 783,767-byte JavaScript bundle.
3. All 32 explicit routes and all SQLite tables/columns are inventoried above.
4. CLI turns are headless; no PTY, interactive session subsystem or provider-session resume exists.
5. PM tasks are dynamic inside a fixed pipeline; no visual workflow authoring or independent runs model exists.
6. HIGH risks include path containment, dependency bypass, incomplete final QA, Host trust and secret exposure.
7. Usage/model/effort displays have provenance gaps; unknown cost aggregates to zero.
8. Both typechecks passed; source counts 49 server/19 web tests; full suites and paid runs were not rerun.
9. V2 needs run/session/workflow-version models and supervised interactive execution while preserving core invariants.
10. Only docs/v2/V1_AUDIT.md was written; Jarvis/ECC integration is absent and external state was untouched.
