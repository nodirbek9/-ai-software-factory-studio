# Migration Strategy — V1 → V2 (principles)

1. **V1 keeps running.** The owner's daily studio (`D:\jarvis 2\ai-software-factory-studio`, port 4317,
   `data/`) is never used as the V2 development environment. V2 lives on branch `feature/v2-studio` in the
   worktree `D:\jarvis 2\asf-v2`, ports 4327 (API) / 5327 (web dev), its own fresh `ASF_DATA_DIR` (D-001).
2. **Version control first.** `git init` + V1 baseline commit + tag `v1.0.0` (D-020, owner approval). The file
   backup `D:\jarvis 2\backups\asf-v1-2026-10-16\` stays as a second safety net.
3. **Fix V1's HIGH risks on `main` first** (Phase 0b) so both V1 and V2 start from a safer base; V2 branches
   from the hardened `main`.
4. **Strangler UI.** The V2 shell hosts the V1 pages unchanged, then replaces them one by one; a V1 feature is
   removed only after its V2 replacement passes the feature-parity check against `FEATURE_INVENTORY.md`.
5. **Additive API.** V1 routes stay; new behaviour lives under `/api/v2/*` (D-013). V1 routes are reviewed for
   removal only in Phase 7.
6. **Forward-only DB migrations with automatic backup.** Every migration step first writes
   `data/backups/studio-before-v<N>.db` with `VACUUM INTO` (D-018). The only non-additive step is the `tasks`
   rebuild (v3), done in one transaction with a foreign-key check.
7. **Never test migrations on the live DB.** V1 rows contain absolute paths into V1's `data/workspaces`; a V2
   instance pointed at a copy of the V1 DB with the scheduler on could run agents in V1's repositories.
   Migration tests run on a DB copy with `ASF_DISABLE_SCHEDULER=1` (new flag) and a temp data dir.
8. **Cut-over is a decision, not a side effect.** After Phase 7 acceptance and owner approval: stop V1 (no
   running agents), merge `feature/v2-studio` → `main`, start the merged studio on 4317 with the original
   `data/` (migrations run once, with backup). Rollback = stop, restore the backup DB, checkout `v1.0.0`.
9. **Every phase is shippable inside the V2 worktree**: tests, typecheck and build green; no half-features in
   the UI (planned items disabled with a reason).

## SUMMARY
Separate worktree, ports and data for V2; hardened V1 first; strangler UI; additive API; backed-up
forward-only migrations; migration tests only on copies with the scheduler off; explicit, reversible cut-over.
