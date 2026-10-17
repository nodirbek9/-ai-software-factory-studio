# V2 — Next actions (in order)

V2.2 (`v2.2.0`) is merged into `main` and runs on port 4317 (`D:\jarvis 2\ai-software-factory-studio`). New work: a
feature branch in the dev worktree `D:\jarvis 2\asf-v2` (ports 4327/5327, own data), then gates
(`npm test`, `npm run typecheck`, `npm run test:e2e` incl. the every-button audit) and merge + restart with the
owner's OK. Read `docs/v2/CURRENT_STATE.md` first. The V2 plan (Phases 0–7) and its follow-ups are complete.

## Owner decisions (ask, never assume)
1. Set `ASF_AUTH_TOKEN` if other Windows users or networked agent sandboxes share this PC (V21-S2 residual).

## Optional ideas (not planned)
- `/api/projects` as a summary list (153 KB on the real DB today).
- A coverage scanner so a run can reach "ready for release" (the gate is honest "not run" today).
- If the studio stops unexpectedly, read `data/logs/lifecycle.log` first.
