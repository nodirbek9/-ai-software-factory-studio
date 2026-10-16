# V2 — Next actions (in order)

Read `docs/v2/CURRENT_STATE.md` first. Do the first unfinished step; update `CURRENT_STATE.md` after it.

## 1. Commit Phase 0b (needs the owner's OK)
`git add -A` → `git commit -m "fix(security): Phase 0b V1 hardening (R1-R8, S1)"` with a body listing the
items (see `docs/v2/phases/PHASE_0B.md`). Then tell the owner to restart V1 (`start-studio.cmd`) when no
agents run (`GET /api/live` → `running: []`), so the fixes take effect.

## 2. Create the V2 worktree
`MIGRATION_PLAN.md` Step A 5–6: `git branch feature/v2-studio`, `git worktree add "D:/jarvis 2/asf-v2"
feature/v2-studio`, `npm install` there, `.env` with `ASF_PORT=4327` and a fresh `ASF_DATA_DIR`, web dev port
5327 (`.claude/launch.json` entries), `start-v2-dev.cmd`.

## 3. Phase 1 — design foundation + app shell
1. Write `docs/v2/phases/PHASE_1.md` from `IMPLEMENTATION_PHASES.md` Phase 1, `DESIGN_SYSTEM.md`,
   `UI_SCREEN_SPECIFICATIONS.md` §0: chunks ≤ 5 files, each with its tests.
2. Ask the owner once for the new web dev/runtime dependencies (react-resizable-panels, cmdk,
   @tanstack/react-virtual, @vitest/coverage-v8, @playwright/test).
3. Implement chunk by chunk (own limit first; then akk4 / GPT per the model order), gates after each chunk,
   Opus review, `CURRENT_STATE.md`, Uzbek report.

## Then
Phases 2–7 in order (`IMPLEMENTATION_PHASES.md`).
