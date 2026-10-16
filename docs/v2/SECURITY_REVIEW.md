# Security Review — V1 controls, findings, V2 threat model

Inputs: code review by Opus 5.5 (2026-10-16) and `V1_AUDIT.md` §4 (risk IDs R1–R19 are defined there and
referenced, not repeated). Scope: local single-user studio on Windows; agents are the owner's CLI logins.

## 1. Controls V1 already has (keep them)

| Control | Evidence |
|---|---|
| Loopback bind by default; non-loopback refuses to start without `ASF_AUTH_TOKEN` | `server/src/config.ts:62-78` |
| Token check on every request when configured (header or `?token=` for SSE), constant-time compare | `server/src/api/routes.ts:49,105-112` |
| Mutations need an allowed `Origin` and `Content-Type: application/json` (CSRF) | `routes.ts:113-125` |
| Path guard: approved roots, protected paths, `resolveInside` (no `..`, absolute, `.git`) | `workspace/workspaceManager.ts:63-137` |
| Git subcommand allowlist (no push/reset/clean/branch delete/rebase), `--no-ff` merges only, no prompts | `workspace/git.ts:16-40` |
| Command allowlist with argv parsing and a safe-token regex; others need a per-project approval | `workspace/commandRunner.ts:5-30` |
| Secret redaction (patterns + registered literal secrets) on events, outputs and errors | `security/redact.ts` |
| Claude agents: Bash/WebFetch/WebSearch disallowed, edit tools only in edit mode | `providers/cliProviders.ts:84-93` |
| Single-instance lock; recovery after the port is bound | `instanceLock.ts`, `app.ts:52-58` |
| API never returns provider secrets (settings are non-secret only) | `providers/registry.ts`, `api.test.ts` |

## 2. Findings

### From the V1 audit (fix in Phase 0b, before V2 adds privileges)
R1 nested-symlink path escape (HIGH) · R2 retry bypasses unmet dependencies (HIGH) · R3 final verification
can be skipped by DAG shape (HIGH) · R4 no Host allowlist → DNS-rebinding can pass the Origin check (HIGH) ·
R5 file API/commits can expose `.env`-like files; inconsistent redaction (HIGH) · R6 untrusted project code
runs via `npm test/install`, git hooks (HIGH) · R7 failed partial-save still removes the worktree (HIGH) ·
R8 discovered `~/.claude-account4..9` not protected (MEDIUM). R9–R19 are tracked in the phase where the code
is touched.

### Added by this review
| ID | Severity | Finding | Fix |
|---|---|---|---|
| S1 | HIGH | Claude agents run with `--setting-sources project,local` in the task worktree. An imported repository's `.claude/settings.json` can define **hooks** (shell commands run by the CLI) and permission rules; `--disallowedTools Bash` does not stop hooks. (`cliProviders.ts:91`) | Phase 0b: run agents with no project/local setting sources (or a studio-owned settings file via `--settings`), and refuse to start a Claude turn in a worktree that contains `.claude/settings*.json` with `hooks` until the owner approves that project ("trusted project"). Same review for Codex (`AGENTS.md` = prompt injection only; verify no project-level config/MCP is loaded) and Gemini/Antigravity (`.gemini/settings.json` MCP servers). |
| S2 | MEDIUM | Codex edit turns may run any command inside Codex's `workspace-write` sandbox (allowed by prompt), outside the studio allowlist. (`cliProviders.ts:212`) | Keep (owner-approved behaviour) but label it in the Agents/Models page and the Security center; add a per-project toggle "allow agent-run commands (Codex sandbox)". |
| S3 | MEDIUM | `npm install`/`npm ci` are allowlisted; install scripts execute package code. (`commandRunner.ts:6`) | Phase 6: run installs with `--ignore-scripts` unless the project is trusted; show the risk in the approval text. |
| S4 | LOW | No request rate limit (local tool). Acceptable for loopback; required if remote mode is ever used. | Add a simple per-IP limiter only in non-loopback mode. |

## 3. V2 threat model (new surfaces)

| Surface | Threat | Required controls (phase) |
|---|---|---|
| Agent sessions, edit mode (P3) | Agent writes outside its worktree; one session overwrites another; prompt injection from repo files | Own worktree per edit session; `resolveInside` after R1 fix; merge only by explicit user action through the V1 integration path with confirm; repo content is data — system prompt says so (V1 `STUDIO_GUARD`). |
| Session continuity (P3) | Native Claude sessions stored in the account dir; transcript leakage | Redact before storing turns; native mode is a setting; studio never reads or copies the CLI's session files. |
| Merge / discard / checkpoint (P3) | Data loss | Confirm dialogs; discard never deletes branches; R7 fix blocks cleanup when saving fails; audit events. |
| Workflow import/export (P4) | Malicious graph JSON (huge, script-like strings, other project ids) | zod schema, size limits (`WORKFLOW_ENGINE_SPEC.md` §4), ids regenerated on import, labels rendered as text only. |
| Tool Execution node (P4) | Arbitrary command execution | Same allowlist + approval flow as tests; argv only; runs in the integration worktree; never `shell: true`. |
| Human approval / release gate (P4) | Bypass via retry (R2) | R2 fix: retries go through dependency promotion; gates complete only through `decideApproval`. |
| `/api/v2/*` read models (P2) | Over-broad data (file contents, specs, secrets) in summaries | Summary DTOs only; redaction on every string leaving the server; no file contents in overview endpoints. |
| System metrics (P2) | Process list leaks other apps' command lines | Report only studio-owned processes (pids we spawned) and aggregate CPU/RAM. |
| Notifications (P1) | Secrets in toasts | Built from redacted event messages only. |
| `npm audit` scanner (P6) | Network access, data sent to registry | One-time approval per project; uses the project's lockfile only. |
| PTY terminal (P3c, optional) | Remote shell if exposed; clickjacking | Off by default; loopback only; token + Origin + Host check on the WebSocket; worktree cwd; idle kill; audit log; disabled in non-loopback mode. |
| Free/third-party model routes (OmniRoute, Kiro) | Prompts/code sent to providers that may train on them | Not used by the studio (owner rule, 2026-10-16); the OpenAI-compatible provider shows a warning when its base URL is not a first-party API. |

## 4. Audit-log events (new `audit.*` type, never pruned with normal event retention)
`audit.session.merge`, `audit.session.discard`, `audit.session.checkpoint`, `audit.run.start`,
`audit.run.cancel`, `audit.approval.decided`, `audit.command.approved`, `audit.folder.approved/revoked`,
`audit.project.deleted`, `audit.workflow.imported/deleted`, `audit.terminal.opened/closed`,
`audit.settings.changed` (diff of non-secret keys). Each: who = "local owner", what, target ids, time.

## 5. Destructive-action confirmation rules
Confirm dialog (with the exact target named) for: delete project, discard session worktree, merge session,
cancel run, delete/archive workflow, revoke approved folder, reject plan. Typed confirmation ("type the project
name") for delete project. Never automatic: push, deploy, branch deletion, `git reset/clean`.

## 6. Secrets handling
Secrets live only in the server `.env` / CLI login stores; the API returns non-secret settings only; every
string leaving the server (REST, SSE, reports, errors) passes `redact()`; R5 fix adds a sensitive-file policy
(`.env*`, `*.pem`, `*.key`, `id_*`, `*.pfx`, credential JSON) for file reads, copy-import and `commitAll`;
worker jobs (router, akk4) never receive `.env` contents; logs written by the studio are redacted.

## QUALITY_SECURITY_CONTRACT (for "AI Security & QA Guardian" and built-in scanners)

```ts
interface QualityScanner {
  id: string; label: string; kind: 'tests' | 'sast' | 'dependencies' | 'secrets' | 'review' | 'coverage';
  detect(): Promise<{ available: boolean; version: string | null; reason: string | null }>;
  scan(input: { projectId: string; runId: string; cwd: string; commit: string; signal: AbortSignal }): Promise<ScanResult>;
}
type ScanResult = {
  scannerId: string; status: 'passed' | 'failed' | 'error' | 'not_run'; startedAt: string; finishedAt: string;
  commit: string; metrics: Record<string, number>;        // e.g. tests_passed, tests_failed, coverage_lines_pct
  findings: Finding[]; rawReportPath?: string;            // stored under data/, never in the repo
};
type Finding = {
  id: string;                     // stable hash of scanner+rule+file+line
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string; file: string | null; line: number | null; description: string; recommendation: string | null;
  source: string;                 // scanner id or agent role
  status: 'open' | 'fixed' | 'accepted' | 'false_positive';
};
```
Rules: a scanner that did not run reports `not_run` (never `passed`); unparsable agent output reports
`error` with the raw text attached; findings are redacted; "Create fix task" turns selected findings into a V1
fix task description. Guardian integration options: CLI (`guardian scan --json <cwd>` → `ScanResult` on
stdout) or HTTP (`POST /scan` on loopback) — whichever Guardian ships; the adapter maps it to this contract.

## 7. Release security checklist (Phase 7)
- [ ] R1–R8 and S1 fixed with regression tests.
- [ ] Hostile `Host`/`Origin` tests pass; non-loopback refuses to start without a token.
- [ ] No route returns file contents of sensitive files; synthetic-secret test passes through REST, SSE, reports.
- [ ] All destructive actions confirmed and audited.
- [ ] Workflow import fuzz test (size, schema, ids).
- [ ] No new dependency with install scripts or native builds unless approved (D-003, D-019).
- [ ] Independent security review by a worker + Opus final sign-off.

## SUMMARY
V1's guards are solid for a local tool, but eight HIGH issues (audit R1–R7 plus S1: project-level Claude
hooks) must be fixed in a short Phase 0b before V2 adds sessions, tool nodes and terminals. V2's new surfaces
each get concrete controls, audit events and confirmations. The QualityScanner contract lets a future Guardian
plug in without UI changes and guarantees that "not run" is never shown as PASS.
