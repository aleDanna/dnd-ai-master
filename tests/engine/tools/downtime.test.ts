import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleAddBastionRoom,
  handleCompleteDowntimeActivity,
  handleDismissHireling,
  handleHire,
  handleSetBastion,
  handleStartDowntimeActivity,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Bastion,
  Character,
  DowntimeActivity,
  EngineState,
  Hireling,
} from '@/engine/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcWithDowntime(opts: {
  activities?: DowntimeActivity[];
  hirelings?: Hireling[];
  bastion?: Bastion;
} = {}): Character {
  return {
    id: 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 28,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: ['STR', 'CON'],
      skills: ['Athletics', 'Survival'],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: ['Light', 'Medium', 'Heavy', 'Shield'],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: null,
    features: [],
    inventory: [{ slug: 'gp', qty: 500, equipped: false }],
    hitDiceMax: 5,
    hitDieSize: 10,
    downtimeActivities: opts.activities ?? [],
    hirelings: opts.hirelings ?? [],
    bastion: opts.bastion,
  };
}

function freshState(char: Character): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {
    [char.id]: {
      actorId: char.id,
      hpCurrent: char.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    },
  };
  return {
    characters: [char],
    combatActors: [],
    runtime,
    combat: null,
    scene: 'a quiet inn',
  };
}

// ─── handleStartDowntimeActivity ──────────────────────────────────────────

describe('handleStartDowntimeActivity', () => {
  it('uses default day count from PHB §6 when days is omitted', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'recuperating',
      activityId: 'rec-1',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.activity).toMatchObject({
      id: 'rec-1',
      kind: 'recuperating',
      daysRemaining: 3,
      gpSpent: 0,
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]).toMatchObject({
      op: 'start_downtime_activity',
      characterId: 'pc1',
    });
  });

  it('honors a manual `days` override', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'training',
      days: 50,
      activityId: 'train-1',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.activity.daysRemaining).toBe(50);
  });

  it('rejects unknown character', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'ghost',
      activity: 'researching',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });

  it('rejects unknown activity kind', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'sleeping' as never,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_activity');
  });

  it('rejects negative days override', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'researching',
      days: -2,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_days');
  });

  it('generates a project id when none is supplied', () => {
    const state = freshState(pcWithDowntime());
    const r = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'practicing_profession',
    });
    expect(r.ok).toBe(true);
    expect(typeof r.data?.activity.id).toBe('string');
    expect(r.data?.activity.id.length).toBeGreaterThan(0);
  });
});

// ─── handleCompleteDowntimeActivity ───────────────────────────────────────

describe('handleCompleteDowntimeActivity', () => {
  it('emits complete_downtime_activity for an existing activity', () => {
    const state = freshState(
      pcWithDowntime({
        activities: [
          { id: 'rec-1', kind: 'recuperating', daysRemaining: 3, gpSpent: 0 },
        ],
      }),
    );
    const r = handleCompleteDowntimeActivity(state, {
      character: 'pc1',
      activityId: 'rec-1',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'complete_downtime_activity',
      characterId: 'pc1',
      activityId: 'rec-1',
    });
  });

  it('errors with unknown_activity when id is missing', () => {
    const state = freshState(pcWithDowntime());
    const r = handleCompleteDowntimeActivity(state, {
      character: 'pc1',
      activityId: 'nope',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_activity');
  });
});

// ─── handleHire / handleDismissHireling ───────────────────────────────────

describe('handleHire', () => {
  it('computes 2 sp/day × 2 unskilled × 10 days = 40 sp', () => {
    const state = freshState(pcWithDowntime());
    const r = handleHire(state, {
      character: 'pc1',
      kind: 'unskilled',
      count: 2,
      days: 10,
      hireId: 'hire-1',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.hireling).toMatchObject({
      id: 'hire-1',
      kind: 'unskilled',
      count: 2,
      days: 10,
      gpCost: 0,
      spCost: 40,
    });
    expect(r.mutations[0]?.op).toBe('hire');
  });

  it('computes 2 gp/day × 1 skilled × 5 days = 10 gp', () => {
    const state = freshState(pcWithDowntime());
    const r = handleHire(state, {
      character: 'pc1',
      kind: 'skilled',
      count: 1,
      days: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.hireling.gpCost).toBe(10);
    expect(r.data?.hireling.spCost).toBe(0);
  });

  it('rejects invalid kind / count <= 0 / days <= 0', () => {
    const state = freshState(pcWithDowntime());
    expect(handleHire(state, { character: 'pc1', kind: 'wizard' as never, count: 1, days: 1 }).error)
      .toBe('invalid_kind');
    expect(handleHire(state, { character: 'pc1', kind: 'skilled', count: 0, days: 5 }).error)
      .toBe('invalid_count');
    expect(handleHire(state, { character: 'pc1', kind: 'skilled', count: 2, days: 0 }).error)
      .toBe('invalid_days');
  });
});

describe('handleDismissHireling', () => {
  it('emits dismiss_hireling for a known hireling id', () => {
    const state = freshState(
      pcWithDowntime({
        hirelings: [
          { id: 'h1', kind: 'skilled', count: 1, days: 5, gpCost: 10, spCost: 0 },
        ],
      }),
    );
    const r = handleDismissHireling(state, { character: 'pc1', hireId: 'h1' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'dismiss_hireling',
      characterId: 'pc1',
      hireId: 'h1',
    });
  });

  it('errors with unknown_hireling when id is missing', () => {
    const state = freshState(pcWithDowntime());
    const r = handleDismissHireling(state, { character: 'pc1', hireId: 'h-nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_hireling');
  });
});

// ─── handleSetBastion / handleAddBastionRoom ──────────────────────────────

describe('handleSetBastion', () => {
  it('builds a default fortified bastion with 4 rooms + 8 defenders', () => {
    const state = freshState(pcWithDowntime());
    const r = handleSetBastion(state, {
      character: 'pc1',
      name: 'Ravenhollow Manor',
      fortification: 'fortified',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.bastion).toMatchObject({
      name: 'Ravenhollow Manor',
      fortification: 'fortified',
      defenders: 8,
    });
    expect(r.data?.bastion.rooms).toHaveLength(4);
    expect(r.mutations[0]?.op).toBe('set_bastion');
  });

  it('rejects empty name', () => {
    const state = freshState(pcWithDowntime());
    expect(
      handleSetBastion(state, { character: 'pc1', name: '   ', fortification: 'modest' })
        .error,
    ).toBe('invalid_name');
  });

  it('rejects unknown fortification tier', () => {
    const state = freshState(pcWithDowntime());
    expect(
      handleSetBastion(state, {
        character: 'pc1',
        name: 'Foo',
        fortification: 'mansion' as never,
      }).error,
    ).toBe('invalid_fortification');
  });
});

describe('handleAddBastionRoom', () => {
  it('appends a library to an existing bastion', () => {
    const state = freshState(
      pcWithDowntime({
        bastion: {
          name: 'Foo',
          fortification: 'modest',
          rooms: [
            { kind: 'kitchen', level: 1 },
            { kind: 'storage', level: 1 },
          ],
          defenders: 2,
        },
      }),
    );
    const r = handleAddBastionRoom(state, {
      character: 'pc1',
      kind: 'library',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.room).toEqual({ kind: 'library', level: 1 });
    expect(r.mutations[0]).toMatchObject({
      op: 'add_bastion_room',
      characterId: 'pc1',
      room: { kind: 'library', level: 1 },
    });
  });

  it('errors with no_bastion when the PC has no bastion', () => {
    const state = freshState(pcWithDowntime());
    const r = handleAddBastionRoom(state, { character: 'pc1', kind: 'library' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_bastion');
  });

  it('rejects unknown room kind / out-of-range level', () => {
    const state = freshState(
      pcWithDowntime({
        bastion: {
          name: 'Foo',
          fortification: 'modest',
          rooms: [],
          defenders: 2,
        },
      }),
    );
    expect(
      handleAddBastionRoom(state, { character: 'pc1', kind: 'dungeon' as never }).error,
    ).toBe('invalid_room_kind');
    expect(
      handleAddBastionRoom(state, { character: 'pc1', kind: 'library', level: 4 }).error,
    ).toBe('invalid_room_level');
  });
});

// ─── TOOL_HANDLERS dispatch round-trip ────────────────────────────────────

describe('TOOL_HANDLERS dispatch (Phase 13)', () => {
  it('routes start_downtime_activity / hire / set_bastion through the registry', () => {
    const state = freshState(pcWithDowntime());

    const r1 = TOOL_HANDLERS.start_downtime_activity!(state, {
      character: 'pc1',
      activity: 'training',
    });
    expect(r1.ok).toBe(true);
    expect(r1.mutations[0]?.op).toBe('start_downtime_activity');

    const r2 = TOOL_HANDLERS.hire!(state, {
      character: 'pc1',
      kind: 'skilled',
      count: 3,
      days: 7,
    });
    expect(r2.ok).toBe(true);
    const hireData = r2.data as { hireling: Hireling } | undefined;
    expect(hireData?.hireling).toMatchObject({
      kind: 'skilled',
      count: 3,
      days: 7,
      gpCost: 42, // 2 × 3 × 7
      spCost: 0,
    });

    const r3 = TOOL_HANDLERS.set_bastion!(state, {
      character: 'pc1',
      name: 'Stormcrown Keep',
      fortification: 'castle',
    });
    expect(r3.ok).toBe(true);
    const bastionData = r3.data as { bastion: Bastion } | undefined;
    expect(bastionData?.bastion.defenders).toBe(30);
    expect(bastionData?.bastion.rooms).toHaveLength(7);
  });
});
