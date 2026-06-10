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
      const result1 = projector.replayEvents(all as any).chars;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result2 = projector.replayEvents(all as any).chars;

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
      const r1 = projector.replayEvents([seedEnv, heal, damage] as any).chars;
      // Order B: damage then heal. Start at 30, damage → 20, heal → 25.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r2 = projector.replayEvents([seedEnv, damage, heal] as any).chars;

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
      const { chars: states } = projector.replayEvents([seedEnv, dmgA, dmgB] as any);
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
      const { chars: states } = projector.replayEvents([seedEnv] as any);
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
      const { chars: states } = projector.replayEvents([seedEnv] as any);
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
      const { chars: states } = projector.replayEvents([seedEnv] as any);
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
      const { chars: states } = projector.replayEvents([orphan] as any);
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
      const { chars: states } = projector.replayEvents([seedEnv, mut] as any);
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
      // `level_up` is intentionally NOT in VAULT_EVENT_TYPES (audit
      // "provisional" list; see COMPLETENESS-AUDIT.md §"Open Items §(d)").
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = projector.applyEvent(state, { type: 'level_up', payload: { character: CHAR_A_UUID } } as any);
      expect(warnSpy).toHaveBeenCalled();
      // State is structurally identical (modulo identity — applyEvent
      // returns a clone, not the input).
      expect(JSON.parse(JSON.stringify(result))).toEqual(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // 10. applyEvent — Phase 03 reducer arms (plan 03-A-03 Task 4)
  //
  // Coverage map per the 20 Phase 03 event types from
  // COMPLETENESS-AUDIT.md §"(c) Final list":
  //
  //   1. temp_hp_set
  //   2. death_save_success
  //   3. death_save_fail
  //   4. death_save_stabilize
  //   5. death_save_recover_at_one
  //   6. concentration_set
  //   7. concentration_break
  //   8. exhaustion_increment
  //   9. exhaustion_decrement
  //  10. hit_dice_use
  //  11. hit_dice_restore
  //  12. resource_use
  //  13. resource_restore
  //  14. inspiration_grant
  //  15. inspiration_spend
  //  16. attune
  //  17. unattune
  //  18. focus_set
  //  19. focus_unset
  //  20. xp_award
  //
  // Plus byte-stability regression (spike 013) covering mixed
  // Phase 02 + Phase 03 events.
  // -------------------------------------------------------------------------

  describe('applyEvent — Phase 03 reducer arms', () => {
    /**
     * Helper: produce a fresh CharacterState with optional Phase 02 / 03
     * overrides. Defaults match INITIAL_CHARACTER_STATE for Aragorn @
     * id=CHAR_A_UUID, hp_max=30.
     */
    async function freshState(
      overrides: Partial<{
        hp_current: number;
        hp_max: number;
        conditions: string[];
        spell_slots: Record<string, { max: number; used: number }>;
        inventory: { item: string; qty: number }[];
        temp_hp: number;
        death_saves: { successes: number; failures: number };
        flags: { stable: boolean; dead: boolean; inspiration: boolean };
        concentrating_on:
          | { spellSlug: string; slotLevel: number; startedRound: number }
          | null;
        exhaustion_level: number;
        hit_dice_remaining: number;
        hit_dice_max: number;
        attunements: string[];
        equipped_focus: { kind: 'arcane' | 'druidic' | 'holy' | 'instrument'; itemSlug: string } | null;
        resources_used: Record<string, number>;
        xp: number;
        level: number;
      }> = {},
    ): Promise<import('@/ai/master/vault/projector').CharacterState> {
      const { projector } = await importWithRoot(testRoot);
      const base = projector.INITIAL_CHARACTER_STATE({
        id: CHAR_A_UUID,
        name: 'Aragorn',
        hp_max: overrides.hp_max ?? 30,
      });
      return {
        ...base,
        hp_current: overrides.hp_current ?? base.hp_current,
        hp_max: overrides.hp_max ?? base.hp_max,
        conditions: overrides.conditions ?? base.conditions,
        spell_slots: overrides.spell_slots ?? base.spell_slots,
        inventory: overrides.inventory ?? base.inventory,
        temp_hp: overrides.temp_hp ?? base.temp_hp,
        death_saves: overrides.death_saves ?? base.death_saves,
        flags: overrides.flags ?? base.flags,
        concentrating_on:
          overrides.concentrating_on === undefined ? base.concentrating_on : overrides.concentrating_on,
        exhaustion_level: overrides.exhaustion_level ?? base.exhaustion_level,
        hit_dice_remaining: overrides.hit_dice_remaining ?? base.hit_dice_remaining,
        hit_dice_max: overrides.hit_dice_max ?? base.hit_dice_max,
        attunements: overrides.attunements ?? base.attunements,
        equipped_focus:
          overrides.equipped_focus === undefined ? base.equipped_focus : overrides.equipped_focus,
        resources_used: overrides.resources_used ?? base.resources_used,
        xp: overrides.xp ?? base.xp,
        level: overrides.level ?? base.level,
      };
    }

    // -----------------------------------------------------------------------
    // INITIAL_CHARACTER_STATE — Phase 03 default-value coverage
    // -----------------------------------------------------------------------

    describe('INITIAL_CHARACTER_STATE — Phase 03 defaults', () => {
      it('produces neutral defaults for every new field when seed lacks them', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = projector.INITIAL_CHARACTER_STATE({
          id: CHAR_A_UUID,
          name: 'Aragorn',
          hp_max: 30,
        });
        expect(s.temp_hp).toBe(0);
        expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
        expect(s.flags).toEqual({ stable: false, dead: false, inspiration: false });
        expect(s.concentrating_on).toBeNull();
        expect(s.exhaustion_level).toBe(0);
        expect(s.hit_dice_remaining).toBe(0);
        expect(s.hit_dice_max).toBe(0);
        expect(s.attunements).toEqual([]);
        expect(s.equipped_focus).toBeNull();
        expect(s.resources_used).toEqual({});
        expect(s.xp).toBe(0);
        expect(s.level).toBe(1);
      });

      it('honors seed values when present', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = projector.INITIAL_CHARACTER_STATE({
          id: CHAR_A_UUID,
          name: 'Aragorn',
          hp_max: 30,
          temp_hp: 5,
          hit_dice_remaining: 3,
          hit_dice_max: 5,
          exhaustion_level: 2,
          death_saves: { successes: 1, failures: 2 },
          flags: { stable: true, inspiration: true },
          concentrating_on: { spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
          attunements: ['wand', 'amulet'],
          equipped_focus: { kind: 'arcane', itemSlug: 'staff' },
          resources_used: { rage: 1 },
          xp: 1500,
          level: 5,
        });
        expect(s.temp_hp).toBe(5);
        expect(s.hit_dice_remaining).toBe(3);
        expect(s.hit_dice_max).toBe(5);
        expect(s.exhaustion_level).toBe(2);
        expect(s.death_saves).toEqual({ successes: 1, failures: 2 });
        expect(s.flags).toEqual({ stable: true, dead: false, inspiration: true });
        expect(s.concentrating_on).toEqual({
          spellSlug: 'bless',
          slotLevel: 1,
          startedRound: 3,
        });
        // attunements are sorted on intake (DR byte-stability)
        expect(s.attunements).toEqual(['amulet', 'wand']);
        expect(s.equipped_focus).toEqual({ kind: 'arcane', itemSlug: 'staff' });
        expect(s.resources_used).toEqual({ rage: 1 });
        expect(s.xp).toBe(1500);
        expect(s.level).toBe(5);
      });
    });

    // -----------------------------------------------------------------------
    // 1. temp_hp_set
    // -----------------------------------------------------------------------

    describe('temp_hp_set', () => {
      it('overwrites temp_hp with the payload value', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'temp_hp_set',
          payload: { character: CHAR_A_UUID, tempHp: 7 },
        });
        expect(next.temp_hp).toBe(7);
      });

      it('clamps to 0 on a 0 payload (validator already rejects negatives)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ temp_hp: 9 });
        const next = projector.applyEvent(s, {
          type: 'temp_hp_set',
          payload: { character: CHAR_A_UUID, tempHp: 0 },
        });
        expect(next.temp_hp).toBe(0);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ temp_hp: 5 });
        const next = projector.applyEvent(s, {
          type: 'temp_hp_set',
          payload: { character: CHAR_B_UUID, tempHp: 99 },
        });
        expect(next.temp_hp).toBe(5);
      });
    });

    // -----------------------------------------------------------------------
    // 2. death_save_success
    // -----------------------------------------------------------------------

    describe('death_save_success', () => {
      it('increments successes from 0 to 1', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'death_save_success',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.death_saves).toEqual({ successes: 1, failures: 0 });
      });

      it('3 successes resets counter AND sets flags.stable + ensures unconscious in conditions', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ death_saves: { successes: 2, failures: 1 } });
        s = projector.applyEvent(s, {
          type: 'death_save_success',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
        expect(s.flags.stable).toBe(true);
        // PHB §3.18 — stabilized PCs stay unconscious. Mirror applicator
        // semantics: insert `unconscious` if absent.
        expect(s.conditions).toContain('unconscious');
      });

      it('preserves existing failures when incrementing', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ death_saves: { successes: 1, failures: 2 } });
        const next = projector.applyEvent(s, {
          type: 'death_save_success',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.death_saves).toEqual({ successes: 2, failures: 2 });
      });

      it('does not duplicate `unconscious` when already present', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          conditions: ['poisoned', 'unconscious'],
          death_saves: { successes: 2, failures: 0 },
        });
        s = projector.applyEvent(s, {
          type: 'death_save_success',
          payload: { character: CHAR_A_UUID },
        });
        // Single 'unconscious' entry — idempotent insert (matches the
        // `condition_add` arm pattern Phase 02 ships).
        expect(s.conditions.filter((c) => c === 'unconscious')).toHaveLength(1);
        // Other conditions preserved.
        expect(s.conditions).toContain('poisoned');
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'death_save_success',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.death_saves).toEqual({ successes: 0, failures: 0 });
      });
    });

    // -----------------------------------------------------------------------
    // 3. death_save_fail
    // -----------------------------------------------------------------------

    describe('death_save_fail', () => {
      it('increments failures by 1 (non-critical)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'death_save_fail',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.death_saves).toEqual({ successes: 0, failures: 1 });
      });

      it('increments failures by 2 when critical=true', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'death_save_fail',
          payload: { character: CHAR_A_UUID, critical: true },
        });
        expect(next.death_saves).toEqual({ successes: 0, failures: 2 });
      });

      it('3 failures sets flags.dead AND preserves failures:3 for traceability', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ death_saves: { successes: 1, failures: 2 } });
        s = projector.applyEvent(s, {
          type: 'death_save_fail',
          payload: { character: CHAR_A_UUID },
        });
        // applicator.ts:601-608 — failures stay at 3 (not reset) for the
        // operator audit trail. successes reset to 0.
        expect(s.death_saves).toEqual({ successes: 0, failures: 3 });
        expect(s.flags.dead).toBe(true);
      });

      it('critical=true crossing 3 still caps at 3 failures', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ death_saves: { successes: 0, failures: 2 } });
        s = projector.applyEvent(s, {
          type: 'death_save_fail',
          payload: { character: CHAR_A_UUID, critical: true },
        });
        // 2 + 2 = 4 would overflow; cap at 3, set dead.
        expect(s.death_saves.failures).toBe(3);
        expect(s.flags.dead).toBe(true);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'death_save_fail',
          payload: { character: CHAR_B_UUID, critical: true },
        });
        expect(next.death_saves).toEqual({ successes: 0, failures: 0 });
      });
    });

    // -----------------------------------------------------------------------
    // 4. death_save_stabilize
    // -----------------------------------------------------------------------

    describe('death_save_stabilize', () => {
      it('resets death_saves AND sets flags.stable', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ death_saves: { successes: 1, failures: 2 } });
        s = projector.applyEvent(s, {
          type: 'death_save_stabilize',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
        expect(s.flags.stable).toBe(true);
      });

      it('does NOT touch conditions (PHB §3.19 stable but unconscious)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const initialConditions = ['unconscious', 'poisoned'];
        let s = await freshState({
          conditions: initialConditions,
          death_saves: { successes: 0, failures: 2 },
        });
        s = projector.applyEvent(s, {
          type: 'death_save_stabilize',
          payload: { character: CHAR_A_UUID },
        });
        // Order is preserved (the arm does NOT re-sort; it does not touch
        // conditions at all). Assert by membership + length to be
        // order-agnostic vs. the input.
        expect(s.conditions).toHaveLength(initialConditions.length);
        expect(s.conditions).toEqual(expect.arrayContaining(initialConditions));
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ death_saves: { successes: 0, failures: 2 } });
        const next = projector.applyEvent(s, {
          type: 'death_save_stabilize',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.death_saves).toEqual({ successes: 0, failures: 2 });
        expect(next.flags.stable).toBe(false);
      });
    });

    // -----------------------------------------------------------------------
    // 5. death_save_recover_at_one
    // -----------------------------------------------------------------------

    describe('death_save_recover_at_one', () => {
      it('atomic recovery: reset deathsaves + hp_current=1 + remove unconscious + clear stable/dead', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          hp_current: 0,
          hp_max: 30,
          conditions: ['unconscious'],
          death_saves: { successes: 1, failures: 2 },
          flags: { stable: true, dead: false, inspiration: false },
        });
        s = projector.applyEvent(s, {
          type: 'death_save_recover_at_one',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
        expect(s.hp_current).toBe(1);
        expect(s.conditions).not.toContain('unconscious');
        expect(s.flags.stable).toBe(false);
        expect(s.flags.dead).toBe(false);
        // inspiration is unrelated — preserved
        expect(s.flags.inspiration).toBe(false);
      });

      it('preserves other conditions while removing unconscious', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          hp_current: 0,
          conditions: ['poisoned', 'unconscious', 'frightened'],
        });
        s = projector.applyEvent(s, {
          type: 'death_save_recover_at_one',
          payload: { character: CHAR_A_UUID },
        });
        // The arm uses `.filter()` which preserves array order; it does
        // NOT re-sort (the byte-stability sort happens at serializeView
        // emit time for the conditions block).
        expect(s.conditions).not.toContain('unconscious');
        expect(s.conditions).toContain('poisoned');
        expect(s.conditions).toContain('frightened');
        expect(s.conditions).toHaveLength(2);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          hp_current: 0,
          conditions: ['unconscious'],
          death_saves: { successes: 2, failures: 1 },
        });
        const next = projector.applyEvent(s, {
          type: 'death_save_recover_at_one',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.hp_current).toBe(0);
        expect(next.conditions).toEqual(['unconscious']);
        expect(next.death_saves).toEqual({ successes: 2, failures: 1 });
      });
    });

    // -----------------------------------------------------------------------
    // 6. concentration_set
    // -----------------------------------------------------------------------

    describe('concentration_set', () => {
      it('sets concentrating_on with payload fields', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'concentration_set',
          payload: { character: CHAR_A_UUID, spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
        });
        expect(next.concentrating_on).toEqual({
          spellSlug: 'bless',
          slotLevel: 1,
          startedRound: 3,
        });
      });

      it('overwrites pre-existing concentration target', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          concentrating_on: { spellSlug: 'shield-of-faith', slotLevel: 1, startedRound: 1 },
        });
        s = projector.applyEvent(s, {
          type: 'concentration_set',
          payload: { character: CHAR_A_UUID, spellSlug: 'haste', slotLevel: 3, startedRound: 5 },
        });
        expect(s.concentrating_on).toEqual({
          spellSlug: 'haste',
          slotLevel: 3,
          startedRound: 5,
        });
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'concentration_set',
          payload: { character: CHAR_B_UUID, spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
        });
        expect(next.concentrating_on).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // 7. concentration_break
    // -----------------------------------------------------------------------

    describe('concentration_break', () => {
      it('clears concentrating_on regardless of reason', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          concentrating_on: { spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
        });
        s = projector.applyEvent(s, {
          type: 'concentration_break',
          payload: { character: CHAR_A_UUID, reason: 'damage' },
        });
        expect(s.concentrating_on).toBeNull();
      });

      it('reason "killed" produces the same null state', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          concentrating_on: { spellSlug: 'haste', slotLevel: 3, startedRound: 5 },
        });
        s = projector.applyEvent(s, {
          type: 'concentration_break',
          payload: { character: CHAR_A_UUID, reason: 'killed' },
        });
        expect(s.concentrating_on).toBeNull();
      });

      it('reason "incapacitated" also yields null', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          concentrating_on: { spellSlug: 'fly', slotLevel: 3, startedRound: 2 },
        });
        s = projector.applyEvent(s, {
          type: 'concentration_break',
          payload: { character: CHAR_A_UUID, reason: 'incapacitated' },
        });
        expect(s.concentrating_on).toBeNull();
      });

      it('idempotent when concentrating_on was already null', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'concentration_break',
          payload: { character: CHAR_A_UUID, reason: 'damage' },
        });
        expect(next.concentrating_on).toBeNull();
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          concentrating_on: { spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
        });
        const next = projector.applyEvent(s, {
          type: 'concentration_break',
          payload: { character: CHAR_B_UUID, reason: 'damage' },
        });
        expect(next.concentrating_on).toEqual({
          spellSlug: 'bless',
          slotLevel: 1,
          startedRound: 1,
        });
      });
    });

    // -----------------------------------------------------------------------
    // 8. exhaustion_increment
    // -----------------------------------------------------------------------

    describe('exhaustion_increment', () => {
      it('increments exhaustion_level from 0 to 1 AND appends `exhaustion` to conditions', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_A_UUID, source: 'forced_march' },
        });
        expect(next.exhaustion_level).toBe(1);
        expect(next.conditions).toContain('exhaustion');
      });

      it('caps at level 6 AND sets flags.dead at the cap (PHB §4.1)', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ exhaustion_level: 5, conditions: ['exhaustion'] });
        s = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_A_UUID, source: 'starvation' },
        });
        expect(s.exhaustion_level).toBe(6);
        expect(s.flags.dead).toBe(true);
      });

      it('further increments past level 6 stay capped (no overflow)', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          exhaustion_level: 6,
          conditions: ['exhaustion'],
          flags: { stable: false, dead: true, inspiration: false },
        });
        s = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_A_UUID, source: 'magical' },
        });
        expect(s.exhaustion_level).toBe(6);
      });

      it('does not duplicate `exhaustion` in conditions on repeated increments', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState();
        s = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_A_UUID, source: 'forced_march' },
        });
        s = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_A_UUID, source: 'dehydration' },
        });
        const occurrences = s.conditions.filter((c) => c === 'exhaustion').length;
        expect(occurrences).toBe(1);
        expect(s.exhaustion_level).toBe(2);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'exhaustion_increment',
          payload: { character: CHAR_B_UUID, source: 'forced_march' },
        });
        expect(next.exhaustion_level).toBe(0);
        expect(next.conditions).not.toContain('exhaustion');
      });
    });

    // -----------------------------------------------------------------------
    // 9. exhaustion_decrement
    // -----------------------------------------------------------------------

    describe('exhaustion_decrement', () => {
      it('decrements exhaustion_level by 1', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ exhaustion_level: 3, conditions: ['exhaustion'] });
        const next = projector.applyEvent(s, {
          type: 'exhaustion_decrement',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.exhaustion_level).toBe(2);
        // Still > 0 → `exhaustion` stays in conditions
        expect(next.conditions).toContain('exhaustion');
      });

      it('reaching 0 removes `exhaustion` from conditions', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          exhaustion_level: 1,
          conditions: ['exhaustion', 'poisoned'],
        });
        s = projector.applyEvent(s, {
          type: 'exhaustion_decrement',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.exhaustion_level).toBe(0);
        expect(s.conditions).not.toContain('exhaustion');
        // Other conditions preserved
        expect(s.conditions).toContain('poisoned');
      });

      it('no-op at level 0 (no underflow)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'exhaustion_decrement',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.exhaustion_level).toBe(0);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ exhaustion_level: 3, conditions: ['exhaustion'] });
        const next = projector.applyEvent(s, {
          type: 'exhaustion_decrement',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.exhaustion_level).toBe(3);
      });
    });

    // -----------------------------------------------------------------------
    // 10. hit_dice_use
    // -----------------------------------------------------------------------

    describe('hit_dice_use', () => {
      it('decrements hit_dice_remaining by count', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 5 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_use',
          payload: { character: CHAR_A_UUID, count: 2 },
        });
        expect(next.hit_dice_remaining).toBe(3);
      });

      it('clamps to 0 when count exceeds remaining', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 1 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_use',
          payload: { character: CHAR_A_UUID, count: 10 },
        });
        expect(next.hit_dice_remaining).toBe(0);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 5 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_use',
          payload: { character: CHAR_B_UUID, count: 2 },
        });
        expect(next.hit_dice_remaining).toBe(5);
      });
    });

    // -----------------------------------------------------------------------
    // 11. hit_dice_restore
    // -----------------------------------------------------------------------

    describe('hit_dice_restore', () => {
      it('increments hit_dice_remaining by count', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 2 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_restore',
          payload: { character: CHAR_A_UUID, count: 1 },
        });
        expect(next.hit_dice_remaining).toBe(3);
      });

      it('caps at hit_dice_max', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 3 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_restore',
          payload: { character: CHAR_A_UUID, count: 99 },
        });
        expect(next.hit_dice_remaining).toBe(5);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ hit_dice_max: 5, hit_dice_remaining: 2 });
        const next = projector.applyEvent(s, {
          type: 'hit_dice_restore',
          payload: { character: CHAR_B_UUID, count: 1 },
        });
        expect(next.hit_dice_remaining).toBe(2);
      });
    });

    // -----------------------------------------------------------------------
    // 12. resource_use
    // -----------------------------------------------------------------------

    describe('resource_use', () => {
      it('creates a new resource counter when key absent', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'resource_use',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 1 },
        });
        expect(next.resources_used).toEqual({ rage: 1 });
      });

      it('adds to an existing resource counter', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 1, surge: 0 } });
        const next = projector.applyEvent(s, {
          type: 'resource_use',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 2 },
        });
        expect(next.resources_used).toEqual({ rage: 3, surge: 0 });
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 1 } });
        const next = projector.applyEvent(s, {
          type: 'resource_use',
          payload: { character: CHAR_B_UUID, resourceKey: 'rage', uses: 5 },
        });
        expect(next.resources_used).toEqual({ rage: 1 });
      });
    });

    // -----------------------------------------------------------------------
    // 13. resource_restore
    // -----------------------------------------------------------------------

    describe('resource_restore', () => {
      it('decrements a resource counter', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 3 } });
        const next = projector.applyEvent(s, {
          type: 'resource_restore',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 1 },
        });
        expect(next.resources_used).toEqual({ rage: 2 });
      });

      it('deletes the key when count reaches 0', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 2, surge: 1 } });
        const next = projector.applyEvent(s, {
          type: 'resource_restore',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 2 },
        });
        expect(next.resources_used).toEqual({ surge: 1 });
      });

      it('clamps at 0 when restoring more than available', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 1 } });
        const next = projector.applyEvent(s, {
          type: 'resource_restore',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 99 },
        });
        // Underflow → reaches 0 → key deleted.
        expect(next.resources_used).toEqual({});
      });

      it('no-op for absent key (still bottoms out to deleted)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'resource_restore',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 1 },
        });
        expect(next.resources_used).toEqual({});
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 2 } });
        const next = projector.applyEvent(s, {
          type: 'resource_restore',
          payload: { character: CHAR_B_UUID, resourceKey: 'rage', uses: 1 },
        });
        expect(next.resources_used).toEqual({ rage: 2 });
      });
    });

    // -----------------------------------------------------------------------
    // 14. inspiration_grant
    // -----------------------------------------------------------------------

    describe('inspiration_grant', () => {
      it('sets flags.inspiration = true', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'inspiration_grant',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.flags.inspiration).toBe(true);
      });

      it('idempotent — granting again leaves it true', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          flags: { stable: false, dead: false, inspiration: true },
        });
        s = projector.applyEvent(s, {
          type: 'inspiration_grant',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.flags.inspiration).toBe(true);
      });

      it('preserves other flag fields', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          flags: { stable: true, dead: false, inspiration: false },
        });
        const next = projector.applyEvent(s, {
          type: 'inspiration_grant',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.flags).toEqual({ stable: true, dead: false, inspiration: true });
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'inspiration_grant',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.flags.inspiration).toBe(false);
      });
    });

    // -----------------------------------------------------------------------
    // 15. inspiration_spend
    // -----------------------------------------------------------------------

    describe('inspiration_spend', () => {
      it('sets flags.inspiration = false', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          flags: { stable: false, dead: false, inspiration: true },
        });
        const next = projector.applyEvent(s, {
          type: 'inspiration_spend',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.flags.inspiration).toBe(false);
      });

      it('idempotent on already-false flag', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'inspiration_spend',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.flags.inspiration).toBe(false);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          flags: { stable: false, dead: false, inspiration: true },
        });
        const next = projector.applyEvent(s, {
          type: 'inspiration_spend',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.flags.inspiration).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // 16. attune
    // -----------------------------------------------------------------------

    describe('attune', () => {
      it('appends a new attunement slug', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'wand-of-fireballs' },
        });
        expect(next.attunements).toEqual(['wand-of-fireballs']);
      });

      it('keeps attunements sorted for byte-stable output', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState();
        s = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'wand' },
        });
        s = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'amulet' },
        });
        expect(s.attunements).toEqual(['amulet', 'wand']);
      });

      it('idempotent on already-attuned slug', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState();
        s = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'wand' },
        });
        s = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'wand' },
        });
        expect(s.attunements).toEqual(['wand']);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_B_UUID, itemSlug: 'wand' },
        });
        expect(next.attunements).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // 17. unattune
    // -----------------------------------------------------------------------

    describe('unattune', () => {
      it('removes the slug from attunements', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ attunements: ['amulet', 'wand'] });
        const next = projector.applyEvent(s, {
          type: 'unattune',
          payload: { character: CHAR_A_UUID, itemSlug: 'wand' },
        });
        expect(next.attunements).toEqual(['amulet']);
      });

      it('idempotent on absent slug', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ attunements: ['amulet'] });
        const next = projector.applyEvent(s, {
          type: 'unattune',
          payload: { character: CHAR_A_UUID, itemSlug: 'never-attuned' },
        });
        expect(next.attunements).toEqual(['amulet']);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ attunements: ['wand'] });
        const next = projector.applyEvent(s, {
          type: 'unattune',
          payload: { character: CHAR_B_UUID, itemSlug: 'wand' },
        });
        expect(next.attunements).toEqual(['wand']);
      });
    });

    // -----------------------------------------------------------------------
    // 18. focus_set
    // -----------------------------------------------------------------------

    describe('focus_set', () => {
      it('sets equipped_focus with kind + itemSlug', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'focus_set',
          payload: { character: CHAR_A_UUID, kind: 'arcane', itemSlug: 'wand-of-the-warmage' },
        });
        expect(next.equipped_focus).toEqual({
          kind: 'arcane',
          itemSlug: 'wand-of-the-warmage',
        });
      });

      it('overwrites existing focus', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          equipped_focus: { kind: 'arcane', itemSlug: 'crystal' },
        });
        s = projector.applyEvent(s, {
          type: 'focus_set',
          payload: { character: CHAR_A_UUID, kind: 'druidic', itemSlug: 'mistletoe' },
        });
        expect(s.equipped_focus).toEqual({ kind: 'druidic', itemSlug: 'mistletoe' });
      });

      it('supports all four PHB focus kinds', async () => {
        const { projector } = await importWithRoot(testRoot);
        for (const kind of ['arcane', 'druidic', 'holy', 'instrument'] as const) {
          const next = projector.applyEvent(await freshState(), {
            type: 'focus_set',
            payload: { character: CHAR_A_UUID, kind, itemSlug: 'foo' },
          });
          expect(next.equipped_focus?.kind).toBe(kind);
        }
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'focus_set',
          payload: { character: CHAR_B_UUID, kind: 'arcane', itemSlug: 'wand' },
        });
        expect(next.equipped_focus).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // 19. focus_unset
    // -----------------------------------------------------------------------

    describe('focus_unset', () => {
      it('clears equipped_focus to null', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          equipped_focus: { kind: 'holy', itemSlug: 'amulet-of-light' },
        });
        s = projector.applyEvent(s, {
          type: 'focus_unset',
          payload: { character: CHAR_A_UUID },
        });
        expect(s.equipped_focus).toBeNull();
      });

      it('idempotent when already null', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'focus_unset',
          payload: { character: CHAR_A_UUID },
        });
        expect(next.equipped_focus).toBeNull();
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          equipped_focus: { kind: 'arcane', itemSlug: 'wand' },
        });
        const next = projector.applyEvent(s, {
          type: 'focus_unset',
          payload: { character: CHAR_B_UUID },
        });
        expect(next.equipped_focus).toEqual({ kind: 'arcane', itemSlug: 'wand' });
      });
    });

    // -----------------------------------------------------------------------
    // 20. xp_award
    // -----------------------------------------------------------------------

    describe('xp_award', () => {
      it('adds amount to xp', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'xp_award',
          payload: { character: CHAR_A_UUID, amount: 250 },
        });
        expect(next.xp).toBe(250);
      });

      it('accumulates across multiple awards', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({ xp: 1500 });
        s = projector.applyEvent(s, {
          type: 'xp_award',
          payload: { character: CHAR_A_UUID, amount: 500 },
        });
        s = projector.applyEvent(s, {
          type: 'xp_award',
          payload: { character: CHAR_A_UUID, amount: 250, reason: 'monster' },
        });
        expect(s.xp).toBe(2250);
      });

      it('ignores reason metadata (audit log only)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const next = projector.applyEvent(s, {
          type: 'xp_award',
          payload: { character: CHAR_A_UUID, amount: 100, reason: 'side quest' },
        });
        expect(next.xp).toBe(100);
      });

      it('no-op for event targeting another character', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ xp: 500 });
        const next = projector.applyEvent(s, {
          type: 'xp_award',
          payload: { character: CHAR_B_UUID, amount: 100 },
        });
        expect(next.xp).toBe(500);
      });
    });

    // -----------------------------------------------------------------------
    // Purity: Phase 03 arms do not mutate the input state
    // -----------------------------------------------------------------------

    describe('Phase 03 arms preserve purity (no input mutation)', () => {
      it('temp_hp_set does not mutate input state', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ temp_hp: 3 });
        const snapshot = JSON.parse(JSON.stringify(s));
        projector.applyEvent(s, {
          type: 'temp_hp_set',
          payload: { character: CHAR_A_UUID, tempHp: 99 },
        });
        expect(JSON.parse(JSON.stringify(s))).toEqual(snapshot);
      });

      it('attune does not mutate the source attunements array', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ attunements: ['existing'] });
        const sourceArrayRef = s.attunements;
        projector.applyEvent(s, {
          type: 'attune',
          payload: { character: CHAR_A_UUID, itemSlug: 'new-item' },
        });
        // The source array is not the modified one — applyEvent returns a
        // structuredClone-rooted new state.
        expect(sourceArrayRef).toEqual(['existing']);
      });

      it('resource_use does not mutate the source resources_used object', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ resources_used: { rage: 1 } });
        const snapshot = JSON.parse(JSON.stringify(s.resources_used));
        projector.applyEvent(s, {
          type: 'resource_use',
          payload: { character: CHAR_A_UUID, resourceKey: 'rage', uses: 2 },
        });
        expect(JSON.parse(JSON.stringify(s.resources_used))).toEqual(snapshot);
      });
    });

    // -----------------------------------------------------------------------
    // serializeView + parseView round-trip with Phase 03 fields
    // -----------------------------------------------------------------------

    describe('serializeView + parseView round-trip — Phase 03 state', () => {
      it('round-trips a state with every Phase 03 field populated', async () => {
        const { projector } = await importWithRoot(testRoot);
        let s = await freshState({
          hp_current: 12,
          hp_max: 30,
          conditions: ['unconscious', 'poisoned'].sort(),
          spell_slots: { '1': { max: 4, used: 2 }, '2': { max: 3, used: 0 } },
          inventory: [{ item: 'rope', qty: 1 }],
          temp_hp: 5,
          death_saves: { successes: 1, failures: 2 },
          flags: { stable: false, dead: false, inspiration: true },
          concentrating_on: { spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
          exhaustion_level: 2,
          hit_dice_remaining: 3,
          hit_dice_max: 5,
          attunements: ['amulet', 'wand'],
          equipped_focus: { kind: 'arcane', itemSlug: 'crystal' },
          resources_used: { rage: 1, surge: 0 },
          xp: 2500,
          level: 4,
        });
        const serialized = projector.serializeView(s);
        const parsed = projector.parseView(serialized);
        expect(parsed).toEqual(s);
      });

      it('round-trips a state with null concentrating_on and equipped_focus', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({ temp_hp: 7 });
        const serialized = projector.serializeView(s);
        const parsed = projector.parseView(serialized);
        expect(parsed?.concentrating_on).toBeNull();
        expect(parsed?.equipped_focus).toBeNull();
        expect(parsed?.temp_hp).toBe(7);
      });

      it('serializes empty Phase 03 collections inline', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const out = projector.serializeView(s);
        expect(out).toContain('attunements: []');
        expect(out).toContain('resources_used: {}');
        expect(out).toContain('concentrating_on: null');
        expect(out).toContain('equipped_focus: null');
      });

      it('serializes Phase 03 numerics in declared order (byte-stable layout)', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState();
        const out = projector.serializeView(s);
        // The Phase 03 numeric block follows the Phase 02 inventory line and
        // appears in this exact order — anchor the regression to the layout.
        // Anchor each match to the start-of-line ("\n" + key) so substring
        // collisions (e.g. `level:` inside `exhaustion_level:`) cannot
        // produce a false-positive index.
        const tempIdx = out.indexOf('\ntemp_hp:');
        const exhIdx = out.indexOf('\nexhaustion_level:');
        const hdRem = out.indexOf('\nhit_dice_remaining:');
        const hdMax = out.indexOf('\nhit_dice_max:');
        const xpIdx = out.indexOf('\nxp:');
        const lvlIdx = out.indexOf('\nlevel:');
        expect(tempIdx).toBeGreaterThan(0);
        expect(tempIdx).toBeLessThan(exhIdx);
        expect(exhIdx).toBeLessThan(hdRem);
        expect(hdRem).toBeLessThan(hdMax);
        expect(hdMax).toBeLessThan(xpIdx);
        expect(xpIdx).toBeLessThan(lvlIdx);
      });

      it('parseView accepts a Phase 02-only frontmatter and fills Phase 03 defaults', async () => {
        const { projector } = await importWithRoot(testRoot);
        const phase02Only = [
          '---',
          'id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          'name: "Aragorn"',
          'hp_current: 15',
          'hp_max: 30',
          'conditions: []',
          'spell_slots: {}',
          'inventory: []',
          '---',
          '',
          '# Aragorn',
          '',
        ].join('\n');
        const parsed = projector.parseView(phase02Only);
        expect(parsed).not.toBeNull();
        // Phase 03 fields default to neutral values matching
        // INITIAL_CHARACTER_STATE — preserves backward compat with views
        // generated before this plan landed.
        expect(parsed!.temp_hp).toBe(0);
        expect(parsed!.death_saves).toEqual({ successes: 0, failures: 0 });
        expect(parsed!.flags).toEqual({ stable: false, dead: false, inspiration: false });
        expect(parsed!.concentrating_on).toBeNull();
        expect(parsed!.exhaustion_level).toBe(0);
        expect(parsed!.attunements).toEqual([]);
        expect(parsed!.equipped_focus).toBeNull();
        expect(parsed!.resources_used).toEqual({});
        expect(parsed!.xp).toBe(0);
        expect(parsed!.level).toBe(1);
      });

      it('byte-stable across two serializations of the same state', async () => {
        const { projector } = await importWithRoot(testRoot);
        const s = await freshState({
          temp_hp: 5,
          attunements: ['wand', 'amulet'],
          resources_used: { surge: 1, rage: 2 },
          concentrating_on: { spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
          equipped_focus: { kind: 'arcane', itemSlug: 'staff' },
        });
        const a = projector.serializeView(s);
        const b = projector.serializeView(s);
        expect(a).toBe(b);
        // Sorting invariants (spike 013 DR):
        // - attunements emitted alphabetically
        expect(a.indexOf('"amulet"')).toBeLessThan(a.indexOf('"wand"'));
        // - resources_used keys emitted alphabetically (rage < surge)
        expect(a.indexOf('"rage"')).toBeLessThan(a.indexOf('"surge"'));
      });
    });

    // -----------------------------------------------------------------------
    // replayEvents + byte-stable view: mixed Phase 02 + Phase 03 sequence
    // -----------------------------------------------------------------------

    describe('replayEvents + serializeView — byte-stable mixed-phase regression', () => {
      it('replays mixed Phase 02 + Phase 03 events twice and produces byte-identical view', async () => {
        const { projector } = await importWithRoot(testRoot);

        const seedEnv = makeEnvelope(
          'campaign_initialized',
          {
            characters: [
              { id: CHAR_A_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
            ],
          },
          'seed',
          '2026-05-25T10:00:00.000Z',
        );
        const events = [
          seedEnv,
          makeEnvelope(
            'hp_change',
            { character: CHAR_A_UUID, delta: -8 },
            'm1',
            '2026-05-25T10:00:01.000Z',
          ),
          makeEnvelope(
            'temp_hp_set',
            { character: CHAR_A_UUID, tempHp: 3 },
            'm2',
            '2026-05-25T10:00:02.000Z',
          ),
          makeEnvelope(
            'death_save_fail',
            { character: CHAR_A_UUID },
            'm3',
            '2026-05-25T10:00:03.000Z',
          ),
          makeEnvelope(
            'attune',
            { character: CHAR_A_UUID, itemSlug: 'amulet' },
            'm4',
            '2026-05-25T10:00:04.000Z',
          ),
          makeEnvelope(
            'attune',
            { character: CHAR_A_UUID, itemSlug: 'wand' },
            'm5',
            '2026-05-25T10:00:05.000Z',
          ),
          makeEnvelope(
            'concentration_set',
            { character: CHAR_A_UUID, spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
            'm6',
            '2026-05-25T10:00:06.000Z',
          ),
          makeEnvelope(
            'exhaustion_increment',
            { character: CHAR_A_UUID, source: 'forced_march' },
            'm7',
            '2026-05-25T10:00:07.000Z',
          ),
          makeEnvelope(
            'inspiration_grant',
            { character: CHAR_A_UUID },
            'm8',
            '2026-05-25T10:00:08.000Z',
          ),
          makeEnvelope(
            'resource_use',
            { character: CHAR_A_UUID, resourceKey: 'rage', uses: 1 },
            'm9',
            '2026-05-25T10:00:09.000Z',
          ),
          makeEnvelope(
            'xp_award',
            { character: CHAR_A_UUID, amount: 250, reason: 'monster' },
            'm10',
            '2026-05-25T10:00:10.000Z',
          ),
        ];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { chars: states1 } = projector.replayEvents(events as any);
        const view1 = projector.serializeView(states1.get(CHAR_A_UUID)!);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { chars: states2 } = projector.replayEvents(events as any);
        const view2 = projector.serializeView(states2.get(CHAR_A_UUID)!);

        expect(view1).toBe(view2); // byte-exact

        // Sanity assertions on the replayed state
        const s = states1.get(CHAR_A_UUID)!;
        expect(s.hp_current).toBe(22); // 30 - 8
        expect(s.temp_hp).toBe(3);
        expect(s.death_saves.failures).toBe(1);
        expect(s.attunements).toEqual(['amulet', 'wand']);
        expect(s.concentrating_on).toEqual({
          spellSlug: 'bless',
          slotLevel: 1,
          startedRound: 1,
        });
        expect(s.exhaustion_level).toBe(1);
        expect(s.conditions).toContain('exhaustion');
        expect(s.flags.inspiration).toBe(true);
        expect(s.resources_used).toEqual({ rage: 1 });
        expect(s.xp).toBe(250);
      });
    });
  });
});

// =====================================================================
// D-08 (Plan 09-01): cr propagation through applyEncounterEvent into
// EncounterState.monsters[].cr — additive, sourced only from the
// server-controlled monster_spawn event; cr-less logs replay byte-stable.
// Appended as a top-level describe (this file had no encounter-reducer
// tests on disk — the plan's read_first anchors were stale; the reducer
// is otherwise covered in combat-reducer.test.ts). See 09-01-SUMMARY.
// =====================================================================
describe('applyEncounterEvent — monster_spawn cr propagation (D-08)', () => {
  // Build a monster_spawn event without importing the VaultEvent union
  // (keeps this appended block self-contained against the existing imports).
  type EncEvent = Parameters<
    typeof import('@/ai/master/vault/projector')['applyEncounterEvent']
  >[1];
  const spawn = (payload: Record<string, unknown>): EncEvent =>
    ({ type: 'monster_spawn', payload } as unknown as EncEvent);

  it('copies cr into the monsters[] entry when provided', async () => {
    const { projector } = await importWithRoot('/tmp/test-vault-cr');
    const s = projector.applyEncounterEvent(
      projector.INITIAL_ENCOUNTER_STATE,
      spawn({ id: 'veyra-1', name: 'Veyra', hpMax: 30, cr: 3 }),
    );
    expect(s.monsters[0]!.cr).toBe(3);
  });

  it('copies a fractional cr (CR 1/4)', async () => {
    const { projector } = await importWithRoot('/tmp/test-vault-cr');
    const s = projector.applyEncounterEvent(
      projector.INITIAL_ENCOUNTER_STATE,
      spawn({ id: 'rat-1', name: 'Giant Rat', hpMax: 7, cr: 0.25 }),
    );
    expect(s.monsters[0]!.cr).toBe(0.25);
  });

  it('copies cr alongside ac and initiativeBonus', async () => {
    const { projector } = await importWithRoot('/tmp/test-vault-cr');
    const s = projector.applyEncounterEvent(
      projector.INITIAL_ENCOUNTER_STATE,
      spawn({ id: 'veyra-1', name: 'Veyra', hpMax: 30, ac: 15, initiativeBonus: 2, cr: 5 }),
    );
    expect(s.monsters[0]!.ac).toBe(15);
    expect(s.monsters[0]!.initiativeBonus).toBe(2);
    expect(s.monsters[0]!.cr).toBe(5);
  });

  it('produces no cr key when cr is absent (back-compat entry shape)', async () => {
    const { projector } = await importWithRoot('/tmp/test-vault-cr');
    const s = projector.applyEncounterEvent(
      projector.INITIAL_ENCOUNTER_STATE,
      spawn({ id: 'goblin-1', name: 'Goblin', hpMax: 7 }),
    );
    // Byte-identical to the pre-change entry shape — no spurious cr key.
    expect(s.monsters[0]).toEqual({
      id: 'goblin-1',
      name: 'Goblin',
      hpCurrent: 7,
      hpMax: 7,
      isAlive: true,
      conditions: [],
    });
    expect('cr' in s.monsters[0]!).toBe(false);
  });

  it('replays a cr-less event sequence byte-identical to the pre-change snapshot', async () => {
    const { projector } = await importWithRoot('/tmp/test-vault-cr');
    const events: EncEvent[] = [
      { type: 'combat_start', payload: {} } as unknown as EncEvent,
      spawn({ id: 'goblin-1', name: 'Goblin', hpMax: 7 }),
      {
        type: 'initiative_set',
        payload: { order: [{ actorId: 'goblin-1', initiative: 12 }] },
      } as unknown as EncEvent,
      { type: 'turn_advance', payload: {} } as unknown as EncEvent,
    ];
    let enc = projector.INITIAL_ENCOUNTER_STATE;
    for (const ev of events) {
      enc = projector.applyEncounterEvent(enc, ev);
    }
    // cr is purely additive: a cr-less log must serialize exactly as before —
    // no spurious cr key anywhere in the tree (proves no migration needed).
    // turn_advance over a length-1 turnOrder wraps: currentIdx 0->0, round 1->2.
    const expected = {
      active: true,
      round: 2,
      currentIdx: 0,
      turnOrder: [{ actorId: 'goblin-1', initiative: 12 }],
      monsters: [
        {
          id: 'goblin-1',
          name: 'Goblin',
          hpCurrent: 7,
          hpMax: 7,
          isAlive: true,
          conditions: [],
        },
      ],
    };
    expect(JSON.stringify(enc)).toBe(JSON.stringify(expected));
  });
});


// =====================================================================
// Phase 08-02 — deduplicateMonsterNames (RED tests, 2026-06-01)
//
// When >=2 monsters in an encounter share the same base name, they must
// ALL be numbered: "Base 1", "Base 2", "Base 3" (the first is numbered
// too — never "Base", "Base 2", "Base 3").
// A lone monster with a unique base name stays unnumbered.
// The function is PURE and does NOT mutate the EncounterState.
// Ids are left untouched — only the name field is deduped.
// =====================================================================
describe("deduplicateMonsterNames — unique naming (Phase 08-02)", () => {
  type EncState = typeof import("@/ai/master/vault/projector")["INITIAL_ENCOUNTER_STATE"];

  it("3 same-base spawns → name 1 / name 2 / name 3 (first also numbered)", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    const enc: EncState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [],
      monsters: [
        { id: "pirata-buggy-1", name: "Pirata di Buggy", hpCurrent: 20, hpMax: 20, isAlive: true, conditions: [] },
        { id: "pirata-buggy-2", name: "Pirata di Buggy", hpCurrent: 20, hpMax: 20, isAlive: true, conditions: [] },
        { id: "pirata-buggy-3", name: "Pirata di Buggy", hpCurrent: 20, hpMax: 20, isAlive: true, conditions: [] },
      ],
    };
    const result = projector.deduplicateMonsterNames(enc);
    expect(result.monsters.map((m) => m.name)).toEqual([
      "Pirata di Buggy 1",
      "Pirata di Buggy 2",
      "Pirata di Buggy 3",
    ]);
  });

  it("single monster with unique name → stays unnumbered", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    const enc: EncState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [],
      monsters: [
        { id: "goblin-1", name: "Goblin", hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] },
      ],
    };
    const result = projector.deduplicateMonsterNames(enc);
    expect(result.monsters[0]!.name).toBe("Goblin");
  });

  it("mixed: 2 Goblin + 1 Orc → Goblin 1, Goblin 2, Orc (Orc stays unnumbered)", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    const enc: EncState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [],
      monsters: [
        { id: "goblin-1", name: "Goblin", hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] },
        { id: "goblin-2", name: "Goblin", hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] },
        { id: "orc-1", name: "Orc", hpCurrent: 15, hpMax: 15, isAlive: true, conditions: [] },
      ],
    };
    const result = projector.deduplicateMonsterNames(enc);
    expect(result.monsters.map((m) => m.name)).toEqual(["Goblin 1", "Goblin 2", "Orc"]);
  });

  it("ids are left untouched after deduplication", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    const enc: EncState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [],
      monsters: [
        { id: "pirata-buggy-1", name: "Pirata di Buggy", hpCurrent: 20, hpMax: 20, isAlive: true, conditions: [] },
        { id: "pirata-buggy-2", name: "Pirata di Buggy", hpCurrent: 20, hpMax: 20, isAlive: true, conditions: [] },
      ],
    };
    const result = projector.deduplicateMonsterNames(enc);
    expect(result.monsters[0]!.id).toBe("pirata-buggy-1");
    expect(result.monsters[1]!.id).toBe("pirata-buggy-2");
  });

  it("does NOT mutate the original encounter state", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    const enc: EncState = {
      active: true,
      round: 1,
      currentIdx: 0,
      turnOrder: [],
      monsters: [
        { id: "rat-1", name: "Rat", hpCurrent: 5, hpMax: 5, isAlive: true, conditions: [] },
        { id: "rat-2", name: "Rat", hpCurrent: 5, hpMax: 5, isAlive: true, conditions: [] },
      ],
    };
    projector.deduplicateMonsterNames(enc);
    // original names must be unchanged
    expect(enc.monsters[0]!.name).toBe("Rat");
    expect(enc.monsters[1]!.name).toBe("Rat");
  });

  it("applyEncounterEvent monster_spawn: 3 same-base spawns produce unique names in state", async () => {
    const { projector } = await importWithRoot("/tmp/test-dedup");
    type EncEvent = Parameters<typeof projector.applyEncounterEvent>[1];
    const spawn = (id: string, name: string): EncEvent =>
      ({ type: "monster_spawn", payload: { id, name, hpMax: 20 } } as unknown as EncEvent);

    let enc = projector.INITIAL_ENCOUNTER_STATE;
    enc = projector.applyEncounterEvent(enc, spawn("pirata-buggy-1", "Pirata di Buggy"));
    enc = projector.applyEncounterEvent(enc, spawn("pirata-buggy-2", "Pirata di Buggy"));
    enc = projector.applyEncounterEvent(enc, spawn("pirata-buggy-3", "Pirata di Buggy"));

    expect(enc.monsters.map((m) => m.name)).toEqual([
      "Pirata di Buggy 1",
      "Pirata di Buggy 2",
      "Pirata di Buggy 3",
    ]);
  });
});

// ─── 2026-06-10 audit: hp_change RAW damage pipeline (rules.md §3.17–3.21) ──

describe('applyEvent — hp_change RAW pipeline (2026-06-10 audit)', () => {
  let applyEvent: typeof import('@/ai/master/vault/projector').applyEvent;
  let INITIAL_CHARACTER_STATE: typeof import('@/ai/master/vault/projector').INITIAL_CHARACTER_STATE;
  beforeEach(async () => {
    ({ applyEvent, INITIAL_CHARACTER_STATE } = await import('@/ai/master/vault/projector'));
  });
  const base = (over: Partial<import('@/ai/master/vault/projector').CharacterState> = {}) => ({
    ...INITIAL_CHARACTER_STATE({ id: 'c1', name: 'Nami', hp_max: 20, hp_current: 20 }),
    ...over,
  });
  const hp = (delta: number) => ({ type: 'hp_change', payload: { character: 'c1', delta } }) as never;

  it('temp HP absorbs damage first (PHB §3.21)', () => {
    const s = applyEvent(base({ temp_hp: 5 }), hp(-3));
    expect(s.temp_hp).toBe(2);
    expect(s.hp_current).toBe(20); // fully absorbed
    const s2 = applyEvent(base({ temp_hp: 5 }), hp(-8));
    expect(s2.temp_hp).toBe(0);
    expect(s2.hp_current).toBe(17); // 3 spill through
  });

  it('dropping to 0 ⇒ unconscious + dying (death saves reset, not stable)', () => {
    const s = applyEvent(base({ hp_current: 5 }), hp(-5));
    expect(s.hp_current).toBe(0);
    expect(s.conditions).toContain('unconscious');
    expect(s.flags.dead).toBe(false);
    expect(s.flags.stable).toBe(false);
    expect(s.death_saves).toEqual({ successes: 0, failures: 0 });
  });

  it('massive damage ⇒ instant death (overkill >= hp_max, PHB §3.17)', () => {
    // 5 HP left, 25 damage → overkill 20 >= hp_max 20 → dead, not dying.
    const s = applyEvent(base({ hp_current: 5 }), hp(-25));
    expect(s.hp_current).toBe(0);
    expect(s.flags.dead).toBe(true);
    expect(s.conditions).not.toContain('unconscious');
  });

  it('damage while at 0 ⇒ one automatic death-save failure; third kills (PHB §3.18)', () => {
    let s = applyEvent(base({ hp_current: 0, conditions: ['unconscious'] }), hp(-4));
    expect(s.death_saves.failures).toBe(1);
    expect(s.flags.dead).toBe(false);
    s = applyEvent(s, hp(-4));
    s = applyEvent(s, hp(-4));
    expect(s.death_saves.failures).toBe(3);
    expect(s.flags.dead).toBe(true);
  });

  it('healing from 0 wakes the PC: unconscious dropped, death saves reset', () => {
    const dying = applyEvent(base({ hp_current: 3 }), hp(-3));
    const partlyFailed = applyEvent(dying, hp(-1)); // 1 death-save failure
    const healed = applyEvent(partlyFailed, hp(+7));
    expect(healed.hp_current).toBe(7);
    expect(healed.conditions).not.toContain('unconscious');
    expect(healed.death_saves).toEqual({ successes: 0, failures: 0 });
    expect(healed.flags.stable).toBe(false);
  });

  it('hp_change cannot revive the dead', () => {
    const dead = applyEvent(base({ hp_current: 1 }), hp(-30)); // massive damage
    expect(dead.flags.dead).toBe(true);
    const after = applyEvent(dead, hp(+10));
    expect(after.hp_current).toBe(0);
    expect(after.flags.dead).toBe(true);
  });

  it('ordinary damage and heal still clamp to [0, hp_max]', () => {
    expect(applyEvent(base(), hp(-7)).hp_current).toBe(13);
    expect(applyEvent(base({ hp_current: 18 }), hp(+10)).hp_current).toBe(20);
  });
});
