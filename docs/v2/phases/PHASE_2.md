# Phase 2 — Home dashboard + read models

**Status 2026-10-17: done, not committed.** Backend by akk4 Opus 5.5, frontend by akk4 Sonnet 5.5, contract + review +
fixes by Opus 5.5 (a test mocked a 500 as a 200; dates now use a fixed en-GB locale; zero-token usage wording).
Browser check on 4327/5327 with the scripted sample (10/10 tasks): every Home section shows real data, no errors
after reload. Initial JS ~109 KB gzip.

Contract: the V2 types at the end of `shared/src/index.ts` (`OverviewResponse`, `UsageSummary`, `SystemHealth`,
`EventsPage`, …) — written by Opus first, so backend and frontend build against the same shapes.

## Decisions for this phase (Opus, 2026-10-16)
- **ProcessBudget (D-006) moves to Phase 3**, where sessions need it. In Phase 2 "slots" = the scheduler's
  `maxParallelTasks`; `queued` = ready tasks not yet running. Honest, and no scheduler change now.
- New view **`home`** (`#/home`, default) = the new Home page. The V1 Dashboard (agent cards, graph, right
  panel) stays as **Project board** (`#/board`; old `#/dashboard` still works) and Home links to it.
- `ServerInfo.userName` = `os.userInfo().username` for the greeting (no avatar, no role).

## Backend (job p2-backend, Claude account 4, Opus 5.5)
| File | Change |
|---|---|
| `server/src/db/database.ts` | before applying pending migrations to an existing DB (version > 0): `VACUUM INTO <db dir>/backups/studio-before-v<target>.db` (D-018) |
| `server/src/db/repositories.ts` | `EventRepository.page()`, usage window/day aggregates |
| `server/src/events/eventStream.ts` | `clientCount` getter |
| `server/src/readModels/{overview,usage,health}.ts` | builders for the three read models |
| `server/src/api/v2Routes.ts` (+ one line in `routes.ts`) | `GET /api/v2/overview?projectId=`, `/api/v2/usage/summary?range=24h\|7d`, `/api/v2/system/health`, `/api/v2/events?projectId=&before=&limit=&level=&type=` |
| `shared` + `/api/info` | `ServerInfo.userName` |
| `server/test/v2api.test.ts` | tests for all of the above |

## Frontend (job p2-frontend, Claude account 4, Sonnet 5.5)
| File | Change |
|---|---|
| `store/studio.ts`, `app/navigation.ts`, `App.tsx` | `home` view, `#/board` for the V1 Dashboard, default `home` |
| `pages/Home.tsx`, `features/home/*` | greeting, KPI row, Current Project Workflow, Agent Health, Active Projects, Recent Runs, Model Usage (SVG donut + 7-day bars), Project Progress, Quick launch |
| `components/layout/Sidebar.tsx` | System Status from `/api/v2/system/health` |
| `components/layout/TopBar.tsx` | notifications unread badge (Phase 1 leftover) |
| tests | `pages/Home.test.tsx`; updates to navigation / Sidebar / CommandPalette tests |

## Acceptance
Every Home number comes from a named field of the read models; loading, empty (no projects) and error states
with Retry; works at 1366×768 and 1920×1080; refreshes on SSE events (debounced) plus a 15 s safety poll only
while the page is visible; gates green (`npm test`, typecheck, build).
