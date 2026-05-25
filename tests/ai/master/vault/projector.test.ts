import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Plan 02-04 / Task 2 — projector tests.
 *
 * Coverage map (mirrors the acceptance criteria in the plan):
 *
 *   1. INITIAL_CHARACTER_STATE — Postgres-reality fallbacks (5 cases)
 *   2. applyEvent — pure reducer per event type (16+ cases across event types)
 *   3. applyEvent — purity (3 cases: no mutation, identity, no forbidden patterns)
 *   4. replayEvents — determinism + Postgres-reality seed shapes (7 cases)
 *   5. parseEventsFile — fail-fast on corruption (spike 008) (4 cases)
 *   6. regenerateCharacterView — disk roundtrip (3 cases)
 *   7. serializeView + parseView round trip (4 cases)
 *   8. regenerateAffectedViews — dispatcher hook (2 cases)
 *   9. graceful degradation on unknown event types (Pitfall 6) (1 case)
 *
 * No DATABASE_URL required: the projector pulls from `events-schema` (pure)
 * and `campaign-paths` (pure; consumes `VAULT_CAMPAIGNS_ROOT` at module
 * load). We stub the env via `vi.stubEnv` + `vi.resetModules()` and
 * dynamic `import()` to re-read the env at module-load time.
 */

// Fixed UUIDs for deterministic on-disk paths. The first 8 chars become
// the `id8` suffix in `characters/<slug>-<id8>.md` (Decision 10).
const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const CHAR_A_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHAR_B_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const CHAR_C_UUID = 'cccccccc-dddd-eeee-ffff-000000000000';

type ProjectorModule = typeof import('@/ai/master/vault/projector');
type EventsSchemaModule = typeof import('@/ai/master/vault/events-schema');
type CampaignPathsModule = typeof import('@/ai/master/vault/campaign-paths');

async function importWithRoot(root: string): Promise<{
  projector: ProjectorModule;
  events: EventsSchemaModule;
  paths: CampaignPathsModule;
}> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  const [projector, events, paths] = await Promise.all([
    import('@/ai/master/vault/projector'),
    import('@/ai/master/vault/events-schema'),
    import('@/ai/master/vault/campaign-paths'),
  ]);
  return { projector, events, paths };
}

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

describe('projector', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gsd-projector-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. INITIAL_CHARACTER_STATE — Postgres-reality fallbacks
  // -------------------------------------------------------------------------

  describe('INITIAL_CHARACTER_STATE — Postgres-reality fallbacks', () => {
    it('uses hp_max when hp_current absent', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      expect(state.hp_current).toBe(30);
      expect(state.hp_max).toBe(30);
    });

    it('uses provided hp_current when present', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
        hp_current: 12,
      });
      expect(state.hp_current).toBe(12);
      expect(state.hp_max).toBe(30);
    });

    it('uses empty record when spell_slots absent', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      expect(state.spell_slots).toEqual({});
    });

    it('uses provided spell_slots when present', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Gandalf',
        hp_max: 30,
        spell_slots: { '1': { max: 4, used: 2 }, '2': { max: 3, used: 0 } },
      });
      expect(state.spell_slots).toEqual({
        '1': { max: 4, used: 2 },
        '2': { max: 3, used: 0 },
      });
    });

    it('produces conditions: [] and inventory: [] by default', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      expect(state.conditions).toEqual([]);
      expect(state.inventory).toEqual([]);
    });

    it('preserves id and name verbatim', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Élise the Brave',
        hp_max: 25,
      });
      expect(state.id).toBe(CHAR_A_UUID);
      expect(state.name).toBe('Élise the Brave');
    });
  });

  // -------------------------------------------------------------------------
  // 2. applyEvent — pure reducer per event type
  // -------------------------------------------------------------------------

  describe('applyEvent — pure reducer per event type', () => {
    async function freshState(overrides: Partial<{
      hp_current: number;
      hp_max: number;
      conditions: string[];
      spell_slots: Record<string, { max: number; used: number }>;
      inventory: { item: string; qty: number }[];
    }> = {}): Promise<import('@/ai/master/vault/projector').CharacterState> {
      const { projector } = await importWithRoot(testRoot);
      return {
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_current: overrides.hp_current ?? 20,
        hp_max: overrides.hp_max ?? 30,
        conditions: overrides.conditions ?? [],
        spell_slots: overrides.spell_slots ?? { '1': { max: 4, used: 0 }, '2': { max: 2, used: 0 } },
        inventory: overrides.inventory ?? [],
        ...({} as Record<string, never>),
      } as Awaited<ReturnType<typeof projector.INITIAL_CHARACTER_STATE>>;
    }

    it('hp_change positive delta: hp_current goes up, clamped at hp_max', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ hp_current: 25, hp_max: 30 });
      const result = projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: 10 },
      });
      // Clamped at hp_max (25 + 10 = 35 → 30).
      expect(result.hp_current).toBe(30);
    });

    it('hp_change negative delta: hp_current goes down, clamped at 0', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ hp_current: 5, hp_max: 30 });
      const result = projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: -100 },
      });
      expect(result.hp_current).toBe(0);
    });

    it('hp_change zero delta: no-op', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ hp_current: 15, hp_max: 30 });
      const result = projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: 0 },
      });
      expect(result.hp_current).toBe(15);
    });

    it('hp_change normal delta within range', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ hp_current: 20, hp_max: 30 });
      const result = projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: -5 },
      });
      expect(result.hp_current).toBe(15);
    });

    it('condition_add new: condition appears in sorted array', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ conditions: ['poisoned'] });
      const result = projector.applyEvent(state, {
        type: 'condition_add',
        payload: { character: CHAR_A_UUID, condition: 'blinded' },
      });
      // Sorted alphabetically (deterministic ordering for byte-stable view).
      expect(result.conditions).toEqual(['blinded', 'poisoned']);
    });

    it('condition_add duplicate: no double entry', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ conditions: ['poisoned'] });
      const result = projector.applyEvent(state, {
        type: 'condition_add',
        payload: { character: CHAR_A_UUID, condition: 'poisoned' },
      });
      expect(result.conditions).toEqual(['poisoned']);
    });

    it('condition_remove existing: condition removed', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ conditions: ['blinded', 'poisoned'] });
      const result = projector.applyEvent(state, {
        type: 'condition_remove',
        payload: { character: CHAR_A_UUID, condition: 'poisoned' },
      });
      expect(result.conditions).toEqual(['blinded']);
    });

    it('condition_remove non-existent: no-op', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ conditions: ['blinded'] });
      const result = projector.applyEvent(state, {
        type: 'condition_remove',
        payload: { character: CHAR_A_UUID, condition: 'stunned' },
      });
      expect(result.conditions).toEqual(['blinded']);
    });

    it('spell_slot_use: slot.used += 1', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({
        spell_slots: { '1': { max: 4, used: 1 } },
      });
      const result = projector.applyEvent(state, {
        type: 'spell_slot_use',
        payload: { character: CHAR_A_UUID, level: 1 },
      });
      expect(result.spell_slots['1']).toEqual({ max: 4, used: 2 });
    });

    it('spell_slot_use at max: no-op (used does not exceed max)', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({
        spell_slots: { '1': { max: 4, used: 4 } },
      });
      const result = projector.applyEvent(state, {
        type: 'spell_slot_use',
        payload: { character: CHAR_A_UUID, level: 1 },
      });
      expect(result.spell_slots['1']).toEqual({ max: 4, used: 4 });
    });

    it('spell_slot_use on missing slot key: no-op (graceful)', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({
        spell_slots: { '1': { max: 4, used: 0 } },
      });
      const result = projector.applyEvent(state, {
        type: 'spell_slot_use',
        payload: { character: CHAR_A_UUID, level: 5 },
      });
      // Level 5 never existed; no record gets created.
      expect(result.spell_slots).toEqual({ '1': { max: 4, used: 0 } });
    });

    it('spell_slot_restore: slot.used -= 1', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({
        spell_slots: { '1': { max: 4, used: 2 } },
      });
      const result = projector.applyEvent(state, {
        type: 'spell_slot_restore',
        payload: { character: CHAR_A_UUID, level: 1 },
      });
      expect(result.spell_slots['1']).toEqual({ max: 4, used: 1 });
    });

    it('spell_slot_restore at 0: no-op', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({
        spell_slots: { '1': { max: 4, used: 0 } },
      });
      const result = projector.applyEvent(state, {
        type: 'spell_slot_restore',
        payload: { character: CHAR_A_UUID, level: 1 },
      });
      expect(result.spell_slots['1']).toEqual({ max: 4, used: 0 });
    });

    it('inventory_add new item: appears with qty', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [] });
      const result = projector.applyEvent(state, {
        type: 'inventory_add',
        payload: { character: CHAR_A_UUID, item: 'rope', qty: 1 },
      });
      expect(result.inventory).toEqual([{ item: 'rope', qty: 1 }]);
    });

    it('inventory_add existing item: qty aggregates', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'torch', qty: 2 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_add',
        payload: { character: CHAR_A_UUID, item: 'torch', qty: 3 },
      });
      expect(result.inventory).toEqual([{ item: 'torch', qty: 5 }]);
    });

    it('inventory_add sorts the array alphabetically (deterministic order)', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'torch', qty: 2 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_add',
        payload: { character: CHAR_A_UUID, item: 'rope', qty: 1 },
      });
      expect(result.inventory).toEqual([
        { item: 'rope', qty: 1 },
        { item: 'torch', qty: 2 },
      ]);
    });

    it('inventory_remove partial: qty decreases', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'arrow', qty: 10 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_remove',
        payload: { character: CHAR_A_UUID, item: 'arrow', qty: 4 },
      });
      expect(result.inventory).toEqual([{ item: 'arrow', qty: 6 }]);
    });

    it('inventory_remove full: item disappears from inventory', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'torch', qty: 3 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_remove',
        payload: { character: CHAR_A_UUID, item: 'torch', qty: 3 },
      });
      expect(result.inventory).toEqual([]);
    });

    it('inventory_remove non-existent: no-op', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'torch', qty: 3 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_remove',
        payload: { character: CHAR_A_UUID, item: 'gold', qty: 100 },
      });
      expect(result.inventory).toEqual([{ item: 'torch', qty: 3 }]);
    });

    it('inventory_remove with qty larger than stored qty: clamps to 0 (item removed)', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = await freshState({ inventory: [{ item: 'gold', qty: 5 }] });
      const result = projector.applyEvent(state, {
        type: 'inventory_remove',
        payload: { character: CHAR_A_UUID, item: 'gold', qty: 100 },
      });
      // qty bottoms out at 0, then the entry is spliced out.
      expect(result.inventory).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. applyEvent — purity
  // -------------------------------------------------------------------------

  describe('applyEvent — purity', () => {
    it('does not mutate input state', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const snapshot = JSON.parse(JSON.stringify(state)) as unknown;
      projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: -5 },
      });
      // Original state untouched (structuredClone invariant).
      expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot);
    });

    it('returns deeply equal output for deeply equal input', async () => {
      const { projector } = await importWithRoot(testRoot);
      const stateA = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const stateB = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const eventA = {
        type: 'hp_change' as const,
        payload: { character: CHAR_A_UUID, delta: -7 },
      };
      const eventB = {
        type: 'hp_change' as const,
        payload: { character: CHAR_A_UUID, delta: -7 },
      };
      const r1 = projector.applyEvent(stateA, eventA);
      const r2 = projector.applyEvent(stateB, eventB);
      expect(r1).toEqual(r2);
    });

    it('source contains no Date.now / Math.random / process.env references', () => {
      // Static check on the source file: the reducer MUST be deterministic.
      // Match the grep gate from plan 02-04 Task 1 acceptance criteria.
      const src = readFileSync(
        join(process.cwd(), 'src/ai/master/vault/projector.ts'),
        'utf8',
      );
      // Constructed at runtime so the regex string itself doesn't appear
      // as a literal in the test source (avoids self-match if a future
      // tool scans this test file).
      const forbidden = ['Date' + '.now\\(', 'Math' + '.random\\(', 'process' + '\\.env\\.'];
      const violations = forbidden.filter((p) => new RegExp(p).test(src));
      expect(violations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. replayEvents — determinism + Postgres-reality seed shapes
  // -------------------------------------------------------------------------

  describe('replayEvents — determinism + Postgres-reality seed shapes', () => {
    /**
     * Tiny linear-congruential RNG so the "100 random events" case is
     * fully deterministic — same seed always produces same event list.
     */
    function lcg(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
      };
    }

    function buildEnvelopes(
      events: EventsSchemaModule,
    ): {
      seedEnv: ReturnType<typeof makeEnvelope>;
      mutEnvs: ReturnType<typeof makeEnvelope>[];
    } {
      // unused parameter retained for symmetry; suppress lint
      void events;
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        {
          characters: [
            { id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30 },
            { id: CHAR_B_UUID, name: 'Gandalf', hp_max: 25, spell_slots: { '1': { max: 4, used: 0 } } },
          ],
        },
        'seed-id',
        '2026-05-25T10:00:00.000Z',
      );

      const rand = lcg(42);
      const conditions = ['poisoned', 'blinded', 'stunned', 'frightened', 'prone'];
      const items = ['rope', 'torch', 'gold', 'arrow'];
      const mutEnvs: ReturnType<typeof makeEnvelope>[] = [];
      for (let i = 0; i < 100; i++) {
        const target = rand() < 0.5 ? CHAR_A_UUID : CHAR_B_UUID;
        const r = rand();
        const ts = `2026-05-25T10:00:${String(i).padStart(2, '0')}.000Z`;
        const id = `mut-${i}`;
        if (r < 0.3) {
          mutEnvs.push(
            makeEnvelope(
              'hp_change',
              { character: target, delta: Math.floor(rand() * 20) - 10 },
              id,
              ts,
            ),
          );
        } else if (r < 0.5) {
          mutEnvs.push(
            makeEnvelope(
              'condition_add',
              { character: target, condition: conditions[Math.floor(rand() * conditions.length)]! },
              id,
              ts,
            ),
          );
        } else if (r < 0.7) {
          mutEnvs.push(
            makeEnvelope(
              'condition_remove',
              { character: target, condition: conditions[Math.floor(rand() * conditions.length)]! },
              id,
              ts,
            ),
          );
        } else if (r < 0.85) {
          mutEnvs.push(
            makeEnvelope(
              'inventory_add',
              {
                character: target,
                item: items[Math.floor(rand() * items.length)]!,
                qty: 1 + Math.floor(rand() * 5),
              },
              id,
              ts,
            ),
          );
        } else {
          mutEnvs.push(
            makeEnvelope(
              'inventory_remove',
              {
                character: target,
                item: items[Math.floor(rand() * items.length)]!,
                qty: 1 + Math.floor(rand() * 3),
              },
              id,
              ts,
            ),
          );
        }
      }
      return { seedEnv, mutEnvs };
    }

    it('reproduces exact final state across multiple replays (N=100)', async () => {
      const { projector, events } = await importWithRoot(testRoot);
      const { seedEnv, mutEnvs } = buildEnvelopes(events);
      const all = [seedEnv, ...mutEnvs];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result1 = projector.replayEvents(all as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result2 = projector.replayEvents(all as any);

      // Two replays of the same event list MUST produce deeply equal Maps.
      const obj1: Record<string, unknown> = {};
      const obj2: Record<string, unknown> = {};
      for (const [k, v] of result1) obj1[k] = v;
      for (const [k, v] of result2) obj2[k] = v;
      expect(obj1).toEqual(obj2);
    });

    it('order matters — same events in different order produce different states', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const heal = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: 5 },
        'heal',
        '2026-05-25T10:01:00.000Z',
      );
      const damage = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -10 },
        'dmg',
        '2026-05-25T10:02:00.000Z',
      );

      // Order A: heal then damage. Start at 30, heal clamped at 30, then -10 → 20.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r1 = projector.replayEvents([seedEnv, heal, damage] as any);
      // Order B: damage then heal. Start at 30, damage → 20, heal → 25.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r2 = projector.replayEvents([seedEnv, damage, heal] as any);

      expect(r1.get(CHAR_A_UUID)!.hp_current).toBe(20);
      expect(r2.get(CHAR_A_UUID)!.hp_current).toBe(25);
    });

    it('processes campaign_initialized as the first event correctly', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        {
          characters: [
            { id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30 },
            { id: CHAR_B_UUID, name: 'Gandalf', hp_max: 25 },
          ],
        },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const dmgA = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -3 },
        'mut1',
        '2026-05-25T10:01:00.000Z',
      );
      const dmgB = makeEnvelope(
        'hp_change',
        { character: CHAR_B_UUID, delta: -7 },
        'mut2',
        '2026-05-25T10:02:00.000Z',
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([seedEnv, dmgA, dmgB] as any);
      expect(states.get(CHAR_A_UUID)!.hp_current).toBe(27);
      expect(states.get(CHAR_B_UUID)!.hp_current).toBe(18);
    });

    it('campaign_initialized with hp_current absent → state.hp_current === hp_max', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 20 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([seedEnv] as any);
      expect(states.get(CHAR_A_UUID)!.hp_current).toBe(20);
    });

    it('campaign_initialized with hp_current present → state.hp_current === seed value', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 20, hp_current: 7 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([seedEnv] as any);
      expect(states.get(CHAR_A_UUID)!.hp_current).toBe(7);
    });

    it('campaign_initialized with spell_slots absent → state.spell_slots === {}', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 20 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([seedEnv] as any);
      expect(states.get(CHAR_A_UUID)!.spell_slots).toEqual({});
    });

    it('logs and skips events for unseeded characters', async () => {
      const { projector } = await importWithRoot(testRoot);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const orphan = makeEnvelope(
        'hp_change',
        { character: CHAR_C_UUID, delta: -5 },
        'orphan',
        '2026-05-25T10:00:00.000Z',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([orphan] as any);
      expect(states.has(CHAR_C_UUID)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('attaches last_event_id and last_updated metadata after each mutation', async () => {
      const { projector } = await importWithRoot(testRoot);
      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const mut = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -3 },
        'event-uuid-123',
        '2026-05-25T10:05:00.000Z',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const states = projector.replayEvents([seedEnv, mut] as any);
      const state = states.get(CHAR_A_UUID)!;
      expect(state.last_event_id).toBe('event-uuid-123');
      expect(state.last_updated).toBe('2026-05-25T10:05:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // 5. parseEventsFile — fail-fast on corruption (spike 008)
  // -------------------------------------------------------------------------

  describe('parseEventsFile — fail-fast on corruption (spike 008)', () => {
    it('parses a well-formed JSONL events.md', async () => {
      const { projector } = await importWithRoot(testRoot);
      const eventsFile = join(testRoot, 'events.md');
      const lines = [
        JSON.stringify({ id: 'a', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 1 }, timestamp: 't1' }),
        JSON.stringify({ id: 'b', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 2 }, timestamp: 't2' }),
        JSON.stringify({ id: 'c', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 3 }, timestamp: 't3' }),
        JSON.stringify({ id: 'd', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 4 }, timestamp: 't4' }),
        JSON.stringify({ id: 'e', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 5 }, timestamp: 't5' }),
      ];
      writeFileSync(eventsFile, lines.join('\n') + '\n', 'utf8');

      const envelopes = await projector.parseEventsFile(eventsFile);
      expect(envelopes).toHaveLength(5);
      expect(envelopes[0]!.id).toBe('a');
      expect(envelopes[4]!.id).toBe('e');
    });

    it('returns empty array for empty file', async () => {
      const { projector } = await importWithRoot(testRoot);
      const eventsFile = join(testRoot, 'events.md');
      writeFileSync(eventsFile, '', 'utf8');
      const envelopes = await projector.parseEventsFile(eventsFile);
      expect(envelopes).toEqual([]);
    });

    it('returns empty array for missing file', async () => {
      const { projector } = await importWithRoot(testRoot);
      const eventsFile = join(testRoot, 'never-existed.md');
      const envelopes = await projector.parseEventsFile(eventsFile);
      expect(envelopes).toEqual([]);
    });

    it('throws on corrupt JSON line with the line number in the error message', async () => {
      const { projector } = await importWithRoot(testRoot);
      const eventsFile = join(testRoot, 'events.md');
      const lines = [
        JSON.stringify({ id: 'a', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 1 }, timestamp: 't1' }),
        '{ this is not json',
        JSON.stringify({ id: 'c', version: 1, type: 'hp_change', payload: { character: CHAR_A_UUID, delta: 3 }, timestamp: 't3' }),
      ];
      writeFileSync(eventsFile, lines.join('\n') + '\n', 'utf8');

      await expect(projector.parseEventsFile(eventsFile)).rejects.toThrow(/line 2/);
    });
  });

  // -------------------------------------------------------------------------
  // 6. regenerateCharacterView — disk roundtrip
  // -------------------------------------------------------------------------

  describe('regenerateCharacterView — disk roundtrip', () => {
    it('reads events.md → writes view file with replayed state', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);

      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const dmg1 = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -3 },
        'mut1',
        '2026-05-25T10:01:00.000Z',
      );
      const dmg2 = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -5 },
        'mut2',
        '2026-05-25T10:02:00.000Z',
      );
      const heal = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: 2 },
        'mut3',
        '2026-05-25T10:03:00.000Z',
      );
      writeFileSync(
        eventsFile,
        [seedEnv, dmg1, dmg2, heal].map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );

      await projector.regenerateCharacterView(CAMPAIGN_UUID, CHAR_A_UUID);

      const viewPath = paths.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_A_UUID);
      expect(existsSync(viewPath)).toBe(true);

      const content = readFileSync(viewPath, 'utf8');
      expect(content).toContain('hp_current: 24');
      expect(content).toContain('hp_max: 30');
      expect(content).toMatch(/\/characters\/aragorn-aaaaaaaa\.md/.test(viewPath) ? /.*/ : /never/);
      expect(viewPath).toMatch(/\/characters\/aragorn-aaaaaaaa\.md$/);
    });

    it('updates view atomically when called repeatedly', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);

      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const dmg1 = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -3 },
        'mut1',
        '2026-05-25T10:01:00.000Z',
      );
      writeFileSync(
        eventsFile,
        [seedEnv, dmg1].map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );
      await projector.regenerateCharacterView(CAMPAIGN_UUID, CHAR_A_UUID);
      const viewPath = paths.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_A_UUID);
      const firstContent = readFileSync(viewPath, 'utf8');
      expect(firstContent).toContain('hp_current: 27');

      // Append a 2nd mutation and re-run the projector.
      const dmg2 = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -10 },
        'mut2',
        '2026-05-25T10:02:00.000Z',
      );
      writeFileSync(
        eventsFile,
        [seedEnv, dmg1, dmg2].map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );
      await projector.regenerateCharacterView(CAMPAIGN_UUID, CHAR_A_UUID);
      const secondContent = readFileSync(viewPath, 'utf8');
      expect(secondContent).toContain('hp_current: 17');
      // Not the previous content — a clean overwrite, not an append.
      expect(secondContent).not.toBe(firstContent);
    });

    it('creates parent directories if missing', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);

      const seedEnv = makeEnvelope(
        'campaign_initialized',
        { characters: [{ id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30 }] },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      writeFileSync(eventsFile, JSON.stringify(seedEnv) + '\n', 'utf8');

      // The characters/ subdir does NOT exist yet.
      const charactersDir = join(campaignDir, 'characters');
      expect(existsSync(charactersDir)).toBe(false);

      await projector.regenerateCharacterView(CAMPAIGN_UUID, CHAR_A_UUID);

      expect(existsSync(charactersDir)).toBe(true);
      const viewPath = paths.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_A_UUID);
      expect(existsSync(viewPath)).toBe(true);
    });

    it('throws when the target character is not seeded', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);
      writeFileSync(eventsFile, '', 'utf8');

      await expect(
        projector.regenerateCharacterView(CAMPAIGN_UUID, CHAR_A_UUID),
      ).rejects.toThrow(/not seeded/);
    });
  });

  // -------------------------------------------------------------------------
  // 7. serializeView + parseView round trip
  // -------------------------------------------------------------------------

  describe('serializeView + parseView round trip', () => {
    it('round-trips a minimal state', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const serialized = projector.serializeView(state);
      const parsed = projector.parseView(serialized);
      expect(parsed).toEqual(state);
    });

    it('round-trips a state with all event types applied', async () => {
      const { projector } = await importWithRoot(testRoot);
      let state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
        spell_slots: { '1': { max: 4, used: 0 } },
      });
      state = projector.applyEvent(state, {
        type: 'hp_change',
        payload: { character: CHAR_A_UUID, delta: -5 },
      });
      state = projector.applyEvent(state, {
        type: 'condition_add',
        payload: { character: CHAR_A_UUID, condition: 'poisoned' },
      });
      state = projector.applyEvent(state, {
        type: 'condition_add',
        payload: { character: CHAR_A_UUID, condition: 'blinded' },
      });
      state = projector.applyEvent(state, {
        type: 'spell_slot_use',
        payload: { character: CHAR_A_UUID, level: 1 },
      });
      state = projector.applyEvent(state, {
        type: 'inventory_add',
        payload: { character: CHAR_A_UUID, item: 'rope', qty: 1 },
      });
      state = projector.applyEvent(state, {
        type: 'inventory_add',
        payload: { character: CHAR_A_UUID, item: 'torch', qty: 3 },
      });
      // Add metadata as the dispatcher would.
      state.last_event_id = 'evt-xyz';
      state.last_updated = '2026-05-25T11:00:00.000Z';

      const serialized = projector.serializeView(state);
      const parsed = projector.parseView(serialized);
      expect(parsed).toEqual(state);
    });

    it('serializes empty arrays/maps deterministically', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const serialized = projector.serializeView(state);
      expect(serialized).toContain('conditions: []');
      expect(serialized).toContain('inventory: []');
      expect(serialized).toContain('spell_slots: {}');
    });

    it('byte-stable for the same input (spike 013 DR invariant)', async () => {
      const { projector } = await importWithRoot(testRoot);
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
        spell_slots: { '2': { max: 2, used: 0 }, '1': { max: 4, used: 1 } },
      });
      state.conditions = ['poisoned', 'blinded'];
      state.inventory = [
        { item: 'torch', qty: 3 },
        { item: 'rope', qty: 1 },
      ];

      const a = projector.serializeView(state);
      const b = projector.serializeView(state);
      // Identical strings byte-for-byte (no nondeterminism in key iteration
      // or in any clock/randomness path).
      expect(a).toBe(b);

      // Sorting invariant: spell_slots key 1 comes before key 2 in output
      // even though the source object had key 2 first.
      const idx1 = a.indexOf('"1":');
      const idx2 = a.indexOf('"2":');
      expect(idx1).toBeGreaterThan(-1);
      expect(idx2).toBeGreaterThan(idx1);
    });

    it('parseView returns null when frontmatter delimiters are missing', async () => {
      const { projector } = await importWithRoot(testRoot);
      expect(projector.parseView('not a view file')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 8. regenerateAffectedViews — dispatcher hook
  // -------------------------------------------------------------------------

  describe('regenerateAffectedViews — dispatcher hook', () => {
    it('regenerates one view for a single-character event', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);

      const seedEnv = makeEnvelope(
        'campaign_initialized',
        {
          characters: [
            { id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
            { id: CHAR_B_UUID, name: 'Gandalf', hp_max: 25, hp_current: 25 },
          ],
        },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      const dmgA = makeEnvelope(
        'hp_change',
        { character: CHAR_A_UUID, delta: -5 },
        'mut-a',
        '2026-05-25T10:01:00.000Z',
      );
      writeFileSync(
        eventsFile,
        [seedEnv, dmgA].map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf8',
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await projector.regenerateAffectedViews(CAMPAIGN_UUID, dmgA as any);

      const viewAPath = paths.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_A_UUID);
      const viewBPath = paths.characterViewPath(CAMPAIGN_UUID, 'Gandalf', CHAR_B_UUID);
      expect(existsSync(viewAPath)).toBe(true);
      // Gandalf's view was NOT touched because dmgA targets Aragorn.
      expect(existsSync(viewBPath)).toBe(false);
    });

    it('regenerates all character views for a campaign_initialized event', async () => {
      const { projector, paths } = await importWithRoot(testRoot);
      const campaignDir = paths.campaignDir(CAMPAIGN_UUID);
      mkdirSync(campaignDir, { recursive: true });
      const eventsFile = paths.eventsPath(CAMPAIGN_UUID);

      const seedEnv = makeEnvelope(
        'campaign_initialized',
        {
          characters: [
            { id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30 },
            { id: CHAR_B_UUID, name: 'Gandalf', hp_max: 25 },
            { id: CHAR_C_UUID, name: 'Legolas', hp_max: 28 },
          ],
        },
        'seed',
        '2026-05-25T10:00:00.000Z',
      );
      writeFileSync(eventsFile, JSON.stringify(seedEnv) + '\n', 'utf8');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await projector.regenerateAffectedViews(CAMPAIGN_UUID, seedEnv as any);

      expect(
        existsSync(paths.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_A_UUID)),
      ).toBe(true);
      expect(
        existsSync(paths.characterViewPath(CAMPAIGN_UUID, 'Gandalf', CHAR_B_UUID)),
      ).toBe(true);
      expect(
        existsSync(paths.characterViewPath(CAMPAIGN_UUID, 'Legolas', CHAR_C_UUID)),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 9. graceful degradation on unknown event types (Pitfall 6)
  // -------------------------------------------------------------------------

  describe('graceful degradation on unknown event types (Pitfall 6)', () => {
    it('logs and returns state unchanged for an unknown event type', async () => {
      const { projector } = await importWithRoot(testRoot);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const state = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: 30,
      });
      const snapshot = JSON.parse(JSON.stringify(state)) as unknown;

      // Cast a fake event to bypass the discriminated-union type check —
      // simulates a Phase 03+ event type appearing in older code's
      // events.md (the forward-compat scenario Pitfall 6 documents).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = projector.applyEvent(state, { type: 'level_up', payload: { character: CHAR_A_UUID } } as any);
      expect(warnSpy).toHaveBeenCalled();
      // State is structurally identical (modulo identity — applyEvent
      // returns a clone, not the input).
      expect(JSON.parse(JSON.stringify(result))).toEqual(snapshot);
    });
  });
});
