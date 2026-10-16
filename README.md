# AI Software Factory Studio

Local-first multi-agent development studio. Submit a specification; a Project Manager agent plans
tasks, an Architect writes the technical plan, you approve it, Backend/Frontend agents implement in
isolated git worktrees, QA runs the project's real test command, Security and Reviewer agents check
the integrated diff, and a delivery report is generated. A React dashboard shows the live state.

Fully independent: own `node_modules`, own SQLite database (`data/studio.db`), own ports
(API `127.0.0.1:4317`, dev UI `127.0.0.1:5317`), own `.env`. It does not read or modify any other
installation (Jarvis, ECC, global Claude settings).

## Requirements
- Node.js 22.13+ (tested on 24.19) and git on PATH.
- Optional AI providers (detected, never assumed): Claude Code CLI (`claude`), OpenAI Codex CLI
  (`codex`), Gemini CLI (`gemini`), or any OpenAI-compatible HTTP endpoint configured in `.env`.

## Start
```bash
npm install
npm run dev        # API on :4317 + Vite dashboard on http://127.0.0.1:5317
```
Production-style single process (builds the UI, serves it from the API port):
```bash
npm start          # http://127.0.0.1:4317
```
Optional configuration: copy `.env.example` to `.env`.

## First run (2 minutes, no AI quota used)
1. Projects → New project → **Sample project** → `todo-service` → Create.
2. Top bar → **Generate plan**. PM + Architect run; the plan waits in **Approvals**.
3. Approve. Backend/Frontend tasks run in parallel worktrees (the `http-api` task fails once on
   purpose and is retried), QA runs `npm test` for real, Security/Reviewer give verdicts, the report
   is generated (`Report` button).

The sample uses the **Scripted (offline, not AI)** provider, which replays `.asf-script.json`. To let
real models do the work: Model providers → enable *Claude Code CLI* (or another) → Agents → assign it.

## Tests
```bash
npm test           # server: unit + API + end-to-end workflow tests (vitest)
npm run typecheck
```

## Documentation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, state machine, security model
- [HANDOFF.md](HANDOFF.md) — status, limitations, how to resume
