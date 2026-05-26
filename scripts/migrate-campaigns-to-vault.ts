#!/usr/bin/env tsx
/**
 * scripts/migrate-campaigns-to-vault.ts — bulk-migrate every campaign in
 * Postgres to the vault format (Phase 03-A, Decision 1).
 *
 * Wraps the per-campaign primitives from `scripts/vault-flip-helpers.ts`:
 *   1. flipCampaignToVault(id)        — sets settings.masterBackend = 'vault'
 *   2. enableMutationsForCampaign(id) — sets settings.vaultMutations = true
 *                                       + writes campaign_initialized seed event
 *
 * Idempotent: already-migrated campaigns are SKIPPED (changed: false from the
 * helpers). Re-running the same command produces 0 new events.md lines — this
 * is the T-03-03 mitigation in the threat model.
 *
 * Per-campaign errors are isolated — a failure in campaign B does not block
 * campaigns A or C. Final exit code is 1 if ANY campaign errored.
 *
 * Usage:
 *   pnpm migrate-campaigns-to-vault                          # migrate all
 *   pnpm migrate-campaigns-to-vault --dry-run                # list what would migrate
 *   pnpm migrate-campaigns-to-vault --filter=onepiece        # subset by case-insensitive name match
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
import { isNull, sql } from 'drizzle-orm';
import { resolveMasterBackend } from '@/lib/preferences';
import {
  flipCampaignToVault,
  enableMutationsForCampaign,
} from './vault-flip-helpers';

interface Args {
  dryRun: boolean;
  filter: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, filter: null, limit: null };
  for (const a of argv) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--filter=')) {
      args.filter = a.slice('--filter='.length);
    } else if (a.startsWith('--limit=')) {
      const raw = a.slice('--limit='.length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        console.error(`Invalid --limit=${raw}. Use a non-negative integer.`);
        process.exit(2);
      }
      args.limit = n;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage:');
      console.log('  pnpm migrate-campaigns-to-vault                          # migrate all');
      console.log('  pnpm migrate-campaigns-to-vault --dry-run                # list what would migrate');
      console.log('  pnpm migrate-campaigns-to-vault --filter=<substring>     # case-insensitive name match');
      console.log('  pnpm migrate-campaigns-to-vault --limit=<N>              # cap at N campaigns');
      process.exit(0);
    }
  }
  return args;
}

interface CampaignSummary {
  id: string;
  name: string;
  status:
    | 'migrated'
    | 'skipped'
    | 'errored'
    | 'dry-run-would-migrate'
    | 'dry-run-skip';
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Load every non-deleted campaign. Order by last_played_at DESC (most
  // recent first) — minimizes risk if the operator stops mid-run; the
  // campaigns most likely to be hit by player traffic land first.
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
    })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(sql`last_played_at DESC NULLS LAST`);

  // Apply --filter (case-insensitive substring match on name) + --limit cap.
  let candidates = rows;
  if (args.filter) {
    const f = args.filter.toLowerCase();
    candidates = candidates.filter((r) => r.name.toLowerCase().includes(f));
  }
  if (args.limit !== null) {
    candidates = candidates.slice(0, args.limit);
  }

  console.log(
    `[migrate-campaigns-to-vault] found ${rows.length} campaign(s); ${candidates.length} match filter`,
  );
  if (args.dryRun) {
    console.log('[migrate-campaigns-to-vault] DRY RUN — no changes will be written');
  }

  const summary: CampaignSummary[] = [];
  for (const row of candidates) {
    // Resolve the current backend + vault-mutations state so we can detect
    // "already migrated" before touching the helpers (they are idempotent
    // themselves, but the up-front check makes the log output cleaner and
    // avoids spurious "already on vault" warn lines from the helpers).
    const backend = resolveMasterBackend(row.settings.masterBackend);
    const alreadyMigrated =
      backend === 'vault' && row.settings.vaultMutations === true;

    if (alreadyMigrated) {
      console.log(
        `[migrate] ${row.id.slice(0, 8)} ${row.name} — already on vault, skipping`,
      );
      summary.push({
        id: row.id,
        name: row.name,
        status: args.dryRun ? 'dry-run-skip' : 'skipped',
      });
      continue;
    }

    if (args.dryRun) {
      console.log(
        `[migrate] ${row.id.slice(0, 8)} ${row.name} — WOULD migrate (backend=${backend}, vaultMutations=${row.settings.vaultMutations ?? false})`,
      );
      summary.push({
        id: row.id,
        name: row.name,
        status: 'dry-run-would-migrate',
      });
      continue;
    }

    try {
      const flipResult = await flipCampaignToVault(row.id);
      const enableResult = await enableMutationsForCampaign(row.id);
      console.log(
        `[migrate] ${row.id.slice(0, 8)} ${row.name} — MIGRATED (backend ${flipResult.previousBackend}→vault, seedEvent=${enableResult.seedEventId?.slice(0, 8) ?? 'existed'}, characters=${enableResult.charactersSeeded ?? 'n/a'})`,
      );
      summary.push({ id: row.id, name: row.name, status: 'migrated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[migrate] ${row.id.slice(0, 8)} ${row.name} — ERROR: ${message}`,
      );
      summary.push({
        id: row.id,
        name: row.name,
        status: 'errored',
        error: message,
      });
    }
  }

  console.log('---');
  const migrated = summary.filter((s) => s.status === 'migrated').length;
  const skipped = summary.filter((s) => s.status === 'skipped').length;
  const errored = summary.filter((s) => s.status === 'errored').length;
  const dryWould = summary.filter(
    (s) => s.status === 'dry-run-would-migrate',
  ).length;
  const drySkip = summary.filter((s) => s.status === 'dry-run-skip').length;

  if (args.dryRun) {
    console.log(
      `[migrate-campaigns-to-vault] DRY RUN summary: would-migrate=${dryWould} skipped=${drySkip}`,
    );
  } else {
    console.log(
      `[migrate-campaigns-to-vault] migrated=${migrated} skipped=${skipped} errored=${errored}`,
    );
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
  console.error(
    '[migrate-campaigns-to-vault] fatal:',
    e instanceof Error ? e.message : e,
  );
  process.exit(1);
});
