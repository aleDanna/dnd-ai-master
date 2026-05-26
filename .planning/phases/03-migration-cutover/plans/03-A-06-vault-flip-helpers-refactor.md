---
phase: 03
plan: A-06
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/vault-flip-helpers.ts
  - scripts/vault-flip.ts
  - tests/scripts/vault-flip-helpers.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "scripts/vault-flip-helpers.ts exports flipCampaignToVault(campaignId), enableMutationsForCampaign(campaignId), flipSourceOfTruth(campaignId, target) as named, testable functions"
    - "scripts/vault-flip.ts main() is reduced to a thin arg-parsing + dispatch shell over the helpers (behavior unchanged for existing flags --to / --enable-mutations / --disable-mutations)"
    - "All Phase 02 vault-flip CLI cases (the existing usage from docs/operators/vault-backup.md) continue to work end-to-end"
    - "plan 03-A-07 (bulk migration script) can `import { flipCampaignToVault, enableMutationsForCampaign } from './vault-flip-helpers'` and loop over campaigns"
    - "plan 03-B-02 (cutover script) can `import { flipSourceOfTruth } from './vault-flip-helpers'` and implement the cutover flag flip"
    - "The seed-event payload assembly (LEFT JOIN sessions ⨝ session_state to get hp_current; characters.spellcasting to get spell_slots) is now in a single named function `assembleCampaignSeedPayload(campaignId)` that BOTH the helpers and the existing main() use"
  artifacts:
    - path: "scripts/vault-flip-helpers.ts"
      provides: "Named exports of the flip operations + seed payload assembler"
      exports: ["flipCampaignToVault", "enableMutationsForCampaign", "disableMutationsForCampaign", "flipSourceOfTruth", "assembleCampaignSeedPayload"]
    - path: "scripts/vault-flip.ts"
      provides: "CLI shell that delegates to the helpers (main + parseArgs only)"
    - path: "tests/scripts/vault-flip-helpers.test.ts"
      provides: "Per-helper unit tests (DATABASE_URL gated)"
  key_links:
    - from: "scripts/vault-flip.ts (main)"
      to: "scripts/vault-flip-helpers.ts"
      via: "Direct import + call after arg parsing"
      pattern: "vault-flip-helpers"
    - from: "scripts/migrate-campaigns-to-vault.ts (plan 03-A-07)"
      to: "scripts/vault-flip-helpers.ts"
      via: "Bulk loop wraps the per-campaign helpers"
      pattern: "flipCampaignToVault|enableMutationsForCampaign"
    - from: "scripts/vault-cutover.ts (plan 03-B-02)"
      to: "scripts/vault-flip-helpers.ts (flipSourceOfTruth)"
      via: "Cutover wraps the parallel-shape source-of-truth flip"
      pattern: "flipSourceOfTruth"
---

# Plan 03-A-06: Refactor vault-flip into Named Helpers

**Phase:** 03-migration-cutover
**Wave:** 1 (no deps)
**Status:** Pending
**Estimated diff size:** ~250 LOC source (refactor — net ~0 LOC change to the codebase, just relocation) + ~150 LOC tests / 3 files

## Goal

Phase 02 shipped `scripts/vault-flip.ts` as a single-file CLI: `main()` parses args, then inlines the flip + enable-mutations logic. Plan 03-A-07 (bulk migration) and plan 03-B-02 (cutover) need to REUSE this logic per-campaign in a loop. Without refactoring, both new scripts would duplicate the LEFT JOIN sessions ⨝ session_state code + the seed-event assembly — exactly the regression risk BLOCKER 1 from Phase 02 plan 02-10 surfaced.

This plan refactors `scripts/vault-flip.ts` to export named helpers from a new `scripts/vault-flip-helpers.ts`, then collapses the existing `main()` to a thin CLI shell that calls those helpers. The Phase 02 behavior MUST remain bit-identical (all existing flags, all existing outputs).

Additionally, this plan adds the NEW helper `flipSourceOfTruth(campaignId, target: 'postgres' | 'vault')` for plan 03-B-02 to consume — the parallel-shape extension of `flipCampaignToVault` for the cutover semantics (Decision 4).

## Requirements satisfied

- **REQ-006** — Reuse of validated migration primitives (Phase 02 seed-event assembly) preserves DR correctness for the bulk migration. No re-derivation.

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/vault-flip-helpers.ts` | NEW | Extract named helpers |
| `scripts/vault-flip.ts` | EDIT (refactor) | Collapse main() to call the helpers |
| `tests/scripts/vault-flip-helpers.test.ts` | NEW | Per-helper unit tests |

## Tasks

<task type="auto">
  <name>Task 1: Extract helpers into scripts/vault-flip-helpers.ts</name>
  <files>scripts/vault-flip-helpers.ts</files>
  <read_first>
    - scripts/vault-flip.ts (entire file — main() spans lines ~85-280; the LEFT JOIN sessions ⨝ session_state pattern lives here; the seed event assembly + EventsWriter.applyEvent + regenerateAffectedViews calls)
    - src/ai/master/vault/events-writer.ts (EventsWriter.applyEvent — the call signature)
    - src/ai/master/vault/projector.ts (regenerateAffectedViews — the call signature)
    - src/ai/master/vault/events-schema.ts (VaultEventEnvelope, VaultSeedCharacter — extended in plan 03-A-03)
    - src/ai/master/vault/campaign-paths.ts (eventsPath, UUID_REGEX)
    - src/db/schema/campaigns.ts (campaigns table + CampaignSettings + sourceOfTruth field added in plan 03-B-01)
  </read_first>
  <action>
Create `scripts/vault-flip-helpers.ts`. This is the EXTRACTED logic from `scripts/vault-flip.ts` — same algorithm, exposed as named functions.

```ts
// scripts/vault-flip-helpers.ts
// Named helpers extracted from scripts/vault-flip.ts main() for reuse by:
//   - scripts/migrate-campaigns-to-vault.ts (plan 03-A-07 bulk loop)
//   - scripts/vault-cutover.ts (plan 03-B-02 source-of-truth flip)
// The Phase 02 CLI (scripts/vault-flip.ts) now consumes these helpers from
// its main() — behavior unchanged for existing operator commands.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions, sessionState } from '@/db/schema';
import { resolveMasterBackend, type MasterBackend } from '@/lib/preferences';
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { EVENT_SCHEMA_VERSION } from '@/ai/master/vault/events-schema';
import type { VaultEventEnvelope, VaultSeedCharacter } from '@/ai/master/vault/events-schema';

export interface FlipResult {
  campaignId: string;
  campaignName: string;
  previousBackend: MasterBackend;
  newBackend: MasterBackend;
  changed: boolean;
}

export async function flipCampaignToVault(campaignId: string): Promise<FlipResult> {
  // Extracted from scripts/vault-flip.ts main() lines ~95-145
  // (the "set masterBackend = 'vault'" path)
  const [row] = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error(`flipCampaignToVault: campaign ${campaignId} not found`);
  const previousBackend = resolveMasterBackend(row.settings.masterBackend);
  if (previousBackend === 'vault') {
    return { campaignId, campaignName: row.name, previousBackend, newBackend: 'vault', changed: false };
  }
  await db
    .update(campaigns)
    .set({
      settings: { ...row.settings, masterBackend: 'vault' as const },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));
  return { campaignId, campaignName: row.name, previousBackend, newBackend: 'vault', changed: true };
}

export async function flipCampaignToBaked(campaignId: string): Promise<FlipResult> {
  // Same shape — for completeness + symmetry (and used by the existing CLI --to=baked flag)
  // ... (similar implementation — extracted from main())
  const [row] = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error(`flipCampaignToBaked: campaign ${campaignId} not found`);
  const previousBackend = resolveMasterBackend(row.settings.masterBackend);
  if (previousBackend === 'baked') {
    return { campaignId, campaignName: row.name, previousBackend, newBackend: 'baked', changed: false };
  }
  await db
    .update(campaigns)
    .set({
      settings: { ...row.settings, masterBackend: 'baked' as const },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));
  return { campaignId, campaignName: row.name, previousBackend, newBackend: 'baked', changed: true };
}

/**
 * Assembles the campaign_initialized seed payload from Postgres.
 * EXTRACTED VERBATIM from scripts/vault-flip.ts — the BLOCKER-1 fix
 * (LEFT JOIN sessions ⨝ session_state for hp_current) is preserved.
 *
 * Phase 03 extends the seed shape with optional persisted fields
 * (per plan 03-A-03 VaultSeedCharacter extension): temp_hp,
 * hit_dice_remaining, hit_dice_max, exhaustion_level, resources_used,
 * xp, level, classes. The LEFT JOIN harvests these from session_state +
 * characters where available; omits when null (projector falls back to
 * INITIAL_CHARACTER_STATE defaults).
 */
export async function assembleCampaignSeedPayload(campaignId: string): Promise<VaultSeedCharacter[]> {
  // The full SELECT extracted from scripts/vault-flip.ts; extend with the
  // new Phase 03 columns from session_state + characters:
  //   - session_state.temp_hp                      -> seed.temp_hp
  //   - session_state.hit_dice_remaining           -> seed.hit_dice_remaining
  //   - characters.classLevels (JSONB) -> classes  -> seed.classes
  //   - sum(classLevels values) === characters.level -> seed.level
  //   - max(level) -> hit_dice_max (1/level — standard PHB)
  //   - session_state.exhaustion_level             -> seed.exhaustion_level
  //   - session_state.resources_used               -> seed.resources_used
  //   - characters.xp                              -> seed.xp
  const rows = await db
    .select({
      charId: characters.id,
      charName: characters.name,
      hpMax: characters.hpMax,
      hpCurrent: sessionState.hpCurrent,
      tempHp: sessionState.tempHp,
      hitDiceRemaining: sessionState.hitDiceRemaining,
      exhaustionLevel: sessionState.exhaustionLevel,
      resourcesUsed: sessionState.resourcesUsed,
      classLevels: characters.classLevels,
      level: characters.level,
      xp: characters.xp,
      spellcasting: characters.spellcasting,
      spellSlotsUsed: characters.spellSlotsUsed,
    })
    .from(characters)
    .leftJoin(sessions, and(eq(sessions.campaignId, characters.campaignId), isNull(sessions.deletedAt)))
    .leftJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)))
    .orderBy(desc(sessions.lastPlayedAt));

  // Dedup by character id, keep most-recent session_state (first row per id due to ORDER BY DESC)
  const byChar = new Map<string, typeof rows[0]>();
  for (const r of rows) {
    if (!byChar.has(r.charId)) byChar.set(r.charId, r);
  }

  return Array.from(byChar.values()).map((r): VaultSeedCharacter => {
    // Assemble spell_slots — same shape as Phase 02
    const slotsMax = (r.spellcasting?.slotsMax ?? {}) as Record<string, number>;
    const slotsUsed = (r.spellSlotsUsed ?? {}) as Record<string, number>;
    const spellSlots: Record<string, { max: number; used: number }> = {};
    for (const [level, max] of Object.entries(slotsMax)) {
      if (max > 0) {
        spellSlots[level] = { max, used: slotsUsed[level] ?? 0 };
      }
    }
    const seed: VaultSeedCharacter = {
      id: r.charId,
      name: r.charName,
      hp_max: r.hpMax,
    };
    if (r.hpCurrent !== null && r.hpCurrent !== undefined) seed.hp_current = r.hpCurrent;
    if (Object.keys(spellSlots).length > 0) seed.spell_slots = spellSlots;
    // Phase 03 optional fields — only emit if present in Postgres
    if (r.tempHp !== null && r.tempHp !== undefined && r.tempHp > 0) seed.temp_hp = r.tempHp;
    if (r.hitDiceRemaining !== null && r.hitDiceRemaining !== undefined) seed.hit_dice_remaining = r.hitDiceRemaining;
    if (r.level !== null && r.level !== undefined) seed.level = r.level;
    if (r.level) seed.hit_dice_max = r.level;  // 1 die/level
    if (r.exhaustionLevel !== null && r.exhaustionLevel !== undefined && r.exhaustionLevel > 0) seed.exhaustion_level = r.exhaustionLevel;
    if (r.resourcesUsed && Object.keys(r.resourcesUsed).length > 0) seed.resources_used = r.resourcesUsed as Record<string, number>;
    if (r.xp !== null && r.xp !== undefined && r.xp > 0) seed.xp = r.xp;
    if (r.classLevels && Object.keys(r.classLevels).length > 0) seed.classes = r.classLevels as Record<string, number>;
    return seed;
  });
}

export interface EnableMutationsResult {
  campaignId: string;
  campaignName: string;
  changed: boolean;
  seedEventId?: string;
  charactersSeeded?: number;
}

export async function enableMutationsForCampaign(campaignId: string): Promise<EnableMutationsResult> {
  // Extracted from scripts/vault-flip.ts main() (the --enable-mutations branch).
  // 1. Verify campaign exists + masterBackend === 'vault' (warn if not)
  // 2. Set settings.vaultMutations = true
  // 3. Assemble seed payload via assembleCampaignSeedPayload
  // 4. Append campaign_initialized event via EventsWriter
  // 5. regenerateAffectedViews
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!row) throw new Error(`enableMutationsForCampaign: campaign ${campaignId} not found`);

  // Check if already enabled (idempotent — the migration script depends on this)
  if (row.settings.vaultMutations === true && resolveMasterBackend(row.settings.masterBackend) === 'vault') {
    return { campaignId, campaignName: row.name, changed: false };
  }

  // Set the flag
  await db
    .update(campaigns)
    .set({
      settings: { ...row.settings, vaultMutations: true },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));

  // Build + emit the seed event ONCE per campaign — guard by checking events.md
  // for an existing campaign_initialized line first (true idempotency for re-runs)
  const seedCharacters = await assembleCampaignSeedPayload(campaignId);
  const envelope: VaultEventEnvelope = {
    id: randomUUID(),
    version: EVENT_SCHEMA_VERSION,
    type: 'campaign_initialized',
    payload: { characters: seedCharacters },
    timestamp: new Date().toISOString(),
  };
  await EventsWriter.applyEvent(eventsPath(campaignId), envelope);
  await regenerateAffectedViews(campaignId, envelope);
  return {
    campaignId,
    campaignName: row.name,
    changed: true,
    seedEventId: envelope.id,
    charactersSeeded: seedCharacters.length,
  };
}

export async function disableMutationsForCampaign(campaignId: string): Promise<{ campaignId: string; changed: boolean }> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!row) throw new Error(`disableMutationsForCampaign: campaign ${campaignId} not found`);
  if (row.settings.vaultMutations !== true) {
    return { campaignId, changed: false };
  }
  await db
    .update(campaigns)
    .set({ settings: { ...row.settings, vaultMutations: false }, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
  return { campaignId, changed: true };
}

/**
 * Phase 03-B Decision 4 — flip sourceOfTruth between 'postgres' and 'vault'.
 * Parallel-shape with flipCampaignToVault/Baked. Used by plan 03-B-02 vault-cutover script.
 */
export async function flipSourceOfTruth(
  campaignId: string,
  target: 'postgres' | 'vault',
): Promise<{ campaignId: string; previous: 'postgres' | 'vault'; next: 'postgres' | 'vault'; changed: boolean }> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!row) throw new Error(`flipSourceOfTruth: campaign ${campaignId} not found`);
  // resolveSourceOfTruth lives in src/lib/preferences.ts (plan 03-B-01)
  const { resolveSourceOfTruth } = await import('@/lib/preferences');
  const previous = resolveSourceOfTruth(row.settings.sourceOfTruth);
  if (previous === target) {
    return { campaignId, previous, next: target, changed: false };
  }
  // Defensive: target=vault requires masterBackend === 'vault' + vaultMutations === true
  if (target === 'vault') {
    const backend = resolveMasterBackend(row.settings.masterBackend);
    if (backend !== 'vault') {
      throw new Error(`flipSourceOfTruth: cannot set sourceOfTruth=vault when masterBackend=${backend}; run vault-flip --to=vault first`);
    }
    if (row.settings.vaultMutations !== true) {
      throw new Error(`flipSourceOfTruth: cannot set sourceOfTruth=vault when vaultMutations=false; run vault-flip --enable-mutations first`);
    }
  }
  const now = new Date();
  await db
    .update(campaigns)
    .set({
      settings: {
        ...row.settings,
        sourceOfTruth: target,
        cutoverAt: target === 'vault' ? now.toISOString() : row.settings.cutoverAt,
      },
      updatedAt: now,
    })
    .where(eq(campaigns.id, campaignId));
  return { campaignId, previous, next: target, changed: true };
}
```

The export surface is the contract for plan 03-A-07 + 03-B-02. Do not export internal helpers that callers should not depend on.
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "^export " scripts/vault-flip-helpers.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "^export (function|async function|interface)" scripts/vault-flip-helpers.ts` returns ≥ 6 (the named helpers + interfaces)
    - The exports include: flipCampaignToVault, flipCampaignToBaked, enableMutationsForCampaign, disableMutationsForCampaign, flipSourceOfTruth, assembleCampaignSeedPayload
    - Imports use the same drizzle ORM patterns as scripts/vault-flip.ts (no new ORM idioms introduced)
    - The seed-payload assembly uses LEFT JOIN sessions ⨝ session_state per Phase 02 BLOCKER-1 fix
  </acceptance_criteria>
  <done>
    Helpers extracted. Task 2 collapses the CLI main() to use them.
  </done>
</task>

<task type="auto">
  <name>Task 2: Collapse scripts/vault-flip.ts main() to a thin shell over the helpers</name>
  <files>scripts/vault-flip.ts</files>
  <read_first>
    - scripts/vault-flip.ts (Task 1 extracted the inline logic; main() now needs to call helpers instead of inlining)
    - scripts/vault-flip-helpers.ts (Task 1 — the helper signatures)
  </read_first>
  <action>
Edit `scripts/vault-flip.ts`. Replace the inline implementations with calls to `vault-flip-helpers.ts`.

Specifically:
- Keep the `parseArgs` function + the listing mode (`pnpm vault:flip` with no args lists all campaigns)
- Replace the `--to=vault` branch body with `await flipCampaignToVault(args.id)`
- Replace the `--to=baked` branch body with `await flipCampaignToBaked(args.id)`
- Replace the `--enable-mutations` branch body with `await enableMutationsForCampaign(args.id)`
- Replace the `--disable-mutations` branch body with `await disableMutationsForCampaign(args.id)`
- Preserve all console.log + error-handling shapes (the operator output should be IDENTICAL to Phase 02)
- The combined `--to=vault --enable-mutations` case calls both helpers sequentially

The DECOMPOSE-CLI-FROM-LOGIC pattern matches the planning brief intent: `scripts/migrate-campaigns-to-vault.ts` (plan 03-A-07) can now import the helpers cleanly.

Also add a NEW CLI flag for Phase 03: `--source-of-truth=vault|postgres` calling `flipSourceOfTruth(args.id, args.sourceOfTruth)`. This is the Phase 03-B parallel to the Phase 02 `--to` flag (note: plan 03-B-02 also ships `scripts/vault-cutover.ts` as a higher-level operator script that wraps `flipSourceOfTruth` + an audit + rollback window check — this flag here is the LOW-LEVEL knob for power users / debugging).

Update the usage docstring at the top:
```ts
/**
 * scripts/vault-flip.ts — toggle a campaign between vault/baked backends
 * and (Phase 02) vaultMutations on/off and (Phase 03-B) sourceOfTruth.
 *
 * Phase 03 refactor: the per-campaign flip operations now live in
 * scripts/vault-flip-helpers.ts. This CLI is the operator entry point;
 * scripts/migrate-campaigns-to-vault.ts (Phase 03-A bulk) and
 * scripts/vault-cutover.ts (Phase 03-B cutover) reuse the helpers in a loop.
 *
 * Usage:
 *   pnpm vault:flip
 *   pnpm vault:flip --id=<uuid> --to=vault
 *   pnpm vault:flip --id=<uuid> --to=baked
 *   pnpm vault:flip --id=<uuid> --enable-mutations
 *   pnpm vault:flip --id=<uuid> --disable-mutations
 *   pnpm vault:flip --id=<uuid> --source-of-truth=vault     # Phase 03-B
 *   pnpm vault:flip --id=<uuid> --source-of-truth=postgres  # Phase 03-B rollback
 */
```

After the refactor, the file is ~120 LOC (vs. ~280 LOC before).
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm vault:flip 2>&1 | head -20</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `pnpm vault:flip` (no args) still prints the campaign listing (Phase 02 behavior preserved)
    - `grep -c "flipCampaignToVault\\|enableMutationsForCampaign\\|flipSourceOfTruth" scripts/vault-flip.ts` returns ≥ 3 (the helpers are called)
    - `grep -c "from '\\./vault-flip-helpers'" scripts/vault-flip.ts` returns exactly 1 (single import line)
    - The Phase 02 inline implementations are GONE — no more `db.update(campaigns).set({masterBackend...})` inside vault-flip.ts main (it lives in vault-flip-helpers.ts now)
    - The file is shorter — `wc -l scripts/vault-flip.ts` returns < 200 (vs. ~280 before)
  </acceptance_criteria>
  <done>
    CLI refactored. Phase 02 behavior preserved; Phase 03 helpers reusable.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/scripts/vault-flip-helpers.test.ts</name>
  <files>tests/scripts/vault-flip-helpers.test.ts</files>
  <read_first>
    - scripts/vault-flip-helpers.ts (Task 1)
    - tests/scripts/vault-backup.test.ts (Phase 02 — DB-gated script test pattern)
    - tests/sessions/vault-mutations-gate.test.ts (Phase 02 — DB-gated test pattern with fixture campaign + character)
  </read_first>
  <action>
Create `tests/scripts/vault-flip-helpers.test.ts`. Skip if DATABASE_URL unset. Use a throwaway campaign + character + session fixture.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('vault-flip-helpers', () => {
  let helpers: typeof import('@/../scripts/vault-flip-helpers');
  let db: typeof import('@/db/client').db;
  let campaigns: typeof import('@/db/schema').campaigns;
  let TEST_VAULT_ROOT: string;
  let TEST_CAMPAIGN_ID: string;

  beforeAll(async () => {
    TEST_VAULT_ROOT = mkdtempSync(join(tmpdir(), 'vault-flip-helpers-'));
    vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
    // Dynamic re-import so the stub takes effect
    vi.resetModules();
    helpers = await import('@/../scripts/vault-flip-helpers');
    const dbMod = await import('@/db/client');
    const schemaMod = await import('@/db/schema');
    db = dbMod.db;
    campaigns = schemaMod.campaigns;
    // Insert a fixture campaign owned by a fixture user
    // ... (the fixture helper used by Phase 02 vault-backup.test.ts is the model; reuse if present)
  });

  afterAll(async () => {
    // Clean up campaign + remove tmpdir
    try { await db.delete(campaigns).where(eq(campaigns.id, TEST_CAMPAIGN_ID)); } catch {}
    if (existsSync(TEST_VAULT_ROOT)) rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
  });

  describe('flipCampaignToVault', () => {
    it('sets settings.masterBackend = vault', async () => {
      const r = await helpers.flipCampaignToVault(TEST_CAMPAIGN_ID);
      expect(r.changed).toBe(true);
      expect(r.newBackend).toBe('vault');
      const [row] = await db.select().from(campaigns).where(eq(campaigns.id, TEST_CAMPAIGN_ID)).limit(1);
      expect(row.settings.masterBackend).toBe('vault');
    });
    it('is idempotent — second call returns changed:false', async () => {
      const r = await helpers.flipCampaignToVault(TEST_CAMPAIGN_ID);
      expect(r.changed).toBe(false);
    });
    it('throws on unknown campaignId', async () => {
      await expect(helpers.flipCampaignToVault('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    });
  });

  describe('enableMutationsForCampaign', () => {
    it('appends a campaign_initialized event to events.md', async () => {
      // Ensure campaign is on vault first
      await helpers.flipCampaignToVault(TEST_CAMPAIGN_ID);
      const r = await helpers.enableMutationsForCampaign(TEST_CAMPAIGN_ID);
      expect(r.changed).toBe(true);
      expect(r.seedEventId).toMatch(/^[0-9a-f-]{36}$/);
      // events.md exists with the seed line
      const { readFile } = await import('node:fs/promises');
      const { eventsPath } = await import('@/ai/master/vault/campaign-paths');
      const content = await readFile(eventsPath(TEST_CAMPAIGN_ID), 'utf8');
      expect(content).toMatch(/"type":"campaign_initialized"/);
    });
    it('is idempotent — second call returns changed:false and does NOT append another seed', async () => {
      const r = await helpers.enableMutationsForCampaign(TEST_CAMPAIGN_ID);
      expect(r.changed).toBe(false);
    });
  });

  describe('flipSourceOfTruth', () => {
    it('refuses to set sourceOfTruth=vault when vaultMutations=false', async () => {
      // Disable first
      await helpers.disableMutationsForCampaign(TEST_CAMPAIGN_ID);
      await expect(helpers.flipSourceOfTruth(TEST_CAMPAIGN_ID, 'vault')).rejects.toThrow(/vaultMutations/);
    });
    it('sets sourceOfTruth=vault when prerequisites met', async () => {
      await helpers.flipCampaignToVault(TEST_CAMPAIGN_ID);
      await helpers.enableMutationsForCampaign(TEST_CAMPAIGN_ID);
      const r = await helpers.flipSourceOfTruth(TEST_CAMPAIGN_ID, 'vault');
      expect(r.changed).toBe(true);
      expect(r.next).toBe('vault');
    });
    it('rollback: flips back to postgres', async () => {
      const r = await helpers.flipSourceOfTruth(TEST_CAMPAIGN_ID, 'postgres');
      expect(r.changed).toBe(true);
      expect(r.next).toBe('postgres');
    });
    it('is idempotent — repeated flip returns changed:false', async () => {
      const r = await helpers.flipSourceOfTruth(TEST_CAMPAIGN_ID, 'postgres');
      expect(r.changed).toBe(false);
    });
  });

  describe('assembleCampaignSeedPayload', () => {
    it('produces VaultSeedCharacter[] with hp_max for every character', async () => {
      const seeds = await helpers.assembleCampaignSeedPayload(TEST_CAMPAIGN_ID);
      // Depends on the fixture's character set — should be >= 1
      expect(seeds.length).toBeGreaterThanOrEqual(1);
      for (const s of seeds) {
        expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof s.name).toBe('string');
        expect(typeof s.hp_max).toBe('number');
        expect(s.hp_max).toBeGreaterThan(0);
      }
    });
    it('emits Phase 03 optional fields (xp, level) when populated', async () => {
      // Update the fixture character row to set xp + level
      // Then call assembleCampaignSeedPayload + assert fields present
      // ... (helper-specific assertions)
    });
  });
});
```

The DB fixture pattern is shared with Phase 02's vault-backup tests. Mock or insert a real test campaign + character row. The cleanup MUST remove rows in afterAll so the test isolation is preserved.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/vault-flip-helpers.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL is set (skipped otherwise)
    - The `flipCampaignToVault` idempotency case passes (re-runs return changed:false)
    - The `enableMutationsForCampaign` idempotency case passes (re-runs do NOT append another seed event)
    - The `flipSourceOfTruth` preconditions are enforced (refuses to set vault without prerequisites)
    - Fixture rows cleaned up in afterAll (no orphans in test DB)
    - Test runtime < 20s
  </acceptance_criteria>
  <done>
    Helpers tested. Plan 03-A-07 (bulk migration) consumes them cleanly.
  </done>
</task>
