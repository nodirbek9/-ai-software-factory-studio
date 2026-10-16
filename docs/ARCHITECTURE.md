# AI Software Factory Studio — Architecture

Local-first multi-agent development studio. One Node.js process orchestrates AI agents,
persists everything in SQLite, isolates code changes in git worktrees and streams live
state to a React dashboard over Server-Sent Events.

```
┌──────────────────────── Browser (React + Vite) ────────────────────────┐
│ Sidebar · TopBar · Agent cards · Workflow graph (React Flow) · Details │
│ Zustand store  ◄── SSE /api/events (Last-Event-ID replay)              │
│                ──► REST /api/*  (JSON, zod-validated on the server)    │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 127.0.0.1:4317 (token required if not loopback)
┌───────────────────────────────▼────────────────────────────────────────┐
│ Fastify server (server/src)                                            │
│  api/routes ─► ProjectService ─► TaskScheduler ─► AgentExecutor        │
│                     │                 │               │                │
│              ApprovalService    WorkspaceManager   ProviderRegistry    │
│                     │           (git worktrees,    (Claude Code CLI,   │
│                     │            path guard,        Codex CLI, Gemini  │
│                     │            CommandRunner)     CLI, OpenAI-compat,│
│                     ▼                               Scripted offline)  │
│  Repositories (node:sqlite) ◄──── EventStream (persist + broadcast)    │
└────────────────────────────────────────────────────────────────────────┘
          data/studio.db     data/workspaces/<slug>     data/worktrees/<project>/<task>
```

## Key decisions

| Topic | Decision | Why |
|---|---|---|
| Runtime | Single Node 24 process, TypeScript run with `tsx` | No microservices; one process is enough for a local tool |
| Persistence | Built-in `node:sqlite` (WAL) | No native build step on Windows, transactional, single file |
| Live updates | SSE with persisted event ids | One-way stream is all the UI needs; replay on reconnect |
| Code isolation | One git worktree per task, merged into a per-project integration branch | Parallel tasks never share a working tree; user's checkout is never touched |
| Agent output | CLI providers edit files directly in the worktree; API/scripted providers return a JSON file-edit protocol that the executor applies after path validation | One verification path (git diff + commit) for every provider |
| Progress | Only verified events move progress: a commit merged, a test command exit code 0, a parsed review verdict | Dashboard never shows simulated progress |
| Shell | No shell from chat. Only allowlisted test/build commands, parsed to argv, no metacharacters; others need an approval | Prevent arbitrary execution |
| Git safety | Only `init/worktree add/add/commit/merge --no-ff/diff/log/worktree remove` on studio-owned branches. Never push, reset, clean or delete user branches | No destructive git operations |

## Workflow (task graph)

```
plan (PM) ─► architecture (Architect) ─► plan-approval (gate, user)
                                              │
                    ┌─────────────────────────┴───────────────┐
              implement tasks (Backend / Frontend, from PM's JSON plan, own deps)
                    └─────────────────────────┬───────────────┘
                                         qa (QA: tests + real test command)
                                              │
                                     security (Security review)
                                              │
                                      review (Reviewer verdict)
                                              │
                                      report (system-generated)
```

The PM's task list is validated (zod + DAG check). Missing QA/Security/Review steps are
appended automatically so every project ends with verification.

## Task state machine

```
pending ─► ready ─► running ─► completed
   │         ▲         │  └──► failed ──(retry, attempts < max)──► ready
   │         │         └─────► ready (pause-abort / crash recovery)
   │         │                  failed ──(fix loop: behind a new fix task)──► pending
   └──► blocked (a dependency failed) ──(dependency retried)──► pending
gate tasks: ready ─► waiting_approval ─► completed | failed (rejected)
any non-terminal ─► cancelled
```
Transitions are enforced in `domain/taskStateMachine.ts`; an illegal transition throws.

## Fix loop

`orchestrator/fixLoop.ts`. When a QA `test` task goes red or a Security/Reviewer task returns
`VERDICT: FAIL`, the runner throws `VerificationFailedError` (source `tests` | `review`, plus the
redacted test output tail or review text). If the project still has fix rounds left
(`maxFixRounds` setting, default 2, 0 = off; usage counted in setting `fixRounds:<projectId>`),
one SQLite transaction:

1. creates `fix-<failedKey>-<round>` (role `backend`, kind `implement`) with the failed task's
   old `dependsOn` and a description built by `fixTaskDescription()` (`agents/prompts.ts`);
2. moves the failed task to `pending`, `dependsOn: [fixKey]`, `maxAttempts ≥ attempt + 1`;
3. shifts `orderIndex` so the fix task sits right before it.

The fix task runs like any implement task (worktree → merge); the verification then re-runs on
the integration branch. With no rounds left the old behaviour applies (tests: normal retry while
attempts remain; review FAIL: permanent), so the task ends `failed` and blocks its dependants.

## Checkpoints & recovery

Each task stores a checkpoint stage: `worktree` → `agent_done` → `committed` → `merged`.
On startup, tasks left `running` are recovered: `merged` → completed; anything earlier →
the worktree is removed and the task returns to `ready` (counts as an attempt).
Projects that were `running` resume automatically; `paused` projects stay paused.

## Pause / cancel

* **Pause** — scheduler dispatches nothing new; running tasks finish (graceful drain).
* **Cancel task** — AbortController kills the provider process tree; task → `cancelled`.
* **Retry** — failed/cancelled task → `ready`, blocked dependants → `pending`.

## Provider adapters

`ProviderAdapter { id, detect(), run(request, signal) }`. Detection runs `<cli> --version`
with a timeout; nothing is assumed about keys or subscriptions. Providers start **disabled**
until the user enables them. Per-agent assignment = provider + model; routing policy can
fall back to the next enabled+available provider (logged as an event). Budgets per provider
are checked before every run against recorded usage.

| Provider | Edits files | Detection |
|---|---|---|
| Claude Code CLI (account 1) | yes (`--permission-mode acceptEdits`, tools limited to Read/Edit/Write/Glob/Grep) | `claude --version` |
| Claude Code CLI (account 2) | same; runs `claude` with `CLAUDE_CONFIG_DIR=~/.claude-account2` (the login the user's `claude2` command uses; setting `configDir` overrides) | config dir exists + `claude --version` |
| OpenAI Codex CLI (GPT-6.1-Sol / 6-Astra / 6-Luna) | yes (`codex exec --json --sandbox workspace-write`; may run project tests inside its sandbox) | `codex --version` |
| Antigravity CLI (Gemini 3.8 Flash, Claude 4.6 on Google quota) | yes (`agy -p --mode accept-edits --output-format json`; no shell tool; long prompts via temp file) | `agy --version` |
| Gemini CLI | yes (`gemini -p ... --approval-mode auto_edit`) | `gemini --version` |
| OpenAI-compatible HTTP | via file protocol | base URL + key env var configured in `.env` |
| Scripted (offline, **not AI**) | via file protocol | always; replays `.asf-script.json` from the workspace |

Credentials live only in the server's `.env` (referenced by env var name); the API never
returns them and logs pass through `security/redact.ts`.

## Security

* Binds `127.0.0.1` by default. Non-loopback bind refuses to start without `ASF_AUTH_TOKEN`;
  every `/api` request then needs `Authorization: Bearer <token>` (or `?token=` for SSE).
* Mutating requests must come from an allowed Origin and use `Content-Type: application/json`
  (HTML forms and simple cross-site requests cannot do both) — CSRF guard.
* Filesystem: project workspaces must resolve (realpath) inside `ASF_APPROVED_ROOTS` or
  `data/workspaces`. File protocol paths are relative, no `..`, never inside `.git`.
* Command runner: allowlist of test/build commands; argv only; output redacted and capped.

## ECC / Jarvis

Not integrated and not touched. A future optional adapter could call the ECC router through
its public CLI (`node <router>/ai.mjs run --role <role> --cwd <worktree> --prompt-file f`) as
one more `ProviderAdapter` with `editsFiles: true`. It is **not implemented or activated**.
Jarvis is out of scope.
