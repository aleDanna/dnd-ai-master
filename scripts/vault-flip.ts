#!/usr/bin/env tsx
/**
 * scripts/vault-flip.ts — toggle a campaign between `vault` and `baked`
 * backends without dropping into psql.
 *
 * Usage:
 *   pnpm vault:flip                          # list campaigns + their current backend
 *   pnpm vault:flip --id=<uuid> --to=vault   # set masterBackend=vault
 *   pnpm vault:flip --id=<uuid> --to=baked   # set masterBackend=baked
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

interface Args {
  id: string | null;
  to: MasterBackend | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { id: null, to: null };
  for (const a of argv) {
    if (a.startsWith('--id=')) args.id = a.slice('--id='.length);
    else if (a.startsWith('--to=')) {
      const raw = a.slice('--to='.length);
      if (!isMasterBackend(raw)) {
        console.error(`Invalid --to=${raw}. Use 'vault' or 'baked'.`);
        process.exit(2);
      }
      args.to = raw;
    }
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

  console.log('id (short)  backend  last played       name');
  console.log('──────────  ───────  ─────────────────  ────');
  for (const r of rows) {
    const shortId = r.id.slice(0, 8);
    const backend = resolveMasterBackend(r.settings.masterBackend);
    const last = r.lastPlayedAt ? r.lastPlayedAt.toISOString().slice(0, 16).replace('T', ' ') : '—';
    const name = r.name.slice(0, 50);
    console.log(`${shortId}    ${backend.padEnd(7)}  ${last.padEnd(17)}  ${name}`);
  }
  console.log('');
  console.log('To flip one onto the vault backend:');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --to=vault');
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

async function flipCampaign(id: string, to: MasterBackend): Promise<void> {
  const fullId = await resolveCampaignId(id);
  if (!fullId) {
    console.error(`Campaign ${id} not found.`);
    process.exit(2);
  }

  const [before] = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(eq(campaigns.id, fullId))
    .limit(1);
  if (!before) {
    console.error(`Campaign ${fullId} disappeared mid-flip.`);
    process.exit(2);
  }

  const prevBackend = resolveMasterBackend(before.settings.masterBackend);
  if (prevBackend === to) {
    console.log(`Campaign "${before.name}" (${fullId.slice(0, 8)}) is already on '${to}'. No-op.`);
    return;
  }

  const nextSettings = { ...before.settings, masterBackend: to };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, fullId));

  console.log(`✓ Campaign "${before.name}" (${fullId.slice(0, 8)}) flipped: ${prevBackend} → ${to}`);
  if (to === 'vault') {
    console.log('');
    console.log('  Next steps:');
    console.log('    pnpm migrate-handbook-to-vault   # if not already run');
    console.log('    pnpm dev                          # ensure dev server is up');
    console.log('    pnpm bench-vault-m4 --user-jwt=<__session-cookie>');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id && !args.to) {
    await listCampaigns();
  } else if (args.id && args.to) {
    await flipCampaign(args.id, args.to);
  } else {
    console.error('Both --id=<uuid> and --to=vault|baked are required to flip.');
    console.error('Without args, lists all campaigns.');
    process.exit(2);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('vault-flip failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
