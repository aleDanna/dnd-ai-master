import { describe, expect, it } from 'vitest';
import { castSpell } from '@/engine/spells';
import { applyDamage } from '@/engine/combat/damage';
import { handleConcentrationCheck } from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  ConditionInstance,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// The production applicator is DB-backed. For these E2E scenarios we drive
// the same mutation set against an in-memory EngineState so we can exercise
// the full concentration loop without a database. Mutation semantics MUST
// match the DB applicator — keep in lockstep with src/sessions/applicator.ts.
// Mirrors the pattern from death-save-loop.test.ts and extends it with the
// concentration ops added in Phase 2 (set_concentration, break_concentration,
// concentration_check, use_spell_slot).
function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next = { ...state, runtime: { ...state.runtime } };
  switch (m.op) {
    case 'set_hp': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: m.hpCurrent };
      break;
    }
    case 'apply_damage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: Math.max(0, rt.hpCurrent - m.amount) };
      break;
    }
    case 'heal': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const target =
        next.characters.find((c) => c.id === m.actorId) ??
        next.combatActors.find((a) => a.id === m.actorId);
      const hpMax = target?.hpMax ?? rt.hpCurrent + m.amount;
      const newHp = Math.min(hpMax, rt.hpCurrent + m.amount);
      const wasAt0 = rt.hpCurrent === 0 && newHp > 0;
      next.runtime[m.actorId] = {
        ...rt,
        hpCurrent: newHp,
        deathSaves: wasAt0 ? { successes: 0, failures: 0 } : rt.deathSaves,
        conditions: wasAt0 ? rt.conditions.filter((c) => c.slug !== 'unconscious') : rt.conditions,
        flags: wasAt0 ? { ...(rt.flags ?? {}), stable: false } : rt.flags,
      };
      break;
    }
    case 'add_condition': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const conds = rt.conditions.filter((c) => c.slug !== m.condition.slug);
      conds.push(m.condition);
      next.runtime[m.actorId] = { ...rt, conditions: conds };
      break;
    }
    case 'remove_condition': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = {
        ...rt,
        conditions: rt.conditions.filter((c) => c.slug !== m.conditionSlug),
      };
      break;
    }
    case 'use_spell_slot': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.spellSlotsUsed ?? {}) };
      used[m.level] = (used[m.level] ?? 0) + 1;
      next.runtime[m.actorId] = { ...rt, spellSlotsUsed: used };
      break;
    }
    case 'set_concentration': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = {
        ...rt,
        concentratingOn: {
          spellSlug: m.spellSlug,
          slotLevel: m.slotLevel,
          startedRound: m.startedRound,
        },
      };
      break;
    }
    case 'break_concentration': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const { concentratingOn: _drop, ...rest } = rt;
      next.runtime[m.actorId] = rest;
      break;
    }
    case 'concentration_check': {
      // Pure signal — the AI Master invokes the concentration_check tool
      // (handleConcentrationCheck), which emits break_concentration on a
      // failed save. The mutation itself is a no-op against state.
      break;
    }
    case 'death_save': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ds = rt.deathSaves ?? { successes: 0, failures: 0 };
      const flags = rt.flags ?? {};
      if (m.success) {
        const newSuccesses = Math.min(3, ds.successes + 1);
        if (newSuccesses >= 3) {
          const conds: ConditionInstance[] = rt.conditions.slice();
          if (!conds.some((c) => c.slug === 'unconscious')) {
            conds.push({
              slug: 'unconscious',
              source: 'stable but down',
              durationRounds: 'until_removed',
              appliedRound: 0,
            });
          }
          next.runtime[m.actorId] = {
            ...rt,
            deathSaves: { successes: 0, failures: 0 },
            flags: { ...flags, stable: true },
            conditions: conds,
          };
        } else {
          next.runtime[m.actorId] = {
            ...rt,
            deathSaves: { successes: newSuccesses, failures: ds.failures },
          };
        }
      } else {
        const inc = m.isCrit ? 2 : 1;
        const newFailures = Math.min(3, ds.failures + inc);
        if (newFailures >= 3) {
          next.runtime[m.actorId] = {
            ...rt,
            deathSaves: { successes: 0, failures: 3 },
            flags: { ...flags, dead: true },
          };
        } else {
          next.runtime[m.actorId] = {
            ...rt,
            deathSaves: { successes: ds.successes, failures: newFailures },
          };
        }
      }
      break;
    }
    case 'reset_death_saves': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, deathSaves: { successes: 0, failures: 0 } };
      break;
    }
    case 'set_stable': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, flags: { ...(rt.flags ?? {}), stable: m.stable } };
      break;
    }
    default:
      // Other ops aren't exercised by these scenarios — no-op.
      break;
  }
  return next;
}

function applyMutations(state: EngineState, muts: Mutation[]): EngineState {
  return muts.reduce(applyMutation, state);
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

interface ClericFixture {
  character: Character;
  runtime: ActorRuntimeState;
}

function makeCleric(opts: { conScore?: number; profCon?: boolean; id?: string; hpCurrent?: number } = {}): ClericFixture {
  const id = opts.id ?? 'pc1';
  const character: Character = {
    id,
    name: 'Mira',
    level: 5,
    xp: 0,
    classSlug: 'cleric',
    raceSlug: 'human',
    backgroundSlug: 'acolyte',
    abilities: {
      STR: 10,
      DEX: 10,
      CON: opts.conScore ?? 14,
      INT: 10,
      WIS: 16,
      CHA: 12,
    },
    proficiencyBonus: 3,
    hpMax: 38,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: opts.profCon ? ['WIS', 'CHA', 'CON'] : ['WIS', 'CHA'],
      skills: ['Religion'],
      expertise: [],
      weapons: ['Simple'],
      armor: ['Light', 'Medium', 'Shield'],
      tools: [],
      languages: ['Common'],
    },
    spellcasting: {
      ability: 'WIS',
      spellSaveDC: 14,
      spellAttackBonus: 6,
      slotsMax: { 1: 4, 2: 3, 3: 2 },
      spellsKnown: ['bless', 'hold-person', 'fire-bolt', 'detect-magic'],
      spellsPrepared: ['bless', 'hold-person', 'fire-bolt', 'detect-magic'],
    },
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 8,
  };
  const runtime: ActorRuntimeState = {
    actorId: id,
    hpCurrent: opts.hpCurrent ?? 38,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    spellSlotsUsed: {},
    resourcesUsed: {},
    hitDiceRemaining: 5,
  };
  return { character, runtime };
}

interface AllyFixture {
  actor: CombatActor;
  runtime: ActorRuntimeState;
}

function makeAlly(opts: { id: string }): AllyFixture {
  const actor: CombatActor = {
    id: opts.id,
    kind: 'pc',
    name: 'Ally',
    hpMax: 24,
    ac: 16,
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 2,
    initiativeBonus: 1,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
  };
  const runtime: ActorRuntimeState = {
    actorId: opts.id,
    hpCurrent: 24,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
  };
  return { actor, runtime };
}

function buildState(
  caster: ClericFixture,
  monsters: { actor: CombatActor; runtime: ActorRuntimeState }[],
  allies: AllyFixture[] = [],
): EngineState {
  return {
    characters: [caster.character],
    combatActors: [...monsters.map((m) => m.actor), ...allies.map((a) => a.actor)],
    runtime: {
      [caster.character.id]: caster.runtime,
      ...Object.fromEntries(monsters.map((m) => [m.actor.id, m.runtime])),
      ...Object.fromEntries(allies.map((a) => [a.actor.id, a.runtime])),
    },
    combat: null,
    scene: 'temple ruins',
  };
}

// ─── E2E scenarios ─────────────────────────────────────────────────────────

describe('E2E — concentration loop', () => {
  it('Cleric casts bless → set_concentration → bless target takes 21 dmg → fails CON save → bless ends', () => {
    // CON 8 → -1 mod, no proficiency. DC 10 needs roll ≥ 11 → very fail-prone.
    const cleric = makeCleric({ conScore: 8 });
    const ally = makeAlly({ id: 'ally1' });
    let state = buildState(cleric, [], [ally]);

    // 1. Cast bless on the cleric herself + ally.
    const castResult = castSpell(
      {
        caster: cleric.character,
        runtime: cleric.runtime,
        spellSlug: 'bless',
        slotLevel: 1,
        targets: [{ id: cleric.character.id }, { id: 'ally1' }],
        currentRound: 1,
      },
      () => 0.5,
    );
    expect(castResult.ok).toBe(true);
    // bless emits add_condition x2, set_concentration, use_spell_slot.
    const castOps = castResult.mutations.map((m) => m.op);
    expect(castOps).toContain('set_concentration');
    expect(castOps).toContain('use_spell_slot');

    state = applyMutations(state, castResult.mutations);
    expect(state.runtime[cleric.character.id]!.concentratingOn).toMatchObject({
      spellSlug: 'bless',
      slotLevel: 1,
    });
    expect(state.runtime[cleric.character.id]!.spellSlotsUsed?.[1]).toBe(1);

    // 2. Cleric takes 21 damage → DC = max(10, 10) = 10. The runtime has the
    //    active concentratingOn so applyDamage emits a concentration_check.
    const dmgResult = applyDamage({
      target: cleric.character,
      runtime: state.runtime[cleric.character.id]!,
      amount: 21,
      type: 'piercing',
    });
    expect(dmgResult.ok).toBe(true);
    const checkMut = dmgResult.mutations.find((m) => m.op === 'concentration_check');
    expect(checkMut).toBeDefined();
    if (checkMut?.op === 'concentration_check') {
      expect(checkMut.dc).toBe(10);
    }
    state = applyMutations(state, dmgResult.mutations);

    // 3. AI Master invokes concentration_check tool with a low rng → fails
    //    save (roll 1 + (-1) = 0 < DC 10).
    const concResult = handleConcentrationCheck(
      { rng: () => 0.05 },
      state,
      { actorId: cleric.character.id, dc: 10 },
    );
    expect(concResult.ok).toBe(true);
    expect(concResult.data?.success).toBe(false);
    state = applyMutations(state, concResult.mutations);

    // 4. Concentration broken.
    expect(state.runtime[cleric.character.id]!.concentratingOn).toBeUndefined();
  });

  it('Cleric casting bless then hold-person breaks bless first', () => {
    const cleric = makeCleric();
    let state = buildState(cleric, []);

    // Cast bless on self.
    const cast1 = castSpell(
      {
        caster: cleric.character,
        runtime: cleric.runtime,
        spellSlug: 'bless',
        slotLevel: 1,
        targets: [{ id: cleric.character.id }],
        currentRound: 1,
      },
      () => 0.5,
    );
    expect(cast1.ok).toBe(true);
    state = applyMutations(state, cast1.mutations);
    expect(state.runtime[cleric.character.id]!.concentratingOn).toMatchObject({
      spellSlug: 'bless',
    });

    // Cast hold-person (also concentration) — must break bless first.
    const cast2 = castSpell(
      {
        caster: cleric.character,
        runtime: state.runtime[cleric.character.id]!,
        spellSlug: 'hold-person',
        slotLevel: 2,
        targets: [{ id: 'ally1' }],
        currentRound: 3,
      },
      () => 0.5,
    );
    expect(cast2.ok).toBe(true);
    const ops = cast2.mutations.map((m) => m.op);
    expect(ops).toContain('break_concentration');
    expect(ops).toContain('set_concentration');
    expect(ops.indexOf('break_concentration')).toBeLessThan(ops.indexOf('set_concentration'));

    // The break_concentration mutation must carry reason='new_concentration'.
    const breakMut = cast2.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toBeDefined();
    if (breakMut?.op === 'break_concentration') {
      expect(breakMut.reason).toBe('new_concentration');
    }

    state = applyMutations(state, cast2.mutations);
    expect(state.runtime[cleric.character.id]!.concentratingOn).toMatchObject({
      spellSlug: 'hold-person',
      slotLevel: 2,
    });
  });

  it('Cleric concentrating drops to 0 HP → break_concentration with reason=incapacitated', () => {
    const cleric = makeCleric({ hpCurrent: 5 });
    let state = buildState(cleric, []);

    // Cast bless on self → start concentration.
    const cast = castSpell(
      {
        caster: cleric.character,
        runtime: cleric.runtime,
        spellSlug: 'bless',
        slotLevel: 1,
        targets: [{ id: cleric.character.id }],
        currentRound: 1,
      },
      () => 0.5,
    );
    expect(cast.ok).toBe(true);
    state = applyMutations(state, cast.mutations);
    expect(state.runtime[cleric.character.id]!.concentratingOn).toBeDefined();

    // Take 8 damage at 5 HP → goes to 0 HP. Damage 8 < hpMax 38, so not killed.
    const dmgResult = applyDamage({
      target: cleric.character,
      runtime: state.runtime[cleric.character.id]!,
      amount: 8,
      type: 'piercing',
    });
    expect(dmgResult.ok).toBe(true);

    // Should emit break_concentration with reason='incapacitated' — no
    // concentration_check (the PC is dropping to 0, so no save is rolled).
    const breakMut = dmgResult.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toBeDefined();
    if (breakMut?.op === 'break_concentration') {
      expect(breakMut.reason).toBe('incapacitated');
    }
    const concCheck = dmgResult.mutations.find((m) => m.op === 'concentration_check');
    expect(concCheck).toBeUndefined();

    state = applyMutations(state, dmgResult.mutations);
    expect(state.runtime[cleric.character.id]!.concentratingOn).toBeUndefined();
    expect(state.runtime[cleric.character.id]!.hpCurrent).toBe(0);
  });

  it('Wizard casts detect-magic as ritual → no slot consumed', () => {
    // Reuse the cleric helper as a generic prepared caster — spellsKnown
    // includes detect-magic. The narrative class doesn't matter here.
    const caster = makeCleric();
    const state = buildState(caster, []);

    const cast = castSpell(
      {
        caster: caster.character,
        runtime: caster.runtime,
        spellSlug: 'detect-magic',
        slotLevel: 1,
        targets: [],
        currentRound: 0,
        asRitual: true,
        spellMeta: { ritual: true, concentration: false },
      },
      () => 0.5,
    );

    expect(cast.ok).toBe(true);
    const slotMut = cast.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeUndefined();
    expect(cast.data?.effects).toContain('ritual');
    // State unchanged (no slot consumption).
    const post = applyMutations(state, cast.mutations);
    expect(post.runtime[caster.character.id]!.spellSlotsUsed?.[1] ?? 0).toBe(0);
  });

  it('Wizard casting fire-bolt with asRitual:true errors', () => {
    const caster = makeCleric();
    buildState(caster, []);

    const cast = castSpell(
      {
        caster: caster.character,
        runtime: caster.runtime,
        spellSlug: 'fire-bolt',
        slotLevel: 0,
        targets: [{ id: 'm1', ac: 10 }],
        currentRound: 0,
        asRitual: true,
        spellMeta: { ritual: false, concentration: false },
      },
      () => 0.5,
    );

    expect(cast.ok).toBe(false);
    expect(cast.error).toMatch(/ritual/i);
  });
});
