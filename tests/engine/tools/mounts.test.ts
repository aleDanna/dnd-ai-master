import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleDisembarkVehicle,
  handleDismount,
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
  MountedState,
  Size,
  TurnState,
} from '@/engine/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pc(opts: { mountedOn?: MountedState; embarkedOn?: string } = {}): Character {
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
    mountedOn: opts.mountedOn,
    embarkedOn: opts.embarkedOn,
  };
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

function freshState(char: Character, mounts: CombatActor[] = []): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {
    [char.id]: {
      actorId: char.id,
      hpCurrent: char.hpMax,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
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
    scene: 'a windy plain',
  };
}

// ─── handleMount ───────────────────────────────────────────────────────────

describe('handleMount (PHB §3.23)', () => {
  it('mounts the rider on a same-or-larger creature with default controlled mode', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'm1' });
    expect(r.ok).toBe(true);
    expect(r.data?.mounted).toEqual({ mountId: 'm1', mode: 'controlled' });
    expect(r.mutations).toEqual([
      { op: 'mount', characterId: 'pc1', mountId: 'm1', mode: 'controlled' },
    ]);
  });

  it('honours an explicit independent mode', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'm1', mode: 'independent' });
    expect(r.ok).toBe(true);
    expect(r.data?.mounted.mode).toBe('independent');
  });

  it('rejects unknown rider', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleMount(state, { rider: 'ghost', mount: 'm1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });

  it('rejects unknown mount', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'ghost' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_mount');
  });

  it('rejects an invalid mode', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleMount(state, {
      rider: 'pc1',
      mount: 'm1',
      mode: 'berserk' as never,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_mode');
  });

  it('rejects when both sizes are known and mount is not larger', () => {
    const rider = pc();
    (rider as { size?: Size }).size = 'large';
    const state = freshState(rider, [horse('m1', 'large')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'm1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('mount_too_small');
  });

  it('permits the mount when one of the sizes is missing', () => {
    // Rider has no size; mount is medium. Engine stays permissive.
    const state = freshState(pc(), [horse('m1', 'medium')]);
    const r = handleMount(state, { rider: 'pc1', mount: 'm1' });
    expect(r.ok).toBe(true);
  });
});

// ─── handleDismount ────────────────────────────────────────────────────────

describe('handleDismount (PHB §3.23)', () => {
  it('clears the rider when currently mounted', () => {
    const state = freshState(pc({ mountedOn: { mountId: 'm1', mode: 'controlled' } }));
    const r = handleDismount(state, { rider: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'dismount', characterId: 'pc1' }]);
  });

  it('rejects when the rider is not mounted', () => {
    const state = freshState(pc());
    const r = handleDismount(state, { rider: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_mounted');
  });

  it('rejects unknown rider', () => {
    const state = freshState(pc());
    const r = handleDismount(state, { rider: 'ghost' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

// ─── handleSetMountMode ────────────────────────────────────────────────────

describe('handleSetMountMode (PHB §3.23)', () => {
  it('flips the mode while preserving the mountId', () => {
    const state = freshState(pc({ mountedOn: { mountId: 'm1', mode: 'controlled' } }));
    const r = handleSetMountMode(state, { rider: 'pc1', mode: 'independent' });
    expect(r.ok).toBe(true);
    expect(r.data?.mounted).toEqual({ mountId: 'm1', mode: 'independent' });
    expect(r.mutations).toEqual([
      { op: 'set_mount_mode', characterId: 'pc1', mode: 'independent' },
    ]);
  });

  it('rejects when not mounted', () => {
    const state = freshState(pc());
    const r = handleSetMountMode(state, { rider: 'pc1', mode: 'independent' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_mounted');
  });

  it('rejects an invalid mode', () => {
    const state = freshState(pc({ mountedOn: { mountId: 'm1', mode: 'controlled' } }));
    const r = handleSetMountMode(state, { rider: 'pc1', mode: 'berserk' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_mode');
  });
});

// ─── handleEmbarkVehicle / handleDisembarkVehicle ─────────────────────────

describe('handleEmbarkVehicle (PHB §9.6)', () => {
  it('embarks on a known catalog slug', () => {
    const state = freshState(pc());
    const r = handleEmbarkVehicle(state, {
      character: 'pc1',
      vehicleSlug: 'sailing-ship',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'embark_vehicle', characterId: 'pc1', vehicleSlug: 'sailing-ship' },
    ]);
  });

  it('rejects an unknown vehicle slug', () => {
    const state = freshState(pc());
    const r = handleEmbarkVehicle(state, { character: 'pc1', vehicleSlug: 'mecha' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_vehicle');
  });
});

describe('handleDisembarkVehicle', () => {
  it('clears the vehicle when embarked', () => {
    const state = freshState(pc({ embarkedOn: 'rowboat' }));
    const r = handleDisembarkVehicle(state, { character: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'disembark_vehicle', characterId: 'pc1' }]);
  });

  it('rejects when not embarked', () => {
    const state = freshState(pc());
    const r = handleDisembarkVehicle(state, { character: 'pc1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_embarked');
  });
});

// ─── handleSwapAttackTarget (PHB §3.23) ────────────────────────────────────

describe('handleSwapAttackTarget', () => {
  function turnState(reactionUsed = false): TurnState {
    return {
      actionUsed: false,
      bonusUsed: false,
      reactionUsed,
      movementSpentFt: 0,
      freeInteractionsUsed: 0,
      dodging: false,
      disengaged: false,
      dashed: false,
    };
  }

  function mountedState(reactionUsed = false): EngineState {
    const rider = pc({ mountedOn: { mountId: 'm1', mode: 'controlled' } });
    const state = freshState(rider, [horse('m1', 'large')]);
    state.runtime['pc1']!.turnState = turnState(reactionUsed);
    return state;
  }

  it('emits consume_action(reaction) when the rider has reaction available', () => {
    const state = mountedState(false);
    const r = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'm1',
      newTargetId: 'pc1',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'consume_action', actorId: 'pc1', kind: 'reaction' },
    ]);
  });

  it('also accepts the reverse pairing (original=rider, new=mount)', () => {
    const state = mountedState(false);
    const r = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'pc1',
      newTargetId: 'm1',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when the rider already used their reaction', () => {
    const state = mountedState(true);
    const r = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'm1',
      newTargetId: 'pc1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('reaction_already_used');
  });

  it('rejects when the rider is not mounted', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'm1',
      newTargetId: 'pc1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_mounted');
  });

  it('rejects when neither target is the rider/mount pair', () => {
    const state = mountedState(false);
    const r = handleSwapAttackTarget(state, {
      rider: 'pc1',
      originalTargetId: 'pc1',
      newTargetId: 'unrelated',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_swap_pair');
  });

  it('rejects unknown rider', () => {
    const state = mountedState(false);
    const r = handleSwapAttackTarget(state, {
      rider: 'ghost',
      originalTargetId: 'm1',
      newTargetId: 'pc1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

// ─── TOOL_HANDLERS registry routing ────────────────────────────────────────

describe('TOOL_HANDLERS routing for Phase 14 tools', () => {
  it('mount/dismount/set_mount_mode/embark/disembark/swap_attack_target are wired', () => {
    expect(typeof TOOL_HANDLERS['mount']).toBe('function');
    expect(typeof TOOL_HANDLERS['dismount']).toBe('function');
    expect(typeof TOOL_HANDLERS['set_mount_mode']).toBe('function');
    expect(typeof TOOL_HANDLERS['embark_vehicle']).toBe('function');
    expect(typeof TOOL_HANDLERS['disembark_vehicle']).toBe('function');
    expect(typeof TOOL_HANDLERS['swap_attack_target']).toBe('function');
  });

  it('mount via registry resolves rider via the resolveCharacterId convention', () => {
    const state = freshState(pc(), [horse('m1', 'large')]);
    const r = TOOL_HANDLERS['mount']!(state, {
      rider: 'pc1',
      mount: 'm1',
      mode: 'independent',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'mount',
      characterId: 'pc1',
      mountId: 'm1',
      mode: 'independent',
    });
  });

  it('embark_vehicle via registry uses character ref', () => {
    const state = freshState(pc());
    const r = TOOL_HANDLERS['embark_vehicle']!(state, {
      character: 'pc1',
      vehicleSlug: 'longship',
    });
    expect(r.ok).toBe(true);
  });
});
