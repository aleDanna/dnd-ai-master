import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { eq, and, isNull, isNotNull, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, sessionMessages, combatActors, characters, campaigns } from '@/db/schema';
import { GameClient } from './game-client';
import { getResolvedPreferences, getSessionMasterPreferences } from '@/lib/preferences';
import { deriveLevel1Spellcasting } from '@/characters/derive';
import type { Character, FeatureInstance, SpellcastingState } from '@/engine/types';
import { checkPartyAccess } from '@/multiplayer/access';

export const dynamic = 'force-dynamic';

export default async function GameSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;
  const { id: sessionId } = await params;

  const [sessionRow] = await db
    .select({ session: sessions, campaign: campaigns })
    .from(sessions)
    .leftJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!sessionRow) notFound();
  const hasAccess = await checkPartyAccess(userId, sessionId);
  if (!hasAccess) notFound();
  const session = sessionRow.session;
  const campaign = sessionRow.campaign;

  // Multiplayer: each viewer sees THEIR OWN character in the left pane.
  // Look up the viewer's instance in the campaign's party. Fall back to
  // session.characterId (host's character) for the host or for legacy
  // single-character sessions where the viewer's row is the same.
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
  const characterRow = viewerChar ?? (
    await db.select().from(characters).where(eq(characters.id, session.characterId)).limit(1)
  )[0];
  if (!characterRow) notFound();

  // One-time backfill: characters created before deriveCharacter populated
  // spellcasting can have a null block (or empty spellsKnown) even when the
  // class is a caster. Fix it on read so the Spells panel shows the starter
  // loadout immediately, with no manual migration required.
  let character = characterRow;
  const persistedSpellcasting = character.spellcasting as SpellcastingState | null;
  const needsSpellBackfill =
    deriveLevel1Spellcasting(character.classSlug, character.abilities, character.proficiencyBonus) !== null &&
    (persistedSpellcasting === null || persistedSpellcasting.spellsKnown.length === 0);
  if (needsSpellBackfill) {
    const derived = deriveLevel1Spellcasting(
      character.classSlug,
      character.abilities,
      character.proficiencyBonus,
    );
    if (derived) {
      // Preserve any pre-existing slot tracking the master mutated (e.g. a
      // wizard that already leveled up): we only fill missing fields,
      // never overwrite a non-empty spellsKnown.
      const merged: SpellcastingState = persistedSpellcasting
        ? {
            ...persistedSpellcasting,
            spellsKnown: persistedSpellcasting.spellsKnown.length > 0 ? persistedSpellcasting.spellsKnown : derived.spellsKnown,
            spellsPrepared: persistedSpellcasting.spellsPrepared.length > 0 ? persistedSpellcasting.spellsPrepared : derived.spellsPrepared,
          }
        : derived;
      await db
        .update(characters)
        .set({ spellcasting: merged, updatedAt: new Date() })
        .where(eq(characters.id, character.id));
      character = { ...character, spellcasting: merged };
    }
  }

  const [stateRow] = await db.select().from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);

  const [history, actors] = await Promise.all([
    db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(asc(sessionMessages.createdAt)).limit(100),
    db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId)),
  ]);

  // Engine-shaped Character for the panes
  const engineCharacter: Character = {
    id: character.id,
    name: character.name,
    level: character.level,
    xp: character.xp,
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

  // Split prefs by ownership:
  //   - Master-driven flags (manualRolls, imageGenerationEnabled) come from
  //     the host so the party sees one consistent Master configuration.
  //   - TTS autoplay is a personal device choice — each viewer sets it
  //     themselves on /settings.
  const [viewerPrefs, sessionPrefs] = await Promise.all([
    getResolvedPreferences(userId),
    getSessionMasterPreferences(sessionId),
  ]);

  return (
    <GameClient
      sessionId={sessionId}
      initialAutoplay={viewerPrefs.ttsAutoplay}
      initialManualRolls={sessionPrefs.manualRolls}
      initialImageGenerationEnabled={sessionPrefs.imageGenerationEnabled}
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
      campaign={campaign ? {
        id: campaign.id,
        userId: campaign.userId,
        name: campaign.name,
        premise: campaign.premise,
        style: campaign.style,
        language: campaign.language,
        tonalFrame: campaign.tonalFrame,
        engagementProfile: campaign.engagementProfile,
        status: campaign.status,
        createdAt: campaign.createdAt.toISOString(),
        updatedAt: campaign.updatedAt.toISOString(),
      } : null}
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
              sceneImageVersion: stateRow.sceneImageVersion,
              sceneImagePrompt: stateRow.sceneImagePrompt,
            }
          : null
      }
      initialMessages={history.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        authorCharacterId: m.authorCharacterId ?? null,
        createdAt: m.createdAt.toISOString(),
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
