import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleDisembarkVehicle,
  handleEmbarkVehicle,
  handleMount,
  handleSetMountMode,
  handleSwapAttackTarget,
} from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  Mutation,
  Size,
  TurnState,
} from '@/engine/types';

// ─── In-memory applicator ─────────────────────────────────────────────────
// Mirrors the DB applicator's mount/dismount/embark semantics so this
// scenario can run without Postgres. The contract MUST track
// `src/sessions/applicator.ts` — see also tests/engine/scenarios/downtime-loop.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
  };
  switch (m.op) {
    case 'mount': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        mountedOn: { mountId: m.mountId, mode: m.mode ?? 'controlled' },
      };
      break;
    }
    case 'dismount': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        mountedOn: undefined,
      };
      break;
    }
    case 'set_mount_mode': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const cur = next.characters[idx]!.mountedOn;
      if (!cur) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        mountedOn: { ...cur, mode: m.mode },
      };
      break;
    }
    case 'embark_vehicle': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        embarkedOn: m.vehicleSlug,
      };
      break;
    }
    case 'disembark_vehicle': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      next.characters[idx] = {
        ...next.characters[idx]!,
        embarkedOn: undefined,
      };
      break;
    }
    case 'consume_action': {
      const rt = next.runtime[m.actorId];
      if (!rt?.turnState) break;
      const ts: TurnState = { ...rt.turnState };
      if (m.kind === 'action') ts.actionUsed = true;
      else if (m.kind === 'bonus') ts.bonusUsed = true;
      else if (m.kind === 'reaction') ts.reactionUsed = true;
      next.runtime[m.actorId] = { ...rt, turnState: ts };
      break;
    }
    case 'apply_damage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = {
        ...rt,
        hpCurrent: Math.max(0, rt.hpCurrent - m.amount),
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

function pcMedium(): Character {
  const char: Character = {
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
      skills: ['Athletics'],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: ['Light', 'Medium', 'Heavy', 'Shield'],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 10,
  };
  // Mark size on the character via the optional field — TypeScript allows
  // this because we extended Character with `mountedOn` and we use a side
  // path here for the size data.
  (char as { size?: Size }).size = 'medium';
  return char;
}

function horse(id = 'horse1', size: Size = 'large'): CombatActor {
  return {
    id,
    kind: 'monster',
    name: 'Riding Horse',
    monsterSlug: 'riding-horse',
    hpMax: 13,
    ac: 10,
    abilities: { STR: 16, DEX: 10, CON: 12, INT: 2, WIS: 11, CHA: 7 },
    proficiencyBonus: 2,
    initiativeBonus: 0,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
    size,
  };
}

function goblin(id = 'gob1'): CombatActor {
  return {
    id,
    kind: 'monster',
    name: 'Goblin',
    monsterSlug: 'goblin',
    hpMax: 7,
    ac: 15,
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    initiativeBonus: 2,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
    size: 'small',
  };
}

function freshTurnState(): TurnState {
  return {
    actionUsed: false,
    bonusUsed: false,
    reactionUsed: false,
    movementSpentFt: 0,
    freeInteractionsUsed: 0,
    dodging: false,
    disengaged: false,
    dashed: false,
  };
}

function freshState(char: Character, mounts: CombatActor[] = []): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {
    [char.id]: {
      actorId: char.id,
      hpCurrent: char.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
      turnState: freshTurnState(),
    },
  };
  for (const m of mounts) {
    runtime[m.id] = {
      actorId: m.id,
      hpCurrent: m.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    };
  }
  return {
    characters: [char],
    combatActors: mounts,
    runtime,
    combat: null,
    scene: 'a windy plain at the edge of the road',
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────

describe('E2E — mounts / vehicles loop (PHB §3.23, §9.6)', () => {
  it('PC mounts a horse (medium PC, large mount) → mounted state set', () => {
    let state = freshState(pcMedium(), [horse('h1', 'large')]);

    const r = handleMount(state, { rider: 'pc1', mount: 'h1' });
    expect(r.ok).toBe(true);
    expect(r.data?.mounted).toEqual({ mountId: 'h1', mode: 'controlled' });
    state = applyAll(state, r.mutations);

    expect(state.characters[0]!.mountedOn).toEqual({
      mountId: 'h1',
      mode: 'controlled',
    });
  });

  it('mount with a same-size creature fails (PHB rule)', () => {
    // A medium PC trying to mount a medium creature → rejected.
    const state = freshState(pcMedium(), [horse('h1', 'medium')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'h1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('mount_too_small');
  });

  it('set_mount_mode flips controlled → independent', () => {
    let state = freshState(pcMedium(), [horse('h1', 'large')]);

    // First mount controlled.
    state = applyAll(state, handleMount(state, { rider: 'pc1', mount: 'h1' }).mutations);

    // Switch to independent.
    const r = handleSetMountMode(state, { rider: 'pc1', mode: 'independent' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.mountedOn?.mode).toBe('independent');
  });

  it('goblin attacks mount → rider uses swap_attack_target → reaction consumed, rider takes the hit', () => {
    let state = freshState(pcMedium(), [horse('h1', 'large'), goblin('g1')]);
    state = applyAll(state, handleMount(state, { rider: 'pc1', mount: 'h1' }).mutations);

    // Pre-condition: rider has full HP, mount has full HP, reaction free.
    expect(state.runtime['pc1']!.hpCurrent).toBe(28);
    expect(state.runtime['h1']!.hpCurrent).toBe(13);
    expect(state.runtime['pc1']!.turnState!.reactionUsed).toBe(false);

    // The attack roll already happened (master narrated it). The goblin's
    // sword struck the mount for 6 damage. The rider invokes the swap to
    // take the hit instead.
    const swap = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'h1',
      newTargetId: 'pc1',
    });
    expect(swap.ok).toBe(true);
    expect(swap.mutations).toEqual([
      { op: 'consume_action', actorId: 'pc1', kind: 'reaction' },
    ]);

    // Apply the engine mutations (consume reaction) AND the master-side
    // damage application (the engine doesn't redo the attack — the master
    // applies the damage manually).
    state = applyAll(state, swap.mutations);
    state = applyAll(state, [
      { op: 'apply_damage', actorId: 'pc1', amount: 6, type: 'slashing' },
    ]);

    // Reaction consumed.
    expect(state.runtime['pc1']!.turnState!.reactionUsed).toBe(true);
    // Rider took the hit; mount untouched.
    expect(state.runtime['pc1']!.hpCurrent).toBe(28 - 6);
    expect(state.runtime['h1']!.hpCurrent).toBe(13);

    // Trying to swap again the same round → rejected.
    const second = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'pc1',
      newTargetId: 'h1',
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('reaction_already_used');
  });

  it("PC embarks 'sailing-ship' → embarkedOn = 'sailing-ship'", () => {
    let state = freshState(pcMedium());
    const r = handleEmbarkVehicle(state, {
      character: 'pc1',
      vehicleSlug: 'sailing-ship',
    });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.embarkedOn).toBe('sailing-ship');
  });

  it('PC disembarks → embarkedOn cleared', () => {
    let state = freshState(pcMedium());
    state = applyAll(
      state,
      handleEmbarkVehicle(state, {
        character: 'pc1',
        vehicleSlug: 'rowboat',
      }).mutations,
    );
    expect(state.characters[0]!.embarkedOn).toBe('rowboat');

    const r = handleDisembarkVehicle(state, { character: 'pc1' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.characters[0]!.embarkedOn).toBeUndefined();
  });

  it('TOOL_HANDLERS dispatch end-to-end: mount → swap → dismount → embark → disembark', () => {
    let state = freshState(pcMedium(), [horse('h1', 'large'), goblin('g1')]);

    // mount via registry
    const mount = TOOL_HANDLERS.mount!(state, {
      rider: 'pc1',
      mount: 'h1',
      mode: 'controlled',
    });
    expect(mount.ok).toBe(true);
    state = applyAll(state, mount.mutations);

    // swap_attack_target via registry
    const swap = TOOL_HANDLERS.swap_attack_target!(state, {
      rider: 'pc1',
      originalTargetId: 'pc1',
      newTargetId: 'h1',
    });
    expect(swap.ok).toBe(true);
    state = applyAll(state, swap.mutations);
    expect(state.runtime['pc1']!.turnState!.reactionUsed).toBe(true);

    // dismount via registry
    const dismount = TOOL_HANDLERS.dismount!(state, { rider: 'pc1' });
    expect(dismount.ok).toBe(true);
    state = applyAll(state, dismount.mutations);
    expect(state.characters[0]!.mountedOn).toBeUndefined();

    // embark airship via registry
    const embark = TOOL_HANDLERS.embark_vehicle!(state, {
      character: 'pc1',
      vehicleSlug: 'airship',
    });
    expect(embark.ok).toBe(true);
    state = applyAll(state, embark.mutations);
    expect(state.characters[0]!.embarkedOn).toBe('airship');

    // disembark via registry
    const disembark = TOOL_HANDLERS.disembark_vehicle!(state, { character: 'pc1' });
    expect(disembark.ok).toBe(true);
    state = applyAll(state, disembark.mutations);
    expect(state.characters[0]!.embarkedOn).toBeUndefined();
  });
});
