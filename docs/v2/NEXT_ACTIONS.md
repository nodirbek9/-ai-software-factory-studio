# V2 — Next actions (in order)

Work in `D:\jarvis 2\asf-v2` (branch `feature/v2-studio`). Read `docs/v2/CURRENT_STATE.md` first.

## 1. Commit Phase 1 (needs the owner's OK)
In the worktree: `git add -A` → `git commit -m "feat(web): V2 design tokens, app shell, navigation and command palette"`.

## 2. Phase 2 — Home dashboard + read models
1. Write `docs/v2/phases/PHASE_2.md` from `IMPLEMENTATION_PHASES.md` Phase 2 and
   `UI_SCREEN_SPECIFICATIONS.md` §1 (chunks ≤ 5 files, tests per chunk). Include the two Phase 1 leftovers.
2. Backend first: migration runner with pre-migration backup (D-018), `ProcessBudget` (D-006, scheduler only),
   `/api/v2/overview`, `/api/v2/usage/summary`, `/api/v2/system/health`, paginated `/api/v2/events`.
3. Frontend: Home page replacing V1 Dashboard (V1 agent cards + right panel stay reachable).
4. Gates, browser check on 4327/5327, Opus review, `CURRENT_STATE.md`, Uzbek report.

## Then
Phases 3–7 in order (`IMPLEMENTATION_PHASES.md`).
