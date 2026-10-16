# V2 — Current state

Last updated: 2026-10-16 ~22:10 (Opus 5.5, account 1). Update this file after every step.

## Phase 0 — Audit, backup, planning: **docs complete, waiting for owner approval**

### Done
- Web test suite (19 tests, `web/vitest.config.ts`, `web/src/test/`); root `npm test` green (53 server + 19
  web), typecheck + build clean.
- V1 backup `D:\jarvis 2\backups\asf-v1-2026-10-16\` (source 154 files, data folders, consistent DB snapshot:
  8 projects, 88 tasks). Do not delete.
- `docs/v2/` complete (all reviewed by Opus):
  | File | Author |
  |---|---|
  | `V1_AUDIT.md` (306 lines, risks R1–R19) | GPT-6-Astra |
  | `FEATURE_INVENTORY.md` | Opus 4.6 (Antigravity) → refreshed by GPT-6-Astra |
  | `V2_PRD.md`, `DESIGN_SYSTEM.md`, `TEST_PLAN.md` | GPT-6-Luna |
  | `V2_ARCHITECTURE.md`, `DECISIONS.md` (D-001…D-020 + answers), `IMPLEMENTATION_PHASES.md`, `PERFORMANCE_BASELINE.md` (measured), `WORKFLOW_ENGINE_SPEC.md`, `AGENT_WORKSPACE_SPEC.md`, `SECURITY_REVIEW.md`, `UI_SCREEN_SPECIFICATIONS.md`, `REUSE_VS_REBUILD.md`, `MIGRATION_STRATEGY.md`, `MIGRATION_PLAN.md`, `reference/REFERENCE_NOTES.md` | Opus 5.5 |
- Project `CLAUDE.md` (rules for any Claude session here) and owner guide `DAVOM_ETTIRISH.md`.

### Key findings that changed the plan
- Scheduler/runners read all tasks of a project → multi-run needs run scoping + `tasks` table rebuild
  (D-009 revised).
- 8 HIGH risks (audit R1–R7 + S1 project-level Claude hooks) → new **Phase 0b V1 hardening** on `main` before
  V2 work.
- V1 runs Claude with `--no-session-persistence` → native resume needs a V2 adapter change.

### No worker jobs running
All router/akk4 jobs were stopped or finished. OmniRoute/free models must not be used (owner, 2026-10-16).

### Waiting for the owner (nothing happens without an explicit "ha")
1. Approve the V2 plan (architecture, 0–7 phases incl. 0b).
2. D-020 git baseline: `git init`, commit V1, tag `v1.0.0`; then Phase 0b on `main`; then branch
   `feature/v2-studio` + worktree `D:\jarvis 2\asf-v2` (ports 4327/5327, fresh data).
3. Later approvals: new web dependencies (D-003, Phase 1), optional PTY terminal (D-019, Phase 3c), opt-in
   real-AI smoke runs (spend quota).

### Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`),
GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
Limits at 22:05: Claude akk1 5 h ≈ 40 % used (resets 00:20); Codex out until 00:29; Antigravity Claude 0 %.
