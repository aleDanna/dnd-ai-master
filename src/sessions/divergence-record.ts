/**
 * Phase 03-A — thin wrapper for inserting a `dual_write_divergences`
 * audit row.
 *
 * Called fire-and-forget by `dual-writer.ts` (see the `void recordDivergence(...)`
 * + `.catch` site there); audit-write failures are logged but do not block
 * the LLM turn. The separation from `dual-writer.ts` exists so the
 * audit-write surface is testable in isolation (plan 03-A-09 task 4 —
 * `tests/sessions/divergence-record.test.ts` — exercises this module
 * against the real schema without exercising the parallel-write path).
 *
 * Field mapping (all sourced from the inputs — this module performs NO
 * derivations; it is a typed INSERT alias):
 *
 *   - input.sessionId       → dual_write_divergences.session_id      (NOT NULL FK)
 *   - input.campaignId      → dual_write_divergences.campaign_id     (NOT NULL FK)
 *   - input.characterId     → dual_write_divergences.character_id    (nullable)
 *   - input.eventType       → dual_write_divergences.event_type      (nullable; carries
 *                                                                     the VaultEvent.type
 *                                                                     that triggered the
 *                                                                     parity-check)
 *   - parityResult.vault    → dual_write_divergences.vault_state     (jsonb)
 *   - parityResult.postgres → dual_write_divergences.postgres_state  (jsonb)
 *   - parityResult.summary  → dual_write_divergences.summary         (text, ≤200 chars
 *                                                                     enforced by
 *                                                                     parityCheck)
 *
 * `id` + `created_at` are filled by Postgres defaults
 * (`gen_random_uuid()` + `now()`).
 */
import { db } from '@/db/client';
import { dualWriteDivergences } from '@/db/schema';
import type { ParityResult } from '@/ai/master/vault/parity-check';

/**
 * Input shape for `recordDivergence`. Mirrors the fields the caller
 * (`dual-writer.ts`) already has in scope: identifiers from
 * `DualWriteContext`, the event type from the envelope, and the
 * `ParityResult` returned by `parityCheck`.
 */
export interface RecordDivergenceInput {
  sessionId: string;
  campaignId: string;
  /** Nullable for session-level divergences (e.g., resume-check). */
  characterId: string | null;
  /** The VaultEvent.type that triggered the parity-check. */
  eventType: string;
  /** The `ParityResult` produced by `parityCheck` (must be a divergence — not null). */
  parityResult: ParityResult;
}

/**
 * Insert one row into `dual_write_divergences`. Returns `void` — callers
 * do not need the row id (the audit table is queried by operators, not
 * the application). Throws on DB error; callers (the `dual-writer.ts`
 * fire-and-forget site) MUST attach a `.catch` to swallow + log.
 */
export async function recordDivergence(
  input: RecordDivergenceInput,
): Promise<void> {
  await db.insert(dualWriteDivergences).values({
    sessionId: input.sessionId,
    campaignId: input.campaignId,
    characterId: input.characterId,
    eventType: input.eventType,
    vaultState: input.parityResult.vault,
    postgresState: input.parityResult.postgres,
    summary: input.parityResult.summary,
  });
}
