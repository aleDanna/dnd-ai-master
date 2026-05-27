/**
 * tests/scripts/vault-cutover.test.ts — CLI smoke tests for the Phase
 * 03-B-02 cutover script `scripts/vault-cutover.ts`.
 *
 * Pattern: spawn the CLI via spawnSync (same approach as
 * tests/scripts/migrate-campaigns-to-vault.test.ts) and assert against
 * stdout/stderr lines + DB state + audit-file presence. The test is
 * DATABASE_URL-gated — skipped when the env var is absent.
 *
 * The fixture uses CUTOVER_AUDIT_DIR=<tmpdir> so each invocation lands
 * the JSON audit under the sandbox. Three campaigns are seeded:
 *   - vault-ready:         masterBackend=vault, vaultMutations=true, dualWrite=true   (forward cutover OK)
 *   - baked-blocked:       masterBackend=baked                                         (precondition REFUSAL)
 *   - mutations-blocked:   masterBackend=vault, vaultMutations=false                   (precondition REFUSAL)
 *
 * Coverage matrix:
 *   1. Cutover happy path — sourceOfTruth flips to vault; cutoverAt stamped; audit written
 *   2. Cutover refused — masterBackend=baked → exit 1 + "REFUSED: masterBackend=baked"
 *   3. Cutover refused — vaultMutations=false → exit 1 + "REFUSED: vaultMutations=false"
 *   4. Idempotent — already on vault → exit 0 + "already on sourceOfTruth=vault, no-op"
 *   5. Rollback within window → flips back; audit with action:rollback
 *   6. Rollback refused past window — set cutoverAt to 25h ago → exit 1 + "rollback window expired"
 *   7. CUTOVER_ROLLBACK_HOURS env override → 25h-elapsed with env=48 proceeds
 *   8. --dry-run does not mutate (DB + audit dir unchanged)
 *   9. Missing --id → exit 2 + usage hint (only when --rollback or --dry-run passed)
 *   10. No args at all → list mode (exit 0)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/vault-cutover.ts');
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx');

interface RunResult extends SpawnSyncReturns<string> {
  stdoutText: string;
  stderrText: string;
}

(HAS_DB ? describe : describe.skip)('vault-cutover CLI', () => {
  const SUITE_TAG = 'cutovertest' + Date.now();
  const TEST_USER = 'user_vct_' + Date.now();
  let TEST_AUDIT_DIR: string;
  let VAULT_READY_ID = '';
  let BAKED_BLOCKED_ID = '';
  let MUTATIONS_BLOCKED_ID = '';

  let dbMod: typeof import('@/db/client');
  let schemaMod: typeof import('@/db/schema');

  /**
   * Spawn the vault-cutover CLI. CUTOVER_AUDIT_DIR points at the suite
   * tmpdir so each test's audit JSON lands in the sandbox without
   * polluting the in-repo .planning/ dir.
   */
  function runCli(
    args: string[],
    envOverrides: Record<string, string> = {},
  ): RunResult {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CUTOVER_AUDIT_DIR: TEST_AUDIT_DIR,
        ...envOverrides,
      },
      cwd: process.cwd(),
    });
    return {
      ...r,
      stdoutText: (r.stdout ?? '').toString(),
      stderrText: (r.stderr ?? '').toString(),
    };
  }

  /**
   * Direct DB helper: rewrite a campaign's settings (used to reset state
   * between tests). The script only flips sourceOfTruth + cutoverAt
   * through the helper; bypass that here so each test starts from a
   * known baseline.
   */
  async function setCampaignSettings(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const { db } = dbMod;
    const { campaigns } = schemaMod;
    await db
      .update(campaigns)
      .set({ settings: settings, updatedAt: new Date() })
      .where(eq(campaigns.id, id));
  }

  async function readSettings(id: string): Promise<Record<string, unknown>> {
    const { db } = dbMod;
    const { campaigns } = schemaMod;
    const [row] = await db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    return (row?.settings ?? {}) as Record<string, unknown>;
  }

  function listAuditFiles(): string[] {
    if (!existsSync(TEST_AUDIT_DIR)) return [];
    return readdirSync(TEST_AUDIT_DIR).filter((f) => f.endsWith('.json'));
  }

  beforeAll(async () => {
    TEST_AUDIT_DIR = mkdtempSync(join(tmpdir(), 'vault-cutover-test-'));

    dbMod = await import('@/db/client');
    schemaMod = await import('@/db/schema');
    const { db } = dbMod;
    const { campaigns } = schemaMod;
    const { ensureUser } = await import('@/db/users');

    await ensureUser(TEST_USER);

    const [a] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${SUITE_TAG}-vault-ready`,
        premise: 'fixture vault-ready',
        // forward-cutover preconditions: all three flags ON
        settings: {
          masterBackend: 'vault',
          vaultMutations: true,
          dualWrite: true,
        },
      })
      .returning();
    VAULT_READY_ID = a!.id;

    const [b] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${SUITE_TAG}-baked-blocked`,
        premise: 'fixture baked-blocked',
        // backend=baked → cutover REFUSED
        settings: { masterBackend: 'baked' },
      })
      .returning();
    BAKED_BLOCKED_ID = b!.id;

    const [c] = await db
      .insert(campaigns)
      .values({
        userId: TEST_USER,
        name: `${SUITE_TAG}-mutations-blocked`,
        premise: 'fixture mutations-blocked',
        // backend=vault but vaultMutations=false → cutover REFUSED
        settings: { masterBackend: 'vault', vaultMutations: false },
      })
      .returning();
    MUTATIONS_BLOCKED_ID = c!.id;
  }, 30_000);

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db, pool } = dbMod;
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (TEST_AUDIT_DIR && existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    }
    await pool.end();
  }, 30_000);

  beforeEach(async () => {
    // Reset the vault-ready campaign to a clean precondition baseline
    // (all preconditions met, sourceOfTruth=postgres, no cutoverAt). The
    // tests mutate this row in isolation.
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      dualWrite: true,
    });
    await setCampaignSettings(BAKED_BLOCKED_ID, { masterBackend: 'baked' });
    await setCampaignSettings(MUTATIONS_BLOCKED_ID, {
      masterBackend: 'vault',
      vaultMutations: false,
    });
    // Clear audit dir between tests so each test's assertions on listAuditFiles()
    // count only its OWN run.
    if (existsSync(TEST_AUDIT_DIR)) {
      for (const f of readdirSync(TEST_AUDIT_DIR)) {
        rmSync(join(TEST_AUDIT_DIR, f));
      }
    }
  });

  it('cutover happy path — flips sourceOfTruth to vault + stamps cutoverAt + writes audit', async () => {
    const r = runCli([`--id=${VAULT_READY_ID}`]);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/sourceOfTruth: postgres → vault/);
    expect(r.stdoutText).toMatch(/\(FLIPPED\)/);

    const settings = await readSettings(VAULT_READY_ID);
    expect(settings.sourceOfTruth).toBe('vault');
    expect(typeof settings.cutoverAt).toBe('string');
    // cutoverAt must be a valid ISO timestamp within the last ~30s.
    const elapsedMs = Date.now() - Date.parse(settings.cutoverAt as string);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(30_000);

    // Audit file present.
    const files = listAuditFiles();
    expect(files.length).toBe(1);
    const audit = JSON.parse(
      readFileSync(join(TEST_AUDIT_DIR, files[0]!), 'utf8'),
    ) as Record<string, unknown>;
    expect(audit.action).toBe('cutover');
    expect(audit.campaignId).toBe(VAULT_READY_ID);
    expect(audit.previousSourceOfTruth).toBe('postgres');
    expect(audit.newSourceOfTruth).toBe('vault');
    expect(audit.operator).toBe('cli');
    expect(typeof audit.timestamp).toBe('string');
    expect(typeof audit.cutoverAtRecorded).toBe('string');
    expect(audit.rollbackWindowHours).toBe(24);
  }, 60_000);

  it('cutover refused — masterBackend=baked', async () => {
    const r = runCli([`--id=${BAKED_BLOCKED_ID}`]);
    expect(r.status).toBe(1);
    expect(r.stderrText).toMatch(/REFUSED: masterBackend=baked/);
    // No flip applied.
    const settings = await readSettings(BAKED_BLOCKED_ID);
    expect(settings.sourceOfTruth).toBeUndefined();
    // No audit file written on refusal.
    expect(listAuditFiles().length).toBe(0);
  }, 60_000);

  it('cutover refused — vaultMutations=false', async () => {
    const r = runCli([`--id=${MUTATIONS_BLOCKED_ID}`]);
    expect(r.status).toBe(1);
    expect(r.stderrText).toMatch(/REFUSED: vaultMutations=false/);
    const settings = await readSettings(MUTATIONS_BLOCKED_ID);
    expect(settings.sourceOfTruth).toBeUndefined();
    expect(listAuditFiles().length).toBe(0);
  }, 60_000);

  it('cutover refused — dualWrite=false (coexistence required)', async () => {
    // Force vault-ready into the broken precondition (dualWrite missing).
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      // dualWrite OMITTED
    });
    const r = runCli([`--id=${VAULT_READY_ID}`]);
    expect(r.status).toBe(1);
    expect(r.stderrText).toMatch(/REFUSED: dualWrite=false/);
  }, 60_000);

  it('idempotent — already on sourceOfTruth=vault is a no-op', async () => {
    // Seed the campaign as already-cutover.
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      dualWrite: true,
      sourceOfTruth: 'vault',
      cutoverAt: new Date().toISOString(),
    });
    const r = runCli([`--id=${VAULT_READY_ID}`]);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/already on sourceOfTruth=vault, no-op/);
    // No new audit file written for a no-op.
    expect(listAuditFiles().length).toBe(0);
  }, 60_000);

  it('rollback within window — flips back to postgres + audit action=rollback', async () => {
    // Cutover happened 1h ago — well inside the 24h window.
    const cutoverAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      dualWrite: true,
      sourceOfTruth: 'vault',
      cutoverAt,
    });

    const r = runCli([`--id=${VAULT_READY_ID}`, '--rollback']);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/rollback within window/);
    expect(r.stdoutText).toMatch(/sourceOfTruth: vault → postgres/);

    const settings = await readSettings(VAULT_READY_ID);
    expect(settings.sourceOfTruth).toBe('postgres');
    // cutoverAt PRESERVED on rollback (Decision 4 — audit trail intact).
    expect(settings.cutoverAt).toBe(cutoverAt);

    const files = listAuditFiles();
    expect(files.length).toBe(1);
    const audit = JSON.parse(
      readFileSync(join(TEST_AUDIT_DIR, files[0]!), 'utf8'),
    ) as Record<string, unknown>;
    expect(audit.action).toBe('rollback');
    expect(audit.previousSourceOfTruth).toBe('vault');
    expect(audit.newSourceOfTruth).toBe('postgres');
    // cutoverAtRecorded is undefined on rollback (only set on cutover).
    expect(audit.cutoverAtRecorded).toBeUndefined();
  }, 60_000);

  it('rollback refused past window — exit 1 + "rollback window expired"', async () => {
    // 25 hours ago > 24h default window.
    const cutoverAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      dualWrite: true,
      sourceOfTruth: 'vault',
      cutoverAt,
    });

    const r = runCli([`--id=${VAULT_READY_ID}`, '--rollback']);
    expect(r.status).toBe(1);
    expect(r.stderrText).toMatch(/rollback window expired/);
    expect(r.stderrText).toMatch(/CUTOVER_ROLLBACK_HOURS/);

    // No mutation applied.
    const settings = await readSettings(VAULT_READY_ID);
    expect(settings.sourceOfTruth).toBe('vault');
    expect(listAuditFiles().length).toBe(0);
  }, 60_000);

  it('rollback respects CUTOVER_ROLLBACK_HOURS env override (48h allows 25h-elapsed)', async () => {
    const cutoverAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await setCampaignSettings(VAULT_READY_ID, {
      masterBackend: 'vault',
      vaultMutations: true,
      dualWrite: true,
      sourceOfTruth: 'vault',
      cutoverAt,
    });

    const r = runCli(
      [`--id=${VAULT_READY_ID}`, '--rollback'],
      { CUTOVER_ROLLBACK_HOURS: '48' },
    );
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/rollback within window/);
    expect(r.stdoutText).toMatch(/sourceOfTruth: vault → postgres/);

    const settings = await readSettings(VAULT_READY_ID);
    expect(settings.sourceOfTruth).toBe('postgres');

    const files = listAuditFiles();
    expect(files.length).toBe(1);
    const audit = JSON.parse(
      readFileSync(join(TEST_AUDIT_DIR, files[0]!), 'utf8'),
    ) as Record<string, unknown>;
    expect(audit.rollbackWindowHours).toBe(48);
  }, 60_000);

  it('--dry-run does not mutate (DB + audit dir unchanged)', async () => {
    const before = await readSettings(VAULT_READY_ID);
    const r = runCli([`--id=${VAULT_READY_ID}`, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdoutText).toMatch(/WOULD flip sourceOfTruth: postgres → vault/);
    expect(r.stdoutText).toMatch(/dry-run, no changes written/);

    const after = await readSettings(VAULT_READY_ID);
    expect(after).toEqual(before);
    expect(listAuditFiles().length).toBe(0);
  }, 60_000);

  it('missing --id with --rollback flag → exit 2 + usage', async () => {
    const r = runCli(['--rollback']);
    expect(r.status).toBe(2);
    expect(r.stderrText).toMatch(/--id=<uuid> is required/);
    // The script printUsage() emits to stdout (not stderr) — usage text
    // appears in either stream depending on where printUsage() prints.
    expect(r.stdoutText + r.stderrText).toMatch(/Usage:/);
  }, 60_000);

  it('no args → list mode (exit 0)', async () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    // The list header banner.
    expect(r.stdoutText).toMatch(/id \(short\)/);
    expect(r.stdoutText).toMatch(/Cutover \(postgres → vault\)/);
  }, 60_000);
});
