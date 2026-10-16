# V2 — Current state

Last updated: 2026-10-17 ~02:20 (Opus 5.5, account 1, automated night run asf-v2-continue-0030).

## Owner report (Uzbek)

**Nima qilindi (2026-10-17, 00:30–02:20, avtomatik tungi ish):**
- Phase 3 gate'lari qayta tekshirildi: hammasi yashil.
- **Phase 4 — Workflow Builder + run'lar.** `runs` va `workflows` jadvallari qo'shildi, vazifalar har bir run'ga
  bog'landi. Workflow kompilyatori yozildi: Standard shablon V1 bilan bir xil vazifalarni chiqaradi (golden test). Bitta
  loyihada bir nechta run ishlatish mumkin. Builder sahifasi (`#/builder`) ishlaydi: canvas, palitra, inspector,
  validate/simulate/run, autosave, import/export, run tarixi.
- **Phase 5 — Projects, Tasks, Repos.** Tasks sahifasida Kanban, ro'yxat, filtrlar va vazifa drawer'i bor (git diff
  ham). Loyiha sahifasi (`#/projects/:id`) tablari bilan tayyor. Repos sahifasi faqat o'qiydi: branch'lar,
  ahead/behind, worktree'lar, wip commit'lar, konfliktlar.
- **Phase 6 — QA & Security, Logs, Models.** Security/review agentlarining topilmalari saqlanadi va fix task yaratsa
  bo'ladi. Release gate'larida "Not run" hech qachon yashil ko'rinmaydi. `npm audit` faqat sizning tasdig'ingiz bilan
  ishlaydi. Logs'da server tomonidagi filtrlar, live tail va eksport bor. Models'ga Usage va Fallback tab'lari qo'shildi.
- Haqiqiy V1 bazasining nusxasida migratsiya tekshirildi (v2 → v5): 88 ta vazifadan 88 tasi saqlandi, 7 ta run
  yaratildi, foreign key xatosi yo'q.
- Topib tuzatilgan haqiqiy xato: ikkinchi run'da task branch nomlari birinchi run'niki bilan to'qnashardi. Endi run 2
  dan boshlab nom `r<N>-` bilan boshlanadi; regression test qo'shildi.

**Commit'lar** (`feature/v2-studio`, push qilinmagan, main'ga merge qilinmagan): `68b471b` (Phase 4 A),
`16603af` (Phase 4), `a0a996f` (Phase 5), `7859975` (Phase 6).

**Testlar:** server 228 ta, web 486 ta — hammasi o'tdi; typecheck va build yashil.

**Kim nima qildi:**
- Opus 5.5, akk1 (men): reja, umumiy tiplar kontrakti, review, tuzatishlar, route ulash, WF-03/WF-04 va regression
  testlari, migratsiya sinovi.
- akk4 (Opus 5.5): p4-db, p4-compiler. akk4 (Sonnet 5.5): p4-ui-state.
- Phase 4 B-batch akk4 da limit tugagani uchun uzildi va akk5 da qayta ishga tushirildi.
- akk5 (Opus 5.5): p4-scoping, p4-runservice, p5-server, p6-findings, p6-quality-api.
- akk5 (Sonnet 5.5): p4-canvas, p4-page, p5-tasks-ui, p5-projects-ui, p6-logs-usage-server, p6-quality-ui,
  p6-logs-ui, p6-models-ui.
- GPT/Gemini ishlatilmadi.

**Limitlar (02:20):**
- akk1: 5 soatlik oyna 24 %, haftalik 71 %.
- akk4: sessiya limiti tugagan, ~03:20 da tiklanadi.
- akk5: ishlatildi, oxirgi ishlar muvaffaqiyatli tugadi.

**Siz qilishingiz kerak (meni kutayotgan ishlar):**
1. Brauzerda tekshiruv. Avtomatik ishda V2 preview serverini ishga tushirishga ruxsat berilmadi. `start-v2-dev.cmd`
   ni oching va Workspace, Builder, Tasks, QA sahifalarini ko'ring.
2. Phase 3c (PTY terminal) — tasdig'ingiz kerak (D-019).
3. Phase 7 (barqarorlashtirish, E2E, mustaqil review) va keyin main'ga merge — sizning ruxsatingiz bilan.

**Keyingi qadam:** Phase 7 — Playwright E2E, mustaqil security review, haqiqiy V1 bazasi nusxasida yakuniy sinov.

## Where we are
- **V2 work happens here**: worktree `D:\jarvis 2\asf-v2`, branch `feature/v2-studio`. Run it with `start-v2-dev.cmd`
  (API http://127.0.0.1:4327, web http://127.0.0.1:5327, own `data/`). V1 stays in
  `D:\jarvis 2\ai-software-factory-studio` on port 4317 (untouched). Desktop preview entries `asf-v2-api` / `asf-v2-web`
  are in `D:\jarvis 2\.claude\launch.json`.
- `main`: `5354c5c` V1 baseline (tag `v1.0.0`) → `fc615d2` Phase 0b hardening.
- Branch history: Phases 1–2 (`bcdc5f4`, `8d6c719`), Phase 3 (`6bd11bf`, `53cfc1d`, `78480e3`), Phase 4 (`68b471b`,
  `16603af`), Phase 5 (`a0a996f`), Phase 6 (`7859975`).
- **Phases 0–6 are done** (except 3c PTY = owner decision). Phase plans and Opus decisions: `docs/v2/phases/PHASE_4.md`
  (P4-1..P4-7 also in DECISIONS.md), `PHASE_5.md` (P5-1..P5-4), `PHASE_6.md` (P6-1..P6-8).
- Schema: migrations index 0–4 (`schema_version` 5): v4 = workflows/runs/tasks per run, v5 = findings. Rehearsed on a
  copy of the real V1 DB (88 tasks, 7 runs, FK clean); the runner writes `data/backups/studio-before-v<N>.db` first.
- Gates at `7859975`: `npm run typecheck`, `npm run build`, `npm test` (228 server + 486 web) green.
- Owner (2026-10-16 23:35): continue through the phases; commits on `feature/v2-studio` approved. Never: merge to `main`,
  push, restart V1, paid APIs, global installs.

## Open items / known gaps
- **Browser checks not done** for Phases 3–6 (the automated run's preview start was declined). Do them first in Phase 7.
- Runs page `#/runs` still maps to the V1 Monitor; run history is in the Builder's bottom panel and the Project detail
  Runs tab. A dedicated Runs page (UI spec §6) is not built.
- Project detail: no Files tab (V1 Files page is at `#/files`); Settings tab omits the trust flag (not on `Project`).
- Plan tab has no milestone grouping (P5-3: PM plan has no phase/epic fields).
- Coverage gate is always "not run" (no coverage scanner) → no run is "ready for release" yet (P6-2, honest by design).
- Skeleton slot `maxAttempts` from backend/frontend nodes is validated but not applied to PM tasks (compiler note).
- Repo overview caps branches at 300 without a "truncated" flag.
- Events table has no `created_at` index; add one if Logs gets slow on large DBs.
- Logs live tail matches run/session filters only when the SSE event carries `data.runId` / `data.sessionId`.
- Independent (non-Opus) review of Phases 4–6 not run yet — Opus reviewed the diffs; plan it in Phase 7.

## Follow-ups noted
- Verify whether Codex, Antigravity and Gemini CLIs load project-level config from a repository (S1 note).
- `npm install --ignore-scripts` for untrusted projects (S3).
- Risk: an empty argv value (`--setting-sources ""`) is rejected by the Windows .cmd bridge (R16); fine while Claude is
  `claude.exe` on this PC.

## Model order (owner, 2026-10-16)
Own Claude limit first up to 80 % of the 5-hour window → then Claude account 4 (`.ai-jobs/run-akk4.mjs`), account 5
(`CLAUDE_WORKER_ACCOUNT=5`), GPT via Codex (`--model … --only`), Gemini if it has quota. Nothing else.
