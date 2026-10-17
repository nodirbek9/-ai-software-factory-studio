# Software Factory Agent Studio — project instructions for Claude

Any Claude session opened in this folder (any account: claude1…claude5) reads this first.

## What this is
A local multi-agent AI development studio (**V2**, tag `v2.0.0`, cut over on 2026-10-17): Fastify + `node:sqlite`
server (`server/`), React 19 + Vite + Zustand + Tailwind 4 dashboard (`web/`), shared types (`shared/`). Runs from
`start-studio.cmd` on http://127.0.0.1:4317. Details: `HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/v2/WINDOWS_LAUNCH.md`.

V2 (premium UI + multi-agent workspace + visual workflow builder) is merged into `main` and runs from this
folder. Everything about V2 is in `docs/v2/`. **To continue the work, read in this order:**
1. `docs/v2/CURRENT_STATE.md` — what is done, what is running, what waits for the owner.
2. `docs/v2/NEXT_ACTIONS.md` — the exact next steps.
3. `docs/v2/DECISIONS.md` and `docs/v2/V2_ARCHITECTURE.md` — decisions you must not silently change.
Read only the files a step needs; do not re-scan the whole repository.

## Hard rules
- The owner speaks Uzbek: reply in Uzbek; code, comments and docs in English.
- Never modify anything outside this folder, especially the owner's Jarvis (`D:\Jarvis`) and ECC
  (`D:\AI-Stack`, `~/.claude*`, `~/.codex`, `~/.gemini`) installs.
- The owner uses the studio daily: do not stop/restart it on port 4317 while agents run
  (check `GET http://127.0.0.1:4317/api/live` → `running` must be empty). Development copies run on
  ports 4327/5327 with their own `ASF_DATA_DIR` (decision D-001).
- No commits/pushes, global installs, paid API calls or destructive actions without the owner's
  explicit "ha" in chat. Git: `main` = V2 (tags `v1.0.0`, `v2.0.0`, `v2.1.0`, `v2.2.x`) in
  `D:\jarvis 2\ai-software-factory-studio` (the running studio). Develop on a feature branch in the dev worktree
  `D:\jarvis 2\asf-v2` (`start-v2-dev.cmd`: API 4327, web 5327, own data); never edit the running checkout directly.
- Backups: `D:\jarvis 2\backups\asf-v1-2026-10-16\` and `asf-v1-final-2026-10-17\` (V1 DB right before the cut-over,
  data tar, repo bundle). Do not delete them. Rollback: `docs/v2/WINDOWS_LAUNCH.md`.
- No fake/demo data in the UI; every visible control must work or be disabled with a reason.
- Gates after every change: `npm test` (server + web), `npm run typecheck`, `npm run build`; UI flows also
  `npm run test:e2e` (Playwright on Edge, temp data, Scripted provider, no AI quota).

## Workers — owner's model order (2026-10-16)
1. First do the work yourself on your own Claude limit until its **5-hour window reaches 80 %**.
2. Then only: Claude **account 4** (headless, `node .ai-jobs/run-akk4.mjs <jobs.json> <id>=<model>`), and when
   account 4 is out of quota **account 5** (`CLAUDE_WORKER_ACCOUNT=5 node .ai-jobs/run-akk4.mjs ...`),
   **GPT via Codex** (router with `--model gpt-sol|gpt-astra|gpt-luna --only`), **Gemini** if it has quota.
3. Never OmniRoute free models, Qoder, Antigravity Claude or other providers (the router's default chains
   fall through to them — always pin with `--only`).

Account 1 (`claude1`) has the model router: delegate with
`node D:/AI-Stack/router/ai.mjs run --role <role> --cwd "D:/jarvis 2/ai-software-factory-studio" --prompt-file <file>`
or `ai.mjs parallel <jobs.json>` (job files live in `.ai-jobs/`). Accounts 2–5 have no router: do the
work yourself, in small steps, and keep `docs/v2/CURRENT_STATE.md` updated after each step.
