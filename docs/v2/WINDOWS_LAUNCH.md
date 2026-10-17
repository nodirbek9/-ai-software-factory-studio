# Windows launch guide (V2)

Requirements: Windows 10/11, Node.js ≥ 22.13 (`node -v`), Git for Windows, Microsoft Edge (for E2E only). AI CLIs
(Claude Code, Codex, Gemini, Antigravity) are optional; without them only the offline Scripted provider works.

## Today (before the cut-over)
| What | How | Address | Data |
|---|---|---|---|
| V1 studio (daily use) | double-click `D:\jarvis 2\ai-software-factory-studio\start-studio.cmd` | http://127.0.0.1:4317 | `ai-software-factory-studio\data` |
| V2 development | double-click `D:\jarvis 2\asf-v2\start-v2-dev.cmd` | http://127.0.0.1:5327 (API 4327) | `asf-v2\data` (from `.env`) |

Both can run at the same time: different ports and data folders. Close a window (or Ctrl+C) to stop that studio.
Before stopping V1, check that no agent is working: open http://127.0.0.1:4317/api/live — `running` must be `[]`.

## Checks (V2 folder)
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

## After the cut-over (owner, MIGRATION_PLAN.md step D)
`start-studio.cmd` in `ai-software-factory-studio` starts V2 on port 4317 with the original `data/` folder. The first
start migrates the database once (schema 2 → 5) and writes `data/backups/studio-before-v5.db` first.

## Rollback
1. Close the studio window. 2. Copy `data/backups/studio-before-v5.db` over `data/studio.db` (delete
`studio.db-wal` and `studio.db-shm`). 3. `git checkout v1.0.0` (or the Phase 0b commit on `main`), `npm install`,
start `start-studio.cmd`. Work done in V2 after the cut-over is not in the backup. Drill:
`scripts/rollback-drill.mts` (docs/v2/phases/PHASE_7.md §5).
