import { describe, it, expect, afterAll } from 'vitest';
import { db, pool } from '@/db/client';
import { saveCharacter, getMyCharacter, softDeleteCharacter, listMyCharacters } from '@/characters/persist';
import { ensureUser } from '@/db/users';
import { emptyWizardState } from '@/characters/types';
import { sql } from 'drizzle-orm';

describe('character persistence (real DB)', () => {
  const TEST_USER = 'user_test_' + Date.now();

  afterAll(async () => {
    // Cleanup the test rows
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('saves and retrieves a character', async () => {
    await ensureUser(TEST_USER, 'Test User');
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const { id } = await saveCharacter({ userId: TEST_USER, wizard: w });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const got = await getMyCharacter(TEST_USER, id);
    expect(got?.name).toBe('Tharion');
    expect(got?.classSlug).toBe('fighter');
    expect(got?.hpMax).toBe(11);          // 10 + CON 1 (CON 13 → mod 1)
  });

  it('lists only the user’s characters', async () => {
    const list = await listMyCharacters(TEST_USER);
    expect(list.length).toBeGreaterThan(0);
    list.forEach((c) => expect(c.userId).toBe(TEST_USER));
  });

  it('soft-deletes', async () => {
    const list = await listMyCharacters(TEST_USER);
    const target = list[0];
    expect(target).toBeDefined();
    const ok = await softDeleteCharacter(TEST_USER, target!.id);
    expect(ok).toBe(true);
    const after = await getMyCharacter(TEST_USER, target!.id);
    expect(after).toBeNull();
  });
});
