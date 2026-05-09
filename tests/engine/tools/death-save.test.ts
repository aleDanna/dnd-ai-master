import { describe, expect, it } from 'vitest';
import { handleMakeDeathSave, handleStabilize } from '@/engine/tools/handlers';
import type { ActorRuntimeState, Character, CombatActor, EngineState, Mutation } from '@/engine/types';

// Helper: build minimal EngineState with one PC (id 'pc1') at the given HP /
// death-save state. The PC carries the bare-minimum sheet fields so the
// handler can resolve the actor; the runtime block carries the dying state.
function stateWith(opts: {
  hpCurrent?: number;
  deathSaves?: { successes: number; failures: number };
  flags?: { stable?: boolean; dead?: boolean };
} = {}): EngineState {
  const pc: Character = {
    id: 'pc1',
    name: 'Tharion',
    level: 3,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 2,
    hpMax: 30,
    ac: 16,
    speed: 30,
    proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 3,
    hitDieSize: 10,
  };
  const goblin: CombatActor = {
    id: 'm1', kind: 'monster', name: 'Goblin',
    hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2, initiativeBonus: 2,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
  };
  const runtime: ActorRuntimeState = {
    actorId: 'pc1',
    hpCurrent: opts.hpCurrent ?? 0,
    tempHp: 0,
    conditions: [],
    deathSaves: opts.deathSaves ?? { successes: 0, failures: 0 },
    flags: opts.flags,
    hitDiceRemaining: 3,
    spellSlotsUsed: {},
    resourcesUsed: {},
  };
  return {
    characters: [pc],
    combatActors: [goblin],
    runtime: {
      pc1: runtime,
      m1: { actorId: 'm1', hpCurrent: 7, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } },
    },
    combat: null,
    scene: 'a dim cell',
  };
}

describe('tool make_death_save', () => {
  it('rolls 11 (mid) → success, emits one death_save success=true', () => {
    // Math.floor(0.5 * 20) + 1 = 11
    const result = handleMakeDeathSave(
      { rng: () => 0.5 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { success: boolean }).success).toBe(true);
    const ds = result.mutations.find((m) => m.op === 'death_save') as Extract<Mutation, { op: 'death_save' }> | undefined;
    expect(ds).toMatchObject({ op: 'death_save', actorId: 'pc1', success: true });
  });

  it('rolls 2 (low) → failure', () => {
    // Math.floor(0.05 * 20) + 1 = 2
    const result = handleMakeDeathSave(
      { rng: () => 0.05 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { success: boolean }).success).toBe(false);
    const ds = result.mutations.find((m) => m.op === 'death_save') as Extract<Mutation, { op: 'death_save' }> | undefined;
    expect(ds).toMatchObject({ op: 'death_save', actorId: 'pc1', success: false });
  });

  it('natural 20 → regain 1 HP, reset death saves, remove unconscious', () => {
    // Math.floor(0.9999 * 20) + 1 = 20
    const result = handleMakeDeathSave(
      { rng: () => 0.9999 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { naturalTwenty?: boolean }).naturalTwenty).toBe(true);
    const setHp = result.mutations.find((m) => m.op === 'set_hp');
    const reset = result.mutations.find((m) => m.op === 'reset_death_saves');
    const removeCond = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'remove_condition' }> =>
        m.op === 'remove_condition' && m.conditionSlug === 'unconscious',
    );
    expect(setHp).toMatchObject({ op: 'set_hp', actorId: 'pc1', hpCurrent: 1 });
    expect(reset).toBeDefined();
    expect(removeCond).toBeDefined();
  });

  it('natural 1 → 2 failures', () => {
    // Math.floor(0.0001 * 20) + 1 = 1
    const result = handleMakeDeathSave(
      { rng: () => 0.0001 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(true);
    const fails = result.mutations.filter(
      (m): m is Extract<Mutation, { op: 'death_save' }> => m.op === 'death_save' && m.success === false,
    );
    expect(fails.length).toBe(2);
  });

  it('errors if actor not at 0 HP', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.5 },
      stateWith({ hpCurrent: 5 }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/0 HP/);
  });

  it('errors if actor already dead', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.5 },
      stateWith({ hpCurrent: 0, flags: { dead: true } }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dead/);
  });

  it('errors if actor stable', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.5 },
      stateWith({ hpCurrent: 0, flags: { stable: true } }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stable/);
  });
});

describe('tool stabilize', () => {
  it('healing_kit auto-stabilizes', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'healing_kit' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { stabilized: boolean }).stabilized).toBe(true);
    const setStable = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'set_stable' }> => m.op === 'set_stable',
    );
    expect(setStable).toMatchObject({ op: 'set_stable', actorId: 'pc1', stable: true });
    const reset = result.mutations.find((m) => m.op === 'reset_death_saves');
    expect(reset).toBeDefined();
  });

  it('medicine_check >=10 stabilizes', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'medicine_check', medicineRoll: 14 },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { stabilized: boolean }).stabilized).toBe(true);
    const setStable = result.mutations.find((m) => m.op === 'set_stable');
    expect(setStable).toBeDefined();
  });

  it('medicine_check <10 fails (no mutations)', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'medicine_check', medicineRoll: 8 },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { stabilized: boolean }).stabilized).toBe(false);
    expect(result.mutations.length).toBe(0);
  });

  it('medicine_check missing medicineRoll → ok:false', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'medicine_check' },
    );
    expect(result.ok).toBe(false);
  });

  it('spell auto-stabilizes', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'spell' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { stabilized: boolean }).stabilized).toBe(true);
  });

  it('does NOT remove unconscious — stable but still down (PHB §3.19)', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'pc1', method: 'healing_kit' },
    );
    expect(result.ok).toBe(true);
    const removeUnc = result.mutations.find(
      (m): m is Extract<Mutation, { op: 'remove_condition' }> =>
        m.op === 'remove_condition' && m.conditionSlug === 'unconscious',
    );
    expect(removeUnc).toBeUndefined();
  });

  it('errors if actor not at 0 HP', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 5 }),
      { actorId: 'pc1', method: 'healing_kit' },
    );
    expect(result.ok).toBe(false);
  });

  it('errors if actor dead', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0, flags: { dead: true } }),
      { actorId: 'pc1', method: 'healing_kit' },
    );
    expect(result.ok).toBe(false);
  });

  it('errors if actor unknown', () => {
    const result = handleStabilize(
      { rng: () => 0 },
      stateWith({ hpCurrent: 0 }),
      { actorId: 'ghost', method: 'healing_kit' },
    );
    expect(result.ok).toBe(false);
  });
});
