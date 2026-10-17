# Phase 7 — Stabilization and release (2026-10-17)

Owner rule: everything here runs on V2 data or on copies. Merge into `main`, the `v2.0.0` tag, restarting V1 and
the cut-over wait for the owner's "ha".

## 1. Browser E2E (D-017)
`npm run test:e2e` = `npm run build` + `playwright test` (`playwright.config.ts`, specs in `e2e/`). Installed Edge
(`channel: 'msedge'`, Edge 155), a studio on a fresh temp `ASF_DATA_DIR` on port 4397 (`ASF_E2E_PORT`), only the
offline Scripted provider (the default of a new database), no AI quota. Every test fails on page errors and console
errors (`e2e/fixtures.ts`). Teardown deletes the temp dir unless a test left artifacts (`ASF_E2E_KEEP=1` keeps it).

| Spec | Covers (TEST_PLAN ids) |
|---|---|
| `navigation.spec.ts` | P1-04 every nav item at 1366×768 and 1920×1080, h1, no alert, no horizontal scroll; P2-04 Home KPIs vs API |
| `workflow.spec.ts` | V1 core flow in the V2 UI: plan → approve → scripted run completes; P5-03 Tasks list + drawer; P6-03 QA gates, Logs search |
| `workspace.spec.ts` | P3-05 six panels, two scripted sessions with real turns, layout restored after reload, 0 processes while idle; Terminal disabled with reason (D-019) |
| `builder.spec.ts` | P4-05 Standard → Duplicate → Validate → Simulate → Run → approve → run completed in history |
| `perf.spec.ts` | Performance targets (§3) |

**Real bug found by E2E and fixed:** opening *New Session* while the project snapshot was not loaded yet (a fresh
project) looped React forever (error #185, "getSnapshot should be cached") and the dialog's *Create session* stayed
disabled. Cause: the selector `s.snapshot?.tasks ?? []` returned a new array on every render. Fix: a stable empty
list (`NewSessionDialog.tsx`), regression test in `Workspace.test.tsx` (fails without the fix).

## 2. Independent security review (GPT-6-Astra, read-only) + Opus final authority
Report: `.ai-jobs/gpt-p7-security.log`. Opus verified every finding in the code before fixing it.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| P7-S1 | HIGH | Diff views ran a repository's `diff.<driver>.textconv` program | **Fixed**: `git()` adds `--no-ext-diff --no-textconv` to every `diff`/`show`, and `-c core.fsmonitor=false` to every call |
| P7-S2 | HIGH | Session discard removed the worktree after a failed WIP save (R7 regression) | **Fixed**: `saveWip` reports failure; discard answers 409 and keeps the worktree |
| P7-S3 | HIGH | An in-root symlink (`public.txt` → `private.pem`) bypassed the sensitive-file check | **Fixed**: `isSensitiveTarget` checks the canonical target too (file reads, session diff). Test skips on this PC (file symlinks need Developer Mode) |
| P7-S4 | HIGH | `.npmrc`, `credentials.json`, `.git-credentials`, … not treated as sensitive | **Fixed**: credential names + `.ssh/.aws/.gnupg` folders in `isSensitivePath` (reads, import copy, commits, diffs) |
| P7-S5 | MEDIUM | A malformed `asf-findings` block (or FAIL with nothing parsed) closed earlier findings as fixed | **Fixed**: `parseFindingsReport` flags malformed; such replies keep earlier findings and emit `findings.error` |
| P7-S6 | HIGH | Custom workflows: a Security node not keyed `security-review` skipped the final test barrier (R3) | **Fixed**: every `security` task runs the project tests on the integrated code first |
| P7-S7 | MEDIUM | File/diff reads loaded whole files before applying limits | **Fixed**: `readHead` reads at most the limit; session diff checks sizes first and stops at the 300 KB budget |
| P7-S8 | MEDIUM | Workflow tool nodes may run `npm install`/`npm ci` (package lifecycle scripts) without extra approval | **Owner decision** (project trust / `--ignore-scripts`, follow-up S3 of Phase 0b) — not changed |
| P7-S9 | MEDIUM | An audit PASS stayed valid after later code changes in the same run | **Fixed**: the gate is `not_run` when an `implement` task finished after the audit |

Residual (noted, not fixed): git `filter.<name>.clean/smudge` drivers from an imported repository's own config still
run on `git add`/`status`; only an owner-imported repository can carry them (same trust question as P7-S8).
Tests: `server/test/security-p7.test.ts` (written by GPT-6.1-Sol, reviewed by Opus; 7 pass, S3 skips here).

## 3. Performance (vs PERFORMANCE_BASELINE.md targets)
Measured by `e2e/perf.spec.ts` (temp data) and `scripts/migration-rehearsal.mts` (copy of the real V1 DB, 8 projects).

| Metric | V1 | Target | V2 measured | |
|---|---|---|---|---|
| Initial JS on Home (gzip) | 245 KB | ≤ 160 KB | 116 KB (index 109 KB + Home chunks) | ✅ |
| Server working set | 98 MB | ≤ 150 MB | 123 MB RSS (E2E server, idle) | ✅ |
| Idle browser heap (Home) | 11 MB | ≤ 40 MB | 6 MB | ✅ |
| `/api/v2/overview` (warm) | — | ≤ 300 ms | 8–12 ms (real DB copy) | ✅ |
| Workspace with 8 panels, 0 running | — | 0 processes | 0 | ✅ |
| Largest routine payload | 725 KB | ≤ 150 KB | 701 KB `/api/projects/:id` (V1 snapshot, still loaded for the current project); `/api/v2/events?limit=200` 258 KB | ❌ open |
| `/api/v2/overview` first call after start | — | — | ~3 s (provider detection runs once) | note |

## 4. Migration rehearsal (real V1 DB copy, scheduler off)
`node node_modules/tsx/dist/cli.mjs scripts/migration-rehearsal.mts "<V1>/data/studio.db"`: VACUUM INTO a temp dir,
open with V2 code without recovery/scheduler. Result: schema 2 → 5, projects 8/8, tasks 88/88, 0 tasks without run,
7 runs, events 2,652/2,652, `foreign_key_check` clean, `integrity_check` ok, backup `studio-before-v5.db` written —
**REHEARSAL OK** (third pass).

## 5. Rollback drill
`node node_modules/tsx/dist/cli.mjs scripts/rollback-drill.mts "<V1>/data/studio.db" "<V1 checkout>"`: V2 migrates a
copy (2 → 5, backup written), the backup is restored into a fresh data dir and opened with the **V1 code** of the
`main` checkout: schema 2, 8/8 projects, project snapshot 200 — **ROLLBACK DRILL OK**. The V1 checkout and its data
were only read (`git status` clean afterwards).

## 6. Windows launch guide
See `docs/v2/WINDOWS_LAUNCH.md`.

## 7. Still open after Phase 7
- Owner: merge `feature/v2-studio` → `main`, tag `v2.0.0`, cut-over (MIGRATION_PLAN step D); restart V1 so Phase 0b
  applies (until the cut-over); Phase 3c PTY terminal (D-019); P7-S8 project trust for package install scripts.
- Payload target: replace the V1 project snapshot in the V2 shell with summary endpoints (largest 701 KB), lower the
  Logs page size or trim event payloads.
- Earlier open items in `CURRENT_STATE.md` (Runs page, Files tab, events index, coverage scanner).
