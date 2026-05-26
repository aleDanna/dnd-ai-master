---
phase: 03
plan: C-03
type: execute
wave: 8
depends_on: [03-C-02]
files_modified:
  - drizzle/XXXX_drop_pgvector.sql
  - src/db/schema/rag-chunks.ts
  - src/db/schema/index.ts
autonomous: true
requirements: [REQ-033]
must_haves:
  truths:
    - "drizzle/XXXX_drop_pgvector.sql exists with the migration in correct order: DROP INDEX → DROP TABLE → DROP EXTENSION (Pitfall 5)"
    - "src/db/schema/rag-chunks.ts is DELETED"
    - "src/db/schema/index.ts no longer exports from './rag-chunks'"
    - "`pnpm db:migrate` on a fresh local PG instance applies the migration successfully (no `cannot drop extension` error)"
    - "After migrate, `\\dx` in psql shows no `vector` extension; `\\dt rag_chunks` returns 'did not find any relation'"
    - "`pnpm typecheck` exits 0 (the schema deletion is consistent with the code deletion in plan 03-C-02)"
  artifacts:
    - path: "drizzle/XXXX_drop_pgvector.sql"
      provides: "Hand-written migration with ordered DROPs"
    - path: "src/db/schema/rag-chunks.ts"
      provides: "DELETED"
    - path: "src/db/schema/index.ts"
      provides: "barrel export removed"
  key_links:
    - from: "drizzle/XXXX_drop_pgvector.sql"
      to: "(removed) rag_chunks table + vector extension"
      via: "Ordered DROP per Pitfall 5"
      pattern: "DROP EXTENSION IF EXISTS vector"
---

# Plan 03-C-03: Drop pgvector Migration

**Phase:** 03-migration-cutover
**Wave:** 8 (depends on 03-C-02 — code references gone)
**Status:** Pending
**Estimated diff size:** ~30 LOC SQL + ~-50 LOC schema (deletion) / 3 files

## Goal

Per Decision 7 step 4 + Pitfall 5: drop the `rag_chunks` table + `vector` extension in the correct order. Pitfall 5 says `DROP EXTENSION vector` fails if any column still references the type — so the order MUST be DROP INDEX → DROP TABLE → DROP EXTENSION.

drizzle-kit's auto-generator MAY produce a valid ordering, BUT given the destructive nature, we HAND-WRITE the migration to be sure. Verify by running `pnpm db:migrate` on a fresh PG.

## Requirements satisfied

- **REQ-033** — Completes the RAG decommission (DB tier).

## Files touched

| File | Action | Why |
|---|---|---|
| `drizzle/XXXX_drop_pgvector.sql` | NEW (hand-written) | Ordered drop migration |
| `src/db/schema/rag-chunks.ts` | DELETE | Schema definition gone |
| `src/db/schema/index.ts` | EDIT | Remove barrel export |

## Tasks

<task type="auto">
  <name>Task 1: Hand-write drizzle/XXXX_drop_pgvector.sql</name>
  <files>drizzle/XXXX_drop_pgvector.sql</files>
  <read_first>
    - drizzle/ (the existing migration files — determine next sequence number)
    - drizzle/0034_cooing_morgan_stark.sql (or wherever pgvector was CREATEd; mirror the ordering)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§"Drizzle migration: pgvector drop" code example + Pitfall 5)
  </read_first>
  <action>
Find the NEXT migration number in `drizzle/`. Create a hand-written file `drizzle/00XX_drop_pgvector.sql` (X = next sequence). Content per the RESEARCH example:

```sql
-- Phase 03-C — drop pgvector RAG storage.
-- Ordered: DROP INDEX → DROP TABLE → DROP EXTENSION (Pitfall 5).
-- `IF EXISTS` everywhere so the migration is idempotent + re-runnable.

DROP INDEX IF EXISTS "rag_chunks_embedding_idx";
DROP INDEX IF EXISTS "rag_chunks_source_hash_idx";
DROP TABLE IF EXISTS "rag_chunks";
DROP EXTENSION IF EXISTS vector;
```

(If the actual index names differ from the assumption above, inspect `\d rag_chunks` in psql against current prod schema to confirm the index names. Update the SQL accordingly.)

Update `drizzle/meta/_journal.json` if Drizzle requires it — `pnpm db:generate` once after creating the SQL file may auto-emit the journal entry; OR the next `pnpm db:migrate` will reject the new file if the journal isn't updated. Check the existing pattern.

Hand-written migration is INTENTIONAL — drizzle-kit's auto-generator may emit the steps in the wrong order. Per Pitfall 5: the FK from `rag_chunks.embedding` (vector type) → vector extension means dropping the extension FIRST fails.
  </action>
  <verify>
    <automated>ls drizzle/*drop_pgvector*.sql && cat drizzle/*drop_pgvector*.sql</automated>
  </verify>
  <acceptance_criteria>
    - The migration file exists
    - The order is: DROP INDEX, DROP TABLE, DROP EXTENSION (verified by grep -n)
    - `IF EXISTS` on all 4 statements (idempotent)
    - drizzle/meta/_journal.json updated (if applicable)
  </acceptance_criteria>
  <done>
    Migration drafted. Task 2 applies it.
  </done>
</task>

<task type="auto">
  <name>Task 2: Delete src/db/schema/rag-chunks.ts + remove barrel export</name>
  <files>src/db/schema/rag-chunks.ts</files>
  <read_first>
    - src/db/schema/rag-chunks.ts (existing — confirm it's the only schema for this table)
    - src/db/schema/index.ts (existing barrel — find the export line)
  </read_first>
  <action>
Delete the schema file:
```
rm src/db/schema/rag-chunks.ts
```

Edit `src/db/schema/index.ts`: remove the line `export * from './rag-chunks';`.

The schema delete + barrel-export removal should not break `pnpm typecheck` BECAUSE plan 03-C-02 already removed all callers of `ragChunks`. Confirm with `grep -rn "ragChunks\\|rag_chunks" src/ tests/`.
  </action>
  <verify>
    <automated>! test -f src/db/schema/rag-chunks.ts && ! grep -q "rag-chunks" src/db/schema/index.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File deleted
    - Barrel export line gone
    - `pnpm typecheck` exits 0 (no orphaned references)
  </acceptance_criteria>
  <done>
    Schema cleanup complete.
  </done>
</task>

<task type="auto">
  <name>Task 3: Apply migration locally + verify</name>
  <files>(no files modified — verification only)</files>
  <read_first>
    - (none — verification)
  </read_first>
  <action>
Run the migration locally:
```
pnpm db:migrate
```

It should exit 0. Confirm in psql:
```
\dx                  -- should NOT list 'vector'
\dt rag_chunks       -- should return 'did not find any relation'
```

If the migration fails with `cannot drop extension vector because column X depends on it`, the order is wrong OR there's another consumer of vector that the audit missed. Investigate, adjust, retry.

After local verification, commit:
```
chore(phase-03-c): drop pgvector — DB tier RAG decommission
```

Production: the operator runs `pnpm db:migrate` on production AFTER the code deploys (plan 03-C-02 + 03-C-03 land together).
  </action>
  <verify>
    <automated>pnpm db:migrate</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm db:migrate` exits 0
    - psql `\dx` confirms vector extension is gone
    - psql `\dt rag_chunks` confirms table is gone
    - The migration is journaled (drizzle/meta/_journal.json has an entry for it)
  </acceptance_criteria>
  <done>
    DB tier RAG decommission complete.
  </done>
</task>
