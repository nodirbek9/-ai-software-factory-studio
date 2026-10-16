# V2 Design System

**Status:** proposed for V2.0 · **Updated:** 2026-10-16 · **Theme:** dark only

This spec turns the three reference screens into a reusable system for real V1-backed data. Reference names, counts, percentages, and statuses are illustrative; never ship them as fixture UI. V2 evolves the V1 palette and primitives (`web/src/index.css:3-28`, `web/src/components/ui/primitives.tsx:7-80`); role colors and state semantics retain V1 identity (`web/src/components/agentMeta.tsx:10-25`, `web/src/lib/utils.ts:12-30`).

## Visual and accessibility contract

- Canvas is deep navy; panels are separated by subtle borders, not heavy shadows. Use restrained blue/indigo action gradients and violet selection. Reserve semantic hues for actual status or findings.
- Dark is the only V2.0 theme. Tokens remain semantic so a later theme can replace values without component rewrites.
- Text and meaningful status labels use colors with at least **4.5:1** contrast against the base surface. Large text may use 3:1. Focus indicators, control boundaries, chart marks, and other non-text state cues target **3:1** against adjacent colors. Never convey status by color alone.
- Ratios below use WCAG relative luminance, rounded, against `surface` `#0F1729`; the same foregrounds also exceed 4.5:1 on `canvas` `#080D19`. Contrast is not guaranteed for translucent mixtures; put status text on the opaque surface and use tint only behind it.

### Color tokens

| Role | Token / hex | Use |
|---|---|---|
| Background layers | `canvas #080D19`; `sidebar #0B1222`; `surface #0F1729`; `raised #131D33`; `hover #192743` | App, nav, cards, overlays, hovered rows |
| Borders | `border #344563`; `border-subtle #263551`; `divider #202D45` | Controls, selected boundaries, quiet separators |
| Text | `text #E6EDF8` (15.18:1); `text-muted #B0BCD0` (9.32:1); `text-subtle #9AA9C0` (7.50:1); `text-disabled #8A96AA` (5.98:1); `on-brand #080D19` | Main, secondary, metadata, disabled labels, filled primary controls |
| Brand | `brand-blue #8AB4FF` (8.56:1); `brand-indigo #A5A8FF` (8.21:1); `brand-violet #C4A7FF` (8.78:1); `brand-cyan #9FE7E2` (12.77:1) | Links, gradient endpoints, selection, secondary highlight |
| Agents | `agent-claude #FFAA8C` (9.69:1); `agent-codex #9FE7E2` (12.77:1); `agent-gemini #D4A6FF` (9.11:1); `agent-jarvis #8AB4FF` (8.56:1); `agent-qa #78E0A7` (11.08:1); `agent-security #FFD08A` (12.46:1); `agent-reviewer #90AFFF` (8.31:1) | Stable role icon/chip accents; Jarvis color reserved for studio orchestrator UI, not an integration |
| Status | `status-idle #AAB6C8` (8.71:1); `status-planning #C4A7FF` (8.78:1); `status-running #8AB4FF` (8.56:1); `status-waiting #FFD08A` (12.46:1); `status-blocked #FFB86B` (10.49:1); `status-success #78E0A7` (11.08:1); `status-failed #FF9292` (8.32:1); `status-cancelled #AAB6C8` (8.71:1) | Label + dot/icon; waiting covers approval and paused states |
| Status tint | `success-tint #102B28`; `warning-tint #302719`; `danger-tint #321F28`; `info-tint #172743`; `selected-tint #202548` | Low-opacity-look backgrounds, implemented as opaque safe colors |

### Tailwind 4 theme block

Paste into the design token stylesheet after `@import "tailwindcss"`. Self-host WOFF2 assets under the web app and declare `@font-face` for Inter and JetBrains Mono; do not load fonts from a CDN.

```css
@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --color-canvas: #080D19;
  --color-sidebar: #0B1222;
  --color-surface: #0F1729;
  --color-raised: #131D33;
  --color-hover: #192743;
  --color-border: #344563;
  --color-border-subtle: #263551;
  --color-divider: #202D45;
  --color-text: #E6EDF8;
  --color-text-muted: #B0BCD0;
  --color-text-subtle: #9AA9C0;
  --color-text-disabled: #8A96AA;
  --color-brand-blue: #8AB4FF;
  --color-brand-indigo: #A5A8FF;
  --color-brand-violet: #C4A7FF;
  --color-brand-cyan: #9FE7E2;
  --color-agent-claude: #FFAA8C;
  --color-agent-codex: #9FE7E2;
  --color-agent-gemini: #D4A6FF;
  --color-agent-jarvis: #8AB4FF;
  --color-agent-qa: #78E0A7;
  --color-agent-security: #FFD08A;
  --color-agent-reviewer: #90AFFF;
  --color-status-idle: #AAB6C8;
  --color-status-planning: #C4A7FF;
  --color-status-running: #8AB4FF;
  --color-status-waiting: #FFD08A;
  --color-status-blocked: #FFB86B;
  --color-status-success: #78E0A7;
  --color-status-failed: #FF9292;
  --color-status-cancelled: #AAB6C8;
  --color-success-tint: #102B28;
  --color-warning-tint: #302719;
  --color-danger-tint: #321F28;
  --color-info-tint: #172743;
  --color-selected-tint: #202548;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 9999px;
  --spacing-0-5: 2px;
  --spacing-1: 4px;
  --spacing-1-5: 6px;
  --spacing-2: 8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-5: 20px;
  --spacing-6: 24px;
  --spacing-8: 32px;
  --spacing-10: 40px;
  --spacing-12: 48px;
}
```

### Type, spacing, shape, elevation, motion

| Token | Specification |
|---|---|
| Typeface | Inter 400/500/600/700; JetBrains Mono 400/500. Sans for UI, mono for code, IDs, timestamps, metrics where alignment matters. Enable `font-variant-numeric: tabular-nums`. |
| Type scale | 11/16 metadata; 12/16 compact label; 13/20 control/body dense; 14/20 default body; 16/24 section heading; 20/28 page subtitle; 28/36 page title; 24-28/32 KPI. Weights: 400 body, 500 controls, 600 headings, 700 only emphasis. |
| Spacing | 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48 px. Default card padding 16; dense panel 12; page gutter 24 (wide) / 16 (compact). |
| Radius | 4 tiny marks; 6 inputs; 8 buttons/popovers; 12 cards/dialogs; 16 large shell surfaces; pill for status and chips. |
| Border/elevation | 1 px subtle by default; selected/focus border 1-2 px brand. Card shadow `0 8px 24px #00000033`; modal `0 20px 60px #00000066`; selected glow at most `0 0 18px #8AB4FF26`. Avoid persistent blur. |
| Motion | 100 ms press, 140 ms hover/focus, 180 ms tooltip/menu, 220 ms drawer/dialog, 300 ms layout; `cubic-bezier(.2,.8,.2,1)` enter and `cubic-bezier(.4,0,1,1)` exit. Progress transitions 300 ms. No continuous shimmer; reduced-motion disables transitions/animation and replaces spinners with static progress text/icon. |
| Icons | lucide-react outline, 1.75-2 px stroke; 16 px inline, 18 px navigation, 20 px buttons, 24 px empty state. Pair with visible text or accessible name; do not use emoji or agent logos as status. |

### Density and shell

- Shared shell follows reference proportions: header 56-64 px, sidebar 216 px expanded / 56 px collapsed, bottom status bar 28 px. Sidebar labels 14 px; nav icon 18 px. At 1366×768, use 56 px header, 200 px sidebar, 16 px page gutter, compact 12 px card gaps; collapse inspector/drawer and permit scrolling. Keep primary action and current project visible. Never shrink body text below 12 px to force-fit.
- At 1920×1080, use 64 px header, 224 px sidebar, 24 px gutter, 16-20 px card gaps; cap reading columns around 1440 px and use extra width for dashboard columns/workspace panels. Preserve consistent card paddings.
- Workspace grids use available dimensions with a 280 px minimum panel width where possible; below that show a single panel or an explicit overflow/layout choice. No content is clipped to simulate the mock's 6-panel view.

## Component contract

All interactive elements implement the state row below. Disabled is visually distinct and truly inert; loading announces progress and prevents duplicate submission. Focus-visible is a 2 px brand outline with 2 px offset, never removed. State changes remain understandable without color. Use native semantics/ARIA, keyboard operation, and 44×44 px hit targets where practical (compact icon controls may be 32×32 with surrounding hit area).

| Component | Default and state behavior |
|---|---|
| Button variants | Primary blue→indigo fill, dark text; secondary raised + border; ghost transparent; danger/success semantic tint + border. Hover raises surface/brightness; focus outline; active 1 px press; disabled muted/inert; loading spinner + stable width + `aria-busy`. Sizes 32/36/40 px. |
| IconButton | 32 or 36 px square, icon 16/18 px, tooltip and accessible label required. Hover raised; focus outline; active inset; disabled muted; loading spinner. Destructive action uses danger treatment and confirmation when destructive. |
| Card / KPI card | Card surface, 1 px divider border, 12 px radius; hover border only if clickable; focus outline if interactive; active follows contained control. Disabled content muted with reason. Loading uses Skeleton; KPI value 24-28 px tabular, label + unit + period and real delta source; missing data says “—”/“Not available”, never fabricated. |
| StatusPill | 11-12 px label + dot/icon, tinted fill, semantic border. Hover only if interactive; focus outline when actionable; active pressed; disabled retains readable label; loading uses “Checking…” and static indicator. Map statuses through canonical state metadata; unknown → Idle/Unknown, not success. |
| Tabs | Underline or quiet segmented surface, selected has text + underline/border; hover surface; focus outline; active selects; disabled tab excluded from tab order with reason. Loading panel retains selected tab and shows Skeleton. Arrow keys/Home/End. |
| SegmentedControl | Single selection, 32-36 px; selected brand-tint + text; hover/active surface; roving keyboard focus; disabled options explained; loading locks choices and labels pending operation. |
| Input / Select / Textarea | Surface, 1 px border, 36 px input/select, textarea min 80 px. Placeholder uses readable subtle token. Hover border; focus brand border + ring; active caret; disabled muted; loading read-only with inline progress. Error state pairs message and `aria-describedby`; labels never rely on placeholder. |
| Toggle | 36×20 track, 12 px thumb; checked brand, off raised; hover border; focus ring; active thumb press; disabled muted; loading locks and announces “Updating”. Text label always describes setting. |
| Stepper | 32 px decrement/value/increment controls; numeric tabular value; hover/focus/active as IconButton; disabled at min/max with bounds; loading disables both and shows pending marker. |
| Tooltip / Kbd | Tooltip delayed 180 ms, 12 px, max 320 px; hover/focus opens, active stays, disabled trigger can expose explanation via wrapper, loading tooltips suppressed. Kbd uses mono 11 px, raised keycap + border; no interactive states. |
| Menu / ContextMenu | Raised surface, border, 8 px radius; hover highlighted row; keyboard focus follows active row; active executes; disabled item explains why; loading action row becomes spinner and prevents repeat. Escape/outside closes; context menu has keyboard equivalent. |
| Dialog / Drawer | Dialog centered, max 90vh, overlay; drawer right edge with title/close and modal semantics unless explicitly nonmodal. Hover/focus/active inherited by controls; disabled actions explain; loading shows inline state and blocks duplicate commit. Focus trap, return focus, Escape close unless unsaved/destructive guard requires a clear choice. |
| SplitPane handle | 4 px rail, 24 px hit target; hover/focus brand; active visibly grips; disabled fixed-size divider; loading N/A. Keyboard resize, announce pane sizes; min/max boundaries. |
| Sidebar item | Icon + 14 px label; default muted; hover raised; focus outline; active selected navy/brand border + bright label; disabled muted + reason; loading nav keeps route and shows compact progress. |
| Header search / Command palette | Search field 36 px; palette opens with Ctrl/Cmd+K, searchable real navigation/actions and current project. Hover/focus row highlight; active invokes; disabled action gives reason; loading shows actual request; empty results state, Escape close, arrows + Enter. Never include actions without API support. |
| Toast / Notification | Toast has semantic icon, title, concise detail, timestamp and optional real action; hover pauses timeout; focus actionable; active action; disabled action omitted with explanation; loading action row. Notifications list is event-backed (failures, approval waits, provider limits); unread dot only when unread events exist. |
| Table / VirtualList | Table header/rows have consistent 36-40 px density, tabular numeric columns, sortable headers announce direction; row hover, focus for row action, active selection, disabled row reason, loading Skeleton rows. VirtualList preserves row keyboard access, stable keys, scroll position; empty/error states distinct. |
| ProgressBar / Donut / Sparkline | Progress has label/value and accessible min/max; determinate only for measured progress, otherwise indeterminate with text. Donut legend + center total and percentages from usage records; Sparkline has period, units, accessible summary. Hover may reveal exact measured point; focusable data only when useful; active/disabled/loading states use static placeholder with “No data” or Skeleton, never zero-filled mock series. |
| Skeleton / EmptyState / ErrorState | Skeleton matches final geometry, no flashing; reduced motion is static. Empty state names what is absent and offers a supported next action; hover/focus/active on action; disabled with reason; loading transitions to skeleton. ErrorState states failed request and retry action; retry hover/focus/active, disabled during retry, loading announces retry progress. |
| Code / terminal surface | `surface`/canvas, mono 12-13 px, line height 1.55, visible line numbers, wrap toggle if available, selection readable. Read-only editor/output is default; terminal is captured output, not an interactive shell. Hover row subtle, focus toolbar, active selection; disabled explains read-only; loading “Loading file/output”; syntax colors must meet 4.5:1. Interactive PTY is **planned optional Phase 3b**, off by default and subject to D-019 approval. |
| React Flow node / edge | Node card ~170-220 px, raised surface, 1 px type-hue border/icon; title, role, status label, useful real metadata. Hover border, focus-visible outline, active selection `selected-tint` + glow, disabled planned node striped/tinted with “Planned” + reason, loading/running uses static status text and subtle edge progress. Edge 2 px brand-blue curve + arrow; success green; retry dashed amber/red with label; selected 3 px. Labels/handles keyboard accessible. Deploy and external notification nodes remain non-executable/planned per catalog. |

## Data and interaction boundaries

```text
idle/draft/pending → queued → running/planning → completed
                         ↘ waiting_approval ↗
                         ↘ paused → running
                         ↘ blocked | failed | cancelled (terminal until real retry/recovery)
```

Status colors are presentation only; actual state comes from API/SSE. Percentages require a named measurable denominator; usage/cost come only from `usage_records`; “health” shows named checks/status rather than a decorative score. Agent panels map to real sessions; “Jarvis” means studio orchestrator only. File editor is read-only; workspace communication, artifacts, runs, logs and findings must be backend-backed. Unsupported workflows (Deploy/Delivery, generic expressions, external notifications, delay) are planned/disabled with reason. PTY terminal is optional planned work and needs D-019 approval. Respect D-011 through D-016; this spec changes no decision.

## V1-to-V2 migration map

| V1 source | V1 token/class or behavior | V2 target |
|---|---|---|
| `web/src/index.css:3-28` | Instrument Sans; `ink-*`, `line*`, `text/muted/faint`, `brand`, `brand-2`, `st-*` | Inter + JetBrains Mono; semantic `canvas/surface/raised/border/text/brand/status-*` above. Keep aliases temporarily during page-by-page strangler migration. |
| `web/src/index.css:39-59` | layered dark background, tnum, blue focus, reduced motion | dark-only layered canvas; tabular numbers; explicit 2 px focus ring; same reduced-motion guarantee. |
| `web/src/components/ui/primitives.tsx:7-20` | primary/secondary/ghost/danger/success; 28/32 px buttons | five visual variants retained; 32/36/40 px accessible targets and unified focus/active/disabled/loading. |
| `web/src/components/ui/primitives.tsx:31-65` | Panel, PanelHeader, StatusDot/Badge, Progress | Card/KPI/StatusPill/ProgressBar; opaque tint + AA text, explicit status label and accessible progress. |
| `web/src/components/ui/primitives.tsx:69-123` | Input, Select, Textarea, Field, Dialog, EmptyState | Keep API intent; standard heights, error/loading states, focus management, actionable empty/error states. |
| `web/src/lib/utils.ts:12-30` | canonical status labels/colors + unknown fallback | Preserve state names and live semantics, map to `status-*`; unknown rendered neutral “Unknown”. |
| `web/src/components/agentMeta.tsx:10-25` | Seven stable role icons and hues | Keep role identity with brighter AA-safe hues; Jarvis is not an agent role in V1 and must not imply an external integration. |

## Acceptance checks

1. At 1366×768 and 1920×1080, shell, page title, current project, primary action, and responsive content remain reachable without overlap; workspace can scroll or change layout rather than clip.
2. Every listed interactive component can be inspected in default, hover, focus-visible, active, disabled, and loading states; keyboard-only use works and no focus indicator is hidden.
3. Automated contrast checks confirm every text/status foreground meets 4.5:1 on each actual opaque surface; non-text focus/boundary cues meet 3:1. No translucent tint carries essential text.
4. Reduced-motion mode removes animated transitions and live pulses. Screen readers receive control labels, status text, progress values, errors, and retry progress.
5. UI examples use live API/SSE data or honest empty/loading/error states. No screenshot values, fake percentages, unsupported actions, or secret/config values appear.

## Open questions for Opus

- Should the user profile/avatar block in the visual reference be omitted in V2.0 unless a real local identity/profile endpoint exists?
- Confirm whether 44 px touch targets are required throughout, given the 1366×768 dense workspace and desktop-only target.
- Should the reviewer hue move from V1 pink `#f58fb8` to reference-aligned blue `#90AFFF`?

## SUMMARY

Dark-only semantic token system adapts the V1 palette and reference layouts with AA-contrast foregrounds.
Component states, responsive density, interaction/data boundaries, migration mappings, and acceptance checks are specified.
Unsupported workflow controls and interactive PTY are explicitly planned/disabled.
