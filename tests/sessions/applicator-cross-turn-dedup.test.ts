import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, characters, inventoryGrants, campaigns } from '@/db/schema';
import { applyMutations } from '@/sessions/applicator';
import type { Mutation } from '@/engine/types';

/**
 * Cross-turn `add_inventory` dedup test.
 *
 * The master AI sometimes re-narrates the same loot in a following turn and
 * re-emits the `add_inventory` tool call. The in-batch dedup (same
 * applyMutations call) didn't catch it because each turn is its own
 * applyMutations invocation. The persistent `inventory_grants` log + recent-
 * window check inside the `add_inventory` case is what closes that gap.
 *
 * Tests below exercise the two halves of the contract:
 *  - exact (character, itemSlug, qty) repeats within the window are suppressed
 *  - same item with a different qty (a legitimate later pickup) still applies
 */

const TEST_USER = 'user_app_xturn_' + Date.now();
let SESSION_ID = '';
let PC_ID = '';

interface InvItem { slug: string; qty: number; equipped: boolean }
async function readGp(): Promise<number> {
  const [c] = await db
    .select({ inv: characters.inventory })
    .from(characters)
    .where(eq(characters.id, PC_ID))
    .limit(1);
  const inv = (c!.inv ?? []) as InvItem[];
  return inv.find((i) => i.slug === 'gp')?.qty ?? 0;
}
async function readItemQty(slug: string): Promise<number> {
  const [c] = await db
    .select({ inv: characters.inventory })
    .from(characters)
    .where(eq(characters.id, PC_ID))
    .limit(1);
  const inv = (c!.inv ?? []) as InvItem[];
  return inv.find((i) => i.slug === slug)?.qty ?? 0;
}

describe('add_inventory cross-turn dedup', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Dedup Subject';
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
    // inventory_grants cascades from sessions; explicit delete keeps the
    // teardown order obvious if FKs ever change.
    await db.execute(sql`delete from inventory_grants where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('suppresses an identical (character, item, qty) grant across two applyMutations calls', async () => {
    const before = await readItemQty('healing-potion');
    const mut: Mutation = { op: 'add_inventory', characterId: PC_ID, itemSlug: 'healing-potion', qty: 3 };
    await applyMutations(SESSION_ID, [mut], []);
    const afterFirst = await readItemQty('healing-potion');
    expect(afterFirst).toBe(before + 3);

    // Simulate the master re-narrating the same loot in the next turn.
    await applyMutations(SESSION_ID, [mut], []);
    const afterSecond = await readItemQty('healing-potion');
    expect(afterSecond).toBe(before + 3);   // unchanged — duplicate suppressed

    // Exactly ONE grant row should exist for this tuple.
    const grants = await db
      .select()
      .from(inventoryGrants)
      .where(eq(inventoryGrants.sessionId, SESSION_ID));
    const potionGrants = grants.filter(
      (g) => g.itemSlug === 'healing-potion' && g.qty === 3,
    );
    expect(potionGrants.length).toBe(1);
  });

  it('allows a same-item grant with a different qty (legitimate later pickup)', async () => {
    const before = await readGp();
    await applyMutations(
      SESSION_ID,
      [{ op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 50 }],
      [],
    );
    expect(await readGp()).toBe(before + 50);

    // Different qty → different dedup tuple → applies.
    await applyMutations(
      SESSION_ID,
      [{ op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 25 }],
      [],
    );
    expect(await readGp()).toBe(before + 75);

    // Now repeat the qty 25 grant — should be suppressed.
    await applyMutations(
      SESSION_ID,
      [{ op: 'add_inventory', characterId: PC_ID, itemSlug: 'gp', qty: 25 }],
      [],
    );
    expect(await readGp()).toBe(before + 75);   // still 75, second 25 suppressed
  });
});
