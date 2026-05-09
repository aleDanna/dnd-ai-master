import { describe, it, expect, afterAll } from 'vitest';
import { addItemDb } from '@/engine/tools/add-item-db';
import { pool } from '@/db/client';
import type { Character, EngineState } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 12, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [],
  hitDiceMax: 1, hitDieSize: 10,
};

const state: EngineState = {
  characters: [fighter],
  combatActors: [],
  runtime: {
    pc1: { actorId: 'pc1', hpCurrent: 12, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
  },
  combat: null,
  scene: 'tavern',
};

const ctx = { sessionId: '00000000-0000-0000-0000-000000000000', state };

afterAll(async () => {
  await pool.end();
});

describe('addItemDb', () => {
  it('accepts a valid SRD weapon slug', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'longsword', qty: 1 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'add_inventory',
      characterId: 'pc1',
      itemSlug: 'longsword',
      qty: 1,
    });
    expect((r.data as { kind: string }).kind).toBe('weapon');
  });

  it('accepts a valid SRD armor slug', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'leather' });
    expect(r.ok).toBe(true);
    expect((r.data as { kind: string }).kind).toBe('armor');
  });

  it('accepts a currency code (gp)', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'gp', qty: 50 });
    expect(r.ok).toBe(true);
    expect((r.data as { kind: string }).kind).toBe('currency');
    expect(r.mutations[0]).toMatchObject({ itemSlug: 'gp', qty: 50 });
  });

  it('rejects an unknown slug with descriptive error', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'sword-of-vorpal-fakeness' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_item:sword-of-vorpal-fakeness');
    expect(r.mutations).toHaveLength(0);
  });

  it('rejects empty slug', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_slug');
  });

  it('rejects unknown actor', async () => {
    const r = await addItemDb(ctx, { actor: 'no-such-pc', slug: 'longsword' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('clamps qty to >= 1', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'longsword', qty: 0 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ qty: 1 });
  });

  it('case-insensitive slug normalization', async () => {
    const r = await addItemDb(ctx, { actor: 'player_character', slug: 'LongSword' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ itemSlug: 'longsword' });
  });
});
