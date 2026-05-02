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

  it('returns null on cross-tenant getMyCharacter', async () => {
    const TEST_USER_B = 'user_test_other_' + Date.now();
    await ensureUser(TEST_USER_B, 'Other User');

    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Mallorea';
    const { id } = await saveCharacter({ userId: TEST_USER, wizard: w });

    // User B tries to read user A's character
    const got = await getMyCharacter(TEST_USER_B, id);
    expect(got).toBeNull();

    // Verify owner can still read
    const ownerGot = await getMyCharacter(TEST_USER, id);
    expect(ownerGot?.name).toBe('Mallorea');

    // Cleanup
    await db.execute(sql`delete from users where id = ${TEST_USER_B}`);
  });

  it('returns false on cross-tenant softDeleteCharacter', async () => {
    const TEST_USER_C = 'user_test_attacker_' + Date.now();
    await ensureUser(TEST_USER_C, 'Attacker');

    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'wizard';
    w.backgroundSlug = 'sage';
    w.identity.name = 'Polgara';
    const { id } = await saveCharacter({ userId: TEST_USER, wizard: w });

    // User C tries to delete user A's character
    const ok = await softDeleteCharacter(TEST_USER_C, id);
    expect(ok).toBe(false);

    // Verify still selectable as owner
    const stillThere = await getMyCharacter(TEST_USER, id);
    expect(stillThere?.name).toBe('Polgara');

    // Cleanup
    await db.execute(sql`delete from users where id = ${TEST_USER_C}`);
  });
});
