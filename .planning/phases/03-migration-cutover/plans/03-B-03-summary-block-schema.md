---
phase: 03
plan: B-03
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/schema/session-state.ts
  - drizzle/XXXX_session_state_summary_block.sql
  - tests/db/session-state-summary-block.test.ts
autonomous: true
requirements: [REQ-023]
must_haves:
  truths:
    - "session_state has a new jsonb column summary_block, nullable, default null"
    - "The Drizzle TypeScript schema (src/db/schema/session-state.ts) exports summaryBlock typed as { text: string; generatedAt: string; tokensBefore: number } | null"
    - "A drizzle migration file under drizzle/XXXX_session_state_summary_block.sql ALTER TABLEs session_state to ADD COLUMN summary_block jsonb"
    - "`pnpm db:migrate` applies it successfully (idempotent under IF NOT EXISTS — the migration uses ADD COLUMN IF NOT EXISTS where supported)"
    - "Inserting a row with summaryBlock = {text:'...', generatedAt:'2026-05-26T12:00:00Z', tokensBefore:15234} round-trips correctly"
    - "Backward compat: existing rows have NULL summary_block; reads do not break"
  artifacts:
    - path: "src/db/schema/session-state.ts"
      provides: "summaryBlock jsonb column added"
      contains: "summaryBlock"
    - path: "drizzle/XXXX_session_state_summary_block.sql"
      provides: "ALTER TABLE migration"
    - path: "tests/db/session-state-summary-block.test.ts"
      provides: "Insert + read-back round-trip + null-default test"
  key_links:
    - from: "src/ai/master/vault/condense.ts (plan 03-B-04)"
      to: "src/db/schema/session-state.ts (this plan — summaryBlock column)"
      via: "Drizzle update persists the summary"
      pattern: "summaryBlock"
---

# Plan 03-B-03: session_state.summaryBlock Column

**Phase:** 03-migration-cutover
**Wave:** 1 (no deps)
**Status:** Pending
**Estimated diff size:** ~30 LOC source + ~80 LOC tests / 3 files

## Goal

Add the persistence column for the summarizer's output (REQ-023). Per RESEARCH §3.3 + Decision 6: the summary lives in `session_state.summaryBlock` JSONB (additive — survives Next.js restart per Pitfall 4).

The column is nullable + defaults to null — existing rows are unaffected. The summarizer module (plan 03-B-04) writes; the loop (plan 03-B-05) reads to skip re-summarization after restart.

## Requirements satisfied

- **REQ-023** — Per-turn summarization persistence. Without this column, the summarizer must re-run on every cold start (Pitfall 4).

## Files touched

| File | Action | Why |
|---|---|---|
| `src/db/schema/session-state.ts` | EDIT | Add summaryBlock column |
| `drizzle/XXXX_session_state_summary_block.sql` | NEW (drizzle-generated) | ALTER TABLE |
| `tests/db/session-state-summary-block.test.ts` | NEW | Round-trip test |

## Tasks

<task type="auto">
  <name>Task 1: Add summaryBlock column to session-state schema</name>
  <files>src/db/schema/session-state.ts</files>
  <read_first>
    - src/db/schema/session-state.ts (existing pgTable — confirm the jsonb columns use `.$type<...>()` typing pattern)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§3.3 — summary block shape: {text, generatedAt, tokensBefore})
  </read_first>
  <action>
Edit `src/db/schema/session-state.ts`. Add a new column at the END of the table definition (after `travel`):

```ts
  /**
   * Phase 03-B vault-llm-wiki — persisted per-turn summarization block
   * (REQ-023). When the cumulative prompt exceeds the summarizer trigger,
   * maybeCondense generates a ~200-word summary of the older turns and
   * stores it here. On Next.js restart, the loop reads this block and
   * skips re-summarization unless the threshold is crossed AGAIN with
   * new turns.
   *
   * Shape: {text: string; generatedAt: ISO timestamp; tokensBefore: int}
   * (extensible — Phase 04+ may add summaryModel, condensedFromTurns).
   *
   * Default: null (no summarization yet for this session). Backward-compat
   * with rows created before Phase 03.
   */
  summaryBlock: jsonb('summary_block').$type<{ text: string; generatedAt: string; tokensBefore: number } | null>().default(null),
```

(Don't modify any other column.)
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "summaryBlock\\|summary_block" src/db/schema/session-state.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "summaryBlock" src/db/schema/session-state.ts` returns >= 2
    - The default is `null` (not `{}` or `undefined`)
    - The TypeScript type is `{ text; generatedAt; tokensBefore } | null` (not unknown or any)
  </acceptance_criteria>
  <done>
    Schema extended.
  </done>
</task>

<task type="auto">
  <name>Task 2: Generate + apply drizzle migration</name>
  <files>drizzle/XXXX_session_state_summary_block.sql</files>
  <read_first>
    - src/db/schema/session-state.ts (Task 1)
    - drizzle.config.ts (drizzle-kit invocation)
  </read_first>
  <action>
Run `pnpm db:generate`. drizzle-kit emits a migration file like `drizzle/00XX_<auto-name>.sql`. Confirm the SQL contains:

```sql
ALTER TABLE "session_state" ADD COLUMN "summary_block" jsonb;
```

(Drizzle's default emit may omit `IF NOT EXISTS` — that's fine because `pnpm db:migrate` tracks applied migrations.)

Apply locally: `pnpm db:migrate`. Confirm exit 0.

Inspect with psql: `\d session_state` shows the new column.
  </action>
  <verify>
    <automated>ls drizzle/*summary_block*.sql && pnpm db:migrate</automated>
  </verify>
  <acceptance_criteria>
    - `ls drizzle/*summary_block*.sql` finds the migration file
    - `grep "summary_block" drizzle/*summary_block*.sql` finds the ALTER TABLE
    - `pnpm db:migrate` exits 0
  </acceptance_criteria>
  <done>
    Migration applied.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/db/session-state-summary-block.test.ts</name>
  <files>tests/db/session-state-summary-block.test.ts</files>
  <read_first>
    - tests/db/dual-write-divergences.test.ts (plan 03-A-05 — DB-fixture pattern)
    - src/db/schema/session-state.ts (Task 1)
  </read_first>
  <action>
Create `tests/db/session-state-summary-block.test.ts`. Skip if DATABASE_URL unset.

Cases:
1. New session row has summaryBlock = null (default)
2. Update sessionState.summaryBlock = {...} round-trips correctly (insert, select, fields preserved)
3. Type-safe shape — the TypeScript type catches a wrong field name at compile time (this is implicit in pnpm typecheck; cover via a smoke that asserts the runtime shape)

Use the existing session+session_state fixture pattern. Cleanup in afterAll.

```ts
(HAS_DB ? describe : describe.skip)('session_state.summaryBlock', () => {
  // ... fixture setup ...

  it('defaults to null on new rows', async () => {
    const [row] = await db.select({ summaryBlock: sessionState.summaryBlock }).from(sessionState).where(eq(sessionState.sessionId, TEST_SESSION_ID)).limit(1);
    expect(row.summaryBlock).toBeNull();
  });

  it('round-trip {text, generatedAt, tokensBefore}', async () => {
    const block = { text: 'Aragorn entered the dungeon.', generatedAt: '2026-05-26T12:00:00Z', tokensBefore: 15234 };
    await db.update(sessionState).set({ summaryBlock: block }).where(eq(sessionState.sessionId, TEST_SESSION_ID));
    const [row] = await db.select({ summaryBlock: sessionState.summaryBlock }).from(sessionState).where(eq(sessionState.sessionId, TEST_SESSION_ID)).limit(1);
    expect(row.summaryBlock).toEqual(block);
  });

  it('reset to null', async () => {
    await db.update(sessionState).set({ summaryBlock: null }).where(eq(sessionState.sessionId, TEST_SESSION_ID));
    const [row] = await db.select({ summaryBlock: sessionState.summaryBlock }).from(sessionState).where(eq(sessionState.sessionId, TEST_SESSION_ID)).limit(1);
    expect(row.summaryBlock).toBeNull();
  });
});
```
  </action>
  <verify>
    <automated>pnpm test tests/db/session-state-summary-block.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All 3 cases pass (skipped when DATABASE_URL unset)
    - The round-trip preserves the JSONB shape exactly
    - Cleanup is complete
  </acceptance_criteria>
  <done>
    Schema + migration + test ship. Plan 03-B-04 condense.ts persists summaries here.
  </done>
</task>
