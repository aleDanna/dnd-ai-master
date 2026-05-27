#!/usr/bin/env tsx
/**
 * scripts/migrate-stale-userprefs.ts — one-shot migration for stale
 * `userPrefs.aiMasterModel` + `campaigns.settings.aiMasterModel` values
 * left over after Phase 03-C-04 stripped the retired baked tier names
 * (`dnd-master-lite/max/max2/max3`) from `TIER_NAMES`.
 *
 * Why this script exists (Pitfall 6 in `03-RESEARCH.md`):
 *   After 03-C-04, `isBakedModel('dnd-master-max2')` still returns true
 *   (matches the `dnd-master-` prefix), but `getBakedBaseModel` returns
 *   `null` because the tier is no longer in `TIER_NAMES`. The turn route
 *   then resolves the slug verbatim and asks Ollama for `dnd-master-max2:
 *   latest`, which 404s — the turn fails for that user. This script
 *   rewrites every stale stored slug to the REQ-030 production primary
 *   (`qwen3:30b-a3b-instruct-2507-q4_K_M`) so no user can land on a
 *   missing model.
 *
 * Stale slugs migrated:
 *   `dnd-master-lite` / `dnd-master-lite:latest`
 *   `dnd-master-max`  / `dnd-master-max:latest`
 *   `dnd-master-max2` / `dnd-master-max2:latest`
 *   `dnd-master-max3` / `dnd-master-max3:latest`
 *
 * The smoke campaign One Piece (3ef630db) currently stores
 * `dnd-master-max2` — it is part of the migration cohort by default; the
 * operator can opt to keep `dnd-master-plus` as the regression-baseline
 * model via the operator playbook in plan 03-C-06.
 *
 * `dnd-master-plus` is PRESERVED (REQ-033 regression baseline) — it is
 * NOT in `STALE_SLUGS`, so it is never touched. The
 * `--preserve-pretty-names` flag is a NO-OP in the current shape and
 * exists only for forward compatibility (if a future tier name is
 * later added back as a pretty-name alias).
 *
 * Per-user (`users.preferences.aiMasterModel`) AND per-campaign
 * (`campaigns.settings.aiMasterModel`) scopes are migrated in the same
 * invocation. Both updates run inside the same script run so the
 * operator gets one combined summary.
 *
 * Idempotent: re-running produces `0 migrated, 0 campaigns`.
 *
 * Soft-delete safety: campaigns with `deleted_at IS NOT NULL` are
 * skipped — they're inert and don't generate turns.
 *
 * Usage:
 *   pnpm migrate-stale-userprefs                          # migrate
 *   pnpm migrate-stale-userprefs --dry-run                # preview only
 *   pnpm migrate-stale-userprefs --preserve-pretty-names  # no-op flag (see above)
 *
 * Uses `_env-loader` so it works wherever `vercel env pull` has
 * populated `.env.local` (no shell-level DATABASE_URL export needed).
 */
import './_env-loader';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';

/**
 * Stale baked-tier slugs to rewrite. Both bare (`dnd-master-max2`) AND
 * tagged (`dnd-master-max2:latest`) forms are matched because user
 * preferences historically store either depending on the entry point
 * (manual settings update vs. Ollama list output).
 *
 * `dnd-master-plus` is INTENTIONALLY ABSENT — it is the REQ-033
 * regression baseline and stays runnable on M4.
 */
const STALE_SLUGS = [
  'dnd-master-lite',
  'dnd-master-lite:latest',
  'dnd-master-max',
  'dnd-master-max:latest',
  'dnd-master-max2',
  'dnd-master-max2:latest',
  'dnd-master-max3',
  'dnd-master-max3:latest',
];

/**
 * REQ-030 production primary. The `aiMasterModel` field stores the BASE
 * Ollama slug directly on the vault path (no baked variant), so this is
 * the literal string `qwen3` knows how to load via `ollama run`.
 */
const PRIMARY = 'qwen3:30b-a3b-instruct-2507-q4_K_M';

interface Args {
  dryRun: boolean;
  preservePrettyNames: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, preservePrettyNames: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--preserve-pretty-names') args.preservePrettyNames = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: pnpm migrate-stale-userprefs [--dry-run] [--preserve-pretty-names]',
          '',
          'Rewrites stale dnd-master-{lite,max,max2,max3} stored in',
          '  users.preferences.aiMasterModel and',
          '  campaigns.settings.aiMasterModel',
          `to the REQ-030 primary '${PRIMARY}'.`,
          '',
          'Flags:',
          '  --dry-run               List what WOULD migrate, no UPDATE.',
          '  --preserve-pretty-names No-op today; reserved for future pretty-name aliases.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      console.error('Run with --help for usage.');
      process.exit(2);
    }
  }
  return args;
}

interface StaleUserRow {
  id: string;
  slug: string;
}

interface StaleCampaignRow {
  id: string;
  name: string;
  slug: string;
}

async function findStaleUsers(): Promise<StaleUserRow[]> {
  // Read every user row whose stored slug matches one of STALE_SLUGS.
  // The `= ANY(${arr})` predicate is parameterized — no string-concat SQL.
  const result = await db.execute(sql`
    SELECT id, preferences->>'aiMasterModel' AS slug
    FROM users
    WHERE preferences->>'aiMasterModel' = ANY(${STALE_SLUGS})
    ORDER BY id
  `);
  const rows = (result.rows ?? []) as Array<{ id: string; slug: string }>;
  return rows.map((r) => ({ id: String(r.id), slug: String(r.slug) }));
}

async function findStaleCampaigns(): Promise<StaleCampaignRow[]> {
  // Soft-deleted campaigns are excluded — they can't generate turns,
  // so rewriting their settings is wasted work + would mask the fact
  // that the migration window had observable scope.
  const result = await db.execute(sql`
    SELECT id, name, settings->>'aiMasterModel' AS slug
    FROM campaigns
    WHERE settings->>'aiMasterModel' = ANY(${STALE_SLUGS})
      AND deleted_at IS NULL
    ORDER BY id
  `);
  const rows = (result.rows ?? []) as Array<{ id: string; name: string; slug: string }>;
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), slug: String(r.slug) }));
}

function logUsers(rows: StaleUserRow[]): void {
  console.log(
    `[migrate-stale-userprefs] found ${rows.length} user(s) with stale preferences.aiMasterModel`,
  );
  for (const u of rows.slice(0, 20)) {
    const shortId = u.id.length >= 8 ? u.id.slice(0, 8) : u.id;
    console.log(`  - user=${shortId} slug=${u.slug}`);
  }
  if (rows.length > 20) console.log(`  ... (+${rows.length - 20} more)`);
}

function logCampaigns(rows: StaleCampaignRow[]): void {
  console.log(
    `[migrate-stale-userprefs] found ${rows.length} campaign(s) with stale settings.aiMasterModel`,
  );
  for (const c of rows.slice(0, 20)) {
    const shortId = c.id.length >= 8 ? c.id.slice(0, 8) : c.id;
    // Truncate long campaign names so the log line stays readable.
    const name = c.name.length > 50 ? c.name.slice(0, 47) + '...' : c.name;
    console.log(`  - campaign=${shortId} "${name}" slug=${c.slug}`);
  }
  if (rows.length > 20) console.log(`  ... (+${rows.length - 20} more)`);
}

async function applyMigration(): Promise<{ users: number; campaigns: number }> {
  // jsonb_set + to_jsonb(text) is the canonical pattern for editing a
  // single JSONB key in place. The `::text` cast on the literal is
  // necessary because drizzle's parameter binder defaults bind-typed
  // unknown parameters to `text`, but the `to_jsonb` overload resolution
  // is unambiguous when the cast is explicit.
  const userResult = await db.execute(sql`
    UPDATE users
    SET preferences = jsonb_set(preferences, '{aiMasterModel}', to_jsonb(${PRIMARY}::text))
    WHERE preferences->>'aiMasterModel' = ANY(${STALE_SLUGS})
  `);

  // Same pattern for campaigns + bump `updated_at` so the UI's
  // "last edited" timestamp reflects the migration (operators reading
  // the audit trail know WHEN the rewrite happened, not just that the
  // current value is the post-migration default).
  const campaignResult = await db.execute(sql`
    UPDATE campaigns
    SET settings = jsonb_set(settings, '{aiMasterModel}', to_jsonb(${PRIMARY}::text)),
        updated_at = now()
    WHERE settings->>'aiMasterModel' = ANY(${STALE_SLUGS})
      AND deleted_at IS NULL
  `);

  return {
    users: userResult.rowCount ?? 0,
    campaigns: campaignResult.rowCount ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.preservePrettyNames) {
    // Surface the no-op intent so the operator doesn't think it changed
    // anything. dnd-master-plus already lives outside STALE_SLUGS, so
    // there is nothing for the flag to preserve.
    console.log(
      '[migrate-stale-userprefs] --preserve-pretty-names: dnd-master-plus is not in STALE_SLUGS; flag is a no-op (forward-compat).',
    );
  }

  const userRows = await findStaleUsers();
  logUsers(userRows);

  const campaignRows = await findStaleCampaigns();
  logCampaigns(campaignRows);

  if (args.dryRun) {
    console.log('[migrate-stale-userprefs] DRY RUN — no changes written');
    console.log(
      `[migrate-stale-userprefs] WOULD migrate ${userRows.length} user(s) + ${campaignRows.length} campaign(s) to ${PRIMARY}`,
    );
    await pool.end();
    process.exit(0);
  }

  if (userRows.length === 0 && campaignRows.length === 0) {
    console.log(
      `[migrate-stale-userprefs] nothing to migrate — every stored aiMasterModel is already on a current slug`,
    );
    await pool.end();
    process.exit(0);
  }

  const result = await applyMigration();
  console.log(
    `[migrate-stale-userprefs] migrated users=${result.users} campaigns=${result.campaigns} → ${PRIMARY}`,
  );
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('[migrate-stale-userprefs] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
