import { describe, it, expect } from 'vitest';
import {
  parseFirstAttackFromProse,
  getBestiaryAttackStats,
} from '@/app/api/sessions/[id]/turn/monster-bestiary';
import { rollDamage } from '@/engine/dice';
import { makeSeededRng } from '@/engine/rand';

// D-04 / D-07 — isolated SRD bestiary attack-prose parser.
// Verifies: 6 real prose forms parse, Multiattack-first skip, no-match null,
// ReDoS-bounded pathological input, slug/path-safety, and that every returned
// damageDice is rollDamage-consumable.

describe('parseFirstAttackFromProse', () => {
  it('parses the first attack from a two-attack colon-form line (goblin)', () => {
    const text =
      'Scimitar: +4 to hit, 5ft, 1d6+2 slashing. Shortbow: +4 to hit, range 80/320, 1d6+2 piercing.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 4, damageDice: '1d6+2' });
  });

  it('parses orc greataxe (+5 / 1d12+3)', () => {
    const text =
      'Greataxe: +5 to hit, 5ft, 1d12+3 slashing. Javelin: +5 to hit, 5ft / 30/120, 1d6+3 piercing.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 5, damageDice: '1d12+3' });
  });

  it('parses zombie slam (+3 / 1d6+1)', () => {
    const text = 'Slam: +3 to hit, 5ft, 1d6+1 bludgeoning.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 3, damageDice: '1d6+1' });
  });

  it('parses bandit-captain, skipping the leading Multiattack block (+5 / 1d6+3)', () => {
    const text =
      'Multiattack: 2 scimitar + 1 dagger (or 2 dagger ranged). Scimitar: +5 to hit, 5ft, 1d6+3 slashing. Dagger: +5 to hit, 5ft / 20/60, 1d4+3 piercing.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 5, damageDice: '1d6+3' });
  });

  it('skips a leading Multiattack line and uses the first +N to hit block (troll, synthetic 2d6+4)', () => {
    const text = 'Multiattack: 1 bite + 2 claws. Bite: +7 to hit, 5ft, 2d6+4 piercing.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 7, damageDice: '2d6+4' });
  });

  it('captures the primary die of a compound damage line, ignoring the +4d6 rider (adult red dragon)', () => {
    const text = 'Bite: +14 to hit, 10ft, 2d10+8 piercing + 4d6 fire.';
    expect(parseFirstAttackFromProse(text)).toEqual({ attackBonus: 14, damageDice: '2d10+8' });
  });

  it('returns null when no block has a "+N to hit" (parenthetical trait form)', () => {
    expect(parseFirstAttackFromProse('Nimble Escape (Disengage or Hide as a bonus action).')).toBeNull();
  });

  it('returns null on empty / whitespace input', () => {
    expect(parseFirstAttackFromProse('')).toBeNull();
    expect(parseFirstAttackFromProse('   ')).toBeNull();
  });

  it('returns null when a block has "+N to hit" but no dice', () => {
    expect(parseFirstAttackFromProse('Slam: +3 to hit, 5ft, bludgeoning.')).toBeNull();
  });

  it('returns null promptly on a 5,000-char pathological non-matching input (ReDoS-bounded)', () => {
    // Repeated near-match fragments that would trigger catastrophic backtracking
    // under a naive greedy multi-line pattern. Must complete well under a second.
    const pathological = ('+ to hit 1d ' + 'a'.repeat(20) + ' ').repeat(250).slice(0, 5000);
    const start = Date.now();
    const result = parseFirstAttackFromProse(pathological);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });

  it('every returned damageDice is rollDamage-consumable (> 0)', () => {
    const forms = [
      'Scimitar: +4 to hit, 5ft, 1d6+2 slashing.',
      'Greataxe: +5 to hit, 5ft, 1d12+3 slashing.',
      'Bite: +14 to hit, 10ft, 2d10+8 piercing + 4d6 fire.',
    ];
    for (const form of forms) {
      const parsed = parseFirstAttackFromProse(form);
      expect(parsed).not.toBeNull();
      const roll = rollDamage(parsed!.damageDice, {}, makeSeededRng(1));
      expect(roll.total).toBeGreaterThan(0);
    }
  });
});

describe('getBestiaryAttackStats', () => {
  it('reads handbook/monsters/goblin.md and returns the goblin attack profile', async () => {
    const stats = await getBestiaryAttackStats('Goblin');
    expect(stats).toEqual({ attackBonus: 4, damageDice: '1d6+2' });
  });

  it('slug-normalizes a multi-word name to match the on-disk filename (Bandit Captain)', async () => {
    const stats = await getBestiaryAttackStats('Bandit Captain');
    expect(stats).toEqual({ attackBonus: 5, damageDice: '1d6+3' });
  });

  it('skips the troll Multiattack block and returns its first real attack', async () => {
    const stats = await getBestiaryAttackStats('Troll');
    // troll.md: "Multiattack: ... Bite: +7 to hit, 5ft, 1d6+4 piercing. ..."
    expect(stats).toEqual({ attackBonus: 7, damageDice: '1d6+4' });
  });

  it('returns null for a name with no bestiary file (readVaultFile ERROR marker)', async () => {
    expect(await getBestiaryAttackStats('Veyra')).toBeNull();
  });

  it('returns null for a path-traversal name (safeVaultPath rejects it, never throws)', async () => {
    expect(await getBestiaryAttackStats('../../../etc/passwd')).toBeNull();
  });

  it('returns null (never throws) for a name that cannot produce a usable slug', async () => {
    await expect(getBestiaryAttackStats('!!!')).resolves.toBeNull();
    await expect(getBestiaryAttackStats('')).resolves.toBeNull();
  });

  it('returned damageDice from a real file is rollDamage-consumable', async () => {
    const stats = await getBestiaryAttackStats('Goblin');
    expect(stats).not.toBeNull();
    const roll = rollDamage(stats!.damageDice, {}, makeSeededRng(1));
    expect(roll.total).toBeGreaterThan(0);
  });
});
