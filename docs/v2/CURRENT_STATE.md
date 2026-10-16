# V2 — Current state

Last updated: 2026-10-17 ~00:00 (Opus 5.5, account 1). Update this file after every step.

## Where we are
- **V2 work happens here**: worktree `D:\jarvis 2\asf-v2`, branch `feature/v2-studio` (from `main` at
  `fc615d2`). Run it with `start-v2-dev.cmd` (API http://127.0.0.1:4327, web http://127.0.0.1:5327, own
  `data/` from `.env`). The owner's V1 stays in `D:\jarvis 2\ai-software-factory-studio` on port 4317.
  Desktop preview entries `asf-v2-api` / `asf-v2-web` are in `D:\jarvis 2\.claude\launch.json`.
- `main`: `5354c5c` V1 baseline (tag `v1.0.0`) → `fc615d2` Phase 0b hardening (committed).
- **Phase 1** committed (`bcdc5f4`). **Phase 2** (Home + `/api/v2` read models): done, **not committed** — see
  `docs/v2/phases/PHASE_2.md`. V2 dev data has the scripted sample project (all roles set to the offline Scripted
  provider in the V2 data, no AI quota used).
- The running V1 on 4317 still runs pre-0b code until the owner restarts `start-studio.cmd` (no agents running).

## Follow-ups noted
- Verify whether Codex, Antigravity and Gemini CLIs load project-level config from a repository (S1 note).
- `npm install --ignore-scripts` for untrusted projects (S3, Phase 6).

## Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`,
headless `claude -p`, file tools only), GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
Limits at 00:00: Claude akk1 5 h 85 % (over the 80 % mark → next work goes to akk4 / GPT after 00:29 / Gemini).
