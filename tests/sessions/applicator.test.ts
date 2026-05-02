import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, combatActors, diceLog } from '@/db/schema';
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
});
