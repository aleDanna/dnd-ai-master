#!/usr/bin/env tsx
/**
 * scripts/vault-flip.ts — operator CLI to toggle a campaign between
 * `vault` and `baked` master backends, toggle Phase 02 `vaultMutations`
 * on/off (with synthetic `campaign_initialized` seed-event emission),
 * and (Phase 03-B) flip `sourceOfTruth` between `'postgres'` and
 * `'vault'` for the cutover state machine.
 *
 * Phase 03 refactor: the per-campaign flip + seed-payload assembly logic
 * now lives in `scripts/vault-flip-helpers.ts`. This file is the operator
 * CLI shell that parses args, resolves the campaign id (supports short
 * UUID prefix), then dispatches to the helpers. Other scripts that need
 * the same per-campaign primitives import them directly:
 *
 *   - scripts/migrate-campaigns-to-vault.ts (plan 03-A-07) — bulk loop
 *   - scripts/vault-cutover.ts             (plan 03-B-02) — cutover
 *
 * Usage:
 *   pnpm vault:flip                                                # list campaigns + their current backend + mutation flag
 *   pnpm vault:flip --id=<uuid> --to=vault                         # set masterBackend=vault
 *   pnpm vault:flip --id=<uuid> --to=baked                         # set masterBackend=baked
 *   pnpm vault:flip --id=<uuid> --enable-mutations                 # set vaultMutations=true + append seed event
 *   pnpm vault:flip --id=<uuid> --to=vault --enable-mutations      # combined: backend AND mutations in one call
 *   pnpm vault:flip --id=<uuid> --disable-mutations                # set vaultMutations=false (events.md is preserved)
 *   pnpm vault:flip --id=<uuid> --source-of-truth=vault            # Phase 03-B — flip read pivot to vault
 *   pnpm vault:flip --id=<uuid> --source-of-truth=postgres         # Phase 03-B — rollback read pivot to postgres
 *
 * --enable-mutations / --disable-mutations require --id=<uuid>. They are
 * MUTUALLY EXCLUSIVE — passing both errors out.
 *
 * --source-of-truth=vault has DEFENSIVE PRECONDITIONS enforced by the
 * helper: masterBackend MUST be 'vault' AND vaultMutations MUST be true.
 * A friendly error tells the operator which earlier flag to run first.
 * Use `scripts/vault-cutover.ts` (plan 03-B-02) for the higher-level
 * operator surface that adds audit logging + rollback-window enforcement;
 * this flag is the low-level knob for power users / debugging.
 *
 * The campaign UUID can be a prefix (first 8 chars) as long as it uniquely
 * identifies one row — the script disambiguates.
 *
 * Uses `_env-loader` so it works wherever `vercel env pull` has populated
 * `.env.production.local` (no shell-level DATABASE_URL export needed).
 */
import './_env-loader';
import { eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';
import { resolveMasterBackend, isMasterBackend, type MasterBackend } from '@/lib/preferences';
import {
  flipCampaignToVault,
  flipCampaignToBaked,
  enableMutationsForCampaign,
  disableMutationsForCampaign,
  flipSourceOfTruth,
  type SourceOfTruth,
} from './vault-flip-helpers';

interface Args {
  id: string | null;
  to: MasterBackend | null;
  enableMutations: boolean;
  disableMutations: boolean;
  sourceOfTruth: SourceOfTruth | null;
}

function isSourceOfTruth(v: unknown): v is SourceOfTruth {
  return v === 'postgres' || v === 'vault';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    id: null,
    to: null,
    enableMutations: false,
    disableMutations: false,
    sourceOfTruth: null,
  };
  for (const a of argv) {
    if (a.startsWith('--id=')) args.id = a.slice('--id='.length);
    else if (a.startsWith('--to=')) {
      const raw = a.slice('--to='.length);
      if (!isMasterBackend(raw)) {
        console.error(`Invalid --to=${raw}. Use 'vault' or 'baked'.`);
        process.exit(2);
      }
      args.to = raw;
    } else if (a.startsWith('--source-of-truth=')) {
      const raw = a.slice('--source-of-truth='.length);
      if (!isSourceOfTruth(raw)) {
        console.error(`Invalid --source-of-truth=${raw}. Use 'postgres' or 'vault'.`);
        process.exit(2);
      }
      args.sourceOfTruth = raw;
    } else if (a === '--enable-mutations') {
      args.enableMutations = true;
    } else if (a === '--disable-mutations') {
      args.disableMutations = true;
    }
  }
  if (args.enableMutations && args.disableMutations) {
    console.error('Cannot --enable-mutations and --disable-mutations in the same invocation.');
    process.exit(2);
  }
  return args;
}

async function listCampaigns(): Promise<void> {
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
      lastPlayedAt: campaigns.lastPlayedAt,
    })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(sql`last_played_at DESC NULLS LAST`)
    .limit(50);

  if (rows.length === 0) {
    console.log('(no campaigns found)');
    return;
  }

  console.log('id (short)  backend  mut  sot       last played       name');
  console.log('──────────  ───────  ───  ────────  ─────────────────  ────');
  for (const r of rows) {
    const shortId = r.id.slice(0, 8);
    const backend = resolveMasterBackend(r.settings.masterBackend);
    const mut = r.settings.vaultMutations === true ? 'on ' : 'off';
    const sot = (r.settings.sourceOfTruth ?? 'postgres').padEnd(8);
    const last = r.lastPlayedAt ? r.lastPlayedAt.toISOString().slice(0, 16).replace('T', ' ') : '—';
    const name = r.name.slice(0, 50);
    console.log(`${shortId}    ${backend.padEnd(7)}  ${mut}  ${sot}  ${last.padEnd(17)}  ${name}`);
  }
  console.log('');
  console.log('To flip one onto the vault backend:');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --to=vault');
  console.log('To enable event-sourced mutations (Phase 02):');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --enable-mutations');
  console.log('To flip source-of-truth (Phase 03-B cutover):');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --source-of-truth=vault');
}

async function resolveCampaignId(prefix: string): Promise<string | null> {
  // Allow either a full UUID or a short prefix (first 8 chars or any prefix).
  // If the prefix is 36 chars (full UUID format), look up exactly. Otherwise
  // pattern match.
  if (prefix.length === 36) {
    const [row] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, prefix))
      .limit(1);
    return row?.id ?? null;
  }

  // Postgres LIKE doesn't accept uuid operands → cast to text. drizzle's
  // `like(campaigns.id, ...)` would emit `id LIKE $1` which fails with
  // "operator does not exist: uuid ~~ unknown" on a uuid column. The
  // raw `sql` template lets us write the cast explicitly.
  const matches = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(sql`${campaigns.id}::text LIKE ${prefix + '%'}`)
    .limit(2);

  if (matches.length === 0) {
    console.error(`No campaign id starts with '${prefix}'. Run \`pnpm vault:flip\` (no args) to list.`);
    process.exit(2);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix '${prefix}' matches multiple campaigns. Use a longer prefix or the full UUID.`);
    process.exit(2);
  }
  return matches[0]!.id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // No flags at all → list mode.
  if (
    !args.id &&
    !args.to &&
    !args.enableMutations &&
    !args.disableMutations &&
    !args.sourceOfTruth
  ) {
    await listCampaigns();
    await pool.end();
    process.exit(0);
  }

  // Mutation-only flags still require --id.
  if (!args.id) {
    console.error(
      '--id=<uuid> is required when passing --to, --enable-mutations, --disable-mutations, or --source-of-truth.',
    );
    console.error('Without args, lists all campaigns.');
    process.exit(2);
  }

  const fullId = await resolveCampaignId(args.id);
  if (!fullId) {
    console.error(`Campaign ${args.id} not found.`);
    process.exit(2);
  }

  // --to flips backend first. The helper is idempotent — re-running against
  // a campaign already on the target backend is a no-op (changed: false).
  if (args.to === 'vault') {
    const r = await flipCampaignToVault(fullId);
    if (!r.changed) {
      console.log(`Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) is already on 'vault'. No-op.`);
    } else {
      console.log(`✓ Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) flipped: ${r.previousBackend} → vault`);
      console.log('');
      console.log('  Next steps:');
      console.log('    pnpm migrate-handbook-to-vault   # if not already run');
      console.log('    pnpm dev                          # ensure dev server is up');
      console.log('    pnpm bench-vault-m4 --user-jwt=<__session-cookie>');
    }
  } else if (args.to === 'baked') {
    const r = await flipCampaignToBaked(fullId);
    if (!r.changed) {
      console.log(`Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) is already on 'baked'. No-op.`);
    } else {
      console.log(`✓ Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) flipped: ${r.previousBackend} → baked`);
    }
  }

  if (args.enableMutations) {
    const r = await enableMutationsForCampaign(fullId);
    if (!r.changed) {
      console.log(
        `[vault-flip] Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) is already on vaultMutations:true. No-op.`,
      );
    } else {
      console.log(
        `[vault-flip] seeded campaign "${r.campaignName}" with ${r.charactersSeeded} characters; vault mutations enabled (seed ${r.seedEventId?.slice(0, 8)}).`,
      );
    }
  } else if (args.disableMutations) {
    const r = await disableMutationsForCampaign(fullId);
    if (!r.changed) {
      console.log(
        `[vault-flip] Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) is already on vaultMutations:false. No-op.`,
      );
    } else {
      console.log(
        `[vault-flip] disabled vaultMutations for "${r.campaignName}" (${fullId.slice(0, 8)}). events.md preserved for re-enable.`,
      );
    }
  }

  if (args.sourceOfTruth) {
    try {
      const r = await flipSourceOfTruth(fullId, args.sourceOfTruth);
      if (!r.changed) {
        console.log(
          `[vault-flip] Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) is already on sourceOfTruth:${args.sourceOfTruth}. No-op.`,
        );
      } else {
        console.log(
          `✓ Campaign "${r.campaignName}" (${fullId.slice(0, 8)}) sourceOfTruth flipped: ${r.previous} → ${r.next}`,
        );
        if (r.next === 'vault') {
          console.log('');
          console.log('  Reads now pivot to vault. To roll back within the rollback window:');
          console.log(`    pnpm vault:flip --id=${fullId.slice(0, 8)} --source-of-truth=postgres`);
        }
      }
    } catch (e) {
      // The helper throws Errors with operator-actionable messages (e.g.,
      // "run vault-flip --to=vault first"). Surface them verbatim and exit
      // non-zero so the operator can re-run with the right flags.
      console.error(`vault-flip --source-of-truth failed: ${e instanceof Error ? e.message : e}`);
      await pool.end();
      process.exit(1);
    }
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('vault-flip failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
