# V2 — Current state

> **2026-10-16 23:20 — V2 work has moved to the worktree `D:\jarvis 2\asf-v2` (branch `feature/v2-studio`).**
> Phase 0b is committed on `main` (`fc615d2`). Read `D:\jarvis 2\asf-v2\docs\v2\CURRENT_STATE.md` for the live
> state; this folder is the owner's daily V1 (port 4317).

Last updated: 2026-10-16 ~22:45 (Opus 5.5, account 1). Update this file after every step.

## Where we are
- **Phase 0** (audit, backup, plan): done; plan approved by the owner on 2026-10-16.
- **Git baseline**: done — repo on `main`, commit `5354c5c` "chore: V1 baseline", tag `v1.0.0`; repo-local
  `user.name=nodir`, `user.email` = owner's address, `core.autocrlf=false` (global config untouched).
- **Phase 0b** (V1 hardening): **code done and green, NOT committed** — waiting for the owner's OK to commit.
  Details: `docs/v2/phases/PHASE_0B.md`. Gates: `npm test` 68 server (53 + 15 hardening) + 19 web,
  `npm run typecheck`, `npm run build` all green.
  Uncommitted files: `server/src/{api/routes.ts, config.ts, domain/taskStateMachine.ts, orchestrator/scheduler.ts,
  orchestrator/taskRunners.ts, providers/cliProviders.ts, workspace/commandRunner.ts, workspace/git.ts,
  workspace/processRunner.ts, workspace/workspaceManager.ts, security/sensitiveFiles.ts (new)}`,
  `server/test/hardening.test.ts` (new), `docs/v2/phases/PHASE_0B.md` (new), `HANDOFF.md`, this file,
  `NEXT_ACTIONS.md`.
- The running V1 on port 4317 still runs the old code until it is restarted (owner restarts
  `start-studio.cmd` when no agents run).

## Done earlier
- Web test suite (19 tests). V1 backup `D:\jarvis 2\backups\asf-v1-2026-10-16\` (do not delete).
- `docs/v2/` complete: audit, inventory, PRD, architecture, decisions D-001…D-020 (D-009 revised), phases
  0–7 incl. 0b, design system, screen specs, workspace spec, workflow engine spec, security review, test plan,
  performance baseline, migration strategy/plan, reuse-vs-rebuild, reference images + notes.

## Follow-ups noted (not part of 0b)
- Verify whether Codex, Antigravity and Gemini CLIs load project-level config from a repository (S1 note).
- `npm install` with `--ignore-scripts` for untrusted projects (S3, Phase 6).
- Fastify warns that `disableRequestLogging` is deprecated (`server/src/app.ts`) — harmless, fix in Phase 1.

## No worker jobs running
OmniRoute/free models must not be used (owner, 2026-10-16).

## Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`),
GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
Limits at 22:40: Claude akk1 5 h ≈ 60 % used (resets 00:20); Codex ≈ 2 % until 00:29; Antigravity Claude 0 %.
