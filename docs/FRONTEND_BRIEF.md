# Frontend brief for page implementers

Stack: React 19 + TypeScript (strict, `noUnusedLocals`), Vite, Tailwind CSS v4, Zustand, lucide-react, `@xyflow/react`.
Import alias `@/` = `web/src/`. Shared API types: `import type { ... } from '@asf/shared'` (file `shared/src/index.ts`).

## Read these before writing (do not modify them)
- `shared/src/index.ts` — all API types (Project, Task, AgentView, ProviderInfo, ServerInfo, StudioEvent, ...).
- `web/src/store/studio.ts` — `useStudio()` store: state + actions (createProject, updateProvider, updateAgentConfig,
  updateSettings, retryTask, cancelTask, selectProject, selectTask, selectAgent, setView, refreshProviders, ...).
- `web/src/lib/api.ts` — `api<T>(path)`, `post`, `put`, `patch` (adds auth token). `web/src/lib/utils.ts` — `cn`, `statusMeta`, `timeAgo`, `formatTokens`, `formatDuration`.
- `web/src/components/ui/primitives.tsx` — Button (variants primary/secondary/ghost/danger/success, sizes sm/md/icon), Panel, PanelHeader,
  StatusBadge, StatusDot, Progress, Input, Textarea, Select, Field, Dialog, EmptyState. Use these; do not add new UI libraries.
- `web/src/components/agentMeta.tsx` (ROLE_ICON, ROLE_HUE), `web/src/components/Markdown.tsx`, `web/src/components/WorkflowGraph.tsx`.
- `web/src/pages/Dashboard.tsx` — reference for layout, spacing and tone.

## Design rules
- Dark navy theme tokens (Tailwind classes): backgrounds `bg-ink-950/900/850/800/700`, borders `border-line` / `border-line-soft`,
  text `text-text` / `text-muted` / `text-faint`, accent `brand`, status colours `st-running`, `st-completed`, `st-failed`, `st-waiting`, `st-planning`.
- Base font size 13px (`text-[13px]`), small labels `text-[12px]`/`text-[11px]`. Page padding `p-4`, gaps `gap-3`.
- Sentence-case labels. No ALL-CAPS labels, no decorative gradients, no emoji. Monospace (`font-mono`) only for code, paths, logs.
- Each page fills its container: root element `className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4"` (or similar) with a page `<h1 className="text-lg font-semibold">`.
- Show real backend state only. Empty states explain what to do next. Errors: call `useStudio.getState().setError(message)`.
- Accessible: buttons have labels, inputs use `<Field label=...>`, keyboard focus visible (already global).
- Responsive down to ~768px wide.

## Backend endpoints (all JSON, prefix /api)
GET /info · PUT /settings · GET /providers[?refresh=1] · PATCH /providers/:id · GET /usage · GET /agents/config · PUT /agents/:role/config
GET /samples → {name, spec}[] · GET /projects · POST /projects (CreateProjectInput) · GET /projects/:id (ProjectSnapshot)
POST /projects/:id/plan|pause|resume|cancel · GET /projects/:id/report.md · GET /projects/:id/events?limit=&level=&taskId=
GET /projects/:id/files → FileEntry[] · GET /projects/:id/file?path= → {content, truncated, binary}
GET/POST /projects/:id/agents/:role/messages · POST /tasks/:id/retry|cancel · POST /approvals/:id/decision
GET /usage → {providerId, model, calls, inputTokens, outputTokens, costUsd}[]

## Definition of done
Only the file(s) assigned to you change. `npx tsc --noEmit` in `web/` passes with zero errors. Named export with the same name as the stub.
