#!/usr/bin/env tsx
/**
 * scripts/vault-cutover.ts — operator CLI to flip campaign sourceOfTruth
 * from 'postgres' to 'vault' (cutover) or back ('--rollback').
 *
 * Per Decision 4: reads pivot when sourceOfTruth='vault'. Writes continue
 * dual-writing to Postgres for the rollback window so PG stays as the
 * rollback target.
 *
 * Per Decision 5: rollback window is CUTOVER_ROLLBACK_HOURS (default 24h).
 * Past the window, --rollback refuses unless the operator explicitly
 * extends the env. The 30-day Postgres-data retention is OUT OF SCOPE for
 * this script — that's a separate decommission-legacy-state migration.
 *
 * Preconditions for forward cutover (target=vault), enforced by the helper
 * AND by an up-front friendly error here:
 *   - settings.masterBackend === 'vault'
 *   - settings.vaultMutations === true
 *   - settings.dualWrite === true   (must be in coexistence first — Decision 2)
 *
 * Usage:
 *   pnpm vault:cutover                              # list campaigns + their state
 *   pnpm vault:cutover --id=<short|full-uuid>       # flip to vault (cutover)
 *   pnpm vault:cutover --id=<...> --rollback        # flip back to postgres (within window)
 *   pnpm vault:cutover --id=<...> --dry-run         # show what WOULD change
 *
 * Audit log written to:
 *   .planning/phases/03-migration-cutover/cutover-audit/<id-prefix>-<iso-ts>.json
 * Override with env CUTOVER_AUDIT_DIR=<path> (used by tests).
 *
 * Uses `_env-loader` so it works wherever `vercel env pull` has populated
 * `.env.local` (no shell-level DATABASE_URL export needed).
 */
import './_env-loader';
import { eq, isNull, sql } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';
import {
  resolveMasterBackend,
  resolveSourceOfTruth,
} from '@/lib/preferences';
import { flipSourceOfTruth } from './vault-flip-helpers';

interface Args {
  id: string | null;
  rollback: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { id: null, rollback: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--id=')) args.id = a.slice('--id='.length);
    else if (a === '--rollback') args.rollback = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  pnpm vault:cutover                              # list campaigns + their state');
  console.log('  pnpm vault:cutover --id=<short|full-uuid>       # flip to vault (cutover)');
  console.log('  pnpm vault:cutover --id=<...> --rollback        # flip back to postgres');
  console.log('  pnpm vault:cutover --id=<...> --dry-run         # show what WOULD change');
  console.log('');
  console.log('Env:');
  console.log('  CUTOVER_ROLLBACK_HOURS  (default 24)  — rollback window in hours');
  console.log('  CUTOVER_AUDIT_DIR       (default .planning/phases/03-migration-cutover/cutover-audit/)');
}

const DEFAULT_AUDIT_DIR =
  '.planning/phases/03-migration-cutover/cutover-audit';

function auditDir(): string {
  const override = process.env.CUTOVER_AUDIT_DIR?.trim();
  return override && override.length > 0 ? override : DEFAULT_AUDIT_DIR;
}

function rollbackWindowHours(): number {
  const raw = process.env.CUTOVER_ROLLBACK_HOURS?.trim();
  if (!raw) return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return n;
}

function writeAudit(entry: Record<string, unknown>): string {
  const dir = auditDir();
  mkdirSync(dir, { recursive: true });
  const id = String(entry.campaignId ?? 'unknown').slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${id}-${ts}.json`);
  writeFileSync(path, JSON.stringify(entry, null, 2));
  return path;
}

/**
 * Resolve a short UUID prefix (or full UUID) to a full campaign id. Errors
 * out cleanly on ambiguous or missing prefix. Mirrors the resolver in
 * scripts/vault-flip.ts (same operator UX contract).
 */
async function resolveCampaignId(prefix: string): Promise<string | null> {
  if (prefix.length === 36) {
    const [row] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, prefix))
      .limit(1);
    return row?.id ?? null;
  }
  // Postgres LIKE doesn't accept uuid operands → cast to text.
  const matches = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(sql`${campaigns.id}::text LIKE ${prefix + '%'}`)
    .limit(2);

  if (matches.length === 0) {
    console.error(
      `[vault-cutover] no campaign id starts with '${prefix}'. Run \`pnpm vault:cutover\` (no args) to list.`,
    );
    process.exit(2);
  }
  if (matches.length > 1) {
    console.error(
      `[vault-cutover] ambiguous prefix '${prefix}' matches multiple campaigns. Use a longer prefix or the full UUID.`,
    );
    process.exit(2);
  }
  return matches[0]!.id;
}

interface ListRow {
  id: string;
  name: string;
  backend: 'vault' | 'baked';
  vaultMutations: boolean;
  dualWrite: boolean;
  sourceOfTruth: 'postgres' | 'vault';
  cutoverAt: string | undefined;
  rollbackHoursRemaining: number | null;
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

  const windowHours = rollbackWindowHours();
  const now = Date.now();
  const listRows: ListRow[] = rows.map((r) => {
    const backend = resolveMasterBackend(r.settings.masterBackend);
    const vaultMutations = r.settings.vaultMutations === true;
    const dualWrite = r.settings.dualWrite === true;
    const sourceOfTruth = resolveSourceOfTruth(r.settings.sourceOfTruth);
    const cutoverAt = r.settings.cutoverAt;
    let rollbackHoursRemaining: number | null = null;
    if (sourceOfTruth === 'vault' && cutoverAt) {
      const elapsedMs = now - Date.parse(cutoverAt);
      const remainingHours = windowHours - elapsedMs / (1000 * 60 * 60);
      rollbackHoursRemaining = remainingHours;
    }
    return {
      id: r.id,
      name: r.name,
      backend,
      vaultMutations,
      dualWrite,
      sourceOfTruth,
      cutoverAt: cutoverAt || undefined,
      rollbackHoursRemaining,
    };
  });

  console.log('id (short)  backend  mut  dw   sot       cutoverAt         rollback');
  console.log('──────────  ───────  ───  ───  ────────  ───────────────  ────────');
  for (const r of listRows) {
    const shortId = r.id.slice(0, 8);
    const mut = r.vaultMutations ? 'on ' : 'off';
    const dw = r.dualWrite ? 'on ' : 'off';
    const sot = r.sourceOfTruth.padEnd(8);
    const cutoverAt = r.cutoverAt
      ? r.cutoverAt.slice(0, 16).replace('T', ' ')
      : '—'.padEnd(16);
    let rollback = '—';
    if (r.rollbackHoursRemaining !== null) {
      rollback =
        r.rollbackHoursRemaining > 0
          ? `${r.rollbackHoursRemaining.toFixed(1)}h left`
          : 'EXPIRED';
    }
    const name = r.name.slice(0, 40);
    console.log(
      `${shortId}    ${r.backend.padEnd(7)}  ${mut}  ${dw}  ${sot}  ${cutoverAt.padEnd(15)}  ${rollback.padEnd(8)}  ${name}`,
    );
  }
  console.log('');
  console.log('Cutover (postgres → vault):');
  console.log('  pnpm vault:cutover --id=<short-or-full-uuid>');
  console.log('Rollback (vault → postgres, within window):');
  console.log('  pnpm vault:cutover --id=<short-or-full-uuid> --rollback');
  console.log(`Rollback window: ${windowHours}h (env CUTOVER_ROLLBACK_HOURS)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // No args → list mode (per contract).
  if (!args.id && !args.rollback && !args.dryRun) {
    await listCampaigns();
    await pool.end();
    process.exit(0);
  }

  // Mutation flags (--rollback, --dry-run) still require --id.
  if (!args.id) {
    console.error('[vault-cutover] --id=<uuid> is required when passing --rollback or --dry-run.');
    printUsage();
    process.exit(2);
  }

  const fullId = await resolveCampaignId(args.id);
  if (!fullId) {
    console.error(`[vault-cutover] campaign ${args.id} not found`);
    await pool.end();
    process.exit(1);
  }

  const [row] = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
    })
    .from(campaigns)
    .where(eq(campaigns.id, fullId))
    .limit(1);
  if (!row) {
    console.error(`[vault-cutover] campaign ${fullId} not found`);
    await pool.end();
    process.exit(1);
  }

  const previousSourceOfTruth = resolveSourceOfTruth(row.settings.sourceOfTruth);
  const backend = resolveMasterBackend(row.settings.masterBackend);
  const vaultMutations = row.settings.vaultMutations === true;
  const dualWrite = row.settings.dualWrite === true;
  const target: 'postgres' | 'vault' = args.rollback ? 'postgres' : 'vault';
  const shortId = fullId.slice(0, 8);

  // Precondition checks for forward cutover. Match the helper's defensive
  // throws (vault-flip-helpers.ts flipSourceOfTruth) so the operator sees
  // the same error wording whether they invoke this script or the
  // lower-level vault-flip --source-of-truth=vault flag.
  if (target === 'vault') {
    if (backend !== 'vault') {
      console.error(
        `[vault-cutover] REFUSED: masterBackend=${backend}; run \`pnpm vault:flip --id=${shortId} --to=vault\` first`,
      );
      await pool.end();
      process.exit(1);
    }
    if (!vaultMutations) {
      console.error(
        `[vault-cutover] REFUSED: vaultMutations=false; run \`pnpm vault:flip --id=${shortId} --enable-mutations\` first`,
      );
      await pool.end();
      process.exit(1);
    }
    if (!dualWrite) {
      console.error(
        `[vault-cutover] REFUSED: dualWrite=false; cutover requires coexistence first (Decision 2). Enable dualWrite for this campaign before cutover.`,
      );
      await pool.end();
      process.exit(1);
    }
  }

  const windowHours = rollbackWindowHours();

  // Rollback window enforcement (Decision 5). Only applies when we are
  // actually rolling back (target=postgres) AND the campaign currently
  // resolves to sourceOfTruth=vault.
  if (target === 'postgres' && previousSourceOfTruth === 'vault') {
    const cutoverAt = row.settings.cutoverAt;
    if (!cutoverAt) {
      console.error(
        '[vault-cutover] REFUSED: campaign has sourceOfTruth=vault but no cutoverAt timestamp; cannot enforce rollback window',
      );
      await pool.end();
      process.exit(1);
    }
    const elapsedHours = (Date.now() - Date.parse(cutoverAt)) / (1000 * 60 * 60);
    if (elapsedHours > windowHours) {
      console.error(
        `[vault-cutover] REFUSED: rollback window expired (${elapsedHours.toFixed(1)}h > ${windowHours}h)`,
      );
      console.error(
        `[vault-cutover] To override: set CUTOVER_ROLLBACK_HOURS=<higher> env explicitly + re-run`,
      );
      await pool.end();
      process.exit(1);
    }
    console.log(
      `[vault-cutover] rollback within window (${elapsedHours.toFixed(1)}h < ${windowHours}h)`,
    );
  }

  // Idempotent no-op.
  if (previousSourceOfTruth === target) {
    console.log(
      `[vault-cutover] ${shortId} ${row.name} — already on sourceOfTruth=${target}, no-op`,
    );
    await pool.end();
    process.exit(0);
  }

  if (args.dryRun) {
    console.log(
      `[vault-cutover] ${shortId} ${row.name} — WOULD flip sourceOfTruth: ${previousSourceOfTruth} → ${target} (dry-run, no changes written)`,
    );
    await pool.end();
    process.exit(0);
  }

  // All gates passed — perform the flip through the shared helper.
  let result: Awaited<ReturnType<typeof flipSourceOfTruth>>;
  try {
    result = await flipSourceOfTruth(fullId, target);
  } catch (e) {
    // The helper throws on its own preconditions. Surface the message
    // verbatim — we already gated for vault preconditions above so this
    // branch is reached only if state changed between our read and the
    // helper's read (race), or for postgres-target edge cases.
    console.error(
      `[vault-cutover] flipSourceOfTruth failed: ${e instanceof Error ? e.message : e}`,
    );
    await pool.end();
    process.exit(1);
  }

  console.log(
    `[vault-cutover] ${shortId} ${row.name} — sourceOfTruth: ${result.previous} → ${result.next}${result.changed ? ' (FLIPPED)' : ''}`,
  );

  // Audit log. Per the must_haves contract: {action, campaignId,
  // previousSourceOfTruth, newSourceOfTruth, timestamp, operator: 'cli'}.
  const auditPath = writeAudit({
    action: target === 'vault' ? 'cutover' : 'rollback',
    campaignId: fullId,
    campaignName: row.name,
    previousSourceOfTruth: result.previous,
    newSourceOfTruth: result.next,
    timestamp: new Date().toISOString(),
    operator: 'cli',
    cutoverAtRecorded:
      target === 'vault' ? new Date().toISOString() : undefined,
    rollbackWindowHours: windowHours,
  });
  console.log(`[vault-cutover] audit: ${auditPath}`);

  if (result.next === 'vault') {
    console.log('');
    console.log('  Reads now pivot to vault. To roll back within the window:');
    console.log(`    pnpm vault:cutover --id=${shortId} --rollback`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('[vault-cutover] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
