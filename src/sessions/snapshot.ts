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
import type {
  Bastion,
  BastionFortification,
  BastionRoom,
  BastionRoomKind,
  Character,
  ClassLevel,
  CombatActor,
  ConcentrationState,
  CraftingKind,
  CraftingProject,
  DowntimeActivity,
  DowntimeActivityKind,
  EngineState,
  ActorRuntimeState,
  EquippedFocus,
  FocusKind,
  Hireling,
  TonalFrame,
  EngagementProfile,
} from '@/engine/types';
import { isValidTonalFrame, isValidEngagementProfile } from '@/engine/npc-tonal';
import type { SnapshotForModel } from './types';

/** Defensive guard: drop legacy/garbage focus values so component validation doesn't crash. */
const VALID_FOCUS_KINDS: ReadonlySet<FocusKind> = new Set([
  'arcane',
  'druidic',
  'holy',
  'instrument',
]);

function hydrateFocus(raw: unknown): EquippedFocus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { kind?: unknown; itemSlug?: unknown };
  if (typeof r.kind !== 'string' || typeof r.itemSlug !== 'string') return undefined;
  if (!VALID_FOCUS_KINDS.has(r.kind as FocusKind)) return undefined;
  return { kind: r.kind as FocusKind, itemSlug: r.itemSlug };
}

const VALID_CRAFTING_KINDS: ReadonlySet<CraftingKind> = new Set([
  'item',
  'magic_item',
  'scroll',
  'potion',
]);

/**
 * PHB §5 + DMG: hydrate the `crafting_projects` jsonb column. Drops
 * malformed entries defensively so legacy/garbage rows can't crash the
 * tool layer (e.g. handler look-ups by id). Returns `[]` when the
 * column is null/empty.
 */
function hydrateCraftingProjects(raw: unknown): CraftingProject[] {
  if (!Array.isArray(raw)) return [];
  const clean: CraftingProject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as {
      id?: unknown;
      recipeSlug?: unknown;
      kind?: unknown;
      daysRemaining?: unknown;
      gpSpent?: unknown;
      startedRound?: unknown;
    };
    if (typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.recipeSlug !== 'string' || !r.recipeSlug) continue;
    if (typeof r.kind !== 'string' || !VALID_CRAFTING_KINDS.has(r.kind as CraftingKind)) continue;
    const days = typeof r.daysRemaining === 'number' && Number.isFinite(r.daysRemaining)
      ? Math.max(0, Math.floor(r.daysRemaining))
      : null;
    if (days == null) continue;
    const gp = typeof r.gpSpent === 'number' && Number.isFinite(r.gpSpent)
      ? Math.max(0, Math.floor(r.gpSpent))
      : 0;
    const project: CraftingProject = {
      id: r.id,
      recipeSlug: r.recipeSlug,
      kind: r.kind as CraftingKind,
      daysRemaining: days,
      gpSpent: gp,
    };
    if (typeof r.startedRound === 'number' && Number.isFinite(r.startedRound)) {
      project.startedRound = Math.floor(r.startedRound);
    }
    clean.push(project);
  }
  return clean;
}

// ─── Phase 13 (PHB §6 + 2024 PHB Bastion) defensive hydrators ─────────────

const VALID_DOWNTIME_KINDS_SET: ReadonlySet<DowntimeActivityKind> = new Set([
  'practicing_profession',
  'recuperating',
  'researching',
  'training',
  'crafting',
]);

/**
 * PHB §6 — hydrate the `downtime_activities` jsonb column. Drops
 * malformed entries defensively so legacy/garbage rows can't crash the
 * tool layer (e.g. handler look-ups by id). Returns `[]` when the
 * column is null/empty.
 */
function hydrateDowntimeActivities(raw: unknown): DowntimeActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: DowntimeActivity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<DowntimeActivity>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (
      typeof r.kind !== 'string' ||
      !VALID_DOWNTIME_KINDS_SET.has(r.kind as DowntimeActivityKind)
    ) continue;
    if (typeof r.daysRemaining !== 'number' || !Number.isFinite(r.daysRemaining)) continue;
    const gp =
      typeof r.gpSpent === 'number' && Number.isFinite(r.gpSpent)
        ? Math.max(0, Math.floor(r.gpSpent))
        : 0;
    const entry: DowntimeActivity = {
      id: r.id,
      kind: r.kind as DowntimeActivityKind,
      daysRemaining: Math.max(0, Math.floor(r.daysRemaining)),
      gpSpent: gp,
    };
    if (typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)) {
      entry.startedAt = Math.floor(r.startedAt);
    }
    out.push(entry);
  }
  return out;
}

const VALID_HIRELING_KINDS_SET: ReadonlySet<Hireling['kind']> = new Set([
  'skilled',
  'unskilled',
]);

function hydrateHirelings(raw: unknown): Hireling[] {
  if (!Array.isArray(raw)) return [];
  const out: Hireling[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<Hireling>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (
      typeof r.kind !== 'string' ||
      !VALID_HIRELING_KINDS_SET.has(r.kind as Hireling['kind'])
    ) continue;
    if (typeof r.count !== 'number' || !Number.isFinite(r.count)) continue;
    if (typeof r.days !== 'number' || !Number.isFinite(r.days)) continue;
    const gpCost =
      typeof r.gpCost === 'number' && Number.isFinite(r.gpCost) ? Math.max(0, Math.floor(r.gpCost)) : 0;
    const spCost =
      typeof r.spCost === 'number' && Number.isFinite(r.spCost) ? Math.max(0, Math.floor(r.spCost)) : 0;
    const entry: Hireling = {
      id: r.id,
      kind: r.kind as Hireling['kind'],
      count: Math.max(0, Math.floor(r.count)),
      days: Math.max(0, Math.floor(r.days)),
      gpCost,
      spCost,
    };
    if (typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)) {
      entry.startedAt = Math.floor(r.startedAt);
    }
    out.push(entry);
  }
  return out;
}

const VALID_BASTION_FORTIFICATIONS_SET: ReadonlySet<BastionFortification> = new Set([
  'modest',
  'fortified',
  'castle',
]);

const VALID_BASTION_ROOM_KINDS_SET: ReadonlySet<BastionRoomKind> = new Set([
  'workshop',
  'library',
  'armory',
  'stable',
  'garden',
  'storage',
  'training',
  'shrine',
  'kitchen',
  'guesthouse',
]);

function hydrateBastion(raw: unknown): Bastion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<Bastion>;
  if (typeof r.name !== 'string') return undefined;
  if (
    typeof r.fortification !== 'string' ||
    !VALID_BASTION_FORTIFICATIONS_SET.has(r.fortification as BastionFortification)
  ) return undefined;
  if (typeof r.defenders !== 'number' || !Number.isFinite(r.defenders)) return undefined;
  const rooms: BastionRoom[] = [];
  if (Array.isArray(r.rooms)) {
    for (const room of r.rooms) {
      if (!room || typeof room !== 'object') continue;
      const rm = room as Partial<BastionRoom>;
      if (
        typeof rm.kind !== 'string' ||
        !VALID_BASTION_ROOM_KINDS_SET.has(rm.kind as BastionRoomKind)
      ) continue;
      const lvl =
        typeof rm.level === 'number' && [1, 2, 3].includes(Math.floor(rm.level))
          ? (Math.floor(rm.level) as BastionRoom['level'])
          : null;
      if (lvl == null) continue;
      rooms.push({ kind: rm.kind as BastionRoomKind, level: lvl });
    }
  }
  return {
    name: r.name,
    fortification: r.fortification as BastionFortification,
    rooms,
    defenders: Math.max(0, Math.floor(r.defenders)),
  };
}

/**
 * PHB §2.5 — hydrate the `classes` jsonb column. Validates each entry has a
 * string `slug` and a positive integer `level`; drops malformed entries
 * defensively. If the column is empty or has no valid entries, backfill a
 * single entry from the legacy `classSlug` + `level` fields so downstream
 * code can rely on `classes[0]` always existing.
 */
function hydrateClasses(
  raw: unknown,
  fallbackClassSlug: string,
  fallbackLevel: number,
): ClassLevel[] {
  if (Array.isArray(raw)) {
    const clean: ClassLevel[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as { slug?: unknown; level?: unknown; subclass?: unknown };
      if (typeof r.slug !== 'string' || !r.slug) continue;
      const lvl = typeof r.level === 'number' && r.level >= 1 ? Math.floor(r.level) : null;
      if (lvl == null) continue;
      const entry: ClassLevel = { slug: r.slug, level: lvl };
      if (typeof r.subclass === 'string' && r.subclass) entry.subclass = r.subclass;
      clean.push(entry);
    }
    if (clean.length > 0) return clean;
  }
  // Legacy / empty column: backfill from classSlug + level so the engine
  // always sees a single-class breakdown that matches the row.
  return [{ slug: fallbackClassSlug, level: Math.max(1, Math.floor(fallbackLevel || 1)) }];
}

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

  // PHB §2.5 — hydrate the multi-class breakdown. We backfill from the legacy
  // classSlug+level when the column is empty so downstream engine code can
  // always rely on `classes[0]`. The primary classSlug stays as the legacy
  // alias for callers that don't yet read `classes`.
  const classes = hydrateClasses(character.classes, character.classSlug, character.level);
  const primaryClassSlug = classes[0]?.slug ?? character.classSlug;

  const characters: Character[] = [
    {
      id: character.id,
      name: character.name,
      level: character.level,
      xp: character.xp,
      classSlug: primaryClassSlug,
      classes,
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
      // PHB §10.1: hydrate from the persisted column. The DB default is `[]`
      // but historic rows pre-migration may surface as null/undefined; the
      // `??` keeps the engine-side type non-nullable.
      attunedItems: Array.isArray(character.attunedItems) ? character.attunedItems : [],
      hitDiceMax: character.hitDiceMax,
      hitDieSize: character.hitDieSize,
      // PHB §6.4 — hydrate the optional Senses column. NULL → undefined so
      // the engine type's optional field reads as absent.
      senses: character.senses ?? undefined,
      // PHB §8.4 — hydrate the equipped focus. We validate the kind
      // against the FocusKind union so a corrupt/legacy value can't
      // crash component validation downstream.
      equippedFocus: hydrateFocus(character.equippedFocus),
      // PHB §5 + DMG — hydrate in-flight crafting projects. Defaults to
      // [] so callers can rely on the array always being present even
      // when the row predates the column.
      craftingProjects: hydrateCraftingProjects(character.craftingProjects),
      // PHB §6 — Phase 13 downtime activities. Defaults to [] so legacy
      // rows pre-migration still typecheck.
      downtimeActivities: hydrateDowntimeActivities(character.downtimeActivities),
      // PHB §6 — Phase 13 hireling roster. Defaults to [].
      hirelings: hydrateHirelings(character.hirelings),
      // 2024 PHB simplified Bastion. NULL → undefined so the optional
      // field reads as absent on the engine type.
      bastion: hydrateBastion(character.bastion),
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

  // Master World Lore §5.1 + Master Handbook §2.1 — hydrate the
  // session-level tonal frame and engagement profile. The frame is a
  // single string in the DB; we validate it against the typed union and
  // drop unknown values defensively (forward-compat with legacy data).
  // The engagement profile is a jsonb array; same defensive filter.
  const tonalFrame: TonalFrame | undefined =
    typeof session.tonalFrame === 'string' && isValidTonalFrame(session.tonalFrame)
      ? session.tonalFrame
      : undefined;
  const engagementProfile: EngagementProfile[] = Array.isArray(session.engagementProfile)
    ? (session.engagementProfile.filter((p): p is EngagementProfile =>
        typeof p === 'string' && isValidEngagementProfile(p),
      ) as EngagementProfile[])
    : [];

  const state: EngineState = {
    characters,
    combatActors,
    runtime,
    combat: stateRow.combat ?? null,
    scene: stateRow.scene,
    // PHB §6 — hydrate exploration/travel state if persisted. NULL means
    // the session has no explicit travel context (combat or default scene).
    travel: stateRow.travel ?? undefined,
    tonalFrame,
    engagementProfile,
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
    class: primaryClassSlug,
    // PHB §2.5: always show the full multi-class breakdown; for a single-
    // class PC this is just `[{slug, level}]`. The master uses this to gate
    // multiclass actions and combine spell slots.
    classes,
    race: character.raceSlug,
    hp: `${stateRow.hpCurrent}/${character.hpMax}`,
    ac: character.ac,
    abilities: character.abilities,
    saves: character.proficiencies.saves,
    skills: character.proficiencies.skills,
    conditions: stateRow.conditions,
    inCombat: stateRow.inCombat,
    inventory: character.inventory,
    // PHB §10.1: master sees the current attunement list so it can self-check
    // the cap (max 3) before calling `attune`.
    attunedItems: Array.isArray(character.attunedItems) ? character.attunedItems : [],
    // PHB §8.4: master sees the currently held focus so it can decide
    // whether to call equip_focus / unequip_focus or pass freeHand=false
    // when both hands are occupied AND no focus is held.
    equippedFocus: hydrateFocus(character.equippedFocus) ?? null,
    // PHB §5 + DMG: master sees in-flight crafting projects so it can
    // narrate downtime progress (e.g. "you've already spent 12 days on
    // your longsword — 18 to go") and decide which project to address.
    craftingProjects: hydrateCraftingProjects(character.craftingProjects),
    // PHB §6 (Phase 13): master sees pending downtime activities and
    // hirelings + the optional Bastion so it can narrate the ledger
    // and time-stamp completion.
    downtimeActivities: hydrateDowntimeActivities(character.downtimeActivities),
    hirelings: hydrateHirelings(character.hirelings),
    bastion: hydrateBastion(character.bastion) ?? null,
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
    // PHB §6.4 — special senses (NULL when the actor has none).
    senses: row.senses ?? undefined,
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
