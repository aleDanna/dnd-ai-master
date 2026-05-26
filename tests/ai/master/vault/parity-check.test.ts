/**
 * Phase 03-A plan 03-A-08 — parityCheck integration tests.
 *
 * The function under test exercises BOTH sides of the dual-write window:
 *   1. Vault side — reads events.md from VAULT_CAMPAIGNS_ROOT, replays it
 *      through the projector to compute the per-character state.
 *   2. Postgres side — reads `characters` + `session_state` rows.
 *
 * The suite therefore needs a real Postgres (DATABASE_URL gating, same
 * pattern as `dual-write-divergences.test.ts`) AND a per-test tmpdir for
 * VAULT_CAMPAIGNS_ROOT.
 *
 * Fixture strategy mirrors `tests/db/dual-write-divergences.test.ts` —
 * raw SQL inserts for the user + character rows to bypass the broken
 * saveCharacter pipeline (`src/characters/derive.ts` is in an unresolved
 * merge state — see `.planning/phases/03-migration-cutover/deferred-items.md`).
 * Drizzle is fine for the campaign/session/session_state inserts because
 * those tables have no transitive imports from the conflict files.
 *
 * Coverage matrix:
 *   1. skip — campaignId is not a UUID
 *   2. skip — events.md does not exist
 *   3. skip — events.md exists but is empty
 *   4. skip — character not seeded in events.md
 *   5. skip — Postgres `characters` row missing
 *   6. skip — Postgres `session_state` row missing
 *   7. match — vault and Postgres agree (returns null)
 *   8. divergence — hp_current differs
 *   9. divergence — conditions content differs
 *  10. normalization — different condition order is NOT a divergence
 *  11. normalization — different spell_slots key order is NOT a divergence
 *  12. divergence — inventory differs (vault `item` vs Postgres `slug`)
 *  13. divergence — multi-field — summary truncated at 200 chars
 *  14. attunements — NIT 1/4 — sourced from characters.attunedItems
 *  15. inspiration — NIT 1 — sourced from characters.inspiration (top-level)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';

const HAS_DB = !!process.env.DATABASE_URL;

// Stub VAULT_CAMPAIGNS_ROOT BEFORE any module load. The campaign-paths
// module resolves the constant at top-level via `./path`, so the value
// must be set before the dynamic imports inside `beforeAll` execute.
const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'parity-check-test-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

// Stable UUIDs for the suite — easier to grep + reproduce divergences.
const CAMPAIGN_UUID = '12121212-3434-5656-7878-9a9a9a9a9a9a';
const CHAR_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ABSENT_CHAR_UUID = 'cccccccc-9999-9999-9999-999999999999';

(HAS_DB ? describe : describe.skip)('parityCheck', () => {
  const TEST_USER = 'user_parity_' + Date.now();
  let SESSION_ID = '';
  // Bindings resolved after the env stub took effect.
  let db: typeof import('@/db/client').db;
  let pool: typeof import('@/db/client').pool;
  let schema: typeof import('@/db/schema');
  let parityCheck: typeof import('@/ai/master/vault/parity-check').parityCheck;
  let campaignDirPath: string;
  let eventsFilePath: string;

  beforeAll(async () => {
    vi.resetModules();
    const dbMod = await import('@/db/client');
    schema = await import('@/db/schema');
    const parityMod = await import('@/ai/master/vault/parity-check');
    const pathsMod = await import('@/ai/master/vault/campaign-paths');
    db = dbMod.db;
    pool = dbMod.pool;
    parityCheck = parityMod.parityCheck;
    eventsFilePath = pathsMod.eventsPath(CAMPAIGN_UUID);
    campaignDirPath = join(TEST_VAULT_ROOT, CAMPAIGN_UUID);

    // === Postgres fixture ===
    // User — minimal required fields. The users table only needs `id`.
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Character — raw SQL bypasses the broken saveCharacter pipeline.
    // Critical fields tested by the parity-check: hp_max, inventory,
    // spellcasting.slotsMax, spellSlotsUsed, attunedItems, inspiration,
    // resourcesUsed, level, xp.
    await db.execute(sql`
      insert into characters (
        id, user_id, name, level, xp,
        race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size,
        spellcasting, spell_slots_used, resources_used,
        inventory, attuned_items, inspiration
      ) values (
        ${CHAR_UUID}, ${TEST_USER}, 'Aragorn', 1, 0,
        'human', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 })}::jsonb,
        2, 30, 14, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 10,
        ${JSON.stringify(null)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify([])}::jsonb,
        ${JSON.stringify([])}::jsonb,
        false
      )
    `);

    // Campaign + session — drizzle is safe here (no conflict-file imports).
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        id: CAMPAIGN_UUID,
        userId: TEST_USER,
        name: 'Parity-check test campaign',
        premise: 'fixture',
      })
      .returning();
    if (!campaign) throw new Error('campaign insert failed');

    const [s] = await db
      .insert(schema.sessions)
      .values({
        userId: TEST_USER,
        characterId: CHAR_UUID,
        campaignId: CAMPAIGN_UUID,
        premise: 'fixture',
      })
      .returning();
    if (!s) throw new Error('session insert failed');
    SESSION_ID = s.id;

    // session_state — start at hpCurrent=30 to match the seed (default match).
    await db.insert(schema.sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 30,
      hitDiceRemaining: 0, // vault doesn't track yet — normalize to 0 both sides
    });
  });

  afterAll(async () => {
    // Reverse-FK order cleanup.
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (existsSync(TEST_VAULT_ROOT)) {
      rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    await pool.end();
  });

  /**
   * Reset the vault state to "no events.md" + Postgres to baseline before
   * each test so cases are independent.
   *
   * Baseline state:
   *   - vault: no events.md
   *   - postgres: hpCurrent=30, hp_max=30, no conditions, no inventory,
   *               no attunements, inspiration=false, spellcasting=null
   */
  beforeEach(async () => {
    if (existsSync(campaignDirPath)) {
      rmSync(campaignDirPath, { recursive: true, force: true });
    }
    await db
      .update(schema.sessionState)
      .set({
        hpCurrent: 30,
        tempHp: 0,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        flags: {},
        exhaustionLevel: 0,
        concentratingOn: null,
        hitDiceRemaining: 0,
        resourcesUsed: {},
      })
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    await db
      .update(schema.characters)
      .set({
        hpMax: 30,
        inventory: [],
        attunedItems: [],
        inspiration: false,
        spellcasting: null,
        spellSlotsUsed: {},
        resourcesUsed: {},
        xp: 0,
        level: 1,
      })
      .where(eq(schema.characters.id, CHAR_UUID));
  });

  /**
   * Helper: write a sequence of envelopes to events.md. Each envelope is
   * JSON-stringified one-per-line (matches the on-disk format the
   * projector's `parseEventsFile` consumes).
   */
  async function writeEvents(envelopes: VaultEventEnvelope[]): Promise<void> {
    mkdirSync(campaignDirPath, { recursive: true });
    const lines = envelopes.map((env) => JSON.stringify(env)).join('\n') + '\n';
    await writeFile(eventsFilePath, lines, 'utf8');
  }

  /**
   * Helper: build a campaign_initialized seed envelope. Mirrors the shape
   * the flip script emits in plan 03-A-06.
   */
  function seedEnvelope(
    hpMax: number,
    hpCurrent?: number,
    spellSlots?: Record<string, { max: number; used: number }>,
  ): VaultEventEnvelope {
    const seed: {
      id: string;
      name: string;
      hp_max: number;
      hp_current?: number;
      spell_slots?: Record<string, { max: number; used: number }>;
    } = {
      id: CHAR_UUID,
      name: 'Aragorn',
      hp_max: hpMax,
    };
    if (hpCurrent !== undefined) seed.hp_current = hpCurrent;
    if (spellSlots !== undefined) seed.spell_slots = spellSlots;
    return {
      id: '00000000-aaaa-bbbb-cccc-000000000001',
      version: 1,
      type: 'campaign_initialized',
      payload: { characters: [seed] },
      timestamp: '2026-05-26T00:00:00.000Z',
    };
  }

  /**
   * Helper: build a mutation envelope for the test character. `idSuffix`
   * is appended to a fixed UUID prefix so each envelope has a unique id
   * (matches the dispatcher's `crypto.randomUUID()` contract; the tests
   * just need them distinct).
   */
  function mutEnvelope(
    type: VaultEventEnvelope['type'],
    payload: Record<string, unknown>,
    idSuffix = '0002',
  ): VaultEventEnvelope {
    return {
      id: `00000000-aaaa-bbbb-cccc-00000000${idSuffix}`,
      version: 1,
      type,
      payload: { character: CHAR_UUID, ...payload } as VaultEventEnvelope['payload'],
      timestamp: '2026-05-26T00:00:01.000Z',
    };
  }

  // ===== Skip cases =====

  describe('skip cases (return null, not a ParityResult)', () => {
    it('returns null when campaignId is not a UUID', async () => {
      const r = await parityCheck('not-a-uuid', CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('returns null when events.md does not exist (campaign not on vault)', async () => {
      // No writeEvents call — events.md absent.
      expect(existsSync(eventsFilePath)).toBe(false);
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('returns null when events.md exists but is empty', async () => {
      mkdirSync(campaignDirPath, { recursive: true });
      await writeFile(eventsFilePath, '', 'utf8');
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('returns null when character not in any seed', async () => {
      // Seed a DIFFERENT character — TEST_CHAR_UUID's state has no entry.
      const otherCharSeed: VaultEventEnvelope = {
        id: '00000000-aaaa-bbbb-cccc-00000000ffff',
        version: 1,
        type: 'campaign_initialized',
        payload: {
          characters: [
            { id: ABSENT_CHAR_UUID, name: 'Legolas', hp_max: 25 },
          ],
        },
        timestamp: '2026-05-26T00:00:00.000Z',
      };
      await writeEvents([otherCharSeed]);
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('returns null when Postgres characters row is missing', async () => {
      await writeEvents([seedEnvelope(30, 30)]);
      // Query a character UUID that has no row in the DB.
      const r = await parityCheck(
        CAMPAIGN_UUID,
        '99999999-9999-9999-9999-999999999999',
        SESSION_ID,
      );
      expect(r).toBeNull();
    });

    it('returns null when Postgres session_state row is missing', async () => {
      await writeEvents([seedEnvelope(30, 30)]);
      // Query a sessionId with no session_state row. (We don't delete the
      // real fixture row because afterAll's cascade would error; instead
      // we use an orphan UUID that has no session_state entry.)
      const r = await parityCheck(
        CAMPAIGN_UUID,
        CHAR_UUID,
        '99999999-9999-9999-9999-999999999999',
      );
      expect(r).toBeNull();
    });
  });

  // ===== Match (null on agreement) =====

  describe('match cases (return null on agreement)', () => {
    it('returns null when seed hp matches Postgres hp', async () => {
      // Seed: hp_max=30, hp_current=30 (omit; falls back to hp_max)
      // Postgres: hpMax=30, hpCurrent=30 (set in beforeEach)
      await writeEvents([seedEnvelope(30)]);
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('returns null after a converging hp_change', async () => {
      // Vault: seed at 30, then -5 → hp_current=25
      // Postgres: hpCurrent=25
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('hp_change', { delta: -5 }, '0002'),
      ]);
      await db
        .update(schema.sessionState)
        .set({ hpCurrent: 25 })
        .where(eq(schema.sessionState.sessionId, SESSION_ID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });
  });

  // ===== Divergence detection =====

  describe('divergence detection (return ParityResult on mismatch)', () => {
    it('detects hp_current divergence', async () => {
      // Vault: hp_current=30 (seed default)
      // Postgres: hpCurrent=15
      await writeEvents([seedEnvelope(30, 30)]);
      await db
        .update(schema.sessionState)
        .set({ hpCurrent: 15 })
        .where(eq(schema.sessionState.sessionId, SESSION_ID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.diverged).toBe(true);
      expect(r!.summary).toMatch(/hp_current/);
      expect(r!.summary).toContain('vault=30');
      expect(r!.summary).toContain('postgres=15');
      expect(r!.vault.hp_current).toBe(30);
      expect(r!.postgres.hp_current).toBe(15);
    });

    it('detects conditions divergence', async () => {
      // Vault: condition_add poisoned
      // Postgres: no conditions
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('condition_add', { condition: 'poisoned' }),
      ]);
      // Postgres conditions stays [] (beforeEach default).
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.summary).toMatch(/conditions/);
      expect(r!.vault.conditions).toEqual(['poisoned']);
      expect(r!.postgres.conditions).toEqual([]);
    });

    it('detects inventory divergence (vault item vs Postgres slug projected)', async () => {
      // Vault: inventory_add potion x3
      // Postgres: inventory has [{ slug: 'rope', qty: 1, equipped: false }]
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('inventory_add', { item: 'potion', qty: 3 }),
      ]);
      await db
        .update(schema.characters)
        .set({ inventory: [{ slug: 'rope', qty: 1, equipped: false }] })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.summary).toMatch(/inventory/);
      // Vault has potion=3; Postgres has rope=1 (projected to {item:'rope',qty:1}).
      expect(r!.vault.inventory).toEqual([{ item: 'potion', qty: 3 }]);
      expect(r!.postgres.inventory).toEqual([{ item: 'rope', qty: 1 }]);
    });
  });

  // ===== Normalization (no false positives) =====

  describe('normalization — sort order does not trigger divergence', () => {
    it('conditions sorted on both sides produces no divergence', async () => {
      // Vault: condition_add poisoned + condition_add blessed
      //   → projector sorts to ['blessed', 'poisoned']
      // Postgres: conditions stored in REVERSE order [poisoned, blessed]
      //   → normalizer sorts to ['blessed', 'poisoned']
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('condition_add', { condition: 'poisoned' }, '0002'),
        mutEnvelope('condition_add', { condition: 'blessed' }, '0003'),
      ]);
      await db
        .update(schema.sessionState)
        .set({
          conditions: [
            { slug: 'poisoned', source: 'spell', durationRounds: 'until_removed', appliedRound: 1 },
            { slug: 'blessed', source: 'spell', durationRounds: 'until_removed', appliedRound: 1 },
          ],
        })
        .where(eq(schema.sessionState.sessionId, SESSION_ID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('inventory sorted on both sides produces no divergence', async () => {
      // Vault: inventory_add rope, then inventory_add potion
      //   → projector sorts by item to [{potion,1},{rope,2}]
      // Postgres: inventory in reverse order — normalizer sorts.
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('inventory_add', { item: 'rope', qty: 2 }, '0002'),
        mutEnvelope('inventory_add', { item: 'potion', qty: 1 }, '0003'),
      ]);
      await db
        .update(schema.characters)
        .set({
          inventory: [
            { slug: 'rope', qty: 2, equipped: false },
            { slug: 'potion', qty: 1, equipped: false },
          ],
        })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('spell_slots — different key insertion order yields no divergence', async () => {
      // Vault seed declares spell_slots with keys "1","2" (sorted in seed).
      // Postgres spellcasting.slotsMax declares keys "2","1" (reverse).
      // Both normalize to the same sorted-key representation.
      await writeEvents([
        seedEnvelope(30, 30, { '1': { max: 4, used: 1 }, '2': { max: 2, used: 0 } }),
      ]);
      await db
        .update(schema.characters)
        .set({
          spellcasting: {
            ability: 'INT',
            spellSaveDC: 13,
            spellAttackBonus: 5,
            // Insertion order reversed — buildSpellSlots + normalizeSpellSlots
            // walks Object.keys().sort() to neutralize this.
            slotsMax: { '2': 2, '1': 4 },
            spellsKnown: [],
            spellsPrepared: [],
          },
          spellSlotsUsed: { '1': 1 },
        })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).toBeNull();
    });
  });

  // ===== NIT 1 / NIT 4 source-mapping verification =====

  describe('NIT resolution — attunements + inspiration source mapping', () => {
    it('attunements diverges when characters.attunedItems differs from vault [] default', async () => {
      // Vault: no attunement events (Phase 02 doesn't emit; vault state
      //   normalizes to []).
      // Postgres: characters.attunedItems = ['ring-of-protection']
      // Expected: divergence on attunements (vault=[] vs postgres=[ring...]).
      await writeEvents([seedEnvelope(30, 30)]);
      await db
        .update(schema.characters)
        .set({ attunedItems: ['ring-of-protection'] })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.summary).toMatch(/attunements/);
      // NIT 4 — the postgres side reads from characters.attunedItems
      // (the real column), NOT a hardcoded stub.
      expect(r!.postgres.attunements).toEqual(['ring-of-protection']);
      expect(r!.vault.attunements).toEqual([]);
    });

    it('flags.inspiration diverges when characters.inspiration is true and vault default is false', async () => {
      // NIT 1 — characters.inspiration is top-level boolean, NOT inside
      // session_state.flags. The normalizer must read it from the character row.
      await writeEvents([seedEnvelope(30, 30)]);
      await db
        .update(schema.characters)
        .set({ inspiration: true })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.summary).toMatch(/flags/);
      // Postgres flags.inspiration is sourced from characters.inspiration.
      expect((r!.postgres.flags as { inspiration: boolean }).inspiration).toBe(true);
      expect((r!.vault.flags as { inspiration: boolean }).inspiration).toBe(false);
    });
  });

  // ===== Summary cap =====

  describe('summary truncation', () => {
    it('summary is capped at 200 chars when many fields diverge', async () => {
      // Force divergences on many fields at once.
      await writeEvents([
        seedEnvelope(30, 30),
        mutEnvelope('condition_add', { condition: 'poisoned' }, '0002'),
        mutEnvelope('inventory_add', { item: 'potion', qty: 3 }, '0003'),
      ]);
      await db
        .update(schema.sessionState)
        .set({
          hpCurrent: 1, // hp_current divergence
          conditions: [], // conditions divergence
          // tempHp/exhaustionLevel stay 0 (no divergence)
        })
        .where(eq(schema.sessionState.sessionId, SESSION_ID));
      await db
        .update(schema.characters)
        .set({
          hpMax: 999, // hp_max divergence
          inventory: [], // inventory divergence
          attunedItems: ['ring-a', 'ring-b'], // attunements divergence
          inspiration: true, // flags.inspiration divergence
          xp: 1000, // xp divergence
          level: 9, // level divergence
          resourcesUsed: { rage: 1 }, // resources_used divergence
        })
        .where(eq(schema.characters.id, CHAR_UUID));
      const r = await parityCheck(CAMPAIGN_UUID, CHAR_UUID, SESSION_ID);
      expect(r).not.toBeNull();
      expect(r!.summary.length).toBeLessThanOrEqual(200);
      // Truncated summaries end with the ellipsis sentinel from the cap logic.
      if (r!.summary.length === 200) {
        expect(r!.summary.endsWith('...')).toBe(true);
      }
    });
  });
});
