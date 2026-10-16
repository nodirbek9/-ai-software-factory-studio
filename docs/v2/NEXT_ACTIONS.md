# V2 — Next actions (in order)

Read `docs/v2/CURRENT_STATE.md` first. Do the first unfinished step; update `CURRENT_STATE.md` after it.

## 1. Owner approval (Phase 0 exit)
Present the Uzbek summary (already given in the session of 2026-10-16; re-summarize from `V2_ARCHITECTURE.md`
and `IMPLEMENTATION_PHASES.md` if this is a new session) and get two explicit answers:
(a) plan approved, (b) git baseline allowed (D-020).

## 2. Git baseline (after "ha")
`MIGRATION_PLAN.md` Step A 1–3: check `/api/live` running is empty, `git init -b main`, `git add -A`,
`git commit -m "chore: V1 baseline"`, `git tag v1.0.0`. Verify `git status` clean and that `data/`,
`node_modules/`, `web/dist/`, `.env` are not tracked.

## 3. Phase 0b — V1 hardening on `main`
1. Phase-planner writes `docs/v2/phases/PHASE_0B.md`: one chunk per item R1, R2, R3, R4, R5, R6+S1, R7, R8
   (`V1_AUDIT.md` §4, `SECURITY_REVIEW.md` §2) — each chunk = failing regression test first, then the fix,
   ≤ 5 files.
2. Implement chunks (own limit first; then akk4 / GPT per the model order). Gates: `npm test`,
   `npm run typecheck`, `npm run build`.
3. Opus reviews the diff; commit per chunk (`fix(security): …`) only with the owner's OK to commit.
4. Restart V1 on 4317 only when no agents run, so the owner gets the fixes.

## 4. Create the V2 worktree
`MIGRATION_PLAN.md` Step A 5–6 (branch, worktree `D:\jarvis 2\asf-v2`, `.env` ports 4327/5327, fresh
`ASF_DATA_DIR`, `.claude/launch.json` entries, `start-v2-dev.cmd`).

## 5. Phase 1 — design foundation + app shell
Phase-planner writes `docs/v2/phases/PHASE_1.md` from `IMPLEMENTATION_PHASES.md` Phase 1,
`DESIGN_SYSTEM.md`, `UI_SCREEN_SPECIFICATIONS.md` §0. Ask the owner once for the new web dependencies
(react-resizable-panels, cmdk, @tanstack/react-virtual, @vitest/coverage-v8, @playwright/test; later
dagre/xterm/CodeMirror). Then chunks → tests → review → Uzbek report.

## Then
Phases 2–7 in order (`IMPLEMENTATION_PHASES.md`); each phase: phase plan → chunks → gates → review →
`CURRENT_STATE.md` → Uzbek report.
