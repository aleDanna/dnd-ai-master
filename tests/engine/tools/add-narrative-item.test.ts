import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, codexEntities, campaigns } from '@/db/schema';
import { addNarrativeItem } from '@/engine/tools/add-narrative-item';
import type { Character, EngineState } from '@/engine/types';

const TEST_USER = 'user_narrative_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';
let pc: Character;
let state: EngineState;

beforeAll(async () => {
  await ensureUser(TEST_USER);
  const w = emptyWizardState();
  w.raceSlug = 'human';
  w.classSlug = 'fighter';
  w.backgroundSlug = 'soldier';
  w.identity.name = 'P';
  const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
  CHAR_ID = charId;
  const [campaign] = await db.insert(campaigns).values({ userId: TEST_USER, name: 'Test campaign', premise: 'narrative-items-test' }).returning();
  const [s] = await db
    .insert(sessions)
    .values({ userId: TEST_USER, characterId: charId, campaignId: campaign!.id, premise: 'narrative-items-test' })
    .returning();
  SESSION_ID = s!.id;
  await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });

  pc = {
    id: CHAR_ID, name: 'P', level: 1, xp: 0,
    classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
    abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 2, hpMax: 10, ac: 10, speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, features: [], inventory: [],
    hitDiceMax: 1, hitDieSize: 10,
  };
  state = {
    characters: [pc],
    combatActors: [],
    runtime: { [CHAR_ID]: { actorId: CHAR_ID, hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] } },
    combat: null,
    scene: 'tavern',
  };
});

afterAll(async () => {
  await db.execute(sql`delete from codex_entities where session_id = ${SESSION_ID}`);
  await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
  await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
  await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
  await db.execute(sql`delete from users where id = ${TEST_USER}`);
  await pool.end();
});

const ctx = () => ({ sessionId: SESSION_ID, state });

describe('addNarrativeItem', () => {
  it('inserts a new named_item with magical:false and emits add_inventory', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Strano amuleto di osso', description: 'Un amuleto antico.', qty: 1 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'add_inventory',
      characterId: CHAR_ID,
      itemSlug: 'strano-amuleto-di-osso',
      qty: 1,
    });
    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'strano-amuleto-di-osso')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('named_item');
    expect(rows[0]!.name).toBe('Strano amuleto di osso');
    expect((rows[0]!.data as { magical: boolean }).magical).toBe(false);
    expect((rows[0]!.data as { description: string }).description).toBe('Un amuleto antico.');
  });

  it('reuses an existing codex row when slug already present (no second insert)', async () => {
    await addNarrativeItem(ctx(), { name: 'Lettera cifrata' });
    const r2 = await addNarrativeItem(ctx(), { name: 'Lettera cifrata', description: 'whatever' });
    expect(r2.ok).toBe(true);
    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'lettera-cifrata')));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as { description: string }).description).toBe('');
  });

  it('rejects empty name with invalid_name', async () => {
    const r = await addNarrativeItem(ctx(), { name: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
    expect(r.mutations).toHaveLength(0);
  });

  it('rejects name longer than 80 chars with invalid_name', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'a'.repeat(81) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
  });

  it('rejects punctuation-only name with invalid_name (slugify produces empty)', async () => {
    const r = await addNarrativeItem(ctx(), { name: '!!!' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
  });

  it('truncates description to 120 chars', async () => {
    const longDesc = 'x'.repeat(200);
    await addNarrativeItem(ctx(), { name: 'Anello con sigillo', description: longDesc });
    const [row] = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'anello-con-sigillo')));
    expect((row!.data as { description: string }).description).toHaveLength(120);
  });

  it('clamps qty to integer >= 1', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Penna piuma', qty: 0 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ qty: 1 });

    const r2 = await addNarrativeItem(ctx(), { name: 'Penna piuma', qty: 3.7 });
    expect(r2.mutations[0]).toMatchObject({ qty: 3 });
  });

  it('rejects unknown actor when no PC in state', async () => {
    const emptyState: EngineState = { ...state, characters: [] };
    const r = await addNarrativeItem({ sessionId: SESSION_ID, state: emptyState }, { name: 'Boccale di ferro' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('returns slug, name, qty, kind in data on success', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Mappa stracciata', qty: 2 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      slug: 'mappa-stracciata',
      name: 'Mappa stracciata',
      qty: 2,
      kind: 'named_item',
    });
  });
});
