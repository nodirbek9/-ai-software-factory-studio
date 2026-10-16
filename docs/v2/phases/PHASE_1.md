# Phase 1 — Design foundation + app shell (branch `feature/v2-studio`, worktree `D:\jarvis 2\asf-v2`)

**Status 2026-10-16: chunks 1, 2, 3, 4, 6 done; chunk 5 partly (the V1 bell dropdown is kept: approvals waiting
+ warn/error events; unread badge/last-seen still to do); chunk 7 partly (CLAUDE.md updated; the Fastify
`disableRequestLogging` deprecation is left for Phase 2).** Gates on the V2 worktree: `npm test` 68 server + 63
web (19 V1 + 44 new), typecheck, build green. Browser check on 4327/5327 at 1366×768 and 1920×1080: shell, 11
items, Ctrl+K → "run" → Enter opens Runs, old `#/providers` opens Models & Providers, no console errors.
Initial JS 338 KB (108 KB gzip) vs V1 784 KB (245 KB gzip). Command palette + its tests, navigation and Models
tests written by Claude account 4 (Sonnet 5.5), reviewed by Opus. Not committed yet.

Goal: the V2 look and navigation with every V1 page still working. **No new npm dependencies in this phase**
(command palette and drawers are small own components; fonts use the Windows 11 system stack until a
self-hosted font package is approved).

## Navigation map (11 items)
| # | Item | Hash | Page in Phase 1 | Status |
|---|---|---|---|---|
| 1 | Home | `#/home` (old `#/dashboard`) | V1 Dashboard | live (replaced in Phase 2) |
| 2 | Projects | `#/projects` | V1 Projects | live |
| 3 | Agent Workspace | — | — | disabled: "Multi-panel agent sessions arrive in Phase 3. Until then chat with an agent from its card on Home." |
| 4 | Workflow Builder | — | — | disabled: "Visual workflow editing arrives in Phase 4. The current task graph is under Tasks." |
| 5 | Tasks | `#/tasks` (old `#/workflows`) | V1 Workflows (graph + task table) | live |
| 6 | Runs | `#/runs` (old `#/monitor`) | V1 Live monitor | live |
| 7 | Repos | `#/repos` (old `#/files`) | V1 File explorer | live |
| 8 | QA & Security | — | — | disabled: "The quality center arrives in Phase 6. Test and review results are on each task under Tasks." |
| 9 | Logs | `#/logs` | V1 Logs | live |
| 10 | Models & Providers | `#/models` (old `#/providers`, `#/agents`) | NEW tabs page: Providers (V1) · Agents (V1) | live |
| 11 | Settings | `#/settings` | V1 Settings | live |

## Chunks
| # | Chunk | Files | Tests |
|---|---|---|---|
| 1 | Tokens: retune V1 token values to the V2 palette (`DESIGN_SYSTEM.md`), add V2 tokens, system font stack, primary button gradient `#2563EB→#4F46E5` | `index.css`, `components/ui/primitives.tsx` | existing web tests stay green |
| 2 | Routes: `models` view, hash aliases (V2 slugs + old V1 hashes), `setView` writes V2 slugs, nav model with disabled reasons, `React.lazy` pages | `store/studio.ts`, `app/navigation.ts` (new), `App.tsx` | `navigation.test.ts`: every alias resolves; planned items have reasons |
| 3 | Shell: Header (logo + "V2", project selector, search button with Ctrl K, running-agents pill, notifications, V1 project actions), Sidebar (11 items, disabled items with tooltip, collapse Ctrl+B, status footer from real connection/provider/agent data) | `components/layout/Header.tsx` (from TopBar), `components/layout/Sidebar.tsx`, `App.tsx` | `Sidebar.test.tsx`: 11 items, planned disabled with reason, click navigates, collapse |
| 4 | Command palette (Ctrl+K): navigate, switch project, real actions (start planning / pause / resume / stop with confirm), keyboard ↑↓ Enter Esc, ARIA dialog + listbox | `components/CommandPalette.tsx` | `CommandPalette.test.tsx`: filter, Enter navigates/switches, disabled action shows reason |
| 5 | Notifications drawer: approvals waiting + warn/error events of the current project, unread badge (last-seen id in localStorage), click → page | `components/layout/Notifications.tsx` | `Notifications.test.tsx` |
| 6 | Models & Providers page: tabs Providers / Agents re-hosting V1 pages | `pages/Models.tsx` | `Models.test.tsx`: both tabs render; V1 Agents tests still pass |
| 7 | Cleanup: Fastify `disableRequestLogging` deprecation; `CLAUDE.md` facts (git now exists, test counts) | `server/src/app.ts`, `CLAUDE.md` | gates |

## Acceptance
- All 11 items reachable (live ones navigate; disabled ones explain why and when).
- Old bookmarks (`#/dashboard`, `#/monitor`, `#/workflows`, `#/files`, `#/providers`, `#/agents`) still open the right page.
- Ctrl+K palette works with keyboard only; Ctrl+B toggles the sidebar.
- 1366×768 and 1920×1080 checked in the browser on the V2 dev server (4327/5327).
- Initial JS smaller than V1's single 784 KB chunk (lazy pages).
- Gates: `npm test`, `npm run typecheck`, `npm run build` green.
