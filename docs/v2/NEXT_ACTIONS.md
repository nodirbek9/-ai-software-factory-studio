# V2 — Next actions (in order)

Work in `D:\jarvis 2\asf-v2` (branch `feature/v2-studio`). Read `docs/v2/CURRENT_STATE.md` first.

## 1. Finish Phase 3
1. Verify batch 1 gates are green (`npm run typecheck`, `npm run build`, `npm test` in `D:jarvis 2asf-v2`).
2. Run batch 2 (account 4, or account 5 when 4 is out):
   `node .ai-jobs/run-akk4.mjs .ai-jobs/phase3-batch2.json p3-sessions=claude-opus-5-5 p3-workspace-ui=claude-sonnet-5-5`
   (prefix `CLAUDE_WORKER_ACCOUNT=5` for account 5). Workers have no shell: afterwards run the gates, fix, review.
3. Browser check on 4327/5327 with the scripted sample: open 6–8 panels (no process starts), send to two Scripted
   sessions, reorder, reload. Then ask the owner to commit Phase 3.

## Then
Phases 3–7 in order (`IMPLEMENTATION_PHASES.md`).
