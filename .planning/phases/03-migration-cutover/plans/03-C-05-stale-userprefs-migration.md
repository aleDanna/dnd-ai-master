---
phase: 03
plan: C-05
type: execute
wave: 8
depends_on: [03-C-04]
files_modified:
  - scripts/migrate-stale-userprefs.ts
  - package.json
  - tests/scripts/migrate-stale-userprefs.test.ts
autonomous: true
requirements: [REQ-030, REQ-033]
must_haves:
  truths:
    - "`pnpm migrate-stale-userprefs` finds every user row where preferences.aiMasterModel matches a retired tier slug and rewrites it to qwen3:30b-a3b-instruct-2507-q4_K_M (REQ-030 production primary)"
    - "The script ALSO scans campaigns.settings.aiMasterModel for stale references and migrates them (per-campaign overrides)"
    - "The script is IDEMPOTENT — re-running produces 0 migrated"
    - "The script has --dry-run for safety (lists what WOULD migrate)"
    - "Stale slugs migrated: 'dnd-master-lite', 'dnd-master-max', 'dnd-master-max2', 'dnd-master-max3' → 'qwen3:30b-a3b-instruct-2507-q4_K_M'"
    - "The SMOKE CAMPAIGN One Piece (3ef630db) which uses 'dnd-master-max2' is migrated to the primary by default; the operator playbook (plan 03-C-06) notes this"
    - "A --preserve-pretty-names flag keeps dnd-master-plus as the chosen model for any user/campaign whose preference is 'dnd-master-plus' (regression baseline use case — kept as-is)"
  artifacts:
    - path: "scripts/migrate-stale-userprefs.ts"
      provides: "One-shot migration CLI for stale aiMasterModel references"
    - path: "package.json"
      provides: "migrate-stale-userprefs script entry"
      contains: "migrate-stale-userprefs"
    - path: "tests/scripts/migrate-stale-userprefs.test.ts"
      provides: "Idempotency + per-row + dry-run tests"
  key_links:
    - from: "scripts/migrate-stale-userprefs.ts"
      to: "src/ai/master/baked-models.ts (TIER_NAMES — plan 03-C-04)"
      via: "Reads the post-strip TIER_NAMES to identify what's still valid"
      pattern: "TIER_NAMES"
---

# Plan 03-C-05: Stale userPrefs.aiMasterModel Migration

**Phase:** 03-migration-cutover
**Wave:** 8 (depends on 03-C-04 TIER_NAMES strip)
**Status:** Pending
**Estimated diff size:** ~120 LOC source + ~180 LOC tests / 3 files

## Goal

Per Pitfall 6 + Decision 8: after plan 03-C-04 strips the retired tier mappings, any `userPrefs.aiMasterModel = 'dnd-master-max2'` (etc.) row still points at a baked variant that no longer builds. The next turn for that user fails with `ollama 404 model not found`.

This plan ships a one-shot SQL migration script that rewrites stored stale slugs to the production primary base slug (`qwen3:30b-a3b-instruct-2507-q4_K_M` — REQ-030).

Same migration on `campaigns.settings.aiMasterModel` (per-campaign override).

The smoke campaign One Piece (3ef630db) currently uses `dnd-master-max2` — it's part of the migration cohort. The operator can opt-in to keep `dnd-master-plus` as the chosen model for regression-baseline campaigns via `--preserve-pretty-names`.

## Requirements satisfied

- **REQ-030** — Production primary `qwen3:30b-a3b-instruct-2507-q4_K_M` becomes the post-migration default for any user/campaign whose stored slug was a retired tier
- **REQ-033** — Closes the user-data half of baked-variant decommission (plan 03-C-04 closed the code half)

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/migrate-stale-userprefs.ts` | NEW | One-shot CLI |
| `package.json` | EDIT | Script entry |
| `tests/scripts/migrate-stale-userprefs.test.ts` | NEW | Behavior tests |

## Tasks

<task type="auto">
  <name>Task 1: Write scripts/migrate-stale-userprefs.ts</name>
  <files>scripts/migrate-stale-userprefs.ts</files>
  <read_first>
    - src/db/schema/users.ts (the users table + preferences jsonb column structure)
    - src/db/schema/campaigns.ts (campaigns.settings jsonb with aiMasterModel field)
    - scripts/vault-flip.ts (CLI structure pattern + _env-loader)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Pitfall 6 — the canonical migration SQL)
  </read_first>
  <action>
Create `scripts/migrate-stale-userprefs.ts`:

```ts
#!/usr/bin/env tsx
/**
 * scripts/migrate-stale-userprefs.ts — one-shot migration for stale
 * userPrefs.aiMasterModel + campaigns.settings.aiMasterModel after Phase 03-C-04
 * strips retired baked tier names.
 *
 * Stale slugs migrated:
 *   dnd-master-lite, dnd-master-max, dnd-master-max2, dnd-master-max3
 *     → 'qwen3:30b-a3b-instruct-2507-q4_K_M' (REQ-030 production primary)
 *
 * dnd-master-plus is PRESERVED (regression baseline per REQ-033).
 *
 * Per-user (users.preferences) AND per-campaign (campaigns.settings) scopes.
 *
 * Idempotent: re-running produces 0 migrated.
 *
 * Usage:
 *   pnpm migrate-stale-userprefs                         # migrate
 *   pnpm migrate-stale-userprefs --dry-run               # preview
 *   pnpm migrate-stale-userprefs --preserve-pretty-names # keep dnd-master-plus as is (no-op for plus refs)
 */
import './_env-loader';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';

const STALE_SLUGS = ['dnd-master-lite', 'dnd-master-max', 'dnd-master-max2', 'dnd-master-max3'];
const PRIMARY = 'qwen3:30b-a3b-instruct-2507-q4_K_M';

interface Args { dryRun: boolean; preservePrettyNames: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, preservePrettyNames: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--preserve-pretty-names') args.preservePrettyNames = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Count stale users
  const userResult = await db.execute(sql`
    SELECT id, preferences->>'aiMasterModel' AS slug
    FROM users
    WHERE preferences->>'aiMasterModel' = ANY(${STALE_SLUGS})
  `);
  const userRows = userResult.rows ?? [];
  console.log(`[migrate-stale-userprefs] found ${userRows.length} user(s) with stale aiMasterModel`);
  for (const u of userRows.slice(0, 20)) {
    console.log(`  - user=${(u as any).id?.toString().slice(0, 8) ?? '?'} slug=${(u as any).slug}`);
  }
  if (userRows.length > 20) console.log(`  ... (+${userRows.length - 20} more)`);

  // Count stale campaigns
  const campaignResult = await db.execute(sql`
    SELECT id, name, settings->>'aiMasterModel' AS slug
    FROM campaigns
    WHERE settings->>'aiMasterModel' = ANY(${STALE_SLUGS})
      AND deleted_at IS NULL
  `);
  const campaignRows = campaignResult.rows ?? [];
  console.log(`[migrate-stale-userprefs] found ${campaignRows.length} campaign(s) with stale settings.aiMasterModel`);
  for (const c of campaignRows.slice(0, 20)) {
    console.log(`  - campaign=${(c as any).id?.toString().slice(0, 8) ?? '?'} ${(c as any).name} slug=${(c as any).slug}`);
  }
  if (campaignRows.length > 20) console.log(`  ... (+${campaignRows.length - 20} more)`);

  if (args.dryRun) {
    console.log(`[migrate-stale-userprefs] DRY RUN — no changes`);
    console.log(`[migrate-stale-userprefs] WOULD migrate ${userRows.length} user(s) + ${campaignRows.length} campaign(s) to ${PRIMARY}`);
    await pool.end();
    return;
  }

  // Apply
  const userUpdate = await db.execute(sql`
    UPDATE users
    SET preferences = jsonb_set(preferences, '{aiMasterModel}', to_jsonb(${PRIMARY}::text))
    WHERE preferences->>'aiMasterModel' = ANY(${STALE_SLUGS})
  `);
  const campaignUpdate = await db.execute(sql`
    UPDATE campaigns
    SET settings = jsonb_set(settings, '{aiMasterModel}', to_jsonb(${PRIMARY}::text)),
        updated_at = now()
    WHERE settings->>'aiMasterModel' = ANY(${STALE_SLUGS})
      AND deleted_at IS NULL
  `);

  console.log(`[migrate-stale-userprefs] migrated ${userUpdate.rowCount ?? 0} user(s) + ${campaignUpdate.rowCount ?? 0} campaign(s) to ${PRIMARY}`);
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate-stale-userprefs] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

The `--preserve-pretty-names` flag is a NO-OP in the current shape (dnd-master-plus is not in STALE_SLUGS so it's not migrated regardless). The flag is present for future-proofing IF additional pretty-name slugs get added later.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - The script uses parameterized SQL (= ANY array) for the stale slug list
    - Both users + campaigns scopes are migrated
    - The PRIMARY const equals 'qwen3:30b-a3b-instruct-2507-q4_K_M' (REQ-030)
    - --dry-run prints counts without UPDATE
  </acceptance_criteria>
  <done>
    Script lands. Tasks 2-3 wire entry + tests.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add migrate-stale-userprefs to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (existing — see migrate-handbook-to-vault entry)
  </read_first>
  <action>
Add `"migrate-stale-userprefs": "tsx scripts/migrate-stale-userprefs.ts",` near the other migrate-* entries.
  </action>
  <verify>
    <automated>grep -c "migrate-stale-userprefs" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "migrate-stale-userprefs" package.json` returns 1
  </acceptance_criteria>
  <done>
    Entry added.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/scripts/migrate-stale-userprefs.test.ts</name>
  <files>tests/scripts/migrate-stale-userprefs.test.ts</files>
  <read_first>
    - scripts/migrate-stale-userprefs.ts (Task 1)
    - tests/scripts/migrate-campaigns-to-vault.test.ts (plan 03-A-07 — execSync CLI test pattern)
  </read_first>
  <action>
Create `tests/scripts/migrate-stale-userprefs.test.ts`. DB-gated.

Cases:
1. Fixture: insert 3 users with stale slugs (lite/max/max2), 1 user with primary (control), 1 campaign with stale settings
2. `--dry-run` lists the stale rows without mutating
3. Actual run rewrites all stale rows to PRIMARY
4. Re-run is idempotent (0 rows migrated)
5. Users with non-stale slugs (e.g., already on primary, or on dnd-master-plus) are NOT migrated
6. Campaigns with `deleted_at IS NOT NULL` are NOT migrated (soft-deleted exclusion)

Use the execSync pattern + per-test fixture cleanup.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/migrate-stale-userprefs.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL set
    - Re-run idempotency case passes (the script handles already-migrated rows)
    - The dnd-master-plus regression-baseline case is preserved (user keeps plus, not migrated)
    - Fixture cleanup is complete
  </acceptance_criteria>
  <done>
    User-data half of baked decommission shipped.
  </done>
</task>
