# Agent Workspace Spec — sessions, process budget, multi-panel UI (Phase 3)

Implements `V2_ARCHITECTURE.md` §3.1–3.2 and §4, decisions D-005, D-006, D-007, D-019. Reference screen:
`reference/02-multi-agent-workspace.webp` (mapping in `reference/REFERENCE_NOTES.md`).

## 1. V1 facts this builds on

| Fact | Evidence |
|---|---|
| Claude Code runs headless: `claude -p --output-format stream-json --verbose --model … --permission-mode acceptEdits|default --allowedTools … --disallowedTools Bash,WebFetch,WebSearch --setting-sources project,local --no-session-persistence [--effort]`; prompt on stdin; per-account `CLAUDE_CONFIG_DIR`. | `providers/cliProviders.ts:84-130` |
| Codex runs `codex exec --json --skip-git-repo-check --sandbox workspace-write|read-only [-m] [-c model_reasoning_effort=…] -`; usage from `turn.completed`. | `cliProviders.ts:207-250` |
| `AgentExecutor.run()` resolves the provider **by role** (`registry.resolveForRole`), streams `agent.output` events (750 ms batches), idle watchdog, limit failover, records usage per project/task. | `agents/agentExecutor.ts:44-142` |
| V1 chat = one read-only turn per message with the last 20 messages + task list in the prompt; one in-flight message per project+role. | `orchestrator/projectService.ts:156-182` |
| Worktrees: `createTaskWorktree`, `mergeIntoIntegration` (`--no-ff`, conflict → `MergeConflictError`), `removeWorktree` with retries; git allowlist without push/reset/clean. | `workspace/workspaceManager.ts:257-330`, `workspace/git.ts` |

Gap: V1 has no sessions, no resume (`--no-session-persistence`), no process cap shared across subsystems,
no explicit (non-role) provider choice and no per-turn identity on events.

## 2. Data model (migration v5 in `MIGRATION_PLAN.md`, additive)

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,           -- role = system prompt + hue
  provider_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '', allow_fallback INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK (mode IN ('readonly','edit')),
  cwd_kind TEXT NOT NULL CHECK (cwd_kind IN ('integration','own-worktree')),
  branch TEXT, worktree_path TEXT, base_commit TEXT,
  continuity TEXT NOT NULL DEFAULT 'replay' CHECK (continuity IN ('native','replay')),
  provider_session_ref TEXT,                                                  -- Claude session id / Codex thread id
  task_id TEXT, status TEXT NOT NULL,                                         -- see §4
  last_error TEXT, last_activity_at TEXT, created_at TEXT NOT NULL, closed_at TEXT,
  UNIQUE(project_id, number));
CREATE TABLE session_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, author TEXT NOT NULL CHECK (author IN ('user','agent','system')),
  text TEXT NOT NULL, activity TEXT NOT NULL DEFAULT '[]',                    -- tool activity lines (redacted)
  provider_id TEXT, model_reported TEXT, usage TEXT, files_changed TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, error TEXT, UNIQUE(session_id, seq));
CREATE TABLE workspace_layouts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  layout TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE usage_records ADD COLUMN session_id TEXT;
```
Text columns are redacted on write (`security/redact.ts`). Turn text ≤ 200 KB (longer is truncated with a note).

## 3. ProcessBudget (D-006) — `server/src/orchestrator/processBudget.ts`

```ts
class ProcessBudget {
  constructor(getLimit: () => number)            // setting maxAgentProcesses, default 3, 1–8
  acquire(owner: { kind: 'task'|'session'; id: string; projectId: string; label: string }, signal: AbortSignal): Promise<Release>
  snapshot(): { limit; running: Owner[]; queued: (Owner & { position: number; since: string })[] }
}
```
- FIFO with one fairness rule: when both kinds wait, alternate task/session so neither starves.
- `acquire` rejects with `AbortError` if the signal aborts while queued (queued turn cancelled → slot never taken).
- Release is idempotent and happens in `finally` of the executor call (success, error, timeout, abort).
- Scheduler: `tick()` keeps its own `maxParallelTasks`; each started task awaits `acquire` before
  `TASK_RUNNERS[kind]` → a task may be `running` (state) while "waiting for a slot" (shown in UI, emitted as
  `task.waiting_slot`). Commands run by the studio (tests, tool nodes) do **not** take a slot (they are short
  and serialized by the integration lock); conflict-resolution turns reuse the task's slot.
- Exposed in `/api/v2/system/health` and the Workspace status bar ("3 / 3 slots · 2 queued").

## 4. Session lifecycle

```
          create (no process)
               │
               ▼
   ┌──────── idle ◄──────────────────────────────┐
   │  send ▼                                      │ turn finished ok
   │      queued ── abort ──► idle (turn cancelled)│
   │        │ slot acquired                        │
   │        ▼                                      │
   │     running ── stop ──► idle (outcome stopped)┘
   │        │ error / limit (no fallback)
   │        ▼
   │     failed ── send/restart ──► queued
   └─ close ──► closed (edit: only after merge or confirmed discard)
```
- One turn at a time per session (409 on a second send while queued/running — same rule as V1 chat).
- **Stop** aborts the process tree (V1 abort path). **Restart** = stop if needed, then resend the last user
  message (continuity as configured). Server shutdown/crash: `running` turns → outcome `interrupted`; edit
  sessions commit `wip(session-<n>)` like V1 partial work (`taskRunners.ts:63`).
- Changing provider/model/effort is allowed only while `idle`; it resets `provider_session_ref` and switches
  continuity to replay for the next turn (a new native session starts after it).

## 5. Turn execution — `server/src/sessions/sessionManager.ts`

1. Validate session state; insert the user turn; emit `session.updated` (status `queued`).
2. `ProcessBudget.acquire({kind:'session'})`.
3. Build the prompt: role system prompt (`ROLE_SYSTEM_PROMPTS`) + session header (project name, mode, cwd,
   branch, linked task summary) + user text. Continuity:
   - **native** → adapter receives `resume: { ref }` (§6) and only the new message;
   - **replay** → last N turns (default 12, ≤ 24 KB, oldest summarized as one line each) + the new message;
     the UI shows "context replay" on the panel header.
4. `AgentExecutor.run()` with the new optional input fields:
   `explicit: { providerId, model, effort, allowFallback }` (bypasses role config; fallback order only if
   allowed), `sessionId`, `resume`, `mode`, `cwd`. Output events become `session.output { sessionId, chunk }`
   (same batching/redaction as `agent.output`). Usage is recorded with `session_id`.
5. Edit mode: after the turn, `git status` of the session worktree → `files_changed` (no commit yet;
   committed on "Checkpoint" or before merge so the user can review diffs turn by turn).
6. Persist the agent turn (text, activity lines, usage, reported model, provider session ref); emit
   `session.turn { sessionId, seq, outcome }`; release the slot; status → `idle` or `failed`.

## 6. Adapter capability: continuity

`ProviderAdapter` gains optional `readonly supports?: { resume?: 'native' | 'none' }` and
`ProviderRunRequest.resume?: { ref: string | null }` / `ProviderRunResult.sessionRef?: string`.

| Provider | Native continuity | How | Verify in Phase 3 |
|---|---|---|---|
| Claude Code (all accounts) | yes | first turn: drop `--no-session-persistence`, pass `--session-id <uuid>`; next turns `--resume <uuid>`; ref also read from the stream-json `system/init` and `result` events | real 2-turn test ("remember X" → "what was X") per account |
| Codex CLI | likely | ref = `thread_id` from the `thread.started` event; next turn `codex exec resume <id> --json …` | `codex exec resume --help` in `detect()`; if absent → replay |
| Antigravity, Gemini CLI, OpenAI-compatible, Scripted | no | context replay | — |

Native Claude sessions are stored by the CLI in that account's config dir under the worktree path (this is
the CLI's normal behaviour; V1 disabled it). Setting `sessionContinuity: 'native'|'replay'` (default native)
lets the owner turn it off. Task runs keep `--no-session-persistence` (unchanged V1 behaviour).

## 7. Isolation (D-007)

| Mode | cwd | Tools | Branch |
|---|---|---|---|
| `readonly` (default for PM, Architect, Reviewer, Security) | project integration worktree | Claude `Read,Glob,Grep`; Codex `--sandbox read-only` | none |
| `edit` (default for Backend, Frontend, QA) | own worktree `data/worktrees/<project>/session-<n>` | V1 edit tools; Codex `workspace-write` | `asf/<slug>/session-<n>` from integration HEAD |

Actions on edit sessions (each confirms in the UI, each emits an audit event):
- **Checkpoint**: commit current changes `wip(session-<n>): <first line of last user message>`.
- **Sync from integration**: `git merge --no-ff <integration>` into the session worktree; on conflict the user
  chooses "ask this agent to resolve" (V1 `conflictPrompt` flow) or "abort".
- **Merge into integration**: checkpoint → V1 `integrate()` path (integration lock, `--no-ff`, conflict
  rounds, leftover-marker check) → event `git.merge` with files. Blocked while a run is merging (lock).
- **Discard**: remove worktree; branch is kept (studio never deletes branches) and listed in Repos.
- **Run tests**: project test command (allowlist/approval rules unchanged) in the session worktree; output
  streams to the panel's Output tab; result stored as a system turn.

## 8. REST + SSE (`/api/v2`)

| Endpoint | Purpose |
|---|---|
| `GET /projects/:id/sessions` | list (no turns) |
| `POST /projects/:id/sessions` `{ title?, role, providerId, model, effort, mode, taskId? }` | create (no process); edit mode creates the worktree |
| `GET /sessions/:id`, `PATCH /sessions/:id` | read / rename / change provider-model-effort (idle only) |
| `GET /sessions/:id/turns?before=&limit=` | paginated transcript |
| `POST /sessions/:id/messages` `{ text }` | queue a turn (409 when busy) |
| `POST /sessions/:id/stop`, `/restart`, `/checkpoint`, `/sync`, `/merge`, `/discard`, `/run-tests` | actions above |
| `GET /sessions/:id/diff` | session branch vs integration (`git diff`, ≤ 300 KB, truncated note) |
| `GET /sessions/:id/files`, `/file?path=` | read-only tree/content of the session cwd (V1 file endpoints' guards) |
| `DELETE /sessions/:id` | close (edit: requires merged or `discard` first) |
| `GET/PUT /projects/:id/workspace-layout` | layout JSON (§9) |
| `POST /projects/:id/orchestrator/messages` `{ text, forwardTo?: sessionId[] }` | "Message all agents": stored as `agent_messages` role `orchestrator`; forwarded only to the sessions the user ticks |

SSE: `session.created|updated|closed`, `session.output`, `session.turn`, `budget.updated`. All carry
`projectId` so the existing per-project event filtering works.

## 9. Layout engine (web) — `web/src/features/workspace/`

```ts
type PanelId = string;
type LayoutNode = { type: 'panel'; id: PanelId } | { type: 'split'; dir: 'row' | 'col'; sizes: number[]; children: LayoutNode[] };
type WorkspaceLayout = {
  version: 1; preset: 1 | 2 | 3 | 4 | 5 | 6 | 8 | 'custom'; root: LayoutNode;
  panels: Record<PanelId, { sessionId: string | null; tab: PanelTab; kind: 'session' | 'orchestrator' }>;
  maximized: PanelId | null; minimized: PanelId[]; recentlyClosed: { sessionId: string; title: string; closedAt: string }[];
  drawer: { open: boolean; tab: 'coordination' | 'context' | 'artifacts'; width: number };
};
```
Presets: 1 = one panel · 2 = row(2) · 3 = row(3) · 4 = 2×2 · 5 = col(row(3), row(2)) · 6 = col(row(3), row(3))
· 8 = col(row(4), row(4)). Rendering: nested `react-resizable-panels` groups; min panel 320×220 px at
1366×768 (presets above 4 switch to 2 columns + scroll on narrow screens). Actions: resize (drag handles,
keyboard arrows on focused handle), split h/v (panel menu), move (drag header to another panel's edge),
swap (drop on centre), maximize (Ctrl+Shift+M or double-click header; Esc restores), minimize (to the dock
strip above the status bar), close (session keeps existing; listed in "Recently closed" for reopen), reopen.
Persistence: debounced `PUT` 1 s after a change; export/import JSON from the toolbar ("Share" = export).
Changing the preset keeps existing panels in order and adds empty panels ("Start a session" picker).

## 10. Panel anatomy and tabs

Header: role icon + hue, title, status pill (Idle / Queued #n / Running mm:ss / Failed / Stopped), chips
(provider · model · effort, cwd: `integration` or `session-<n>` branch, continuity `native`/`replay`),
buttons Stop (running), Restart, overflow (rename, change model when idle, link task, checkpoint, sync,
merge, discard, export transcript, close).

| Tab | Data source | Notes |
|---|---|---|
| Chat | `session_turns` + live `session.output` | virtualized; Ctrl+Enter sends; "@file" inserts a path picked from Files (text only) |
| Activity | `activity` lines of turns | tool calls ("Editing src/app.ts") with times |
| Changes | `GET /sessions/:id/diff` | edit mode only; per-file collapsible diff |
| Files | `/files`, `/file` | read-only CodeMirror 6 (lazy-loaded) |
| Output | `run-tests` stream, command results | `@xterm/xterm` read-only, mounted only while visible |
| Task | linked task (V1 task fields, test result, review text) | hidden when no task |

**Studio Orchestrator panel** (kind `orchestrator`, replaces the image's "Jarvis Orchestrator"; Jarvis is not
integrated): active run stages, scheduler timeline from events (`task.*`, `run.*`, `provider.fallback`,
`provider.limit`, `git.merge`, `git.conflict`, `task.fix_*`), slot queue from `ProcessBudget`, decisions
(fix rounds used, fallbacks). Read-only plus Pause/Resume/Cancel of the run.

## 11. Coordination drawer

| Section | Source |
|---|---|
| Current workflow | active run timeline (`WORKFLOW_ENGINE_SPEC.md` §7) |
| Task handoffs | derived: task B started and A ∈ B.dependsOn completed → "A.role → B.role · A.title · time" |
| Shared artifacts | `git.merge` event files of the run, `docs/IMPLEMENTATION_PLAN.md`, `ASF_REPORT.md` |
| Agent messages | `agent_messages` (task completions, fix-round notes, orchestrator inbox) |
| Approval requests | pending approvals, decide inline (V1 `POST /api/approvals/:id/decision`) |
| Blocked tasks / errors | tasks `blocked`/`failed`, failed turns, `provider.limit` events |

## 12. Status bar
Active project · run name/status · sessions running/queued and budget slots · elapsed of the active run ·
tokens today from `usage_records` (no denominator unless a provider budget is set; then spend/budget) · server
CPU % and system RAM % (`/api/v2/system/health`, sampled only while the page is visible). No "Network" meter.

## 13. Performance rules
Panels and sessions are data only until a turn runs; xterm/CodeMirror instances exist only for visible tabs;
transcripts virtualized and paginated (50 turns per page); SSE output batched (750 ms) and dropped for
sessions not on screen (the turn text is fetched when the panel becomes visible); layout saves debounced.

## 14. Optional PTY terminal (Phase 3c, D-019 — owner approval required)
Server: prebuilt ConPTY binding (candidate `@lydell/node-pty`, verify Node 24 prebuilds); browser: xterm.js
over a WebSocket on the same port, loopback only, token-checked, Origin+Host checked. Shell = PowerShell in
the session worktree only, started by an explicit "Open terminal" click, killed on panel close/idle 15 min,
max 2 terminals, full transcript logged (redacted) as audit events. Disabled when the server binds
non-loopback. Agents never get the PTY.

## 15. Test cases
WS-01 8 panels open → 0 agent processes · WS-02 budget 3: 5 sends → 3 running, 2 queued with positions;
abort a queued one · WS-03 one failing session (provider error) leaves others running · WS-04 Claude native
continuity 2-turn memory test (opt-in real call) · WS-05 replay fallback with the Scripted provider includes
previous turns · WS-06 edit session: change → diff → merge into integration → `git.merge` event; conflict path
· WS-07 discard keeps the branch, removes the worktree · WS-08 restart server while a turn runs → outcome
`interrupted`, wip commit exists · WS-09 layout presets render, swap/maximize/minimize/close/reopen, survive
reload (web tests) · WS-10 orchestrator message stored and forwarded only to ticked sessions · WS-11 Playwright:
open 6 panels, send to two Scripted sessions, reorder, reload.

## SUMMARY
Workspace panels are views over turn-based agent sessions that reuse V1 adapters through an extended
`AgentExecutor` (explicit provider, session id, continuity). A shared `ProcessBudget` (default 3) caps every
agent process, so many open panels cost nothing until messages are sent. Claude gets native resume, Codex is
verified at runtime, others use labelled context replay. Edit sessions work in their own worktrees and reach
the project only by explicit merge through V1's conflict-safe path. PTY terminals are optional and gated.
