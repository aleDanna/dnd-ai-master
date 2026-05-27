---
phase: 03-migration-cutover
plan: C-03
subsystem: database

tags:
  - drizzle
  - postgres
  - pgvector
  - migration
  - rag-decommission

requires:
  - phase: 03-C-02
    provides: All RAG TypeScript callers removed (src/ai/master/rag/, build-rag-index, useRagRetrieval prefs, ragChunkCount column reference)
provides:
  - 0039_drop_pgvector migration that drops the rag_chunks table, the rag_chunk_count column on ai_usage, and the pgvector extension in the order required by Pitfall 5
  - src/db/schema/rag-chunks.ts is deleted; barrel export removed; drizzle-kit snapshot 0039 is consistent with the trimmed TS schema
affects:
  - 03-C-06 operator playbook (DB cutover step references this migration)
  - All future Phase 03+ DB schema changes (snapshot baseline shifted)

tech-stack:
  added: []
  patterns:
    - "Hand-written drop migration: drizzle-kit emits CASCADE drops but never DROPs PG extensions — for extension teardown we hand-write the SQL while letting drizzle-kit own the snapshot diff"
    - "Ordered DROP for pgvector: INDEX → TABLE → COLUMN → EXTENSION; every statement IF EXISTS for idempotency"

key-files:
  created:
    - drizzle/0039_drop_pgvector.sql
    - drizzle/meta/0039_snapshot.json
  modified:
    - drizzle/meta/_journal.json
    - src/db/schema/index.ts
  deleted:
    - src/db/schema/rag-chunks.ts

key-decisions:
  - "Hand-write the SQL but let drizzle-kit own the snapshot: ran `pnpm db:generate` after deleting the schema TS so drizzle-kit produced an accurate snapshot diff, then overwrote the auto-generated SQL file with the ordered DROP per Pitfall 5"
  - "Included `ALTER TABLE ai_usage DROP COLUMN rag_chunk_count` in the same migration: the column was removed from the schema TS in Wave 7 (03-C-02 5fc6deb) but the column still exists in the live DB — closing the snapshot drift here keeps the rag teardown atomic"
  - "Did NOT execute `pnpm db:migrate` against the configured DATABASE_URL because it points to the Supabase pooler (PROD). Per contract, the migration runs at the next `pnpm dev` boot via src/db/migrate.ts. Verification used `pnpm db:generate` → 'No schema changes' to confirm snapshot/SQL consistency"

patterns-established:
  - "PG extension teardown ordering: when an extension defines types that columns use, the DROP order MUST be index → table (or column) → extension; auto-generators only see table/column changes and will silently leak the extension"

requirements-completed: [REQ-033]

duration: 4min
completed: 2026-05-28
---

# Phase 03 Plan C-03: Drop pgvector Migration Summary

**Hand-written migration `0039_drop_pgvector` enforces the INDEX → TABLE → COLUMN → EXTENSION drop order required to safely remove pgvector while pgvector-typed columns still exist on disk (Pitfall 5).**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-27T22:29:59Z
- **Completed:** 2026-05-27T22:34:56Z
- **Tasks:** 3 (2 commit-bearing, 1 verification-only per contract carve-out)
- **Files modified:** 2 created, 2 modified, 1 deleted

## Accomplishments

- Hand-written `drizzle/0039_drop_pgvector.sql` with the ordered DROPs required by Pitfall 5; every statement is `IF EXISTS` so the migration is idempotent and safe to re-run after partial failure.
- Generated correct snapshot via `pnpm db:generate` after deleting `src/db/schema/rag-chunks.ts` — drizzle-kit's emitted `0039_*.sql` (which used `DROP TABLE CASCADE` and would have leaked the pgvector extension) was replaced by the hand-written ordered version while keeping the auto-generated `_journal.json` entry + `0039_snapshot.json`.
- Deleted `src/db/schema/rag-chunks.ts` and removed `export * from './rag-chunks'` from the barrel; `pnpm typecheck` exits 0; `pnpm db:generate` reports "No schema changes" confirming the snapshot ↔ TS schema are consistent.

## Task Commits

1. **Task 1: Hand-write 0039_drop_pgvector.sql** — `c3b5171` (chore: add migration SQL + journal entry)
2. **Task 2: Delete rag_chunks schema + barrel** — `e074cbc` (chore: schema TS + barrel + drizzle-kit snapshot)
3. **Task 3: Apply migration locally + verify** — no commit (verification-only per contract — see Deviations)

**Plan metadata commit:** added after this SUMMARY.md is finalized.

## Files Created/Modified

- `drizzle/0039_drop_pgvector.sql` — 19-line hand-written migration: DROP INDEX rag_chunks_embedding_idx + rag_chunks_source_hash_idx → DROP TABLE rag_chunks → ALTER TABLE ai_usage DROP COLUMN rag_chunk_count → DROP EXTENSION vector, all `IF EXISTS`.
- `drizzle/meta/0039_snapshot.json` — drizzle-kit-generated snapshot reflecting schema after rag_chunks deletion (3302 lines, down 78 from 0038).
- `drizzle/meta/_journal.json` — appended idx 39 entry with tag `0039_drop_pgvector` (renamed from auto-generated `0039_keen_kitty_pryde`).
- `src/db/schema/index.ts` — removed `export * from './rag-chunks';` from barrel.
- `src/db/schema/rag-chunks.ts` — deleted; held `ragChunks` table + `customType<vector>` definition that was the last in-source pgvector reference.

## Decisions Made

- **Auto-generate then hand-edit the SQL** (vs pure hand-write from scratch): deleted the schema TS first so drizzle-kit could compute the correct snapshot diff + journal entry. Then overwrote ONLY the SQL file with the ordered DROP per Pitfall 5. This gives us a guaranteed-correct snapshot (drizzle-kit owns the table/column schema state) AND a guaranteed-correct DROP order + extension teardown (we own the SQL).
- **Included the `ai_usage.rag_chunk_count` DROP COLUMN in the same migration:** the column was removed from `ai-usage.ts` in Wave 7 (commit 018068d) but the live DB column was deferred per plan 03-C-02. Bundling the drop here keeps the rag teardown atomic — a single migration removes all of: index, table, lingering column, extension.
- **Renamed the auto-generated SQL filename:** drizzle-kit emitted `0039_keen_kitty_pryde.sql` (its random-codename convention); renamed to `0039_drop_pgvector.sql` for readability and updated the corresponding `_journal.json` tag to match.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added DROP COLUMN ai_usage.rag_chunk_count to migration**
- **Found during:** Task 1 (hand-writing the SQL)
- **Issue:** The plan's example SQL only dropped index + table + extension, but the schema TS in Wave 7 (commit 018068d) already removed `rag_chunk_count` from `src/db/schema/ai-usage.ts` while leaving the column physically present on the DB. The drizzle-kit snapshot 0038 still had it. Without dropping the column, the next `pnpm db:generate` would have produced a competing migration AND the contract explicitly required this drop ("ALTER TABLE ai_usage DROP COLUMN rag_chunk_count" — phase_context).
- **Fix:** Added `ALTER TABLE "ai_usage" DROP COLUMN IF EXISTS "rag_chunk_count";` as step 3 in the migration, between the table drop and the extension drop. Order is safe because the column is `integer`, not `vector` — its position between TABLE and EXTENSION is semantically correct without affecting Pitfall 5 (the extension drop is gated by the vector-typed column on rag_chunks.embedding, which is already gone by step 2).
- **Files modified:** drizzle/0039_drop_pgvector.sql
- **Verification:** `pnpm db:generate` (post-commit) reports "No schema changes, nothing to migrate" — confirming snapshot 0039 + TS schema + SQL migration are all consistent on the rag_chunk_count axis.
- **Committed in:** c3b5171 (Task 1)

### Skipped Tasks (contract carve-out)

**1. Task 3 verification: did NOT run `pnpm db:migrate`**
- **Reason:** Contract explicitly stated: "DO NOT run the migration against prod DB from this task — just generate the SQL via `pnpm db:generate` (drizzle picks up the schema changes from Wave 7 and emits the migration). The migration runs at next `pnpm dev` boot via src/db/migrate.ts." The configured `DATABASE_URL` in `.env.local` points to the Supabase pooler (production), so running the migration here would have applied the destructive DROPs to the live DB outside the operator cutover window.
- **Alternative verification performed:**
  - `pnpm db:generate` → "No schema changes, nothing to migrate" (snapshot ↔ schema consistent)
  - `pnpm typecheck` → exits 0 (no orphaned references)
  - SQL parsed by hand: 5 statements, all `IF EXISTS`, ordered per Pitfall 5
- **Deferred to:** Next operator-run `pnpm db:migrate` (post-cutover playbook 03-C-06)

---

**Total deviations:** 1 auto-fixed (Rule 2 — added DROP COLUMN), 1 task skipped (contract carve-out)
**Impact on plan:** Auto-fix was necessary for atomicity: without it the snapshot would diverge from the SQL and the next executor would have hit a phantom migration. Task 3 skip is fully expected per contract — verification is functionally complete via `db:generate` + `typecheck`.

## Issues Encountered

None. Wave 8 parallel execution: noticed untracked files from sibling agents (`docs/operators/phase-03-cutover.md` from 03-C-06, `tests/scripts/migrate-stale-userprefs.test.ts` from 03-C-05, plus a pre-existing `src/sessions/use-turn-stream.ts`) — left alone per the destructive-git-prohibition rule (files outside my scope).

## User Setup Required

None - the only deployment step is operator-run `pnpm db:migrate` which is documented in the 03-C-06 operator playbook.

## Next Phase Readiness

- The rag/pgvector decommission is now complete on the schema + migration tier. `0039_drop_pgvector` is queued to apply at the next `pnpm db:migrate` invocation.
- The operator playbook (03-C-06, parallel) references this migration as the DB-side cutover step.
- After successful production migration, REQ-033 closes out the RAG decommission (the rag/pgvector code, prefs, telemetry, schema, and tables will all be gone).

## Self-Check: PASSED

Verified all claims:
- `drizzle/0039_drop_pgvector.sql` exists (19 lines, ordered DROPs, all IF EXISTS)
- `drizzle/meta/0039_snapshot.json` exists (3302 lines, 0 rag references, prevId links to 0038)
- `drizzle/meta/_journal.json` has entry idx 39 with tag `0039_drop_pgvector`
- `src/db/schema/rag-chunks.ts` is deleted (confirmed via `! test -f`)
- `src/db/schema/index.ts` has no `rag-chunks` export
- Commits `c3b5171` and `e074cbc` exist on main
- `pnpm typecheck` exits 0
- `pnpm db:generate` reports "No schema changes" (snapshot/schema consistent)

---
*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
