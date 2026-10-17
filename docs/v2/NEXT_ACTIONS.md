# V2 — Next actions (in order)

V2 is merged into `main` (`v2.0.0`) and is the studio on port 4317 since 2026-10-17 (cut-over record:
`docs/v2/WINDOWS_LAUNCH.md`). Work in `D:\jarvis 2\ai-software-factory-studio`. Read `docs/v2/CURRENT_STATE.md` first.

## 1. Owner decisions (ask, never assume)
1. Remove the merged V2 worktree `D:\jarvis 2\asf-v2` when the owner is happy with V2 (MIGRATION_PLAN step D.6):
   `git worktree remove "D:/jarvis 2/asf-v2"` — its `data/` and `.env` go with it.
2. **Phase 3c PTY terminal** (D-019, native dependency) — yes/no.
3. **P7-S8**: package install scripts in workflow tool nodes — add project trust / `--ignore-scripts`?

## 2. Follow-ups (normal worker pipeline, on a feature branch)
1. Payload target (≤ 150 KB): the V2 shell still loads the V1 project snapshot (`/api/projects/:id`, up to 701 KB on
   the real DB); move the pages that need it to summary endpoints, keep the board/monitor pages working.
2. Runs page `#/runs` (UI spec §6), Project detail Files tab, `events(created_at)` index, coverage scanner.
