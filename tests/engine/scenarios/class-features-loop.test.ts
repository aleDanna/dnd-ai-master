import { describe, expect, it } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import {
  handleEndRage,
  handleGrantBardicInspiration,
  handleStartRage,
  handleUseActionSurge,
  handleUseChannelDivinity,
  handleUseLayOnHands,
} from '@/engine/tools/handlers';
import { newTurnState } from '@/engine/combat/turn-state';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  FeatureInstance,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// E2E driver against an in-memory EngineState. Mutation semantics MUST
// match the DB applicator — keep this in lockstep with
// src/sessions/applicator.ts. Phase 11 extends it with the 5 class-feature
// mutations: use_class_feature, restore_class_feature,
// modify_lay_on_hands_pool, mark_sneak_attack, reset_action_for_surge.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
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
    case 'use_class_feature': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.resourcesUsed ?? {}) };
      const inc = Math.max(1, Math.floor(m.uses ?? 1));
      used[m.featureSlug] = (used[m.featureSlug] ?? 0) + inc;
      next.runtime[m.actorId] = { ...rt, resourcesUsed: used };
      break;
    }
    case 'restore_class_feature': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.resourcesUsed ?? {}) };
      const dec = Math.max(1, Math.floor(m.uses ?? 1));
      const cur = used[m.featureSlug] ?? 0;
      const nextVal = Math.max(0, cur - dec);
      if (nextVal === 0) delete used[m.featureSlug];
      else used[m.featureSlug] = nextVal;
      next.runtime[m.actorId] = { ...rt, resourcesUsed: used };
      break;
    }
    case 'modify_lay_on_hands_pool': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const used = { ...(rt.resourcesUsed ?? {}) };
      const cur = used['lay_on_hands'] ?? 0;
      const nextVal = Math.max(0, cur + Math.floor(m.delta));
      if (nextVal === 0) delete used['lay_on_hands'];
      else used['lay_on_hands'] = nextVal;
      next.runtime[m.actorId] = { ...rt, resourcesUsed: used };
      break;
    }
    case 'mark_sneak_attack': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: { ...ts, sneakAttackUsed: true } };
      break;
    }
    case 'reset_action_for_surge': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = { ...rt, turnState: { ...ts, actionUsed: false } };
      break;
    }
    case 'consume_action':
    case 'consume_movement':
    case 'concentration_check':
    case 'use_resource':
    case 'mark_loading_shot':
    case 'mark_offhand_attack':
    case 'consume_ammo':
    case 'opportunity_attack_triggered':
    case 'spend_inspiration':
    case 'grant_inspiration':
    case 'set_temp_hp':
      break;
    default:
      break;
  }
  return next;
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function feat(slug: string, usesMax: number | 'unlimited' = 1): FeatureInstance {
  return { slug, source: 'class', usesMax, description: slug };
}

function rng(values: number[]) {
  let i = 0;
  return {
    intInclusive(min: number, max: number) {
      if (i >= values.length) return min;
      const v = values[i]!;
      i += 1;
      if (v < min) return min;
      if (v > max) return max;
      return v;
    },
  };
}

function rogue(): Character {
  return {
    id: 'rogue1', name: 'Sly', level: 5, xp: 0,
    classSlug: 'rogue',
    classes: [{ slug: 'rogue', level: 5 }],
    raceSlug: 'human', backgroundSlug: 'criminal',
    abilities: { STR: 10, DEX: 18, CON: 12, INT: 12, WIS: 10, CHA: 14 },
    proficiencyBonus: 3, hpMax: 30, ac: 14, speed: 30,
    proficiencies: { saves: ['DEX', 'INT'], skills: ['Stealth'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light'], tools: [], languages: [] },
    spellcasting: null,
    features: [feat('sneak_attack', 'unlimited')],
    inventory: [{ slug: 'rapier', qty: 1, equipped: true }],
    hitDiceMax: 5, hitDieSize: 8,
  };
}

function barbarian(): Character {
  return {
    id: 'barb1', name: 'Krug', level: 5, xp: 0,
    classSlug: 'barbarian',
    classes: [{ slug: 'barbarian', level: 5 }],
    raceSlug: 'half-orc', backgroundSlug: 'outlander',
    abilities: { STR: 18, DEX: 14, CON: 16, INT: 8, WIS: 12, CHA: 8 },
    proficiencyBonus: 3, hpMax: 50, ac: 14, speed: 30,
    proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Shield'], tools: [], languages: [] },
    spellcasting: null,
    features: [feat('rage', 3)],
    inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
    hitDiceMax: 5, hitDieSize: 12,
  };
}

function fighter(): Character {
  return {
    id: 'fighter1', name: 'Tharion', level: 5, xp: 0,
    classSlug: 'fighter',
    classes: [{ slug: 'fighter', level: 5 }],
    raceSlug: 'human', backgroundSlug: 'soldier',
    abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
    proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: [] },
    spellcasting: null,
    features: [feat('action_surge', 1)],
    inventory: [],
    hitDiceMax: 5, hitDieSize: 10,
  };
}

function paladin(): Character {
  return {
    id: 'pal1', name: 'Lyra', level: 5, xp: 0,
    classSlug: 'paladin',
    classes: [{ slug: 'paladin', level: 5 }],
    raceSlug: 'human', backgroundSlug: 'acolyte',
    abilities: { STR: 16, DEX: 10, CON: 14, INT: 8, WIS: 12, CHA: 18 },
    proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
    proficiencies: { saves: ['WIS', 'CHA'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: [] },
    spellcasting: null,
    features: [feat('lay_on_hands', 'unlimited'), feat('channel_divinity', 1)],
    inventory: [],
    hitDiceMax: 5, hitDieSize: 10,
  };
}

function bard(): Character {
  return {
    id: 'bard1', name: 'Lia', level: 5, xp: 0,
    classSlug: 'bard',
    classes: [{ slug: 'bard', level: 5 }],
    raceSlug: 'half-elf', backgroundSlug: 'entertainer',
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 12, WIS: 10, CHA: 18 },
    proficiencyBonus: 3, hpMax: 30, ac: 13, speed: 30,
    proficiencies: { saves: ['DEX', 'CHA'], skills: [], expertise: [], weapons: [], armor: ['Light'], tools: [], languages: [] },
    spellcasting: null,
    features: [feat('bardic_inspiration', 4)],
    inventory: [],
    hitDiceMax: 5, hitDieSize: 8,
  };
}

function ally(): Character {
  return {
    id: 'ally1', name: 'Arin', level: 5, xp: 0,
    classSlug: 'ranger',
    classes: [{ slug: 'ranger', level: 5 }],
    raceSlug: 'human', backgroundSlug: 'outlander',
    abilities: { STR: 12, DEX: 16, CON: 12, INT: 10, WIS: 14, CHA: 10 },
    proficiencyBonus: 3, hpMax: 40, ac: 14, speed: 30,
    proficiencies: { saves: ['STR', 'DEX'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Shield'], tools: [], languages: [] },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 5, hitDieSize: 10,
  };
}

function ogre(): CombatActor {
  return {
    id: 'm1', kind: 'monster', name: 'Ogre',
    hpMax: 59, ac: 11, abilities: { STR: 19, DEX: 8, CON: 16, INT: 5, WIS: 7, CHA: 7 },
    proficiencyBonus: 2, initiativeBonus: -1,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
  };
}

function buildState(opts: { characters: Character[]; combatActors?: CombatActor[]; turnStates?: Record<string, ReturnType<typeof newTurnState>> }): EngineState {
  const runtime: Record<string, ActorRuntimeState> = {};
  for (const c of opts.characters) {
    runtime[c.id] = {
      actorId: c.id,
      hpCurrent: c.hpMax,
      tempHp: 0,
      conditions: [],
      deathSaves: { successes: 0, failures: 0 },
      resourcesUsed: {},
      ...(opts.turnStates?.[c.id] ? { turnState: opts.turnStates[c.id] } : {}),
    };
  }
  for (const a of opts.combatActors ?? []) {
    runtime[a.id] = {
      actorId: a.id,
      hpCurrent: a.hpMax,
      tempHp: 0,
      conditions: [],
      deathSaves: { successes: 0, failures: 0 },
    };
  }
  return {
    characters: opts.characters,
    combatActors: opts.combatActors ?? [],
    runtime,
    combat: null,
    scene: 'class-features-test',
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('E2E — class features loop', () => {
  it('1. Rogue L5 makes attack with ADV + useSneakAttack:true → +3d6 damage', () => {
    const state = buildState({
      characters: [rogue()],
      combatActors: [ogre()],
      turnStates: { rogue1: newTurnState() },
    });
    // Sequence: d20a=20 (crit), d20b=15, weapon 2d8 (crit) = [6,4], sneak 6d6 (3 doubled)
    const r = makeAttack(
      {
        attacker: state.characters[0]!,
        target: state.combatActors[0]!,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
        advantage: true,
        attackerRuntime: state.runtime['rogue1'],
        targetRuntime: state.runtime['m1'],
      },
      rng([20, 15, 6, 4, 4, 5, 3, 4, 5, 3]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
    // 6 SA dice (3 doubled): 4+5+3+4+5+3 = 24
    expect(r.data?.sneakAttackDamage).toBe(24);
    expect(r.mutations.some((m) => m.op === 'mark_sneak_attack')).toBe(true);
  });

  it('2. Same rogue tries 2nd Sneak Attack same turn → fails (one per turn)', () => {
    const state = buildState({
      characters: [rogue()],
      combatActors: [ogre()],
      turnStates: { rogue1: { ...newTurnState(), sneakAttackUsed: true } },
    });
    const r = makeAttack(
      {
        attacker: state.characters[0]!,
        target: state.combatActors[0]!,
        weapon: { name: 'Rapier', damage: '1d8', damageType: 'piercing', profGroup: 'Martial', useDex: true, properties: ['finesse'] },
        useSneakAttack: true,
        advantage: true,
        attackerRuntime: state.runtime['rogue1'],
        targetRuntime: state.runtime['m1'],
      },
      rng([20, 15, 6]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sneak_attack_already_used');
  });

  it('3. Barbarian L5 starts rage → \'raging\' condition added, use consumed', () => {
    let state = buildState({ characters: [barbarian()], combatActors: [ogre()] });
    const r = handleStartRage(state, { actor: 'barb1' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.runtime['barb1']!.conditions.some((c) => c.slug === 'raging')).toBe(true);
    expect(state.runtime['barb1']!.resourcesUsed?.['rage']).toBe(1);
  });

  it('4. Raging barbarian melee with longsword → +2 rage damage on hit', () => {
    let state = buildState({ characters: [barbarian()], combatActors: [ogre()] });
    const start = handleStartRage(state, { actor: 'barb1' });
    state = applyAll(state, start.mutations);
    // d20=18, 1d8=6 → base 6+4(STR)=10 + 2 rage = 12 to a non-resistant ogre
    const r = makeAttack(
      {
        attacker: state.characters[0]!,
        target: state.combatActors[0]!,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['versatile'] },
        attackerRuntime: state.runtime['barb1'],
        targetRuntime: state.runtime['m1'],
      },
      rng([18, 6]),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.rageBonus).toBe(2);
    expect(r.data?.rawDamage).toBe(12);
    expect(r.data?.finalDamage).toBe(12);
  });

  it('5. Fighter L5 uses Action Surge → actionUsed reset to false', () => {
    let state = buildState({
      characters: [fighter()],
      turnStates: {
        fighter1: { ...newTurnState(), actionUsed: true, bonusUsed: true },
      },
    });
    expect(state.runtime['fighter1']!.turnState!.actionUsed).toBe(true);
    expect(state.runtime['fighter1']!.turnState!.bonusUsed).toBe(true);

    const r = handleUseActionSurge(state, { actor: 'fighter1' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.runtime['fighter1']!.turnState!.actionUsed).toBe(false);
    // Bonus left untouched.
    expect(state.runtime['fighter1']!.turnState!.bonusUsed).toBe(true);
    expect(state.runtime['fighter1']!.resourcesUsed?.['action_surge']).toBe(1);
  });

  it('6. Paladin L5 uses Lay on Hands 10 points on ally → ally healed +10, pool 25→15', () => {
    let state = buildState({ characters: [paladin(), ally()] });
    // Damage the ally first.
    state = applyMutation(state, { op: 'apply_damage', actorId: 'ally1', amount: 15, type: 'slashing' });
    expect(state.runtime['ally1']!.hpCurrent).toBe(40 - 15); // 25

    const r = handleUseLayOnHands(state, { actor: 'pal1', targetId: 'ally1', points: 10 });
    expect(r.ok).toBe(true);
    expect(r.data?.poolBefore).toBe(25); // 5 * 5
    expect(r.data?.poolAfter).toBe(15);

    state = applyAll(state, r.mutations);
    expect(state.runtime['ally1']!.hpCurrent).toBe(35); // 25 + 10
    expect(state.runtime['pal1']!.resourcesUsed?.['lay_on_hands']).toBe(10);
  });

  it('7. Bard L5 grants bardic inspiration to ally → ally gets bardic_inspired condition', () => {
    let state = buildState({ characters: [bard(), ally()] });
    const r = handleGrantBardicInspiration(state, { actor: 'bard1', targetId: 'ally1' });
    expect(r.ok).toBe(true);
    expect(r.data?.dieSize).toBe(8); // bard L5 → d8
    state = applyAll(state, r.mutations);
    expect(state.runtime['ally1']!.conditions.some((c) => c.slug === 'bardic_inspired')).toBe(true);
    const cond = state.runtime['ally1']!.conditions.find((c) => c.slug === 'bardic_inspired')!;
    expect(cond.source).toBe('bardic_inspiration:d8');
    expect(state.runtime['bard1']!.resourcesUsed?.['bardic_inspiration']).toBe(1);
  });

  // Bonus scenarios beyond the plan's 7 — coverage of additional flows.

  it('Rage end via end_rage drops the raging condition', () => {
    let state = buildState({ characters: [barbarian()] });
    const start = handleStartRage(state, { actor: 'barb1' });
    state = applyAll(state, start.mutations);
    expect(state.runtime['barb1']!.conditions.some((c) => c.slug === 'raging')).toBe(true);

    const end = handleEndRage(state, { actor: 'barb1' });
    expect(end.ok).toBe(true);
    state = applyAll(state, end.mutations);
    expect(state.runtime['barb1']!.conditions.some((c) => c.slug === 'raging')).toBe(false);
  });

  it('Channel Divinity (paladin): consumes 1 use', () => {
    let state = buildState({ characters: [paladin()] });
    const r = handleUseChannelDivinity(state, { actor: 'pal1', effect: 'sacred_weapon' });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.runtime['pal1']!.resourcesUsed?.['channel_divinity']).toBe(1);
  });

  it('Lay on Hands: cure poison removes poisoned condition AND consumes 5 from pool', () => {
    let state = buildState({ characters: [paladin(), ally()] });
    state = applyMutation(state, {
      op: 'add_condition',
      actorId: 'ally1',
      condition: { slug: 'poisoned', source: 'spider', durationRounds: 'until_removed', appliedRound: 0 },
    });
    expect(state.runtime['ally1']!.conditions.some((c) => c.slug === 'poisoned')).toBe(true);

    const r = handleUseLayOnHands(state, { actor: 'pal1', targetId: 'ally1', curePoison: true });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.runtime['ally1']!.conditions.some((c) => c.slug === 'poisoned')).toBe(false);
    expect(state.runtime['pal1']!.resourcesUsed?.['lay_on_hands']).toBe(5);
  });
});
