import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { eq, and, isNull, asc, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, sessionMessages, diceLog, combatActors, characters } from '@/db/schema';
import { GameClient } from './game-client';
import { getResolvedPreferences } from '@/lib/preferences';
import type { Character, FeatureInstance, SpellcastingState } from '@/engine/types';

export const dynamic = 'force-dynamic';

export default async function GameSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) notFound();

  const [character] = await db.select().from(characters).where(eq(characters.id, session.characterId)).limit(1);
  if (!character) notFound();

  const [stateRow] = await db.select().from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);

  const [history, rolls, actors] = await Promise.all([
    db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(asc(sessionMessages.createdAt)).limit(100),
    db.select().from(diceLog).where(eq(diceLog.sessionId, sessionId)).orderBy(desc(diceLog.createdAt)).limit(50),
    db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId)),
  ]);

  // Engine-shaped Character for the panes
  const engineCharacter: Character = {
    id: character.id,
    name: character.name,
    level: character.level,
    classSlug: character.classSlug,
    raceSlug: character.raceSlug,
    backgroundSlug: character.backgroundSlug,
    abilities: character.abilities,
    proficiencyBonus: character.proficiencyBonus,
    hpMax: character.hpMax,
    ac: character.ac,
    speed: character.speed,
    proficiencies: character.proficiencies as Character['proficiencies'],
    spellcasting: character.spellcasting as SpellcastingState | null,
    features: character.features as FeatureInstance[],
    inventory: character.inventory,
    hitDiceMax: character.hitDiceMax,
    hitDieSize: character.hitDieSize,
  };

  const preferences = await getResolvedPreferences(userId);

  return (
    <GameClient
      sessionId={sessionId}
      initialAutoplay={preferences.ttsAutoplay}
      initialManualRolls={preferences.manualRolls}
      session={{
        id: session.id,
        userId: session.userId,
        characterId: session.characterId,
        premise: session.premise,
        language: session.language,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      }}
      character={engineCharacter}
      initialState={
        stateRow
          ? {
              sessionId: stateRow.sessionId,
              hpCurrent: stateRow.hpCurrent,
              tempHp: stateRow.tempHp,
              hitDiceRemaining: stateRow.hitDiceRemaining,
              spellSlotsUsed: stateRow.spellSlotsUsed,
              conditions: stateRow.conditions,
              resourcesUsed: stateRow.resourcesUsed,
              inCombat: stateRow.inCombat,
              combat: stateRow.combat,
              scene: stateRow.scene,
            }
          : null
      }
      initialMessages={history.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }))}
      initialRolls={rolls.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        kind: r.kind,
        formula: r.formula,
        rolls: r.rolls,
        modifier: r.modifier,
        total: r.total,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      }))}
      initialActors={actors.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        name: a.name,
        monsterSlug: a.monsterSlug,
        hpCurrent: a.hpCurrent,
        hpMax: a.hpMax,
        initiative: a.initiative,
        isAlive: a.isAlive,
        conditions: a.conditions,
      }))}
    />
  );
}
