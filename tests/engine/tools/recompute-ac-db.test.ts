import { describe, it, expect, afterAll } from 'vitest';
import { recomputeAcDb } from '@/engine/tools/recompute-ac-db';
import { pool } from '@/db/client';
import type { Character, EngineState } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 12, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [],
  inventory: [
    { slug: 'chain-mail', qty: 1, equipped: true },
    { slug: 'shield', qty: 1, equipped: true },
  ],
  hitDiceMax: 1, hitDieSize: 10,
};

const state: EngineState = {
  characters: [fighter], combatActors: [],
  runtime: {
    pc1: { actorId: 'pc1', hpCurrent: 12, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
  },
  combat: null,
  scene: 'tavern',
};

afterAll(async () => {
  await pool.end();
});

describe('recomputeAcDb', () => {
  it('uses srd_armor specs (chain-mail 16 + shield +2 = 18)', async () => {
    const r = await recomputeAcDb({ sessionId: '00000000-0000-0000-0000-000000000000', state }, { actor: 'player_character' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ newAc: 18 });
  });

  it('returns unknown_actor for nonexistent character', async () => {
    const r = await recomputeAcDb({ sessionId: '00000000-0000-0000-0000-000000000000', state }, { actor: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });
});
