# V2 — Current state

Last updated: 2026-10-16 ~23:20 (Opus 5.5, account 1). Update this file after every step.

## Where we are
- **V2 work happens here**: worktree `D:\jarvis 2\asf-v2`, branch `feature/v2-studio` (from `main` at
  `fc615d2`). Run it with `start-v2-dev.cmd` (API http://127.0.0.1:4327, web http://127.0.0.1:5327, own
  `data/` from `.env`). The owner's V1 stays in `D:\jarvis 2\ai-software-factory-studio` on port 4317.
  Desktop preview entries `asf-v2-api` / `asf-v2-web` are in `D:\jarvis 2\.claude\launch.json`.
- `main`: `5354c5c` V1 baseline (tag `v1.0.0`) → `fc615d2` Phase 0b hardening (committed).
- **Phase 1** (design foundation + app shell): done except two small leftovers, **not committed** —
  `docs/v2/phases/PHASE_1.md` has the status. Gates green: 68 server + 63 web tests, typecheck, build.
  Uncommitted on `feature/v2-studio`: `web/src/{index.css, App.tsx, store/studio.ts, app/navigation.ts,
  app/navigation.test.ts, components/ui/primitives.tsx, components/layout/{Sidebar,TopBar}.tsx,
  components/layout/Sidebar.test.tsx, components/CommandPalette{,.test}.tsx, pages/Models{,.test}.tsx}`,
  `web/vite.config.ts`, `scripts/dev.mjs`, `start-v2-dev.cmd`, `.claude/launch.json`, `CLAUDE.md`,
  `docs/v2/phases/PHASE_1.md`, this file, `NEXT_ACTIONS.md`.
- The running V1 on 4317 still runs pre-0b code until the owner restarts `start-studio.cmd` (no agents running).

## Phase 1 leftovers (do first in Phase 2)
- Notifications: unread badge with last-seen id (the V1 bell dropdown works today).
- Fastify `disableRequestLogging` deprecation warning (`server/src/app.ts`).

## Follow-ups noted
- Verify whether Codex, Antigravity and Gemini CLIs load project-level config from a repository (S1 note).
- `npm install --ignore-scripts` for untrusted projects (S3, Phase 6).

## Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`,
headless `claude -p`, file tools only), GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
Limits at 23:15: Claude akk1 5 h ≈ 70 % used (resets 00:20); Codex ≈ 2 % until 00:29; Antigravity Claude 0 %.
