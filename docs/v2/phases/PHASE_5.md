# Phase 5 — Projects, tasks, repos

Spec: `UI_SCREEN_SPECIFICATIONS.md` §4 (Projects), §5 (Tasks), §7 (Repos); `IMPLEMENTATION_PHASES.md` Phase 5.
Contract (Opus, fixed): "V2 projects, tasks, repos" types at the end of `shared/src/index.ts` (`TaskRow`, `TaskQuery`,
`TasksResponse`, `TaskDetail`, `TaskDiff`, `RepoOverview` and parts).

Opus decisions:
- **P5-1** All git access is read-only (`rev-parse`, `for-each-ref`, `rev-list --count`, `log`, `diff`, `worktree list
  --porcelain`), through `workspace/git.ts` with the studio's hook-disabled git options (Phase 0b). No git writes.
- **P5-2** Task diff: implement/fix tasks → `git diff <first-parent before the task's merge>..<merge commit>` is fragile;
  use the task branch instead: `git diff <merge-base(branch, integration-at-baseCommit)>..<branch>` when the branch
  still exists, else the merge commit found by `git log --grep "<task key>"` on the integration branch (first parent
  diff), else empty with a note. Sensitive files (V1 policy, `security/`) are omitted with a note. ≤ 300 KB.
- **P5-3** No milestone/phase grouping: the PM plan has no `phase`/`epic` fields yet. The Plan tab lists the run's PM
  tasks in order; grouping waits for a planner change (noted, not faked).
- **P5-4** Route wiring (`App.tsx`, `store/studio.ts`, `app/navigation.ts`) is done by Opus after the batch: sidebar
  "Tasks" → new `tasks` view (V1 task graph stays at "Project board"/`#/board` and is linked from Tasks), "Repos" →
  new `repos` view (V1 Files page stays reachable from Project detail → Files), Projects row → `#/projects/:id`.

## Batch (parallel, no file overlap)
| Job | Model | Files |
|---|---|---|
| p5-server | Opus 5.5 | new `server/src/readModels/{tasksReadModel,repoReadModel}.ts`, new `server/src/api/v2WorkRoutes.ts` (registered in `app.ts`, 1–2 lines), tests `server/test/v2work.test.ts` (temp repo: branches, ahead/behind, worktrees, diff == `git diff`) |
| p5-tasks-ui | Sonnet 5.5 | new `web/src/pages/Tasks.tsx`, `web/src/features/tasks/{tasksApi.ts,TaskBoard.tsx,TaskList.tsx,TaskDrawer.tsx,Tasks.test.tsx}` |
| p5-projects-ui | Sonnet 5.5 | new `web/src/pages/{ProjectDetail.tsx,Repos.tsx}`, `web/src/features/projects/{projectsApi.ts,ProjectTabs.tsx,RepoView.tsx,projects.test.tsx}` |

## Acceptance
Progress only from task states; diff matches `git diff`; no git writes; Kanban + list + filters + drawer; Repos shows
branches/worktrees/ahead-behind/wip commits/conflicts; Project detail tabs (Overview with Start run ▾ / Pause / Resume /
Cancel, Requirements, Architecture, Plan, Runs, Tasks, Report, Settings read-only); gates green.
