import { describe, expect, it } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import type { WeaponSpec } from '@/engine/combat/attack';
import { savingThrow } from '@/engine/checks';
import { newTurnState } from '@/engine/combat/turn-state';
import { makeSeededRng } from '@/engine/rand';
import type {
  ActorRuntimeState,
  Character,
  CombatActor,
  EngineState,
  Mutation,
  TurnState,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// Mutation semantics MUST match the DB applicator. This driver covers the
// Phase 8 ops: mark_loading_shot, mark_offhand_attack, consume_ammo,
// plus the existing consume_action and start_turn.

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const next: EngineState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
  };
  switch (m.op) {
    case 'apply_damage': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, hpCurrent: Math.max(0, rt.hpCurrent - m.amount) };
      break;
    }
    case 'start_turn': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      next.runtime[m.actorId] = { ...rt, turnState: newTurnState() };
      break;
    }
    case 'consume_action': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      const map = { action: 'actionUsed', bonus: 'bonusUsed', reaction: 'reactionUsed' } as const;
      next.runtime[m.actorId] = {
        ...rt,
        turnState: { ...ts, [map[m.kind]]: true },
      };
      break;
    }
    case 'mark_loading_shot': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = {
        ...rt,
        turnState: { ...ts, loadingShotUsed: true },
      };
      break;
    }
    case 'mark_offhand_attack': {
      const rt = next.runtime[m.actorId];
      if (!rt) break;
      const ts = rt.turnState ?? newTurnState();
      next.runtime[m.actorId] = {
        ...rt,
        turnState: { ...ts, offHandAttackUsed: true },
      };
      break;
    }
    case 'consume_ammo': {
      const idx = next.characters.findIndex((c) => c.id === m.characterId);
      if (idx < 0) break;
      const char = next.characters[idx]!;
      const inv = char.inventory.slice();
      const itIdx = inv.findIndex((it) => it.slug === m.ammoSlug);
      if (itIdx < 0) break;
      const item = inv[itIdx]!;
      const newQty = item.qty - m.qty;
      if (newQty <= 0) {
        inv.splice(itIdx, 1);
      } else {
        inv[itIdx] = { ...item, qty: newQty };
      }
      next.characters[idx] = { ...char, inventory: inv };
      break;
    }
    default:
      break;
  }
  return next;
}

function applyMutations(state: EngineState, muts: Mutation[]): EngineState {
  return muts.reduce(applyMutation, state);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pcCharacter(opts: { id?: string; inventory?: Character['inventory'] } = {}): Character {
  return {
    id: opts.id ?? 'pc1',
    name: 'Tharion',
    level: 5,
    xp: 0,
    classSlug: 'fighter',
    raceSlug: 'human',
    backgroundSlug: 'soldier',
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    proficiencyBonus: 3,
    hpMax: 44,
    ac: 18,
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
    inventory: opts.inventory ?? [],
    hitDiceMax: 5,
    hitDieSize: 10,
  };
}

function goblin(opts: { id?: string; ac?: number; hp?: number } = {}): CombatActor {
  return {
    id: opts.id ?? 'g1',
    kind: 'monster',
    name: 'Goblin',
    hpMax: opts.hp ?? 7,
    ac: opts.ac ?? 13,
    abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    proficiencyBonus: 2,
    initiativeBonus: 2,
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
  };
}

function pcRuntime(actorId: string, opts: { hpCurrent?: number; turnState?: Partial<TurnState> } = {}): ActorRuntimeState {
  return {
    actorId,
    hpCurrent: opts.hpCurrent ?? 44,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    turnState: { ...newTurnState(), ...(opts.turnState ?? {}) },
  };
}

function monRuntime(actorId: string, hp: number): ActorRuntimeState {
  return {
    actorId,
    hpCurrent: hp,
    tempHp: 0,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
  };
}

const longsword: WeaponSpec = {
  name: 'Longsword',
  damage: '1d8',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['versatile'],
};

const halberd: WeaponSpec = {
  name: 'Halberd',
  damage: '1d10',
  damageType: 'slashing',
  profGroup: 'Martial',
  useDex: false,
  properties: ['heavy', 'reach', 'two-handed'],
};

const lightCrossbow: WeaponSpec = {
  name: 'Light Crossbow',
  damage: '1d8',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: true,
  properties: ['ammunition', 'loading', 'two-handed'],
  ammoSlug: 'crossbow-bolt',
  range: { normal: 80, long: 320 },
};

const dagger: WeaponSpec = {
  name: 'Dagger',
  damage: '1d4',
  damageType: 'piercing',
  profGroup: 'Simple',
  useDex: false,
  properties: ['finesse', 'light', 'thrown'],
};

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('combat-completeness-loop (PHB §3.12, §3.15, §9.4)', () => {
  it('1) PC attacks goblin behind half cover → +2 AC; same total may miss', () => {
    const pc = pcCharacter();
    const target = goblin({ ac: 13 });
    const state: EngineState = {
      characters: [pc],
      combatActors: [target],
      runtime: { [pc.id]: pcRuntime(pc.id), [target.id]: monRuntime(target.id, 7) },
      combat: null,
      scene: '',
    };

    // Find a seed where baseline hits but half cover misses.
    let foundDelta = false;
    for (let seed = 0; seed < 500; seed++) {
      const baseline = makeAttack({
        attacker: pc,
        target,
        weapon: longsword,
        attackerRuntime: state.runtime[pc.id],
        targetRuntime: state.runtime[target.id],
      }, makeSeededRng(seed));
      const withHalf = makeAttack({
        attacker: pc,
        target,
        weapon: longsword,
        attackerRuntime: state.runtime[pc.id],
        targetRuntime: state.runtime[target.id],
        cover: 'half',
      }, makeSeededRng(seed));
      const baseTotal = baseline.rolls[0]?.total ?? 0;
      const baseNat = baseline.rolls[0]?.rolls[0];
      if (baseNat === 20 || baseNat === 1) continue;
      if (baseTotal >= 13 && baseTotal < 15 && baseline.ok && !withHalf.ok) {
        foundDelta = true;
        break;
      }
    }
    expect(foundDelta).toBe(true);
  });

  it('2) PC attacks behind total cover → ok:false target_in_total_cover, no consumption', () => {
    const pc = pcCharacter();
    const target = goblin({ ac: 13 });
    const before = pcRuntime(pc.id);
    const r = makeAttack({
      attacker: pc,
      target,
      weapon: longsword,
      attackerRuntime: before,
      targetRuntime: monRuntime(target.id, 7),
      cover: 'total',
    }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('target_in_total_cover');
    expect(r.mutations).toEqual([]);
    // Action budget untouched.
    expect(before.turnState!.actionUsed).toBe(false);
  });

  it('3) Halberd PC attacks at 10ft → ok; same attack at 15ft → out_of_reach', () => {
    const pc = pcCharacter();
    const target = goblin({ ac: 12 });
    let saw10ftResolved = false;
    for (let seed = 0; seed < 50; seed++) {
      const r10 = makeAttack({
        attacker: pc,
        target,
        weapon: halberd,
        attackerRuntime: pcRuntime(pc.id),
        targetRuntime: monRuntime(target.id, 7),
        meleeRange: 10,
      }, makeSeededRng(seed));
      // Either hit or normal miss is fine; never out_of_reach.
      expect(r10.error).not.toBe('out_of_reach');
      if (r10.ok || r10.error === 'miss') {
        saw10ftResolved = true;
        break;
      }
    }
    expect(saw10ftResolved).toBe(true);

    const r15 = makeAttack({
      attacker: pc,
      target,
      weapon: halberd,
      attackerRuntime: pcRuntime(pc.id),
      targetRuntime: monRuntime(target.id, 7),
      meleeRange: 15,
    }, makeSeededRng(1));
    expect(r15.ok).toBe(false);
    expect(r15.error).toBe('out_of_reach');
  });

  it('4) Crossbow attack consumes 1 bolt; second shot same turn → loading_shot_already_used', () => {
    const pc = pcCharacter({
      inventory: [
        { slug: 'light-crossbow', qty: 1, equipped: true },
        { slug: 'crossbow-bolt', qty: 5, equipped: false },
      ],
    });
    const target = goblin({ ac: 12 });
    let state: EngineState = {
      characters: [pc],
      combatActors: [target],
      runtime: { [pc.id]: pcRuntime(pc.id), [target.id]: monRuntime(target.id, 7) },
      combat: null,
      scene: '',
    };

    // First shot — apply mutations.
    let firstResult: ReturnType<typeof makeAttack> | null = null;
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: state.characters[0]!,
        target,
        weapon: lightCrossbow,
        attackerRuntime: state.runtime[pc.id],
        targetRuntime: state.runtime[target.id],
        ranged: true,
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        firstResult = r;
        break;
      }
    }
    expect(firstResult).not.toBeNull();
    state = applyMutations(state, firstResult!.mutations);

    // Bolt count -1.
    const bolts = state.characters[0]!.inventory.find((it) => it.slug === 'crossbow-bolt');
    expect(bolts?.qty).toBe(4);
    // loadingShotUsed flag set.
    expect(state.runtime[pc.id]!.turnState!.loadingShotUsed).toBe(true);

    // Second shot same turn.
    const r2 = makeAttack({
      attacker: state.characters[0]!,
      target,
      weapon: lightCrossbow,
      attackerRuntime: state.runtime[pc.id],
      targetRuntime: state.runtime[target.id],
      ranged: true,
    }, makeSeededRng(99));
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('loading_shot_already_used');
    // No additional bolt consumed.
    const boltsAfter = state.characters[0]!.inventory.find((it) => it.slug === 'crossbow-bolt');
    expect(boltsAfter?.qty).toBe(4);
  });

  it('5) Attack action (longsword) then offHand dagger (bonus); second offHand → offhand_already_used', () => {
    const pc = pcCharacter();
    const target = goblin({ ac: 12 });
    let state: EngineState = {
      characters: [pc],
      combatActors: [target],
      runtime: { [pc.id]: pcRuntime(pc.id), [target.id]: monRuntime(target.id, 99) },
      combat: null,
      scene: '',
    };

    // First Attack action with longsword.
    let firstAttack: ReturnType<typeof makeAttack> | null = null;
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: state.characters[0]!,
        target,
        weapon: longsword,
        attackerRuntime: state.runtime[pc.id],
        targetRuntime: state.runtime[target.id],
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        firstAttack = r;
        break;
      }
    }
    expect(firstAttack).not.toBeNull();
    state = applyMutations(state, firstAttack!.mutations);
    expect(state.runtime[pc.id]!.turnState!.actionUsed).toBe(true);

    // Off-hand attack with dagger.
    let offHandAttack: ReturnType<typeof makeAttack> | null = null;
    for (let seed = 0; seed < 200; seed++) {
      const r = makeAttack({
        attacker: state.characters[0]!,
        target,
        weapon: dagger,
        attackerRuntime: state.runtime[pc.id],
        targetRuntime: state.runtime[target.id],
        offHand: true,
      }, makeSeededRng(seed));
      if (r.ok || r.error === 'miss') {
        offHandAttack = r;
        break;
      }
    }
    expect(offHandAttack).not.toBeNull();
    // consume_action with kind: 'bonus' must be present.
    const cAct = offHandAttack!.mutations.find((m) => m.op === 'consume_action') as { kind?: string } | undefined;
    expect(cAct?.kind).toBe('bonus');
    state = applyMutations(state, offHandAttack!.mutations);
    expect(state.runtime[pc.id]!.turnState!.bonusUsed).toBe(true);
    expect(state.runtime[pc.id]!.turnState!.offHandAttackUsed).toBe(true);

    // A second off-hand attempt errors offhand_already_used.
    const r3 = makeAttack({
      attacker: state.characters[0]!,
      target,
      weapon: dagger,
      attackerRuntime: state.runtime[pc.id],
      targetRuntime: state.runtime[target.id],
      offHand: true,
    }, makeSeededRng(7));
    expect(r3.ok).toBe(false);
    // Engine errors with bonus_already_used (which is checked before
    // offhand_already_used in the validation order).
    expect(['offhand_already_used', 'bonus_already_used']).toContain(r3.error);
  });

  it('6) Fireball DEX save through half cover gets +2 to modifier', () => {
    const pc = pcCharacter();
    const baseline = savingThrow({ char: pc, ability: 'DEX', dc: 15 }, makeSeededRng(11));
    const withHalf = savingThrow(
      { char: pc, ability: 'DEX', dc: 15, cover: 'half' },
      makeSeededRng(11),
    );
    expect(withHalf.rolls[0]!.modifier - baseline.rolls[0]!.modifier).toBe(2);
  });
});
