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
  BastionRoom,
  Character,
  DowntimeActivity,
  EngineState,
  Hireling,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator ─────────────────────────────────────────────────
// Mirrors the DB applicator's downtime/hireling/bastion semantics so this
// scenario can run without Postgres. The contract MUST track
// `src/sessions/applicator.ts` — see also tests/engine/scenarios/crafting-loop.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({
      ...c,
      downtimeActivities: c.downtimeActivities ? [...c.downtimeActivities] : [],
      hirelings: c.hirelings ? [...c.hirelings] : [],
      bastion: c.bastion
        ? { ...c.bastion, rooms: [...c.bastion.rooms] }
        : c.bastion,
    })),
  };
  switch (m.op) {
    case 'start_downtime_activity': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.downtimeActivities ?? [];
      if (cur.some((a) => a.id === m.activity.id)) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        downtimeActivities: [...cur, m.activity],
      };
      break;
    }
    case 'complete_downtime_activity': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.downtimeActivities ?? [];
      next.characters[idx] = {
        ...next.characters[idx]!,
        downtimeActivities: cur.filter((a) => a.id !== m.activityId),
      };
      break;
    }
    case 'hire': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.hirelings ?? [];
      if (cur.some((h) => h.id === m.hireling.id)) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        hirelings: [...cur, m.hireling],
      };
      break;
    }
    case 'dismiss_hireling': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.hirelings ?? [];
      next.characters[idx] = {
        ...next.characters[idx]!,
        hirelings: cur.filter((h) => h.id !== m.hireId),
      };
      break;
    }
    case 'set_bastion': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        bastion: m.bastion ?? undefined,
      };
      break;
    }
    case 'add_bastion_room': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.bastion;
      if (!cur) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        bastion: { ...cur, rooms: [...cur.rooms, m.room] },
      };
      break;
    }
    default:
      break;
  }
  return next;
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcWithDowntime(): Character {
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
    downtimeActivities: [],
    hirelings: [],
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
    scene: 'a frontier town between adventures',
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────

describe('E2E — downtime / hireling / bastion loop (PHB §6 + 2024 PHB)', () => {
  it('starts practicing_profession (5 days), then completes — outcome left to master', () => {
    let state = freshState(pcWithDowntime());

    // Scenario 1: practicing_profession → 5 days, then complete.
    const start = handleStartDowntimeActivity(state, {
      character: 'pc1',
      activity: 'practicing_profession',
      activityId: 'prof-1',
    });
    expect(start.ok).toBe(true);
    expect(start.data?.activity).toMatchObject({
      id: 'prof-1',
      kind: 'practicing_profession',
      daysRemaining: 5,
      gpSpent: 0,
    });
    state = applyAll(state, start.mutations);
    expect(state.characters[0]!.downtimeActivities).toHaveLength(1);

    const complete = handleCompleteDowntimeActivity(state, {
      character: 'pc1',
      activityId: 'prof-1',
    });
    expect(complete.ok).toBe(true);
    state = applyAll(state, complete.mutations);
    expect(state.characters[0]!.downtimeActivities).toHaveLength(0);
  });

  it('hires 2 unskilled for 10 days → 40 sp computed cost', () => {
    let state = freshState(pcWithDowntime());

    // Scenario 2: hire 2 unskilled for 10 days = 4 sp/day × 10 = 40 sp.
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
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.hirelings).toHaveLength(1);
    expect(state.characters[0]!.hirelings![0]).toMatchObject({
      id: 'hire-1',
      spCost: 40,
    });
  });

  it('sets a fortified bastion → 4 default rooms + 8 defenders', () => {
    let state = freshState(pcWithDowntime());

    // Scenario 3: set_bastion 'fortified' → engine seeds the room list
    // and defender count from defaults.
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
    state = applyAll(state, r.mutations);
    const b = state.characters[0]!.bastion;
    expect(b).toBeDefined();
    expect(b!.rooms).toHaveLength(4);
    expect(b!.defenders).toBe(8);
  });

  it('add_bastion_room appends a library → bastion has 5 rooms', () => {
    let state = freshState(pcWithDowntime());

    // First seed the bastion at fortified tier (4 rooms).
    const seed = handleSetBastion(state, {
      character: 'pc1',
      name: 'Ravenhollow Manor',
      fortification: 'fortified',
    });
    state = applyAll(state, seed.mutations);
    expect(state.characters[0]!.bastion!.rooms).toHaveLength(4);

    // Scenario 4: add a library → 5 rooms.
    const r = handleAddBastionRoom(state, {
      character: 'pc1',
      kind: 'library',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.room).toEqual({ kind: 'library', level: 1 });
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.bastion!.rooms).toHaveLength(5);
    expect(state.characters[0]!.bastion!.rooms[4]).toEqual({
      kind: 'library',
      level: 1,
    });
  });

  it('dismiss_hireling shrinks the list', () => {
    let state = freshState(pcWithDowntime());

    // Hire two engagements first.
    const h1 = handleHire(state, {
      character: 'pc1',
      kind: 'skilled',
      count: 1,
      days: 7,
      hireId: 'h1',
    });
    state = applyAll(state, h1.mutations);
    const h2 = handleHire(state, {
      character: 'pc1',
      kind: 'unskilled',
      count: 3,
      days: 5,
      hireId: 'h2',
    });
    state = applyAll(state, h2.mutations);
    expect(state.characters[0]!.hirelings).toHaveLength(2);

    // Scenario 5: dismiss the first → list shrinks to 1.
    const r = handleDismissHireling(state, { character: 'pc1', hireId: 'h1' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.hirelings).toHaveLength(1);
    expect(state.characters[0]!.hirelings![0]?.id).toBe('h2');
  });

  it('TOOL_HANDLERS dispatch end-to-end mirrors the direct-handler flow', () => {
    let state = freshState(pcWithDowntime());

    // Drive the registry with an arbitrary mix of activity, hireling,
    // and bastion calls and verify the resulting character snapshot.
    const startActivity = TOOL_HANDLERS.start_downtime_activity!(state, {
      character: 'pc1',
      activity: 'researching',
      activityId: 'res-1',
    });
    state = applyAll(state, startActivity.mutations);
    expect(state.characters[0]!.downtimeActivities![0]).toMatchObject({
      id: 'res-1',
      kind: 'researching',
      daysRemaining: 1,
    });

    const hire = TOOL_HANDLERS.hire!(state, {
      character: 'pc1',
      kind: 'skilled',
      count: 4,
      days: 30,
      hireId: 'h-mer',
    });
    state = applyAll(state, hire.mutations);
    const hireData = hire.data as { hireling: Hireling } | undefined;
    expect(hireData?.hireling.gpCost).toBe(2 * 4 * 30); // 240 gp

    const setB = TOOL_HANDLERS.set_bastion!(state, {
      character: 'pc1',
      name: 'Stormcrown Keep',
      fortification: 'castle',
    });
    state = applyAll(state, setB.mutations);
    const setBData = setB.data as { bastion: Bastion } | undefined;
    expect(setBData?.bastion.defenders).toBe(30);
    expect(state.characters[0]!.bastion!.rooms).toHaveLength(7);

    const addRoom = TOOL_HANDLERS.add_bastion_room!(state, {
      character: 'pc1',
      kind: 'workshop',
      level: 2,
    });
    state = applyAll(state, addRoom.mutations);
    const addRoomData = addRoom.data as { room: BastionRoom } | undefined;
    expect(addRoomData?.room).toEqual({ kind: 'workshop', level: 2 });
    expect(state.characters[0]!.bastion!.rooms).toHaveLength(8);

    const completeActivity = TOOL_HANDLERS.complete_downtime_activity!(state, {
      character: 'pc1',
      activityId: 'res-1',
    });
    state = applyAll(state, completeActivity.mutations);
    expect(state.characters[0]!.downtimeActivities).toHaveLength(0);

    // sanity: the activity object emitted in the data field still carries
    // the kind so the master can craft a tailored narration.
    const activityData = completeActivity.data as
      | { activity: DowntimeActivity }
      | undefined;
    expect(activityData?.activity.kind).toBe('researching');
  });
});
