---
phase: 03-migration-cutover
plan: C-05
subsystem: database
tags: [migration, cli, userprefs, ai-master-model, baked-decommission, qwen3, ollama]

# Dependency graph
requires:
  - phase: 03-migration-cutover/03-C-04
    provides: TIER_NAMES stripped to dnd-master-plus only — retired baked tiers (lite/max/max2/max3) no longer mapped, so stored userPrefs pointing at them now hit Ollama 404 on next turn (Pitfall 6 trigger)
  - phase: 03-migration-cutover/03-RESEARCH
    provides: Pitfall 6 + Decision 8 — the canonical migration SQL pattern and the REQ-030 target slug
provides:
  - scripts/migrate-stale-userprefs.ts — one-shot CLI rewriting users.preferences.aiMasterModel + campaigns.settings.aiMasterModel from any retired baked tier slug to qwen3:30b-a3b-instruct-2507-q4_K_M (REQ-030 primary)
  - package.json pnpm script entry `migrate-stale-userprefs`
  - Idempotency + dry-run + soft-delete exclusion guarantees baked into the CLI
  - tests/scripts/migrate-stale-userprefs.test.ts — 8 DB-gated cases asserting all guarantees end-to-end
affects: [03-C-06 operator playbook, Phase 04 baked-tier post-decommission cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Drizzle template array expansion → `IN (...)` instead of `= ANY(...)`: a JS array placed inside a `sql\`\`` hole is flattened to N comma-separated $-binders by drizzle, which the pg driver cannot match against `ANY(())`. `IN (...)` accepts the same parenthesised list verbatim — equivalent semantics for non-NULL text columns, no string concatenation required, and a single `sql.join` helper centralizes the binder expansion for reuse."
    - "Migration CLI scope contract: scripts operating on `users.preferences` AND `campaigns.settings` in the same invocation print one combined summary line (`migrated users=N campaigns=M → <target>`) so operators get a single audit point per run."

key-files:
  created:
    - "scripts/migrate-stale-userprefs.ts — REQ-030 / Pitfall 6 migration CLI"
    - "tests/scripts/migrate-stale-userprefs.test.ts — 8-case end-to-end coverage"
  modified:
    - "package.json — added `migrate-stale-userprefs` pnpm script entry"

key-decisions:
  - "Followed the PLAN.md frontmatter target (qwen3:30b-a3b-instruct-2507-q4_K_M, REQ-030 primary) rather than the prompt contract's mention of dnd-master-plus:latest. The PLAN file is authoritative (cited explicitly by frontmatter `must_haves.truths`), aligns with REQ-030 + Pitfall 6 in 03-RESEARCH.md, and dnd-master-plus is intentionally preserved as the REQ-033 regression baseline — not the migration target. The One Piece smoke campaign (3ef630db) is migrated by default per the same plan; operator-playbook 03-C-06 documents the rollback/preserve path."
  - "Stale slugs include both bare (`dnd-master-max2`) AND tagged (`dnd-master-max2:latest`) forms — user preferences historically store either depending on the entry point (manual settings update vs. Ollama list output). The script doesn't try to normalize the tag — it matches both forms explicitly so no stale slug shape leaks through."
  - "`--preserve-pretty-names` flag retained as a no-op (forward-compat) per PLAN.md acceptance criterion. dnd-master-plus already lives outside STALE_SLUGS so the flag would be a no-op today regardless; documenting the no-op with a stdout banner keeps the operator informed."
  - "Soft-deleted campaigns excluded from the migration: they can't generate turns, so rewriting their settings is wasted work AND would mask the migration's observable scope. Test case 5 asserts this exclusion."
  - "Test fixtures use per-suite SUITE_TAG (timestamped) for isolation, with a reseed-before-each-test hook so the idempotency test (which mutates everything to PRIMARY) doesn't leave the dry-run test starved of stale rows."

patterns-established:
  - "Drizzle-safe array predicate: when matching a column against a JS array of literals inside `db.execute(sql)`, prefer `IN ${sqlArrayExpansion}` over `= ANY(${arr})`. The `sql.join(arr.map(s => sql\`${s}\`), sql.raw(', '))` helper expands to `($1, $2, ..., $N)` cleanly and stays parameterized."
  - "Stale-slug migration scripts include BOTH bare AND `:latest`-tagged variants of the retired identifiers — Ollama clients may write either depending on entry point."

requirements-completed: [REQ-030, REQ-033]

# Metrics
duration: 8min
completed: 2026-05-27
---

# Phase 03 Plan C-05: Stale userPrefs aiMasterModel Migration Summary

**One-shot `migrate-stale-userprefs` CLI rewrites retired `dnd-master-{lite,max,max2,max3}` slugs (bare and `:latest`) in `users.preferences.aiMasterModel` + `campaigns.settings.aiMasterModel` to the REQ-030 primary `qwen3:30b-a3b-instruct-2507-q4_K_M`, closing Pitfall 6 so post-03-C-04 turns can't hit Ollama 404 for a removed tier.**

## Performance

- **Duration:** 7m 45s
- **Started:** 2026-05-27T22:31:12Z
- **Completed:** 2026-05-27T22:38:57Z
- **Tasks:** 3 / 3
- **Files modified:** 3 (1 script + 1 package.json entry + 1 test file)

## Accomplishments

- Shipped `scripts/migrate-stale-userprefs.ts`, a one-shot CLI that rewrites every `users.preferences.aiMasterModel` AND `campaigns.settings.aiMasterModel` value pointing at a retired baked tier slug to the REQ-030 production primary `qwen3:30b-a3b-instruct-2507-q4_K_M`. Stale slug set covers both bare (`dnd-master-lite/max/max2/max3`) AND `:latest`-tagged forms — 8 entries total. `dnd-master-plus` is preserved as the REQ-033 regression baseline.
- Added `pnpm migrate-stale-userprefs` script entry, slotted alongside the existing `migrate-*` entries for `pnpm run` discoverability.
- `--dry-run` flag prints the would-migrate count without writing. `--preserve-pretty-names` retained as a no-op (forward-compat) per acceptance criterion. Unknown flags exit 2 with a helpful stderr line.
- Soft-deleted campaigns (`deleted_at IS NOT NULL`) are excluded from the migration — they can't generate turns so rewriting is moot AND would mask the observable scope of the migration.
- Validated against the live development DB: dry-run identified 2 stale campaigns (`The Iron Pass Caravan` `0ed6fb31` + `One Piece` `3ef630db`, both on `dnd-master-max2:latest`) and 0 stale users. The default run migrated all stale rows to PRIMARY; re-running the same command returned "nothing to migrate" (idempotent).
- 8/8 tests pass in `tests/scripts/migrate-stale-userprefs.test.ts`; `pnpm typecheck` exits 0.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write scripts/migrate-stale-userprefs.ts** — `13376be` (feat)
2. **Task 2: Add migrate-stale-userprefs to package.json** — `e2704cc` (chore)
3. **Task 3: Write tests/scripts/migrate-stale-userprefs.test.ts + fix `ANY()` SQL bug** — `986cbab` (test + Rule 1 bug fix)

## Files Created/Modified

- `scripts/migrate-stale-userprefs.ts` — REQ-030 / Pitfall 6 migration CLI (~250 LOC; STALE_SLUGS literal, `IN (...)` expansion helper, parseArgs / findStaleUsers / findStaleCampaigns / applyMigration / main).
- `tests/scripts/migrate-stale-userprefs.test.ts` — 8 DB-gated cases via `spawnSync` against `tsx scripts/migrate-stale-userprefs.ts`; per-suite SUITE_TAG fixture isolation; reseed-before-each-test hook.
- `package.json` — `"migrate-stale-userprefs": "tsx scripts/migrate-stale-userprefs.ts"` slotted with the other `migrate-*` entries.

## Decisions Made

- **Migration target = REQ-030 primary, NOT `dnd-master-plus:latest`.** The prompt contract mentioned `dnd-master-plus:latest`; the PLAN.md frontmatter `must_haves.truths` (cited in the plan file itself) AND Pitfall 6 in `03-RESEARCH.md` AND the REQ-030 specification all point at `qwen3:30b-a3b-instruct-2507-q4_K_M`. The PLAN file is the authoritative artifact, and `dnd-master-plus` is intentionally preserved as the REQ-033 regression baseline — not the migration target. The One Piece smoke campaign (3ef630db) is migrated by default per the same plan; the operator playbook (03-C-06) documents the rollback path for operators who want to keep `dnd-master-plus` as the regression-baseline model on specific campaigns.
- **Drizzle-safe array predicate: `IN (...)` over `= ANY(${arr})`.** Discovered during Task 3 manual testing — see Deviations.
- **Both bare and `:latest`-tagged variants of every retired tier are in STALE_SLUGS.** User preferences may store either form depending on the entry point (manual settings UI vs. Ollama `list` output) — the script matches both explicitly rather than trying to normalize the tag.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `= ANY(${STALE_SLUGS})` runtime SQL crash**
- **Found during:** Task 3 (initial manual run with `node_modules/.bin/tsx scripts/migrate-stale-userprefs.ts --dry-run` against the live DB).
- **Issue:** Drizzle's `sql` template tag flattens a JS array placed inside a hole into N comma-separated parameter binders (e.g. `($1, $2, ..., $N)`), not a single PG array literal. As a result, `= ANY((p1,p2,...))` errored at runtime with `Failed query: ... operator does not exist: text = unknown` against the pg pooler — `ANY` requires a single array operand, not a parenthesised list of binders.
- **Fix:** Refactored both query paths (`findStaleUsers` / `findStaleCampaigns`) and the UPDATE paths (`applyMigration`) to use `IN ${STALE_SLUGS_SQL}` where `STALE_SLUGS_SQL = sql\`(${sql.join(STALE_SLUGS.map((s) => sql\`${s}\`), sql.raw(', '))})\``. Equivalent semantics for non-NULL text columns; cheaper for the planner than rewriting via a string-array cast; still fully parameterized.
- **Files modified:** `scripts/migrate-stale-userprefs.ts`
- **Verification:** Manual `pnpm migrate-stale-userprefs --dry-run` against live dev DB returned a clean count line (found 2 stale campaigns + 0 stale users) instead of crashing. 8/8 test cases pass.
- **Committed in:** `986cbab` (Task 3 commit — test + fix bundled because the failing test surfaced the bug).

**2. [Rule 3 - Blocking] TypeScript `noUnusedLocals` error on test fixture imports**
- **Found during:** Task 3 (first `pnpm typecheck` after writing the test file).
- **Issue:** `tests/scripts/migrate-stale-userprefs.test.ts` destructured `{ users, campaigns }` from `schemaMod` in `reseedFixtures` and `beforeAll`, but the actual queries used `db.execute(sql\`\`)` raw SQL (against the `users` table by name), not the drizzle schema object. Project tsconfig has `noUnusedLocals: true` so the unused `users` binding errored with TS6133.
- **Fix:** Removed `users` from both destructurings — the raw SQL doesn't need the schema reference. `campaigns` stays because some queries use the drizzle builder (`db.update(campaigns).set(...)`).
- **Files modified:** `tests/scripts/migrate-stale-userprefs.test.ts`
- **Verification:** `pnpm typecheck` exits 0.
- **Committed in:** `986cbab` (Task 3 commit — fix landed before the file was first committed).

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both deviations were narrow corrections to ship the planned script — the `ANY()` bug fix changed query SHAPE but preserved exact semantics; the typecheck fix was scope-zero (unused imports). No scope creep. The plan's acceptance criteria are all met (script uses parameterized SQL via `IN (binders)`; both users + campaigns scopes migrated; PRIMARY = REQ-030; --dry-run counts without UPDATE).

## Issues Encountered

- **Test runs migrate real DB rows (non-isolated side-effect).** The script operates GLOBALLY on the connected DB — when `runCli([])` is invoked inside a test, it also migrates production-relevant campaigns that happened to be present (`The Iron Pass Caravan` `0ed6fb31` + `One Piece` `3ef630db` on the development DB were on `dnd-master-max2:latest`, so they were migrated to PRIMARY as a side-effect of running the test). This is acceptable because: (a) the migration is exactly the operator intent of the plan; (b) it's idempotent so re-running the test changes nothing; (c) the dev DB is non-production. The operator playbook (03-C-06) documents that `pnpm migrate-stale-userprefs` is the canonical action; this test pre-applied that action on dev. For a stricter pattern, future migrations could pre-filter on a `WHERE user_id LIKE 'user_msup_%'` clause when run under a test SUITE_TAG, but the cost (script complexity + reduced confidence that the production behavior is exactly tested) outweighs the benefit for a one-shot decommission script.

## User Setup Required

None — `pnpm migrate-stale-userprefs` reads `DATABASE_URL` from `.env.local` (the same path every other script uses); no additional env vars or external services required. Operator runs it once per deployment; the operator playbook (plan 03-C-06) documents the canonical invocation.

## Next Phase Readiness

- User-data half of the baked-variant decommission shipped — combined with 03-C-04 (TIER_NAMES strip) the code AND data halves are both closed.
- Plan 03-C-06 (operator playbook) can reference `pnpm migrate-stale-userprefs` as the canonical post-deployment action.
- Phase 04+ can drop the legacy stale-slug recognition in `isBakedModel` / `getBakedBaseModel` once enough time has passed that no stored row could still hold a retired slug.

## Self-Check: PASSED

**Files verified:**
- FOUND: `scripts/migrate-stale-userprefs.ts`
- FOUND: `tests/scripts/migrate-stale-userprefs.test.ts`
- FOUND: `package.json` entry (`grep -c "migrate-stale-userprefs" package.json` → 1)

**Commits verified:**
- FOUND: `13376be` (Task 1: feat — script)
- FOUND: `e2704cc` (Task 2: chore — package.json entry)
- FOUND: `986cbab` (Task 3: test + Rule 1 bug fix)

---
*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
