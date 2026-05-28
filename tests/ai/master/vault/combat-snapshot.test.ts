/**
 * Phase 06 Plan 02 — combat-snapshot tests.
 *
 * Verifies the headless snapshot-shape pipeline for vault campaigns:
 *   A. CombatActorRow mapping: mid-encounter — correct field-by-field mapping
 *   B. CombatActorRow mapping: condition present — string[] → condition object[]
 *   C. CombatActorRow mapping: monster not in turnOrder → initiative defaults to 0
 *   D. buildVaultActors: no active encounter → empty array
 *   E. Snapshot combat fields: inCombat + combat shape via translateCharacterState
 *
 * HEADLESS CONTRACT:
 *   - No DATABASE_URL required — no Drizzle DB types that need a connection.
 *   - No real campaign on disk — EncounterState is constructed in-test.
 *   - Tests import pure mapping functions exported from client-snapshot.ts
 *     (buildVaultActors) and use the public materializeFromVault API for
 *     the combat-field shape tests (which requires a real tmpdir + events.md).
 *   - Do NOT flip any real campaign's sourceOfTruth (D2 operator step).
 *
 * LOCKED snapshot mapping (06-CONTEXT.md §"EncounterState + view"):
 *   state.inCombat = encounter.active
 *   state.combat   = active ? { round, currentIdx, turnOrder } : null
 *   actors         = encounter.monsters mapped to CombatActorRow shape
 *   per-actor initiative from matching turnOrder entry; default 0
 *   monsterSlug: null (bestiary is D2)
 *   conditions: string[] → { slug, source:'vault-encounter', durationRounds:'until_removed', appliedRound:0 }[]
 *   PCs NOT in actors (CombatTracker looks them up from the party snapshot)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVaultActors } from '@/sessions/client-snapshot';
import type { EncounterState } from '@/ai/master/vault/projector';
import type { CombatActorRow } from '@/sessions/client-types';

// ---------------------------------------------------------------------------
// Shared fixture factories
// ---------------------------------------------------------------------------

/** Build a minimal EncounterState mid-encounter. */
function makeMidEncounter(
  overrides: Partial<EncounterState> = {},
): EncounterState {
  return {
    active: true,
    round: 2,
    currentIdx: 0,
    turnOrder: [
      { actorId: 'pc-uuid-1', initiative: 18 },
      { actorId: 'goblin-1', initiative: 14 },
    ],
    monsters: [
      {
        id: 'goblin-1',
        name: 'Goblin',
        hpCurrent: 4,
        hpMax: 7,
        ac: 13,
        isAlive: true,
        conditions: [],
      },
    ],
    ...overrides,
  };
}

const SESSION_ID = 'session-uuid-1';

// ---------------------------------------------------------------------------
// Suite A — CombatActorRow mapping: mid-encounter
// ---------------------------------------------------------------------------

describe('Suite A — CombatActorRow mapping: mid-encounter', () => {
  it('maps one monster; PCs are NOT included in actors', () => {
    const encounter = makeMidEncounter();
    const result = buildVaultActors(encounter, SESSION_ID);

    // The encounter has 2 entries in turnOrder (1 PC + 1 monster) but only
    // 1 monster in encounter.monsters. Actors should contain only the monster.
    expect(result).toHaveLength(1);
  });

  it('maps monster id', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.id).toBe('goblin-1');
  });

  it('maps sessionId', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.sessionId).toBe(SESSION_ID);
  });

  it('maps monster name', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.name).toBe('Goblin');
  });

  it('monsterSlug is null (D1 — bestiary is D2)', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.monsterSlug).toBeNull();
  });

  it('maps hpCurrent', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.hpCurrent).toBe(4);
  });

  it('maps hpMax', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.hpMax).toBe(7);
  });

  it('sources initiative from matching turnOrder entry (goblin-1 → 14)', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    // turnOrder has { actorId:'goblin-1', initiative:14 }
    expect(result[0]!.initiative).toBe(14);
  });

  it('maps isAlive', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.isAlive).toBe(true);
  });

  it('maps empty conditions array', () => {
    const result = buildVaultActors(makeMidEncounter(), SESSION_ID);
    expect(result[0]!.conditions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite B — CombatActorRow mapping: condition present
// ---------------------------------------------------------------------------

describe('Suite B — CombatActorRow mapping: condition present', () => {
  function monsterWithConditions(...slugs: string[]): EncounterState {
    return makeMidEncounter({
      monsters: [
        {
          id: 'goblin-1',
          name: 'Goblin',
          hpCurrent: 4,
          hpMax: 7,
          isAlive: true,
          conditions: slugs,
        },
      ],
    });
  }

  it('maps two conditions to condition objects', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions).toHaveLength(2);
  });

  it('first condition slug is "blinded"', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions[0]!.slug).toBe('blinded');
  });

  it('condition source is "vault-encounter"', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions[0]!.source).toBe('vault-encounter');
  });

  it('condition durationRounds is "until_removed"', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions[0]!.durationRounds).toBe('until_removed');
  });

  it('condition appliedRound is 0', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions[0]!.appliedRound).toBe(0);
  });

  it('second condition maps correctly', () => {
    const result = buildVaultActors(
      monsterWithConditions('blinded', 'poisoned'),
      SESSION_ID,
    );
    expect(result[0]!.conditions[1]!.slug).toBe('poisoned');
  });

  it('condition objects satisfy the CombatActorRow.conditions shape', () => {
    // Structural type check — every condition object has all required fields.
    const result = buildVaultActors(
      monsterWithConditions('frightened'),
      SESSION_ID,
    );
    const cond: CombatActorRow['conditions'][number] = result[0]!.conditions[0]!;
    expect(typeof cond.slug).toBe('string');
    expect(typeof cond.source).toBe('string');
    expect(typeof cond.appliedRound).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Suite C — CombatActorRow mapping: monster not in turnOrder → initiative = 0
// ---------------------------------------------------------------------------

describe('Suite C — monster not in turnOrder → initiative defaults to 0', () => {
  it('returns initiative 0 when monster id has no matching turnOrder entry', () => {
    const encounter = makeMidEncounter({
      turnOrder: [
        // goblin-1 is NOT in this turnOrder (only PC is)
        { actorId: 'pc-uuid-1', initiative: 18 },
      ],
      monsters: [
        {
          id: 'goblin-1',
          name: 'Goblin',
          hpCurrent: 4,
          hpMax: 7,
          isAlive: true,
          conditions: [],
        },
      ],
    });
    const result = buildVaultActors(encounter, SESSION_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.initiative).toBe(0);
  });

  it('does not throw when turnOrder is empty', () => {
    const encounter = makeMidEncounter({
      turnOrder: [],
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
    });
    expect(() => buildVaultActors(encounter, SESSION_ID)).not.toThrow();
    const result = buildVaultActors(encounter, SESSION_ID);
    expect(result[0]!.initiative).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite D — buildVaultActors: no active encounter → empty array
// ---------------------------------------------------------------------------

describe('Suite D — buildVaultActors: no active encounter → empty array', () => {
  it('returns empty array when encounter.active is false', () => {
    const encounter: EncounterState = {
      active: false,
      round: 0,
      currentIdx: 0,
      turnOrder: [],
      monsters: [],
    };
    const result = buildVaultActors(encounter, SESSION_ID);
    expect(result).toHaveLength(0);
  });

  it('returns empty array even when encounter has monsters but active is false', () => {
    // Edge case: encounter was ended (combat_end) but reducer left monsters in
    // the state for historical reference. buildVaultActors must still return [].
    const encounter: EncounterState = {
      active: false,
      round: 3,
      currentIdx: 1,
      turnOrder: [{ actorId: 'goblin-1', initiative: 12 }],
      monsters: [
        {
          id: 'goblin-1',
          name: 'Goblin',
          hpCurrent: 0,
          hpMax: 7,
          isAlive: false,
          conditions: [],
        },
      ],
    };
    expect(buildVaultActors(encounter, SESSION_ID)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite E — Snapshot combat fields: inCombat + combat shape via vault replay
//
// This suite tests the materializeFromVault end-to-end (events.md → state)
// to assert that inCombat and combat reflect encounter events. It uses a real
// tmpdir + events.md pattern (same as snapshot-reader.test.ts) but imports
// NO Drizzle DB types and requires NO DATABASE_URL.
// ---------------------------------------------------------------------------

const CAMPAIGN_UUID_E = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CHAR_UUID_E     = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SESSION_UUID_E  = 'ssssssss-ssss-ssss-ssss-ssssssssssss';

type SnapshotReaderModule = typeof import('@/ai/master/vault/snapshot-reader');
type CampaignPathsModule  = typeof import('@/ai/master/vault/campaign-paths');

async function importWithRoot(root: string): Promise<{
  reader: SnapshotReaderModule;
  paths:  CampaignPathsModule;
}> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  const [reader, paths] = await Promise.all([
    import('@/ai/master/vault/snapshot-reader'),
    import('@/ai/master/vault/campaign-paths'),
  ]);
  return { reader, paths };
}

function envelope(type: string, payload: Record<string, unknown>, id: string) {
  return { id, version: 1, type, payload, timestamp: '2026-05-28T10:00:00.000Z' };
}

function writeEvents(
  paths: CampaignPathsModule,
  campaignId: string,
  envelopes: ReturnType<typeof envelope>[],
): void {
  const dir = paths.campaignDir(campaignId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    paths.eventsPath(campaignId),
    envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

/** Standard seed for CHAR_UUID_E. */
function seedEnv() {
  return envelope(
    'campaign_initialized',
    {
      characters: [
        { id: CHAR_UUID_E, name: 'Aria', hp_max: 20, hp_current: 20 },
      ],
    },
    'seed-e1',
  );
}

describe('Suite E — Snapshot combat fields: inCombat + combat shape (end-to-end)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gsd-combat-snapshot-e-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('mid-encounter: state.inCombat is true', async () => {
    const { reader, paths } = await importWithRoot(testRoot);
    writeEvents(paths, CAMPAIGN_UUID_E, [
      seedEnv(),
      envelope('combat_start', {}, 'cs1'),
      envelope('monster_spawn', { id: 'orc-1', name: 'Orc', hpMax: 15 }, 'ms1'),
      envelope(
        'initiative_set',
        { order: [{ actorId: CHAR_UUID_E, initiative: 20 }, { actorId: 'orc-1', initiative: 8 }] },
        'is1',
      ),
    ]);

    const r = await reader.materializeFromVault(CAMPAIGN_UUID_E, CHAR_UUID_E, SESSION_UUID_E);
    expect(r).not.toBeNull();
    expect(r!.state.inCombat).toBe(true);
  });

  it('mid-encounter: state.combat has round, currentIdx, turnOrder', async () => {
    const { reader, paths } = await importWithRoot(testRoot);
    writeEvents(paths, CAMPAIGN_UUID_E, [
      seedEnv(),
      envelope('combat_start', {}, 'cs1'),
      envelope('monster_spawn', { id: 'orc-1', name: 'Orc', hpMax: 15 }, 'ms1'),
      envelope(
        'initiative_set',
        { order: [{ actorId: CHAR_UUID_E, initiative: 20 }, { actorId: 'orc-1', initiative: 8 }] },
        'is1',
      ),
    ]);

    const r = await reader.materializeFromVault(CAMPAIGN_UUID_E, CHAR_UUID_E, SESSION_UUID_E);
    expect(r!.state.combat).not.toBeNull();
    expect(r!.state.combat!.round).toBe(1);
    expect(r!.state.combat!.currentIdx).toBe(0);
    expect(r!.state.combat!.turnOrder).toHaveLength(2);
    expect(r!.state.combat!.turnOrder[0]).toEqual({ actorId: CHAR_UUID_E, initiative: 20 });
    expect(r!.state.combat!.turnOrder[1]).toEqual({ actorId: 'orc-1', initiative: 8 });
  });

  it('after combat_end: state.inCombat is false and state.combat is null', async () => {
    const { reader, paths } = await importWithRoot(testRoot);
    writeEvents(paths, CAMPAIGN_UUID_E, [
      seedEnv(),
      envelope('combat_start', {}, 'cs1'),
      envelope('monster_spawn', { id: 'orc-1', name: 'Orc', hpMax: 15 }, 'ms1'),
      envelope('combat_end', {}, 'ce1'),
    ]);

    const r = await reader.materializeFromVault(CAMPAIGN_UUID_E, CHAR_UUID_E, SESSION_UUID_E);
    expect(r).not.toBeNull();
    expect(r!.state.inCombat).toBe(false);
    expect(r!.state.combat).toBeNull();
  });

  it('no combat events at all: state.inCombat is false, state.combat is null', async () => {
    // Preserved behavior: a campaign without any encounter events shows the
    // same defaults as the hard-coded values that existed before Plan 06-02.
    const { reader, paths } = await importWithRoot(testRoot);
    writeEvents(paths, CAMPAIGN_UUID_E, [seedEnv()]);

    const r = await reader.materializeFromVault(CAMPAIGN_UUID_E, CHAR_UUID_E, SESSION_UUID_E);
    expect(r).not.toBeNull();
    expect(r!.state.inCombat).toBe(false);
    expect(r!.state.combat).toBeNull();
  });

  it('encounter exposes EncounterState on the result object', async () => {
    const { reader, paths } = await importWithRoot(testRoot);
    writeEvents(paths, CAMPAIGN_UUID_E, [
      seedEnv(),
      envelope('combat_start', {}, 'cs1'),
      envelope('monster_spawn', { id: 'orc-1', name: 'Orc', hpMax: 15 }, 'ms1'),
    ]);

    const r = await reader.materializeFromVault(CAMPAIGN_UUID_E, CHAR_UUID_E, SESSION_UUID_E);
    expect(r).not.toBeNull();
    expect(r!.encounter.active).toBe(true);
    expect(r!.encounter.monsters).toHaveLength(1);
    expect(r!.encounter.monsters[0]!.id).toBe('orc-1');
  });
});
