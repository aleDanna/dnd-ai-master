import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, combatActors, characters, campaigns } from '@/db/schema';

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

  const [state] = await db
    .select()
    .from(sessionState)
    .where(eq(sessionState.sessionId, sessionId))
    .limit(1);

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
