/**
 * Phase 03-A — synchronous dual-write fan-out + parity-check.
 *
 * Per RESEARCH Decision 2 (Option B): an in-process function encapsulates
 * `EventsWriter.applyEvent` (vault leg) + a caller-supplied
 * `applyEngineMutation` callback (Postgres leg) + the synchronous
 * `parityCheck` post-write divergence detector. Divergence rows are
 * recorded fire-and-forget via `recordDivergence`.
 *
 * --------------------------------------------------------------------------
 * Why parallel via `Promise.all`
 * --------------------------------------------------------------------------
 * The vault leg is ~5-20 ms (single appendFile + view regen on tmpfs); the
 * Postgres leg is typically 20-100 ms (engine mutation through drizzle + a
 * round-trip to RDS). Sequencing them would add the smaller latency on top
 * of the larger one; `Promise.all` preserves the slower leg's latency, so
 * the LLM turn observes max(vault, pg) — not vault + pg.
 *
 * --------------------------------------------------------------------------
 * Why synchronous parity-check (NIT 6 — partial-success semantics)
 * --------------------------------------------------------------------------
 * The parity-check runs ONLY after both writes succeed. If either write
 * rejects, the `Promise.all` itself rejects and `dualWriteApplyEvent` re-
 * throws — the LLM sees `isError: true` via the dispatcher's catch. We do
 * NOT regenerate views and we do NOT run parity-check in that case: the
 * vault may have appended an event while Postgres did not (or vice versa),
 * which is a genuine divergence — but we record it via the thrown error
 * (caller logs + operator inspects events.md) rather than via an audit
 * row, because audit rows are reserved for cases where BOTH writes
 * succeeded and only the resulting state disagrees.
 *
 * View regeneration runs AFTER the parallel writes so it observes the
 * just-appended event. It runs OUTSIDE the parity-check fork because
 * regeneration is idempotent + cheap (spike 008 measured ~1 ms for 100
 * events) and the parity-check needs the post-regeneration state to
 * compare. Failure of `regenerateAffectedViews` is treated the same as
 * any other failure: the function re-throws and the caller decides.
 *
 * --------------------------------------------------------------------------
 * Anti-pattern avoided (RESEARCH §3.1)
 * --------------------------------------------------------------------------
 * NO auto-correction. The DualWriter records the divergence; the operator
 * decides remediation (compensating apply_event OR
 * `pnpm vault:rebuild-views --campaign=<uuid>`).
 *
 * --------------------------------------------------------------------------
 * Callback decoupling
 * --------------------------------------------------------------------------
 * `applyEngineMutation` is a `() => Promise<void>` callback — the
 * dispatcher (plan 03-A-10) closes over the mutation chain it wants
 * executed (typically a wrapped `applyMutations(sessionId, [...], [])`
 * call inside a transaction). This keeps `dual-writer.ts` independent of
 * the engine module's specific function names and lets event types that
 * have NO Postgres analogue pass a no-op callback (`async () => {}`).
 */
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { parityCheck, type ParityResult } from '@/ai/master/vault/parity-check';
import { recordDivergence } from './divergence-record';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';

/**
 * Context passed alongside the envelope for the parity-check + audit-row
 * insertion. `campaignId` is required (resolves the vault path);
 * `sessionId` is required (identifies the parity scope + audit row);
 * `characterId` is nullable for session-level events that don't target a
 * single character (e.g., a hypothetical `session_paused` event — none
 * exist today, but the design accommodates them by skipping parity).
 */
export interface DualWriteContext {
  campaignId: string;
  sessionId: string;
  /**
   * Character UUID — required for parity-check (the diff is per-character).
   * Pass `null` for session-level events that don't target a single
   * character; the parity-check is skipped in that case and the function
   * always returns `{ divergence: false }`.
   */
  characterId: string | null;
}

/**
 * Returned by `dualWriteApplyEvent`. `divergence: false` means the two
 * sides matched (or parity-check was skipped — characterId null, or one
 * of parityCheck's internal skip-cases). `divergence: true` means
 * `parityCheck` returned a `ParityResult`; `reason` carries the summary
 * (capped at 200 chars by `parityCheck`).
 */
export interface DualWriteResult {
  divergence: boolean;
  /** Set iff `divergence === true`; the ParityResult summary string. */
  reason?: string;
}

/**
 * Issue parallel writes to vault (events.md) AND Postgres (engine
 * mutation), regenerate views, then run the parity-check. The audit
 * row (if any) is fire-and-forget so it does not block the LLM turn.
 *
 * Failure modes (must_haves truth #3):
 *   - Vault write fails → `Promise.all` rejects, function re-throws.
 *     NO view regen, NO parity-check, NO audit row.
 *   - Postgres callback fails → same as above. The Postgres state may now
 *     disagree with what the vault recorded, but this is reported via the
 *     thrown error (operator sees the failure trace and inspects
 *     events.md) rather than via an audit row.
 *   - View regen fails → re-throws. The vault + Postgres writes already
 *     landed; the view file may be stale. The operator's runbook
 *     (`pnpm vault:rebuild-views`) recovers it.
 *   - Parity-check throws (DB connectivity hiccup, malformed events.md)
 *     → propagates to caller. The writes already succeeded; the alarm is
 *     the operator's responsibility.
 *
 * On the happy path, returns `{ divergence: false }` when states agree
 * and `{ divergence: true, reason }` when they disagree. The audit row
 * insertion is detached (`void` + `.catch`) so a transient DB failure
 * recording the divergence does NOT cause the turn to fail.
 */
export async function dualWriteApplyEvent(
  envelope: VaultEventEnvelope,
  applyEngineMutation: () => Promise<void>,
  ctx: DualWriteContext,
): Promise<DualWriteResult> {
  // === Phase 1 — Parallel writes ===
  // The vault append is mutex-serialized per absolute path inside
  // EventsWriter.append; the Postgres mutation is whatever the caller's
  // closure does (typically a single applyMutations call inside a tx).
  // Both legs MUST succeed before we touch views or parity-check — if
  // either rejects, Promise.all rejects and the function re-throws.
  await Promise.all([
    EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope),
    applyEngineMutation(),
  ]);

  // === Phase 2 — View regeneration ===
  // Synchronous regen so the next read_vault_multi (or the parity-check
  // below) observes the just-appended event. Regen is cheap (~1 ms) and
  // idempotent — re-running it produces byte-identical view files.
  await regenerateAffectedViews(ctx.campaignId, envelope);

  // === Phase 3 — Synchronous parity-check ===
  // Skip when the event is not character-targeted (characterId === null).
  // The parityCheck function itself has additional skip cases (malformed
  // campaignId, events.md absent, character not seeded, Postgres row
  // gone) — those return null and we treat them the same as a match.
  if (!ctx.characterId) {
    return { divergence: false };
  }
  const result: ParityResult | null = await parityCheck(
    ctx.campaignId,
    ctx.characterId,
    ctx.sessionId,
  );
  if (!result) {
    return { divergence: false };
  }

  // === Phase 4 — Fire-and-forget divergence record ===
  // `void recordDivergence(...)` detaches the promise so the LLM turn
  // is NOT blocked on the audit insert (the divergence info we return
  // to the caller is already in `result`; the audit row is for offline
  // operator inspection). A `.catch` traps any DB failure so an
  // unhandled rejection doesn't crash the process.
  void recordDivergence({
    sessionId: ctx.sessionId,
    campaignId: ctx.campaignId,
    characterId: ctx.characterId,
    eventType: envelope.type,
    parityResult: result,
  }).catch((e: unknown) => {
    console.error(
      '[dual-writer] recordDivergence failed:',
      e instanceof Error ? e.message : e,
    );
  });

  return { divergence: true, reason: result.summary };
}
