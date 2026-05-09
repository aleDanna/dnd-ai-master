import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessions as sessionsTable,
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  characters as charactersTable,
  type SessionState,
  type CombatActor as CombatActorRow,
} from '@/db/schema';
import type { Character, CombatActor, ConcentrationState, EngineState, ActorRuntimeState } from '@/engine/types';
import type { SnapshotForModel } from './types';

export async function buildSnapshot(sessionId: string, userId: string): Promise<SnapshotForModel> {
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.id, sessionId), eq(sessionsTable.userId, userId), isNull(sessionsTable.deletedAt)))
    .limit(1);
  if (!session) throw new Error(`buildSnapshot: session ${sessionId} not found for user ${userId}`);

  const [character] = await db.select().from(charactersTable).where(eq(charactersTable.id, session.characterId)).limit(1);
  if (!character) throw new Error(`buildSnapshot: character ${session.characterId} not found`);

  const [stateRow] = await db.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
  if (!stateRow) throw new Error(`buildSnapshot: session_state for ${sessionId} not found`);

  const actorRows = await db.select().from(combatActorsTable).where(eq(combatActorsTable.sessionId, sessionId));

  const characters: Character[] = [
    {
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
      inspiration: character.inspiration ?? false,
      spellcasting: character.spellcasting as Character['spellcasting'],
      features: character.features as Character['features'],
      inventory: character.inventory,
      hitDiceMax: character.hitDiceMax,
      hitDieSize: character.hitDieSize,
    },
  ];

  const combatActors: CombatActor[] = actorRows.map(toEngineCombatActor);

  const runtime: Record<string, ActorRuntimeState> = {};
  runtime[character.id] = {
    actorId: character.id,
    hpCurrent: stateRow.hpCurrent,
    tempHp: stateRow.tempHp,
    deathSaves: stateRow.deathSaves ?? { successes: 0, failures: 0 },
    flags: stateRow.flags ?? {},
    exhaustionLevel: stateRow.exhaustionLevel ?? 0,
    conditions: stateRow.conditions as ActorRuntimeState['conditions'],
    hitDiceRemaining: stateRow.hitDiceRemaining,
    spellSlotsUsed: parseSlotsUsed(stateRow.spellSlotsUsed),
    resourcesUsed: stateRow.resourcesUsed,
    concentratingOn: hydrateConcentration(stateRow.concentratingOn),
    turnState: stateRow.turnState ?? undefined,
    position: stateRow.position ?? undefined,
  };
  for (const a of actorRows) {
    runtime[a.id] = {
      actorId: a.id,
      hpCurrent: a.hpCurrent,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: a.conditions as ActorRuntimeState['conditions'],
      turnState: a.turnState ?? undefined,
      position: a.position ?? undefined,
    };
  }

  const state: EngineState = {
    characters,
    combatActors,
    runtime,
    combat: stateRow.combat ?? null,
    scene: stateRow.scene,
  };

  // What the master sees about the PC. xp + inventory are included
  // explicitly so the master can self-check before calling award_xp /
  // add_item: "the player already has 200 XP, do I really need to grant
  // 200 more?" / "the player already has 5 torches, do I add a 6th or
  // narrate them using one?". Without this visibility the master would
  // sometimes re-award the same loot or XP across turns, since chat
  // history alone is not a reliable ledger.
  const characterMonoSpace = JSON.stringify({
    name: character.name,
    level: character.level,
    xp: character.xp,
    class: character.classSlug,
    race: character.raceSlug,
    hp: `${stateRow.hpCurrent}/${character.hpMax}`,
    ac: character.ac,
    abilities: character.abilities,
    saves: character.proficiencies.saves,
    skills: character.proficiencies.skills,
    conditions: stateRow.conditions,
    inCombat: stateRow.inCombat,
    inventory: character.inventory,
    spellSlots: buildSpellSlotsView(character.spellcasting as Character['spellcasting'], stateRow.spellSlotsUsed),
  });

  return { state, characterMonoSpace, scene: stateRow.scene, language: session.language };
}

function toEngineCombatActor(row: CombatActorRow): CombatActor {
  const c = (row.custom ?? {}) as Partial<CombatActor>;
  return {
    id: row.id,
    kind: row.monsterSlug ? 'monster' : 'npc',
    name: row.name,
    monsterSlug: row.monsterSlug ?? undefined,
    hpMax: row.hpMax,
    ac: c.ac ?? 10,
    abilities: c.abilities ?? { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: c.proficiencyBonus ?? 2,
    initiativeBonus: c.initiativeBonus ?? 0,
    resistances: c.resistances ?? [],
    immunities: c.immunities ?? [],
    vulnerabilities: c.vulnerabilities ?? [],
    conditionImmunities: c.conditionImmunities ?? [],
  };
}

/**
 * Master-facing spell-slot view: `{ "1": "2/4", "2": "0/2" }` (used/max per
 * level). Returns null when the PC is not a spellcaster so the JSON stays tidy.
 * The master must consult this before handing out spells — empty `slotsMax`
 * means no spellcasting; a level whose used == max means that level is spent.
 */
function buildSpellSlotsView(
  spellcasting: Character['spellcasting'],
  used: Record<string, number>,
): Record<string, string> | null {
  if (!spellcasting || !spellcasting.slotsMax) return null;
  const view: Record<string, string> = {};
  for (const [lvl, max] of Object.entries(spellcasting.slotsMax)) {
    if (typeof max !== 'number' || max <= 0) continue;
    const u = used[lvl] ?? 0;
    view[lvl] = `${u}/${max}`;
  }
  return Object.keys(view).length > 0 ? view : null;
}

/**
 * Convert the DB jsonb shape `{ spellSlug, slotLevel: number, startedRound } |
 * null` into the engine's `ConcentrationState` (slotLevel narrowed to 0..9).
 * Returns `undefined` when the column is null so the optional field reads as
 * absent on the runtime entry. Out-of-range slotLevels are clamped into 0..9
 * defensively — historic rows shouldn't trigger this, but the engine type
 * relies on it.
 */
function hydrateConcentration(
  raw: { spellSlug: string; slotLevel: number; startedRound: number } | null,
): ConcentrationState | undefined {
  if (!raw) return undefined;
  const lvl = Math.max(0, Math.min(9, Math.floor(raw.slotLevel))) as ConcentrationState['slotLevel'];
  return { spellSlug: raw.spellSlug, slotLevel: lvl, startedRound: raw.startedRound };
}

function parseSlotsUsed(raw: Record<string, number>): ActorRuntimeState['spellSlotsUsed'] {
  const out: ActorRuntimeState['spellSlotsUsed'] = {};
  for (const [k, v] of Object.entries(raw)) {
    const lvl = Number(k);
    if (lvl >= 1 && lvl <= 9 && Number.isFinite(v)) {
      (out as Record<number, number>)[lvl] = v;
    }
  }
  return out;
}

function noop(_: SessionState): void { /* keep import for type-only usage */ }
void noop;
