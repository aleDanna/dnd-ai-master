import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, combatActors, characters, campaigns, type SessionState } from '@/db/schema';
import { resolveSourceOfTruth } from '@/lib/preferences';
import { materializeFromVault } from '@/ai/master/vault/snapshot-reader';

/**
 * Build the client-shaped session snapshot used by `useSessionStream` on
 * BOTH paths:
 *   1. Initial SSE delivery from `/api/sessions/[id]/stream` (the LISTEN
 *      route emits this on connect).
 *   2. `refetch` from `/api/sessions/[id]` triggered by the SSE `message`
 *      and `state` / `dice` events.
 *
 * Keeping the two paths on a single builder is load-bearing — if they drift
 * (as they did before this extraction), the snapshot loses fields on every
 * refetch and downstream UI (composer lock, party strip, etc.) silently
 * breaks. SessionStateRow-shape `state` and full-row `character` /
 * `currentPlayerCharacterId` / `viewerCharacterId` are part of the contract.
 *
 * Multiplayer rule: `character` is the VIEWER's own party instance.
 * Spectators (no instance row) and legacy single-character sessions fall
 * back to `session.characterId` (the host's character).
 *
 * Phase 03-B (Decision 4) — sourceOfTruth pivot:
 *   When `campaign.settings.sourceOfTruth === 'vault'`, the `state` field is
 *   materialized from events.md via `materializeFromVault` instead of
 *   reading `session_state` from Postgres. The returned snapshot SHAPE is
 *   identical across paths — UI consumers don't need to change.
 *
 *   Defensive fallback: if `materializeFromVault` returns null (events.md
 *   missing OR target character not in seed) OR throws, the function falls
 *   back to the Postgres read. The vault-cutover script (plan 03-B-02)
 *   guarantees this state shouldn't arise post-flip, but the safety net is
 *   cheap and avoids breaking the UI for a campaign in an inconsistent
 *   flag state.
 *
 *   When the viewer has NO character (spectator / legacy session falling
 *   back to host's character), `materializeFromVault` would need the host's
 *   characterId — but the host's character may not be a campaign-instance
 *   (templateId null) and so not in the vault seed. We fall back to
 *   Postgres in that case too: the vault pivot only fires when the viewer
 *   resolved to their own campaign-instance character.
 */
export async function buildClientSnapshot(sessionId: string, userId: string) {
  const [row] = await db
    .select({ session: sessions, campaign: campaigns })
    .from(sessions)
    .leftJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`buildClientSnapshot: session ${sessionId} not found`);
  const { session, campaign } = row;

  const [viewerChar] = session.campaignId
    ? await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.campaignId, session.campaignId),
          eq(characters.userId, userId),
          isNotNull(characters.templateId),
          isNull(characters.deletedAt),
        ))
        .limit(1)
    : [];
  const character = viewerChar ?? (
    await db.select().from(characters).where(eq(characters.id, session.characterId)).limit(1)
  )[0] ?? null;

  // Phase 03-B (Decision 4) — sourceOfTruth pivot. Resolve the campaign's
  // cutover flag; when 'vault', try to materialize state from events.md.
  // On null OR throw, fall through to the Postgres read below. This is the
  // ONE branch in the function that differs across paths — every other
  // field (actors, party, character, currentPlayerCharacterId,
  // viewerCharacterId) reads from Postgres as before.
  let state: SessionState | null = null;
  const sourceOfTruth = resolveSourceOfTruth(campaign?.settings?.sourceOfTruth);
  // The vault pivot requires (a) a campaign (legacy single-character
  // sessions without a campaignId stay on Postgres) and (b) the viewer's
  // own campaign-instance character (so the vault seed has them).
  const viewerCharId = viewerChar?.id;
  if (sourceOfTruth === 'vault' && campaign && viewerCharId) {
    try {
      const vaultState = await materializeFromVault(campaign.id, viewerCharId, sessionId);
      if (vaultState) {
        // The translator returns `Partial<SessionState>` populated from
        // vault replay; consumers downstream type it as `SessionState | null`,
        // so we cast here. The translator emits sane defaults for every
        // non-vault-tracked field (see snapshot-reader.translateCharacterState).
        state = vaultState as SessionState;
      }
    } catch (e) {
      // Defensive: never let a vault read error bubble up — the UI loses
      // the snapshot entirely. Log + fall back to Postgres.
      // eslint-disable-next-line no-console
      console.warn(
        '[client-snapshot] vault materialization failed, falling back to Postgres:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (!state) {
    // Default (sourceOfTruth='postgres') OR vault fallback (null/throw).
    // Drizzle's destructured row is `T | undefined` when no rows match;
    // coalesce to null so the snapshot's `state` field stays in its
    // documented `SessionState | null` shape.
    const [pgState] = await db
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .limit(1);
    state = pgState ?? null;
  }

  const actors = await db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId));

  const party = session.campaignId
    ? await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.campaignId, session.campaignId),
          isNull(characters.deletedAt),
          isNotNull(characters.templateId),
        ))
        .orderBy(characters.createdAt)
    : [];

  return {
    session,
    campaign,
    state: state ?? null,
    character,
    actors,
    party,
    currentPlayerCharacterId: session.currentPlayerCharacterId,
    viewerCharacterId: viewerChar?.id ?? null,
  };
}
