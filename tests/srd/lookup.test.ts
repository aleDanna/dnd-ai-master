import { describe, it, expect, afterAll } from 'vitest';
import { lookupSpell, lookupMonster, lookupRule, listSpells } from '@/srd/lookup';
import { pool } from '@/db/client';

describe('lookup', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('finds Magic Missile by slug', async () => {
    const spell = await lookupSpell('magic-missile');
    expect(spell?.name).toBe('Magic Missile');
    expect(spell?.level).toBe(1);
  });

  it('returns null for unknown slug', async () => {
    const spell = await lookupSpell('not-a-real-spell');
    expect(spell).toBeNull();
  });

  it('finds the Goblin', async () => {
    const monster = await lookupMonster('goblin');
    expect(monster?.name).toMatch(/goblin/i);
  });

  it('finds a rule section by anchor', async () => {
    const rule = await lookupRule('1.3 Advantage and Disadvantage');
    expect(rule?.markdown).toMatch(/2d20/);
  });

  it('lists all spells (paginated default)', async () => {
    const page = await listSpells({ limit: 10, offset: 0 });
    expect(page.length).toBeLessThanOrEqual(10);
    expect(page.length).toBeGreaterThan(0);
  });
});
