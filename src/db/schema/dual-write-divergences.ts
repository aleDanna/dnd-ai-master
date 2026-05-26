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
