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
    // Add a longbow and 50 gp
    await applyMutations(SESSION_ID, [
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'longbow', qty: 1 },
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 50 },
    ], []);
    let [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    let inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'longbow')).toMatchObject({ qty: 1, equipped: false });
    expect(inv.find((i) => i.slug === 'gp')).toMatchObject({ qty: 50 });

    // Add 25 more gp — should stack
    await applyMutations(SESSION_ID, [
      { op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 25 },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'gp')!.qty).toBe(75);

    // Equip the longbow
    await applyMutations(SESSION_ID, [
      { op: 'set_equipped', characterId: PC_ID, itemSlug: 'longbow', equipped: true },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'longbow')!.equipped).toBe(true);

    // Spend 30 gp — qty drops to 45
    await applyMutations(SESSION_ID, [
      { op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 30 },
    ], []);
    [c] = await db.select({ inv: characters.inventory }).from(characters).where(eq(characters.id, PC_ID)).limit(1);
    inv = (c!.inv ?? []) as { slug: string; qty: number; equipped: boolean }[];
    expect(inv.find((i) => i.slug === 'gp')!.qty).toBe(45);

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
});
