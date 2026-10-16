# Phase 4 — Visual workflow builder + runs

Spec: `WORKFLOW_ENGINE_SPEC.md` (decisions D-008, D-009 revised, D-010). Contract (written by Opus first, do not
change without reporting): the "V2 workflows and runs" types at the end of `shared/src/index.ts`, plus
`Task.runId / nodeId / options` and `TaskKind` `'command' | 'notify'`. Built-in template:
`server/src/workflows/standardTemplate.ts` (node ids that produce tasks = V1 task keys).

Opus decisions for this phase (additions to DECISIONS.md):
- **P4-1** Migration index 3 (spec name "v6"): `workflows`, `runs`, `tasks` rebuild (`run_id NOT NULL`, `node_id`,
  `options TEXT NOT NULL DEFAULT '{}'`, `UNIQUE(run_id, key)`), `usage_records.run_id`; one backfill run per project
  (`id = 'run-' || project_id`, number 1, trigger `backfill`, snapshot = Standard graph); builtin template row
  `wf-standard` (project_id NULL, builtin 1) — re-synced from code at startup. Fix-round settings move from
  `fixRounds:<projectId>:<key>` to `fixRounds:<runId>:<key>`.
- **P4-2** New repositories go to `server/src/db/runRepositories.ts` (repositories.ts is near the 800-line ceiling).
- **P4-3** No dagre dependency: auto-layout is a small layered (longest-path) layout in the web feature folder.
- **P4-4** A project's run status mirrors its derived project status; `completed_with_failures` only when a
  failed task had `onFailure: 'continue'` and everything else completed.
- **P4-5** The V1 "Start planning" button = `RunService.start(projectId, 'wf-standard')`. A new run is allowed only
  when the project has no active run (`planning/running/awaiting_approval/paused`); the project row keeps one status
  (= the latest run's).

## Batch A (parallel, no file overlap)
| Job | Model | Files |
|---|---|---|
| p4-db | Opus 5.5 | `server/src/db/database.ts` (migration), `server/src/db/repositories.ts` (Task run fields, `listByRun`, `create` takes `runId`), new `server/src/db/runRepositories.ts` (RunRepository, WorkflowRepository) wired into `createRepositories`, `server/src/orchestrator/fixLoop.ts` (run-scoped budget key + `options.fixRoundsMax/fixRole`), minimal `runId` pass-through in `projectService.startPlanning` (creates run N via `repos.runs`) and `taskRunners.expandPlan`, placeholder runners for `command`/`notify` (PermanentTaskError "not wired yet" — batch B replaces them), tests `server/test/runs-db.test.ts` + existing tests updated for `runId` |
| p4-compiler | Opus 5.5 | new `server/src/workflows/{catalog,validate,compile,expand}.ts`, `server/test/workflows-compiler.test.ts` (WF-01 golden, WF-02 every error code, WF-05) |
| p4-ui-state | Sonnet 5.5 | new `web/src/features/workflows/{graphState.ts,graphState.test.ts,autoLayout.ts,autoLayout.test.ts,workflowsApi.ts}` |

## Batch B (after A is green)
| Job | Model | Files |
|---|---|---|
| p4-scoping | Opus 5.5 | `orchestrator/scheduler.ts` (tick/promote/demote/openGate/deriveStatus/plan-skip/retry/cancel scoped to the active run, run status + finishedAt, `onFailure: continue`, per-task timeout), `orchestrator/taskRunners.ts` (expandPlan through `expand.ts` with the run's skeleton, architecture/test summary/review diff scoped to the run, review diff from `run.baseCommit`, `command` + `notify` runners, agent overrides from `task.options`), tests WF-03/04/06/07/08/11 |
| p4-runservice | Opus 5.5 | new `server/src/workflows/runService.ts` (start/cancel/list/get/timeline/simulate), new `server/src/api/workflowRoutes.ts` (all §7 routes, zod, registered in `app.ts`), `projectService.ts` (startPlanning → RunService, agentViews/snapshot on the active run), SSE `run.created/run.updated`, `task.*` carry `runId/nodeId`, tests `server/test/workflows-api.test.ts` (WF-10 + routes) |
| p4-canvas | Sonnet 5.5 | `web/src/features/workflows/{WorkflowCanvas.tsx,WorkflowNodeCard.tsx,NodePalette.tsx,NodeInspector.tsx}` + tests |
| p4-page | Sonnet 5.5 | `web/src/pages/WorkflowBuilder.tsx`, `web/src/features/workflows/{BuilderToolbar.tsx,RunPanel.tsx,workflowsStore.ts}`, route + sidebar wiring (`App.tsx`, `app/navigation.ts`), tests |

## Acceptance
Standard template run on the scripted sample == V1 (10/10 tasks); custom fan-out/fan-in + quality gate graph runs
and stops at the round limit; planned nodes cannot run and say why; cancel mid-run works; second run on the same
project leaves run 1 untouched; gates green. Browser check on 4327/5327 when the preview server is allowed.
