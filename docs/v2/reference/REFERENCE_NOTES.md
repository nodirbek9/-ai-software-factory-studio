# Reference images — visual extraction (input for DESIGN_SYSTEM.md and UI_SCREEN_SPECIFICATIONS.md)

Images (owner-supplied, 2026-10-16): `01-home-dashboard.webp`, `02-multi-agent-workspace.webp`,
`03-workflow-builder.webp` in this folder. They are a visual direction, not a pixel spec. Every number,
name and percentage in them is illustrative mock data — V2 shows only real studio data (see "Real-data
mapping" under each screen).

## Shared shell (all three images)

- **Window**: frameless dark app, ~1672×941 at the reference; content must also fit 1366×768.
- **Header bar** (~64 px): logo tile (stacked-layers glyph, blue→indigo gradient) · product title
  "Software Factory Agent Studio" + "V2" in indigo/violet · tagline in muted text · **project selector**
  pill (label "Project" + current name + chevron) · **global search** (wide, placeholder "Search projects,
  files, agents, runs…", `Ctrl` `K` key caps on the right) · **notifications** bell with red unread dot ·
  user block (avatar, name, role, chevron).
- **Left sidebar** (~210 px, collapsible): Home, Projects, Agent Workspace, Workflow Builder, Tasks, Runs,
  Repos, QA & Security, Logs, Models, Settings. Outline icons (lucide style, 18 px), 14 px labels.
  Active item: filled navy-blue background, 1 px blue border, soft glow, white label.
- **Sidebar footer card "System Status"**: green dot + "All Systems Operational", then rows with a green
  check-circle and a percentage: Agent Services, Build Runners, Model Providers, Git Integrations,
  Security Scanning, Infrastructure.
- **Surfaces**: page background deep navy (~#0A0F1E); cards/panels slightly lighter navy (~#0F172A /
  #111A2E) with a 1 px low-contrast border (~#1E2A44) and 12 px radius; no heavy shadows, faint glow only
  on active/selected elements.
- **Accents**: primary action = blue→indigo gradient (≈#3B82F6 → #6366F1); violet (≈#8B5CF6) for brand
  and "selected" highlights; per-agent hues (Claude coral/orange, Codex/OpenAI white-teal, Gemini
  violet-magenta, Jarvis blue, QA green, Security amber, Reviewer blue).
- **Semantic status colors only**: green = success/online/done, amber = warning/waiting, red =
  failed/critical/blocked, blue = running/in progress, gray = pending/idle. Status pills: small rounded
  pill, tinted background (~12 %), colored dot + label.
- **Typography**: Inter-like sans; page title ~28 px semibold; card titles 14–15 px semibold; body 13 px;
  meta 11–12 px muted (~#8B97B0); KPI numbers 24–28 px semibold tabular; code in a mono font.
- **Links**: blue text "View all →" in card headers.

## Screen 1 — Home Dashboard

Layout top → bottom:
1. **Greeting row**: "Welcome back, <name>" + subtitle "Your AI software engineering control center";
   right side date + one-line tagline + primary button "+ Create New Project".
2. **KPI row (5 cards)**: icon tile (40 px, tinted square) + label + big number + delta/badge + "View … →"
   link. Cards: Active Projects (6, ↑+2), Running Agents (8 / 8, "Healthy" pill), Active Runs (3, "2 queued"),
   Open Tasks (12, ↑4), Model Usage (18.4K tokens (24h), ↓26 %).
3. **Project Workflow panel** (wide, left): title + project chip + status pill "In Progress" + right-aligned
   caption. Six stage cards in a row joined by blue arrows: Architect, Backend, Frontend, QA, Security,
   Review. Each: colored icon, title, two-line description, bottom status glyph (green check = done,
   spinner = running, empty circle = pending). The running stage has a brighter violet border.
4. **Agents Health panel** (right): 2×4 grid. Each item: agent icon tile, name, role, "● Online" and a
   percentage with a sparkle glyph. "View all →".
5. **Bottom row (3 columns)**: **Active Projects** (icon, name, one-line description, status pill, progress
   bar, %) · **Recent Runs** (run icon by status, "#482 Add product search API", project · time ago,
   status pill Success/Running/Failed, duration) · **Model Usage (24h)** donut with total in the centre
   and a legend (model, %, tokens).
6. **Last row**: **Sprint Progress** (week chip, "On Track" pill, progress bar, counters Total / Completed /
   In Progress / Blocked) · promo card "Multi-Agent Workspace — Coming Soon / Get Early Access" · promo card
   "Visual Workflow Builder — Try Now" with a mini 4-node pipeline.

Real-data mapping (V1 has the data unless marked NEW):
- Name: local OS user name (`os.userInfo().username`) or a name set in Settings — no fake role/avatar.
- KPIs: projects by status, live running agents vs process budget, runs (NEW `runs` table; until Phase 4
  = projects with an active pipeline), open tasks (non-terminal), tokens 24 h from `usage_records`
  with a real delta vs the previous 24 h.
- Project Workflow: the current project's tasks grouped by role/stage with real status, current task,
  provider/model, duration, latest artifact, error.
- Agents Health: one item per **agent role** (7 roles) + one per **provider**; the percentage is a real
  metric with a label (e.g. verified success rate over 7 days), never an invented "health %".
  Online/Idle/Failed/Disconnected from provider detection + live state.
- Recent Runs: real runs (Phase 4) / recent finished tasks (`/api/live` `recent`) before that.
- Model Usage donut: tokens per provider/model from `usage_records`; cost only where a provider reports
  it, labelled as reported cost; no subscription quota unless a provider exposes it legitimately.
- "Sprint Progress" → **Project Progress** (real task counts; milestones in Phase 5).
- Promo cards → **real quick-launch cards** (open Workspace with the project preset; open Builder with
  the standard workflow). No "Coming Soon" for features that exist.
- Sidebar "System Status" → real checks: API, database, event stream, provider detection, git on PATH,
  disk space of `data/`, CPU/RAM. Each row shows OK / degraded / down, never a constant 100 %.

## Screen 2 — Multi-Agent Workspace

- **Title row**: "Multi-Agent Workspace" + subtitle; toolbar right: layout select "6 Panels ▾", two
  layout-mode toggles, Share, Save Workspace, primary "+ New Session", overflow "⋯".
- **Tab strip**: Workspace (active), Open Files (12), Shared Artifacts, Run History, "+".
- **Panel grid** 3×2 (layouts 1–8). Each **agent panel**: header (agent icon, "Claude – Architect",
  role subtitle, status pill Running / Testing / Scanning, buttons pause, restart, ⋯), per-panel sub-tabs,
  body, optional footer input. Selected panel: colored border (blue, magenta).
  - Claude Architect: tabs Chat / Plan / Artifacts (3); chat message bubble; artifact card
    ("Architecture Diagram · architecture.mmd · View"); step checklist with durations and an
    "In Progress" pill; input "Message Claude…" with attach, @mention, send.
  - Codex Backend: tabs Editor / Terminal / Tests / Logs; code editor (file tab, line numbers, syntax
    colors, status bar: language, LF, UTF-8, spaces, Ln/Col).
  - Gemini Frontend: tabs Editor / Preview / Console / Components; TSX file in the editor.
  - Jarvis Orchestrator: tabs Timeline / Decisions / Tool Calls / Memory; timestamped timeline with check
    icons; "Current Objective" card with progress bar "3 / 6 steps completed 50 %".
  - QA Agent: tabs Terminal / Test Results / Coverage; terminal running `npm run test` → vitest output,
    green "PASS All tests passed!".
  - Security Reviewer: tabs Scan Results / Terminal / Recommendations; severity counters (Critical red,
    High amber, Medium blue, Low gray); findings list (title, severity tag, file:line, description, "Fix").
- **Right drawer** (collapsible) tabs Agent Coordination / Shared Context / Artifacts: "Current Workflow"
  mini pipeline with per-stage status; "Task Handoffs" vertical timeline (from → to, summary, time,
  Completed / In Progress / Pending); "Agent Communication" (Live pill) message list with @mentions;
  input "Message all agents…".
- **Bottom status bar**: active session · project + feature · "6 / 8 Agents Running" · elapsed timer ·
  tokens used / budget bar · CPU, Memory, Network meters.

Real-data mapping:
- A panel = a **real agent session** (NEW `agent_sessions`): provider + model + effort + role + project +
  working directory (own worktree when it may edit files). Sub-tabs show real data: Chat = session turns;
  Plan/Timeline = linked task + events; Artifacts = files changed in the session worktree (git diff);
  Editor = read-only file viewer of the worktree (editing stays with agents in V2.0); Terminal = output of
  studio-run allowlisted commands (and the optional PTY terminal of Phase 3b); Tests = parsed test run;
  Scan Results = parsed security findings; "Fix" creates a real fix task.
- "Jarvis Orchestrator" panel → the **studio orchestrator panel** (scheduler decisions, handoffs, events).
  Jarvis itself is not integrated (and must not be modified); it can only appear later as a provider.
- Handoffs = real dependency completions between tasks (task A completed → task B started).
  Agent Communication = real `agent_messages` + orchestrator notes; "Message all agents" posts to the
  orchestrator, which routes to sessions — no frontend-only fake chat.
- Status bar: tokens today (real), budget bar only when a budget is configured; CPU/RAM real; drop
  "Network" unless measured. "Share" → export workspace layout JSON (no cloud sharing).

## Screen 3 — Visual Workflow Builder

- **Title row**: icon + "Visual Workflow Builder" + subtitle; toolbar: undo, redo, zoom − 100 % +,
  "Validate" (green check), "Simulate", primary "Run", primary "Save" with dropdown.
- **Breadcrumb**: home › project › workflow name ▾ · "Draft" chip · "Auto-saved 2m ago".
- **Canvas**: dark, nodes ~170×110 cards with a type-colored border, icon tile, title, subtitle, green
  status dot, 3-item bullet list, bottom chip with model/tool. Node types shown: Trigger (green),
  Architect (blue), Task Decomposition (violet), Backend Agent, Frontend Agent (magenta), QA Tests
  (selected, bright border), Security Scan (orange), Quality Gate (diamond, "All checks passed?"),
  Create Fix Tasks (red), Reviewer, Human Approval ("Required" chip), Deploy, Notifications (red).
  Edges: blue curved with arrowheads, fan-out (Task Decomposition → Backend + Frontend) and fan-in
  (→ QA); Quality Gate "Yes" (green label) → Reviewer, "No" (red label) → Create Fix Tasks; dashed red
  "Retry" edge back to Task Decomposition. **Mini-map** bottom-right with +/−/fit.
- **Inspector** (right, "Node Configuration", delete + close): node header with "Active" pill;
  description; tabs Configuration / Inputs (3) / Outputs (4); fields Node Name, Description; Agent/Model
  (provider select + model select); Execution Settings (Max Retries stepper, Timeout minutes, Cost Limit
  USD); Test Configuration toggles (unit, integration, e2e, report); Permissions toggles (project
  credentials, test environments, external API calls); Outputs list with types (JSON, String, File).
- **Bottom panel**: tabs Run History / Validation (2) / Execution Logs / Artifacts + search; run table
  (Run ID, Branch/Trigger, Status, Duration, Cost, Started); selected run detail with tabs Timeline /
  Execution Logs / Agent Messages / Artifacts and a per-step timeline with timestamps and durations.

Real-data mapping:
- Node catalog comes from the server with a capability flag per type: **executable** (backed by V1
  orchestration: Requirement, Architect, Task Decomposition (PM plan), Backend, Frontend, QA tests,
  Security review, Reviewer, Human Approval gate, Quality Gate → V1 fix loop, Retry policy, Tool
  Execution (allowlisted command), Artifact Output (report), in-app Notification) or **planned**
  (Deploy/Delivery, external notifications like Slack, Delay — shown disabled with an explanation).
- Run = compile the graph to the V1 task DAG and execute it with the existing scheduler; the canvas
  shows live node status from task events.
- "Simulate" = dry-run validation + compiled task list preview (no agents started).
- Cost: only measured costs; Cost Limit maps to the existing provider budget check when set.
- Permissions toggles must map to real enforcement (command allowlist, approvals); otherwise omit.
