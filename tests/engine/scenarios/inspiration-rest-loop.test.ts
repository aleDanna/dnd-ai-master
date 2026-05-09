import { describe, expect, it } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { longRest } from '@/engine/rests';
import {
  TOOL_HANDLERS,
  handleForcedMarch,
  handleGrantInspiration,
} from '@/engine/tools/handlers';
import { createRng } from '@/engine/rand';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// E2E driver against an in-memory EngineState. Mutation semantics MUST
// match the DB applicator — keep this in lockstep with
// src/sessions/applicator.ts. Mirrors the pattern from death-save-loop and
// concentration-loop scenarios. Adds the inspiration / long-rest / exhaustion
// tracking added in Phase 4.

interface ScenarioState extends EngineState {
  /** Phase 4: 24h cooldown timestamp (ms since epoch). */
  lastLongRestAtMs?: number;
}

function applyMutation(state: ScenarioState, m: Mutation): ScenarioState {
  const next: ScenarioState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
  };
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
      next.runtime[m.actorId] = { ...rt, hpCurrent: Math.min(hpMax, rt.hpCurrent + m.amount) };
      break;
    }
    case 'set_temp_hp': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, tempHp: m.amount };
      break;
    }
    case 'add_condition': {
      // PHB §4.1 exhaustion: stacked level on runtime, only one entry in conds[].
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      if (m.condition.slug === 'exhaustion') {
        const curLevel = rt.exhaustionLevel ?? 0;
        const newLevel = Math.min(6, curLevel + 1);
        const conds = rt.conditions.slice();
        if (!conds.some((c) => c.slug === 'exhaustion')) conds.push(m.condition);
        const flags = rt.flags ?? {};
        const nextFlags = newLevel >= 6 ? { ...flags, dead: true } : flags;
        next.runtime[m.actorId] = {
          ...rt,
          conditions: conds,
          exhaustionLevel: newLevel,
          flags: nextFlags,
        };
      } else {
        const conds = rt.conditions.filter((c) => c.slug !== m.condition.slug);
        conds.push(m.condition);
        next.runtime[m.actorId] = { ...rt, conditions: conds };
      }
      break;
    }
    case 'remove_condition': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      if (m.conditionSlug === 'exhaustion') {
        const curLevel = rt.exhaustionLevel ?? 0;
        if (curLevel <= 0) break;
        const newLevel = Math.max(0, curLevel - 1);
        const conds =
          newLevel === 0
            ? rt.conditions.filter((c) => c.slug !== 'exhaustion')
            : rt.conditions;
        next.runtime[m.actorId] = { ...rt, conditions: conds, exhaustionLevel: newLevel };
      } else {
        next.runtime[m.actorId] = {
          ...rt,
          conditions: rt.conditions.filter((c) => c.slug !== m.conditionSlug),
        };
      }
      break;
    }
    case 'restore_spell_slot': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.spellSlotsUsed ?? {}) };
      const cur = used[m.level] ?? 0;
      const nextUsed = Math.max(0, cur - m.amount);
      if (nextUsed === 0) delete used[m.level];
      else used[m.level] = nextUsed;
      next.runtime[m.actorId] = { ...rt, spellSlotsUsed: used };
      break;
    }
    case 'restore_resource': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const usedR = { ...(rt.resourcesUsed ?? {}) };
      usedR[m.featureSlug] = Math.max(0, (usedR[m.featureSlug] ?? 0) - m.amount);
      next.runtime[m.actorId] = { ...rt, resourcesUsed: usedR };
      break;
    }
    case 'restore_hit_dice': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = {
        ...rt,
        hitDiceRemaining: (rt.hitDiceRemaining ?? 0) + m.amount,
      };
      break;
    }
    case 'grant_inspiration': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx >= 0) next.characters[idx] = { ...next.characters[idx]!, inspiration: true };
      break;
    }
    case 'spend_inspiration': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx >= 0) next.characters[idx] = { ...next.characters[idx]!, inspiration: false };
      break;
    }
    case 'set_long_rest_at': {
      next.lastLongRestAtMs = m.epochMs;
      break;
    }
    case 'consume_action':
    case 'concentration_check':
    case 'use_spell_slot':
    case 'use_resource':
    case 'spend_hit_die':
    case 'opportunity_attack_triggered':
      // Not exercised in these scenarios.
      break;
    default:
      break;
  }
  return next;
}

function applyAll(state: ScenarioState, mutations: Mutation[]): ScenarioState {
  return mutations.reduce(applyMutation, state);
}

// rng helper: returns a value that, after Math.floor(rng() * 20) + 1, yields N.
function rngForHandler(values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('rng exhausted (handler)');
    const n = values[i]!;
    i += 1;
    return (n - 0.5) / 20;
  };
}

// rng for engine functions that consume an Rng object (rollD20 / rollDamage).
// Returns d20 results in order.
function makeAttackRng(values: number[]) {
  let i = 0;
  return createRng(() => {
    if (i >= values.length) throw new Error('rng exhausted (attack)');
    const n = values[i]!;
    i += 1;
    return (n - 0.5) / 20;
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function fighter(opts: { inspiration?: boolean } = {}): Character {
  return {
    id: 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 14, CON: 10, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 44,
    ac: 18,
    speed: 30,
    proficiencies: {
      saves: ['STR'], // intentionally NOT proficient in CON for forced-march scenario
      skills: [],
      expertise: [],
      weapons: ['Simple', 'Martial'],
      armor: ['Light', 'Medium', 'Heavy', 'Shield'],
      tools: [],
      languages: ['Common'],
    },
    inspiration: opts.inspiration,
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 5,
    hitDieSize: 10,
  };
}

function goblin(): CombatActor {
  return {
    id: 'm1',
    kind: 'monster',
    name: 'Goblin',
    monsterSlug: 'goblin',
    hpMax: 7,
    ac: 12,
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    initiativeBonus: 2,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
  };
}

function freshState(opts: {
  pc?: Character;
  hpCurrent?: number;
  exhaustionLevel?: number;
  lastLongRestAtMs?: number;
  hitDiceRemaining?: number;
} = {}): ScenarioState {
  const pc = opts.pc ?? fighter();
  const rt: ActorRuntimeState = {
    actorId: pc.id,
    hpCurrent: opts.hpCurrent ?? pc.hpMax,
    tempHp: 0,
    deathSaves: { successes: 0, failures: 0 },
    conditions:
      (opts.exhaustionLevel ?? 0) > 0
        ? [
            {
              slug: 'exhaustion',
              source: 'pre-existing',
              durationRounds: 'until_removed',
              appliedRound: 0,
            },
          ]
        : [],
    exhaustionLevel: opts.exhaustionLevel ?? 0,
    hitDiceRemaining: opts.hitDiceRemaining ?? pc.hitDiceMax,
  };
  return {
    characters: [pc],
    combatActors: [goblin()],
    runtime: {
      [pc.id]: rt,
      m1: {
        actorId: 'm1',
        hpCurrent: 7,
        tempHp: 0,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
      },
    },
    combat: null,
    scene: 'wilderness',
    lastLongRestAtMs: opts.lastLongRestAtMs,
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('E2E — inspiration + rest + survival', () => {
  it('Inspiration grant → use on attack → ADV (2d20) + spend mutation → applicator clears flag', () => {
    let state = freshState();
    expect(state.characters[0]!.inspiration).toBeFalsy();

    // 1. DM grants Inspiration.
    const grant = handleGrantInspiration(state, { character: 'pc1' });
    expect(grant.ok).toBe(true);
    expect(grant.mutations).toEqual([
      { op: 'grant_inspiration', characterId: 'pc1' },
    ]);
    state = applyAll(state, grant.mutations);
    expect(state.characters[0]!.inspiration).toBe(true);

    // 2. PC attacks the goblin spending Inspiration. The attack roll is 2d20
    //    (advantage). Force the rng so the d20s are 18 and 4 — advantage picks
    //    18, so the attack hits AC 12 (18 + 5 bonus = 23). Damage: 1d8+3.
    const attackRng = makeAttackRng([18, 4, 6]); // d20=18, d20=4, dmg d8=6
    const attack = makeAttack(
      {
        attacker: state.characters[0]!,
        target: state.combatActors[0]!,
        weapon: { name: 'longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
        useInspiration: true,
      },
      attackRng,
    );
    expect(attack.ok).toBe(true);
    // ADV → first roll has 2 d20 entries.
    expect(attack.rolls[0]!.rolls.length).toBe(2);
    // spend_inspiration mutation MUST be present on every exit path.
    expect(attack.mutations.find((m) => m.op === 'spend_inspiration')).toEqual({
      op: 'spend_inspiration',
      characterId: 'pc1',
    });

    // 3. Apply mutations — flag should clear.
    state = applyAll(state, attack.mutations);
    expect(state.characters[0]!.inspiration).toBe(false);
  });

  it('Long rest at 0 HP errors with cannot_rest_at_zero_hp', () => {
    const state = freshState({ hpCurrent: 0 });
    const r = longRest({
      char: state.characters[0]!,
      runtime: state.runtime.pc1!,
      currentEpochMs: 1_000_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_rest_at_zero_hp');
    expect(r.mutations).toEqual([]);
  });

  it('Long rest cooldown: t=0 succeeds, t=12h fails, t=25h succeeds', () => {
    // First long rest at t=0 — passes.
    let state = freshState({ hpCurrent: 30 });
    const r1 = longRest({
      char: state.characters[0]!,
      runtime: state.runtime.pc1!,
      currentEpochMs: 0,
    });
    expect(r1.ok).toBe(true);
    expect(r1.mutations.find((m) => m.op === 'set_long_rest_at')).toEqual({
      op: 'set_long_rest_at',
      epochMs: 0,
    });
    state = applyAll(state, r1.mutations);
    expect(state.lastLongRestAtMs).toBe(0);

    // 12h later — fails with long_rest_cooldown.
    const r2 = longRest({
      char: state.characters[0]!,
      runtime: state.runtime.pc1!,
      lastLongRestAtMs: state.lastLongRestAtMs,
      currentEpochMs: 12 * 60 * 60 * 1000,
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('long_rest_cooldown');

    // 25h later — passes.
    const r3 = longRest({
      char: state.characters[0]!,
      runtime: state.runtime.pc1!,
      lastLongRestAtMs: state.lastLongRestAtMs,
      currentEpochMs: 25 * 60 * 60 * 1000,
    });
    expect(r3.ok).toBe(true);
    expect(r3.mutations.find((m) => m.op === 'set_long_rest_at')).toEqual({
      op: 'set_long_rest_at',
      epochMs: 25 * 60 * 60 * 1000,
    });
  });

  it('Long rest with exhaustion 3 → emits remove_condition exhaustion → applicator decrements to 2', () => {
    let state = freshState({ hpCurrent: 20, exhaustionLevel: 3 });
    expect(state.runtime.pc1!.exhaustionLevel).toBe(3);

    const r = longRest({
      char: state.characters[0]!,
      runtime: state.runtime.pc1!,
      currentEpochMs: 0,
    });
    expect(r.ok).toBe(true);
    const removeMut = r.mutations.find(
      (m) => m.op === 'remove_condition' && m.conditionSlug === 'exhaustion',
    );
    expect(removeMut).toBeDefined();

    state = applyAll(state, r.mutations);
    expect(state.runtime.pc1!.exhaustionLevel).toBe(2);
    // The condition entry is still in conditions[] (level > 0).
    expect(state.runtime.pc1!.conditions.some((c) => c.slug === 'exhaustion')).toBe(true);
    // HP fully restored.
    expect(state.runtime.pc1!.hpCurrent).toBe(state.characters[0]!.hpMax);
  });

  it('Forced march 12h fail → CON save vs DC 14 fails → exhaustion mutation → applicator increments level', () => {
    // Fighter has CON 10 (mod 0) and is NOT proficient in CON saves (saves: ['STR']).
    // 12 hours travel → DC 10 + (12 - 8) = 14. Roll 5 → total 5 → fail.
    let state = freshState();
    expect(state.runtime.pc1!.exhaustionLevel ?? 0).toBe(0);

    const r = handleForcedMarch({ rng: rngForHandler([5]) }, state, {
      actor: 'pc1',
      hoursTraveled: 12,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.dc).toBe(14);
    expect(r.data?.saveRoll).toBe(5);
    expect(r.data?.saveSuccess).toBe(false);
    expect(r.data?.exhaustionApplied).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'add_condition',
        actorId: 'pc1',
        condition: {
          slug: 'exhaustion',
          source: 'forced march',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);

    state = applyAll(state, r.mutations);
    expect(state.runtime.pc1!.exhaustionLevel).toBe(1);
    expect(state.runtime.pc1!.conditions.some((c) => c.slug === 'exhaustion')).toBe(true);
  });

  it('Apply_starvation past survival threshold → exhaustion mutation → applicator stacks level', () => {
    // Fighter has CON 10 (mod 0) → 3-day survival window. Day 4 should trigger
    // exhaustion automatically (no save).
    let state = freshState();
    expect(state.runtime.pc1!.exhaustionLevel ?? 0).toBe(0);

    const r = TOOL_HANDLERS['apply_starvation']!(state, {
      actor: 'pc1',
      daysWithoutFood: 4,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { exhaustionApplied: boolean }).exhaustionApplied).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'add_condition',
        actorId: 'pc1',
        condition: {
          slug: 'exhaustion',
          source: 'starvation',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);

    state = applyAll(state, r.mutations);
    expect(state.runtime.pc1!.exhaustionLevel).toBe(1);
  });
});
