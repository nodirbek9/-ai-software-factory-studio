# Phase 0b — V1 hardening (on `main`)

**Status: done 2026-10-16.** All 8 items fixed; the 15 regression tests were red before and are green after.
Gates: `npm test` (68 server + 19 web), typecheck and build green. Not committed yet (needs the owner's OK).
Behaviour changes the owner will notice: one extra test run per project (the security review's final check),
and a `.env` file can no longer be opened in the Files page.

Started 2026-10-16 after the owner approved the V2 plan and the git baseline (`v1.0.0`, commit `5354c5c`).
Each item: regression test in `server/test/hardening.test.ts` first (red), then the fix (green). Sources:
`V1_AUDIT.md` §4, `SECURITY_REVIEW.md` §2.

| # | Item | Files | Test |
|---|---|---|---|
| 1 | R4 Host allowlist in loopback mode (DNS rebinding) | `api/routes.ts` | hostile `Host` → 403 on GET and POST; `localhost`/`127.0.0.1`/`[::1]` with any port → allowed |
| 2 | R8 protect every `~/.claude*` directory | `config.ts` | protected list contains each `.claude*` entry of a fake home |
| 3 | R2 retry/dispatch respects unmet dependencies | `orchestrator/scheduler.ts` | cancel a pending child, retry it → it waits (`pending`) until its dependency completes; dispatch never starts a `ready` task with unmet deps |
| 4 | R7 keep the worktree when saving partial work fails | `orchestrator/taskRunners.ts`, `scheduler.ts` | commit failure → worktree still on disk, `task.partial` error event names it |
| 5 | R1 path containment through symlinks/junctions with missing parents | `workspace/workspaceManager.ts` | junction `link → outside`, write `link/new/file.txt` → rejected; normal nested new dirs → allowed |
| 6 | S1/R6 untrusted project boundary | `providers/cliProviders.ts`, `workspace/git.ts`, `workspace/commandRunner.ts`/`processRunner.ts` | Claude args contain no `project`/`local` setting source; studio git calls run with hooks disabled (a `pre-commit` hook that writes a file does not run); test commands do not inherit `ASF_AUTH_TOKEN`/`ASF_OPENAI_API_KEY` |
| 7 | R5 sensitive files + response redaction | `workspaceManager.ts`, `git.ts`, `api/routes.ts` | file API refuses `.env`; copy-import skips `.env`; `commitAll` never stages `.env`; a registered secret inside a task summary never appears in any JSON response |
| 8 | R3 final verification on the integrated commit | `orchestrator/taskRunners.ts` | PM plan with QA before a later implementation task → the project tests run again on the final integration HEAD before the security review passes |

Gates after all items: `npm test`, `npm run typecheck`, `npm run build`. The running V1 on 4317 only gets the
fixes after a restart, which the owner does when no agents run. Commits need the owner's OK.

Follow-ups found while planning (not in 0b): Codex/Antigravity/Gemini project-level config loading must be
verified per CLI version (S1 note); `npm install` with `--ignore-scripts` for untrusted projects (S3, Phase 6).
