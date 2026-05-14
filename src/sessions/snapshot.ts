import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessions as sessionsTable,
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  characters as charactersTable,
  campaigns as campaignsTable,
  type SessionState,
  type CombatActor as CombatActorRow,
  type Character as CharacterDbRow,
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
  MountedState,
  Size,
  TonalFrame,
  EngagementProfile,
} from '@/engine/types';
import { isValidMountMode, isValidSize } from '@/engine/mounts';
import { isValidVehicleSlug } from '@/engine/vehicles';
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

// ─── Phase 14 (PHB §3.23, §9.6) defensive hydrators ────────────────────────

/**
 * PHB §3.23 — hydrate the `mounted_on` jsonb column. Drops malformed
 * entries defensively so a corrupt mode/value can't crash the tool layer.
 * Returns `undefined` when the column is null/empty.
 */
function hydrateMountedOn(raw: unknown): MountedState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<MountedState>;
  if (typeof r.mountId !== 'string' || !r.mountId) return undefined;
  if (!isValidMountMode(r.mode)) return undefined;
  return { mountId: r.mountId, mode: r.mode };
}

/**
 * PHB §9.6 — hydrate the `embarked_on` text column. Returns the slug only
 * when it matches a known vehicle in `VEHICLE_CATALOG`; otherwise drops
 * the value defensively (forward-compat with legacy data).
 */
function hydrateEmbarkedOn(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return isValidVehicleSlug(raw) ? raw : undefined;
}

/**
 * PHB §1 / monster manual sizing — hydrate the `size` varchar column on a
 * combat actor. Drops unknown sizes defensively so the master can't be
 * tripped by a corrupt value.
 */
function hydrateSize(raw: unknown): Size | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return isValidSize(raw) ? raw : undefined;
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

/**
 * Turn a `characters` table row into the engine-shape `Character` object the
 * tool handlers operate on. Shared between the active-PG hydration and the
 * multiplayer party hydration so every party member receives the same
 * defensive treatment (focus, crafting projects, hirelings, bastion, mounted/
 * embarked state, etc.).
 */
function hydrateEngineCharacter(
  row: CharacterDbRow,
  classes: ClassLevel[],
  primaryClassSlug: string,
): Character {
  return {
    id: row.id,
    name: row.name,
    level: row.level,
    xp: row.xp,
    classSlug: primaryClassSlug,
    classes,
    raceSlug: row.raceSlug,
    backgroundSlug: row.backgroundSlug,
    abilities: row.abilities,
    proficiencyBonus: row.proficiencyBonus,
    hpMax: row.hpMax,
    ac: row.ac,
    speed: row.speed,
    proficiencies: row.proficiencies as Character['proficiencies'],
    inspiration: row.inspiration ?? false,
    spellcasting: row.spellcasting as Character['spellcasting'],
    features: row.features as Character['features'],
    inventory: row.inventory,
    // PHB §10.1: hydrate from the persisted column. The DB default is `[]`
    // but historic rows pre-migration may surface as null/undefined; the
    // `??` keeps the engine-side type non-nullable.
    attunedItems: Array.isArray(row.attunedItems) ? row.attunedItems : [],
    hitDiceMax: row.hitDiceMax,
    hitDieSize: row.hitDieSize,
    // PHB §6.4 — hydrate the optional Senses column. NULL → undefined so
    // the engine type's optional field reads as absent.
    senses: row.senses ?? undefined,
    // PHB §8.4 — hydrate the equipped focus. We validate the kind
    // against the FocusKind union so a corrupt/legacy value can't
    // crash component validation downstream.
    equippedFocus: hydrateFocus(row.equippedFocus),
    // PHB §5 + DMG — hydrate in-flight crafting projects. Defaults to
    // [] so callers can rely on the array always being present even
    // when the row predates the column.
    craftingProjects: hydrateCraftingProjects(row.craftingProjects),
    // PHB §6 — Phase 13 downtime activities. Defaults to [] so legacy
    // rows pre-migration still typecheck.
    downtimeActivities: hydrateDowntimeActivities(row.downtimeActivities),
    // PHB §6 — Phase 13 hireling roster. Defaults to [].
    hirelings: hydrateHirelings(row.hirelings),
    // 2024 PHB simplified Bastion. NULL → undefined so the optional
    // field reads as absent on the engine type.
    bastion: hydrateBastion(row.bastion),
    // PHB §3.23 — Phase 14 mounted state. Defaults to undefined when
    // the column is null / malformed; the tool layer treats absence
    // as "on foot".
    mountedOn: hydrateMountedOn(row.mountedOn),
    // PHB §9.6 — Phase 14 vehicle embarkation. Slug into the
    // catalog; undefined when not embarked.
    embarkedOn: hydrateEmbarkedOn(row.embarkedOn),
  };
}

export async function buildSnapshot(sessionId: string, userId: string): Promise<SnapshotForModel> {
  // Note: no userId filter here — multiplayer guests need to load the snapshot
  // of a session they don't own. Route-level checkPartyAccess gates who can
  // request this. `userId` is used below to identify the viewer's own
  // character in the party.
  const [row] = await db
    .select({ session: sessionsTable, campaign: campaignsTable })
    .from(sessionsTable)
    .innerJoin(campaignsTable, eq(campaignsTable.id, sessionsTable.campaignId))
    .where(and(eq(sessionsTable.id, sessionId), isNull(sessionsTable.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`buildSnapshot: session ${sessionId} not found (viewer ${userId})`);
  const { session, campaign } = row;

  // Multiplayer: in a party, the master should see the stats of whoever is
  // currently acting (cpcId), not always the host. Falls back to the legacy
  // session.characterId for solo sessions and edge cases where the migration
  // hasn't backfilled cpcId yet.
  const activeCharacterId = session.currentPlayerCharacterId ?? session.characterId;
  const [character] = await db.select().from(charactersTable).where(eq(charactersTable.id, activeCharacterId)).limit(1);
  if (!character) throw new Error(`buildSnapshot: character ${activeCharacterId} not found`);

  // Multiplayer — fetch all instance characters for this campaign so consumers
  // can render the full party roster and identify each player's character.
  const partyRows = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.campaignId, session.campaignId),
      isNull(charactersTable.deletedAt),
      isNotNull(charactersTable.templateId),
    ))
    .orderBy(charactersTable.createdAt);

  // The viewing user's own character within the party (may be null for
  // spectators or in edge cases where the instance row hasn't been created).
  const viewerChar: CharacterDbRow | null = partyRows.find((c) => c.userId === userId) ?? null;

  const [stateRow] = await db.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
  if (!stateRow) throw new Error(`buildSnapshot: session_state for ${sessionId} not found`);

  const actorRows = await db.select().from(combatActorsTable).where(eq(combatActorsTable.sessionId, sessionId));

  // PHB §2.5 — hydrate the multi-class breakdown. We backfill from the legacy
  // classSlug+level when the column is empty so downstream engine code can
  // always rely on `classes[0]`. The primary classSlug stays as the legacy
  // alias for callers that don't yet read `classes`.
  const classes = hydrateClasses(character.classes, character.classSlug, character.level);
  const primaryClassSlug = classes[0]?.slug ?? character.classSlug;

  // In a multiplayer party the engine needs every PG visible in
  // `state.characters` so cross-character tools (e.g. `add_item(actor:
  // <kank_uuid>)` while Bruce is active during a "give item" beat) can
  // resolve the target. The active PG is kept at index 0 to preserve
  // legacy callers that read `state.characters[0]` as "the PC" (e.g.
  // `addNarrativeItem`). In solo mode the array stays single-element.
  const characters: Character[] = [
    hydrateEngineCharacter(character, classes, primaryClassSlug),
    ...partyRows
      .filter((r) => r.id !== character.id)
      .map((r) => {
        const otherClasses = hydrateClasses(r.classes, r.classSlug, r.level);
        const otherPrimary = otherClasses[0]?.slug ?? r.classSlug;
        return hydrateEngineCharacter(r, otherClasses, otherPrimary);
      }),
  ];

  const combatActors: CombatActor[] = actorRows.map(toEngineCombatActor);

  const runtime: Record<string, ActorRuntimeState> = {};
  // Active PG's full runtime — HP / conditions / death saves / etc. still
  // live on session_state (per-session). Spell slots and class resources
  // are now read per-PG from `characters` so the active PG sees their own
  // ledger even after a turn swap.
  runtime[character.id] = {
    actorId: character.id,
    hpCurrent: stateRow.hpCurrent,
    tempHp: stateRow.tempHp,
    deathSaves: stateRow.deathSaves ?? { successes: 0, failures: 0 },
    flags: stateRow.flags ?? {},
    exhaustionLevel: stateRow.exhaustionLevel ?? 0,
    conditions: stateRow.conditions as ActorRuntimeState['conditions'],
    hitDiceRemaining: stateRow.hitDiceRemaining,
    spellSlotsUsed: parseSlotsUsed(character.spellSlotsUsed),
    resourcesUsed: (character.resourcesUsed ?? {}) as Record<string, number>,
    concentratingOn: hydrateConcentration(stateRow.concentratingOn),
    turnState: stateRow.turnState ?? undefined,
    position: stateRow.position ?? undefined,
  };
  // Non-active party members get a sparse runtime: their per-PG slot and
  // resource ledgers (so the UI can render their spell-slot tiles and so
  // `long_rest` can target their actorId), with HP / death-saves left at
  // safe defaults until the day per-PG runtime moves off session_state too.
  for (const p of partyRows) {
    if (p.id === character.id) continue;
    runtime[p.id] = {
      actorId: p.id,
      hpCurrent: p.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
      hitDiceRemaining: p.hitDiceMax,
      spellSlotsUsed: parseSlotsUsed(p.spellSlotsUsed),
      resourcesUsed: (p.resourcesUsed ?? {}) as Record<string, number>,
    };
  }
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
  // campaign-level tonal frame and engagement profile (canonical source
  // since Task 15; session columns are deprecated). The frame is a
  // single string in the DB; we validate it against the typed union and
  // drop unknown values defensively (forward-compat with legacy data).
  // The engagement profile is a jsonb array; same defensive filter.
  const tonalFrame: TonalFrame | undefined =
    typeof campaign.tonalFrame === 'string' && isValidTonalFrame(campaign.tonalFrame)
      ? campaign.tonalFrame
      : undefined;
  const engagementProfile: EngagementProfile[] = Array.isArray(campaign.engagementProfile)
    ? (campaign.engagementProfile.filter((p): p is EngagementProfile =>
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
    // PHB §3.23 / §9.6 (Phase 14): master sees current mount + vehicle
    // state so it can decide whether the PC needs to dismount before
    // moving away on foot, or before engaging in combat off-vehicle.
    mountedOn: hydrateMountedOn(character.mountedOn) ?? null,
    embarkedOn: hydrateEmbarkedOn(character.embarkedOn) ?? null,
    spellSlots: buildSpellSlotsView(character.spellcasting as Character['spellcasting'], stateRow.spellSlotsUsed),
  });

  return {
    state,
    characterMonoSpace,
    scene: stateRow.scene,
    language: campaign.language,
    // Multiplayer additions — backward-compatible; existing consumers that only
    // destructure the four fields above continue to work unchanged.
    party: partyRows,
    currentPlayerCharacterId: session.currentPlayerCharacterId,
    viewerCharacterId: viewerChar?.id ?? null,
  };
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
    // PHB §1 / monster manual sizing — Phase 14 mount validation.
    // Validated defensively so a corrupt value reads as "no size data"
    // and the master falls back to permissive behaviour.
    size: hydrateSize(row.size),
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
