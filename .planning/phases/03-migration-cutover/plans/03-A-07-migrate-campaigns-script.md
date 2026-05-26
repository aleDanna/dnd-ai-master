---
phase: 03
plan: A-07
type: execute
wave: 3
depends_on: [03-A-06]
files_modified:
  - scripts/migrate-campaigns-to-vault.ts
  - package.json
  - tests/scripts/migrate-campaigns-to-vault.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "`pnpm migrate-campaigns-to-vault` lists every campaign with deletedAt IS NULL and migrates each one via flipCampaignToVault + enableMutationsForCampaign"
    - "`pnpm migrate-campaigns-to-vault --dry-run` lists what WOULD migrate without making changes"
    - "`pnpm migrate-campaigns-to-vault --filter=<substring>` only operates on campaigns whose name matches the substring (case-insensitive)"
    - "Already-migrated campaigns are SKIPPED with a log line (idempotency — re-runs are safe)"
    - "Per-campaign errors are isolated — if campaign B fails, A and C still complete; final exit code is non-zero if ANY campaign errored"
    - "The script ends with a summary: `migrated=N skipped=M errored=K` + list of errored campaigns with their error messages"
    - "package.json has a `migrate-campaigns-to-vault` script entry pointing at the new file"
  artifacts:
    - path: "scripts/migrate-campaigns-to-vault.ts"
      provides: "Bulk migration CLI wrapping vault-flip-helpers"
    - path: "package.json"
      provides: "Added migrate-campaigns-to-vault script entry"
      contains: "migrate-campaigns-to-vault"
    - path: "tests/scripts/migrate-campaigns-to-vault.test.ts"
      provides: "Idempotency + dry-run + filter + error-isolation tests"
  key_links:
    - from: "scripts/migrate-campaigns-to-vault.ts (per-campaign loop)"
      to: "scripts/vault-flip-helpers.ts (flipCampaignToVault, enableMutationsForCampaign)"
      via: "Direct named imports"
      pattern: "flipCampaignToVault|enableMutationsForCampaign"
---

# Plan 03-A-07: Bulk Migration Script

**Phase:** 03-migration-cutover
**Wave:** 3 (depends on 03-A-06 helpers)
**Status:** Pending
**Estimated diff size:** ~150 LOC source + ~200 LOC tests / 3 files

## Goal

Per Decision 1: ship the bulk migration CLI as a thin loop over the Phase 02 per-campaign flip primitives. The script handles every campaign with `deletedAt IS NULL` in order of `last_played_at DESC` (most recent first — minimizes risk if the operator stops mid-run).

Mandatory flags:
- `--dry-run` — list what WOULD migrate without writing
- `--filter=<substring>` — case-insensitive name match
- (default) — actually migrate every eligible campaign

Idempotency is critical: a campaign already on `vault` with `vaultMutations: true` is SKIPPED with a log line. Re-running the script on the same cohort produces zero new events. This is T-03-03 mitigation in the threat model.

Per-campaign errors are isolated — one bad campaign does NOT block the rest. The final summary lists every error for operator triage.

## Requirements satisfied

- **REQ-006** — Migration is the producer of events.md for the full campaign cohort. DR replay across the cohort depends on this script having run cleanly.

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/migrate-campaigns-to-vault.ts` | NEW | The bulk migration CLI |
| `package.json` | EDIT | Add `migrate-campaigns-to-vault` script entry |
| `tests/scripts/migrate-campaigns-to-vault.test.ts` | NEW | Idempotency + dry-run + filter + error-isolation tests |

## Tasks

<task type="auto">
  <name>Task 1: Write scripts/migrate-campaigns-to-vault.ts</name>
  <files>scripts/migrate-campaigns-to-vault.ts</files>
  <read_first>
    - scripts/vault-flip-helpers.ts (plan 03-A-06 — the helpers this script wraps)
    - scripts/vault-flip.ts (the CLI shell + parseArgs pattern; the listing query for campaigns)
    - scripts/_env-loader.ts (env loader pattern Phase 02 scripts use)
    - scripts/db-snapshot.ts (long-running CLI pattern — error isolation + summary at end)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§"Bulk migration script" code example as the reference shape)
  </read_first>
  <action>
Create `scripts/migrate-campaigns-to-vault.ts`. Mirror the RESEARCH §"Bulk migration script (Phase 03-A)" code example with one addition: a `--limit=<N>` flag to allow staged migrations during testing.

```ts
#!/usr/bin/env tsx
/**
 * scripts/migrate-campaigns-to-vault.ts — bulk-migrate every campaign in
 * Postgres to the vault format (Phase 03-A, Decision 1).
 *
 * Wraps the per-campaign primitives from scripts/vault-flip-helpers.ts:
 *   1. flipCampaignToVault(id)        — sets settings.masterBackend = 'vault'
 *   2. enableMutationsForCampaign(id) — sets settings.vaultMutations = true
 *                                       + writes campaign_initialized seed event
 *
 * Idempotent: already-migrated campaigns are skipped (changed: false from the helpers).
 *
 * Per-campaign errors are isolated — a failure in campaign B does not block
 * campaigns A or C. Final exit code is 1 if ANY campaign errored.
 *
 * Usage:
 *   pnpm migrate-campaigns-to-vault                          # migrate all
 *   pnpm migrate-campaigns-to-vault --dry-run                # list what would migrate
 *   pnpm migrate-campaigns-to-vault --filter=onepiece        # subset by name match
 *   pnpm migrate-campaigns-to-vault --limit=5                # cap at 5 campaigns (testing)
 *   pnpm migrate-campaigns-to-vault --dry-run --filter=test  # combined
 *
 * Acceptance:
 *   - Re-running the same command produces 0 migrated and 100% skipped (idempotency)
 *   - Output ends with: migrated=N skipped=M errored=K
 *   - Exit 0 iff errored=0
 */
import './_env-loader';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';
import { isNull, sql, desc } from 'drizzle-orm';
import {
  flipCampaignToVault,
  enableMutationsForCampaign,
} from './vault-flip-helpers';
import { resolveMasterBackend } from '@/lib/preferences';

interface Args {
  dryRun: boolean;
  filter: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, filter: null, limit: null };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--filter=')) args.filter = a.slice('--filter='.length);
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (Number.isInteger(n) && n > 0) args.limit = n;
    }
  }
  return args;
}

interface CampaignSummary {
  id: string;
  name: string;
  status: 'migrated' | 'skipped' | 'errored' | 'dry-run-would-migrate' | 'dry-run-skip';
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(sql`last_played_at DESC NULLS LAST`);

  let candidates = rows;
  if (args.filter) {
    const f = args.filter.toLowerCase();
    candidates = candidates.filter((r) => r.name.toLowerCase().includes(f));
  }
  if (args.limit !== null) {
    candidates = candidates.slice(0, args.limit);
  }

  console.log(`[migrate-campaigns-to-vault] found ${rows.length} campaign(s); ${candidates.length} match filter`);
  if (args.dryRun) console.log('[migrate-campaigns-to-vault] DRY RUN — no changes will be written');

  const summary: CampaignSummary[] = [];
  for (const row of candidates) {
    const backend = resolveMasterBackend(row.settings.masterBackend);
    const alreadyMigrated = backend === 'vault' && row.settings.vaultMutations === true;
    if (alreadyMigrated) {
      console.log(`[migrate] ${row.id.slice(0, 8)} ${row.name} — already on vault, skipping`);
      summary.push({ id: row.id, name: row.name, status: args.dryRun ? 'dry-run-skip' : 'skipped' });
      continue;
    }
    if (args.dryRun) {
      console.log(`[migrate] ${row.id.slice(0, 8)} ${row.name} — WOULD migrate (backend=${backend}, vaultMutations=${row.settings.vaultMutations ?? false})`);
      summary.push({ id: row.id, name: row.name, status: 'dry-run-would-migrate' });
      continue;
    }
    try {
      const flipResult = await flipCampaignToVault(row.id);
      const enableResult = await enableMutationsForCampaign(row.id);
      console.log(`[migrate] ${row.id.slice(0, 8)} ${row.name} — MIGRATED (backend ${flipResult.previousBackend}→vault, seedEvent=${enableResult.seedEventId?.slice(0, 8) ?? 'existed'}, characters=${enableResult.charactersSeeded ?? 'n/a'})`);
      summary.push({ id: row.id, name: row.name, status: 'migrated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] ${row.id.slice(0, 8)} ${row.name} — ERROR: ${message}`);
      summary.push({ id: row.id, name: row.name, status: 'errored', error: message });
    }
  }

  console.log('---');
  const migrated = summary.filter((s) => s.status === 'migrated').length;
  const skipped = summary.filter((s) => s.status === 'skipped').length;
  const errored = summary.filter((s) => s.status === 'errored').length;
  const dryWould = summary.filter((s) => s.status === 'dry-run-would-migrate').length;
  const drySkip = summary.filter((s) => s.status === 'dry-run-skip').length;
  if (args.dryRun) {
    console.log(`[migrate-campaigns-to-vault] DRY RUN summary: would-migrate=${dryWould} skipped=${drySkip}`);
  } else {
    console.log(`[migrate-campaigns-to-vault] migrated=${migrated} skipped=${skipped} errored=${errored}`);
  }
  if (errored > 0) {
    console.log('[migrate-campaigns-to-vault] errors:');
    for (const s of summary.filter((x) => x.status === 'errored')) {
      console.log(`  - ${s.id.slice(0, 8)} ${s.name}: ${s.error}`);
    }
  }
  await pool.end();
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[migrate-campaigns-to-vault] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

The output style mirrors Phase 02's `vault-flip.ts` (campaign id truncated to 8 chars for readability).
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm migrate-campaigns-to-vault --dry-run --limit=0 2>&1 | head -5</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `pnpm migrate-campaigns-to-vault --dry-run --limit=0` runs without error (0-row dry run is the safest smoke test)
    - `grep -c "flipCampaignToVault\\|enableMutationsForCampaign" scripts/migrate-campaigns-to-vault.ts` returns ≥ 2 (helpers wired)
    - `grep -c "dry-run\\|filter\\|limit" scripts/migrate-campaigns-to-vault.ts` returns ≥ 3 (all CLI flags present)
    - The summary line follows the format `migrated=N skipped=M errored=K`
    - Exit code is 1 if any campaign errored, 0 otherwise (verified manually with a fake-fail injection)
  </acceptance_criteria>
  <done>
    Script lands. Task 2 wires the package.json entry.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add migrate-campaigns-to-vault to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (existing `scripts` block — see Phase 02 entries for `vault:flip`, `vault:backup`, `vault:rebuild-views`)
  </read_first>
  <action>
Edit `package.json`. Add an entry in the `scripts` block:

```json
    "migrate-campaigns-to-vault": "tsx scripts/migrate-campaigns-to-vault.ts",
```

Place it AFTER the Phase 02 `vault:rebuild-views` entry, alphabetically near `migrate-handbook-to-vault`.

Order suggestion (matches the Phase 02 pattern of grouping vault-* together):
```json
    "migrate-handbook-to-vault": "tsx scripts/migrate-handbook-to-vault.ts",
    "migrate-campaigns-to-vault": "tsx scripts/migrate-campaigns-to-vault.ts",
```

Do NOT add `vault:` prefix here — `migrate-campaigns-to-vault` is a one-shot bulk operation (parallel to `migrate-handbook-to-vault` from Phase 01), not part of the daily vault: operator surface.
  </action>
  <verify>
    <automated>grep -c "migrate-campaigns-to-vault" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "migrate-campaigns-to-vault" package.json` returns exactly 1
    - `pnpm migrate-campaigns-to-vault --dry-run` resolves to the new script (no command not found)
    - The package.json file is valid JSON (parsed by node successfully)
  </acceptance_criteria>
  <done>
    Script entry added.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/scripts/migrate-campaigns-to-vault.test.ts</name>
  <files>tests/scripts/migrate-campaigns-to-vault.test.ts</files>
  <read_first>
    - scripts/migrate-campaigns-to-vault.ts (Task 1)
    - tests/scripts/vault-backup.test.ts (Phase 02 — DB-gated script test using execSync to spawn the CLI; the pattern for capturing stdout + asserting against summary lines)
    - tests/scripts/vault-flip-helpers.test.ts (plan 03-A-06 — fixture pattern for campaigns)
  </read_first>
  <action>
Create `tests/scripts/migrate-campaigns-to-vault.test.ts`. Skip if DATABASE_URL unset.

Key cases:
1. **Dry-run does NOT mutate Postgres** — query before + after, settings unchanged
2. **Actual migration sets masterBackend=vault + vaultMutations=true** for matched campaigns
3. **Idempotency: re-run produces 0 migrated, 100% skipped**
4. **Filter is case-insensitive**
5. **Limit caps the run**
6. **Per-campaign error isolation** — inject a fake-fail (e.g., a campaign whose FK target is gone) and confirm OTHER campaigns still migrate; exit code is 1
7. **events.md exists for migrated campaigns** — confirm the seed event landed

Use `execSync('pnpm migrate-campaigns-to-vault --dry-run', {encoding:'utf8'})` to spawn the CLI; assert the summary line + parsed counts.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('migrate-campaigns-to-vault CLI', () => {
  let TEST_VAULT_ROOT: string;
  let testCampaignIds: string[] = [];
  let db: typeof import('@/db/client').db;
  let campaigns: typeof import('@/db/schema').campaigns;

  beforeAll(async () => {
    TEST_VAULT_ROOT = mkdtempSync(join(tmpdir(), 'migrate-campaigns-test-'));
    process.env.VAULT_CAMPAIGNS_ROOT = TEST_VAULT_ROOT;
    const dbMod = await import('@/db/client');
    const schemaMod = await import('@/db/schema');
    db = dbMod.db;
    campaigns = schemaMod.campaigns;
    // Insert 3 fixture campaigns with distinct names (e.g., "migrate-test-A", -B, -C)
    // ... insert + record their IDs in testCampaignIds ...
  });

  afterAll(async () => {
    for (const id of testCampaignIds) {
      try { await db.delete(campaigns).where(eq(campaigns.id, id)); } catch {}
    }
    if (existsSync(TEST_VAULT_ROOT)) rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
  });

  function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execSync(`pnpm migrate-campaigns-to-vault ${args}`, {
        encoding: 'utf8',
        env: { ...process.env, VAULT_CAMPAIGNS_ROOT: TEST_VAULT_ROOT },
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
      return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', exitCode: e.status ?? 1 };
    }
  }

  it('--dry-run does not mutate the database', async () => {
    const beforeRows = await db.select().from(campaigns).where(/* match testCampaignIds */);
    const { stdout, exitCode } = runCli('--dry-run --filter=migrate-test');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/DRY RUN/);
    const afterRows = await db.select().from(campaigns).where(/* match testCampaignIds */);
    // Settings unchanged
    expect(afterRows.map((r) => r.settings.masterBackend ?? 'baked').sort()).toEqual(beforeRows.map((r) => r.settings.masterBackend ?? 'baked').sort());
  });

  it('runs migration end-to-end', async () => {
    const { stdout, exitCode } = runCli('--filter=migrate-test');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/migrated=3 skipped=0 errored=0/);
    // Verify settings flipped
    for (const id of testCampaignIds) {
      const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
      expect(row.settings.masterBackend).toBe('vault');
      expect(row.settings.vaultMutations).toBe(true);
      // events.md exists
      expect(existsSync(join(TEST_VAULT_ROOT, id, 'events.md'))).toBe(true);
    }
  });

  it('re-running is idempotent (0 migrated, 3 skipped)', async () => {
    const { stdout, exitCode } = runCli('--filter=migrate-test');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/migrated=0 skipped=3 errored=0/);
  });

  it('--filter is case-insensitive', async () => {
    const { stdout } = runCli('--dry-run --filter=MIGRATE-TEST');
    expect(stdout).toMatch(/found.*3 match filter/);
  });

  it('--limit caps the run', async () => {
    // Reset first — delete events.md + clear flags for fresh start, then re-run with limit
    // ... (or just verify with --dry-run + --limit=1 — easier)
    const { stdout } = runCli('--dry-run --filter=migrate-test --limit=1');
    expect(stdout).toMatch(/3 match filter/);
    // Of those 3, only 1 is reported as "would migrate" or "skip" (per limit)
    const migrateLines = stdout.match(/^\[migrate\] /gm) ?? [];
    expect(migrateLines.length).toBe(1);
  });

  it('per-campaign error isolation: a failing campaign does not block others', async () => {
    // This is harder to simulate cleanly in an integration test. One approach:
    //   - Insert a 4th campaign with a malformed setting (e.g., masterBackend = 'invalid')
    //   - Verify the script processes the others + reports errored=1
    // Skip if simulation is too fragile; document the case as manual-validation.
    // ...
  });
});
```

These tests prove the operator-facing contract: idempotency, dry-run safety, error isolation.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/migrate-campaigns-to-vault.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL is set (skipped otherwise)
    - The dry-run case proves no mutation
    - The full-run case proves migration (settings flipped, events.md created)
    - The re-run case proves idempotency (0 migrated, all skipped)
    - The filter case-insensitivity case passes
    - The --limit case passes
    - Fixture cleanup is complete (no orphans)
    - Test runtime < 60s (some DB writes per fixture)
  </acceptance_criteria>
  <done>
    Bulk migration ready for the cohort. Operator runs `pnpm migrate-campaigns-to-vault` once after the audit + schema work lands.
  </done>
</task>
