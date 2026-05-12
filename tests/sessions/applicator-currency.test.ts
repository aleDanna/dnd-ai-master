import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, characters, campaigns } from '@/db/schema';
import { applyMutations } from '@/sessions/applicator';
import type { Mutation } from '@/engine/types';

/**
 * End-to-end test that the applicator routes currency `remove_inventory`
 * through the conversion-aware path, not the naive same-slug subtractor.
 *
 * The original bug: paying 3 gp with a silver-only purse left the inventory
 * untouched — `mergeInventoryRemove` looked for a gp row, didn't find it,
 * and silently kept everything. Now the applicator should "make change"
 * across denominations.
 */

const TEST_USER = 'user_app_currency_' + Date.now();
let SESSION_ID = '';
let PC_ID = '';

interface InvItem { slug: string; qty: number; equipped: boolean }
async function readInv(): Promise<InvItem[]> {
  const [c] = await db
    .select({ inv: characters.inventory })
    .from(characters)
    .where(eq(characters.id, PC_ID))
    .limit(1);
  return (c!.inv ?? []) as InvItem[];
}
async function qtyOf(slug: string): Promise<number> {
  const inv = await readInv();
  return inv.find((i) => i.slug === slug)?.qty ?? 0;
}
async function setInv(items: InvItem[]): Promise<void> {
  await db
    .update(characters)
    .set({ inventory: items, updatedAt: new Date() })
    .where(eq(characters.id, PC_ID));
}

describe('applicator currency conversion', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Coin Subject';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    PC_ID = charId;
    const [campaign] = await db.insert(campaigns).values({ userId: TEST_USER, name: 'Test campaign', premise: 'x' }).returning();
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: charId, campaignId: campaign!.id, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from inventory_grants where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('charges gp out of a silver-only purse by redistributing the change', async () => {
    // Set inventory to ONLY 50 sp (=500 cp). Master charges 3 gp (=300 cp).
    // Expected remainder: 200 cp → 2 gp.
    await setInv([{ slug: 'sp', qty: 50, equipped: false }]);
    const muts: Mutation[] = [
      { op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 3 },
    ];
    await applyMutations(SESSION_ID, muts, []);
    expect(await qtyOf('gp')).toBe(2);
    expect(await qtyOf('sp')).toBe(0);
  });

  it('charges sp out of a single gold coin and produces silver change', async () => {
    // 1 gp = 100 cp. Charge 7 sp = 70 cp. Remaining: 30 cp = 3 sp.
    await setInv([{ slug: 'gp', qty: 1, equipped: false }]);
    await applyMutations(
      SESSION_ID,
      [{ op: 'remove_inventory', characterId: PC_ID, itemSlug: 'sp', qty: 7 }],
      [],
    );
    expect(await qtyOf('gp')).toBe(0);
    expect(await qtyOf('sp')).toBe(3);
  });

  it('preserves the silver pile when paying gp out of a mixed purse with enough gp', async () => {
    // Fast path: 10 gp + 50 sp, charge 3 gp → 7 gp + 50 sp (sp untouched).
    await setInv([
      { slug: 'gp', qty: 10, equipped: false },
      { slug: 'sp', qty: 50, equipped: false },
    ]);
    await applyMutations(
      SESSION_ID,
      [{ op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 3 }],
      [],
    );
    expect(await qtyOf('gp')).toBe(7);
    expect(await qtyOf('sp')).toBe(50);    // preserved — no conversion needed
  });

  it('rejects payment that exceeds total coin value and leaves the purse intact', async () => {
    // 5 sp = 50 cp; charge 1 gp = 100 cp. Should be rejected.
    await setInv([{ slug: 'sp', qty: 5, equipped: false }]);
    await applyMutations(
      SESSION_ID,
      [{ op: 'remove_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 1 }],
      [],
    );
    expect(await qtyOf('sp')).toBe(5);     // unchanged
    expect(await qtyOf('gp')).toBe(0);
  });

  it('non-currency removes still use the simple subtraction path', async () => {
    // The conversion logic must NOT touch normal items — paying 1 longbow
    // out of an inventory with no longbow should NOT debit anything.
    await setInv([
      { slug: 'gp', qty: 10, equipped: false },
      { slug: 'longbow', qty: 1, equipped: false },
    ]);
    await applyMutations(
      SESSION_ID,
      [{ op: 'remove_inventory', characterId: PC_ID, itemSlug: 'longbow', qty: 1 }],
      [],
    );
    expect(await qtyOf('longbow')).toBe(0);
    expect(await qtyOf('gp')).toBe(10);    // currency untouched
  });
});
