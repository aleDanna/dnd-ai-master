#!/usr/bin/env tsx
/**
 * scripts/decommission-legacy-state.ts — Phase 03 Step 11 (deferred).
 *
 * Retires the Postgres legacy game-state tables AFTER the vault cutover has
 * soaked. This is the LAST, irreversible step of the migration ceremony.
 *
 * SCOPE (deliberately narrow):
 *   Drops ONLY the two leaf tables — `session_state` and `combat_actors`.
 *   These have NO inbound foreign keys, so the DROP is clean.
 *
 *   `characters` is NOT dropped here. It has inbound FKs from `sessions` and
 *   `session_messages`, AND it is still read at runtime by the Phase 09
 *   monster-turn resolver (the PC-AC bridge: `route.ts` selects
 *   `characters.ac` / `hpMax`). Dropping it now would break combat. Retiring
 *   `characters` is a separate, later migration that must first (a) repoint or
 *   drop those FK columns and (b) move the PC-AC/HP read onto the vault. Until
 *   then `characters` STAYS. See LEGACY_TABLES_RETAINED.
 *
 * SAFETY — this script is INERT by default. It performs the DROP only when the
 * pure readiness evaluator returns `ready: true`, which requires ALL of:
 *   1. `--confirm` is passed.
 *   2. At least one campaign exists (never drop on an empty/misconfigured read).
 *   3. EVERY non-deleted campaign is `sourceOfTruth: 'vault'` (nothing reads PG).
 *   4. NO campaign still has `dualWrite: true` (coexistence has ended).
 *   5. EVERY vault campaign's rollback window (`cutoverAt` + ROLLBACK_WINDOW_DAYS,
 *      default 30) has elapsed.
 *
 * It is intentionally NOT wired into `db:migrate` / `src/db/migrate.ts`: the
 * operator runs `pnpm decommission-legacy-state --confirm` consciously on the
 * production host after reviewing the divergence audit. There is no automatic
 * trigger.
 *
 * Usage:
 *   pnpm decommission-legacy-state              # readiness report (no changes)
 *   pnpm decommission-legacy-state --dry-run    # show the exact DROP SQL, no exec
 *   pnpm decommission-legacy-state --confirm    # execute the DROP (when ready)
 *
 * Env:
 *   ROLLBACK_WINDOW_DAYS  (default 30)  — soak window after cutover before drop
 *
 * Reversibility: NONE. Once dropped, restore is from a Postgres backup only.
 * The vault `events.md` is the source of truth post-cutover, so the dropped
 * tables hold no unique data — but take a final `pg_dump` first regardless.
 */

/**
 * The two leaf tables this script retires. Order is irrelevant (no inter-FK),
 * but listed combat_actors-then-session_state-agnostic. Exported for the test
 * contract.
 */
export const LEGACY_TABLES_TO_DROP = ['session_state', 'combat_actors'] as const;

/**
 * Tables explicitly NOT dropped by this script. `characters` is retained until
 * its inbound FKs are repointed AND the runtime PC-AC/HP read is moved to the
 * vault (Phase 09 resolver still reads it). Exported so the test pins the
 * protection.
 */
export const LEGACY_TABLES_RETAINED = ['characters'] as const;

export interface CampaignDecommissionSnapshot {
  id: string;
  name: string;
  sourceOfTruth: 'postgres' | 'vault';
  dualWrite: boolean;
  /** ISO-8601 cutover stamp, or null if never cut over. */
  cutoverAt: string | null;
}

export interface DecommissionReadiness {
  ready: boolean;
  blockers: string[];
  /** The tables that WOULD be dropped — only populated when `ready`. */
  tablesToDrop: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PURE GO/NO-GO decision. No DB, no clock, no env — every input is passed in
 * so the safety-critical logic is fully unit-testable. Accumulates ALL blockers
 * (does not short-circuit) so the operator sees every reason in one report.
 */
export function evaluateDecommissionReadiness(args: {
  campaigns: CampaignDecommissionSnapshot[];
  now: number;
  windowDays: number;
  confirm: boolean;
}): DecommissionReadiness {
  const { campaigns, now, windowDays, confirm } = args;
  const blockers: string[] = [];

  if (!confirm) {
    blockers.push('Refused: pass --confirm to authorize the irreversible DROP.');
  }

  if (campaigns.length === 0) {
    blockers.push('Refused: no campaigns found — refusing to drop on an empty/misconfigured DB read.');
  }

  for (const c of campaigns) {
    const tag = `${c.id.slice(0, 8)} "${c.name}"`;
    if (c.sourceOfTruth !== 'vault') {
      blockers.push(`Campaign ${tag} is still sourceOfTruth=postgres — cut it over before decommissioning.`);
      continue; // a postgres campaign's window/dualWrite checks are moot
    }
    if (c.dualWrite) {
      blockers.push(`Campaign ${tag} still has dualWrite=on — disable coexistence before decommissioning.`);
    }
    if (!c.cutoverAt) {
      blockers.push(`Campaign ${tag} is vault but has no cutoverAt timestamp — cannot verify the rollback window elapsed.`);
      continue;
    }
    const parsed = Date.parse(c.cutoverAt);
    if (Number.isNaN(parsed)) {
      blockers.push(`Campaign ${tag} has an unparseable cutoverAt (${c.cutoverAt}).`);
      continue;
    }
    const elapsedDays = (now - parsed) / DAY_MS;
    if (elapsedDays < windowDays) {
      const remaining = Math.ceil(windowDays - elapsedDays);
      blockers.push(
        `Campaign ${tag} rollback window not elapsed (${elapsedDays.toFixed(1)}d / ${windowDays}d; ${remaining}d remaining).`,
      );
    }
  }

  const ready = blockers.length === 0;
  return {
    ready,
    blockers,
    tablesToDrop: ready ? [...LEGACY_TABLES_TO_DROP] : [],
  };
}

/** The exact DROP SQL this script would run (leaf tables, IF EXISTS, no CASCADE). */
export function buildDropSql(): string {
  return LEGACY_TABLES_TO_DROP.map((t) => `DROP TABLE IF EXISTS "${t}";`).join('\n');
}

function rollbackWindowDays(): number {
  const raw = process.env.ROLLBACK_WINDOW_DAYS?.trim();
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return n;
}

interface Args {
  confirm: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, dryRun: false };
  for (const a of argv) {
    if (a === '--confirm') args.confirm = true;
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
  console.log('  pnpm decommission-legacy-state              # readiness report (no changes)');
  console.log('  pnpm decommission-legacy-state --dry-run    # show the DROP SQL, no exec');
  console.log('  pnpm decommission-legacy-state --confirm    # execute the DROP (when ready)');
  console.log('');
  console.log('Env: ROLLBACK_WINDOW_DAYS (default 30)');
  console.log('');
  console.log(`Drops ONLY: ${LEGACY_TABLES_TO_DROP.join(', ')}`);
  console.log(`Retains:    ${LEGACY_TABLES_RETAINED.join(', ')} (inbound FKs + still read by the Phase 09 resolver)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const windowDays = rollbackWindowDays();

  // Lazy imports so importing the pure exports (tests) never pulls in the DB client.
  await import('./_env-loader');
  const { eq, isNull } = await import('drizzle-orm');
  const { db, pool } = await import('@/db/client');
  const { campaigns } = await import('@/db/schema');
  const { resolveSourceOfTruth } = await import('@/lib/preferences');

  const rows = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt));

  const snapshots: CampaignDecommissionSnapshot[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceOfTruth: resolveSourceOfTruth(r.settings.sourceOfTruth),
    dualWrite: r.settings.dualWrite === true,
    cutoverAt: r.settings.cutoverAt || null,
  }));

  const readiness = evaluateDecommissionReadiness({
    campaigns: snapshots,
    now: Date.now(),
    windowDays,
    confirm: args.confirm,
  });

  console.log(`[decommission-legacy-state] ${snapshots.length} campaign(s); rollback window ${windowDays}d`);
  console.log(`[decommission-legacy-state] drops: ${LEGACY_TABLES_TO_DROP.join(', ')}  (retains: ${LEGACY_TABLES_RETAINED.join(', ')})`);

  if (!readiness.ready) {
    console.error('[decommission-legacy-state] NOT READY — refusing to drop. Blockers:');
    for (const b of readiness.blockers) console.error(`  - ${b}`);
    await pool.end();
    process.exit(1);
  }

  if (args.dryRun || !args.confirm) {
    console.log('[decommission-legacy-state] READY. SQL that WOULD run (dry-run / no --confirm):');
    console.log(buildDropSql());
    if (!args.confirm) console.log('[decommission-legacy-state] Re-run with --confirm to execute.');
    await pool.end();
    process.exit(0);
  }

  // Ready AND --confirm AND not dry-run → execute the irreversible DROP.
  console.log('[decommission-legacy-state] READY + --confirm → executing DROP (irreversible)…');
  const { sql } = await import('drizzle-orm');
  for (const table of LEGACY_TABLES_TO_DROP) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "${table}";`));
    console.log(`  dropped ${table}`);
  }
  console.log('[decommission-legacy-state] done. Remember: `characters` is retained by design.');
  await pool.end();
  process.exit(0);
}

// Run only when invoked directly (tsx scripts/decommission-legacy-state.ts ...),
// NOT when imported by the test suite (mirrors decommission-baked.ts).
const isDirectRun =
  process.argv[1] !== undefined && process.argv[1].includes('decommission-legacy-state');
if (isDirectRun) {
  void main();
}
