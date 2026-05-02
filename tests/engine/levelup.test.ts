import { describe, it, expect } from 'vitest';
import { levelUp } from '@/engine/levelup';
import { makeSeededRng } from '@/engine/rand';
import type { Character } from '@/engine/types';

const lvl1Fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
};

describe('levelUp', () => {
  it('refuses if newLevel <= current level', () => {
    const r = levelUp({ char: lvl1Fighter, newLevel: 1, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_an_increase');
  });

  it('refuses level > 20', () => {
    const r = levelUp({ char: { ...lvl1Fighter, level: 20 }, newLevel: 21, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('above_cap');
  });

  it('average HP gain: ceil(d/2)+1 + CON mod per level', () => {
    // d10 average = 6, +CON mod 2 → 8 per level. Going 1 → 3 = +16 hpMax.
    const r = levelUp({ char: lvl1Fighter, newLevel: 3, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const mut = r.mutations.find((m) => m.op === 'level_up');
    expect(mut).toBeDefined();
    expect((mut as { hpDelta: number }).hpDelta).toBe(16);
    expect((mut as { newLevel: number }).newLevel).toBe(3);
  });

  it('rolled HP gain rolls a hit die per level', () => {
    const r = levelUp({ char: lvl1Fighter, newLevel: 3, hpRollMode: 'rolled' }, makeSeededRng(7));
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(2);                  // two levels, two rolls
    const mut = r.mutations.find((m) => m.op === 'level_up') as { hpDelta: number };
    // each die in [1..10] + CON 2 → range [6, 24]
    expect(mut.hpDelta).toBeGreaterThanOrEqual(6);
    expect(mut.hpDelta).toBeLessThanOrEqual(24);
  });
});
