import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Plan 03-B-06 / Task 2 — snapshot-reader tests.
 *
 * Coverage map (mirrors the acceptance criteria in the plan):
 *
 *   1. Returns null when events.md doesn't exist
 *   2. Returns null when events.md exists but is empty
 *   3. Returns null when character not in seed
 *   4. Translates hp_current after damage events
 *   5. Translates conditions slug array to PG condition shape
 *   6. Translates spell_slots {level: {max, used}} → {level: used}
 *   7. Translates temp_hp, exhaustion_level, hit_dice_remaining, resources_used
 *   8. Translates death_saves shape correctly
 *   9. Translates flags (omits Phase 03 inspiration — PG session_state.flags
 *      type doesn't carry it)
 *  10. UI-only fields (scene, inCombat, sceneImageData) have correct defaults
 *  11. Byte-stability: replaying twice produces equal outputs
 *  12. Every Phase 02 + Phase 03 event type exercised at least once
 *      (sweep test — feeds a stream covering all 28 event types)
 *
 * Pattern: Pure FS test (no DATABASE_URL needed). Each test re-imports the
 * vault modules AFTER `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', tmpDir)` because
 * VAULT_CAMPAIGNS_ROOT is read at module-load via `./path`. Same idiom as
 * projector.test.ts.
 *
 * Seed strategy: we write events.md DIRECTLY (no dispatchVaultTool) — this
 * test exercises the READER, not the writer. JSON-line envelopes are
 * constructed via `makeEnvelope` and concatenated. Strictly equivalent to
 * what the writer would emit; lets us avoid spinning up the full dispatch
 * pipeline (database-free test surface).
 */

// Fixed UUIDs for deterministic on-disk paths. Different from projector.test.ts
// so a parallel test run doesn't accidentally cross-pollute tmpdirs (each
// `mkdtempSync` is unique per call, but UUIDs are also distinct for clarity).
const CAMPAIGN_UUID = '11111111-1111-1111-1111-111111111111';
const CHAR_UUID = '22222222-2222-2222-2222-222222222222';
const OTHER_CHAR_UUID = '99999999-9999-9999-9999-999999999999';
const SESSION_UUID = '33333333-3333-3333-3333-333333333333';

type SnapshotReaderModule = typeof import('@/ai/master/vault/snapshot-reader');
type CampaignPathsModule = typeof import('@/ai/master/vault/campaign-paths');

async function importWithRoot(root: string): Promise<{
  reader: SnapshotReaderModule;
  paths: CampaignPathsModule;
}> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  const [reader, paths] = await Promise.all([
    import('@/ai/master/vault/snapshot-reader'),
    import('@/ai/master/vault/campaign-paths'),
  ]);
  return { reader, paths };
}

/**
 * Build a JSON-line envelope matching VaultEventEnvelope shape. The
 * snapshot-reader doesn't validate the envelope (the projector's
 * parseEventsFile only does JSON.parse), so an unvalidated envelope is the
 * cheapest seed. Production code goes through validateEvent at the
 * dispatcher boundary, not here.
 */
function makeEnvelope<T extends Record<string, unknown>>(
  type: string,
  payload: T,
  id: string,
  timestamp: string,
): {
  id: string;
  version: 1;
  type: string;
  payload: T;
  timestamp: string;
} {
  return { id, version: 1, type, payload, timestamp };
}

/**
 * Write a sequence of envelopes to events.md under campaignDir(campaignId).
 * Creates the campaign directory if missing. Each envelope occupies one
 * JSONL line, terminated by `\n`.
 */
function writeEvents(
  paths: CampaignPathsModule,
  campaignId: string,
  envelopes: ReturnType<typeof makeEnvelope>[],
): void {
  const dir = paths.campaignDir(campaignId);
  mkdirSync(dir, { recursive: true });
  const eventsFile = paths.eventsPath(campaignId);
  const body = envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(eventsFile, body, 'utf8');
}

/**
 * Standard seed envelope for `CHAR_UUID` named Aragorn. Overridable for
 * Phase 03 field coverage. Returns the envelope object — caller passes it
 * to `writeEvents` along with whatever mutation events follow.
 */
function seedEnvelope(
  overrides: Partial<{
    hp_max: number;
    hp_current: number;
    spell_slots: Record<string, { max: number; used: number }>;
    hit_dice_max: number;
    hit_dice_remaining: number;
    name: string;
  }> = {},
): ReturnType<typeof makeEnvelope> {
  return makeEnvelope(
    'campaign_initialized',
    {
      characters: [
        {
          id: CHAR_UUID,
          name: overrides.name ?? 'Aragorn',
          hp_max: overrides.hp_max ?? 30,
          ...(overrides.hp_current !== undefined ? { hp_current: overrides.hp_current } : {}),
          ...(overrides.spell_slots !== undefined ? { spell_slots: overrides.spell_slots } : {}),
          ...(overrides.hit_dice_max !== undefined ? { hit_dice_max: overrides.hit_dice_max } : {}),
          ...(overrides.hit_dice_remaining !== undefined
            ? { hit_dice_remaining: overrides.hit_dice_remaining }
            : {}),
        },
      ],
    },
    'seed-1',
    '2026-05-25T10:00:00.000Z',
  );
}

describe('snapshot-reader / materializeFromVault', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gsd-snapshot-reader-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Null-return cases (must_haves.truths #2)
  // ---------------------------------------------------------------------------

  describe('null-return cases', () => {
    it('returns null when events.md does not exist', async () => {
      const { reader } = await importWithRoot(testRoot);
      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r).toBeNull();
    });

    it('returns null when events.md exists but is empty', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      // Write empty events.md (campaign dir exists but no seed yet).
      const dir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(dir, { recursive: true });
      writeFileSync(paths.eventsPath(CAMPAIGN_UUID), '', 'utf8');

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r).toBeNull();
    });

    it('returns null when character is not in seed', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      // Seed names OTHER_CHAR_UUID, not CHAR_UUID.
      writeEvents(paths, CAMPAIGN_UUID, [
        makeEnvelope(
          'campaign_initialized',
          {
            characters: [
              { id: OTHER_CHAR_UUID, name: 'Gandalf', hp_max: 25 },
            ],
          },
          'seed-other',
          '2026-05-25T10:00:00.000Z',
        ),
      ]);

      // Materialize for CHAR_UUID — should not be in the state map.
      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Field-by-field translation tests (must_haves.truths #3)
  // ---------------------------------------------------------------------------

  describe('vault-tracked field translation', () => {
    it('echoes sessionId from the argument', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [seedEnvelope({ hp_current: 30 })]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r).not.toBeNull();
      expect(r!.state.sessionId).toBe(SESSION_UUID);
    });

    it('translates hp_current after damage events', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30, hp_current: 30 }),
        makeEnvelope(
          'hp_change',
          { character: CHAR_UUID, delta: -5 },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.hpCurrent).toBe(25);
    });

    it('translates conditions slug array to PG condition shape', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'condition_add',
          { character: CHAR_UUID, condition: 'blinded' },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'condition_add',
          { character: CHAR_UUID, condition: 'prone' },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      // Reducer sorts conditions alphabetically (DR byte-stability).
      expect(r!.state.conditions).toHaveLength(2);
      expect(r!.state.conditions![0]).toEqual({
        slug: 'blinded',
        source: 'vault-replay',
        durationRounds: 'until_removed',
        appliedRound: 0,
      });
      expect(r!.state.conditions![1]).toEqual({
        slug: 'prone',
        source: 'vault-replay',
        durationRounds: 'until_removed',
        appliedRound: 0,
      });
    });

    it('extracts spell_slots used counts (drops the max half)', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({
          hp_max: 30,
          spell_slots: {
            '1': { max: 3, used: 0 },
            '2': { max: 1, used: 0 },
          },
        }),
        makeEnvelope(
          'spell_slot_use',
          { character: CHAR_UUID, level: 1 },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'spell_slot_use',
          { character: CHAR_UUID, level: 1 },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.spellSlotsUsed).toEqual({ '1': 2, '2': 0 });
    });

    it('translates temp_hp via temp_hp_set event', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'temp_hp_set',
          { character: CHAR_UUID, tempHp: 8 },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.tempHp).toBe(8);
    });

    it('translates exhaustion_level via exhaustion_increment events', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'exhaustion_increment',
          { character: CHAR_UUID, source: 'forced-march' },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'exhaustion_increment',
          { character: CHAR_UUID, source: 'starvation' },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.exhaustionLevel).toBe(2);
      // exhaustion_increment also appends 'exhaustion' to conditions.
      expect(r!.state.conditions!.some((c) => c.slug === 'exhaustion')).toBe(true);
    });

    it('translates hit_dice_remaining via hit_dice_use events', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({
          hp_max: 30,
          hit_dice_max: 5,
          hit_dice_remaining: 5,
        }),
        makeEnvelope(
          'hit_dice_use',
          { character: CHAR_UUID, count: 2 },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.hitDiceRemaining).toBe(3);
    });

    it('translates resources_used via resource_use events', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'resource_use',
          { character: CHAR_UUID, resourceKey: 'rage', uses: 1 },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'resource_use',
          { character: CHAR_UUID, resourceKey: 'rage', uses: 1 },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
        makeEnvelope(
          'resource_use',
          { character: CHAR_UUID, resourceKey: 'action_surge', uses: 1 },
          'mut-3',
          '2026-05-25T10:03:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.resourcesUsed).toEqual({ rage: 2, action_surge: 1 });
    });

    it('translates death_saves correctly after death_save_fail events', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'death_save_fail',
          { character: CHAR_UUID },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'death_save_fail',
          { character: CHAR_UUID },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.deathSaves).toEqual({ successes: 0, failures: 2 });
    });

    it('translates death_saves successes via death_save_success', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'death_save_success',
          { character: CHAR_UUID },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.deathSaves).toEqual({ successes: 1, failures: 0 });
    });

    it('translates flags.stable after death_save_stabilize', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'death_save_stabilize',
          { character: CHAR_UUID },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.flags).toEqual({ stable: true, dead: false });
    });

    it('omits inspiration from flags even though vault tracks it', async () => {
      // The vault carries `flags.inspiration` (via inspiration_grant/spend
      // events), but Postgres' session_state.flags type is `{stable?, dead?}`
      // ONLY. The translator drops `inspiration` to match the column type.
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'inspiration_grant',
          { character: CHAR_UUID },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      // Type-narrowing: r!.state.flags is the SessionState column type which
      // only declares stable/dead. The TypeScript surface won't even allow
      // `r!.state.flags.inspiration` at the call site; we assert by reading the
      // raw object's enumerable own keys.
      const flagKeys = Object.keys(r!.state.flags ?? {}).sort();
      expect(flagKeys).toEqual(['dead', 'stable']);
    });

    it('translates concentratingOn via concentration_set event', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'concentration_set',
          {
            character: CHAR_UUID,
            spellSlug: 'bless',
            slotLevel: 1,
            startedRound: 2,
          },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.concentratingOn).toEqual({
        spellSlug: 'bless',
        slotLevel: 1,
        startedRound: 2,
      });
    });

    it('clears concentratingOn after concentration_break', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({ hp_max: 30 }),
        makeEnvelope(
          'concentration_set',
          {
            character: CHAR_UUID,
            spellSlug: 'bless',
            slotLevel: 1,
            startedRound: 2,
          },
          'mut-1',
          '2026-05-25T10:01:00.000Z',
        ),
        makeEnvelope(
          'concentration_break',
          { character: CHAR_UUID, reason: 'damage' },
          'mut-2',
          '2026-05-25T10:02:00.000Z',
        ),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.concentratingOn).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // UI-only fields — empty defaults (must_haves.truths #3 — completeness)
  // ---------------------------------------------------------------------------

  describe('UI-only fields have correct defaults', () => {
    it('every UI/scene-state field matches the Postgres column default', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      writeEvents(paths, CAMPAIGN_UUID, [seedEnvelope({ hp_max: 30 })]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r!.state.turnState).toBeNull();
      expect(r!.state.position).toBeNull();
      expect(r!.state.inCombat).toBe(false);
      expect(r!.state.combat).toBeNull();
      expect(r!.state.scene).toBe('');
      expect(r!.state.inventoryDelta).toEqual([]);
      expect(r!.state.statusFlag).toBeNull();
      expect(r!.state.sceneImageData).toBeNull();
      expect(r!.state.sceneImagePrompt).toBeNull();
      expect(r!.state.sceneImageVersion).toBe(0);
      expect(r!.state.sceneImagePending).toBe(false);
      expect(r!.state.sceneImagePendingAt).toBeNull();
      expect(r!.state.sceneImageFailedReason).toBeNull();
      expect(r!.state.lastLongRestAt).toBeNull();
      expect(r!.state.travel).toBeNull();
      expect(r!.state.summaryBlock).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Byte-stability (must_haves.truths #4)
  // ---------------------------------------------------------------------------

  describe('byte-stability (deterministic same-input → same-output)', () => {
    it('two replays of the same events.md produce equal SessionState shapes', async () => {
      const { reader, paths } = await importWithRoot(testRoot);
      // A non-trivial mixed event stream — exercises 10 different event
      // types so the byte-stability check is meaningful (not just a seed).
      writeEvents(paths, CAMPAIGN_UUID, [
        seedEnvelope({
          hp_max: 30,
          hp_current: 30,
          spell_slots: { '1': { max: 3, used: 0 }, '2': { max: 1, used: 0 } },
          hit_dice_max: 5,
          hit_dice_remaining: 5,
        }),
        makeEnvelope('hp_change', { character: CHAR_UUID, delta: -5 }, 'm1', '2026-05-25T10:01:00.000Z'),
        makeEnvelope('condition_add', { character: CHAR_UUID, condition: 'poisoned' }, 'm2', '2026-05-25T10:02:00.000Z'),
        makeEnvelope('spell_slot_use', { character: CHAR_UUID, level: 1 }, 'm3', '2026-05-25T10:03:00.000Z'),
        makeEnvelope('temp_hp_set', { character: CHAR_UUID, tempHp: 5 }, 'm4', '2026-05-25T10:04:00.000Z'),
        makeEnvelope('death_save_fail', { character: CHAR_UUID }, 'm5', '2026-05-25T10:05:00.000Z'),
        makeEnvelope('exhaustion_increment', { character: CHAR_UUID, source: 'march' }, 'm6', '2026-05-25T10:06:00.000Z'),
        makeEnvelope('resource_use', { character: CHAR_UUID, resourceKey: 'rage', uses: 1 }, 'm7', '2026-05-25T10:07:00.000Z'),
        makeEnvelope('hit_dice_use', { character: CHAR_UUID, count: 1 }, 'm8', '2026-05-25T10:08:00.000Z'),
        makeEnvelope(
          'concentration_set',
          { character: CHAR_UUID, spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
          'm9',
          '2026-05-25T10:09:00.000Z',
        ),
      ]);

      const r1 = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      const r2 = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r1).toEqual(r2);
    });
  });

  // ---------------------------------------------------------------------------
  // Full event-type sweep (must_haves.truths #1 — every type touched)
  //
  // The plan requires "every Phase 02 + Phase 03 event type exercised at
  // least once". We feed a stream covering all 28 mutation event types (+
  // the seed) and assert the resulting snapshot reflects the cumulative
  // effect — proves the translator never barfs on any event type the
  // projector can produce.
  // ---------------------------------------------------------------------------

  describe('exercises every event type at least once', () => {
    it('all 28 event types produce a translated SessionState without throwing', async () => {
      const { reader, paths } = await importWithRoot(testRoot);

      // Build a stream that triggers every reducer arm. Order matters
      // (death_save_success needs the PC to be at 0 HP semantically, but
      // the projector's reducer doesn't enforce HP precondition — the
      // applicator does at the dispatcher layer; here we test the reducer's
      // state machine directly).
      let seq = 0;
      const ts = () => `2026-05-25T10:${String(seq).padStart(2, '0')}:00.000Z`;
      const env = <T extends Record<string, unknown>>(
        type: string,
        payload: T,
      ): ReturnType<typeof makeEnvelope> => makeEnvelope(type, payload, `m-${seq}`, ts());

      writeEvents(paths, CAMPAIGN_UUID, [
        // 0. seed (campaign_initialized)
        seedEnvelope({
          hp_max: 40,
          hp_current: 40,
          spell_slots: { '1': { max: 4, used: 0 }, '2': { max: 2, used: 0 } },
          hit_dice_max: 10,
          hit_dice_remaining: 10,
        }),
        // Phase 02 mutations (7 types)
        ((seq = 1), env('hp_change', { character: CHAR_UUID, delta: -10 })),
        ((seq = 2), env('condition_add', { character: CHAR_UUID, condition: 'frightened' })),
        ((seq = 3), env('condition_remove', { character: CHAR_UUID, condition: 'frightened' })),
        ((seq = 4), env('spell_slot_use', { character: CHAR_UUID, level: 1 })),
        ((seq = 5), env('spell_slot_restore', { character: CHAR_UUID, level: 1 })),
        ((seq = 6), env('inventory_add', { character: CHAR_UUID, item: 'rope', qty: 1 })),
        ((seq = 7), env('inventory_remove', { character: CHAR_UUID, item: 'rope', qty: 1 })),
        // Phase 03 mutations (20 types)
        ((seq = 8), env('temp_hp_set', { character: CHAR_UUID, tempHp: 3 })),
        ((seq = 9), env('death_save_success', { character: CHAR_UUID })),
        ((seq = 10), env('death_save_fail', { character: CHAR_UUID })),
        ((seq = 11), env('death_save_stabilize', { character: CHAR_UUID })),
        ((seq = 12), env('death_save_recover_at_one', { character: CHAR_UUID })),
        (
          (seq = 13),
          env('concentration_set', {
            character: CHAR_UUID,
            spellSlug: 'bless',
            slotLevel: 1,
            startedRound: 1,
          })
        ),
        ((seq = 14), env('concentration_break', { character: CHAR_UUID, reason: 'damage' })),
        ((seq = 15), env('exhaustion_increment', { character: CHAR_UUID, source: 'march' })),
        ((seq = 16), env('exhaustion_decrement', { character: CHAR_UUID })),
        ((seq = 17), env('hit_dice_use', { character: CHAR_UUID, count: 1 })),
        ((seq = 18), env('hit_dice_restore', { character: CHAR_UUID, count: 1 })),
        ((seq = 19), env('resource_use', { character: CHAR_UUID, resourceKey: 'rage', uses: 1 })),
        ((seq = 20), env('resource_restore', { character: CHAR_UUID, resourceKey: 'rage', uses: 1 })),
        ((seq = 21), env('inspiration_grant', { character: CHAR_UUID })),
        ((seq = 22), env('inspiration_spend', { character: CHAR_UUID })),
        ((seq = 23), env('attune', { character: CHAR_UUID, itemSlug: 'amulet-of-health' })),
        ((seq = 24), env('unattune', { character: CHAR_UUID, itemSlug: 'amulet-of-health' })),
        (
          (seq = 25),
          env('focus_set', {
            character: CHAR_UUID,
            kind: 'arcane',
            itemSlug: 'staff-of-power',
          })
        ),
        ((seq = 26), env('focus_unset', { character: CHAR_UUID })),
        ((seq = 27), env('xp_award', { character: CHAR_UUID, amount: 500, reason: 'quest' })),
      ]);

      const r = await reader.materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
      expect(r).not.toBeNull();

      // Sanity asserts on the cumulative state. The exact final values
      // depend on reducer semantics tested elsewhere (projector.test.ts);
      // this test proves the translator never threw and produced a complete
      // SessionState shape.
      expect(r!.state.hpCurrent).toBeGreaterThanOrEqual(0);
      expect(r!.state.tempHp).toBe(3);
      // death_save_recover_at_one resets death_saves to {0,0} (the final
      // state-machine reset event in our sequence).
      expect(r!.state.deathSaves).toEqual({ successes: 0, failures: 0 });
      // exhaustion_increment then exhaustion_decrement → back to 0.
      expect(r!.state.exhaustionLevel).toBe(0);
      // hit_dice_use then hit_dice_restore → back to 10.
      expect(r!.state.hitDiceRemaining).toBe(10);
      // resource_use then resource_restore → key cleared.
      expect(r!.state.resourcesUsed).toEqual({});
      // concentration_set then concentration_break → null.
      expect(r!.state.concentratingOn).toBeNull();
      // spell_slot_use then spell_slot_restore → back to 0.
      expect(r!.state.spellSlotsUsed).toEqual({ '1': 0, '2': 0 });
      // inspiration_grant then inspiration_spend → flags.stable unchanged
      // by these events. The session_state.flags type is `{stable?, dead?}`
      // so `inspiration` is dropped by the translator regardless.
      expect(Object.keys(r!.state.flags ?? {}).sort()).toEqual(['dead', 'stable']);
      // focus_set then focus_unset → equipped_focus is vault-only (not
      // mapped to session_state); the translator just doesn't emit it.
      // attune then unattune → attunements is vault-only too.
      // xp_award → xp is vault-only.
      // All the above prove the translator silently skips vault-only
      // fields (no SessionState column) without throwing.
    });
  });

  // ---------------------------------------------------------------------------
  // REQ-022 purity sanity check — no env reads at module load
  //
  // The snapshot-reader file itself MUST NOT contain `process.env` references.
  // (Transitive consumption via campaign-paths → path.ts is acceptable; that
  // boundary is already audited by Phase 01 tests.)
  // ---------------------------------------------------------------------------

  describe('REQ-022 purity', () => {
    it('snapshot-reader.ts does not reference process.env at any layer', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(
        new URL('../../../../src/ai/master/vault/snapshot-reader.ts', import.meta.url),
        'utf8',
      );
      // Strip comments (single-line // and multi-line /* */) before
      // checking — the JSDoc may mention "env reads" in prose.
      const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(codeOnly).not.toContain('process.env');
    });
  });
});
