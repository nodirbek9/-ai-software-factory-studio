# Phase 3 — Multi-agent workspace

Spec: `AGENT_WORKSPACE_SPEC.md`. Contract (written by Opus first): the "V2 agent sessions" types at the end of
`shared/src/index.ts` (`AgentSession`, `SessionTurn`, `CreateSessionInput`, `ProcessBudgetSnapshot`,
`WorkspaceLayout`, …) and `StudioSettings.maxAgentProcesses`. New dependency: `react-resizable-panels` 4.14.5
(web only, D-003). 3c (PTY terminal) is NOT part of this phase — it needs the owner's approval (D-019).

## Batch 1 (parallel, Claude account 4)
| Job | Scope | Files |
|---|---|---|
| p3-budget-db (Sonnet 5.5) | ProcessBudget (D-006) wired into the scheduler, V1 chat and agent tests; `maxAgentProcesses` setting (server default 3, API 1–8, Settings page field); migration v5: `agent_sessions`, `session_turns`, `workspace_layouts`, `usage_records.session_id`; `SessionRepository`; `UsageRecord.sessionId` | `orchestrator/processBudget.ts`, `orchestrator/{scheduler,context,projectService}.ts`, `app.ts`, `api/routes.ts`, `db/{database,repositories}.ts`, `web/src/pages/Settings.tsx`, `web/src/test/fixtures.ts`, tests |
| p3-continuity (Opus 5.5) | provider continuity (Claude `--session-id`/`--resume` only for sessions; Codex `thread_id` + `exec resume` when the installed CLI supports it), `registry.resolveExplicit`, `AgentExecutor` explicit provider + session id + continuity + `sessionRef` | `providers/{types,cliProviders,registry}.ts`, `agents/agentExecutor.ts`, tests |
| p3-layout (Sonnet 5.5) | pure layout engine (presets 1/2/3/4/5/6/8, split, move, swap, maximize, minimize, close, reopen, normalize) + `LayoutView` rendering with react-resizable-panels | `web/src/features/workspace/{layout.ts,layout.test.ts,LayoutView.tsx}` |

## Batch 2 (after batch 1 is green)
| Job | Scope |
|---|---|
| p3-sessions | `SessionManager` (create / send / stop / restart / close, checkpoint / sync / merge / discard / run-tests, diff, files), `/api/v2` session + layout routes, SSE `session.*` + `budget.updated`, recovery of interrupted turns, tests with fake adapters |
| p3-workspace-ui | Workspace page: toolbar (preset, New Session), panels (header + Chat / Activity / Changes / Files / Output / Task tabs), Studio Orchestrator panel, coordination drawer, status bar, sidebar item enabled, tests |

## Acceptance (from the spec)
8 panels open = 0 agent processes until a message is sent; at most `maxAgentProcesses` turns at once, the rest
visibly queued; one failing panel does not affect the others; layout survives reload; edit-session changes
visible as a diff and mergeable through the V1 merge path; gates green.
