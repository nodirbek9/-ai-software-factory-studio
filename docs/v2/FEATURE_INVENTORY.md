# V1 Feature Inventory — AI Software Factory Studio

Source audit: 2026-10-16. Scope: current source, not a runtime/provider availability certification.
Read: `HANDOFF.md`, `docs/FRONTEND_BRIEF.md`, `web/src/App.tsx`, layout/components/pages, `store/studio.ts`, `server/src/api/routes.ts`, `shared/src/index.ts`, event emitters, repositories, orchestration and tests. No `.context/` directory was present.
**Status:** Real = implemented against backend or functional local UI; Partial = implemented with a stated gap; Placeholder = declared/static capability without an operational implementation. Scripted replay is explicitly non-AI.
**Notation:** all routes below have prefix `/api`; `P` = `/projects/:id`; `S` = selected `ProjectSnapshot` loaded by `refreshSnapshot → GET P`; `local` = component state/direct request, no store action. Braced route suffixes denote separate routes.
Architecture: React 19/Vite/Tailwind + Zustand/hash navigation + React Flow; Fastify + SQLite repositories, DAG scheduler, provider adapters and isolated git worktrees. Code takes precedence over stale brief/handoff statements.

## 1. Navigation and layout

| View in VIEWS / hash | Sidebar label | Component / scope |
|---|---|---|
| `dashboard` / `#/dashboard` | Dashboard | Dashboard; selected project |
| `monitor` / `#/monitor` | Live monitor | Monitor; all projects |
| `projects` / `#/projects` | Projects | Projects; list and selected project |
| `agents` / `#/agents` | Agents | Agents; global routing, selected-project status |
| `workflows` / `#/workflows` | Workflows | Workflows; selected project |
| `files` / `#/files` | File explorer | Files; selected project |
| `logs` / `#/logs` | Activity logs | Logs; selected project |
| `providers` / `#/providers` | Model providers | Providers; global |
| `settings` / `#/settings` | Settings | Settings; global |
| Sidebar | Nine navigation buttons; Collapse/Expand | `setView`, `toggleLeft`; 220/60 px; pending-approval and working-agent counts; SSE connection indicator |
| Top bar | Project selector, status, progress, metrics, notifications, execution/report buttons | Always mounted; some metrics hidden at smaller widths; see §3 |
| Main / right panel | Page plus Details, Chat, Logs, Approvals tabs | Right panel only on Dashboard/Workflows; 360/380 px, collapsed 44 px; `toggleRight` |
| Routing / shell | Browser back/forward; error dismissal; access gate | Hash listener, invalid hash → Dashboard; `setError(null)`; token gate before shell when unauthorized |

## 2. Per-page controls and capabilities

### Dashboard — web/src/pages/Dashboard.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Start without a project | Create project | `setView('projects')` | — | S absent | Real | Opens Projects, not its creation dialog |
| Project overview | Name, branch/test-command text; completed/running/failed/blocked counts | `refreshSnapshot` | GET P | S.project/tasks | Real | No spec/plan/task-list section on this page |
| Draft planning | Generate plan | `startPlanning` | POST P/plan | S.project.status | Real | PM → Architect → approval gate |
| Seven agent cards | Click card | `selectAgent; selectTask(null)` | GET P/agents/:role/messages | S.agents/tasks; providers | Real | Status, assigned model/effort, actual last model/provider/fallback, activity, task, verified progress, tokens/cost; clickable article lacks keyboard equivalent |
| Chat shortcut | Open chat | Same as card selection | GET P/agents/:role/messages | Selected role/messages | Partial | Loads conversation and opens panel but does not select Chat tab |
| Workflow mode | Tasks / Agents tabs | local | GET P via S | S.tasks/agents | Real | Dependency graph; agent edges derived from task dependencies |
| Workflow visibility | Collapse / Expand | local | — | graphOpen | Real | Graph only; default expanded |
| Graph interaction | Node selection; pan; zoom in/out; fit view | `selectTask; selectAgent` | GET P/agents/:role/messages on role selection | S | Real | Shared WorkflowGraph; computed longest-path layout; no drag/connect/edit or saved graph layout |

### Monitor — web/src/pages/Monitor.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Cross-project overview | Working/parallel slots, next in line, waiting for you, today tiles; connection badge | `refreshLive` | GET /live | live | Real | Counts persisted running/ready/waiting_approval tasks; today uses server-local midnight |
| Running details | Click working-agent card | `selectProject; selectTask; selectAgent; setView('workflows')` | GET P; GET P/agents/:role/messages | live.running | Real | Project/task/role, provider, model, effort, non-AI/fallback, elapsed, attempt, checkpoint, latest output/age |
| Queue | Read-only list | `refreshLive` | GET /live | live.queued | Partial | Ready/approval rows; no approval button or project name in rendered row despite backend projectName |
| Provider activity | Read-only Providers today list | `refreshLive` | GET /live | live.providers | Real | Enabled/availability/running/limited states, reset time, calls/tokens/cost |
| Recent results | Click recently finished row | Same navigation as working card | GET P; GET P/agents/:role/messages | live.recent | Real | Latest 12 non-gate finished tasks; status/error tooltip, role/task/project, model/effort, duration/time; row is mouse-only |
| Loading / idle | Loading and no-work/queue/results states | — | — | live | Real | Model can be requested/default when CLI reports no actual id; “Claude cost” tile label is hardcoded despite aggregate cost |

### Projects — web/src/pages/Projects.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Browse projects | Select project card | `selectProject` | GET /projects; GET P | projects/S | Real | Name/status/mode/created time/workspace/branch; resets details tab to Specification |
| Read project documents | Specification / Technical plan / Delivery report tabs | local | GET P | spec/planMarkdown/reportMarkdown | Real | Markdown; arrow/Home/End tab navigation; empty-document states |
| Open workspace view | Open in dashboard | `selectProject; setView` | GET P | Selected project | Real | Explicit navigation, separate from card selection |
| Plan / delete | Generate plan; Delete + browser confirm | `startPlanning; deleteProject` | POST P/plan; POST P/delete | Project status | Real | Delete disabled in planning/running/awaiting_approval; backend also rejects active tasks in paused projects; imported source repo retained |
| Create dialog | New project (header/empty state); Cancel; Close/Escape/outside dismissal | local | GET /samples on open | Form state | Real | Dismissal blocked while submitting/reading upload |
| Metadata | Name input; Description textarea | local → `createProject` | POST /projects | name/description | Real | Server limits 120/2,000 characters; required nonempty name |
| Workspace choice | New empty workspace / Sample project / Import local repository buttons | local → `createProject` | POST /projects | workspaceMode | Real | New and sample create studio-owned workspaces |
| Sample selection | Sample project select | local → `createProject` | GET /samples; POST /projects | Bundled sample names/specs | Real | Fills spec; Scripted provider replays fixed scripts, not AI; git/tests still real |
| Import selection | Absolute repository path; Browse… | local; FolderPicker callbacks | GET /fs/list?path=; see §3 | DirListing | Real | Typed path checked after 300 ms; valid listing required; approval enforced by server |
| Import strategy | Branch / Copy radio buttons | local → `createProject` | POST /projects | importStrategy | Real | `worktree` only for git; copy default for non-git, excludes build/dependency/git dirs; 20k files/500 MB cap; source kept |
| Requirements | Specification textarea; Upload requirements file input | local/FileReader → `createProject` | POST /projects | spec | Real | .md/.txt/.markdown ≤1 MiB replaces text; no PDF/DOCX parsing; server spec cap 200k characters |
| Verification command | Test command input | local → `createProject` | POST /projects | testCommand; info.allowedCommands | Real | Hardcoded initial `npm test`; first five allowlisted commands hinted |
| Save project | Create project submit | `createProject; selectProject; setView('dashboard')` | POST /projects (201); GET P | Form → project | Real | Validation/loading/local+global errors; resets form after success |

### Agents — web/src/pages/Agents.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Role overview | Seven fixed-role configuration cards | `refreshProviders` | GET /agents/config; GET /providers; GET P | AGENT_ROLES/ROLE_INFO; configs/S | Real | PM, Architect, Backend, Frontend, QA, Security, Reviewer; static descriptions plus real status/verified count |
| Provider routing | Provider select | local until Save | GET /providers | providers | Real | Includes disabled/unavailable/non-AI choices; retains compatible model on change, otherwise defaults |
| Availability remedy | Enable provider button, warning | `updateProvider` | PATCH /providers/:providerId | enabled/available/reason | Real | Button only when disabled but detected |
| Model choice | Model radio buttons; Other…; Custom model id input | local until Save | GET /providers | provider.models/defaultModel | Real | Unknown-id warning; Claude/Codex/Gemini catalogs/defaults hardcoded in adapters; Antigravity discovery overrides seeded catalog; HTTP models configurable |
| Reasoning / fallback | Effort select (default, low, medium, high, xhigh, max); fallback checkbox | local until Save | — | Config | Real | Effort always shown; Claude/Codex apply it, Antigravity/Gemini ignore it |
| Persist routing | Save; Saved indicator | `updateAgentConfig` | PUT /agents/:role/config; refresh GETs | Global agent config | Real | Includes providerId/model/effort/allowFallback; refreshes snapshot/configs |
| Probe saved settings | Test; Testing…; result/error line | `testAgent` | POST /agents/:role/test | AgentTestResult | Real | Read-only scratch run, no fallback, 180 s cap; fixed 37×43 question, correctness checks answer contains 1591; dirty config disables Test; same-role overlap →409 |
| Probe evidence | Actual/missing model, mismatch, effort support, thinking tokens, answer, correctness, duration | — | Same test response | agentTests/errors/testingAgents | Real | Actual model may be unreported; test outputTokens returned but not displayed |

### Workflows — web/src/pages/Workflows.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Empty-project navigation | View projects | `setView('projects')` | — | S absent | Real | No tasks → planning guidance |
| Graph / modes | Tasks / Agents tabs; node click; pan/zoom/fit controls | local; `selectTask; selectAgent` | GET P; GET P/agents/:role/messages | S.tasks/agents | Real | Status-colored animated edges; fixed node positions, no workflow authoring |
| Status visibility | Legend and task-status counts | — | GET P | S.tasks | Real | Counts include cancelled; legend omits cancelled |
| Task inspection | Ordered table row click/Enter/Space | `selectTask; selectAgent` | GET P/agents/:role/messages | S.tasks by orderIndex | Real | Order/key/title/agent/kind/status/attempts/provider/model/duration/dependencies |
| Recover / stop task | Retry; Cancel | `retryTask; cancelTask` | POST /tasks/:id/{retry,cancel} | Task status | Real | Retry failed/cancelled, extends attempt budget/unblocks dependants; cancel pending/ready/running/blocked/waiting_approval |

### Files — web/src/pages/Files.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Empty-project navigation | Open projects | `setView('projects')` | — | S absent | Real | Project-specific state resets on project switch |
| Browse / refresh | Refresh; directory expand/collapse; file buttons | local/direct requests | GET P/files; GET P/file?path= | FileEntry[]; content/binary/truncated | Real | Read-only; sizes, selected path, integration path; server falls back to workspace before integration exists |
| Narrow files | Filter files input; Changed by agents only checkbox | local | — | Entries + S.tasks.filesChanged | Real | Case-insensitive path filter; changed badges; first directory level initially open |
| Read content | Line-numbered source; Markdown Preview / Source buttons | local | GET P/file?path= | File content | Real | Markdown defaults to Source; binary/truncation indicators, loading/errors; text preview capped at 512 KiB; no editor/diff/download button |
| Refresh on completion | Automatic list/content reload | local effect | GET P/files; GET P/file?path= | Completed-task count | Partial | Also on mount/project/manual refresh; not every file edit; file tree cap of 5,000 entries has no truncation flag |

### Logs — web/src/pages/Logs.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Empty-project navigation | Open projects | `setView('projects')` | — | currentProjectId | Real | Selected-project history |
| Historical + live activity | Timestamp/level/role/type/message rows, counts | local + store events | GET P/events?limit=1000; GET /events | Deduplicated history/SSE | Real | Latest 800 matching rows rendered; history retained locally while mounted |
| Filtering | Level select (all/info/warn/error/debug); Agent select; Type select; Search input | local | — | Loaded events | Real | Client filtering; types derived from observed events; search message/type/level/role/taskId |
| Output / scrolling | Show agent output checkbox; Follow checkbox | local | — | Loaded events | Real | Output hidden by default; Follow initially on |
| Export | Export JSON | local Blob download | — | All filtered loaded events | Real | Includes event.data; not limited to 800 displayed rows or a full DB export |
| Inspect task | Click task-linked log row | `selectTask; setView('workflows')` | — | event.taskId | Real | Does not select corresponding role |

### Providers — web/src/pages/Providers.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Discovery / identity | Re-detect; cards with kind/version/availability/reason/edit mode/models/non-AI badge | `refreshProviders(true)` | GET /providers?refresh=1; GET /agents/config | Registry + configs | Real | Claude + extra accounts, Codex, Antigravity, Gemini, OpenAI-compatible, Scripted; 2–4 Claude accounts always registered, existing 5–9 folders discovered at startup |
| Enable routing | Enabled switch | `updateProvider` | PATCH /providers/:providerId | enabled | Real | AI providers initially opt-in; Scripted initially enabled |
| Spending cap | Budget numeric input + Save; spent/progress display | `updateProvider` | PATCH /providers/:providerId | budgetUsd/spentUsd | Real | Blank saves null (no separate clear button); nonnegative USD; cumulative recorded spend affects routing |
| Extra Claude login | Config folder input + Save settings | `updateProvider` | PATCH /providers/:providerId | settings.configDir | Real | Blank uses per-account default folder; not a login/authentication UI |
| HTTP adapter | Base URL; API key environment-variable name; comma-separated models; Save settings | `updateProvider` | PATCH /providers/openai-compatible | Non-secret settings | Real | Key value stays on server; names validated in form |
| Usage summary | Provider/model/calls/input/output/cost table | local/direct request | GET /usage | usage_records aggregate | Partial | Fetches once per mount; Re-detect does not refresh usage; unknown DB costs coalesced to zero, despite UI supporting Unknown |

### Settings — web/src/pages/Settings.tsx

| Feature | UI control | Store action | API route | Data source | Status | Notes |
|---|---|---|---|---|---|---|
| Concurrency / retries | Max parallel tasks (1–8); Default max attempts (1–5) numeric inputs | local until `updateSettings` | PUT /settings | info.settings | Real | Seed defaults 2/2 |
| Timeouts | Idle minutes (2–120); longest run minutes (5–480) numeric inputs | local until `updateSettings` | PUT /settings | info.settings | Real | Seed defaults 15/120; activity watchdog separate from hard cap |
| Automatic repair | Fix rounds per check numeric input (0–5) | local until `updateSettings` | PUT /settings | maxFixRounds | Real | Default 2, 0 off; enforced per verification task despite stale shared comment saying per project |
| Fallback chain | Include checkbox per provider; Move up / down buttons | local until Save | — | fallbackOrder + providers | Real | New unlisted choices appended unchecked; boundary move buttons disabled |
| Persist execution | Save; Saved/validation messages | `updateSettings` | PUT /settings | Complete form → settings | Real | Server accepts partial patches; applies scheduling tick; whole-number/range validation |
| Server details / roots | Address/auth/data dir/version; approved/protected path lists; Remove approved folder | local/direct requests | GET /info; GET /fs/roots; POST /fs/approved-roots/remove | ServerInfo/FsRoots | Real | Roots loaded on mount; removal refreshes local list; approvals added in FolderPicker; server version hardcoded as 0.1.0 |
| Policy information | Command allowlist and Security text | — | GET /info | allowedCommands; static prose | Partial | Policy text is hardcoded, not a health check; CLI subprocess permissions vary by adapter |
| Remote sign-out | Sign out (when auth required) | `setToken(null)` helper; reload | — | localStorage | Real | Removes locally stored bearer token |

## 3. Right panel, dialogs and global controls

| Feature / control | Store action / API (prefix /api) | Data source / status | Behavior and limits |
|---|---|---|---|
| Project select | `selectProject` → GET P | projects/S; Real | Persists `asf.project`; startup uses saved existing id or first project; clears selected task/messages |
| Global progress/status | `refreshSnapshot` → GET P | S; Real | Verified completions/total, active agents, running tasks, project status |
| Working-agent pill | `setView('monitor')`; GET /live | live.running; Real | Clickable even at zero; sidebar also shows count |
| Notifications bell / approval entry | local toggle; `setView('dashboard')` | Pending approvals + events; Real | Latest 12 selected-project warn/error events excluding agent.output; closes on mouse leave; no read/unread persistence |
| Generate plan / New project | `startPlanning` → POST P/plan; `setView('projects')` | Draft/no project; Real | Top-bar buttons mirror page affordances |
| Pause / Resume / Stop confirmation | `pause; resume; cancelProject` → POST P/{pause,resume,cancel} | S.project; Real | Pause in planning/running/awaiting_approval lets active tasks finish; resume paused; Stop aborts active/cancels queued tasks, preserves integrated work |
| Report download | Direct authenticated fetch GET P/report.md | reportMarkdown; Real | Button only when report exists; downloads slug-report.md |
| Open/collapse right panel; four tabs | `toggleRight`; local tab | Selection/approvals; Real | Pending-count changes select Approvals; selecting non-null task selects Details; Chat disabled without role |
| Details: task metadata/results | GET P via S | Task; Real | Title/status/role/kind/key/description, attempts/duration/provider/model/checkpoint/deps/total tokens; error, test command/summary/exit/duration/output tail, changed files, Markdown result |
| Details: agent task buttons | `selectTask` | S.tasks filtered by selectedRole; Real | Role description/status and selectable task list; Retry task/Cancel task use same routes/status rules as Workflows |
| Chat textarea / Send / Enter | `loadMessages; sendMessage` → GET/POST P/agents/:role/messages | AgentMessage[]; Real | Shift+Enter newline; POST 202 then SSE reply; user/agent/system messages, auto-scroll/wait state; API max 8,000 chars, history latest 200; read-only provider mode |
| Chat refresh limitation | `agent.message` handler requires data.message | Stored task-completion/failure messages; Partial | Completion event lacks payload; failure message has no matching payload event; selecting agent reloads saved messages |
| Logs tab | Store events, no extra route | Latest 300 by selected task, else role, else all; Partial | Auto-scroll and colored timestamps/output; role/all mode omits project filter and can mix projects |
| Approvals: plan / command | `decide` → POST /approvals/:id/decision | S.approvals; Real | Read/Hide technical plan, task list, command text, optional note, Approve/Reject; decided history includes notes; command approval persists per project |
| Delivery approval kind | Shared ApprovalKind includes `delivery` | Contract only; Placeholder | Generic approval card could render it; no creation flow found in server |
| FolderPicker navigation | Direct GET /fs/roots and /fs/list?path= | FsRoots/DirListing; Real | Drives/approved-root buttons; Up/breadcrumbs; click selects folder, double-click/Enter enters; git badges; path input + Go/Enter; prefers D: drive if present |
| FolderPicker decisions | Approve this folder → POST /fs/approved-roots; Use this folder / Cancel | Listing approval/protection; Real | Approval saved in DB; protected locations never selectable; use returns listing to creation form; loading/errors/truncated-directory notice |
| Dialog controls / Markdown | Radix Close/Escape/outside dismissal; Markdown links/GFM | Local; Real | New project and nested folder dialog; raw HTML disabled in rendered Markdown |
| Token gate / error banner | Password input + Unlock → setToken/reload; `setError(null)` | Auth/error state; Real | Token in `asf.token`; Bearer for HTTP, query token for SSE; dismissible global error alert |

## 4. API routes not used by the UI

All 32 registered method/path pairs in `routes.ts` have UI callers (including report download, REST history and usage). The following capabilities are unused or only partially surfaced; there are no wholly unused registered API routes.

| Capability | Existing API / backend behavior | UI gap |
|---|---|---|
| Server-filtered history | GET P/events?limit=&level=&taskId=; default 500, capped 2,000 | Logs uses only limit=1000; level/task filtering is local, no older-history pagination |
| Scoped event subscription | GET /events?projectId=&after=; Last-Event-ID header | UI uses after/token globally; live scoped delivery also passes global events, scoped DB replay excludes them |
| Partial configuration | PUT /settings accepts partial fields; PATCH /providers/:providerId supports settings map | Settings sends complete form; provider UI edits only specific supported settings |
| Snapshot-only fields | GET P returns full Project/Task/Approval records | Several fields omitted from presentation; see §6 |
| Transport/validation | Token auth, origin/JSON mutation guards, schema validation; errors return error/details | No UI for changing server auth/origins; request limits include decision note 2k, model 120, chat 8k characters |

## 5. Live data flows

`StudioEvent` defines id, projectId/taskId/role, **type: string** (no event-type enum), level, message, data, createdAt. `EventStream.emit` redacts and persists to SQLite before fan-out; replay is DB-backed, not a ring buffer.
Every event enters the store's 1,500-event buffer. Logs/TaskLog consume it; selected-project warning/error notifications exclude agent.output. **S-refresh** below means current-project snapshot refresh after 600 ms, updating cards/graph/table/details/progress. **L-refresh** means /live after 400 ms, updating Monitor and global working badges.

| Emitted event type(s) | Producer / meaning | Specific UI reaction beyond log ingestion |
|---|---|---|
| `project.updated` | context/project service/runners/scheduler; create/status/documents | Upsert projects and selected snapshot.project; auto-select when none; S-refresh |
| `project.deleted` | projectService; deletion | Remove project; select next if current deleted; global event, no direct L-refresh |
| `task.updated`, `task.checkpoint` | context/scheduler/taskRunners; lifecycle/checkpoint | data.task upsert for current project; S-refresh + L-refresh |
| `task.partial`, `task.resume`, `task.fix_exhausted` | taskRunners/scheduler; preserved work/resume/fix cap | S-refresh + L-refresh; no task payload/direct patch |
| `agent.started`, `agent.model` | agentExecutor; assigned/actual run identity | S-refresh + L-refresh; backend task/model and start-event metadata power Monitor |
| `agent.output` | agentExecutor; throttled activity text | L-refresh, deliberately no S-refresh; Monitor latest preview, optional Logs output, panel log |
| `agent.message` | projectService/scheduler; chat or completion | Upsert current-project role messages only with data.message; S-refresh + L-refresh |
| `agent.config` | routes; routing changed | Refresh providers + configs, L-refresh; global event does not directly refresh selected snapshot |
| `agent.test` | routes; probe finished | L-refresh; test result card populated by POST response, not event payload |
| `approval.updated` | scheduler/taskRunners/projectService; plan/command/decision | Upsert current approvals; S-refresh; panel auto-tab, sidebar/bell pending badges |
| `provider.updated` | routes; provider edited | Refresh provider/config lists; Monitor updated by polling |
| `provider.fallback`, `provider.limit` | agentExecutor; alternate provider / usage cap | Both S-refresh; fallback triggers L-refresh, limit waits for subsequent start/fallback or poll |
| `git.merge`, `git.conflict` | taskRunners; integration/conflict repair | S-refresh; log/notification evidence; no dedicated diff/conflict UI |
| `test.started`, `test.result` | taskRunners; real command verification | S-refresh; results appear via snapshot, not direct event.testResult patch |
| `workspace.approved`, `workspace.revoked` | routes; import permissions | Global log ingestion only; picker/Settings update their local roots from request responses |

No `task.started`, `task.completed` or `task.failed` emitters exist: transitions use `task.updated`. Report/fix creation uses existing project/task events.

| Flow / cadence | Behavior |
|---|---|
| Startup | GET /info → projects and provider/config fetches → saved/first project snapshot → SSE + immediate /live |
| SSE transport | GET /events; named `studio` events; id-based native reconnect, retry 2 s, heartbeat 20 s; after/Last-Event-ID replay max 1,000, only when id > 0 |
| Snapshot / live coalescing | 600 ms / 400 ms timers start on first eligible event and are not reset by later events; /live also polls every 3 s on all views |
| Snapshot history / message limits | Snapshot latest 300 events merged/deduplicated into store; chat GET latest 200; replay gap >1,000 has no client catch-up loop |
| Local clocks / reads | Monitor elapsed/quiet timers rerender every 1 s; no network; Projects path check 300 ms; Providers usage and Settings roots on mount; Files on completed-count/manual changes |
| Backend activity / detection | Output flush 750 ms, last 2,000 chars per flush; Monitor preview last line up to 220 chars; detection cache TTL 60 s (not polling); idle watchdog 10 s |

## 6. Backend data not fully shown: V2 dashboard opportunities

| Data already held | Location / current exposure | Missing presentation or access / limitation |
|---|---|---|
| Historical provider/day/project/task/role usage | usage_records includes timestamps and dimensions; /usage all-time provider/model; sinceByProvider drives /live today | Build daily/project/role trends and drill-down; no date-range/raw-usage HTTP route; costs missing from provider are not measured zero, though aggregates coalesce to zero |
| Task token/cost detail | Task.usage + totalsForTask; cards total role usage; Details total task tokens | Separate input/output/cost per task; reasoningTokens exists in shared UsageInfo/test response but usage_records has no reasoning column |
| Task outputs / test evidence | resultSummary, error, testResult shown in Details; streamed output in events; completion messages stored | Searchable consolidated output/test history; output is truncated/summarized, not complete raw transcript; latest task fields overwrite attempt state |
| Structured events / attempts | SQLite events.data + timestamps, GET history/SSE; JSON export retains payload | Timeline, attempt/fallback/conflict drill-down, structured payload viewer; default rows render message only; no full history pagination |
| Reports / plans | Project reportMarkdown/planMarkdown, Projects tabs, authenticated report download; report also committed in workspace | Cross-project report browser, extracted test/review/usage panels; no versioned report DB history; report comparisons need git/history work |
| Git identity / change evidence | Project.baseCommit/integrationBranch/integrationPath; Task.branch/worktreePath/filesChanged; git helpers and report commit list | Base commit/task branch/worktree not shown in Details; interactive commit/diff explorer needs new API, not an existing git route |
| Repair / approval provenance | fixRounds:<projectId>:<taskKey> settings; fix tasks/dependencies; Approval.details/createdAt/decidedAt | Rounds remaining, repair chains, decision timeline; delivery kind is declaration only; approval dates/dependencies not fully rendered |
| Live metadata / limits | /live includes queued.projectName, recent.providerId, running.taskKey/kind; ProviderInfo.limitedUntil | Richer cross-project queue/recent details; limits shown on Monitor but not Providers cards; parked-provider limits live in memory and reset on restart |

## 7. Test coverage and preservation risks

Source-counted cases including parameterized expansions: **53 server + 19 web**. Tests were inspected, not executed for this documentation-only change; no coverage-percentage claim.

| Page / web area | Test file / cases | Actual coverage / gaps |
|---|---|---|
| Dashboard | None / 0 | Cards/graph/plan/empty navigation untested at page level |
| Monitor | Monitor.test.tsx / 3 | Loading, /live request and running/queue/provider/recent display, empty states; no click-through/reconnect/timer tests |
| Projects | None / 0 | Creation modes/upload/doc tabs/import/delete untested at page level |
| Agents | Agents.test.tsx / 8 | Roles/models/custom/provider switch, effort/dirty state, exact Save/refetch, pending test/results, mismatch/unsupported effort/failed run/HTTP error |
| Workflows | None / 0 | Graph/table/selection/retry/cancel untested at page level |
| Files | None / 0 | Tree/filter/read/Markdown/refresh untested at page level |
| Logs | None / 0 | History/filter/export/follow/selection untested at page level |
| Providers | None / 0 | Discovery/config/budget/usage untested at page level |
| Settings | Settings.test.tsx / 5 | Missing info, fallback include/exclude/order/save, fix rounds 3/0 and >5 validation; no root removal/sign-out tests |
| Web helper / shell | test/fetchMock.test.ts / 3 | Mock helper coverage; no dedicated App/TopBar/RightPanel/FolderPicker/WorkflowGraph/SSE integration tests |

| Server area / file | Cases | Covered behavior |
|---|---|---|
| API — server/test/api.test.ts | 17 | Agent probe validation/settings/usage/overlap/limits; sample snapshot; secret-safe validation; fix setting; auth/CSRF/JSON; approved/protected import/copy; deletion; model/effort fallback/new login; quota failover; instance lock |
| Units — server/test/unit.test.ts | 25 | Claude/Codex reasoning extraction (4); state transitions/DAG; JSON/plan/verdict parsing; redaction; command parsing/test summaries/frontend fix routing; git guards/cache exclusions; workspace path/write/import guards; remote config and quota detection |
| Workflow — server/test/workflow.test.ts | 7 | Scripted full pipeline/approval/parallel work/retry/real tests/reports; test fix/review fix/exhaustion/manual retry; pause/resume; crash checkpoints; no-usable-AI failure |
| Resilience — server/test/resilience.test.ts | 4 | Busy vs idle watchdog, interrupted-work continuation, merge-conflict repair, leftover-marker prevention |
| Helpers / gaps | helpers.ts is not a suite | No dedicated SSE replay/reconnect test or exhaustive route coverage; no real external CLI integration in these suites; handoff smoke runs are separate evidence |

| Priority / risk | V2 action | Size |
|---|---|---|
| High: loss of execution/recovery/approval semantics | Preserve scheduler/worktree/provider contracts; regression-test UI against existing lifecycle tests | Large |
| High: silent gaps or misleading provenance | Add replay catch-up, consistent project-scoped logs/message refresh, explicit unknown-cost/model states | Medium |
| Medium: UI controls disappear during redesign | Add page/control tests for six untested pages and shared panels/dialogs before migration | Medium |

## SUMMARY: 10 capabilities V2 must preserve

| # | Capability |
|---|---|
| 1 | All nine views, hash navigation, persistent project selection, contextual panels, authentication and visible errors. |
| 2 | New/sample/import projects, requirement upload, approved folder browsing, branch/copy isolation and safe stopped-project deletion. |
| 3 | PM planning → architecture → explicit plan approval → parallel DAG implementation → real tests/security/review → delivery report. |
| 4 | Seven independently configured roles, provider/model/custom-model/effort selection, saved-setting probes and actual-run provenance. |
| 5 | Claude multi-account and CLI/HTTP routing, provider discovery/enable/budgets, ordered fallback and usage-limit failover; clear Scripted non-AI labeling. |
| 6 | Cross-project live monitor, event-driven graphs/cards/logs, replayable persisted SSE, running/queued/recent work and provider usage. |
| 7 | Pause without discarding active work, resume/cancel, task retry/unblocking, checkpoints, crash recovery, idle/hard limits and preserved partial branches. |
| 8 | Bounded per-check test/review repair loops, Frontend/Backend fix routing, conflict repair and verified completion rather than simulated progress. |
| 9 | Task/test/output/file inspection, read-only agent chat, command approvals with notes/history, filtered/exportable logs and report viewing/download. |
| 10 | Persisted concurrency/retry/timeout/fix/fallback settings, revocable roots, path/command/git guards, secret redaction and source-repository preservation. |
