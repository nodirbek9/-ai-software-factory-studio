# Reuse vs Rebuild — V1 → V2

Verdicts: **Keep** (unchanged) · **Extend** (same module, new capability) · **Refactor** (same behaviour,
new shape) · **Replace** (new module takes over; old one removed after parity) · **Fix** (Phase 0b defect).
Sources: `V1_AUDIT.md`, `FEATURE_INVENTORY.md`, `V2_ARCHITECTURE.md`, code review 2026-10-16.

## Server

| Module | Verdict | Phase | What changes / why | Risk |
|---|---|---|---|---|
| `domain/taskStateMachine.ts` | Keep | — | Verified transition rules; new kinds `command`, `notify` reuse them | low |
| `domain/taskGraph.ts` | Keep | — | DAG validation reused by the workflow compiler | low |
| `orchestrator/scheduler.ts` | Extend + Fix | 0b, 2, 4 | R2 dispatch prerequisite check; ProcessBudget acquire; run scoping (`WORKFLOW_ENGINE_SPEC.md` §3) | **high** — heart of the system; golden + workflow tests guard it |
| `orchestrator/taskRunners.ts` | Extend + Fix | 0b, 4 | R3 final verification barrier, R7 keep worktree when save fails; run-scoped plan expansion with compiled skeleton; `command`/`notify` runners | high |
| `orchestrator/fixLoop.ts` | Extend | 4 | per-run budget key, per-task max rounds | low |
| `orchestrator/projectService.ts` | Refactor | 3, 4 | planning moves to `RunService.start(Standard)`; `sendChat` stays for V1 chat, sessions are separate | medium |
| `orchestrator/liveMonitor.ts` | Keep → Extend | 2 | feeds overview read model; budget queue added | low |
| `orchestrator/context.ts` | Extend | 2 | add `budget`, `sessions`, `runs` to the context | low |
| `agents/agentExecutor.ts` | Extend | 3 | explicit provider, sessionId, continuity, usage provenance (R10) | medium |
| `agents/prompts.ts`, `parsers.ts` | Extend | 4, 6 | security prompt asks for a JSON findings block; parser for it | low |
| `providers/types.ts`, `cliProviders.ts` | Extend + Fix | 0b, 3 | S1 no project setting sources; resume capability (Claude `--session-id/--resume`, Codex `exec resume` verified) | medium |
| `providers/registry.ts` | Extend | 3, 6 | `resolveExplicit()`; persisted cooldowns (R11); capabilities in API | low |
| `providers/apiProviders.ts` | Keep | — | Scripted stays the deterministic test/demo provider | low |
| `workspace/workspaceManager.ts` | Extend + Fix | 0b, 3 | R1 ancestor-safe `resolveInside`, R5 sensitive-file policy; session worktrees | medium |
| `workspace/git.ts` | Fix + Extend | 0b, 5 | disable hooks (`-c core.hooksPath=` empty dir); read-only `branch --list`, `rev-list --count` for Repos | low |
| `workspace/commandRunner.ts` | Keep + Extend | 6 | `--ignore-scripts` for untrusted installs (S3) | low |
| `workspace/processRunner.ts` | Fix | 0b/3 | R16 Windows shim arguments with spaces | medium |
| `db/database.ts` | Extend | 2–4 | migration runner with pre-migration backup (D-018); v3 runs/tasks rebuild; v4 sessions | **high** (data) — backup + migration tests on a DB copy |
| `db/repositories.ts` | Extend | 2–4 | run/session repositories, summary queries, indexes, event retention (R13) | medium |
| `events/eventStream.ts` | Extend + Fix | 2 | bounded cursor replay (R9), new event types | low |
| `api/routes.ts` | Keep + Fix | 0b | R4 Host allowlist; V1 routes stay until Phase 7 | low |
| `api/v2/*` | New | 2–6 | read models, sessions, workflows, runs, quality | — |
| `sessions/*`, `workflows/*`, `orchestrator/processBudget.ts`, `quality/*` | New | 2–6 | see specs | — |
| `reports/reportGenerator.ts` | Fix | 4 | R17 report snapshot after terminal state; per run | low |
| `security/redact.ts` | Keep + Extend | 0b | applied to every outgoing string (R5) | low |
| `instanceLock.ts`, `config.ts` | Keep + Fix | 0b | R8 protect all discovered Claude account dirs | low |

## Web

| Module | Verdict | Phase | What changes / why |
|---|---|---|---|
| `index.css` tokens | Replace | 1 | V2 tokens (`DESIGN_SYSTEM.md`), V1 class names mapped |
| `components/ui/primitives.tsx` | Extend | 1 | keep API, restyle, add new primitives |
| `components/layout/*` (Sidebar, TopBar, RightPanel) | Replace | 1 | V2 AppShell; RightPanel tabs reused inside drawers |
| `store/studio.ts` | Refactor | 1 | slices + selectors; init idempotent (R14); V1 actions unchanged |
| `lib/api.ts` | Keep | — | fetch wrapper used by all slices |
| `pages/Dashboard.tsx` | Replace | 2 | by Home; its project graph moves to Runs/Project detail |
| `pages/Monitor.tsx` | Replace | 2/4 | content split into Home (working now, queue) and Runs (recent) |
| `pages/Agents.tsx` | Keep | 1→6 | re-hosted, later a tab of Models & Providers; its 8 tests keep passing |
| `pages/Providers.tsx` | Extend | 6 | Models & Providers page |
| `pages/Settings.tsx` | Extend | 1, 3 | new sections; its 5 tests keep passing |
| `pages/Projects.tsx` | Extend | 5 | list/detail; folder picker reused |
| `pages/Workflows.tsx` + `components/WorkflowGraph.tsx` | Replace | 4 | Builder (editable) + Runs (live view); React Flow kept |
| `pages/Files.tsx` | Extend | 3 | reused in Project detail and Workspace Files tab |
| `pages/Logs.tsx` | Replace | 6 | virtualized logs (old one re-hosted until then) |
| `components/AgentCard.tsx`, `agentMeta.tsx`, `Markdown.tsx`, `FolderPicker.tsx` | Keep | — | reused (a11y fixes R18) |
| `web/src/test/*` | Keep + Extend | all | fetch mock + fixtures for all new pages |

## Not touched
Jarvis (`D:\Jarvis`), ECC/router (`D:\AI-Stack`), CLI login stores (`~/.claude*`, `~/.codex`, `~/.gemini`),
the owner's imported repositories (studio only adds `asf/*` branches), `sample-projects/` (kept for tests).

## SUMMARY
The engine (state machine, DAG, scheduler, worktrees, fix loop, providers, guards) is kept and extended; the
shell, dashboard, monitor, workflow view and logs are replaced on top of it. Highest-risk changes are the
scheduler run scoping and the `tasks` rebuild migration — both guarded by golden tests and a pre-migration
backup.
