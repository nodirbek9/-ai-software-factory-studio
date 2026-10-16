# V2 — Next actions (in order)

Work in `D:\jarvis 2\asf-v2` (branch `feature/v2-studio`). Read `docs/v2/CURRENT_STATE.md` first.
Phases 0–6 are done and committed (last: `7859975`). What is left needs the owner or is Phase 7.

## 1. Browser check (owner present, or preview start allowed)
Start `asf-v2-api` + `asf-v2-web` (or `start-v2-dev.cmd`), V2 data only, agents on the offline Scripted provider.
Check with the scripted sample project: Workspace (6–8 panels, send to two sessions, reorder, reload), Workflow Builder
(open Standard → Duplicate → edit → Validate → Simulate → Run; live node status; cancel), Tasks (board/list/drawer/diff),
Project detail tabs, Repos, QA & Security (gates, findings after a security FAIL sample, Create fix task, audit approval),
Logs (filters, live tail, export), Models (Usage, Fallback). Fix what breaks, gates, commit.

## 2. Owner decisions
- Phase 3c PTY terminal (D-019, native dependency) — yes/no.
- Phase 7 merge into `main` and the `v2.0.0` tag — only with the owner's "ha".

## 3. Phase 7 — stabilization (`IMPLEMENTATION_PHASES.md`)
1. Playwright E2E against a temp-data test server with the Scripted provider (D-017) for every main flow.
2. Independent security review of Phases 3–6 (worker, then Opus final authority): new routes (`workflowRoutes`,
   `v2WorkRoutes`, `qualityRoutes`, session routes), audit approval path, findings redaction, task diff sensitive-file filter.
3. Performance check vs `PERFORMANCE_BASELINE.md` (initial JS ≤ 160 KB gzip — index chunk is ~109 KB gzip now).
4. Migration validation on a fresh copy of the real V1 DB with the scheduler disabled (rehearsal already passed twice).
5. Close the gaps listed in CURRENT_STATE "Open items" that are cheap (Runs page, Files tab, events index).
6. Docs: README/HANDOFF for V2, Windows launch guide, rollback drill.
