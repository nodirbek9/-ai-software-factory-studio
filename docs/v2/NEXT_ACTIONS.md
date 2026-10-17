# V2 — Next actions (in order)

Work in `D:\jarvis 2\asf-v2` (branch `feature/v2-studio`). Read `docs/v2/CURRENT_STATE.md` first.
Phases 0–7 are done and committed. Everything left needs the owner, or is a follow-up listed below.

## 1. Owner decisions (ask, never assume)
1. **Merge into `main` + tag `v2.0.0` + cut-over** — MIGRATION_PLAN.md step D. Before it: V1 idle check
   (`GET http://127.0.0.1:4317/api/live` → `running: []`), fresh backup, then merge `--no-ff`, `npm install`, gates,
   start `start-studio.cmd`, smoke (Home, projects, one Scripted sample run). Rollback = WINDOWS_LAUNCH.md.
2. Until the cut-over: **restart V1** so the Phase 0b fixes apply (V1 still runs pre-0b code).
3. **Phase 3c PTY terminal** (D-019, native dependency) — yes/no.
4. **P7-S8**: package install scripts in workflow tool nodes — add project trust / `--ignore-scripts`?

## 2. Follow-ups (no owner decision needed, normal worker pipeline)
1. Payload target (≤ 150 KB): the V2 shell still loads the V1 project snapshot (`/api/projects/:id`, up to 701 KB on
   the real DB); move the pages that need it to summary endpoints, keep V1 Dashboard/Monitor working.
2. Runs page `#/runs` (UI spec §6), Project detail Files tab, `events(created_at)` index, coverage scanner.
3. Re-run `npm run test:e2e`, `scripts/migration-rehearsal.mts` and `scripts/rollback-drill.mts` right before the
   cut-over (PHASE_7.md §1, §4, §5).
