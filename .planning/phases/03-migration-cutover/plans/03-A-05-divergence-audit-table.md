---
phase: 03
plan: A-05
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/schema/dual-write-divergences.ts
  - src/db/schema/index.ts
  - drizzle/XXXX_dual_write_divergences.sql
  - tests/db/dual-write-divergences.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "src/db/schema/dual-write-divergences.ts defines the dualWriteDivergences pgTable with columns: id (uuid pk), session_id (uuid FK to sessions ON DELETE CASCADE), campaign_id (uuid FK to campaigns ON DELETE CASCADE), character_id (uuid), event_type (text), vault_state (jsonb), postgres_state (jsonb), summary (text), created_at (timestamptz default now())"
    - "The dualWriteDivergences table has an index on (session_id, created_at DESC) for operator queries of recent divergences"
    - "The new schema module is exported from src/db/schema/index.ts so callers can import via @/db/schema"
    - "A drizzle migration file under drizzle/XXXX_dual_write_divergences.sql creates the table + index, and `pnpm db:migrate` applies it successfully"
    - "The schema type DualWriteDivergenceInsert is usable by plan 03-A-09 (DualWriter calls db.insert(dualWriteDivergences).values({...}))"
  artifacts:
    - path: "src/db/schema/dual-write-divergences.ts"
      provides: "Drizzle pgTable definition for the audit log"
      exports: ["dualWriteDivergences", "DualWriteDivergence", "DualWriteDivergenceInsert"]
    - path: "drizzle/XXXX_dual_write_divergences.sql"
      provides: "CREATE TABLE migration"
    - path: "src/db/schema/index.ts"
      provides: "Barrel export of dualWriteDivergences"
      contains: "dual-write-divergences"
  key_links:
    - from: "src/sessions/dual-writer.ts (plan 03-A-09)"
      to: "src/db/schema/dual-write-divergences.ts (this plan)"
      via: "DualWriter inserts a row when parity-check returns diverged"
      pattern: "dualWriteDivergences"
---

# Plan 03-A-05: Divergence Audit Table

**Phase:** 03-migration-cutover
**Wave:** 1 (no deps — pure schema work)
**Status:** Pending
**Estimated diff size:** ~60 LOC source + ~80 LOC tests / 4 files

## Goal

Ship the Postgres audit table that records every dual-write divergence. Per RESEARCH Decision 3, the table is queryable (operator can `SELECT * FROM dual_write_divergences WHERE created_at > now() - interval '24h'`), schema is minimal (8 columns), append-only, and indexed on (session_id, created_at DESC) for typical "show recent divergences for this session" operator queries.

Plan 03-A-09 (DualWriter) writes rows; the schema MUST land first so that plan can `import { dualWriteDivergences } from '@/db/schema'` without a forward-reference.

## Requirements satisfied

- **REQ-006** — Divergence audit is the safety net during dual-write coexistence; without the audit, divergence detection is invisible to the operator.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/db/schema/dual-write-divergences.ts` | NEW | drizzle pgTable + type exports |
| `src/db/schema/index.ts` | EDIT | Add barrel export |
| `drizzle/XXXX_dual_write_divergences.sql` | NEW (drizzle-generated + reviewed) | CREATE TABLE + INDEX |
| `tests/db/dual-write-divergences.test.ts` | NEW | Schema smoke test — insert + select round-trip |

## Tasks

<task type="auto">
  <name>Task 1: Define the dualWriteDivergences pgTable</name>
  <files>src/db/schema/dual-write-divergences.ts</files>
  <read_first>
    - src/db/schema/sessions.ts (existing — sessions pgTable; FK target)
    - src/db/schema/campaigns.ts (existing — campaigns pgTable; FK target)
    - src/db/schema/ai-usage.ts (existing — similar audit-style table with timestamptz + jsonb columns; mirror the column ordering style)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Decision 3 — schema spec)
  </read_first>
  <action>
Create `src/db/schema/dual-write-divergences.ts`:

```ts
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sessions } from './sessions';
import { campaigns } from './campaigns';

/**
 * Phase 03-A audit table — records every dual-write divergence detected
 * by the synchronous parity-check in `src/sessions/dual-writer.ts`.
 *
 * Append-only. NO updates. NO auto-correction. The operator inspects
 * divergence rows and remediates manually (compensating event via
 * `apply_event` OR `pnpm vault:rebuild-views --campaign=<uuid>`).
 *
 * Per RESEARCH Decision 3: the table is queryable; SELECT ... WHERE
 * created_at > now() - interval '24h' is the typical operator query.
 * Index on (session_id, created_at DESC) keeps that scan O(log N).
 *
 * Phase 03-C decommission does NOT touch this table — the divergence
 * audit log is a permanent record of the cutover window's
 * coexistence period (preserved for forensic value).
 */
export const dualWriteDivergences = pgTable(
  'dual_write_divergences',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** Character UUID. Nullable for session-level divergences (e.g., turn-state mismatch). */
    characterId: uuid('character_id'),
    /** The VaultEvent.type that triggered the divergence-check. NULL for resume-check (no event). */
    eventType: text('event_type'),
    /** Snapshot of the vault-side state at the moment of divergence (sorted JSON for stable diffs). */
    vaultState: jsonb('vault_state').$type<Record<string, unknown>>(),
    /** Snapshot of the Postgres-side state at the same moment. */
    postgresState: jsonb('postgres_state').$type<Record<string, unknown>>(),
    /** Human-readable one-line summary (e.g., "hp_current vault=20 postgres=15"). */
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('dual_write_divergences_session_idx').on(t.sessionId, t.createdAt.desc()),
  }),
);

export type DualWriteDivergence = typeof dualWriteDivergences.$inferSelect;
export type DualWriteDivergenceInsert = typeof dualWriteDivergences.$inferInsert;
```

Mirror Phase 02's pattern (e.g., the `vault-flip` script imports from `@/db/schema/campaigns` — same import structure).
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File exists at the specified path
    - `pnpm typecheck` exits 0
    - `grep -c "dualWriteDivergences" src/db/schema/dual-write-divergences.ts` returns ≥ 2 (pgTable definition + export)
    - The 8 columns specified in RESEARCH are all present: id, session_id, campaign_id, character_id, event_type, vault_state, postgres_state, summary, created_at
    - FK constraints on session_id + campaign_id use ON DELETE CASCADE
    - Index dual_write_divergences_session_idx exists on (session_id, created_at DESC)
  </acceptance_criteria>
  <done>
    Schema module defined.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add to barrel export src/db/schema/index.ts</name>
  <files>src/db/schema/index.ts</files>
  <read_first>
    - src/db/schema/index.ts (existing barrel — confirm the export pattern; likely `export * from './<file>';`)
  </read_first>
  <action>
Edit `src/db/schema/index.ts`. Add a line:

```ts
export * from './dual-write-divergences';
```

Place it in alphabetical order with the other exports (between `dice-log.ts` and `inventory-grants.ts` per the file listing).
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "dual-write-divergences" src/db/schema/index.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "dual-write-divergences" src/db/schema/index.ts` returns exactly 1
    - `node -e "const s = require('./src/db/schema'); console.log(typeof s.dualWriteDivergences);"` (or equivalent TS smoke) confirms the export is reachable — if the project doesn't allow direct require, skip this and rely on typecheck
  </acceptance_criteria>
  <done>
    Schema reachable via @/db/schema.
  </done>
</task>

<task type="auto">
  <name>Task 3: Generate + commit drizzle migration</name>
  <files>drizzle/XXXX_dual_write_divergences.sql</files>
  <read_first>
    - drizzle.config.ts (existing — confirms the migrations dir and naming convention)
    - drizzle/ (the existing migrations directory — note the numbering — the new file gets next-in-sequence)
    - .planning/phases/02-vault-write-path-event-sourcing/plans/02-10-backup-strategy.md (for the `pnpm db:generate` pattern Phase 02 followed)
  </read_first>
  <action>
Run `pnpm db:generate` to have drizzle-kit emit the CREATE TABLE SQL. The migration file lands at `drizzle/<next-number>_<auto-name>.sql`. Confirm the generated SQL contains:

```sql
CREATE TABLE IF NOT EXISTS "dual_write_divergences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "character_id" uuid,
  "event_type" text,
  "vault_state" jsonb,
  "postgres_state" jsonb,
  "summary" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "dual_write_divergences_session_idx" ON "dual_write_divergences" USING btree ("session_id", "created_at" DESC);
```

If drizzle-kit's auto-generated SQL differs cosmetically (it might use slightly different syntax for the FK constraints), accept the auto output but verify the COLUMNS + CONSTRAINTS + INDEX match.

Apply the migration locally:
```
pnpm db:migrate
```
Confirm exit code 0.

If `pnpm db:migrate` fails (e.g., gen_random_uuid not available — needs `CREATE EXTENSION IF NOT EXISTS pgcrypto`), add the extension creation as an earlier migration OR include it in this one. The existing Phase 02 migrations may already have it; verify by `grep -l gen_random_uuid drizzle/*.sql`.
  </action>
  <verify>
    <automated>ls drizzle/*_dual_write_divergences*.sql && pnpm db:migrate</automated>
  </verify>
  <acceptance_criteria>
    - `ls drizzle/*_dual_write_divergences*.sql` finds exactly 1 file
    - `grep -c "CREATE TABLE\\|CREATE INDEX" drizzle/*_dual_write_divergences*.sql` returns ≥ 2 (table + index)
    - `grep -c "session_id\|campaign_id\|character_id\|event_type\|vault_state\|postgres_state\|summary\|created_at" drizzle/*_dual_write_divergences*.sql` returns ≥ 8 (all columns present)
    - `pnpm db:migrate` exits 0
    - After migrate, querying `\dt dual_write_divergences` in psql confirms the table exists (manual sanity check)
  </acceptance_criteria>
  <done>
    Migration applied. Test (Task 4) verifies insert/select.
  </done>
</task>

<task type="auto">
  <name>Task 4: Write tests/db/dual-write-divergences.test.ts</name>
  <files>tests/db/dual-write-divergences.test.ts</files>
  <read_first>
    - src/db/schema/dual-write-divergences.ts (Task 1)
    - tests/lib/preferences-master-backend.test.ts (Phase 01 — DB-dependent test pattern; uses DATABASE_URL)
    - .planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md (test layout convention — tests under tests/, NOT colocated)
  </read_first>
  <action>
Create `tests/db/dual-write-divergences.test.ts`. Skip the file at runtime if DATABASE_URL is not set (pre-existing project convention — see Phase 01 SUMMARY line 53).

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql, desc } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('dual_write_divergences table', () => {
  let db: typeof import('@/db/client').db;
  let dualWriteDivergences: typeof import('@/db/schema').dualWriteDivergences;
  let sessions: typeof import('@/db/schema').sessions;
  let campaigns: typeof import('@/db/schema').campaigns;

  beforeAll(async () => {
    const dbMod = await import('@/db/client');
    const schemaMod = await import('@/db/schema');
    db = dbMod.db;
    dualWriteDivergences = schemaMod.dualWriteDivergences;
    sessions = schemaMod.sessions;
    campaigns = schemaMod.campaigns;
  });

  // Create a throwaway session+campaign for FK targets; clean up after the suite.
  let testCampaignId: string;
  let testSessionId: string;

  beforeAll(async () => {
    // ... insert a fixture campaign + session for FK target ...
    // (use the SAME pattern other DB-dependent tests use; if there's a helper,
    //  reuse it. If not, hand-roll the insert.)
  });

  afterAll(async () => {
    // Clean up the fixture rows (the test runs against a real PG instance).
    await db.delete(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, testSessionId));
    // Cleanup of session + campaign delegated to fixture helper if available.
  });

  it('insert + select round-trip', async () => {
    const [row] = await db.insert(dualWriteDivergences).values({
      sessionId: testSessionId,
      campaignId: testCampaignId,
      characterId: null,
      eventType: 'hp_change',
      vaultState: { hp_current: 20 },
      postgresState: { hp_current: 15 },
      summary: 'hp_current vault=20 postgres=15',
    }).returning();

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.sessionId).toBe(testSessionId);
    expect(row.summary).toBe('hp_current vault=20 postgres=15');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('the (session_id, created_at DESC) index exists', async () => {
    // Postgres-specific introspection
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'dual_write_divergences'
        AND indexname = 'dual_write_divergences_session_idx';
    `);
    expect(result.rows ?? []).toHaveLength(1);
  });

  it('SELECT ordering by created_at DESC works (typical operator query)', async () => {
    // Insert 3 rows with slight time gaps; query latest first
    for (let i = 0; i < 3; i++) {
      await db.insert(dualWriteDivergences).values({
        sessionId: testSessionId,
        campaignId: testCampaignId,
        eventType: `test_${i}`,
        summary: `t${i}`,
      });
      // Avoid identical timestamps
      await new Promise((r) => setTimeout(r, 50));
    }
    const rows = await db.select().from(dualWriteDivergences)
      .where(eq(dualWriteDivergences.sessionId, testSessionId))
      .orderBy(desc(dualWriteDivergences.createdAt))
      .limit(3);
    expect(rows).toHaveLength(3);
    // Confirm DESC ordering
    expect(rows[0].summary).toBe('t2');
    expect(rows[2].summary).toBe('t0');
  });

  it('character_id is nullable', async () => {
    const [row] = await db.insert(dualWriteDivergences).values({
      sessionId: testSessionId,
      campaignId: testCampaignId,
      characterId: null,
      eventType: 'session_level',
      summary: 'session-level divergence',
    }).returning();
    expect(row.characterId).toBeNull();
  });
});
```

If the project has a test-fixtures helper for sessions/campaigns, reuse it (look for existing tests under `tests/db/` or `tests/lib/`). Otherwise hand-roll a minimal fixture inline (insert a user + campaign + session in beforeAll, delete in afterAll).
  </action>
  <verify>
    <automated>pnpm test tests/db/dual-write-divergences.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All 4 cases pass (skipped iff DATABASE_URL unset)
    - The test cleans up after itself (no orphaned rows in dual_write_divergences after the suite)
    - The index check passes (proves the migration ran correctly)
    - `pnpm test tests/db/dual-write-divergences.test.ts` exits 0
  </acceptance_criteria>
  <done>
    Audit table is shipping + tested. Plan 03-A-09 (DualWriter) writes rows here.
  </done>
</task>
