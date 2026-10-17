# V2 — Next actions (in order)

V2.1 (`v2.1.0`) is merged into `main` and runs on port 4317 (`D:\jarvis 2\ai-software-factory-studio`). New work: a
feature branch in the dev worktree `D:\jarvis 2\asf-v2` (ports 4327/5327, own data), then merge + restart with the
owner's OK. Read `docs/v2/CURRENT_STATE.md` first.

## 1. Owner decisions (ask, never assume)
1. Set `ASF_AUTH_TOKEN` if other Windows users or networked agent sandboxes share this PC (V21-S2 residual).

## 2. Follow-ups (normal worker pipeline, on a feature branch)
1. Runs page `#/runs` (UI spec §6) — today it opens the V1 Monitor.
2. Project detail Files tab; `events(created_at)` index if Logs gets slow; a coverage scanner for the release gate.
3. Payload: `/api/projects` (153 KB, full specs/plans for every project) could become a summary list.
