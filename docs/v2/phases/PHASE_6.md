# Phase 6 — Monitoring & quality

Spec: `UI_SCREEN_SPECIFICATIONS.md` §8 (QA & Security), §9 (Logs), §10 (Models & Providers); D-011, D-016.
Contract (Opus, fixed): "V2 quality, logs, usage" types at the end of `shared/src/index.ts`.

Opus decisions:
- **P6-1** Findings come from the security and review agents. Their prompts ask for an optional fenced
  ```` ```asf-findings ```` JSON block (`[{severity,title,file,line,description,recommendation}]`) before the VERDICT line;
  without it the parser reads bullet lines `- HIGH: \`file:line\` text` (the V1 format). Unparseable output produces no
  findings (never invented). Stored in table `findings` (migration index 4) with a fingerprint
  (`source|file|title` normalised) unique per run: a re-run of the same verification task keeps the status of a finding
  it reports again and marks the run's earlier open findings of that task that it no longer reports as `fixed`.
- **P6-2** Gates per run: build = a `command` task whose command contains `build` (else not_run); tests = the run's
  `test` tasks' latest testResult; security / review = the verdict of those tasks (completed = passed, failed with
  VerificationFailed = failed, other failure = error, missing/not finished = not_run); audit = latest `npm audit` of the
  project after the run started; coverage = always not_run (no coverage scanner yet). Ready = all passed — so a run is
  never "ready" while coverage is not measured; the UI says why.
- **P6-3** `npm audit --json` needs network → it always goes through an approval (kind `command`, details
  `{ command: 'npm audit --json', purpose: 'audit' }`); approving runs it once in the integration worktree; result
  findings source `audit` (severity from npm: critical/high/moderate→medium/low/info).
- **P6-4** "Create fix task" inserts an `implement` task `fix-finding-<n>` (role backend; frontend when the file is
  under web/ or .tsx/.jsx/.vue) into the project's **current** run, depending on nothing, and reopens the project
  (`running`) so the scheduler runs it; finding → `fix_planned`, `fixTaskId` set. Refused (409) while the run is in
  planning/awaiting approval or when the finding is not open.
- **P6-5** No new dependencies: the Logs list uses an own fixed-row-height windowed list.
- **P6-6** Fallback order stays editable in Settings (moving it risks the V1 Settings tests for no gain); Models shows a
  read-only "Fallback order" tab with a link to Settings.
- **P6-7** Guardian: a scanner row "Not installed — integration contract ready" (no fake status).
- **P6-8** Route/sidebar wiring (`App.tsx`, `store/studio.ts` view `quality`, `app/navigation.ts`) is done by Opus.

## Batch (parallel; file ownership per job)
| Job | Model | Files |
|---|---|---|
| p6-findings | Opus 5.5 | `server/src/db/database.ts` (migration), new `server/src/db/findingRepository.ts` (+ wiring in `createRepositories` in repositories.ts — the ONLY repositories.ts edit in this batch), new `server/src/quality/findings.ts` (parser + ingest), `server/src/agents/prompts.ts` (security/review instruction), `server/src/orchestrator/taskRunners.ts` (ingest call in runReview), `server/test/findings.test.ts` |
| p6-quality-api | Opus 5.5 | new `server/src/quality/{qualityService,audit}.ts`, new `server/src/api/qualityRoutes.ts` (+ `app.ts` registration), `server/src/orchestrator/projectService.ts` (audit approval hook in decideApproval), `server/test/quality-api.test.ts` |
| p6-logs-usage-server | Sonnet 5.5 | new `server/src/readModels/logs.ts`, `server/src/readModels/usage.ts` (daily rows), `server/src/api/v2Routes.ts` (events query → LogQuery, `/api/v2/usage/daily`), `server/test/logs-usage.test.ts` |
| p6-quality-ui | Sonnet 5.5 | new `web/src/pages/Quality.tsx`, `web/src/features/quality/{qualityApi.ts,ReadinessStrip.tsx,FindingsTable.tsx,FindingDrawer.tsx,quality.test.tsx}` |
| p6-logs-ui | Sonnet 5.5 | `web/src/pages/Logs.tsx`, new `web/src/features/logs/{logsApi.ts,VirtualRows.tsx,LogFilters.tsx,logs.test.tsx}` |
| p6-models-ui | Sonnet 5.5 | `web/src/pages/Models.tsx`, new `web/src/features/models/{usageApi.ts,UsageTab.tsx,FallbackTab.tsx,models.test.tsx}`, `web/src/pages/Providers.tsx` (resume support + limit state + "CLI login"/"API key" labels only) |

FindingRepository API (p6-findings writes it, p6-quality-api uses it — keep exactly):
`list(query: FindingQuery): FindingsResponse` · `get(id): Finding | null` · `listByRun(runId): Finding[]` ·
`update(id, patch: { status?: FindingStatus; note?: string | null; fixTaskId?: string | null }): Finding` ·
`replaceForTask(input: { projectId; runId; taskId; source: 'security' | 'review'; findings: ParsedFinding[] }): Finding[]` (P6-1 semantics) ·
`addAudit(input: { projectId; runId: string | null; findings: ParsedFinding[] }): Finding[]` (replaces the project's previous open audit findings: they become `fixed` when not reported again).
`ParsedFinding = { severity: FindingSeverity; title: string; file: string | null; line: number | null; description: string; recommendation: string | null }` exported from `server/src/quality/findings.ts`.

## Acceptance
Unrun scanners show "Not run", never green; findings from the scripted security FAIL sample appear with severity and
file; "Create fix task" creates a real task that runs; audit needs approval; Logs filter by project/run/session/role/
level/type/search/time with live tail and export; Usage tab by day/provider/model/project with unknown cost "—"; gates green.
