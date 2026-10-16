# ADR 0001 — Single Node process, SQLite state, git worktrees per task

Date: 2026-10-15 · Status: accepted

## Context
The studio must run locally, survive restarts, show only verified progress, let agents work in
parallel without trampling each other, and never touch other installations or the user's checkout.

## Decision
1. One Node.js 24 process (Fastify) hosts the API, SSE stream, scheduler and provider adapters.
2. All state (projects, tasks, events, approvals, usage, config) lives in `node:sqlite` (WAL).
   The scheduler evaluates the graph synchronously from the DB on every tick, so a restart
   resumes from persisted state and per-task checkpoints.
3. Every implementation/test task gets its own git worktree on branch `asf/<slug>/<key>-a<attempt>`,
   created from the studio-owned integration branch `asf/<slug>/integration`. Results are merged with
   `--no-ff` under a per-project lock; conflicts abort the merge and fail the task.
4. Providers are adapters behind one interface; CLI agents edit files directly, API/scripted
   providers return a JSON file-edit protocol applied by the studio after path validation.

## Alternatives considered
- Separate worker processes/queue (BullMQ, Redis): extra services for a single-user local tool.
- better-sqlite3: native compilation on Windows; `node:sqlite` is built in.
- Shared working tree with file locks: impossible to isolate parallel agents safely.
- Docker sandbox per task: strongest isolation but heavy dependency; left for a future option.

## Consequences
- Parallelism is bounded by `maxParallelTasks` and by the integration lock (merges/test runs are serial).
- Users review and merge `asf/<slug>/integration` themselves; the studio never pushes.
- Agents do not get a shell: tests are run by the studio's allowlisted command runner.
