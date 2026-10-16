# Migration Plan — concrete steps

Principles: `MIGRATION_STRATEGY.md`. Commands are for PowerShell/Git Bash on the owner's PC. Steps marked
**[owner]** need an explicit "ha" in chat.

## Step A — Git baseline (Phase 0, **[owner]**)
1. Confirm no agents run: `GET http://127.0.0.1:4317/api/live` → `running: []`.
2. Check `.gitignore` covers `node_modules/`, `data/`, `web/dist/`, `.env`, `coverage/`, `.ai-jobs/` (it does
   today); add `backups/` is not needed (backups live outside the folder).
3. `git init -b main` → `git add -A` → `git commit -m "chore: V1 baseline"` → `git tag v1.0.0`.
4. Phase 0b commits on `main` (hardening); restart V1 only when idle.
5. `git branch feature/v2-studio` → `git worktree add "D:/jarvis 2/asf-v2" feature/v2-studio`.
6. In `D:\jarvis 2\asf-v2`: `npm install`; `.env` with `ASF_PORT=4327`, `ASF_DATA_DIR=./data`; web dev port
   5327 (`.claude/launch.json` entry `asf-v2-web`); `start-v2-dev.cmd` helper.

## Step B — DB migrations (inside V2, each with automatic backup)

| Version | Phase | Change | Type | Verification |
|---|---|---|---|---|
| v3 | 2 | migration runner gains pre-migration backup + `schema_version` history table | infra | backup file exists, version recorded |
| v4 | 2 | indexes: `events(type, id)`, `usage_records(created_at)`, `usage_records(provider_id, created_at)`, `tasks(status, updated_at)`; `audit_events` view or table | additive | `EXPLAIN QUERY PLAN` uses indexes |
| v5 | 3 | `agent_sessions`, `session_turns`, `workspace_layouts`; `usage_records.session_id` | additive | WS tests |
| v6 | 4 | `workflows`, `runs` (+ backfill 1 run per project), `tasks` rebuild with `run_id`, `node_id`, `fix_rounds_max`, `UNIQUE(run_id,key)`; `usage_records.run_id`; settings `fixRounds:<projectId>:<key>` copied to `fixRounds:run-<projectId>:<key>` | rebuild | counts equal; every task has a run; `PRAGMA foreign_key_check` empty; golden test |
| v7 | 6 | `quality_results`, `findings` | additive | QA center tests |

(The specs use these same numbers. Sessions (v5) land before workflows/runs (v6); they are independent.)

Verification queries for v6 (run on a copy first):
```sql
SELECT COUNT(*) FROM tasks;                                   -- equals pre-migration count
SELECT COUNT(*) FROM tasks WHERE run_id IS NULL;              -- 0
SELECT p.id FROM projects p LEFT JOIN runs r ON r.project_id = p.id WHERE r.id IS NULL;  -- no rows
SELECT run_id, key, COUNT(*) c FROM tasks GROUP BY run_id, key HAVING c > 1;            -- no rows
```

## Step C — Migration rehearsal (Phase 4 and again in Phase 7)
1. Copy the latest V1 DB snapshot (`VACUUM INTO`) into a temp dir.
2. Start V2 server with `ASF_DATA_DIR=<temp>`, `ASF_DISABLE_SCHEDULER=1`, port 4337.
3. Migrations run; run the verification queries; open Home, Projects, Runs, Tasks in Playwright read-only.
4. Record results in `CURRENT_STATE.md`.

## Step D — Cut-over (after Phase 7, **[owner]**)
1. V1 idle check; stop V1 (close `start-studio.cmd` window).
2. Fresh backup: `VACUUM INTO D:\jarvis 2\backups\asf-v1-final-<date>\studio.db` + data tar.
3. On `main`: `git merge --no-ff feature/v2-studio`; `git tag v2.0.0`; `npm install`; `npm test`; `npm run build`.
4. Start `start-studio.cmd` (port 4317, original `data/`): migrations v3…v7 run once with their backups.
5. Smoke: Home loads, projects listed, one Scripted sample run end to end.
6. Keep the V2 worktree until the owner confirms; then `git worktree remove "D:/jarvis 2/asf-v2"` **[owner]**.

## Step E — Rollback (any time after cut-over)
1. Stop the studio. 2. Restore `data/studio.db` from `data/backups/studio-before-v3.db` (or the final
backup). 3. `git checkout v1.0.0` (or a V1 worktree). 4. `npm install`, start. V1 data written after
cut-over (new projects/runs) is lost on rollback — the restore point is stated in the rollback dialog.
Rollback drill is part of Phase 7.

## SUMMARY
Git baseline and V1 hardening first, V2 in its own worktree/ports/data, five backed-up migrations (one table
rebuild), rehearsals on DB copies with the scheduler off, then an owner-approved cut-over with a tested
rollback.
