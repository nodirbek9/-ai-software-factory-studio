# Performance baseline — V1 (measured 2026-10-16)

Machine: Windows 11 Pro, Intel i5-10400, 15.8 GB RAM visible (only **3.8 GB free** at measurement time
with the owner's normal apps open), integrated GPU. Studio V1 running from `start-studio.cmd`
(`npm start` → built UI served by the API on `127.0.0.1:4317`), no agents running.

## Server (idle, 8 projects, 88 tasks, 2,652 events in the DB)

| Metric | Value | How |
|---|---|---|
| Server process working set | 98 MB (private 116 MB), 14 threads | `Get-Process` on `data/studio.pid` |
| Child processes when idle | 1 (`esbuild.exe`, from `tsx`) | `Win32_Process` by parent pid |
| SQLite DB size | 4.5 MB (WAL) | `VACUUM INTO` snapshot |
| `GET /api/info` | 1.6 ms, 0.9 KB | curl |
| `GET /api/projects` | 3.2 ms, **157 KB** for 8 projects | curl |
| `GET /api/live` | 6.6 ms, 6.4 KB | curl |
| `GET /api/providers` | 2.3 ms, 3.7 KB (cached detection) | curl |
| `GET /api/agents/config` | 1.5 ms, 0.7 KB | curl |
| `GET /api/projects/:id` (snapshot) | 17 ms, **725 KB** | curl |

## Web UI

| Metric | Value | How |
|---|---|---|
| JS bundle | **784 KB** (245 KB gzip), single chunk, no code splitting | `vite build` |
| CSS | 55 KB (10 KB gzip) | `vite build` |
| DOMContentLoaded / load (warm, localhost) | 166 ms / 167 ms | Navigation Timing |
| JS heap after load (Dashboard) | 11 MB | `performance.memory` |
| DOM nodes (Dashboard, one project) | 756 | `getElementsByTagName('*')` |
| API calls on first load | 11 in 2.5 s: info, projects, providers ×2, agents/config ×2, project snapshot, live ×4 | Resource Timing |
| Polling | `GET /api/live` every 3 s plus debounced on events (`LIVE_POLL_MS`), Monitor re-renders every 1 s (`useNow`) | `web/src/store/studio.ts`, `web/src/pages/Monitor.tsx` |
| Realtime | One SSE stream `/api/events` with replay by event id | `store/studio.ts` |

## Build and tests

| Metric | Value |
|---|---|
| `vite build` | 5.6 s (2,437 modules) |
| Server tests | 53 tests, 87.7 s (end-to-end workflow tests dominate) |
| Web tests | 19 tests, 4.2 s |

## Observations that shape V2

1. **Payload size, not latency, is the risk.** The project snapshot (725 KB) and the project list
   (157 KB) carry full specs, task outputs and recent events. V2 dashboards that aggregate many
   projects must use summary endpoints and paginate events/logs.
2. **Single 784 KB chunk.** V2 adds a workflow editor, terminals and charts; pages must be lazy-loaded
   (`React.lazy`) so the shell stays small. Target: initial JS ≤ 350 KB gzip-equivalent ≤ 120 KB.
3. **Polling.** `/api/live` every 3 s is cheap today (6 KB) but V2 must not add more fixed-interval
   polls; prefer SSE-driven refresh with one slow safety poll.
4. **Memory headroom is small** (3.8 GB free). Each Claude Code CLI process costs roughly
   300–500 MB, Codex ~100–200 MB (estimate, to be measured in Phase 3). The process budget
   (see `V2_ARCHITECTURE.md`) defaults to 3 concurrent agent processes across scheduler and
   workspace sessions.

## V2 targets (checked in Phase 7)

| Metric | V1 | V2 target |
|---|---|---|
| Server idle working set | 98 MB | ≤ 150 MB |
| Initial JS (gzip) | 245 KB | ≤ 160 KB (lazy pages) |
| Home dashboard first data | — | ≤ 300 ms on localhost |
| Largest routine API payload | 725 KB | ≤ 150 KB (summaries + pagination) |
| Idle browser heap (Home) | 11 MB | ≤ 40 MB |
| Workspace with 8 panels, 0 running | — | 0 agent processes started (lazy) |
| Log view with 50k lines | — | smooth scroll (virtualized) |
