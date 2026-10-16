# HANDOFF — AI Software Factory Studio

Last updated: 2026-10-15. Location: `D:\jarvis 2\ai-software-factory-studio` (independent app; nothing
outside this folder was modified except `D:\jarvis 2\.claude\launch.json`, the desktop preview config).

## Status: P0 delivered and verified; P1 fix loop added

| Area | State |
|---|---|
| Backend orchestration (Fastify + node:sqlite) | Done — state machine, DAG scheduler, parallel worktrees, retries, checkpoints, recovery, pause/resume/cancel, approvals |
| Providers | Claude Code CLI account 1 plus **auto-discovered extra logins** `~/.claude-account<N>` (N = 2…9; 2–4 always listed; the `claude<N>` logins). Accounts 2, 3, 4 verified with real calls and enabled; account 5 shows "Not logged in yet (run claude5 once)". Fallback keeps the requested model when the fallback provider offers it (no silent Opus→Sonnet downgrade). Agents page: model picked with buttons (+ "Other…" for a custom id) (`CLAUDE_CONFIG_DIR=~/.claude-account2`, the `claude2` login), **Codex CLI** (GPT-6.1-Sol / 6-Astra / 6-Luna), **Antigravity CLI** (Gemini 3.8 Flash, Claude 4.6) — all verified with real runs; Gemini CLI (not installed), OpenAI-compatible HTTP, Scripted offline replay |
| Agent routing (live DB) | PM, Architect → Claude **acc1** / claude-opus-5-5 / effort high · Backend, Frontend → Codex / GPT-6.1-Sol / medium (owner cap) · QA → Antigravity / Gemini 3.8 Flash high · Security → Codex / GPT-6-Astra / high · Reviewer → Claude acc2 / claude-sonnet-5-5 · fallback order acc2 → Codex → Antigravity → acc1 |
| Folder picker | Projects → New project → Import → **Browse…**: drives (C:\, D:\…), sub-folders, git badge, type-a-path. A folder must be **approved once** (stored in the studio DB, removable in Settings). Protected locations can never be approved/imported: the studio itself, `~/.claude*`, `~/.codex`, `~/.gemini`, `AppData`, Windows/Program Files, `D:\Jarvis`, `D:\AI-Stack` (+ `ASF_PROTECTED_PATHS`). Import methods: **branch** (git repo; studio adds only `asf/<slug>/*` branches and worktrees, your checkout untouched) or **copy** (any folder, copied into `data/workspaces`, skipping node_modules/dist/build/.git; limit 20k files / 500 MB; original never modified). |
| Project deletion | Projects page → **Delete** (only when stopped; `POST /api/projects/:id/delete`). Removes the studio worktrees, the studio-owned workspace folder (new / sample / copy) and the project's records and events. An imported git repository is never deleted; its `asf/*` branches stay for you to remove. |
| Live monitor | Sidebar → **Live monitor** (`GET /api/live`, refreshed on events + every 3 s): every running agent across all projects with provider, real model, effort, fallback badge, elapsed time, attempt, checkpoint and its latest activity (Claude runs in `stream-json`, so "Reading/Editing <file>" appears live); queue, approvals waiting, per-provider usage today, recently finished. Top bar shows "N agents working". |
| Usage-limit failover | Claude/Codex/Antigravity limit replies (429, "hit your session limit · resets 9:20pm", quota) raise `ProviderLimitError`: the provider is parked until its reset time (shown as "limit until HH:MM") and the same turn continues on the next provider in the routing order. Verified live: acc3 and acc2 at limit → backend task continued on acc4 within 3 s. |
| Timeouts and partial work | An agent is stopped only after **`idleTimeoutMinutes` (default 15) without any activity** — Claude/Codex output, Antigravity log growth count as activity; `taskTimeoutMinutes` (default 120) is the hard cap for one run. When an attempt is interrupted (idle stop, hard cap, usage limit, crash, shutdown) its worktree changes are committed as `wip(<task>)` and the next attempt starts from that branch with a "continue, don't start over" note (`task.partial` / `task.resume` events). Root cause it fixes: a busy Opus backend task was killed at the old 20-minute hard limit and its work discarded. |
| Parallel edits / merge conflicts (2026-10-16) | When a task branch conflicts with the integration branch, the integration branch is merged into the task worktree and the task's own agent resolves the markers (`conflictPrompt`); the result is checked for leftover `<<<<<<<`/`>>>>>>>` markers, committed and merged again (2 rounds). Branches carrying leftover markers are cleaned before any merge; a half-finished merge is aborted before partial work is saved; already-committed work is always kept for the next attempt. Verified live: frontend-shell-dashboard resolved a `docs/API.md` conflict in 26 s and merged 64 files. |
| Single instance (2026-10-16) | `data/studio.pid` lock (stale pids taken over, 5 s grace for watcher restarts) and the server binds its port **before** crash recovery, so a second `npm start`/`npm run dev` exits without touching state. Root cause it fixes: a second copy started at 04:13:31 ran recovery on the shared DB and deleted a running agent's worktree. |
| Commit hygiene | `node_modules`, `.npm-cache`, `.pnpm-store`, `.yarn/cache` and agy scratch files are never committed (agents may run `npm install`). |
| Antigravity models | Model buttons come from `agy models` for the logged-in account; an unavailable model fails fast with the list of available ones (gemini-3.1-pro-high is not on this account). |
| Per-agent effort | `agent_configs.effort` (migration v2): Claude `--effort`, Codex `model_reasoning_effort`; Antigravity/Gemini ignore it. The model id the CLI really used is recorded on the task (`agent.model` event when it differs from the request). Verified: PM + Architect ran as `claude-opus-5-5`, effort high (`node scripts/check-planning-models.mjs`). |
| Agent test (2026-10-16) | Agents page → **Test** on each card (`POST /api/agents/:role/test`): runs a fixed arithmetic question on exactly the saved provider/model/effort (no fallback, read-only, scratch folder `data/agent-test`) and shows the model the CLI reported, effort, thinking tokens (Claude `thinking_tokens`, Codex `reasoning_output_tokens`), answer and time. Codex does not report its model id (shown as "Model not reported"; its own header confirms `model` and `reasoning effort`). Verified 2026-10-16: all 7 agents OK; Claude low vs max effort = 0 vs 129 thinking tokens. |
| Claude accounts | akk1–akk5 all logged in, enabled and verified with real calls (2026-10-16). A newly discovered `~/.claude-account<N>` joins the fallback order after the other Claude logins automatically (still disabled until you enable it). |
| Dashboard (React/Vite/Tailwind/React Flow/Zustand, SSE) | Done — 8 pages, agent cards, live workflow graph, right panel (details, chat, logs, approvals) |
| Security | Loopback bind, token for remote, CSRF origin + JSON content-type guard, path guard, git subcommand allowlist, command allowlist, redaction |
| Fix loop (P1) | Done — red tests / `VERDICT: FAIL` create a Backend fix task before the failed verification, which re-runs after the fix merges; `maxFixRounds` per project (default 2, 0 = off) |
| Hardening (Phase 0b, 2026-10-16) | Audit risks fixed, each with a regression test in `server/test/hardening.test.ts` (15 tests): Host allowlist against DNS rebinding (R4); every `~/.claude*` folder protected (R8); retries and dispatch wait for unmet dependencies (R2); the worktree is kept when saving partial work fails (R7); the path guard follows junctions/symlinks (R1); Claude runs with `--setting-sources ""` so repository hooks cannot run (S1, verified with a real hook), studio git calls run with hooks disabled and test commands get no secret-looking env vars (R6); `.env`/key files are never served, copied or committed, and every API response is redacted (R5); the security review re-runs the project tests on the final integrated code (R3). Details: `docs/v2/phases/PHASE_0B.md`. |
| Tests | 68 server tests (53 + 15 hardening) + 19 web tests (2026-10-16: vitest + jsdom, `web/vitest.config.ts`; Agents 8 — model buttons, effort, Save, Test result line incl. "asked for X, got Y" / "effort not supported"; Live monitor 3; Settings 5 — fallback include/exclude/reorder, fix rounds per check; fetch-mock helper 3; `fetch` mocked in `web/src/test/fetchMock.ts`, real store) — previously 30 server tests (unit, API, end-to-end workflow incl. 3 fix-loop scenarios) — all passing — root `npm test` exits 0 |

## Verified runs
1. **Sample project (scripted, not AI)** through the browser UI: plan → approval → Backend+Frontend in
   parallel → `http-api` fails once and is retried → QA runs real `npm test` (6 passed) → Security/Reviewer
   PASS → report. 10/10 tasks.
2. **Real AI (Claude Code CLI, model haiku, all 7 agents, no fallback)** on a new "slugify" spec:
   PM planned 3 tasks, Architect wrote the plan, two Backend tasks ran in parallel, QA wrote tests and the
   studio ran `npm test` → **14 passed, 0 failed**; Security/Reviewer gave real reviews; total 121 s, $0.036.
   Script: `node scripts/real-ai-smoke.mjs claude-code haiku` (spends real quota).
3. Independent reviews (security + orchestrator) by worker models: no CRITICAL/HIGH in orchestration;
   CSRF/redaction/verdict/sample-name fixes applied afterwards.

4. **Mixed providers, all 7 agents real** ("Unit converter" spec, backend + frontend): PM/Architect on Claude acc2
   (opus) planned 6 tasks; Codex GPT-6.1-Sol built backend + frontend; Gemini 3.8 Flash wrote tests and the studio
   ran `npm test` → 17 then **26 passed, 0 failed**; Security (GPT-6-Astra) and Reviewer (Claude acc2) PASS; report
   generated, 12/12 tasks. Found and fixed on the way: Antigravity wrote files into an extra `--add-dir` folder
   (now no extra dirs; long prompts go to a scratch file in the worktree that is never committed), and
   Antigravity's Claude 4.6 stops when its RunCommand is denied (clear error now; Frontend moved to Codex).
   Command: `node scripts/real-ai-smoke.mjs current` (keeps the UI agent assignments; spends real quota).

## Run
```bash
npm install
npm run dev      # API 127.0.0.1:4317 + UI http://127.0.0.1:5317
npm start        # built UI served at http://127.0.0.1:4317
npm test
```

## Fix loop (P1, 2026-10-15)
- Trigger: a QA `test` task whose test command fails, or a Security/Reviewer task with `VERDICT: FAIL`
  (runners throw `VerificationFailedError` in `orchestrator/taskRunners.ts`).
- Action (`orchestrator/fixLoop.ts`, called from `TaskScheduler.fail`): in one transaction, create
  `fix-<failedKey>-<round>` (role backend, kind implement, inherits the failed task's dependencies,
  description = failure output / review findings via `fixTaskDescription()` in `agents/prompts.ts`), set the
  failed task back to `pending` depending on the fix task, and reorder so the fix sits before it. The
  graph shows the fix task like any other task; events `task.updated` and `task.fix_exhausted` are emitted.
- Limit: `maxFixRounds` (Settings page / `PUT /api/settings`, default 2, 0–5) counted **per verification task** in setting
  `fixRounds:<projectId>:<taskKey>` (2026-10-16: was per project, so test fixes used up the security review's budget).
- Re-run after a fix (2026-10-16): the QA test task only re-runs the existing tests; it does not write new tests again
  (otherwise each re-run added new failing tests and the loop never converged).
- Routing (2026-10-16): test failures only in frontend code (web/ workspace, .tsx/.jsx/.vue) go to the Frontend agent;
  everything else to Backend. The fix task gets a "What failed" digest (FAIL lines + first error line, failing npm
  workspaces) and a summary of every workspace (`1 failed | 103 passed; 11 passed`), not just the first one. When used up, the old behaviour applies and the task stays `failed` (manual retry
  still works).
- Tests: `server/test/workflow.test.ts` — red tests fixed by a scripted fix task then green; round limit
  reached → failed + blocked + manual retry; review FAIL → findings reach the fix task → review re-runs.
- After a fix made for review findings, the review task first re-runs the project tests (red → a test fix round),
  then reviews again. Review findings always go to the Backend agent.

## Known limitations
- No JDK/Maven on this machine: the Backend agent's Java/Spring Boot path is prompt-level only; the sample
  and the real-AI check use Node projects. `mvn test` is in the allowlist but unverified here.
- Test dependencies are not installed automatically (`npm ci` is allowlisted but not run before tests).
- Tests run under the per-project integration lock (deliberate: stable tree), so merges wait for test runs.
- A task interrupted after merge but before its test run is re-run in full on recovery (never auto-passed).
- SSE auth uses `?token=` because EventSource cannot send headers (only matters in remote mode).
- Requirement upload accepts text/Markdown only (no PDF/DOCX parsing).
- Chat runs the provider read-only; for Claude Code the user's own CLAUDE.md memory is still loaded by the CLI.
- Windows may hold handles on removed worktrees; directories are deleted by background retries.
- Antigravity models without a shell sometimes try to run commands and stop; Gemini Flash handled QA well,
  Claude 4.6 via Antigravity did not handle Frontend. A failed provider is retried on the same provider —
  automatic per-task fallback to the next provider after such a failure is a P1 item.
- Codex agents may run build/test commands inside Codex's own workspace-write sandbox (not the studio allowlist).
- Gemini CLI (`gemini`) adapter exists but the CLI is not installed; Gemini runs through Antigravity instead.

## Next priorities (P1)
1. ~~Fix-loop~~ — done (see "Fix loop" above). Possible follow-ups: route fixes to Frontend when only UI files are
   involved; re-run the QA test task after a review-driven fix.
2. `npm ci`/dependency install step with approval, and per-project setup commands.
3. Richer usage analytics page (per day / per project), budgets per project.
4. Project history timeline view and report diff between runs.
5. Optional ECC router adapter (`ai.mjs run --role ... --cwd <worktree>`) as a ProviderAdapter — design only, not activated.
6. Docker sandbox option for untrusted test commands.

## Where things are
- Architecture: `docs/ARCHITECTURE.md`, ADR: `docs/adr/0001-*.md`, frontend brief: `docs/FRONTEND_BRIEF.md`
- Server: `server/src` (`orchestrator/scheduler.ts` is the heart), tests in `server/test`
- UI: `web/src` (`store/studio.ts` holds live state)
- Sample: `sample-projects/todo-service` (script built by `node scripts/build-sample-script.mjs`)
- Runtime data (gitignored): `data/` — SQLite DB, workspaces, worktrees. Delete it to reset.
