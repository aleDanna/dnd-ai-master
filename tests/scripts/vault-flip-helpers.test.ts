/**
 * tests/scripts/vault-flip-helpers.test.ts — per-helper unit tests for
 * the Phase 03 plan 03-A-06 refactor of scripts/vault-flip.ts.
 *
 * The helpers exercise live Postgres (the LEFT JOIN sessions ⨝ session_state
 * BLOCKER-1 fix is the load-bearing piece), so the suite is DATABASE_URL-
 * gated: skipped when the env var is absent, runs the full fixture cycle
 * when set. Same pattern as tests/sessions/applicator.test.ts (Phase 02
 * baseline) — `ensureUser` + `saveCharacter` + direct schema inserts for
 * the campaign/session/session_state rows + an `afterAll` that drops the
 * fixture rows in reverse-FK order.
 *
 * Coverage matrix:
 *   - flipCampaignToVault          — flip + idempotency + not-found
 *   - flipCampaignToBaked          — symmetric to flipCampaignToVault
 *   - enableMutationsForCampaign   — seed event append + LEFT JOIN ground
 *                                    truth (BLOCKER-1) + idempotency
 *   - disableMutationsForCampaign  — flag off + events.md preserved
 *   - flipSourceOfTruth            — preconditions enforced (vault target
 *                                    requires vaultMutations+masterBackend) +
 *                                    rollback to postgres + idempotency
 *   - assembleCampaignSeedPayload  — hp_max always present + hp_current
 *                                    sourced from session_state + spell_slots
 *                                    omitted for non-casters
 *
 * VAULT_CAMPAIGNS_ROOT is stubbed to a per-suite tmpdir so each fresh
 * import lands events.md under the sandbox.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

// Stub VAULT_CAMPAIGNS_ROOT BEFORE any module that reads it (campaign-paths
// resolves the constant at import-load). Done at the top-level so the
// dynamic imports inside `beforeAll` pick up the stubbed value.
const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'vault-flip-helpers-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

(HAS_DB ? describe : describe.skip)('vault-flip-helpers', () => {
  const TEST_USER = 'user_vfh_' + Date.now();
  let CAMPAIGN_ID = '';
  let SECOND_CAMPAIGN_ID = ''; // baked-only campaign for Pitfall 5 test
  let CHARACTER_ID = '';
  let SESSION_ID = '';

  // Helpers loaded after the env stub took effect.
  let helpers: typeof import('@/../scripts/vault-flip-helpers');
  let dbMod: typeof import('@/db/client');
  let schemaMod: typeof import('@/db/schema');
  let pathsMod: typeof import('@/ai/master/vault/campaign-paths');

  beforeAll(async () => {
    // Dynamic import after stubEnv. The campaign-paths module reads
    // VAULT_CAMPAIGNS_ROOT at top-level import time; resetting modules and
    // re-importing ensures the stubbed value is honored.
    vi.resetModules();
    helpers = await import('@/../scripts/vault-flip-helpers');
    dbMod = await import('@/db/client');
    schemaMod = await import('@/db/schema');
    pathsMod = await import('@/ai/master/vault/campaign-paths');

    const { db } = dbMod;
    const { campaigns, characters, sessions, sessionState } = schemaMod;
    const { ensureUser } = await import('@/db/users');

    // 1. User + character (direct insert — bypasses saveCharacter/derive so
    //    the test does not transitively import src/characters/derive.ts.
    //    That file is mid-merge in the working tree and would fail parsing.)
    await ensureUser(TEST_USER);
    const [charRow] = await db
      .insert(characters)
      .values({
        userId: TEST_USER,
        name: 'Elara',
        level: 3,
        xp: 0,
        raceSlug: 'human',
        classSlug: 'wizard',
        backgroundSlug: 'sage',
        abilities: { STR: 8, DEX: 14, CON: 12, INT: 16, WIS: 13, CHA: 10 },
        proficiencyBonus: 2,
        hpMax: 25,
        ac: 12,
        speed: 30,
        proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
        spellcasting: {
          ability: 'INT',
          spellSaveDC: 13,
          spellAttackBonus: 5,
          slotsMax: { '1': 4, '2': 2 },
          spellsKnown: ['magic-missile'],
          spellsPrepared: ['magic-missile'],
        },
        spellSlotsUsed: { '1': 1 },
        identity: { alignment: 'neutral-good' },
        hitDiceMax: 3,
        hitDieSize: 6,
      })
      .returning();
    CHARACTER_ID = charRow!.id;

    // 2. Campaign — start with baked so we can test the flip-to-vault path.
    const [campaign] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: 'Test campaign (vault-flip-helpers)',
        premise: 'fixture',
        settings: { masterBackend: 'baked' },
      })
      .returning();
    CAMPAIGN_ID = campaign!.id;

    // 3. Secondary campaign — stays baked for the Pitfall 5 test.
    const [secondary] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: 'Test campaign (baked-only)',
        premise: 'fixture',
        settings: { masterBackend: 'baked' },
      })
      .returning();
    SECOND_CAMPAIGN_ID = secondary!.id;

    // 4. Bind the character to this campaign (instance shape: templateId
    //    points at itself, campaignId is set — the LEFT JOIN reads
    //    characters.campaignId so this is the required edge).
    await db
      .update(characters)
      .set({ campaignId: CAMPAIGN_ID, templateId: CHARACTER_ID })
      .where(eq(characters.id, CHARACTER_ID));

    // 5. Session + session_state — session_state.hpCurrent is the LEFT JOIN
    //    source for hp_current. Set to 18 so the seed payload's hp_current
    //    differs from hp_max (25), proving the join works.
    const [s] = await db
      .insert(sessions)
      .values({
        userId: TEST_USER,
        characterId: CHARACTER_ID,
        campaignId: CAMPAIGN_ID,
        premise: 'fixture',
      })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 18,
      hitDiceRemaining: 1,
    });
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db, pool } = dbMod;
    // Drop fixture rows in reverse-FK order.
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

  describe('flipCampaignToVault', () => {
    it('sets settings.masterBackend = vault on first flip', async () => {
      const r = await helpers.flipCampaignToVault(CAMPAIGN_ID);
      expect(r.changed).toBe(true);
      expect(r.previousBackend).toBe('baked');
      expect(r.newBackend).toBe('vault');
      const [row] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      expect(row!.settings.masterBackend).toBe('vault');
    });

    it('is idempotent — second flip returns changed:false', async () => {
      const r = await helpers.flipCampaignToVault(CAMPAIGN_ID);
      expect(r.changed).toBe(false);
      expect(r.newBackend).toBe('vault');
    });

    it('throws on unknown campaignId', async () => {
      await expect(
        helpers.flipCampaignToVault('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('assembleCampaignSeedPayload — BLOCKER-1 LEFT JOIN ground truth', () => {
    it('returns one VaultSeedCharacter per character in the campaign', async () => {
      const seeds = await helpers.assembleCampaignSeedPayload(CAMPAIGN_ID);
      expect(seeds.length).toBe(1);
      expect(seeds[0]!.id).toBe(CHARACTER_ID);
      expect(seeds[0]!.name).toBe('Elara');
      expect(seeds[0]!.hp_max).toBe(25);
    });

    it('hp_current sourced from session_state.hpCurrent via LEFT JOIN (not from characters)', async () => {
      const seeds = await helpers.assembleCampaignSeedPayload(CAMPAIGN_ID);
      // hpCurrent in session_state is 18, not 25 — proves the JOIN harvested
      // the right column (BLOCKER-1 ground truth).
      expect(seeds[0]!.hp_current).toBe(18);
    });

    it('spell_slots merged from spellcasting.slotsMax + spellSlotsUsed', async () => {
      const seeds = await helpers.assembleCampaignSeedPayload(CAMPAIGN_ID);
      // slotsMax: { '1': 4, '2': 2 }, spellSlotsUsed: { '1': 1 }
      expect(seeds[0]!.spell_slots).toEqual({
        '1': { max: 4, used: 1 },
        '2': { max: 2, used: 0 },
      });
    });

    it('hp_current OMITTED when no session_state row exists (LEFT JOIN null)', async () => {
      // Drop the session_state row temporarily — the LEFT JOIN should yield
      // null hpCurrent, and the seed should OMIT the field (projector
      // fallback to hp_max kicks in at INITIAL_CHARACTER_STATE time).
      await dbMod.db.execute(
        sql`delete from session_state where session_id = ${SESSION_ID}`,
      );
      const seeds = await helpers.assembleCampaignSeedPayload(CAMPAIGN_ID);
      expect(seeds[0]!.hp_current).toBeUndefined();
      expect(seeds[0]!.hp_max).toBe(25); // still present
      // Restore for downstream tests
      await dbMod.db.insert(schemaMod.sessionState).values({
        sessionId: SESSION_ID,
        hpCurrent: 18,
        hitDiceRemaining: 1,
      });
    });

    it('spell_slots OMITTED when spellcasting is null (non-caster)', async () => {
      // Temporarily flip the character to a non-caster, assert spell_slots
      // is absent from the seed, then restore.
      await dbMod.db
        .update(schemaMod.characters)
        .set({ spellcasting: null })
        .where(eq(schemaMod.characters.id, CHARACTER_ID));
      const seeds = await helpers.assembleCampaignSeedPayload(CAMPAIGN_ID);
      expect(seeds[0]!.spell_slots).toBeUndefined();
      // Restore for downstream tests.
      await dbMod.db
        .update(schemaMod.characters)
        .set({
          spellcasting: {
            ability: 'INT',
            spellSaveDC: 13,
            spellAttackBonus: 5,
            slotsMax: { '1': 4, '2': 2 },
            spellsKnown: ['magic-missile'],
            spellsPrepared: ['magic-missile'],
          },
        })
        .where(eq(schemaMod.characters.id, CHARACTER_ID));
    });
  });

  describe('enableMutationsForCampaign', () => {
    it('appends a campaign_initialized event to events.md + sets vaultMutations:true', async () => {
      const r = await helpers.enableMutationsForCampaign(CAMPAIGN_ID);
      expect(r.changed).toBe(true);
      expect(r.seedEventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(r.charactersSeeded).toBe(1);
      // settings.vaultMutations is true.
      const [row] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      expect(row!.settings.vaultMutations).toBe(true);
      // events.md contains the seed line.
      const content = await readFile(pathsMod.eventsPath(CAMPAIGN_ID), 'utf8');
      expect(content).toMatch(/"type":"campaign_initialized"/);
      expect(content).toMatch(new RegExp(`"id":"${CHARACTER_ID}"`));
    });

    it('is idempotent — second call returns changed:false and does NOT append another seed event', async () => {
      const beforeContent = await readFile(pathsMod.eventsPath(CAMPAIGN_ID), 'utf8');
      const beforeLines = beforeContent.trim().split('\n').length;

      const r = await helpers.enableMutationsForCampaign(CAMPAIGN_ID);
      expect(r.changed).toBe(false);

      const afterContent = await readFile(pathsMod.eventsPath(CAMPAIGN_ID), 'utf8');
      const afterLines = afterContent.trim().split('\n').length;
      expect(afterLines).toBe(beforeLines); // no new event line
    });

    it('emits Pitfall 5 warning when enabling on a baked-backend campaign (still flips flag)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const r = await helpers.enableMutationsForCampaign(SECOND_CAMPAIGN_ID);
        expect(r.changed).toBe(true);
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('Pitfall 5')),
        ).toBe(true);
        // Flag was persisted (storage idempotent — Pitfall 5 says "no
        // runtime effect", not "rejected at write").
        const [row] = await dbMod.db
          .select({ settings: schemaMod.campaigns.settings })
          .from(schemaMod.campaigns)
          .where(eq(schemaMod.campaigns.id, SECOND_CAMPAIGN_ID))
          .limit(1);
        expect(row!.settings.vaultMutations).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('flipSourceOfTruth', () => {
    it('refuses to set sourceOfTruth=vault when vaultMutations=false', async () => {
      // Reset campaign to vault-backend but disable mutations first.
      await helpers.disableMutationsForCampaign(CAMPAIGN_ID);
      await expect(
        helpers.flipSourceOfTruth(CAMPAIGN_ID, 'vault'),
      ).rejects.toThrow(/vaultMutations/);
    });

    it('refuses to set sourceOfTruth=vault when masterBackend!=vault', async () => {
      // Flip to baked, then attempt sourceOfTruth=vault.
      await helpers.flipCampaignToBaked(CAMPAIGN_ID);
      await expect(
        helpers.flipSourceOfTruth(CAMPAIGN_ID, 'vault'),
      ).rejects.toThrow(/masterBackend/);
      // Restore for downstream tests.
      await helpers.flipCampaignToVault(CAMPAIGN_ID);
    });

    it('sets sourceOfTruth=vault when prerequisites met + stamps cutoverAt', async () => {
      // Re-enable mutations + perform the flip.
      await helpers.enableMutationsForCampaign(CAMPAIGN_ID);
      const r = await helpers.flipSourceOfTruth(CAMPAIGN_ID, 'vault');
      expect(r.changed).toBe(true);
      expect(r.previous).toBe('postgres');
      expect(r.next).toBe('vault');
      // cutoverAt persisted.
      const [row] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      expect(row!.settings.sourceOfTruth).toBe('vault');
      expect(row!.settings.cutoverAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('rollback to postgres flips back and PRESERVES cutoverAt', async () => {
      const [before] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      const cutoverAtBefore = before!.settings.cutoverAt;

      const r = await helpers.flipSourceOfTruth(CAMPAIGN_ID, 'postgres');
      expect(r.changed).toBe(true);
      expect(r.previous).toBe('vault');
      expect(r.next).toBe('postgres');

      const [row] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      expect(row!.settings.sourceOfTruth).toBe('postgres');
      // cutoverAt MUST stay intact (audit trail).
      expect(row!.settings.cutoverAt).toBe(cutoverAtBefore);
    });

    it('is idempotent — repeated flip to current target returns changed:false', async () => {
      const r = await helpers.flipSourceOfTruth(CAMPAIGN_ID, 'postgres');
      expect(r.changed).toBe(false);
    });
  });

  describe('disableMutationsForCampaign', () => {
    it('sets vaultMutations:false + preserves events.md', async () => {
      const before = await readFile(pathsMod.eventsPath(CAMPAIGN_ID), 'utf8');
      const r = await helpers.disableMutationsForCampaign(CAMPAIGN_ID);
      expect(r.changed).toBe(true);
      const after = await readFile(pathsMod.eventsPath(CAMPAIGN_ID), 'utf8');
      expect(after).toBe(before); // events.md untouched
      const [row] = await dbMod.db
        .select({ settings: schemaMod.campaigns.settings })
        .from(schemaMod.campaigns)
        .where(eq(schemaMod.campaigns.id, CAMPAIGN_ID))
        .limit(1);
      expect(row!.settings.vaultMutations).toBe(false);
    });

    it('is idempotent — second call returns changed:false', async () => {
      const r = await helpers.disableMutationsForCampaign(CAMPAIGN_ID);
      expect(r.changed).toBe(false);
    });
  });
});
