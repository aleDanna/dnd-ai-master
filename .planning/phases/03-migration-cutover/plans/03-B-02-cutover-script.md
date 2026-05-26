---
phase: 03
plan: B-02
type: execute
wave: 5
depends_on: [03-B-01, 03-A-06]
files_modified:
  - scripts/vault-cutover.ts
  - package.json
  - tests/scripts/vault-cutover.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "`pnpm vault:cutover --id=<uuid>` flips campaign.settings.sourceOfTruth from 'postgres' to 'vault' AND records cutoverAt timestamp"
    - "`pnpm vault:cutover --id=<uuid> --rollback` flips sourceOfTruth back to 'postgres' if within CUTOVER_ROLLBACK_HOURS (default 24h); refuses if outside window"
    - "Preconditions enforced before cutover: masterBackend === 'vault' AND vaultMutations === true (operator-friendly error if violated)"
    - "When rollback is refused due to window expiry, the script suggests the operator extends CUTOVER_ROLLBACK_HOURS env if intentional"
    - "Cutover audit log written to .planning/phases/03-migration-cutover/cutover-audit/<campaignId>-<timestamp>.json with {action: 'cutover' | 'rollback', campaignId, previousSourceOfTruth, newSourceOfTruth, timestamp, operator: 'cli'}"
    - "All cutover operations go through scripts/vault-flip-helpers.ts (flipSourceOfTruth) — no inline JSONB mutation"
  artifacts:
    - path: "scripts/vault-cutover.ts"
      provides: "Cutover CLI with --id + --rollback flags"
    - path: "package.json"
      provides: "vault:cutover script entry"
      contains: "vault:cutover"
    - path: "tests/scripts/vault-cutover.test.ts"
      provides: "Cutover + rollback + window-expiry + precondition tests"
    - path: ".planning/phases/03-migration-cutover/cutover-audit/"
      provides: "Per-campaign cutover audit log directory"
  key_links:
    - from: "scripts/vault-cutover.ts"
      to: "scripts/vault-flip-helpers.ts (flipSourceOfTruth)"
      via: "Single named helper call"
      pattern: "flipSourceOfTruth"
---

# Plan 03-B-02: Cutover Script

**Phase:** 03-migration-cutover
**Wave:** 5 (depends on 03-B-01 flag + 03-A-06 helpers)
**Status:** Pending
**Estimated diff size:** ~180 LOC source + ~250 LOC tests / 3 files

## Goal

Ship the operator-facing CLI that performs the cutover (and its rollback). The actual JSONB flip lives in `flipSourceOfTruth` (plan 03-A-06 helper); this plan adds:
- Argument parsing (`--id`, `--rollback`)
- Precondition checks with operator-friendly errors
- Rollback-window enforcement (CUTOVER_ROLLBACK_HOURS env, default 24)
- Audit log file write
- Console output mirroring `vault-flip.ts` style

Per Decision 5: the rollback window is enforced HERE, not in the helper, because it's an operator-policy decision (the helper just flips the flag).

## Requirements satisfied

- **REQ-006** — Cutover is the reads-pivot step; rollback safety is the DR procedure during the coexistence window.

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/vault-cutover.ts` | NEW | Operator CLI |
| `package.json` | EDIT | Add vault:cutover script entry |
| `tests/scripts/vault-cutover.test.ts` | NEW | Behavior tests |

## Tasks

<task type="auto">
  <name>Task 1: Write scripts/vault-cutover.ts</name>
  <files>scripts/vault-cutover.ts</files>
  <read_first>
    - scripts/vault-flip-helpers.ts (plan 03-A-06 — flipSourceOfTruth signature + precondition errors)
    - scripts/vault-flip.ts (Phase 02 + refactored — CLI shape pattern; parseArgs + console.log + db connection close)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Decision 4 + 5 — cutover semantics + rollback window)
  </read_first>
  <action>
Create `scripts/vault-cutover.ts`:

```ts
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
 * Usage:
 *   pnpm vault:cutover --id=<uuid>             # flip to vault (cutover)
 *   pnpm vault:cutover --id=<uuid> --rollback  # flip back to postgres (within window)
 *   pnpm vault:cutover --id=<uuid> --dry-run   # show what WOULD change
 *
 * Audit log written to:
 *   .planning/phases/03-migration-cutover/cutover-audit/<id-prefix>-<iso-ts>.json
 */
import './_env-loader';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';
import { resolveMasterBackend, resolveSourceOfTruth } from '@/lib/preferences';
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
  }
  return args;
}

const AUDIT_DIR = '.planning/phases/03-migration-cutover/cutover-audit';

function writeAudit(entry: Record<string, unknown>): void {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const id = String(entry.campaignId ?? 'unknown').slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(AUDIT_DIR, `${id}-${ts}.json`);
  writeFileSync(path, JSON.stringify(entry, null, 2));
  console.log(`[vault-cutover] audit: ${path}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error('Usage: pnpm vault:cutover --id=<uuid> [--rollback] [--dry-run]');
    process.exit(2);
  }

  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, args.id)).limit(1);
  if (!row) {
    console.error(`[vault-cutover] campaign ${args.id} not found`);
    process.exit(1);
  }

  const previousSourceOfTruth = resolveSourceOfTruth(row.settings.sourceOfTruth);
  const backend = resolveMasterBackend(row.settings.masterBackend);
  const vaultMutations = row.settings.vaultMutations === true;
  const target: 'postgres' | 'vault' = args.rollback ? 'postgres' : 'vault';

  // Precondition checks
  if (target === 'vault') {
    if (backend !== 'vault') {
      console.error(`[vault-cutover] REFUSED: masterBackend=${backend}; run vault:flip --to=vault first`);
      process.exit(1);
    }
    if (!vaultMutations) {
      console.error(`[vault-cutover] REFUSED: vaultMutations=false; run vault:flip --enable-mutations first`);
      process.exit(1);
    }
  }

  // Rollback window enforcement
  if (target === 'postgres' && previousSourceOfTruth === 'vault') {
    const cutoverAt = row.settings.cutoverAt;
    if (!cutoverAt) {
      console.error('[vault-cutover] REFUSED: campaign has sourceOfTruth=vault but no cutoverAt timestamp; cannot enforce rollback window');
      process.exit(1);
    }
    const windowHours = Number(process.env.CUTOVER_ROLLBACK_HOURS ?? '24');
    const elapsed = (Date.now() - Date.parse(cutoverAt)) / (1000 * 60 * 60);
    if (elapsed > windowHours) {
      console.error(`[vault-cutover] REFUSED: rollback window expired (${elapsed.toFixed(1)}h > ${windowHours}h)`);
      console.error(`[vault-cutover] To override: set CUTOVER_ROLLBACK_HOURS=<higher> env explicitly + re-run`);
      process.exit(1);
    }
    console.log(`[vault-cutover] rollback within window (${elapsed.toFixed(1)}h < ${windowHours}h)`);
  }

  if (previousSourceOfTruth === target) {
    console.log(`[vault-cutover] ${args.id.slice(0, 8)} ${row.name} — already on sourceOfTruth=${target}, no-op`);
    await pool.end();
    process.exit(0);
  }

  if (args.dryRun) {
    console.log(`[vault-cutover] ${args.id.slice(0, 8)} ${row.name} — WOULD flip sourceOfTruth: ${previousSourceOfTruth} → ${target}`);
    await pool.end();
    process.exit(0);
  }

  const result = await flipSourceOfTruth(args.id, target);
  console.log(`[vault-cutover] ${args.id.slice(0, 8)} ${row.name} — sourceOfTruth: ${result.previous} → ${result.next}${result.changed ? ' (FLIPPED)' : ''}`);

  writeAudit({
    action: target === 'vault' ? 'cutover' : 'rollback',
    campaignId: args.id,
    campaignName: row.name,
    previousSourceOfTruth: result.previous,
    newSourceOfTruth: result.next,
    timestamp: new Date().toISOString(),
    operator: 'cli',
    cutoverAtRecorded: target === 'vault' ? new Date().toISOString() : undefined,
    rollbackWindowHours: Number(process.env.CUTOVER_ROLLBACK_HOURS ?? '24'),
  });

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('[vault-cutover] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "flipSourceOfTruth" scripts/vault-cutover.ts` returns exactly 1
    - `grep -c "CUTOVER_ROLLBACK_HOURS" scripts/vault-cutover.ts` returns >= 2 (precondition + override hint)
    - The script writes an audit JSON to .planning/phases/03-migration-cutover/cutover-audit/
    - Refuses cutover when masterBackend != vault OR vaultMutations != true
    - Refuses rollback past the configurable window
  </acceptance_criteria>
  <done>
    Script lands. Tasks 2-3 wire package.json + tests.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add vault:cutover to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (existing vault:* script entries)
  </read_first>
  <action>
Add `"vault:cutover": "tsx scripts/vault-cutover.ts",` to the scripts block. Position alphabetically with the other vault:* entries (between vault:backup and vault:flip).
  </action>
  <verify>
    <automated>grep -c "vault:cutover" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "vault:cutover" package.json` returns exactly 1
    - `pnpm vault:cutover --id=00000000-0000-0000-0000-000000000000` runs (and errors with "campaign not found", proving the script is reachable)
  </acceptance_criteria>
  <done>
    Script entry registered.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/scripts/vault-cutover.test.ts</name>
  <files>tests/scripts/vault-cutover.test.ts</files>
  <read_first>
    - scripts/vault-cutover.ts (Task 1)
    - tests/scripts/migrate-campaigns-to-vault.test.ts (plan 03-A-07 — execSync pattern + fixture setup)
  </read_first>
  <action>
Create `tests/scripts/vault-cutover.test.ts`. Skip if DATABASE_URL unset.

Cases:
1. **Cutover happy path** — campaign with masterBackend=vault + vaultMutations=true → `pnpm vault:cutover --id=<uuid>` flips sourceOfTruth to vault; audit file written
2. **Cutover refused — masterBackend=baked** — exit 1 with "REFUSED: masterBackend=baked" in stderr
3. **Cutover refused — vaultMutations=false** — exit 1 with "REFUSED: vaultMutations=false"
4. **Idempotent — already on vault** → "already on sourceOfTruth=vault, no-op" + exit 0
5. **Rollback within window** — flip to vault, then `--rollback` within 1h → flips back; audit file with action:rollback
6. **Rollback refused past window** — set cutoverAt to 25h ago, run --rollback → exit 1 with "rollback window expired"
7. **Rollback respects CUTOVER_ROLLBACK_HOURS env override** — set env=48 → rollback at 25h-elapsed proceeds
8. **--dry-run does not mutate** — confirm Postgres + audit dir unchanged
9. **Missing --id** — exit 2 with usage

The audit-file write CAN go to a tmpdir via env override (add a `CUTOVER_AUDIT_DIR` env in the script if not present; the test stubs it).

Use the `execSync` pattern from plan 03-A-07.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/vault-cutover.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL set (skipped otherwise)
    - The window-expiry case PASSES (proves the rollback-window enforcement)
    - The dry-run case proves no DB mutation
    - The audit-file case proves an audit JSON is written with correct content
    - Test runtime < 30s
    - Fixture cleanup is complete (no orphans in test DB)
  </acceptance_criteria>
  <done>
    Cutover script tested. Operator can flip sourceOfTruth with confidence.
  </done>
</task>
