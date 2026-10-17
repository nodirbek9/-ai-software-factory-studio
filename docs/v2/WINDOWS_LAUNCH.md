# Windows launch guide (V2)

Requirements: Windows 10/11, Node.js ≥ 22.13 (`node -v`), Git for Windows, Microsoft Edge (for E2E only). AI CLIs
(Claude Code, Codex, Gemini, Antigravity) are optional; without them only the offline Scripted provider works.

## Daily use (since the cut-over on 2026-10-17)
| What | How | Address | Data |
|---|---|---|---|
| Studio (V2) | double-click `D:\jarvis 2\ai-software-factory-studio\start-studio.cmd` | http://127.0.0.1:4317 | `ai-software-factory-studio\data` |
| Development copy (optional) | double-click `D:\jarvis 2\asf-v2\start-v2-dev.cmd` | http://127.0.0.1:5327 (API 4327) | `asf-v2\data` (from `.env`) |

Both can run at the same time: different ports and data folders. Close a window (or Ctrl+C) to stop that studio.
Before stopping it, check that no agent is working: open http://127.0.0.1:4317/api/live — `running` must be `[]`.

## Checks (repository folder)
```bash
npm run typecheck
```
```bash
npm test
```
```bash
npm run test:e2e
```
`test:e2e` builds the dashboard and runs Playwright on Edge against a temporary studio on port 4397 with the Scripted
provider only; it spends no AI quota and never touches `data/`.

## Cut-over record (MIGRATION_PLAN.md step D, 2026-10-17)
1. V1 idle check: 0 running, 0 queued. V1 stopped.
2. Final backup `D:\jarvis 2\backups\asf-v1-final-2026-10-17\`: `studio.db` (VACUUM INTO, integrity ok, 8 projects,
   88 tasks, schema 2), `data-files.tar.gz` (rest of `data/`), `repo-main.bundle` (git `main` + tags before the merge).
3. `git merge --no-ff feature/v2-studio` (`b2691fc`), tag `v2.0.0`.
4. `npm install`, typecheck, build, `npm test` (server 235 + 1 skipped, web 487), `npm run test:e2e` (11): green.
5. `start-studio.cmd`: schema 2 → 5, 8 projects, 88 tasks, 7 runs, no task without a run, FK clean,
   `data/backups/studio-before-v5.db` written.
6. Smoke on the real data: all 11 pages load with no console or request errors, 8 projects listed, Home "All systems
   operational". The end-to-end Scripted run was checked by the E2E suite on the merged code (temp data); in the real
   database the sample project would use the owner's configured AI providers and spend quota.

## Rollback
1. Close the studio window. 2. Copy `data/backups/studio-before-v5.db` (or
`D:\jarvis 2\backups\asf-v1-final-2026-10-17\studio.db`) over `data/studio.db` and delete `studio.db-wal` and
`studio.db-shm`. 3. `git checkout 6307bd6` (V1 with the Phase 0b fixes; `v1.0.0` is V1 without them), `npm install`,
start `start-studio.cmd`. Work done in V2 after the cut-over is not in the backup. Drill:
`scripts/rollback-drill.mts` (docs/v2/phases/PHASE_7.md §5).
