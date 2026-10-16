# V2 — Current state

Last updated: 2026-10-17 ~00:25 (Opus 5.5, account 1 at 95 % of its 5-hour limit). Update this file after every step.

## Where we are
- **V2 work happens here**: worktree `D:\jarvis 2\asf-v2`, branch `feature/v2-studio` (from `main` at
  `fc615d2`). Run it with `start-v2-dev.cmd` (API http://127.0.0.1:4327, web http://127.0.0.1:5327, own
  `data/` from `.env`). The owner's V1 stays in `D:\jarvis 2\ai-software-factory-studio` on port 4317.
  Desktop preview entries `asf-v2-api` / `asf-v2-web` are in `D:\jarvis 2\.claude\launch.json`.
- `main`: `5354c5c` V1 baseline (tag `v1.0.0`) → `fc615d2` Phase 0b hardening (committed).
- Phases 1 and 2 committed (`bcdc5f4`, `8d6c719`). **Phase 3 batch 1 done, NOT committed** (ProcessBudget + sessions DB v5 +
  provider continuity + layout engine; see `docs/v2/phases/PHASE_3.md`). Opus fixed: a test helper that hung on an
  already-aborted signal, and the executor now refuses to start an agent for a task cancelled before it began.
  Full gates were running at hand-over (check: `npm run typecheck`, `npm run build`, `npm test`).
- Commit `6bd11bf` (Phase 3 batch 1) was made while the batch-2 workers were still writing, so it also contains their
  unfinished files; the next commit completes Phase 3.
- **Owner (2026-10-16 23:35, before sleeping): continue through the next phases without asking; commits on
  `feature/v2-studio` are approved. Still never: merge to `main`, push, restart V1, paid APIs, global installs.**
- Phase 3 batch 2 committed (see git log; 130 server + 259 web tests green). Browser check of the Workspace still to do.
- **Next: Phase 3 browser check, then Phase 4** — job briefs ready in `.ai-jobs/phase3-batch2.json` (p3-sessions, p3-workspace-ui).
- The running V1 on 4317 still runs pre-0b code until the owner restarts `start-studio.cmd` (no agents running).

## Follow-ups noted
- Verify whether Codex, Antigravity and Gemini CLIs load project-level config from a repository (S1 note).
- `npm install --ignore-scripts` for untrusted projects (S3, Phase 6).

## Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`,
headless `claude -p`, file tools only), GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
Limits at 00:25: Claude akk1 5 h 95 % (resets ~01:20); akk4 used for batches; akk5 available next; Codex resets 00:29.
- Risk noted: an empty argv value (`--setting-sources ""`) is rejected by the Windows .cmd bridge (R16); fine while
  Claude is `claude.exe` (this PC), must be fixed if a .cmd shim is ever used.
