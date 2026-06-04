/**
 * tests/campaigns/seed-vault.test.ts — unit tests for seedCampaignVault.
 *
 * Regression guard for the creation-flow seeding bug: new campaigns are born
 * `masterBackend=vault` + `vaultMutations=true` (initial-settings.ts), so the
 * flag-keyed `enableMutationsForCampaign` early-returns and NEVER writes the
 * `campaign_initialized` genesis. Without the genesis, `materializeFromVault`
 * cannot resolve the viewer PC → returns null → the client snapshot falls back
 * to Postgres (inCombat=false, no encounter, no CombatTracker).
 *
 * `seedCampaignVault` fixes this by keying idempotency on the ACTUAL events.md
 * genesis, not the settings flag.
 *
 * DATABASE_URL-gated (assembleCampaignSeedPayload hits live Postgres), same
 * pattern as tests/scripts/vault-flip-helpers.test.ts. VAULT_CAMPAIGNS_ROOT is
 * stubbed to a per-suite tmpdir so events.md lands under the sandbox.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'seed-vault-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

(HAS_DB ? describe : describe.skip)('seedCampaignVault', () => {
  const TEST_USER = 'user_seedvault_' + Date.now();
  let CAMPAIGN_ID = '';
  let CHARACTER_ID = '';

  let seedMod: typeof import('@/campaigns/seed-vault');
  let dbMod: typeof import('@/db/client');
  let schemaMod: typeof import('@/db/schema');
  let projectorMod: typeof import('@/ai/master/vault/projector');
  let pathsMod: typeof import('@/ai/master/vault/campaign-paths');

  beforeAll(async () => {
    vi.resetModules();
    seedMod = await import('@/campaigns/seed-vault');
    dbMod = await import('@/db/client');
    schemaMod = await import('@/db/schema');
    projectorMod = await import('@/ai/master/vault/projector');
    pathsMod = await import('@/ai/master/vault/campaign-paths');

    const { db } = dbMod;
    const { campaigns, characters } = schemaMod;
    const { ensureUser } = await import('@/db/users');

    await ensureUser(TEST_USER);
    const [charRow] = await db
      .insert(characters)
      .values({
        userId: TEST_USER,
        name: 'Luffy',
        level: 1,
        xp: 0,
        raceSlug: 'human',
        classSlug: 'fighter',
        backgroundSlug: 'folk-hero',
        abilities: { STR: 16, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 12 },
        proficiencyBonus: 2,
        hpMax: 12,
        ac: 15,
        speed: 30,
        proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
        identity: { alignment: 'chaotic-good' },
        hitDiceMax: 1,
        hitDieSize: 10,
      })
      .returning();
    CHARACTER_ID = charRow!.id;

    // Campaign born full-vault (the real creation shape that triggers the bug).
    const [campaign] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: 'Seed-vault fixture',
        premise: 'fixture',
        settings: { masterBackend: 'vault', vaultMutations: true, sourceOfTruth: 'vault' },
      })
      .returning();
    CAMPAIGN_ID = campaign!.id;

    // Instance shape: campaignId set + templateId self (the LEFT JOIN edge).
    await db
      .update(characters)
      .set({ campaignId: CAMPAIGN_ID, templateId: CHARACTER_ID })
      .where(eq(characters.id, CHARACTER_ID));
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db, pool } = dbMod;
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (existsSync(TEST_VAULT_ROOT)) rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
    vi.unstubAllEnvs();
    await pool.end();
  });

  it('writes the campaign_initialized genesis on a fresh (unseeded) vault campaign', async () => {
    const r = await seedMod.seedCampaignVault(CAMPAIGN_ID);
    expect(r.seeded).toBe(true);
    expect(r.charactersSeeded).toBe(1);
    expect(r.seedEventId).toBeTruthy();

    const events = await projectorMod.parseEventsFile(pathsMod.eventsPath(CAMPAIGN_ID));
    const genesis = events.filter((e) => e.type === 'campaign_initialized');
    expect(genesis).toHaveLength(1);
    expect(genesis[0]!.payload).toMatchObject({
      characters: [{ id: CHARACTER_ID, name: 'Luffy', hp_max: 12 }],
    });
  });

  it('is idempotent — a second call does NOT append a second genesis', async () => {
    const r = await seedMod.seedCampaignVault(CAMPAIGN_ID);
    expect(r.seeded).toBe(false);

    const events = await projectorMod.parseEventsFile(pathsMod.eventsPath(CAMPAIGN_ID));
    const genesis = events.filter((e) => e.type === 'campaign_initialized');
    expect(genesis).toHaveLength(1); // still exactly one
  });
});
