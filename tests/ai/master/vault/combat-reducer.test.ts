/**
 * Phase 06 D1 — Combat reducer tests (headless, no LLM).
 *
 * Verifies the encounter-scoped event pipeline added in plan 06-01:
 *   - EncounterState pure reducer (applyEncounterEvent)
 *   - replayEvents returns { chars, encounter }
 *   - serializeCombatView emits byte-stable frontmatter
 *   - regenerateCombatView writes combat.md to the campaign dir
 *
 * No DATABASE_URL required: all imports are filesystem-only (projector,
 * events-schema, campaign-paths). The test uses tmp dirs + vi.stubEnv so
 * VAULT_CAMPAIGNS_ROOT can be reset per test.
 *
 * Test suites:
 *   A — step-by-step reducer (12-event sequence, assertions at each prefix)
 *   B — defensive / edge cases (out-of-order, unknown id, empty turnOrder)
 *   C — combat.md round-trip (serialize → parse frontmatter → assert fields)
 *   D — replay determinism (10 replays → identical JSON.stringify output)
 *   E — regression: no-combat_start events.md (chars Map still works)
 *   F — ENCOUNTER_EVENT_TYPES membership
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Build a VaultEventEnvelope with deterministic metadata. */
function makeEnv(type: string, payload: Record<string, unknown>, suffix = '1'): VaultEventEnvelope {
  return {
    id: `test-${type}-${suffix}`,
    version: 1,
    type: type as VaultEventEnvelope['type'],
    payload: payload as VaultEventEnvelope['payload'],
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

// The 12-event encounter sequence used in suites A and D.
const E1 = makeEnv('combat_start', {});
const E2 = makeEnv('monster_spawn', { id: 'goblin-1', name: 'Goblin', hpMax: 7 });
const E3 = makeEnv('monster_spawn', { id: 'goblin-2', name: 'Goblin Scout', hpMax: 7, ac: 13, initiativeBonus: 2 }, '2');
const E4 = makeEnv('initiative_set', {
  order: [
    { actorId: 'pc-uuid-1', initiative: 18 },
    { actorId: 'goblin-1', initiative: 14 },
    { actorId: 'goblin-2', initiative: 12 },
  ],
});
const E5 = makeEnv('turn_advance', {}, '1');
const E6 = makeEnv('turn_advance', {}, '2');
const E7 = makeEnv('turn_advance', {}, '3');  // idx 2 → 0, round 1 → 2
const E8 = makeEnv('monster_hp_change', { id: 'goblin-1', delta: -5 }, '1');
const E9 = makeEnv('monster_hp_change', { id: 'goblin-1', delta: -5 }, '2'); // 2 → 0, isAlive → false
const E10 = makeEnv('monster_hp_change', { id: 'goblin-1', delta: -3 }, '3'); // dead, stays at 0
const E11 = makeEnv('monster_hp_change', { id: 'goblin-1', delta: 4 }, '4');  // healing dead → isAlive:true
const E12 = makeEnv('combat_end', {});
const FULL_SEQUENCE = [E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11, E12];

// -------------------------------------------------------------------------
// Dynamic import helper (re-reads env at module-load time)
// -------------------------------------------------------------------------

type ProjectorModule = typeof import('@/ai/master/vault/projector');
type EventsSchemaModule = typeof import('@/ai/master/vault/events-schema');

async function importModules(root: string): Promise<{
  projector: ProjectorModule;
  schema: EventsSchemaModule;
}> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  const [projector, schema] = await Promise.all([
    import('@/ai/master/vault/projector'),
    import('@/ai/master/vault/events-schema'),
  ]);
  return { projector, schema };
}

// -------------------------------------------------------------------------
// Suite A — step-by-step reducer
// -------------------------------------------------------------------------

describe('EncounterState reducer: step-by-step', () => {
  it('E1 combat_start: active=true, round=1, currentIdx=0, turnOrder=[], monsters=[]', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1]);
    expect(encounter.active).toBe(true);
    expect(encounter.round).toBe(1);
    expect(encounter.currentIdx).toBe(0);
    expect(encounter.turnOrder).toEqual([]);
    expect(encounter.monsters).toEqual([]);
  });

  it('E1+E2 monster_spawn: appends goblin-1', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2]);
    expect(encounter.monsters).toHaveLength(1);
    const m = encounter.monsters[0]!;
    expect(m.id).toBe('goblin-1');
    expect(m.name).toBe('Goblin');
    expect(m.hpCurrent).toBe(7);
    expect(m.hpMax).toBe(7);
    expect(m.isAlive).toBe(true);
    expect(m.conditions).toEqual([]);
  });

  it('E1+E2+E3 monster_spawn: appends goblin-2 with ac and initiativeBonus', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2, E3]);
    expect(encounter.monsters).toHaveLength(2);
    const m2 = encounter.monsters[1]!;
    expect(m2.id).toBe('goblin-2');
    expect(m2.ac).toBe(13);
    expect(m2.initiativeBonus).toBe(2);
  });

  it('E1+E2+E3+E4 initiative_set: turnOrder set, currentIdx=0', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2, E3, E4]);
    expect(encounter.turnOrder).toHaveLength(3);
    expect(encounter.turnOrder[0]!.actorId).toBe('pc-uuid-1');
    expect(encounter.turnOrder[0]!.initiative).toBe(18);
    expect(encounter.currentIdx).toBe(0);
  });

  it('E5 turn_advance: currentIdx=1', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 5));
    expect(encounter.currentIdx).toBe(1);
  });

  it('E6 turn_advance: currentIdx=2', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 6));
    expect(encounter.currentIdx).toBe(2);
  });

  it('E7 turn_advance (wrap): currentIdx=0, round=2', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 7));
    expect(encounter.currentIdx).toBe(0);
    expect(encounter.round).toBe(2);
  });

  it('E8 monster_hp_change -5: goblin-1 hpCurrent=2', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 8));
    expect(encounter.monsters[0]!.hpCurrent).toBe(2);
  });

  it('E9 monster_hp_change -5: goblin-1 hpCurrent=0, isAlive=false', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 9));
    expect(encounter.monsters[0]!.hpCurrent).toBe(0);
    expect(encounter.monsters[0]!.isAlive).toBe(false);
  });

  it('E10 monster_hp_change -3 when dead: hpCurrent stays 0 (clamped)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 10));
    expect(encounter.monsters[0]!.hpCurrent).toBe(0);
    expect(encounter.monsters[0]!.isAlive).toBe(false);
  });

  it('E11 monster_hp_change +4 on dead: hpCurrent=4, isAlive=true (healing restores)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE.slice(0, 11));
    expect(encounter.monsters[0]!.hpCurrent).toBe(4);
    expect(encounter.monsters[0]!.isAlive).toBe(true);
  });

  it('E12 combat_end: active=false', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents(FULL_SEQUENCE);
    expect(encounter.active).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Suite A2 — Phase 08 lifecycle hardening (operator smoke 2026-05-30)
//   Fix A: turn_advance skips dead monster actors (no stall on a corpse).
//   Fix B: monster_spawn resets an all-dead active encounter (new fight).
// -------------------------------------------------------------------------

describe('EncounterState reducer: Phase 08 lifecycle hardening', () => {
  const cs = makeEnv('combat_start', {});
  const spawnM1 = makeEnv('monster_spawn', { id: 'm1', name: 'Veyra', hpMax: 10, ac: 14 }, 'm1');
  const spawnM2 = makeEnv('monster_spawn', { id: 'm2', name: 'Slime', hpMax: 10, ac: 12 }, 'm2');
  const init3 = makeEnv('initiative_set', {
    order: [
      { actorId: 'pc-1', initiative: 20 },
      { actorId: 'm1', initiative: 14 },
      { actorId: 'm2', initiative: 10 },
    ],
  }, 'i3');
  const init2 = makeEnv('initiative_set', {
    order: [
      { actorId: 'pc-1', initiative: 20 },
      { actorId: 'm1', initiative: 14 },
    ],
  }, 'i2');
  const killM1 = makeEnv('monster_hp_change', { id: 'm1', delta: -10 }, 'k1'); // m1 → 0, dead

  // --- Fix A ---
  it('turn_advance SKIPS a dead monster actor (PC@0 → dead m1@1 → lands m2@2)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const adv = makeEnv('turn_advance', {}, 'aA');
    const enc = projector.replayEvents([cs, spawnM1, spawnM2, init3, killM1, adv]).encounter;
    expect(enc.currentIdx).toBe(2); // not 1 (the dead m1) — that would stall
    expect(enc.turnOrder[enc.currentIdx]!.actorId).toBe('m2');
  });

  it('turn_advance skips a dead monster and WRAPS to the PC (round increments)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const adv = makeEnv('turn_advance', {}, 'aB');
    const enc = projector.replayEvents([cs, spawnM1, init2, killM1, adv]).encounter;
    expect(enc.currentIdx).toBe(0); // back to the PC
    expect(enc.round).toBe(2); // wrapped past idx 0
  });

  it('turn_advance does NOT skip a LIVE monster (regression — monster turns still run)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const adv = makeEnv('turn_advance', {}, 'aC');
    const enc = projector.replayEvents([cs, spawnM1, init2, adv]).encounter; // m1 alive
    expect(enc.currentIdx).toBe(1);
    expect(enc.turnOrder[enc.currentIdx]!.actorId).toBe('m1');
  });

  // --- Fix B ---
  it('monster_spawn into an ALL-DEAD active encounter RESETS (discards corpses)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const spawnM3 = makeEnv('monster_spawn', { id: 'm3', name: 'Drake', hpMax: 20 }, 'm3a');
    const enc = projector.replayEvents([cs, spawnM1, killM1, spawnM3]).encounter;
    expect(enc.monsters).toHaveLength(1);
    expect(enc.monsters[0]!.id).toBe('m3');
    expect(enc.monsters[0]!.isAlive).toBe(true);
    expect(enc.turnOrder).toHaveLength(0); // the reset cleared the stale order
  });

  it('monster_spawn with a LIVE monster present APPENDS (reinforcement, not reset)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const spawnM3 = makeEnv('monster_spawn', { id: 'm3', name: 'Drake', hpMax: 20 }, 'm3b');
    const enc = projector.replayEvents([cs, spawnM1, spawnM2, killM1, spawnM3]).encounter; // m2 alive
    expect(enc.monsters.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

// -------------------------------------------------------------------------
// Suite B — defensive / edge cases
// -------------------------------------------------------------------------

describe('EncounterState reducer: defensive / edge cases', () => {
  it('monster_hp_change on unknown id does not throw and returns state unchanged', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const unknown = makeEnv('monster_hp_change', { id: 'nonexistent-monster', delta: -99 });
    const after = projector.replayEvents([E1, E2, unknown]).encounter;
    expect(after.monsters).toHaveLength(1);
    expect(after.monsters[0]!.hpCurrent).toBe(7); // unchanged
  });

  it('turn_advance with empty turnOrder does not throw and returns state unchanged', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const advance = makeEnv('turn_advance', {});
    // E1 gives active=true, turnOrder=[]
    const enc = projector.replayEvents([E1, advance]).encounter;
    expect(enc.currentIdx).toBe(0);
    expect(enc.round).toBe(1);
  });

  // Robustness (2026-05-29): local models (qwen3/gemma4) emit monster_spawn +
  // initiative_set but frequently SKIP combat_start. The reducer auto-activates
  // on the first combat event so a skipped combat_start no longer leaves the
  // encounter inactive/invisible.
  it('initiative_set before combat_start AUTO-ACTIVATES the encounter', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const enc = projector.replayEvents([E4]).encounter;
    expect(enc.active).toBe(true);
    expect(enc.turnOrder.length).toBeGreaterThan(0);
    expect(enc.round).toBe(1);
  });

  it('monster_spawn before combat_start AUTO-ACTIVATES the encounter', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const enc = projector.replayEvents([E2]).encounter;
    expect(enc.active).toBe(true);
    expect(enc.monsters).toHaveLength(1);
  });

  it('combat_end on already-inactive encounter: active stays false (idempotent)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const enc = projector.replayEvents([E12]).encounter;
    expect(enc.active).toBe(false);
  });

  it('duplicate monster_spawn (same id) is idempotent', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const enc = projector.replayEvents([E1, E2, E2]).encounter;
    expect(enc.monsters).toHaveLength(1); // second spawn skipped
  });
});

// -------------------------------------------------------------------------
// Suite C — combat.md round-trip
// -------------------------------------------------------------------------

describe('combat.md round-trip', () => {
  it('serializeCombatView(INITIAL_ENCOUNTER_STATE) contains "active: false"', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const view = projector.serializeCombatView(projector.INITIAL_ENCOUNTER_STATE);
    expect(view).toContain('active: false');
  });

  it('active encounter serializes round, currentIdx, and monster ids', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2, E3, E4]);
    const view = projector.serializeCombatView(encounter);
    expect(view).toContain('active: true');
    expect(view).toContain('goblin-1');
    expect(view).toContain('goblin-2');
    // Parse round and currentIdx from the frontmatter
    const lines = view.split('\n');
    const roundLine = lines.find((l) => l.startsWith('round:'));
    const idxLine = lines.find((l) => l.startsWith('currentIdx:'));
    expect(roundLine).toBeDefined();
    expect(idxLine).toBeDefined();
    expect(roundLine).toContain('1');
    expect(idxLine).toContain('0');
  });

  it('serialized view is wrapped in --- delimiters', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2]);
    const view = projector.serializeCombatView(encounter);
    expect(view.startsWith('---')).toBe(true);
    expect(view).toContain('\n---\n');
  });

  it('serializeCombatView is byte-stable: same input → same output', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const { encounter } = projector.replayEvents([E1, E2, E3, E4]);
    const a = projector.serializeCombatView(encounter);
    const b = projector.serializeCombatView(encounter);
    expect(a).toBe(b);
  });
});

// -------------------------------------------------------------------------
// Suite D — replay determinism
// -------------------------------------------------------------------------

describe('Replay determinism', () => {
  it('same events.md replayed 10 times yields identical EncounterState', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { encounter } = projector.replayEvents(FULL_SEQUENCE);
      results.push(JSON.stringify(encounter));
    }
    const first = results[0]!;
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(first);
    }
  });
});

// -------------------------------------------------------------------------
// Suite E — regression: no-combat_start events.md
// -------------------------------------------------------------------------

const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const CHAR_A_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Regression: no-combat_start events.md', () => {
  it('character reducer still works; encounter is INITIAL (active=false)', async () => {
    const { projector } = await importModules('/tmp/test-vault');
    const seedEnv = makeEnv('campaign_initialized', {
      characters: [{ id: CHAR_A_UUID, name: 'Aria', hp_max: 20 }],
    });
    const hpEnv = makeEnv('hp_change', { character: CHAR_A_UUID, delta: -5 });
    const condEnv = makeEnv('condition_add', { character: CHAR_A_UUID, condition: 'poisoned' });
    const { chars, encounter } = projector.replayEvents([seedEnv, hpEnv, condEnv]);
    // Character reducer still works
    expect(chars.size).toBe(1);
    const charState = chars.get(CHAR_A_UUID)!;
    expect(charState.hp_current).toBe(15);
    expect(charState.conditions).toContain('poisoned');
    // Encounter reducer stays at initial state
    expect(encounter.active).toBe(false);
    expect(encounter.monsters).toHaveLength(0);
    expect(encounter.round).toBe(0);
  });
});

// -------------------------------------------------------------------------
// Suite F — ENCOUNTER_EVENT_TYPES membership
// -------------------------------------------------------------------------

describe('ENCOUNTER_EVENT_TYPES membership', () => {
  it('contains all 6 encounter type strings', async () => {
    const { schema } = await importModules('/tmp/test-vault');
    const expected = ['combat_start', 'monster_spawn', 'initiative_set', 'turn_advance', 'monster_hp_change', 'combat_end'];
    for (const t of expected) {
      expect(schema.ENCOUNTER_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it('does NOT contain character event types', async () => {
    const { schema } = await importModules('/tmp/test-vault');
    expect(schema.ENCOUNTER_EVENT_TYPES.has('hp_change')).toBe(false);
    expect(schema.ENCOUNTER_EVENT_TYPES.has('campaign_initialized')).toBe(false);
    expect(schema.ENCOUNTER_EVENT_TYPES.has('condition_add')).toBe(false);
    expect(schema.ENCOUNTER_EVENT_TYPES.has('xp_award')).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Suite G — regenerateCombatView disk write
// -------------------------------------------------------------------------

describe('regenerateCombatView: disk write', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'combat-reducer-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('writes combat.md to campaignDir after encounter events', async () => {
    const { projector } = await importModules(tmpDir);
    const { writeFile, mkdir: mkdirFs } = await import('node:fs/promises');
    const { eventsPath, campaignDir } = await import('@/ai/master/vault/campaign-paths');

    // Write events.md with a small encounter sequence
    const evPath = eventsPath(CAMPAIGN_UUID);
    await mkdirFs(join(tmpDir, CAMPAIGN_UUID), { recursive: true });
    const lines = [E1, E2, E3, E4].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(evPath, lines, 'utf8');

    await projector.regenerateCombatView(CAMPAIGN_UUID);

    const combatPath = join(campaignDir(CAMPAIGN_UUID), 'combat.md');
    expect(existsSync(combatPath)).toBe(true);
    const content = readFileSync(combatPath, 'utf8');
    expect(content).toContain('active: true');
    expect(content).toContain('goblin-1');
    expect(content).toContain('goblin-2');
  });

  it('regenerateAffectedViews routes encounter events to regenerateCombatView', async () => {
    const { projector } = await importModules(tmpDir);
    const { writeFile, mkdir: mkdirFs } = await import('node:fs/promises');
    const { eventsPath, campaignDir } = await import('@/ai/master/vault/campaign-paths');

    await mkdirFs(join(tmpDir, CAMPAIGN_UUID), { recursive: true });
    // Write the start event
    const lines = [E1].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(eventsPath(CAMPAIGN_UUID), lines, 'utf8');

    // Simulate the dispatcher hook with a combat_start envelope
    await projector.regenerateAffectedViews(CAMPAIGN_UUID, E1);

    const combatPath = join(campaignDir(CAMPAIGN_UUID), 'combat.md');
    expect(existsSync(combatPath)).toBe(true);
    const content = readFileSync(combatPath, 'utf8');
    expect(content).toContain('active: true');
  });
});
