import { describe, expect, it } from 'vitest';
import { handleMakeDeathSave } from '@/engine/tools/handlers';
import type {
  ActorRuntimeState,
  Character,
  ConditionInstance,
  EngineState,
  Mutation,
} from '@/engine/types';

// ─── In-memory applicator (mirror of src/sessions/applicator.ts) ───────────
// The production applicator is DB-backed (Drizzle transactions). For these
// E2E scenarios we drive the same mutation set against an in-memory
// EngineState so we can exercise the full death-save loop without spinning
// up a database. The mutation semantics MUST match the DB applicator —
// changes here should be made in lockstep with src/sessions/applicator.ts.

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
        // PHB §3.21: healing a creature at 0 HP wakes them — reset death
        // saves, drop unconscious, clear stable flag.
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
      // Other ops (combat, inventory, leveling, ...) aren't exercised by
      // these scenarios — no-op them to keep the wrapper minimal.
      break;
  }
  return next;
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeRng(values: number[]): () => number {
  // Returns rng() values that — after `Math.floor(rng() * 20) + 1` — produce
  // the supplied d20 results. To get a roll of N, we need rng() in
  // [(N-1)/20, N/20). Using (N - 0.5) / 20 lands cleanly inside the slot.
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('rng exhausted');
    const n = values[i]!;
    i += 1;
    return (n - 0.5) / 20;
  };
}

function freshState(opts: {
  hpCurrent: number;
  deathSaves?: { successes: number; failures: number };
  flags?: { stable?: boolean; dead?: boolean };
  conditions?: ConditionInstance[];
}): EngineState {
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
    hpMax: 10,
    ac: 16,
    speed: 30,
    proficiencies: {
      saves: ['STR', 'CON'],
      skills: [],
      expertise: [],
      weapons: [],
      armor: [],
      tools: [],
      languages: [],
    },
    spellcasting: null,
    features: [],
    inventory: [],
    hitDiceMax: 3,
    hitDieSize: 10,
  };
  const runtime: ActorRuntimeState = {
    actorId: 'pc1',
    hpCurrent: opts.hpCurrent,
    tempHp: 0,
    conditions: opts.conditions ?? [],
    deathSaves: opts.deathSaves ?? { successes: 0, failures: 0 },
    flags: opts.flags,
  };
  return {
    characters: [pc],
    combatActors: [],
    runtime: { pc1: runtime },
    combat: null,
    scene: 'crypt',
  };
}

// ─── E2E scenarios ─────────────────────────────────────────────────────────

describe('E2E — death save loop', () => {
  it('PC at 1 HP takes 5 dmg → 0 HP unconscious; rolls 12 12 12 → stable', () => {
    let state = freshState({ hpCurrent: 1 });

    // 1. Apply damage 5 → HP drops to 0.
    const dmg: Mutation[] = [{ op: 'apply_damage', actorId: 'pc1', amount: 5, type: 'slashing' }];
    state = applyAll(state, dmg);
    expect(state.runtime.pc1!.hpCurrent).toBe(0);

    // The PC is now dying. Add the unconscious condition explicitly to mirror
    // what the master loop does when narrating the knockdown (the damage
    // helper emits set_hp for non-PCs but the at-0-HP branch adds the
    // condition for PCs only via the master narrative). Either way, by the
    // time death saves start, unconscious is on the sheet.
    state = applyAll(state, [
      {
        op: 'add_condition',
        actorId: 'pc1',
        condition: {
          slug: 'unconscious',
          source: 'dropped to 0 HP',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      },
    ]);

    // 2. Three death saves, each rolling 12 (mid-roll → success).
    const rng = makeRng([12, 12, 12]);
    for (let i = 0; i < 3; i += 1) {
      const r = handleMakeDeathSave({ rng }, state, { actorId: 'pc1' });
      expect(r.ok).toBe(true);
      expect(r.data?.success).toBe(true);
      state = applyAll(state, r.mutations);
    }

    // 3. Stable: counters reset, flag set, unconscious still present.
    expect(state.runtime.pc1!.flags?.stable).toBe(true);
    expect(state.runtime.pc1!.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(state.runtime.pc1!.conditions.some((c) => c.slug === 'unconscious')).toBe(true);
  });

  it('PC at 0 HP rolls 5, 3, 7 → dead', () => {
    let state = freshState({
      hpCurrent: 0,
      conditions: [
        {
          slug: 'unconscious',
          source: 'dropped to 0 HP',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      ],
    });

    const rng = makeRng([5, 3, 7]);
    for (let i = 0; i < 3; i += 1) {
      const r = handleMakeDeathSave({ rng }, state, { actorId: 'pc1' });
      expect(r.ok).toBe(true);
      expect(r.data?.success).toBe(false);
      state = applyAll(state, r.mutations);
    }

    expect(state.runtime.pc1!.flags?.dead).toBe(true);
    expect(state.runtime.pc1!.deathSaves).toEqual({ successes: 0, failures: 3 });
  });

  it('PC at 0 HP gets a nat 20 → regains 1 HP and consciousness', () => {
    let state = freshState({
      hpCurrent: 0,
      conditions: [
        {
          slug: 'unconscious',
          source: 'dropped to 0 HP',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      ],
    });

    const rng = makeRng([20]);
    const r = handleMakeDeathSave({ rng }, state, { actorId: 'pc1' });
    expect(r.ok).toBe(true);
    expect(r.data?.naturalTwenty).toBe(true);
    state = applyAll(state, r.mutations);

    expect(state.runtime.pc1!.hpCurrent).toBe(1);
    expect(state.runtime.pc1!.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(state.runtime.pc1!.conditions.some((c) => c.slug === 'unconscious')).toBe(false);
  });

  it('PC at 0 HP, 2 failures, takes a crit damage → dead immediately', () => {
    let state = freshState({
      hpCurrent: 0,
      deathSaves: { successes: 0, failures: 2 },
      conditions: [
        {
          slug: 'unconscious',
          source: 'dropped to 0 HP',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      ],
    });

    // Crit damage at 0 HP → +2 failures → cap at 3 → dead.
    const muts: Mutation[] = [
      { op: 'death_save', actorId: 'pc1', success: false, isCrit: true },
    ];
    state = applyAll(state, muts);

    expect(state.runtime.pc1!.flags?.dead).toBe(true);
    expect(state.runtime.pc1!.deathSaves).toEqual({ successes: 0, failures: 3 });
  });

  it('Cleric heals dying PC for 3 → wakes at 3 HP, death saves reset, no unconscious', () => {
    let state = freshState({
      hpCurrent: 0,
      deathSaves: { successes: 1, failures: 1 },
      conditions: [
        {
          slug: 'unconscious',
          source: 'dropped to 0 HP',
          durationRounds: 'until_removed',
          appliedRound: 0,
        },
      ],
    });

    state = applyAll(state, [{ op: 'heal', actorId: 'pc1', amount: 3 }]);

    expect(state.runtime.pc1!.hpCurrent).toBe(3);
    expect(state.runtime.pc1!.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(state.runtime.pc1!.conditions.some((c) => c.slug === 'unconscious')).toBe(false);
    expect(state.runtime.pc1!.flags?.stable).toBe(false);
  });
});
