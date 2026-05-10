import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, combatActors, diceLog, characters } from '@/db/schema';
import { applyMutations } from '@/sessions/applicator';
import type { Mutation, DiceRoll } from '@/engine/types';

const TEST_USER = 'user_app_' + Date.now();
let SESSION_ID = '';
let PC_ID = '';
let MONSTER_ID = '';

describe('applyMutations', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tharion';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    PC_ID = charId;
    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'x' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 11, hitDiceRemaining: 1 });
    const [m] = await db.insert(combatActors).values({ sessionId: SESSION_ID, name: 'Goblin', monsterSlug: 'goblin', hpCurrent: 7, hpMax: 7 }).returning();
    MONSTER_ID = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from dice_log where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from combat_actors where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('apply_damage to a monster reduces combat_actors.hp_current', async () => {
    const muts: Mutation[] = [{ op: 'apply_damage', actorId: MONSTER_ID, amount: 3, type: 'slashing' }];
    await applyMutations(SESSION_ID, muts, []);
    const [row] = await db.select().from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
    expect(row!.hpCurrent).toBe(4);
  });

  it('set_hp on the PC writes session_state.hp_current', async () => {
    const muts: Mutation[] = [{ op: 'set_hp', actorId: PC_ID, hpCurrent: 8 }];
    await applyMutations(SESSION_ID, muts, []);
    const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    expect(row!.hpCurrent).toBe(8);
  });

  it('persists dice rolls into dice_log', async () => {
    const rolls: DiceRoll[] = [
      { formula: '1d20+5', rolls: [14], modifier: 5, total: 19, meta: { kind: 'attack', target: MONSTER_ID } },
      { formula: '1d8+3', rolls: [4], modifier: 3, total: 7, meta: { kind: 'damage' } },
    ];
    await applyMutations(SESSION_ID, [], rolls);
    const persisted = await db.select().from(diceLog).where(eq(diceLog.sessionId, SESSION_ID));
    expect(persisted.length).toBe(2);
    expect(persisted.find((r) => r.formula === '1d20+5')?.kind).toBe('attack');
    expect(persisted.find((r) => r.formula === '1d8+3')?.kind).toBe('damage');
  });

  it('apply_condition appends to combat_actors.conditions jsonb', async () => {
    const muts: Mutation[] = [{ op: 'add_condition', actorId: MONSTER_ID, condition: { slug: 'poisoned', source: 'spider bite', durationRounds: 3, appliedRound: 1 } }];
    await applyMutations(SESSION_ID, muts, []);
    const [row] = await db.select().from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
    expect((row!.conditions as { slug: string }[]).some((c) => c.slug === 'poisoned')).toBe(true);
  });

  it('level_up persists new level + hpMax + proficiencyBonus and heals the PC by hpDelta', async () => {
    // Pre-condition: PC at level 1, hpMax 11, hpCurrent 8 (from earlier test).
    // The level_up mutation bumps level to 5, adds 18 hp, expects PB to land
    // at +3 (the SRD bracket for levels 5-8).
    const muts: Mutation[] = [
      { op: 'level_up', characterId: PC_ID, newLevel: 5, hpDelta: 18 },
    ];
    await applyMutations(SESSION_ID, muts, []);

    const [char] = await db.select().from(characters).where(eq(characters.id, PC_ID)).limit(1);
    expect(char!.level).toBe(5);
    expect(char!.hpMax).toBe(11 + 18); // 29
    expect(char!.proficiencyBonus).toBe(3);

    const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
    // Was at hpCurrent 8 (from set_hp test), healed by 18 → 26, capped at new max 29.
    expect(state!.hpCurrent).toBe(8 + 18);
  });

  it('add_inventory + remove_inventory + set_equipped persist to characters.inventory', { timeout: 15000 }, async () => {
    // PC starts with the soldier background's 10 gp baseline + soldier
    // common clothes (Phase B.6 wizard derivation seeds the inventory).
    // Each assertion accounts for the 10 gp baseline.
    await applyMutations(SESSION_ID, [
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'longbow', qty: 1 },
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 50 },
    ], []);
    let [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    let inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'longbow')).toMatchObject({ qty: 1, equipped: false });
    expect(inv.find((i) => i.slug === 'gp')).toMatchObject({ qty: 60 });    // 10 baseline + 50

    // Add 25 more gp — should stack
    await applyMutations(SESSION_ID, [
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 25 },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'gp')!.qty).toBe(85);                  // 60 + 25

    // Equip the longbow
    await applyMutations(SESSION_ID, [
      { op: 'set_equipped', characterId: PC_ID, itemSlug: 'longbow', equipped: true },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'longbow')!.equipped).toBe(true);

    // Spend 30 gp — qty drops to 55
    await applyMutations(SESSION_ID, [
      { op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 30 },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'gp')!.qty).toBe(55);                  // 85 - 30

    // Remove all remaining gp — entry disappears entirely
    await applyMutations(SESSION_ID, [
      { op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 100 },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'gp')).toBeUndefined();
  });

  it('award_xp adds the amount to characters.xp atomically', async () => {
    const [before] = await db.select({ xp: characters.xp }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    const startXp = before!.xp;

    await applyMutations(SESSION_ID, [
      { op: 'award_xp', characterId: PC_ID, amount: 250, reason: 'killed the goblin' },
    ], []);

    const [after] = await db.select({ xp: characters.xp }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    expect(after!.xp).toBe(startXp + 250);
  });

  describe('applicator — death_save mutation', () => {
    // Helper: reset session_state so each death-save test starts clean.
    async function resetDeathSaves(opts: { conditions?: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[] } = {}) {
      await db
        .update(sessionState)
        .set({
          deathSaves: { successes: 0, failures: 0 },
          flags: {},
          conditions: opts.conditions ?? [],
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }
    async function setDeathSaves(successes: number, failures: number) {
      await db
        .update(sessionState)
        .set({ deathSaves: { successes, failures }, flags: {} })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }

    it('success increments successes counter', async () => {
      await resetDeathSaves();
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: true },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 1, failures: 0 });
      expect(s!.flags).toEqual({});
    });

    it('3 successes → stable, counters reset, unconscious added', async () => {
      await setDeathSaves(2, 0);
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: true },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 0, failures: 0 });
      expect(s!.flags).toMatchObject({ stable: true });
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'unconscious')).toBe(true);
    });

    it('does not duplicate unconscious if already present when becoming stable', async () => {
      await db
        .update(sessionState)
        .set({
          deathSaves: { successes: 2, failures: 0 },
          flags: {},
          conditions: [{ slug: 'unconscious', source: 'prior knockout', durationRounds: 'until_removed', appliedRound: 0 }],
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: true },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.filter((c) => c.slug === 'unconscious').length).toBe(1);
    });

    it('3 failures → dead, counters frozen at 0/3', async () => {
      await setDeathSaves(0, 2);
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: false },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 0, failures: 3 });
      expect(s!.flags).toMatchObject({ dead: true });
    });

    it('crit failure counts as 2', async () => {
      await setDeathSaves(0, 0);
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: false, isCrit: true },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 0, failures: 2 });
      expect(s!.flags).toEqual({});
    });

    it('crit failure caps at 3 and marks dead', async () => {
      await setDeathSaves(0, 2);
      await applyMutations(SESSION_ID, [
        { op: 'death_save', actorId: PC_ID, success: false, isCrit: true },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 0, failures: 3 });
      expect(s!.flags).toMatchObject({ dead: true });
    });

    it('reset_death_saves clears counters but does not touch flags', async () => {
      await db
        .update(sessionState)
        .set({
          deathSaves: { successes: 2, failures: 1 },
          flags: { stable: true },
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
      await applyMutations(SESSION_ID, [
        { op: 'reset_death_saves', actorId: PC_ID },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.deathSaves).toEqual({ successes: 0, failures: 0 });
      // flags untouched
      expect(s!.flags).toMatchObject({ stable: true });
    });
  });

  describe('exhaustion stacking', () => {
    // Helper: reset session_state into a clean slate per test. We zero
    // exhaustion_level, drop any prior exhaustion entries, and clear the
    // flags so dead/stable from death-save tests don't leak into ours.
    async function resetExhaustion(level: number = 0, hasCondition: boolean = false) {
      const conditions = hasCondition
        ? [{ slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed' as const, appliedRound: 0 }]
        : [];
      await db
        .update(sessionState)
        .set({
          exhaustionLevel: level,
          conditions,
          flags: {},
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }

    it('first add_condition exhaustion → level 1, condition added once', async () => {
      await resetExhaustion(0, false);
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed', appliedRound: 0 },
        },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(1);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.filter((c) => c.slug === 'exhaustion').length).toBe(1);
    });

    it('second add_condition exhaustion → level 2, condition still present once', async () => {
      await resetExhaustion(1, true);
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'exhaustion', source: 'starvation', durationRounds: 'until_removed', appliedRound: 0 },
        },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(2);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.filter((c) => c.slug === 'exhaustion').length).toBe(1);
    });

    it('exhaustion stacking caps at 6', async () => {
      await resetExhaustion(5, true);
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'exhaustion', source: 'curse', durationRounds: 'until_removed', appliedRound: 0 },
        },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(6);
      // Adding a 7th does NOT push past 6.
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'exhaustion', source: 'extra', durationRounds: 'until_removed', appliedRound: 0 },
        },
      ], []);
      const [s2] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s2!.exhaustionLevel).toBe(6);
    });

    it('exhaustion level 6 sets flags.dead', async () => {
      await resetExhaustion(5, true);
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'exhaustion', source: 'curse', durationRounds: 'until_removed', appliedRound: 0 },
        },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(6);
      expect(s!.flags).toMatchObject({ dead: true });
    });

    it('remove_condition exhaustion decrements level by 1, condition stays while > 0', async () => {
      await resetExhaustion(3, true);
      await applyMutations(SESSION_ID, [
        { op: 'remove_condition', actorId: PC_ID, conditionSlug: 'exhaustion' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(2);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'exhaustion')).toBe(true);
    });

    it('remove_condition exhaustion at level 1 → level 0, condition removed from array', async () => {
      await resetExhaustion(1, true);
      await applyMutations(SESSION_ID, [
        { op: 'remove_condition', actorId: PC_ID, conditionSlug: 'exhaustion' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(0);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'exhaustion')).toBe(false);
    });

    it('remove_condition exhaustion at level 0 is a no-op', async () => {
      await resetExhaustion(0, false);
      await applyMutations(SESSION_ID, [
        { op: 'remove_condition', actorId: PC_ID, conditionSlug: 'exhaustion' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(0);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'exhaustion')).toBe(false);
    });

    it('non-exhaustion add_condition does not touch exhaustionLevel', async () => {
      await resetExhaustion(2, true);
      await applyMutations(SESSION_ID, [
        {
          op: 'add_condition',
          actorId: PC_ID,
          condition: { slug: 'poisoned', source: 'venom', durationRounds: 3, appliedRound: 1 },
        },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(2);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'poisoned')).toBe(true);
      expect(conds.some((c) => c.slug === 'exhaustion')).toBe(true);
    });

    it('non-exhaustion remove_condition does not touch exhaustionLevel', async () => {
      // start with both poisoned and exhaustion present, exhaustionLevel=2.
      await db
        .update(sessionState)
        .set({
          exhaustionLevel: 2,
          conditions: [
            { slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed', appliedRound: 0 },
            { slug: 'poisoned', source: 'venom', durationRounds: 3, appliedRound: 1 },
          ],
          flags: {},
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
      await applyMutations(SESSION_ID, [
        { op: 'remove_condition', actorId: PC_ID, conditionSlug: 'poisoned' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.exhaustionLevel).toBe(2);
      const conds = s!.conditions as { slug: string }[];
      expect(conds.some((c) => c.slug === 'poisoned')).toBe(false);
      expect(conds.some((c) => c.slug === 'exhaustion')).toBe(true);
    });
  });

  describe('applicator — inspiration', () => {
    // Helper: reset PC inspiration to false so each test starts clean.
    async function resetInspiration(value: boolean = false) {
      await db
        .update(characters)
        .set({ inspiration: value })
        .where(eq(characters.id, PC_ID));
    }

    it('grant_inspiration sets characters.inspiration=true', async () => {
      await resetInspiration(false);
      await applyMutations(SESSION_ID, [
        { op: 'grant_inspiration', characterId: PC_ID },
      ], []);
      const [c] = await db.select({ insp: characters.inspiration }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.insp).toBe(true);
    });

    it('grant_inspiration when already inspired stays true (idempotent)', async () => {
      await resetInspiration(true);
      await applyMutations(SESSION_ID, [
        { op: 'grant_inspiration', characterId: PC_ID },
      ], []);
      const [c] = await db.select({ insp: characters.inspiration }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.insp).toBe(true);
    });

    it('spend_inspiration sets characters.inspiration=false', async () => {
      await resetInspiration(true);
      await applyMutations(SESSION_ID, [
        { op: 'spend_inspiration', characterId: PC_ID },
      ], []);
      const [c] = await db.select({ insp: characters.inspiration }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.insp).toBe(false);
    });

    it('grant + spend round-trip lands at false', async () => {
      await resetInspiration(false);
      await applyMutations(SESSION_ID, [
        { op: 'grant_inspiration', characterId: PC_ID },
      ], []);
      let [c] = await db.select({ insp: characters.inspiration }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.insp).toBe(true);

      await applyMutations(SESSION_ID, [
        { op: 'spend_inspiration', characterId: PC_ID },
      ], []);
      [c] = await db.select({ insp: characters.inspiration }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.insp).toBe(false);
    });

    it('set_long_rest_at writes the timestamp to session_state', async () => {
      // Reset the column first
      await db
        .update(sessionState)
        .set({ lastLongRestAt: null })
        .where(eq(sessionState.sessionId, SESSION_ID));

      const epochMs = 1_700_000_000_000;
      await applyMutations(SESSION_ID, [
        { op: 'set_long_rest_at', epochMs },
      ], []);
      const [s] = await db.select({ lastLongRestAt: sessionState.lastLongRestAt }).from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.lastLongRestAt).toBeInstanceOf(Date);
      expect(s!.lastLongRestAt!.getTime()).toBe(epochMs);
    });

    it('set_long_rest_at overwrites a previous timestamp', async () => {
      const first = 1_700_000_000_000;
      const second = 1_700_086_400_000; // 24h later
      await applyMutations(SESSION_ID, [
        { op: 'set_long_rest_at', epochMs: first },
      ], []);
      await applyMutations(SESSION_ID, [
        { op: 'set_long_rest_at', epochMs: second },
      ], []);
      const [s] = await db.select({ lastLongRestAt: sessionState.lastLongRestAt }).from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.lastLongRestAt!.getTime()).toBe(second);
    });
  });

  describe('applicator — attunement (PHB §10.1)', () => {
    // Helper: reset attunedItems to a known list before each test.
    async function resetAttuned(items: string[] = []) {
      await db
        .update(characters)
        .set({ attunedItems: items })
        .where(eq(characters.id, PC_ID));
    }

    async function readAttuned(): Promise<string[]> {
      const [c] = await db
        .select({ attunedItems: characters.attunedItems })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c?.attunedItems ?? []) as string[];
    }

    it('attune appends the slug when not already present', async () => {
      await resetAttuned([]);
      await applyMutations(SESSION_ID, [
        { op: 'attune', characterId: PC_ID, itemSlug: 'cloak-of-protection' },
      ], []);
      expect(await readAttuned()).toEqual(['cloak-of-protection']);
    });

    it('attune is a no-op when the slug is already attuned', async () => {
      await resetAttuned(['cloak-of-protection']);
      await applyMutations(SESSION_ID, [
        { op: 'attune', characterId: PC_ID, itemSlug: 'cloak-of-protection' },
      ], []);
      expect(await readAttuned()).toEqual(['cloak-of-protection']);
    });

    it('attune preserves existing entries when adding a new one', async () => {
      await resetAttuned(['cloak-of-protection', 'ring-of-protection']);
      await applyMutations(SESSION_ID, [
        { op: 'attune', characterId: PC_ID, itemSlug: 'amulet-of-health' },
      ], []);
      expect(await readAttuned()).toEqual([
        'cloak-of-protection',
        'ring-of-protection',
        'amulet-of-health',
      ]);
    });

    it('unattune removes the slug from the list', async () => {
      await resetAttuned(['cloak-of-protection', 'ring-of-protection']);
      await applyMutations(SESSION_ID, [
        { op: 'unattune', characterId: PC_ID, itemSlug: 'cloak-of-protection' },
      ], []);
      expect(await readAttuned()).toEqual(['ring-of-protection']);
    });

    it('unattune is a no-op when the slug is not attuned', async () => {
      await resetAttuned(['cloak-of-protection']);
      await applyMutations(SESSION_ID, [
        { op: 'unattune', characterId: PC_ID, itemSlug: 'amulet-of-health' },
      ], []);
      expect(await readAttuned()).toEqual(['cloak-of-protection']);
    });
  });

  describe('applicator — concentration mutations', () => {
    // Helper: clear the concentratingOn column so each test starts at NULL.
    async function resetConcentration() {
      await db
        .update(sessionState)
        .set({ concentratingOn: null })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }

    it('set_concentration writes concentratingOn to session_state', async () => {
      await resetConcentration();
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: PC_ID, spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.concentratingOn).toEqual({ spellSlug: 'bless', slotLevel: 1, startedRound: 3 });
    });

    it('break_concentration clears concentratingOn', async () => {
      await resetConcentration();
      // First set concentration
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: PC_ID, spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
      ], []);
      // Then break it
      await applyMutations(SESSION_ID, [
        { op: 'break_concentration', actorId: PC_ID, reason: 'damage' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.concentratingOn).toBeNull();
    });

    it('break_concentration when not concentrating is a no-op', async () => {
      await resetConcentration();
      await applyMutations(SESSION_ID, [
        { op: 'break_concentration', actorId: PC_ID, reason: 'damage' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.concentratingOn).toBeNull();
    });

    it('set_concentration replaces previous concentratingOn', async () => {
      await resetConcentration();
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: PC_ID, spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
      ], []);
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: PC_ID, spellSlug: 'hold-person', slotLevel: 2, startedRound: 5 },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.concentratingOn).toEqual({ spellSlug: 'hold-person', slotLevel: 2, startedRound: 5 });
    });

    it('concentration_check mutation is a no-op (handled by tool, not applicator)', async () => {
      await resetConcentration();
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: PC_ID, spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
      ], []);
      const [before] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      await applyMutations(SESSION_ID, [
        { op: 'concentration_check', actorId: PC_ID, dc: 10, spellSlug: 'bless' },
      ], []);
      const [after] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      // concentratingOn stays exactly as it was — the applicator does not
      // resolve checks; the concentration_check tool will (and may emit
      // break_concentration on a failed save).
      expect(after!.concentratingOn).toEqual(before!.concentratingOn);
    });

    it('set_concentration on a non-PC actorId is a no-op (monsters not tracked)', async () => {
      await resetConcentration();
      await applyMutations(SESSION_ID, [
        { op: 'set_concentration', actorId: MONSTER_ID, spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.concentratingOn).toBeNull();
    });
  });

  describe('applicator — advance_turn ticks condition durations', () => {
    // Helper: seed a fresh combat with PC + MONSTER so we can drive advance_turn.
    async function seedCombat(args: {
      currentIdx: number;
      round: number;
      pcConditions?: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
      monsterConditions?: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
    }) {
      const combat = {
        round: args.round,
        currentIdx: args.currentIdx,
        turnOrder: [
          { actorId: PC_ID, initiative: 18 },
          { actorId: MONSTER_ID, initiative: 12 },
        ],
      };
      await db
        .update(sessionState)
        .set({
          combat: combat as never,
          inCombat: true,
          conditions: (args.pcConditions ?? []) as never,
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
      await db
        .update(combatActors)
        .set({ conditions: (args.monsterConditions ?? []) as never })
        .where(eq(combatActors.id, MONSTER_ID));
    }

    it('decrements PC condition durationRounds when their turn ends', async () => {
      await seedCombat({
        currentIdx: 0, // PC's turn
        round: 1,
        pcConditions: [
          { slug: 'blessed', source: 'cleric bless', durationRounds: 10, appliedRound: 0 },
        ],
      });
      await applyMutations(SESSION_ID, [{ op: 'advance_turn' }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const conds = (s!.conditions ?? []) as { slug: string; durationRounds: number | 'until_removed' }[];
      expect(conds.find((c) => c.slug === 'blessed')?.durationRounds).toBe(9);
    });

    it('removes PC condition when durationRounds reaches 0', async () => {
      await seedCombat({
        currentIdx: 0,
        round: 1,
        pcConditions: [
          { slug: 'helped', source: 'help-action', durationRounds: 1, appliedRound: 0 },
        ],
      });
      await applyMutations(SESSION_ID, [{ op: 'advance_turn' }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const conds = (s!.conditions ?? []) as { slug: string }[];
      expect(conds.some((c) => c.slug === 'helped')).toBe(false);
    });

    it('leaves until_removed conditions untouched', async () => {
      await seedCombat({
        currentIdx: 0,
        round: 1,
        pcConditions: [
          { slug: 'unconscious', source: 'KO', durationRounds: 'until_removed', appliedRound: 0 },
        ],
      });
      await applyMutations(SESSION_ID, [{ op: 'advance_turn' }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const conds = (s!.conditions ?? []) as { slug: string; durationRounds: number | 'until_removed' }[];
      expect(conds.find((c) => c.slug === 'unconscious')?.durationRounds).toBe('until_removed');
    });

    it('decrements monster (combat actor) condition durations when their turn ends', async () => {
      await seedCombat({
        currentIdx: 1, // monster's turn
        round: 2,
        monsterConditions: [
          { slug: 'poisoned', source: 'venom', durationRounds: 3, appliedRound: 1 },
        ],
      });
      await applyMutations(SESSION_ID, [{ op: 'advance_turn' }], []);
      const [a] = await db.select().from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
      const conds = (a!.conditions ?? []) as { slug: string; durationRounds: number | 'until_removed' }[];
      expect(conds.find((c) => c.slug === 'poisoned')?.durationRounds).toBe(2);
    });

    it('removes expired monster condition', async () => {
      await seedCombat({
        currentIdx: 1,
        round: 2,
        monsterConditions: [
          { slug: 'poisoned', source: 'venom', durationRounds: 1, appliedRound: 1 },
        ],
      });
      await applyMutations(SESSION_ID, [{ op: 'advance_turn' }], []);
      const [a] = await db.select().from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
      const conds = (a!.conditions ?? []) as { slug: string }[];
      expect(conds.some((c) => c.slug === 'poisoned')).toBe(false);
    });
  });

  describe('applicator — action economy mutations', () => {
    // Helper: clear/seed turnState + position so each test starts at a known state.
    async function resetTurnState(turnState: unknown = null, position: unknown = null) {
      await db
        .update(sessionState)
        .set({
          // Drizzle types this strictly; cast through unknown to allow null seeds in tests.
          turnState: turnState as ReturnType<typeof Object> | null as never,
          position: position as ReturnType<typeof Object> | null as never,
        })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }

    it('start_turn resets turnState to fresh', async () => {
      // Seed a "dirty" turnState
      await resetTurnState({
        actionUsed: true,
        bonusUsed: true,
        reactionUsed: false,
        movementSpentFt: 30,
        freeInteractionsUsed: 1,
        dodging: true,
        disengaged: false,
        dashed: true,
        readied: { trigger: 'enemy moves', action: 'shoot bow' },
      });
      await applyMutations(SESSION_ID, [
        { op: 'start_turn', actorId: PC_ID },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.turnState).toEqual({
        actionUsed: false,
        bonusUsed: false,
        reactionUsed: false,
        movementSpentFt: 0,
        freeInteractionsUsed: 0,
        dodging: false,
        disengaged: false,
        dashed: false,
      });
    });

    it('consume_action(action) marks actionUsed=true', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'consume_action', actorId: PC_ID, kind: 'action' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.turnState).toMatchObject({
        actionUsed: true,
        bonusUsed: false,
        reactionUsed: false,
      });
    });

    it('consume_action(bonus) marks bonusUsed=true; not action', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'consume_action', actorId: PC_ID, kind: 'bonus' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.turnState).toMatchObject({
        actionUsed: false,
        bonusUsed: true,
        reactionUsed: false,
      });
    });

    it('consume_action(reaction) marks reactionUsed=true', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'consume_action', actorId: PC_ID, kind: 'reaction' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.turnState).toMatchObject({
        actionUsed: false,
        bonusUsed: false,
        reactionUsed: true,
      });
    });

    it('consume_movement increments movementSpentFt', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'consume_movement', actorId: PC_ID, feet: 15 },
      ], []);
      let [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { movementSpentFt: number } | null)?.movementSpentFt).toBe(15);
      await applyMutations(SESSION_ID, [
        { op: 'consume_movement', actorId: PC_ID, feet: 10 },
      ], []);
      [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { movementSpentFt: number } | null)?.movementSpentFt).toBe(25);
    });

    it('take_dodge sets dodging=true', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'take_dodge', actorId: PC_ID },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { dodging: boolean } | null)?.dodging).toBe(true);
    });

    it('take_disengage sets disengaged=true', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'take_disengage', actorId: PC_ID },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { disengaged: boolean } | null)?.disengaged).toBe(true);
    });

    it('take_dash sets dashed=true', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'take_dash', actorId: PC_ID, extraSpeedFt: 30 },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { dashed: boolean } | null)?.dashed).toBe(true);
    });

    it('set_readied stores trigger + action', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'set_readied', actorId: PC_ID, trigger: 'enemy enters', action: 'Attack with bow' },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { readied?: { trigger: string; action: string } } | null)?.readied).toEqual({
        trigger: 'enemy enters',
        action: 'Attack with bow',
      });
    });

    it('set_position writes the position object', async () => {
      await resetTurnState();
      await applyMutations(SESSION_ID, [
        { op: 'set_position', actorId: PC_ID, position: { band: 'far', engagedWith: [] } },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.position).toEqual({ band: 'far', engagedWith: [] });
    });

    it('opportunity_attack_triggered is a no-op signal (no state change)', async () => {
      await resetTurnState({
        actionUsed: false,
        bonusUsed: false,
        reactionUsed: false,
        movementSpentFt: 0,
        freeInteractionsUsed: 0,
        dodging: false,
        disengaged: false,
        dashed: false,
      }, { band: 'engaged', engagedWith: [MONSTER_ID] });
      const [before] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      await applyMutations(SESSION_ID, [
        { op: 'opportunity_attack_triggered', attackerId: MONSTER_ID, targetId: PC_ID },
      ], []);
      const [after] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(after!.turnState).toEqual(before!.turnState);
      expect(after!.position).toEqual(before!.position);
    });
  });

  describe('applicator — exploration mutations (PHB §6)', () => {
    async function resetTravel() {
      await db
        .update(sessionState)
        .set({ travel: null })
        .where(eq(sessionState.sessionId, SESSION_ID));
    }

    it('set_travel_pace persists travel.pace and merges with existing fields', async () => {
      await resetTravel();
      await applyMutations(SESSION_ID, [
        { op: 'set_travel_pace', pace: 'fast' },
      ], []);
      const [s1] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s1!.travel).toEqual({ pace: 'fast' });

      // A subsequent set_light_level should preserve the pace.
      await applyMutations(SESSION_ID, [
        { op: 'set_light_level', lightLevel: 'dim' },
      ], []);
      const [s2] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s2!.travel).toEqual({ pace: 'fast', lightLevel: 'dim' });
    });

    it('set_light_level: bright → darkness updates only the light field', async () => {
      await resetTravel();
      await applyMutations(SESSION_ID, [
        { op: 'set_light_level', lightLevel: 'bright' },
      ], []);
      let [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.travel).toEqual({ lightLevel: 'bright' });

      await applyMutations(SESSION_ID, [
        { op: 'set_light_level', lightLevel: 'darkness' },
      ], []);
      [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(s!.travel).toEqual({ lightLevel: 'darkness' });
    });

    it('set_marching_order persists the front/middle/back ranks', async () => {
      await resetTravel();
      const order = { front: ['pc1', 'companion'], middle: ['scout'], back: ['mage'] };
      await applyMutations(SESSION_ID, [
        { op: 'set_marching_order', order },
      ], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.travel as { marchingOrder?: typeof order } | null)?.marchingOrder).toEqual(order);
    });

    it('set_senses on the PC writes characters.senses', async () => {
      await applyMutations(SESSION_ID, [
        { op: 'set_senses', actorId: PC_ID, senses: { darkvisionFt: 60, passivePerception: 13 } },
      ], []);
      const [c] = await db.select({ senses: characters.senses }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      expect(c!.senses).toEqual({ darkvisionFt: 60, passivePerception: 13 });
    });

    it('set_senses on a combat actor writes combat_actors.senses (PC vs monster branching)', async () => {
      await applyMutations(SESSION_ID, [
        { op: 'set_senses', actorId: MONSTER_ID, senses: { darkvisionFt: 60 } },
      ], []);
      const [a] = await db.select({ senses: combatActors.senses }).from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
      expect(a!.senses).toEqual({ darkvisionFt: 60 });

      // PC senses unaffected (verifies the actorId branching doesn't leak across).
      await applyMutations(SESSION_ID, [
        { op: 'set_senses', actorId: MONSTER_ID, senses: { blindsightFt: 30, tremorsenseFt: 15 } },
      ], []);
      const [a2] = await db.select({ senses: combatActors.senses }).from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
      expect(a2!.senses).toEqual({ blindsightFt: 30, tremorsenseFt: 15 });
    });
  });

  describe('weapon-property mutations (PHB §9.4)', () => {
    it('mark_loading_shot on the PC sets sessionState.turnState.loadingShotUsed', async () => {
      // Reset the PC turnState to a fresh, untouched value first.
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: PC_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'mark_loading_shot', actorId: PC_ID }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { loadingShotUsed?: boolean } | null)?.loadingShotUsed).toBe(true);
    });

    it('start_turn resets loadingShotUsed back to false (fresh turn)', async () => {
      // Mark, then start a fresh turn — should reset.
      await applyMutations(SESSION_ID, [{ op: 'mark_loading_shot', actorId: PC_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: PC_ID }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const ts = s!.turnState as { loadingShotUsed?: boolean } | null;
      expect(ts?.loadingShotUsed).toBeFalsy();
    });

    it('mark_loading_shot on a combat actor (NPC) sets combat_actors.turnState.loadingShotUsed', async () => {
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: MONSTER_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'mark_loading_shot', actorId: MONSTER_ID }], []);
      const [a] = await db.select().from(combatActors).where(eq(combatActors.id, MONSTER_ID)).limit(1);
      expect((a!.turnState as { loadingShotUsed?: boolean } | null)?.loadingShotUsed).toBe(true);
    });

    it('mark_offhand_attack on the PC sets sessionState.turnState.offHandAttackUsed (PHB §3.15)', async () => {
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: PC_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'mark_offhand_attack', actorId: PC_ID }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { offHandAttackUsed?: boolean } | null)?.offHandAttackUsed).toBe(true);
    });

    it('consume_ammo decrements characters.inventory[ammoSlug].qty', async () => {
      // Seed the PC with crossbow bolts.
      await applyMutations(SESSION_ID, [
        { op: 'add_inventory', characterId: PC_ID, itemSlug: 'crossbow-bolt', qty: 5 },
      ], []);
      await applyMutations(SESSION_ID, [
        { op: 'consume_ammo', characterId: PC_ID, ammoSlug: 'crossbow-bolt', qty: 1 },
      ], []);
      const [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      const bolt = (c!.inv as { slug: string; qty: number }[]).find((it) => it.slug === 'crossbow-bolt');
      expect(bolt?.qty).toBe(4);
    });

    it('consume_ammo to zero removes the entry from inventory', async () => {
      // After previous test we have 4 bolts; consume 4 → entry removed.
      await applyMutations(SESSION_ID, [
        { op: 'consume_ammo', characterId: PC_ID, ammoSlug: 'crossbow-bolt', qty: 4 },
      ], []);
      const [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
      const bolt = (c!.inv as { slug: string; qty: number }[]).find((it) => it.slug === 'crossbow-bolt');
      expect(bolt).toBeUndefined();
    });
  });

  describe('spellcasting focus (PHB §8.4)', () => {
    it('set_focus persists characters.equipped_focus', async () => {
      await applyMutations(SESSION_ID, [
        {
          op: 'set_focus',
          characterId: PC_ID,
          focus: { kind: 'arcane', itemSlug: 'crystal-orb' },
        },
      ], []);
      const [c] = await db
        .select({ equippedFocus: characters.equippedFocus })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      expect(c!.equippedFocus).toEqual({ kind: 'arcane', itemSlug: 'crystal-orb' });
    });

    it('set_focus overwrites the previous focus (idempotent for same value)', async () => {
      await applyMutations(SESSION_ID, [
        {
          op: 'set_focus',
          characterId: PC_ID,
          focus: { kind: 'holy', itemSlug: 'amulet-of-light' },
        },
      ], []);
      const [c] = await db
        .select({ equippedFocus: characters.equippedFocus })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      expect(c!.equippedFocus).toEqual({ kind: 'holy', itemSlug: 'amulet-of-light' });
    });

    it('unset_focus clears characters.equipped_focus', async () => {
      await applyMutations(SESSION_ID, [
        { op: 'unset_focus', characterId: PC_ID },
      ], []);
      const [c] = await db
        .select({ equippedFocus: characters.equippedFocus })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      expect(c!.equippedFocus).toBeNull();
    });
  });

  describe('add_class_level (PHB §2.5)', () => {
    it('appends a new class entry, increments level total, leaves classSlug as starter', async () => {
      // Reset the row to a clean fighter level 5 baseline so this test is
      // deterministic regardless of ordering with the level_up test above.
      await db
        .update(characters)
        .set({ classes: [], classSlug: 'fighter', level: 5 })
        .where(eq(characters.id, PC_ID));

      await applyMutations(
        SESSION_ID,
        [{ op: 'add_class_level', characterId: PC_ID, classSlug: 'wizard' }],
        [],
      );

      const [c] = await db
        .select({
          classes: characters.classes,
          classSlug: characters.classSlug,
          level: characters.level,
        })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      // Backfill from classSlug+level + new wizard entry → fighter 5 + wizard 1 = 6.
      expect(c!.classes).toEqual([
        { slug: 'fighter', level: 5 },
        { slug: 'wizard', level: 1 },
      ]);
      expect(c!.classSlug).toBe('fighter');
      expect(c!.level).toBe(6);
    });

    it('increments an existing class entry instead of duplicating', async () => {
      // Re-run add_class_level for fighter — should bump fighter to 6.
      await applyMutations(
        SESSION_ID,
        [{ op: 'add_class_level', characterId: PC_ID, classSlug: 'fighter' }],
        [],
      );
      const [c] = await db
        .select({ classes: characters.classes, level: characters.level })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      expect(c!.classes).toEqual([
        { slug: 'fighter', level: 6 },
        { slug: 'wizard', level: 1 },
      ]);
      expect(c!.level).toBe(7);
    });

    it('attaches subclass when supplied', async () => {
      await db
        .update(characters)
        .set({ classes: [{ slug: 'fighter', level: 2 }], classSlug: 'fighter', level: 2 })
        .where(eq(characters.id, PC_ID));

      await applyMutations(
        SESSION_ID,
        [{ op: 'add_class_level', characterId: PC_ID, classSlug: 'fighter', subclass: 'eldritch-knight' }],
        [],
      );
      const [c] = await db
        .select({ classes: characters.classes })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      expect(c!.classes).toEqual([
        { slug: 'fighter', level: 3, subclass: 'eldritch-knight' },
      ]);
    });
  });

  describe('class-feature mutations (Phase 11)', () => {
    it('use_class_feature increments resourcesUsed by uses (default 1)', async () => {
      // Reset the resourcesUsed bag for this test.
      await db
        .update(sessionState)
        .set({ resourcesUsed: {} })
        .where(eq(sessionState.sessionId, SESSION_ID));

      await applyMutations(
        SESSION_ID,
        [{ op: 'use_class_feature', actorId: PC_ID, featureSlug: 'rage' }],
        [],
      );
      let [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.resourcesUsed as Record<string, number>)['rage']).toBe(1);

      // Increment with explicit uses=2.
      await applyMutations(
        SESSION_ID,
        [{ op: 'use_class_feature', actorId: PC_ID, featureSlug: 'rage', uses: 2 }],
        [],
      );
      [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.resourcesUsed as Record<string, number>)['rage']).toBe(3);
    });

    it('restore_class_feature decrements resourcesUsed and clears entry at 0', async () => {
      await db
        .update(sessionState)
        .set({ resourcesUsed: { action_surge: 1 } })
        .where(eq(sessionState.sessionId, SESSION_ID));

      await applyMutations(
        SESSION_ID,
        [{ op: 'restore_class_feature', actorId: PC_ID, featureSlug: 'action_surge' }],
        [],
      );
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const used = s!.resourcesUsed as Record<string, number>;
      // Either deleted entry or 0 (the applicator deletes on hit-zero — assert deletion).
      expect(used['action_surge']).toBeUndefined();
    });

    it('modify_lay_on_hands_pool with positive delta increments spent', async () => {
      await db
        .update(sessionState)
        .set({ resourcesUsed: {} })
        .where(eq(sessionState.sessionId, SESSION_ID));

      await applyMutations(
        SESSION_ID,
        [{ op: 'modify_lay_on_hands_pool', actorId: PC_ID, delta: 10 }],
        [],
      );
      let [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.resourcesUsed as Record<string, number>)['lay_on_hands']).toBe(10);

      // Negative delta restores (e.g., long rest).
      await applyMutations(
        SESSION_ID,
        [{ op: 'modify_lay_on_hands_pool', actorId: PC_ID, delta: -10 }],
        [],
      );
      [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.resourcesUsed as Record<string, number>)['lay_on_hands']).toBeUndefined();
    });

    it('mark_sneak_attack on the PC sets sessionState.turnState.sneakAttackUsed', async () => {
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: PC_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'mark_sneak_attack', actorId: PC_ID }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect((s!.turnState as { sneakAttackUsed?: boolean } | null)?.sneakAttackUsed).toBe(true);
    });

    it('start_turn resets sneakAttackUsed back to undefined/false', async () => {
      await applyMutations(SESSION_ID, [{ op: 'mark_sneak_attack', actorId: PC_ID }], []);
      await applyMutations(SESSION_ID, [{ op: 'start_turn', actorId: PC_ID }], []);
      const [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      const ts = s!.turnState as { sneakAttackUsed?: boolean } | null;
      expect(ts?.sneakAttackUsed).toBeFalsy();
    });

    it('reset_action_for_surge clears actionUsed without touching bonus/reaction', async () => {
      // Start fresh, then mark actionUsed and bonusUsed via consume_action.
      await applyMutations(
        SESSION_ID,
        [
          { op: 'start_turn', actorId: PC_ID },
          { op: 'consume_action', actorId: PC_ID, kind: 'action' },
          { op: 'consume_action', actorId: PC_ID, kind: 'bonus' },
        ],
        [],
      );
      let [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      let ts = s!.turnState as { actionUsed: boolean; bonusUsed: boolean };
      expect(ts.actionUsed).toBe(true);
      expect(ts.bonusUsed).toBe(true);

      // Now Action Surge: action resets, bonus stays consumed.
      await applyMutations(
        SESSION_ID,
        [{ op: 'reset_action_for_surge', actorId: PC_ID }],
        [],
      );
      [s] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      ts = s!.turnState as { actionUsed: boolean; bonusUsed: boolean };
      expect(ts.actionUsed).toBe(false);
      expect(ts.bonusUsed).toBe(true);
    });
  });

  // ─── Phase 12: crafting projects (PHB §5 + DMG) ──────────────────────────
  describe('applicator — crafting mutations', () => {
    type ProjectRow = {
      id: string;
      recipeSlug: string;
      kind: string;
      daysRemaining: number;
      gpSpent: number;
      startedRound?: number;
    };

    async function getProjects(): Promise<ProjectRow[]> {
      const [c] = await db
        .select({ p: characters.craftingProjects })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c!.p ?? []) as ProjectRow[];
    }

    async function resetCrafting() {
      await db
        .update(characters)
        .set({ craftingProjects: [] })
        .where(eq(characters.id, PC_ID));
    }

    it('start_crafting appends the project to characters.crafting_projects', async () => {
      await resetCrafting();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_crafting',
            characterId: PC_ID,
            project: {
              id: 'proj-1',
              recipeSlug: 'longsword',
              kind: 'item',
              daysRemaining: 30,
              gpSpent: 0,
            },
          },
        ],
        [],
      );
      const projects = await getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        id: 'proj-1',
        recipeSlug: 'longsword',
        kind: 'item',
        daysRemaining: 30,
        gpSpent: 0,
      });
    });

    it('start_crafting is idempotent on duplicate id', async () => {
      await resetCrafting();
      const project = {
        id: 'proj-dup',
        recipeSlug: 'rope-hempen',
        kind: 'item' as const,
        daysRemaining: 4,
        gpSpent: 0,
      };
      await applyMutations(
        SESSION_ID,
        [{ op: 'start_crafting', characterId: PC_ID, project }],
        [],
      );
      // Second call with the same id is a silent no-op (no duplicate row).
      await applyMutations(
        SESSION_ID,
        [{ op: 'start_crafting', characterId: PC_ID, project }],
        [],
      );
      const projects = await getProjects();
      expect(projects).toHaveLength(1);
    });

    it('progress_crafting decrements daysRemaining (clamp 0) and adds gpDelta to gpSpent', async () => {
      await resetCrafting();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_crafting',
            characterId: PC_ID,
            project: {
              id: 'proj-2',
              recipeSlug: 'studded-leather',
              kind: 'item',
              daysRemaining: 10,
              gpSpent: 0,
            },
          },
        ],
        [],
      );

      // Spend 4 days + 12 gp.
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'progress_crafting',
            characterId: PC_ID,
            projectId: 'proj-2',
            daysSpent: 4,
            gpDelta: 12,
          },
        ],
        [],
      );
      let projects = await getProjects();
      expect(projects[0]!.daysRemaining).toBe(6);
      expect(projects[0]!.gpSpent).toBe(12);

      // Spend 99 days — clamps at 0, gpSpent grows by gpDelta.
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'progress_crafting',
            characterId: PC_ID,
            projectId: 'proj-2',
            daysSpent: 99,
            gpDelta: 5,
          },
        ],
        [],
      );
      projects = await getProjects();
      expect(projects[0]!.daysRemaining).toBe(0);
      expect(projects[0]!.gpSpent).toBe(17);
    });

    it('complete_crafting at daysRemaining=0 removes project AND adds inventory', async () => {
      await resetCrafting();
      // Reset inventory so we can observe the add cleanly.
      const [before] = await db
        .select({ inv: characters.inventory })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      const beforeInv = (before!.inv ?? []) as { slug: string; qty: number }[];
      const beforeQty = beforeInv.find((i) => i.slug === 'longsword')?.qty ?? 0;

      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_crafting',
            characterId: PC_ID,
            project: {
              id: 'proj-3',
              recipeSlug: 'longsword',
              kind: 'item',
              daysRemaining: 0,
              gpSpent: 8,
            },
          },
          { op: 'complete_crafting', characterId: PC_ID, projectId: 'proj-3' },
        ],
        [],
      );

      const projects = await getProjects();
      expect(projects.find((p) => p.id === 'proj-3')).toBeUndefined();

      const [after] = await db
        .select({ inv: characters.inventory })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      const afterInv = (after!.inv ?? []) as { slug: string; qty: number }[];
      const afterQty = afterInv.find((i) => i.slug === 'longsword')?.qty ?? 0;
      expect(afterQty).toBe(beforeQty + 1);
    });

    it('cancel_crafting drops the project without an inventory side-effect', async () => {
      await resetCrafting();
      const [before] = await db
        .select({ inv: characters.inventory })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      const beforeInv = (before!.inv ?? []) as { slug: string; qty: number }[];

      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_crafting',
            characterId: PC_ID,
            project: {
              id: 'proj-4',
              recipeSlug: 'wand-of-fireballs',
              kind: 'magic_item',
              daysRemaining: 100,
              gpSpent: 500,
            },
          },
          { op: 'cancel_crafting', characterId: PC_ID, projectId: 'proj-4' },
        ],
        [],
      );

      const projects = await getProjects();
      expect(projects.find((p) => p.id === 'proj-4')).toBeUndefined();

      const [after] = await db
        .select({ inv: characters.inventory })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      const afterInv = (after!.inv ?? []) as { slug: string; qty: number }[];
      // No new wand entry should have appeared.
      expect(
        afterInv.find((i) => i.slug === 'wand-of-fireballs'),
      ).toBeUndefined();
      // Other inventory entries are untouched.
      expect(afterInv.length).toBe(beforeInv.length);
    });
  });

  // ─── Phase 13: downtime / hireling / bastion (PHB §6 + 2024 PHB) ─────────
  describe('applicator — downtime/hireling/bastion mutations', () => {
    type ActivityRow = {
      id: string;
      kind: string;
      daysRemaining: number;
      gpSpent: number;
      startedAt?: number;
    };
    type HirelingRow = {
      id: string;
      kind: string;
      count: number;
      days: number;
      gpCost: number;
      spCost: number;
      startedAt?: number;
    };
    type BastionRow = {
      name: string;
      fortification: string;
      rooms: { kind: string; level: number }[];
      defenders: number;
    } | null;

    async function getActivities(): Promise<ActivityRow[]> {
      const [c] = await db
        .select({ a: characters.downtimeActivities })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c!.a ?? []) as ActivityRow[];
    }

    async function getHirelings(): Promise<HirelingRow[]> {
      const [c] = await db
        .select({ h: characters.hirelings })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c!.h ?? []) as HirelingRow[];
    }

    async function getBastion(): Promise<BastionRow> {
      const [c] = await db
        .select({ b: characters.bastion })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c!.b ?? null) as BastionRow;
    }

    async function resetDowntime() {
      await db
        .update(characters)
        .set({
          downtimeActivities: [],
          hirelings: [],
          bastion: null,
        })
        .where(eq(characters.id, PC_ID));
    }

    it('start_downtime_activity appends to characters.downtime_activities', async () => {
      await resetDowntime();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_downtime_activity',
            characterId: PC_ID,
            activity: {
              id: 'dt-1',
              kind: 'recuperating',
              daysRemaining: 3,
              gpSpent: 0,
            },
          },
        ],
        [],
      );
      const acts = await getActivities();
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({
        id: 'dt-1',
        kind: 'recuperating',
        daysRemaining: 3,
        gpSpent: 0,
      });
    });

    it('start_downtime_activity is idempotent on duplicate id', async () => {
      await resetDowntime();
      const activity = {
        id: 'dt-dup',
        kind: 'researching' as const,
        daysRemaining: 5,
        gpSpent: 0,
      };
      await applyMutations(
        SESSION_ID,
        [{ op: 'start_downtime_activity', characterId: PC_ID, activity }],
        [],
      );
      await applyMutations(
        SESSION_ID,
        [{ op: 'start_downtime_activity', characterId: PC_ID, activity }],
        [],
      );
      const acts = await getActivities();
      expect(acts).toHaveLength(1);
    });

    it('complete_downtime_activity removes the activity from the array', async () => {
      await resetDowntime();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'start_downtime_activity',
            characterId: PC_ID,
            activity: {
              id: 'dt-2',
              kind: 'practicing_profession',
              daysRemaining: 5,
              gpSpent: 0,
            },
          },
          {
            op: 'complete_downtime_activity',
            characterId: PC_ID,
            activityId: 'dt-2',
          },
        ],
        [],
      );
      const acts = await getActivities();
      expect(acts.find((a) => a.id === 'dt-2')).toBeUndefined();
    });

    it('hire appends a hireling engagement to characters.hirelings', async () => {
      await resetDowntime();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'hire',
            characterId: PC_ID,
            hireling: {
              id: 'hire-1',
              kind: 'unskilled',
              count: 2,
              days: 10,
              gpCost: 0,
              spCost: 40,
            },
          },
        ],
        [],
      );
      const list = await getHirelings();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'hire-1',
        kind: 'unskilled',
        count: 2,
        days: 10,
        spCost: 40,
      });
    });

    it('dismiss_hireling drops the engagement by id', async () => {
      await resetDowntime();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'hire',
            characterId: PC_ID,
            hireling: {
              id: 'hire-2',
              kind: 'skilled',
              count: 1,
              days: 5,
              gpCost: 10,
              spCost: 0,
            },
          },
          {
            op: 'dismiss_hireling',
            characterId: PC_ID,
            hireId: 'hire-2',
          },
        ],
        [],
      );
      const list = await getHirelings();
      expect(list.find((h) => h.id === 'hire-2')).toBeUndefined();
    });

    it('set_bastion overwrites the bastion field; null clears it', async () => {
      await resetDowntime();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'set_bastion',
            characterId: PC_ID,
            bastion: {
              name: 'Ravenhollow Manor',
              fortification: 'fortified',
              rooms: [
                { kind: 'kitchen', level: 1 },
                { kind: 'storage', level: 1 },
                { kind: 'armory', level: 1 },
                { kind: 'training', level: 1 },
              ],
              defenders: 8,
            },
          },
        ],
        [],
      );
      let b = await getBastion();
      expect(b).not.toBeNull();
      expect(b!.name).toBe('Ravenhollow Manor');
      expect(b!.fortification).toBe('fortified');
      expect(b!.defenders).toBe(8);
      expect(b!.rooms).toHaveLength(4);

      // Now clear it.
      await applyMutations(
        SESSION_ID,
        [{ op: 'set_bastion', characterId: PC_ID, bastion: null }],
        [],
      );
      b = await getBastion();
      expect(b).toBeNull();
    });

    it('add_bastion_room appends to bastion.rooms; no-op when no bastion', async () => {
      await resetDowntime();
      // No bastion yet → add_bastion_room should be a silent no-op.
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'add_bastion_room',
            characterId: PC_ID,
            room: { kind: 'library', level: 1 },
          },
        ],
        [],
      );
      let b = await getBastion();
      expect(b).toBeNull();

      // Establish a modest bastion (2 rooms), then add a library.
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'set_bastion',
            characterId: PC_ID,
            bastion: {
              name: 'Brookholt Cottage',
              fortification: 'modest',
              rooms: [
                { kind: 'kitchen', level: 1 },
                { kind: 'storage', level: 1 },
              ],
              defenders: 2,
            },
          },
          {
            op: 'add_bastion_room',
            characterId: PC_ID,
            room: { kind: 'library', level: 1 },
          },
        ],
        [],
      );
      b = await getBastion();
      expect(b).not.toBeNull();
      expect(b!.rooms).toHaveLength(3);
      expect(b!.rooms[2]).toMatchObject({ kind: 'library', level: 1 });
    });
  });

  // ─── Phase 14: mounted combat / vehicles (PHB §3.23, §9.6) ──────────────
  describe('applicator — mount/dismount/embark mutations', () => {
    type MountedRow = { mountId: string; mode: string } | null;

    async function getMountedOn(): Promise<MountedRow> {
      const [c] = await db
        .select({ m: characters.mountedOn })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return (c!.m ?? null) as MountedRow;
    }

    async function getEmbarkedOn(): Promise<string | null> {
      const [c] = await db
        .select({ e: characters.embarkedOn })
        .from(characters)
        .where(eq(characters.id, PC_ID))
        .limit(1);
      return c!.e ?? null;
    }

    async function resetVehicleState() {
      await db
        .update(characters)
        .set({ mountedOn: null, embarkedOn: null })
        .where(eq(characters.id, PC_ID));
    }

    it('mount writes characters.mounted_on with default controlled mode', async () => {
      await resetVehicleState();
      await applyMutations(
        SESSION_ID,
        [{ op: 'mount', characterId: PC_ID, mountId: MONSTER_ID }],
        [],
      );
      const m = await getMountedOn();
      expect(m).not.toBeNull();
      expect(m!.mountId).toBe(MONSTER_ID);
      expect(m!.mode).toBe('controlled');
    });

    it('mount with explicit independent mode persists', async () => {
      await resetVehicleState();
      await applyMutations(
        SESSION_ID,
        [
          {
            op: 'mount',
            characterId: PC_ID,
            mountId: MONSTER_ID,
            mode: 'independent',
          },
        ],
        [],
      );
      const m = await getMountedOn();
      expect(m!.mode).toBe('independent');
    });

    it('dismount clears characters.mounted_on (idempotent)', async () => {
      await resetVehicleState();
      // No mount → dismount is a silent no-op (the column stays NULL).
      await applyMutations(
        SESSION_ID,
        [{ op: 'dismount', characterId: PC_ID }],
        [],
      );
      expect(await getMountedOn()).toBeNull();

      // Mount + dismount cycle.
      await applyMutations(
        SESSION_ID,
        [
          { op: 'mount', characterId: PC_ID, mountId: MONSTER_ID },
          { op: 'dismount', characterId: PC_ID },
        ],
        [],
      );
      expect(await getMountedOn()).toBeNull();
    });

    it('set_mount_mode updates the mode while preserving the mountId', async () => {
      await resetVehicleState();
      await applyMutations(
        SESSION_ID,
        [
          { op: 'mount', characterId: PC_ID, mountId: MONSTER_ID, mode: 'controlled' },
          { op: 'set_mount_mode', characterId: PC_ID, mode: 'independent' },
        ],
        [],
      );
      const m = await getMountedOn();
      expect(m!.mountId).toBe(MONSTER_ID);
      expect(m!.mode).toBe('independent');
    });

    it('set_mount_mode is a no-op when not currently mounted', async () => {
      await resetVehicleState();
      await applyMutations(
        SESSION_ID,
        [{ op: 'set_mount_mode', characterId: PC_ID, mode: 'independent' }],
        [],
      );
      expect(await getMountedOn()).toBeNull();
    });

    it('embark_vehicle persists a known slug; unknown slug is dropped', async () => {
      await resetVehicleState();
      await applyMutations(
        SESSION_ID,
        [{ op: 'embark_vehicle', characterId: PC_ID, vehicleSlug: 'sailing-ship' }],
        [],
      );
      expect(await getEmbarkedOn()).toBe('sailing-ship');

      // Unknown slug — applicator drops it; column unchanged.
      await applyMutations(
        SESSION_ID,
        [{ op: 'embark_vehicle', characterId: PC_ID, vehicleSlug: 'mecha' }],
        [],
      );
      expect(await getEmbarkedOn()).toBe('sailing-ship');
    });

    it('disembark_vehicle clears characters.embarked_on (idempotent)', async () => {
      await resetVehicleState();
      // Cycle: embark → disembark.
      await applyMutations(
        SESSION_ID,
        [
          { op: 'embark_vehicle', characterId: PC_ID, vehicleSlug: 'rowboat' },
          { op: 'disembark_vehicle', characterId: PC_ID },
        ],
        [],
      );
      expect(await getEmbarkedOn()).toBeNull();

      // Idempotent — disembark again is fine.
      await applyMutations(
        SESSION_ID,
        [{ op: 'disembark_vehicle', characterId: PC_ID }],
        [],
      );
      expect(await getEmbarkedOn()).toBeNull();
    });
  });
});
