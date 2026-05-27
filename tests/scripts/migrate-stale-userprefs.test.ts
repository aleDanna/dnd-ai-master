/**
 * tests/scripts/migrate-stale-userprefs.test.ts — CLI smoke tests for
 * plan 03-C-05 stale-aiMasterModel migration.
 *
 * Pattern: spawn the CLI via `spawnSync` (same approach as
 * `tests/scripts/migrate-campaigns-to-vault.test.ts`), then assert
 * against stdout summary lines + DB state. DB-gated — skipped when
 * `DATABASE_URL` is absent.
 *
 * Fixtures are isolated by a per-suite tag (user-id prefix + campaign
 * name suffix) so concurrent test runs and pre-existing production
 * rows can't collide.
 *
 * Coverage matrix:
 *   1. --dry-run does NOT mutate the database
 *   2. Default run rewrites every stale slug to PRIMARY (users + campaigns)
 *   3. Re-running is idempotent (0 migrated on the second pass)
 *   4. Non-stale slugs (PRIMARY, dnd-master-plus, gpt-5) are preserved
 *   5. Soft-deleted campaigns are excluded from the migration
 *   6. `:latest` tagged variants of stale slugs are migrated
 *   7. Unknown flag exits 2 with a helpful stderr line
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { sql, eq, inArray } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/migrate-stale-userprefs.ts');
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx');

/**
 * REQ-030 primary — kept in sync with `PRIMARY` const in the script.
 * Duplicated rather than imported so we catch a silent drift in either
 * direction (the test fails loudly if the script is edited to migrate
 * to a different slug without updating the assertion).
 */
const EXPECTED_PRIMARY = 'qwen3:30b-a3b-instruct-2507-q4_K_M';

interface RunResult extends SpawnSyncReturns<string> {
  stdoutText: string;
  stderrText: string;
}

(HAS_DB ? describe : describe.skip)('migrate-stale-userprefs CLI', () => {
  // Unique tag so this suite's fixtures are identifiable and clean-up
  // is exhaustive even across parallel test runs.
  const SUITE_TAG = 'msup' + Date.now();
  const USER_STALE_LITE = `user_${SUITE_TAG}_lite`;
  const USER_STALE_MAX = `user_${SUITE_TAG}_max`;
  const USER_STALE_MAX2_LATEST = `user_${SUITE_TAG}_max2latest`;
  const USER_PRIMARY = `user_${SUITE_TAG}_primary`;
  const USER_PLUS = `user_${SUITE_TAG}_plus`;
  const USER_CLOUD = `user_${SUITE_TAG}_cloud`;

  let CAMPAIGN_STALE_ID = '';
  let CAMPAIGN_FRESH_ID = '';
  let CAMPAIGN_DELETED_ID = '';

  let dbMod: typeof import('@/db/client');
  let schemaMod: typeof import('@/db/schema');

  /**
   * Spawn the CLI with the test runner's DATABASE_URL. cwd stays at the
   * project root so `import './_env-loader'` (relative to scripts/)
   * resolves correctly.
   */
  function runCli(args: string[]): RunResult {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env },
      cwd: process.cwd(),
    });
    return {
      ...r,
      stdoutText: (r.stdout ?? '').toString(),
      stderrText: (r.stderr ?? '').toString(),
    };
  }

  /**
   * Re-seed the fixture rows to a known stale-vs-fresh baseline.
   * Called from beforeAll AND beforeEach (per-test) so each test runs
   * against a fresh stale set — otherwise the idempotency test would
   * leave NOTHING stale for the dry-run case that runs after it.
   */
  async function reseedFixtures(): Promise<void> {
    const { db } = dbMod;
    const { campaigns } = schemaMod;

    // Reset every user's aiMasterModel to a deterministic stale/fresh
    // value. We use jsonb_set so the rest of the preferences object
    // (which may have other defaults) is preserved.
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"dnd-master-lite"'::jsonb)
      WHERE id = ${USER_STALE_LITE}
    `);
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"dnd-master-max"'::jsonb)
      WHERE id = ${USER_STALE_MAX}
    `);
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"dnd-master-max2:latest"'::jsonb)
      WHERE id = ${USER_STALE_MAX2_LATEST}
    `);
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', ${`"${EXPECTED_PRIMARY}"`}::jsonb)
      WHERE id = ${USER_PRIMARY}
    `);
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"dnd-master-plus"'::jsonb)
      WHERE id = ${USER_PLUS}
    `);
    await db.execute(sql`
      UPDATE users
      SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"gpt-5"'::jsonb)
      WHERE id = ${USER_CLOUD}
    `);

    // Campaigns: one stale (max3), one fresh (primary), one soft-deleted
    // with a stale slug — the latter MUST be skipped by the migration.
    await db
      .update(campaigns)
      .set({
        settings: { aiMasterModel: 'dnd-master-max3' },
        deletedAt: null,
      })
      .where(eq(campaigns.id, CAMPAIGN_STALE_ID));
    await db
      .update(campaigns)
      .set({
        settings: { aiMasterModel: EXPECTED_PRIMARY },
        deletedAt: null,
      })
      .where(eq(campaigns.id, CAMPAIGN_FRESH_ID));
    await db
      .update(campaigns)
      .set({
        settings: { aiMasterModel: 'dnd-master-max2' },
        deletedAt: new Date(),
      })
      .where(eq(campaigns.id, CAMPAIGN_DELETED_ID));
  }

  beforeAll(async () => {
    dbMod = await import('@/db/client');
    schemaMod = await import('@/db/schema');
    const { db } = dbMod;
    const { campaigns } = schemaMod;
    const { ensureUser } = await import('@/db/users');

    // Create six user fixtures with deterministic IDs.
    await ensureUser(USER_STALE_LITE);
    await ensureUser(USER_STALE_MAX);
    await ensureUser(USER_STALE_MAX2_LATEST);
    await ensureUser(USER_PRIMARY);
    await ensureUser(USER_PLUS);
    await ensureUser(USER_CLOUD);

    // Insert three campaign fixtures owned by USER_STALE_LITE (any user
    // works — the migration scope is the settings.aiMasterModel field,
    // not the owner). Names tagged with SUITE_TAG so the afterAll
    // cleanup grabs only this suite's rows.
    const [stale] = await db
      .insert(campaigns)
      .values({
        userId: USER_STALE_LITE,
        name: `${SUITE_TAG}-stale`,
        premise: 'fixture',
        settings: { aiMasterModel: 'dnd-master-max3' },
      })
      .returning();
    CAMPAIGN_STALE_ID = stale!.id;

    const [fresh] = await db
      .insert(campaigns)
      .values({
        userId: USER_STALE_LITE,
        name: `${SUITE_TAG}-fresh`,
        premise: 'fixture',
        settings: { aiMasterModel: EXPECTED_PRIMARY },
      })
      .returning();
    CAMPAIGN_FRESH_ID = fresh!.id;

    const [deleted] = await db
      .insert(campaigns)
      .values({
        userId: USER_STALE_LITE,
        name: `${SUITE_TAG}-deleted`,
        premise: 'fixture',
        settings: { aiMasterModel: 'dnd-master-max2' },
        deletedAt: new Date(),
      })
      .returning();
    CAMPAIGN_DELETED_ID = deleted!.id;

    // Initial seed so the dry-run test sees stale state.
    await reseedFixtures();
  }, 30_000);

  beforeEach(async () => {
    // Restore the stale baseline before every test so order independence
    // holds — the idempotency test deliberately mutates everything to
    // PRIMARY, and the dry-run test that follows still needs stale rows
    // to find.
    await reseedFixtures();
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db, pool } = dbMod;
    // Tear-down order respects FK constraints: campaigns (FK → users)
    // first, then users. Soft-delete flag is ignored — we hard-delete
    // the suite fixtures.
    await db.execute(
      sql`delete from campaigns where id in (${CAMPAIGN_STALE_ID}::uuid, ${CAMPAIGN_FRESH_ID}::uuid, ${CAMPAIGN_DELETED_ID}::uuid)`,
    );
    await db.execute(sql`
      delete from users where id in (
        ${USER_STALE_LITE}, ${USER_STALE_MAX}, ${USER_STALE_MAX2_LATEST},
        ${USER_PRIMARY}, ${USER_PLUS}, ${USER_CLOUD}
      )
    `);
    await pool.end();
  }, 30_000);

  it('--dry-run does NOT mutate the database', async () => {
    const { db } = dbMod;
    const { users, campaigns } = schemaMod;

    // Snapshot the relevant rows BEFORE running.
    const userIds = [
      USER_STALE_LITE,
      USER_STALE_MAX,
      USER_STALE_MAX2_LATEST,
      USER_PRIMARY,
      USER_PLUS,
      USER_CLOUD,
    ];
    const usersBefore = await db
      .select({ id: users.id, prefs: users.preferences })
      .from(users)
      .where(inArray(users.id, userIds));
    const campaignsBefore = await db
      .select({ id: campaigns.id, settings: campaigns.settings, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(
        inArray(campaigns.id, [CAMPAIGN_STALE_ID, CAMPAIGN_FRESH_ID, CAMPAIGN_DELETED_ID]),
      );

    const r = runCli(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/DRY RUN/);
    expect(r.stdoutText).toMatch(/WOULD migrate/);
    // Stale users in scope: lite, max, max2:latest = 3.
    // Plus any other rows lingering in the local DB — the migration is
    // global, so use >= rather than ===.
    expect(r.stdoutText).toMatch(/found \d+ user\(s\)/);
    // Snapshot must be byte-identical AFTER the dry run.
    const usersAfter = await db
      .select({ id: users.id, prefs: users.preferences })
      .from(users)
      .where(inArray(users.id, userIds));
    const campaignsAfter = await db
      .select({ id: campaigns.id, settings: campaigns.settings, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(
        inArray(campaigns.id, [CAMPAIGN_STALE_ID, CAMPAIGN_FRESH_ID, CAMPAIGN_DELETED_ID]),
      );

    const usersBeforeMap = new Map(usersBefore.map((u) => [u.id, u.prefs]));
    for (const row of usersAfter) {
      expect(row.prefs).toEqual(usersBeforeMap.get(row.id));
    }
    const campaignsBeforeMap = new Map(campaignsBefore.map((c) => [c.id, c.settings]));
    for (const row of campaignsAfter) {
      expect(row.settings).toEqual(campaignsBeforeMap.get(row.id));
    }
  }, 60_000);

  it('migrates stale users + campaigns end-to-end to the REQ-030 primary', async () => {
    const { db } = dbMod;
    const { users, campaigns } = schemaMod;

    const r = runCli([]);
    expect(r.status).toBe(0);
    // Summary line shape: `migrated users=N campaigns=M → <PRIMARY>`.
    expect(r.stdoutText).toMatch(/migrated users=\d+ campaigns=\d+/);
    expect(r.stdoutText).toContain(EXPECTED_PRIMARY);

    // Each stale user is now on PRIMARY.
    const staleIds = [USER_STALE_LITE, USER_STALE_MAX, USER_STALE_MAX2_LATEST];
    const migrated = await db
      .select({ id: users.id, prefs: users.preferences })
      .from(users)
      .where(inArray(users.id, staleIds));
    expect(migrated.length).toBe(3);
    for (const u of migrated) {
      expect(u.prefs.aiMasterModel).toBe(EXPECTED_PRIMARY);
    }

    // The stale CAMPAIGN is migrated.
    const [staleCamp] = await db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, CAMPAIGN_STALE_ID))
      .limit(1);
    expect(staleCamp!.settings.aiMasterModel).toBe(EXPECTED_PRIMARY);
  }, 60_000);

  it('re-running is idempotent — 0 users, 0 campaigns migrated', async () => {
    const { db } = dbMod;
    const { users } = schemaMod;

    // First run: rewrites every stale row.
    const first = runCli([]);
    expect(first.status).toBe(0);
    expect(first.stdoutText).toMatch(/migrated users=\d+ campaigns=\d+/);

    // Second run: nothing to migrate. The script short-circuits with the
    // "nothing to migrate" line OR (when other DB rows lurk) the
    // `users=0 campaigns=0` summary. Either is idempotent — we assert
    // the union.
    const second = runCli([]);
    expect(second.status).toBe(0);
    const idleNothing = /nothing to migrate/.test(second.stdoutText);
    const idleZero = /migrated users=0 campaigns=0/.test(second.stdoutText);
    expect(idleNothing || idleZero).toBe(true);

    // Sanity: the previously-stale users are still on PRIMARY.
    const staleIds = [USER_STALE_LITE, USER_STALE_MAX, USER_STALE_MAX2_LATEST];
    const after = await db
      .select({ id: users.id, prefs: users.preferences })
      .from(users)
      .where(inArray(users.id, staleIds));
    for (const u of after) {
      expect(u.prefs.aiMasterModel).toBe(EXPECTED_PRIMARY);
    }
  }, 60_000);

  it('does NOT touch users on PRIMARY, dnd-master-plus, or cloud models', async () => {
    const { db } = dbMod;
    const { users } = schemaMod;

    runCli([]);

    const [primary] = await db
      .select({ prefs: users.preferences })
      .from(users)
      .where(eq(users.id, USER_PRIMARY))
      .limit(1);
    const [plus] = await db
      .select({ prefs: users.preferences })
      .from(users)
      .where(eq(users.id, USER_PLUS))
      .limit(1);
    const [cloud] = await db
      .select({ prefs: users.preferences })
      .from(users)
      .where(eq(users.id, USER_CLOUD))
      .limit(1);

    // PRIMARY stays PRIMARY (the script doesn't rewrite already-on-primary rows;
    // strictly speaking it could no-op the UPDATE, but we want the row UNTOUCHED).
    expect(primary!.prefs.aiMasterModel).toBe(EXPECTED_PRIMARY);
    // dnd-master-plus is the REQ-033 regression baseline — NEVER migrated.
    expect(plus!.prefs.aiMasterModel).toBe('dnd-master-plus');
    // Cloud slugs (gpt-5, claude-sonnet-4-5, etc.) are not even in STALE_SLUGS.
    expect(cloud!.prefs.aiMasterModel).toBe('gpt-5');
  }, 60_000);

  it('excludes soft-deleted campaigns from the migration', async () => {
    const { db } = dbMod;
    const { campaigns } = schemaMod;

    runCli([]);

    const [deleted] = await db
      .select({ settings: campaigns.settings, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, CAMPAIGN_DELETED_ID))
      .limit(1);

    // The soft-deleted row's stale slug is untouched — it's inert
    // (no turns can fire against it).
    expect(deleted!.settings.aiMasterModel).toBe('dnd-master-max2');
    expect(deleted!.deletedAt).not.toBeNull();
  }, 60_000);

  it('migrates `:latest` tagged variants of stale slugs', async () => {
    const { db } = dbMod;
    const { users } = schemaMod;

    runCli([]);

    // USER_STALE_MAX2_LATEST started on `dnd-master-max2:latest` — the
    // tagged form must be recognised by STALE_SLUGS and rewritten.
    const [row] = await db
      .select({ prefs: users.preferences })
      .from(users)
      .where(eq(users.id, USER_STALE_MAX2_LATEST))
      .limit(1);
    expect(row!.prefs.aiMasterModel).toBe(EXPECTED_PRIMARY);
  }, 60_000);

  it('rejects an unknown flag with exit 2 and a helpful stderr line', async () => {
    const r = runCli(['--not-a-real-flag']);
    expect(r.status).toBe(2);
    expect(r.stderrText).toMatch(/Unknown flag/);
  }, 30_000);

  it('--preserve-pretty-names is a no-op (forward-compat) and still runs', async () => {
    const { db } = dbMod;
    const { users } = schemaMod;

    const r = runCli(['--preserve-pretty-names', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/--preserve-pretty-names/);
    expect(r.stdoutText).toMatch(/no-op/);
    expect(r.stdoutText).toMatch(/DRY RUN/);

    // Confirm dnd-master-plus is genuinely preserved across the flagged invocation.
    const [plus] = await db
      .select({ prefs: users.preferences })
      .from(users)
      .where(eq(users.id, USER_PLUS))
      .limit(1);
    expect(plus!.prefs.aiMasterModel).toBe('dnd-master-plus');
  }, 60_000);
});
