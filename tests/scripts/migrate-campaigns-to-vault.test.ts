/**
 * tests/scripts/migrate-campaigns-to-vault.test.ts — CLI smoke tests for
 * the Phase 03-A plan 03-A-07 bulk migration script.
 *
 * Pattern: spawn the CLI via spawnSync (same approach as
 * tests/scripts/vault-backup.test.ts) and assert against stdout summary
 * lines + DB state + on-disk events.md presence. The test is
 * DATABASE_URL-gated — skipped when the env var is absent.
 *
 * The fixtures live under a per-suite tmpdir VAULT_CAMPAIGNS_ROOT so
 * each CLI invocation lands events.md under the sandbox. Three campaigns
 * are seeded (migrate-test-a/b/c) with a single character bound to
 * campaign A only — the missing-character path on B and C exercises
 * the "no characters bound" warning path of enableMutationsForCampaign
 * (still succeeds with an empty seed payload).
 *
 * Coverage matrix:
 *   1. --dry-run does NOT mutate the database
 *   2. Default invocation migrates matched campaigns end-to-end
 *   3. Re-running is idempotent (0 migrated, all skipped)
 *   4. --filter is case-insensitive
 *   5. --limit caps the run
 *   6. Summary line format: migrated=N skipped=M errored=K
 *   7. events.md exists for migrated campaigns
 *   8. exits 0 on success (errored=0)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql, eq, inArray } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/migrate-campaigns-to-vault.ts');
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx');

interface RunResult extends SpawnSyncReturns<string> {
  stdoutText: string;
  stderrText: string;
}

(HAS_DB ? describe : describe.skip)('migrate-campaigns-to-vault CLI', () => {
  const TEST_USER = 'user_mcv_' + Date.now();
  // Unique suffix so the --filter substring identifies ONLY our fixture
  // campaigns across reruns and parallel test invocations.
  const FIXTURE_TAG = 'mcvfixture' + Date.now();
  let TEST_VAULT_ROOT: string;
  let CAMPAIGN_A_ID = '';
  let CAMPAIGN_B_ID = '';
  let CAMPAIGN_C_ID = '';
  let CHARACTER_ID = '';

  let dbMod: typeof import('@/db/client');
  let schemaMod: typeof import('@/db/schema');

  /**
   * Spawn the migrate-campaigns-to-vault CLI with the test VAULT_CAMPAIGNS_ROOT
   * + the test runner's DATABASE_URL. The env loader inside the script
   * requires DATABASE_URL — pass it through. cwd stays at the project root
   * so `import './_env-loader'` (relative to scripts/) resolves correctly.
   */
  function runCli(args: string[]): RunResult {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, VAULT_CAMPAIGNS_ROOT: TEST_VAULT_ROOT },
      cwd: process.cwd(),
    });
    return {
      ...r,
      stdoutText: (r.stdout ?? '').toString(),
      stderrText: (r.stderr ?? '').toString(),
    };
  }

  beforeAll(async () => {
    TEST_VAULT_ROOT = mkdtempSync(join(tmpdir(), 'migrate-campaigns-test-'));

    dbMod = await import('@/db/client');
    schemaMod = await import('@/db/schema');
    const { db } = dbMod;
    const { campaigns, characters } = schemaMod;
    const { ensureUser } = await import('@/db/users');

    await ensureUser(TEST_USER);

    // Insert character template — bound to campaign A below so the seed
    // payload on campaign A has one VaultSeedCharacter. Campaigns B + C
    // get empty seed payloads (still valid; exercises the empty-payload
    // warn path in the helper).
    const [charRow] = await db
      .insert(characters)
      .values({
        userId: TEST_USER,
        name: 'Migrator',
        level: 3,
        xp: 0,
        raceSlug: 'human',
        classSlug: 'fighter',
        backgroundSlug: 'soldier',
        abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
        proficiencyBonus: 2,
        hpMax: 28,
        ac: 16,
        speed: 30,
        proficiencies: {
          saves: [],
          skills: [],
          expertise: [],
          weapons: [],
          armor: [],
          tools: [],
          languages: [],
        },
        spellcasting: null,
        spellSlotsUsed: {},
        identity: { alignment: 'lawful-neutral' },
        hitDiceMax: 3,
        hitDieSize: 10,
      })
      .returning();
    CHARACTER_ID = charRow!.id;

    // Three fixture campaigns with the shared FIXTURE_TAG inside their
    // names — used by --filter cases to isolate this suite from any
    // production campaigns the local DB might hold.
    const [a] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${FIXTURE_TAG}-A`,
        premise: 'fixture',
        settings: { masterBackend: 'baked' },
      })
      .returning();
    CAMPAIGN_A_ID = a!.id;

    const [b] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${FIXTURE_TAG}-B`,
        premise: 'fixture',
        settings: { masterBackend: 'baked' },
      })
      .returning();
    CAMPAIGN_B_ID = b!.id;

    const [c] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${FIXTURE_TAG}-C`,
        premise: 'fixture',
        settings: { masterBackend: 'baked' },
      })
      .returning();
    CAMPAIGN_C_ID = c!.id;

    // Bind the character to campaign A so its seed payload is non-empty
    // and the materialized character view lands under TEST_VAULT_ROOT.
    await db
      .update(characters)
      .set({ campaignId: CAMPAIGN_A_ID, templateId: CHARACTER_ID })
      .where(eq(characters.id, CHARACTER_ID));
  }, 30_000);

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db, pool } = dbMod;
    // Reverse-FK order. Characters reference campaigns via campaignId,
    // so delete campaigns first (cascade unbinds the character row),
    // then characters, then user.
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (TEST_VAULT_ROOT && existsSync(TEST_VAULT_ROOT)) {
      rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
    }
    await pool.end();
  }, 30_000);

  it('--dry-run does NOT mutate the database', async () => {
    const { db } = dbMod;
    const { campaigns } = schemaMod;
    const ids = [CAMPAIGN_A_ID, CAMPAIGN_B_ID, CAMPAIGN_C_ID];

    // Snapshot BEFORE the dry run.
    const before = await db
      .select({ id: campaigns.id, settings: campaigns.settings })
      .from(campaigns)
      .where(inArray(campaigns.id, ids));

    const r = runCli(['--dry-run', `--filter=${FIXTURE_TAG}`]);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/DRY RUN/);
    expect(r.stdoutText).toMatch(/would-migrate=3/);
    // No actual `migrated=` summary line in dry-run mode.
    expect(r.stdoutText).not.toMatch(/migrated=\d+ skipped=\d+ errored=\d+/);

    // Snapshot AFTER — settings MUST be byte-identical.
    const after = await db
      .select({ id: campaigns.id, settings: campaigns.settings })
      .from(campaigns)
      .where(inArray(campaigns.id, ids));
    expect(after.length).toBe(3);
    const beforeById = new Map(before.map((r) => [r.id, r.settings]));
    for (const row of after) {
      expect(row.settings).toEqual(beforeById.get(row.id));
    }
  }, 60_000);

  it('migrates the matched campaigns end-to-end + writes events.md', async () => {
    const { db } = dbMod;
    const { campaigns } = schemaMod;

    const r = runCli([`--filter=${FIXTURE_TAG}`]);
    expect(r.status).toBe(0);
    // Final summary line shape: `migrated=N skipped=M errored=K`.
    expect(r.stdoutText).toMatch(/migrated=3 skipped=0 errored=0/);

    // Each campaign's settings should now have masterBackend=vault + vaultMutations=true.
    for (const id of [CAMPAIGN_A_ID, CAMPAIGN_B_ID, CAMPAIGN_C_ID]) {
      const [row] = await db
        .select({ settings: campaigns.settings })
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .limit(1);
      expect(row!.settings.masterBackend).toBe('vault');
      expect(row!.settings.vaultMutations).toBe(true);
      // events.md materialized under the test vault root.
      expect(existsSync(join(TEST_VAULT_ROOT, id, 'events.md'))).toBe(true);
    }
  }, 60_000);

  it('re-running is idempotent — 0 migrated, all skipped', async () => {
    const r = runCli([`--filter=${FIXTURE_TAG}`]);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/migrated=0 skipped=3 errored=0/);
    // Each campaign emits an "already on vault, skipping" log line.
    const skipLines = r.stdoutText
      .split('\n')
      .filter((l) => l.includes('already on vault'));
    expect(skipLines.length).toBe(3);
  }, 60_000);

  it('--filter is case-insensitive', async () => {
    const upper = FIXTURE_TAG.toUpperCase();
    const r = runCli(['--dry-run', `--filter=${upper}`]);
    expect(r.status).toBe(0);
    // The summary line counts 3 fixtures even though the filter was UPPER.
    expect(r.stdoutText).toMatch(/3 match filter/);
  }, 60_000);

  it('--limit caps the run', async () => {
    // Use --dry-run + --limit=1 so we exercise the limit path without
    // having to reset the DB state from the previous migration test.
    const r = runCli(['--dry-run', `--filter=${FIXTURE_TAG}`, '--limit=1']);
    expect(r.status).toBe(0);
    // The "found N campaign(s); M match filter" line reports the filter
    // count BEFORE the limit slice — verify the limit slice landed by
    // counting the per-campaign [migrate] lines (one per row in scope).
    const migrateLines = r.stdoutText
      .split('\n')
      .filter((l) => l.startsWith('[migrate] '));
    expect(migrateLines.length).toBe(1);
  }, 60_000);

  it('--limit=0 produces a 0-row dry run', async () => {
    const r = runCli(['--dry-run', `--filter=${FIXTURE_TAG}`, '--limit=0']);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/would-migrate=0 skipped=0/);
    const migrateLines = r.stdoutText
      .split('\n')
      .filter((l) => l.startsWith('[migrate] '));
    expect(migrateLines.length).toBe(0);
  }, 60_000);

  it('rejects invalid --limit=abc with exit code 2', async () => {
    const r = runCli(['--dry-run', '--limit=abc']);
    expect(r.status).toBe(2);
    expect(r.stderrText).toMatch(/Invalid --limit/);
  }, 60_000);
});
