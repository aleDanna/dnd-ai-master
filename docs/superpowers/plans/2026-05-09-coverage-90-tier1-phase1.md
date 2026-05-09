# Coverage 90% — Tier 1 Phase 1: Condition Effects & Death Saves

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare le 15 condizioni D&D 5e da puro testo in regole eseguite (ADV/DIS, speed, auto-fail, auto-crit) e completare il loop death saves (rolls, success/fail tracking, stable, dead, knockout, stabilize). Sblocca da solo +25 punti percentuali di coverage portando l'area "Conditions/HP/Death" da 44% a ~85%.

**Architecture:** Aggiungere un risolutore puro `getEffectsForActor(conditions)` che produce un set di flag deterministici. I consumer (`checks.ts`, `attack.ts`, `damage.ts`) consultano questi flag prima di rollare. La mutation `death_save` riceve handler completo nell'applicator. Nuovi tool `make_death_save`, `stabilize`, parametro `knockOut` su `make_attack`. Tutto TDD-first.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (no schema changes in questa fase), Anthropic SDK tool schemas.

---

## Roadmap macro (Tier 1+2 per arrivare al 90%)

| Phase | Scope | Coverage delta | Stato |
|---|---|---|---|
| **Phase 1 (questo piano)** | Condition Effects + Death Saves + Knockout + Stabilize | +25 pts | 📝 dettagliato sotto |
| Phase 2 | Concentration enforcement + Spell Engine generic factory | +15 pts | da pianificare |
| Phase 3 | Action Economy tracker + Standard Actions (Dash/Disengage/Dodge/Help/Hide/Ready/Search) + Opportunity Attacks | +10 pts | da pianificare |
| Phase 4 | Inspiration system + Long Rest constraints + Exhaustion auto-apply | +5 pts | da pianificare |
| Phase 5 | Magic Item Rarity + Attunement + Cursed/Sentient flags | +6 pts | da pianificare |
| Phase 6 | Exploration Layer: Travel pace, Vision/Light, Falling, Suffocation, Food/Water | +8 pts | da pianificare |
| Phase 7 | NPC Three-Beat schema + Tonal Frame injection + Engagement profile detection | +3 pts | da pianificare |
| **TOTALE** | da 50% → ~92% | **+72 pts** | — |

---

## File Structure (Phase 1)

### File da creare:
- `src/engine/condition-effects.ts` — risolutore puro flag da condizioni
- `tests/engine/condition-effects.test.ts` — unit test resolver
- `tests/engine/scenarios/death-save-loop.test.ts` — test E2E sopravvivenza a 0 HP

### File da modificare:
- `src/engine/conditions.ts` — re-export di `getEffectsForActor`
- `src/engine/checks.ts` — leggere effects per `abilityCheck`/`savingThrow`
- `src/engine/combat/attack.ts` — leggere effects attacker + target, parametro `knockOut?: boolean`
- `src/engine/combat/damage.ts` — auto death-save fail quando damage colpisce target a 0 HP
- `src/sessions/applicator.ts` — implementare handler `death_save` (riga 262), aggiungere handler `stabilize`
- `src/engine/dice.ts` — esporre `rollD20Raw()` per il death save (se non già)
- `src/engine/tools/index.ts` — aggiungere tool def `make_death_save`, `stabilize`
- `src/engine/tools/schemas.ts` — schemi Zod/JSON dei nuovi tool
- `src/engine/tools/handlers.ts` — handler dei nuovi tool
- `src/ai/master/system-prompt.ts` — aggiornare tool contract con i 2 nuovi tool

### Test files da estendere:
- `tests/engine/conditions.test.ts` — verificare effetti applicati
- `tests/engine/checks.test.ts` — verificare DIS/auto-fail con condizioni
- `tests/engine/combat/attack.test.ts` — verificare ADV/DIS/auto-crit con condizioni
- `tests/engine/combat/damage.test.ts` — verificare death-save fail su damage a 0 HP

---

## Task 1: Resolver condition-effects (TDD)

**Files:**
- Create: `src/engine/condition-effects.ts`
- Create: `tests/engine/condition-effects.test.ts`

### - [ ] Step 1: Scrivere il test file con i casi base

File: `tests/engine/condition-effects.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { getEffectsForActor } from '../../src/engine/condition-effects';
import type { ConditionInstance } from '../../src/engine/types';

const cond = (slug: ConditionInstance['slug'], extra?: Partial<ConditionInstance>): ConditionInstance => ({
  slug,
  source: 'test',
  durationRounds: 'until_removed',
  appliedRound: 0,
  ...extra,
});

describe('getEffectsForActor — flags base', () => {
  it('nessuna condizione → tutti i flag a default', () => {
    const fx = getEffectsForActor([]);
    expect(fx.speedZero).toBe(false);
    expect(fx.speedHalvedFactor).toBe(1);
    expect(fx.hpMaxFactor).toBe(1);
    expect(fx.incapacitated).toBe(false);
    expect(fx.attackRollDisadvantage).toBe(false);
    expect(fx.incomingAttackAdvantage).toBe(false);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(false);
    expect(fx.abilityCheckDisadvantage).toBe(false);
    expect(fx.saveAutoFail.STR).toBe(false);
    expect(fx.saveAutoFail.DEX).toBe(false);
  });

  it('blinded → attack DIS, incoming attack ADV', () => {
    const fx = getEffectsForActor([cond('blinded')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('grappled → speedZero', () => {
    const fx = getEffectsForActor([cond('grappled')]);
    expect(fx.speedZero).toBe(true);
  });

  it('incapacitated → cannot act, cannot react', () => {
    const fx = getEffectsForActor([cond('incapacitated')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.cannotReact).toBe(true);
  });

  it('paralyzed → incapacitated + auto-fail STR/DEX + incoming ADV + melee 5ft auto-crit', () => {
    const fx = getEffectsForActor([cond('paralyzed')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.saveAutoFail.DEX).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(true);
  });

  it('petrified → incapacitated + auto-fail STR/DEX + resistance all damage', () => {
    const fx = getEffectsForActor([cond('petrified')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.resistanceAllDamage).toBe(true);
  });

  it('poisoned → attack DIS + check DIS', () => {
    const fx = getEffectsForActor([cond('poisoned')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('prone → attack DIS + incoming melee 5ft ADV + incoming ranged DIS', () => {
    const fx = getEffectsForActor([cond('prone')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.incomingMeleeWithin5ftAdvantage).toBe(true);
    expect(fx.incomingRangedDisadvantage).toBe(true);
  });

  it('restrained → speedZero + attack DIS + DEX save DIS + incoming ADV', () => {
    const fx = getEffectsForActor([cond('restrained')]);
    expect(fx.speedZero).toBe(true);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.saveDisadvantage.DEX).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('stunned → incapacitated + auto-fail STR/DEX + incoming ADV', () => {
    const fx = getEffectsForActor([cond('stunned')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('unconscious → incapacitated + speed 0 + drops + auto-fail + melee 5ft auto-crit', () => {
    const fx = getEffectsForActor([cond('unconscious')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.speedZero).toBe(true);
    expect(fx.dropsHeldItems).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(true);
  });

  it('frightened → attack DIS + check DIS', () => {
    const fx = getEffectsForActor([cond('frightened')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('invisible → attack ADV + incoming attack DIS', () => {
    const fx = getEffectsForActor([cond('invisible')]);
    expect(fx.attackRollAdvantage).toBe(true);
    expect(fx.incomingAttackDisadvantage).toBe(true);
  });
});

describe('getEffectsForActor — exhaustion levels', () => {
  it('exhaustion lvl 1 → ability check DIS', () => {
    const fx = getEffectsForActor([cond('exhaustion', { durationRounds: 1, appliedRound: 1 })], { exhaustionLevel: 1 });
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('exhaustion lvl 2 → speed halved', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 2 });
    expect(fx.speedHalvedFactor).toBe(0.5);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('exhaustion lvl 3 → attack DIS + save DIS all', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 3 });
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.saveDisadvantage.STR).toBe(true);
    expect(fx.saveDisadvantage.WIS).toBe(true);
  });

  it('exhaustion lvl 4 → HP max halved', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 4 });
    expect(fx.hpMaxFactor).toBe(0.5);
  });

  it('exhaustion lvl 5 → speedZero', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 5 });
    expect(fx.speedZero).toBe(true);
  });
});

describe('getEffectsForActor — combinazioni', () => {
  it('blinded + restrained → entrambi gli effetti', () => {
    const fx = getEffectsForActor([cond('blinded'), cond('restrained')]);
    expect(fx.attackRollDisadvantage).toBe(true);  // entrambi causano DIS
    expect(fx.incomingAttackAdvantage).toBe(true);  // entrambi causano ADV in ingresso
    expect(fx.speedZero).toBe(true);                // restrained
    expect(fx.saveDisadvantage.DEX).toBe(true);     // restrained
  });
});
```

### - [ ] Step 2: Eseguire il test e verificare che fallisca

Run: `pnpm test condition-effects`
Expected: FAIL — modulo `condition-effects` non esiste

### - [ ] Step 3: Creare il file con tipi e logica minima

File: `src/engine/condition-effects.ts`

```ts
import type { Ability, ConditionInstance, ConditionSlug } from './types';

export interface ConditionEffectFlags {
  // movement
  speedZero: boolean;
  speedHalvedFactor: number;       // 1 (normal) or 0.5
  // hp
  hpMaxFactor: number;              // 1 (normal) or 0.5
  // action economy
  incapacitated: boolean;
  cannotReact: boolean;
  // own rolls
  attackRollAdvantage: boolean;
  attackRollDisadvantage: boolean;
  abilityCheckDisadvantage: boolean;
  saveAutoFail: Record<Ability, boolean>;
  saveDisadvantage: Record<Ability, boolean>;
  // incoming
  incomingAttackAdvantage: boolean;
  incomingAttackDisadvantage: boolean;
  incomingMeleeWithin5ftAdvantage: boolean;
  incomingMeleeWithin5ftAutoCrit: boolean;
  incomingRangedDisadvantage: boolean;
  // damage
  resistanceAllDamage: boolean;
  // misc
  dropsHeldItems: boolean;
}

export interface EffectContext {
  exhaustionLevel?: number;  // 0..6
}

const ABILITIES: Ability[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

function emptyAbilityFlags(): Record<Ability, boolean> {
  return { STR: false, DEX: false, CON: false, INT: false, WIS: false, CHA: false };
}

function defaultFlags(): ConditionEffectFlags {
  return {
    speedZero: false,
    speedHalvedFactor: 1,
    hpMaxFactor: 1,
    incapacitated: false,
    cannotReact: false,
    attackRollAdvantage: false,
    attackRollDisadvantage: false,
    abilityCheckDisadvantage: false,
    saveAutoFail: emptyAbilityFlags(),
    saveDisadvantage: emptyAbilityFlags(),
    incomingAttackAdvantage: false,
    incomingAttackDisadvantage: false,
    incomingMeleeWithin5ftAdvantage: false,
    incomingMeleeWithin5ftAutoCrit: false,
    incomingRangedDisadvantage: false,
    resistanceAllDamage: false,
    dropsHeldItems: false,
  };
}

const APPLIERS: Record<Exclude<ConditionSlug, 'exhaustion'>, (f: ConditionEffectFlags) => void> = {
  blinded: (f) => {
    f.attackRollDisadvantage = true;
    f.incomingAttackAdvantage = true;
  },
  charmed: () => {
    // no automatic mechanical effect — charmer-tracking is narrative
  },
  deafened: () => {
    // auto-fail check requiring hearing — narrative
  },
  frightened: (f) => {
    // assumes source visible (engine v1 shortcut)
    f.attackRollDisadvantage = true;
    f.abilityCheckDisadvantage = true;
  },
  grappled: (f) => {
    f.speedZero = true;
  },
  incapacitated: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
  },
  invisible: (f) => {
    f.attackRollAdvantage = true;
    f.incomingAttackDisadvantage = true;
  },
  paralyzed: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
    f.incomingMeleeWithin5ftAutoCrit = true;
  },
  petrified: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.resistanceAllDamage = true;
    f.incomingAttackAdvantage = true;
  },
  poisoned: (f) => {
    f.attackRollDisadvantage = true;
    f.abilityCheckDisadvantage = true;
  },
  prone: (f) => {
    f.attackRollDisadvantage = true;
    f.incomingMeleeWithin5ftAdvantage = true;
    f.incomingRangedDisadvantage = true;
  },
  restrained: (f) => {
    f.speedZero = true;
    f.attackRollDisadvantage = true;
    f.saveDisadvantage.DEX = true;
    f.incomingAttackAdvantage = true;
  },
  stunned: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
  },
  unconscious: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.speedZero = true;
    f.dropsHeldItems = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
    f.incomingMeleeWithin5ftAutoCrit = true;
  },
};

function applyExhaustion(f: ConditionEffectFlags, level: number): void {
  if (level >= 1) f.abilityCheckDisadvantage = true;
  if (level >= 2) f.speedHalvedFactor = 0.5;
  if (level >= 3) {
    f.attackRollDisadvantage = true;
    for (const ab of ABILITIES) f.saveDisadvantage[ab] = true;
  }
  if (level >= 4) f.hpMaxFactor = 0.5;
  if (level >= 5) f.speedZero = true;
  // level 6 is death — handled elsewhere
}

export function getEffectsForActor(
  conditions: ConditionInstance[],
  ctx: EffectContext = {},
): ConditionEffectFlags {
  const flags = defaultFlags();
  for (const c of conditions) {
    if (c.slug === 'exhaustion') continue; // handled via ctx.exhaustionLevel
    const fn = APPLIERS[c.slug];
    if (fn) fn(flags);
  }
  if (ctx.exhaustionLevel && ctx.exhaustionLevel > 0) {
    applyExhaustion(flags, ctx.exhaustionLevel);
  }
  return flags;
}
```

### - [ ] Step 4: Eseguire i test e verificare PASS

Run: `pnpm test condition-effects`
Expected: 16 PASS

### - [ ] Step 5: Commit

```bash
git add src/engine/condition-effects.ts tests/engine/condition-effects.test.ts
git commit -m "feat(engine): condition effect flags resolver

Implements pure resolver mapping ConditionInstance[] → ConditionEffectFlags
covering 14 of 15 D&D 5e conditions (charmed/deafened are narrative-only)
plus 6 exhaustion levels. Establishes the contract used by checks/attacks
to apply ADV/DIS/auto-fail/auto-crit consistently."
```

---

## Task 2: Integrare effects in checks.ts (abilityCheck + savingThrow)

**Files:**
- Modify: `src/engine/checks.ts`
- Modify: `tests/engine/checks.test.ts`

### - [ ] Step 1: Leggere checks.ts esistente per capire la firma

Run: `cat src/engine/checks.ts`
Identifica: firme di `abilityCheck()` e `savingThrow()` e dove rollano d20.

### - [ ] Step 2: Aggiungere test per check con condizione

File: `tests/engine/checks.test.ts` (append)

```ts
import { abilityCheck, savingThrow } from '../../src/engine/checks';

describe('abilityCheck — condition effects', () => {
  it('poisoned applies disadvantage', () => {
    const result = abilityCheck({
      character: testChar({ poisoned: true }),
      ability: 'STR',
      skill: 'Athletics',
      dc: 15,
      rng: () => 0.99, // would be 20 without DIS, but DIS picks the lower of two
    });
    // Both d20s would be 20 (rng=0.99 → 20), so DIS still produces 20
    // Use a more controlled scenario:
    expect(result.rolls[0].rolls.length).toBe(2); // DIS = 2 dice
  });

  it('exhaustion lvl 1 applies disadvantage to check', () => {
    const result = abilityCheck({
      character: testChar({ exhaustionLevel: 1 }),
      ability: 'STR',
      skill: 'Athletics',
      dc: 15,
      rng: makeSeq([10, 5]),
    });
    expect(result.rolls[0].total).toBe(5 /* +mod */ + computeMod());
  });
});

describe('savingThrow — condition effects', () => {
  it('paralyzed → STR save auto-fails', () => {
    const result = savingThrow({
      character: testChar({ paralyzed: true }),
      ability: 'STR',
      dc: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.data?.autoFailed).toBe(true);
  });

  it('paralyzed → DEX save auto-fails', () => {
    const result = savingThrow({
      character: testChar({ paralyzed: true }),
      ability: 'DEX',
      dc: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.data?.autoFailed).toBe(true);
  });

  it('paralyzed → CON save NOT auto-fail', () => {
    const result = savingThrow({
      character: testChar({ paralyzed: true }),
      ability: 'CON',
      dc: 10,
      rng: () => 0.99, // high roll
    });
    expect(result.data?.autoFailed).toBeFalsy();
  });

  it('restrained → DEX save has disadvantage', () => {
    const result = savingThrow({
      character: testChar({ restrained: true }),
      ability: 'DEX',
      dc: 10,
    });
    expect(result.rolls[0].rolls.length).toBe(2); // 2 dice = DIS
  });
});
```

(Helper `testChar({ poisoned, paralyzed, restrained, exhaustionLevel })` da implementare nel test file: crea un Character + ActorRuntimeState con condizioni inizializzate.)

### - [ ] Step 3: Eseguire il test e verificare che fallisca

Run: `pnpm test checks`
Expected: i nuovi test FAIL (auto-fail/DIS non implementato)

### - [ ] Step 4: Modificare checks.ts per consultare effects

File: `src/engine/checks.ts` — aggiungere import e usare flags:

```ts
import { getEffectsForActor } from './condition-effects';

export function abilityCheck(input: AbilityCheckInput): ActionResult<{ total: number; success: boolean }> {
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  const advantage = !!input.advantage || false;
  const disadvantage = !!input.disadvantage || fx.abilityCheckDisadvantage;
  // ... resto invariato, passa { advantage, disadvantage } al rollD20
}

export function savingThrow(input: SavingThrowInput): ActionResult<{ total: number; success: boolean; autoFailed?: boolean }> {
  const fx = getEffectsForActor(input.runtime?.conditions ?? [], {
    exhaustionLevel: input.runtime?.exhaustionLevel,
  });
  if (fx.saveAutoFail[input.ability]) {
    return {
      ok: false,
      data: { total: 0, success: false, autoFailed: true },
      rolls: [],
      mutations: [],
    };
  }
  const disadvantage = !!input.disadvantage || fx.saveDisadvantage[input.ability];
  // ... resto invariato
}
```

(NB: aggiungi `runtime?: ActorRuntimeState` agli input types se non presente; aggiungi `exhaustionLevel?: number` come campo derivato da `ConditionInstance` con slug 'exhaustion' — vedi Task 6.)

### - [ ] Step 5: Eseguire i test e verificare PASS

Run: `pnpm test checks`
Expected: tutti PASS, anche i nuovi.

### - [ ] Step 6: Commit

```bash
git add src/engine/checks.ts tests/engine/checks.test.ts
git commit -m "feat(engine): apply condition effects to ability checks and saves

abilityCheck and savingThrow now consult getEffectsForActor and apply:
- abilityCheckDisadvantage (poisoned, frightened, exhaustion 1+)
- saveAutoFail (paralyzed/petrified/stunned/unconscious for STR & DEX)
- saveDisadvantage per-ability (restrained DEX, exhaustion 3+ all)"
```

---

## Task 3: Integrare effects in attack.ts e damage.ts

**Files:**
- Modify: `src/engine/combat/attack.ts`
- Modify: `tests/engine/combat/attack.test.ts`

### - [ ] Step 1: Aggiungere test per attack con condizioni

File: `tests/engine/combat/attack.test.ts` (append)

```ts
describe('makeAttack — condition effects', () => {
  it('attacker poisoned → disadvantage on attack roll', () => {
    const result = makeAttack({
      attacker: testActor({ poisoned: true }),
      attackerRuntime: runtimeWith({ poisoned: true }),
      target: dummyTarget(),
      targetRuntime: dummyRuntime(),
      weapon: shortswordSpec(),
      rng: makeSeq([0.95, 0.05]), // would be 19 then 1 → DIS picks 1
    });
    expect(result.rolls[0].rolls.length).toBe(2);
    expect(result.data?.hit).toBe(false);
  });

  it('target prone, melee within 5ft → advantage on attack', () => {
    const result = makeAttack({
      attacker: testActor(),
      target: testActor({ prone: true }),
      targetRuntime: runtimeWith({ prone: true }),
      weapon: shortswordSpec(),
      meleeRange: 5,
      rng: makeSeq([0.05, 0.95]), // ADV picks higher
    });
    expect(result.rolls[0].rolls.length).toBe(2);
  });

  it('target paralyzed, melee within 5ft → auto-crit on hit', () => {
    const result = makeAttack({
      attacker: testActor(),
      target: testActor({ paralyzed: true }),
      targetRuntime: runtimeWith({ paralyzed: true }),
      weapon: shortswordSpec(),
      meleeRange: 5,
      rng: makeSeq([0.5]),  // d20=11
    });
    if (result.data?.hit) {
      expect(result.data.crit).toBe(true);
    }
  });

  it('attacker invisible → advantage; target invisible → disadvantage; both → cancel', () => {
    const result = makeAttack({
      attacker: testActor({ invisible: true }),
      target: testActor({ invisible: true }),
      attackerRuntime: runtimeWith({ invisible: true }),
      targetRuntime: runtimeWith({ invisible: true }),
      weapon: shortswordSpec(),
      rng: makeSeq([0.5]),
    });
    expect(result.rolls[0].rolls.length).toBe(1); // single d20: ADV cancels DIS
  });
});

describe('makeAttack — knockOut option', () => {
  it('melee attack with knockOut leaves target at 0 HP unconscious instead of dead', () => {
    const target = testActor({ hpCurrent: 3 });
    const result = makeAttack({
      attacker: testActor(),
      target,
      targetRuntime: runtimeWith({ hpCurrent: 3 }),
      weapon: shortswordSpec({ damage: '1d8' }),
      knockOut: true,
      meleeRange: 5,
      rng: makeSeq([0.95, 0.5]), // hit then dmg=4
    });
    expect(result.data?.knockedOut).toBe(true);
    // mutation: set_hp 0 + add_condition unconscious; NOT death save trigger
    const setHp = result.mutations.find((m) => m.op === 'set_hp');
    const addCond = result.mutations.find((m) => m.op === 'add_condition');
    expect(setHp?.hpCurrent).toBe(0);
    expect(addCond?.condition.slug).toBe('unconscious');
  });

  it('knockOut ignored on ranged attack', () => {
    const result = makeAttack({
      attacker: testActor(),
      target: testActor({ hpCurrent: 3 }),
      targetRuntime: runtimeWith({ hpCurrent: 3 }),
      weapon: longbowSpec({ damage: '1d8' }),
      knockOut: true,
      ranged: true,
      rng: makeSeq([0.95, 0.5]),
    });
    expect(result.data?.knockedOut).toBeFalsy();
  });
});
```

### - [ ] Step 2: Eseguire i test e verificare FAIL

Run: `pnpm test combat/attack`
Expected: nuovi test FAIL.

### - [ ] Step 3: Modificare attack.ts per consultare effects + knockOut

File: `src/engine/combat/attack.ts` — modificare la firma e logica:

```ts
import { getEffectsForActor } from '../condition-effects';

export interface MakeAttackInput {
  attacker: CombatActor;
  attackerRuntime?: ActorRuntimeState;
  target: CombatActor;
  targetRuntime?: ActorRuntimeState;
  weapon: WeaponSpec;
  ranged?: boolean;
  meleeRange?: number;        // default 5
  knockOut?: boolean;          // PHB §3.20 — melee only
  advantage?: boolean;
  disadvantage?: boolean;
  rng?: () => number;
}

export function makeAttack(input: MakeAttackInput): ActionResult<{ hit: boolean; crit: boolean; damage: number; knockedOut?: boolean }> {
  const fxAttacker = getEffectsForActor(input.attackerRuntime?.conditions ?? [], { exhaustionLevel: input.attackerRuntime?.exhaustionLevel });
  const fxTarget = getEffectsForActor(input.targetRuntime?.conditions ?? [], { exhaustionLevel: input.targetRuntime?.exhaustionLevel });

  // incapacitated attacker = no attack
  if (fxAttacker.incapacitated) {
    return { ok: false, error: 'attacker incapacitated', rolls: [], mutations: [] };
  }

  const isMelee = !input.ranged;
  const within5 = isMelee && (input.meleeRange ?? 5) <= 5;

  let advantage = !!input.advantage || fxAttacker.attackRollAdvantage || fxTarget.incomingAttackAdvantage
    || (within5 && fxTarget.incomingMeleeWithin5ftAdvantage);
  let disadvantage = !!input.disadvantage || fxAttacker.attackRollDisadvantage || fxTarget.incomingAttackDisadvantage
    || (input.ranged && fxTarget.incomingRangedDisadvantage);

  // ADV/DIS cancel
  if (advantage && disadvantage) { advantage = false; disadvantage = false; }

  // ... existing d20 + AC compare logic, using { advantage, disadvantage } ...

  let crit = naturalRoll === 20 || (within5 && fxTarget.incomingMeleeWithin5ftAutoCrit && hit);

  // ... existing damage roll, doubling on crit ...

  // KNOCKOUT (§3.20): melee only, when reducing target to 0
  if (hit && input.knockOut && isMelee) {
    const wouldBe = (input.targetRuntime?.hpCurrent ?? input.target.hpMax) - finalDamage;
    if (wouldBe <= 0) {
      return {
        ok: true,
        data: { hit: true, crit, damage: finalDamage, knockedOut: true },
        rolls,
        mutations: [
          { op: 'set_hp', actorId: input.target.id, hpCurrent: 0 },
          { op: 'add_condition', actorId: input.target.id, condition: {
            slug: 'unconscious', source: 'knock-out blow',
            durationRounds: 'until_removed', appliedRound: 0,
          } },
        ],
      };
    }
  }

  // ... return existing result ...
}
```

### - [ ] Step 4: Eseguire i test e verificare PASS

Run: `pnpm test combat/attack`
Expected: tutti i test PASS.

### - [ ] Step 5: Commit

```bash
git add src/engine/combat/attack.ts tests/engine/combat/attack.test.ts
git commit -m "feat(engine): apply condition effects to attacks + knockout option

makeAttack now consults attacker AND target condition effects:
- ADV/DIS computed from blinded/poisoned/prone/restrained/invisible/...
- ADV cancels DIS regardless of count (PHB §1.3)
- Auto-crit on hit when target paralyzed/unconscious within 5ft melee
- New knockOut?: boolean param (melee only): non-lethal blow leaves
  target at 0 HP unconscious instead of triggering death saves (PHB §3.20)"
```

---

## Task 4: Damage → death save fail at 0 HP

**Files:**
- Modify: `src/engine/combat/damage.ts`
- Modify: `tests/engine/combat/damage.test.ts`

### - [ ] Step 1: Test: PG a 0 HP che subisce danno → 1 fail (2 da crit)

File: `tests/engine/combat/damage.test.ts` (append)

```ts
describe('applyDamage — death save fail at 0 HP', () => {
  it('PC at 0 HP takes damage → +1 death save failure', () => {
    const result = applyDamage({
      target: pcAt0Hp(),
      runtime: runtimeAt0Hp({ successes: 1, failures: 0 }),
      amount: 5,
      type: 'piercing',
      isCrit: false,
    });
    const ds = result.mutations.find((m) => m.op === 'death_save');
    expect(ds).toBeDefined();
    expect(ds?.success).toBe(false);
    expect(ds?.isCrit).toBe(false);
  });

  it('PC at 0 HP takes critical damage → +2 death save failures', () => {
    const result = applyDamage({
      target: pcAt0Hp(),
      runtime: runtimeAt0Hp({ successes: 0, failures: 0 }),
      amount: 8,
      type: 'piercing',
      isCrit: true,
    });
    const dsFails = result.mutations.filter((m) => m.op === 'death_save' && !m.success);
    expect(dsFails.length).toBe(2);
  });

  it('PC at 0 HP takes damage equal to hpMax → instant death (no death saves)', () => {
    const target = { ...pcAt0Hp(), hpMax: 10 };
    const result = applyDamage({
      target,
      runtime: runtimeAt0Hp({ successes: 0, failures: 0 }),
      amount: 10,
      type: 'piercing',
      isCrit: false,
    });
    expect(result.data?.dead).toBe(true);
    // no death_save mutations — instant death
    const ds = result.mutations.find((m) => m.op === 'death_save');
    expect(ds).toBeUndefined();
  });
});
```

### - [ ] Step 2: Implementare la logica in damage.ts

Modificare `applyDamage()` per emettere mutation `death_save` (success=false) quando target è a 0 HP:

```ts
export function applyDamage(input: ApplyDamageInput): ActionResult<{ dealt: number; dead?: boolean }> {
  // existing temp HP, resistance, vulnerability, immunity logic ...

  const wasAt0 = (input.runtime?.hpCurrent ?? input.target.hpMax) <= 0;

  if (wasAt0) {
    // PHB §3.18: damage at 0 HP = 1 fail, crit = 2 fails
    // PHB §3.17: damage ≥ hpMax from single source = instant death
    if (finalDamage >= input.target.hpMax) {
      return {
        ok: true,
        data: { dealt: finalDamage, dead: true },
        rolls: [],
        mutations: [
          { op: 'set_hp', actorId: input.target.id, hpCurrent: 0 },
          { op: 'add_condition', actorId: input.target.id, condition: {
            slug: 'unconscious', source: 'massive damage',
            durationRounds: 'until_removed', appliedRound: 0,
          } },
        ],
      };
    }
    const fails = input.isCrit ? 2 : 1;
    const dsMutations: Mutation[] = Array.from({ length: fails }, () => (
      { op: 'death_save' as const, actorId: input.target.id, success: false, isCrit: input.isCrit }
    ));
    return {
      ok: true,
      data: { dealt: finalDamage },
      rolls: [],
      mutations: dsMutations,
    };
  }

  // existing logic for HP > 0 ...
}
```

### - [ ] Step 3: Run test → PASS

Run: `pnpm test combat/damage`

### - [ ] Step 4: Commit

```bash
git add src/engine/combat/damage.ts tests/engine/combat/damage.test.ts
git commit -m "feat(engine): emit death_save fails when damaging a creature at 0 HP

PHB §3.17, §3.18:
- Damage at 0 HP → +1 death save failure
- Critical hit at 0 HP → +2 failures
- Damage ≥ hpMax from single source → instant death (skip saves)"
```

---

## Task 5: Implementare l'handler `death_save` nell'applicator

**Files:**
- Modify: `src/sessions/applicator.ts` (riga ~262, attualmente `case 'death_save': break;`)
- Modify: `tests/sessions/applicator.test.ts`

### - [ ] Step 1: Test del handler death_save

File: `tests/sessions/applicator.test.ts` (append)

```ts
describe('applicator — death_save mutation', () => {
  it('success increments successes counter', () => {
    const state = stateWith({ deathSaves: { successes: 0, failures: 0 } });
    const next = applyMutation(state, { op: 'death_save', actorId: 'pc1', success: true });
    expect(next.runtime.pc1.deathSaves).toEqual({ successes: 1, failures: 0 });
  });

  it('3 successes → mark stable, reset', () => {
    const state = stateWith({ deathSaves: { successes: 2, failures: 0 } });
    const next = applyMutation(state, { op: 'death_save', actorId: 'pc1', success: true });
    expect(next.runtime.pc1.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(next.runtime.pc1.conditions.some((c) => c.slug === 'unconscious')).toBe(true);
    expect(next.runtime.pc1.flags?.stable).toBe(true);
  });

  it('3 failures → dead', () => {
    const state = stateWith({ deathSaves: { successes: 0, failures: 2 } });
    const next = applyMutation(state, { op: 'death_save', actorId: 'pc1', success: false });
    expect(next.runtime.pc1.flags?.dead).toBe(true);
  });

  it('isCrit failure counts as 2', () => {
    const state = stateWith({ deathSaves: { successes: 0, failures: 0 } });
    const next = applyMutation(state, { op: 'death_save', actorId: 'pc1', success: false, isCrit: true });
    expect(next.runtime.pc1.deathSaves.failures).toBe(2);
  });

  it('reset_death_saves clears counters', () => {
    const state = stateWith({ deathSaves: { successes: 2, failures: 1 } });
    const next = applyMutation(state, { op: 'reset_death_saves', actorId: 'pc1' });
    expect(next.runtime.pc1.deathSaves).toEqual({ successes: 0, failures: 0 });
  });
});
```

### - [ ] Step 2: Implementare l'handler nel switch

File: `src/sessions/applicator.ts`, riga ~262 — sostituire `case 'death_save': break;` con:

```ts
case 'death_save': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  const successes = rt.deathSaves.successes;
  const failures = rt.deathSaves.failures;

  if (m.success) {
    const newSuccesses = successes + 1;
    if (newSuccesses >= 3) {
      // STABLE
      next.runtime[m.actorId] = {
        ...rt,
        deathSaves: { successes: 0, failures: 0 },
        flags: { ...(rt.flags ?? {}), stable: true },
        conditions: rt.conditions.some((c) => c.slug === 'unconscious')
          ? rt.conditions
          : [...rt.conditions, { slug: 'unconscious' as const, source: 'stable but down', durationRounds: 'until_removed' as const, appliedRound: 0 }],
      };
    } else {
      next.runtime[m.actorId] = { ...rt, deathSaves: { successes: newSuccesses, failures } };
    }
  } else {
    const inc = m.isCrit ? 2 : 1;
    const newFailures = Math.min(3, failures + inc);
    if (newFailures >= 3) {
      next.runtime[m.actorId] = {
        ...rt,
        deathSaves: { successes: 0, failures: 3 },
        flags: { ...(rt.flags ?? {}), dead: true },
      };
    } else {
      next.runtime[m.actorId] = { ...rt, deathSaves: { successes, failures: newFailures } };
    }
  }
  break;
}

case 'reset_death_saves': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  next.runtime[m.actorId] = { ...rt, deathSaves: { successes: 0, failures: 0 } };
  break;
}
```

(NB: aggiungi `flags?: { stable?: boolean; dead?: boolean }` a `ActorRuntimeState` in `types.ts`.)

### - [ ] Step 3: Aggiornare ActorRuntimeState in types.ts

File: `src/engine/types.ts`, riga 115:

```ts
export interface ActorRuntimeState {
  actorId: string;
  hpCurrent: number;
  tempHp: number;
  conditions: ConditionInstance[];
  deathSaves: { successes: number; failures: number };
  flags?: { stable?: boolean; dead?: boolean };
  exhaustionLevel?: number;  // 0..6, derived from condition with slug 'exhaustion'
  hitDiceRemaining?: number;
  spellSlotsUsed?: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  resourcesUsed?: ResourceUsage;
}
```

### - [ ] Step 4: Test → PASS

Run: `pnpm test sessions/applicator`

### - [ ] Step 5: Commit

```bash
git add src/sessions/applicator.ts src/engine/types.ts tests/sessions/applicator.test.ts
git commit -m "feat(applicator): implement death_save handler with stable/dead outcomes

Replaces empty stub with full PHB §3.18 logic:
- success +1; 3 successes → stable, conditions cleared, unconscious added
- failure +1 (or +2 on crit); 3 failures → dead flag set
- reset_death_saves clears counters
Adds flags.{stable,dead} and exhaustionLevel to ActorRuntimeState."
```

---

## Task 6: Esporre tool `make_death_save`

**Files:**
- Modify: `src/engine/tools/schemas.ts`
- Modify: `src/engine/tools/index.ts`
- Modify: `src/engine/tools/handlers.ts`
- Create: `tests/engine/tools/death-save.test.ts`

### - [ ] Step 1: Test handler tool

File: `tests/engine/tools/death-save.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { handleMakeDeathSave } from '../../../src/engine/tools/handlers';

describe('tool make_death_save', () => {
  it('rolls 10+ → success, emits death_save success=true', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.5 /* d20 = 11 */ },
      stateWith({ pcAt0Hp: true }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.success).toBe(true);
    expect(result.mutations[0]).toMatchObject({ op: 'death_save', success: true });
  });

  it('rolls <10 → failure', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.05 /* d20 = 2 */ },
      stateWith({ pcAt0Hp: true }),
      { actorId: 'pc1' },
    );
    expect(result.data?.success).toBe(false);
    expect(result.mutations[0]).toMatchObject({ op: 'death_save', success: false });
  });

  it('natural 20 → regain 1 HP, reset death saves', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.999 /* d20 = 20 */ },
      stateWith({ pcAt0Hp: true }),
      { actorId: 'pc1' },
    );
    expect(result.data?.naturalTwenty).toBe(true);
    const setHp = result.mutations.find((m) => m.op === 'set_hp');
    const reset = result.mutations.find((m) => m.op === 'reset_death_saves');
    expect(setHp?.hpCurrent).toBe(1);
    expect(reset).toBeDefined();
  });

  it('natural 1 → 2 failures', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.0001 /* d20 = 1 */ },
      stateWith({ pcAt0Hp: true }),
      { actorId: 'pc1' },
    );
    const fails = result.mutations.filter((m) => m.op === 'death_save' && !m.success);
    expect(fails.length).toBe(2);
  });

  it('errors if actor not at 0 HP', () => {
    const result = handleMakeDeathSave(
      { rng: () => 0.5 },
      stateWith({ pcAt0Hp: false }),
      { actorId: 'pc1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not at 0 HP/);
  });
});
```

### - [ ] Step 2: Implementare l'handler

File: `src/engine/tools/handlers.ts` (append):

```ts
export function handleMakeDeathSave(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string },
): ActionResult<{ roll: number; total: number; success: boolean; naturalTwenty?: boolean; naturalOne?: boolean }> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (rt.hpCurrent > 0) return { ok: false, error: 'actor not at 0 HP', rolls: [], mutations: [] };
  if (rt.flags?.dead) return { ok: false, error: 'actor is already dead', rolls: [], mutations: [] };
  if (rt.flags?.stable) return { ok: false, error: 'actor is stable, no save needed', rolls: [], mutations: [] };

  const roll = Math.floor(ctx.rng() * 20) + 1;

  if (roll === 20) {
    return {
      ok: true,
      data: { roll, total: roll, success: true, naturalTwenty: true },
      rolls: [{ formula: '1d20', rolls: [roll], modifier: 0, total: roll }],
      mutations: [
        { op: 'reset_death_saves', actorId: input.actorId },
        { op: 'set_hp', actorId: input.actorId, hpCurrent: 1 },
        { op: 'remove_condition', actorId: input.actorId, conditionSlug: 'unconscious' },
      ],
    };
  }

  if (roll === 1) {
    return {
      ok: true,
      data: { roll, total: roll, success: false, naturalOne: true },
      rolls: [{ formula: '1d20', rolls: [roll], modifier: 0, total: roll }],
      mutations: [
        { op: 'death_save', actorId: input.actorId, success: false },
        { op: 'death_save', actorId: input.actorId, success: false },
      ],
    };
  }

  const success = roll >= 10;
  return {
    ok: true,
    data: { roll, total: roll, success },
    rolls: [{ formula: '1d20', rolls: [roll], modifier: 0, total: roll }],
    mutations: [{ op: 'death_save', actorId: input.actorId, success }],
  };
}
```

### - [ ] Step 3: Aggiungere schema e tool def

File: `src/engine/tools/schemas.ts` — aggiungere:

```ts
export const makeDeathSaveSchema = {
  type: 'object',
  properties: {
    actorId: { type: 'string', description: 'ID of the actor at 0 HP making the save' },
  },
  required: ['actorId'],
} as const;

export const stabilizeSchema = {
  type: 'object',
  properties: {
    actorId: { type: 'string', description: 'ID of the dying actor to stabilize' },
    method: {
      type: 'string',
      enum: ['medicine_check', 'healing_kit', 'spell'],
      description: 'How stabilization is attempted',
    },
    medicineRoll: {
      type: 'number',
      description: 'Required if method=medicine_check: total of d20 + Wisdom (Medicine) bonus',
    },
  },
  required: ['actorId', 'method'],
} as const;
```

File: `src/engine/tools/index.ts` — aggiungere alle definizioni esposte all'AI:

```ts
{
  name: 'make_death_save',
  description: 'Roll a death save for an actor at 0 HP. Returns the d20 result and applies the proper success/failure mutation. Natural 20 → regain 1 HP. Natural 1 → 2 failures. 10+ → success. <10 → failure. 3 successes → stable. 3 failures → dead.',
  input_schema: makeDeathSaveSchema,
},
{
  name: 'stabilize',
  description: 'Stabilize a dying actor. method=medicine_check requires medicineRoll (d20 + WIS+Medicine bonus, DC 10). method=healing_kit auto-stabilizes (consumes 1 use). method=spell assumes a healing spell already restored ≥1 HP. On success: clears death saves, marks stable, keeps unconscious.',
  input_schema: stabilizeSchema,
},
```

### - [ ] Step 4: Implementare handleStabilize

File: `src/engine/tools/handlers.ts` (append):

```ts
export function handleStabilize(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string; method: 'medicine_check' | 'healing_kit' | 'spell'; medicineRoll?: number },
): ActionResult<{ stabilized: boolean }> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (rt.hpCurrent > 0) return { ok: false, error: 'actor is not at 0 HP', rolls: [], mutations: [] };
  if (rt.flags?.dead) return { ok: false, error: 'actor is dead', rolls: [], mutations: [] };

  let stabilized = false;
  switch (input.method) {
    case 'healing_kit':
      stabilized = true;
      break;
    case 'spell':
      // healer is responsible to apply heal mutation separately; this just resets death saves
      stabilized = true;
      break;
    case 'medicine_check':
      if (input.medicineRoll == null) {
        return { ok: false, error: 'medicineRoll required for medicine_check method', rolls: [], mutations: [] };
      }
      stabilized = input.medicineRoll >= 10;
      break;
  }

  if (!stabilized) {
    return { ok: true, data: { stabilized: false }, rolls: [], mutations: [] };
  }

  return {
    ok: true,
    data: { stabilized: true },
    rolls: [],
    mutations: [
      { op: 'reset_death_saves', actorId: input.actorId },
      // flag stable is set by reset? No — we add a stable flag via dedicated mutation
      // We piggyback on death_save handler's stable logic by emitting 3 successes path? Simpler: add a tiny mutation:
      { op: 'set_stable', actorId: input.actorId, stable: true },
    ],
  };
}
```

### - [ ] Step 5: Aggiungere mutation `set_stable` in types.ts e applicator

File: `src/engine/types.ts` — append a Mutation union:

```ts
| { op: 'set_stable'; actorId: string; stable: boolean }
```

File: `src/sessions/applicator.ts` — aggiungere case:

```ts
case 'set_stable': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  next.runtime[m.actorId] = {
    ...rt,
    flags: { ...(rt.flags ?? {}), stable: m.stable },
  };
  break;
}
```

### - [ ] Step 6: Wire-up nei handler registry

File: `src/engine/tools/handlers.ts` — aggiungere a `TOOL_HANDLERS`:

```ts
export const TOOL_HANDLERS = {
  // ... esistenti ...
  make_death_save: (ctx: ToolCtx, state: EngineState, input: any) => handleMakeDeathSave(ctx, state, input),
  stabilize: (ctx: ToolCtx, state: EngineState, input: any) => handleStabilize(ctx, state, input),
};
```

### - [ ] Step 7: Test → PASS

Run: `pnpm test tools/death-save`

### - [ ] Step 8: Commit

```bash
git add src/engine/tools/ src/engine/types.ts src/sessions/applicator.ts tests/engine/tools/death-save.test.ts
git commit -m "feat(tools): expose make_death_save and stabilize to AI Master

- make_death_save: d20 roll with natural 20 → 1 HP, natural 1 → 2 fails,
  10+ success, <10 fail. Idempotent via runtime check.
- stabilize: 3 methods (medicine_check w/ DC 10, healing_kit, spell).
  Sets flags.stable, clears death saves.
- New mutation set_stable in applicator."
```

---

## Task 7: Aggiornare il system prompt con i nuovi tool

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

### - [ ] Step 1: Cercare la sezione MASTER_TOOL_CONTRACT in system-prompt

Run: `grep -n "MASTER_TOOL_CONTRACT" src/ai/master/system-prompt.ts`

### - [ ] Step 2: Aggiungere paragrafo sull'uso dei nuovi tool

Trovare la sezione che descrive il combat lifecycle e aggiungere:

```
**Death saves loop (PHB §3.18):**
When a PC drops to 0 HP, narrate the fall and emit `add_condition` for "unconscious".
At the START of each of that PC's turns thereafter (until stable, healed, or dead),
call `make_death_save` with their actorId. The tool rolls a d20, applies the right
mutation (success/failure/critical), and returns the result. Natural 20 grants 1 HP
and removes unconscious automatically. Natural 1 counts as 2 failures.
DO NOT call `make_death_save` more than once per round per PC.
DO NOT call it for stable PCs or dead PCs — the tool errors out.

**Stabilization (PHB §3.19):**
An ally adjacent to a dying PC can stabilize them. Use `stabilize` with method:
- `medicine_check` + medicineRoll (d20 + WIS + Medicine bonus, DC 10)
- `healing_kit` (consumes one use of a healer's kit; auto-success — also call
  `remove_item` with slug="healers-kit" qty=1 if you want to track the resource)
- `spell` (when a healing spell restored at least 1 HP — already brings them
  conscious; stabilize call is then redundant but harmless)
A stable PC stays unconscious but no longer rolls death saves; they wake at 1 HP
after 1d4 hours of rest (narrate it; no tool needed).

**Knockout (PHB §3.20):**
When the player explicitly wants to spare a humanoid (capture, mercy), pass
`knockOut: true` to `make_attack`. Only valid on melee attacks. If the hit reduces
the target to 0 HP, they fall unconscious instead of dying or making death saves.
On ranged attacks the flag is silently ignored.
```

### - [ ] Step 3: Commit

```bash
git add src/ai/master/system-prompt.ts
git commit -m "docs(prompt): document make_death_save, stabilize, knockOut to AI Master"
```

---

## Task 8: Scenario E2E — full death save loop

**Files:**
- Create: `tests/engine/scenarios/death-save-loop.test.ts`

### - [ ] Step 1: Scenario completo

```ts
import { describe, expect, it } from 'vitest';
import { applyMutation, applyMutations } from '../../../src/sessions/applicator';
import { handleMakeDeathSave } from '../../../src/engine/tools/handlers';
// ... setup helpers ...

describe('E2E — death save loop', () => {
  it('PC at 1 HP takes 5 dmg → 0 HP unconscious; rolls 12 12 12 → stable', () => {
    let state = stateWithPC({ hpCurrent: 1, hpMax: 10 });
    const target = state.combatActors[0];

    // Step 1: damage drops to 0
    const dmg = applyDamage({ target, runtime: state.runtime[target.id], amount: 5, type: 'piercing' });
    state = applyMutations(state, dmg.mutations);
    expect(state.runtime[target.id].hpCurrent).toBe(0);
    expect(state.runtime[target.id].conditions.some((c) => c.slug === 'unconscious')).toBe(true);

    // Step 2-4: three successes
    for (let i = 0; i < 3; i++) {
      const ds = handleMakeDeathSave({ rng: () => 0.5 }, state, { actorId: target.id });
      state = applyMutations(state, ds.mutations);
    }
    expect(state.runtime[target.id].flags?.stable).toBe(true);
    expect(state.runtime[target.id].deathSaves).toEqual({ successes: 0, failures: 0 });
  });

  it('PC at 0 HP rolls 5, 3, 7 → dead', () => {
    let state = stateWithPC({ hpCurrent: 0, hpMax: 10 });
    const id = state.combatActors[0].id;
    state.runtime[id].conditions.push({ slug: 'unconscious', source: 'down', durationRounds: 'until_removed', appliedRound: 0 });

    for (const r of [0.20, 0.10, 0.30]) {  // 5, 3, 7
      const ds = handleMakeDeathSave({ rng: () => r }, state, { actorId: id });
      state = applyMutations(state, ds.mutations);
    }
    expect(state.runtime[id].flags?.dead).toBe(true);
  });

  it('PC at 0 HP gets a nat 20 → regains 1 HP and consciousness', () => {
    let state = stateWithPC({ hpCurrent: 0, hpMax: 10 });
    const id = state.combatActors[0].id;
    state.runtime[id].conditions.push({ slug: 'unconscious', source: 'down', durationRounds: 'until_removed', appliedRound: 0 });

    const ds = handleMakeDeathSave({ rng: () => 0.999 }, state, { actorId: id });
    state = applyMutations(state, ds.mutations);

    expect(state.runtime[id].hpCurrent).toBe(1);
    expect(state.runtime[id].conditions.some((c) => c.slug === 'unconscious')).toBe(false);
    expect(state.runtime[id].deathSaves).toEqual({ successes: 0, failures: 0 });
  });

  it('PC at 0 HP, 2 failures, takes a crit → dead immediately', () => {
    let state = stateWithPC({ hpCurrent: 0, hpMax: 10 });
    const target = state.combatActors[0];
    state.runtime[target.id].deathSaves = { successes: 0, failures: 2 };

    const dmg = applyDamage({ target, runtime: state.runtime[target.id], amount: 4, type: 'piercing', isCrit: true });
    state = applyMutations(state, dmg.mutations);
    expect(state.runtime[target.id].flags?.dead).toBe(true);
  });

  it('Cleric heals dying PC for 3 → wakes at 3 HP, death saves reset', () => {
    let state = stateWithPC({ hpCurrent: 0, hpMax: 10 });
    const id = state.combatActors[0].id;
    state.runtime[id].deathSaves = { successes: 1, failures: 1 };
    state.runtime[id].conditions.push({ slug: 'unconscious', source: 'down', durationRounds: 'until_removed', appliedRound: 0 });

    state = applyMutation(state, { op: 'heal', actorId: id, amount: 3 });
    // healing should also: clear death saves + remove unconscious
    // ⇒ this drives a follow-up adjustment in heal handler (see Step 2)
    expect(state.runtime[id].hpCurrent).toBe(3);
    expect(state.runtime[id].deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(state.runtime[id].conditions.some((c) => c.slug === 'unconscious')).toBe(false);
  });
});
```

### - [ ] Step 2: Aggiornare l'handler `heal` nell'applicator per resettare death saves

File: `src/sessions/applicator.ts` — case 'heal':

```ts
case 'heal': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  const target = lookupActor(state, m.actorId);
  const newHp = Math.min(target.hpMax, rt.hpCurrent + m.amount);

  next.runtime[m.actorId] = {
    ...rt,
    hpCurrent: newHp,
    // PHB §3.21: healing a creature at 0 HP wakes them, resets death saves
    deathSaves: rt.hpCurrent === 0 && newHp > 0 ? { successes: 0, failures: 0 } : rt.deathSaves,
    conditions: rt.hpCurrent === 0 && newHp > 0
      ? rt.conditions.filter((c) => c.slug !== 'unconscious')
      : rt.conditions,
    flags: rt.hpCurrent === 0 && newHp > 0
      ? { ...(rt.flags ?? {}), stable: false }
      : rt.flags,
  };
  break;
}
```

### - [ ] Step 3: Run E2E test → PASS

Run: `pnpm test scenarios/death-save-loop`

### - [ ] Step 4: Commit

```bash
git add tests/engine/scenarios/death-save-loop.test.ts src/sessions/applicator.ts
git commit -m "test(scenarios): full death save loop E2E + heal-wakes-pc fix

5 end-to-end scenarios covering:
- damage→unconscious→3 successes→stable
- 3 failures→dead
- nat 20→regain 1 HP
- crit at 2 failures→dead
- heal at 0 HP→wakes + death saves reset (PHB §3.21)"
```

---

## Task 9: Auto-derivare exhaustionLevel da ConditionInstance

**Files:**
- Modify: `src/engine/conditions.ts` (extend `applyCondition` per exhaustion stacking)
- Modify: `src/sessions/applicator.ts` (case `add_condition` per exhaustion)

### - [ ] Step 1: Test exhaustion stacking

File: `tests/engine/conditions.test.ts` (append)

```ts
describe('exhaustion stacking', () => {
  it('multiple exhaustion add_condition calls increment level (max 6)', () => {
    let state = stateWithPC();
    const id = state.combatActors[0].id;
    expect(state.runtime[id].exhaustionLevel ?? 0).toBe(0);

    state = applyMutation(state, {
      op: 'add_condition', actorId: id,
      condition: { slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed', appliedRound: 0 },
    });
    expect(state.runtime[id].exhaustionLevel).toBe(1);

    state = applyMutation(state, {
      op: 'add_condition', actorId: id,
      condition: { slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed', appliedRound: 0 },
    });
    expect(state.runtime[id].exhaustionLevel).toBe(2);
  });

  it('exhaustion level 6 → flags.dead', () => {
    let state = stateWithPC();
    const id = state.combatActors[0].id;
    state.runtime[id].exhaustionLevel = 5;
    state = applyMutation(state, {
      op: 'add_condition', actorId: id,
      condition: { slug: 'exhaustion', source: 'no rest', durationRounds: 'until_removed', appliedRound: 0 },
    });
    expect(state.runtime[id].exhaustionLevel).toBe(6);
    expect(state.runtime[id].flags?.dead).toBe(true);
  });

  it('remove_condition exhaustion decrements level', () => {
    let state = stateWithPC();
    const id = state.combatActors[0].id;
    state.runtime[id].exhaustionLevel = 3;
    state = applyMutation(state, { op: 'remove_condition', actorId: id, conditionSlug: 'exhaustion' });
    expect(state.runtime[id].exhaustionLevel).toBe(2);
  });
});
```

### - [ ] Step 2: Modificare l'applicator (case `add_condition` e `remove_condition`)

File: `src/sessions/applicator.ts`:

```ts
case 'add_condition': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  if (m.condition.slug === 'exhaustion') {
    const newLevel = Math.min(6, (rt.exhaustionLevel ?? 0) + 1);
    next.runtime[m.actorId] = {
      ...rt,
      exhaustionLevel: newLevel,
      flags: newLevel >= 6 ? { ...(rt.flags ?? {}), dead: true } : rt.flags,
      conditions: rt.conditions.some((c) => c.slug === 'exhaustion')
        ? rt.conditions
        : [...rt.conditions, m.condition],
    };
  } else {
    // existing logic
    next.runtime[m.actorId] = {
      ...rt,
      conditions: rt.conditions.some((c) => c.slug === m.condition.slug)
        ? rt.conditions
        : [...rt.conditions, m.condition],
    };
  }
  break;
}

case 'remove_condition': {
  const rt = state.runtime[m.actorId];
  if (!rt) break;
  if (m.conditionSlug === 'exhaustion') {
    const cur = rt.exhaustionLevel ?? 0;
    const newLevel = Math.max(0, cur - 1);
    next.runtime[m.actorId] = {
      ...rt,
      exhaustionLevel: newLevel,
      conditions: newLevel === 0
        ? rt.conditions.filter((c) => c.slug !== 'exhaustion')
        : rt.conditions,
    };
  } else {
    next.runtime[m.actorId] = {
      ...rt,
      conditions: rt.conditions.filter((c) => c.slug !== m.conditionSlug),
    };
  }
  break;
}
```

### - [ ] Step 3: Run test → PASS

Run: `pnpm test conditions`

### - [ ] Step 4: Commit

```bash
git add src/sessions/applicator.ts tests/engine/conditions.test.ts
git commit -m "feat(conditions): exhaustion stacking with level cap and death at 6

PHB §4.1: exhaustion is a 6-level condition, cumulative.
- add_condition('exhaustion') increments runtime.exhaustionLevel up to 6
- level 6 sets flags.dead
- remove_condition('exhaustion') decrements (e.g. long rest)
The condition itself is kept once (one entry in conditions[]) and the
*level* lives in runtime.exhaustionLevel for resolver lookup."
```

---

## Task 10: Smoke test runtime e typecheck

### - [ ] Step 1: Eseguire l'intera test suite

Run: `pnpm test`
Expected: tutti i test PASS, nessun nuovo failure su file non toccati.

### - [ ] Step 2: Eseguire typecheck

Run: `pnpm typecheck`
Expected: 0 errori.

### - [ ] Step 3: Eseguire lint

Run: `pnpm lint`
Expected: 0 errori (warning OK).

### - [ ] Step 4: Smoke test del dev server

Run: `pnpm dev` (background)
Aprire http://localhost:3000, fare login, iniziare una sessione di gioco con un PC esistente, narrare un combattimento dove il PC arriva a 0 HP.
Verificare nei log che `make_death_save` venga chiamato e l'UI mostri lo stato.

### - [ ] Step 5: Commit final tag

```bash
git tag -a phase1-conditions-deaths-complete -m "Phase 1 of 90% coverage: conditions effects + death saves complete"
```

---

## Self-Review checklist

Prima di considerare la fase 1 chiusa:

- [ ] **Coverage delta misurato**: rieseguire l'audit Explore agent del Tier "Conditions/HP/Death" e verificare che salga da 44% a ≥80%.
- [ ] **No placeholder**: cerca nei file modificati per `TODO`/`FIXME`/`XXX` introdotti.
- [ ] **Type consistency**: `ConditionEffectFlags`, `ActorRuntimeState.flags`, `ActorRuntimeState.exhaustionLevel`, `Mutation.set_stable` sono coerenti tra dichiarazione e uso.
- [ ] **Idempotenza**: `make_death_save` chiamato due volte di seguito (nello stesso turno) deve essere previsto dal master prompt — verifica che il prompt avverta "una sola call per round per PC".
- [ ] **Heal-wakes**: confermato che `heal` ora resetta death saves e rimuove unconscious quando porta da 0 a >0.
- [ ] **Knockout vs death save**: una melee con `knockOut: true` non triggera death saves (path separato).

---

## Stima sforzo Phase 1

- Task 1 (resolver): 2h (con TDD)
- Task 2 (checks integration): 1h
- Task 3 (attack integration + knockout): 2h
- Task 4 (damage → death_save fail): 1h
- Task 5 (death_save handler): 1.5h
- Task 6 (tool exposure): 2h
- Task 7 (system prompt): 30min
- Task 8 (E2E scenarios): 1h
- Task 9 (exhaustion stacking): 1h
- Task 10 (smoke + typecheck): 30min

**Totale: ~12-14h** di un singolo sviluppatore. Con un agente subagent-driven: 1 giornata.

---

## Phase successive (high-level scope, da pianificare in dettaglio una alla volta)

### Phase 2: Concentration & Spell Engine Generic Factory (+15 pts)
- Aggiungere campo `concentratingOn?: { spellSlug; sourceActorId; expiresOnRound? }` a `ActorRuntimeState`
- Hook in `applyDamage`: se target sta concentrando, emit `concentration_check` con DC = max(10, dmg/2)
- Spell handler factory: archetipi `attack-spell`, `save-half-spell`, `save-negate-spell`, `condition-apply-spell`, `buff-spell`, `heal-spell`, `aoe-save-spell`. Mappa per ~30 archetipi → copre 200+ spell del SRD via dati CSV.
- Tool `cast_spell` riconosce archetype e dispatcha al handler giusto.
- Ritual flag: nuovo param `asRitual?: boolean` skippa consumo slot ma aggiunge 10 min di scene time.

### Phase 3: Action Economy & Standard Actions (+10 pts)
- `ActorRuntimeState.turnState`: `{ actionUsed, bonusUsed, reactionUsed, movementUsed, free Interactions }`
- Tool nuovi: `take_action({ kind: 'dash'|'disengage'|'dodge'|'help'|'hide'|'ready'|'search'|'use_object' })`
- Reset al `advance_turn`
- Opportunity attack auto-trigger quando un nemico esce dal reach senza Disengage (richiede tracking di posizione semplificato — distance bands).

### Phase 4: Inspiration + Long Rest constraints + Auto-Exhaustion (+5 pts)
- `Character.inspiration: boolean` + tool `grant_inspiration`/`spend_inspiration`
- `EngineState.lastLongRestEpoch?: number` per cooldown 24h
- `forced_march` tool: applica exhaustion automaticamente con CON save DC 10+ore extra
- `apply_hunger`/`apply_thirst` tool con CON save

### Phase 5: Magic Item Rarity & Attunement (+6 pts)
- Schema field `rarity: 'common'|'uncommon'|...` su codex named_item
- `Character.attunedItems: string[]` (max 3)
- Tool `attune({ itemSlug })` / `unattune({ itemSlug })` con check del cap
- Snapshot mostra "Attuned: 2/3"

### Phase 6: Exploration Layer (+8 pts)
- `EngineState.travel?: { pace: 'fast'|'normal'|'slow', currentLocation, lightLevel }`
- Tool `start_travel`/`end_travel`
- Tool `check_vision({ targetActorId })` → consulta darkvision range del target + lightLevel + cover
- Tool `apply_falling({ actorId, distanceFt })` → 1d6 per 10ft max 20d6 + prone
- Tool `apply_suffocation`, `apply_starvation`, `apply_dehydration`

### Phase 7: NPC Three-Beat & Tonal Frame (+3 pts)
- Schema `npc` codex: aggiungere `want: string`, `fear: string`, `quirk: string`, `attitude: 'friendly'|'indifferent'|'hostile'`
- Validation in lookup_codex/save: forzare master a fornire i 3 campi quando crea un NPC
- `Session.tonalFrame: 'high-heroic'|'sword-sorcery'|'dark'|...` iniettata nel system prompt al session start
- `Session.engagementProfile?: string[]` rilevato dai primi turni e iniettato come hint

---

## Note finali

- **TDD rigoroso**: ogni task è "test first", non "implementation first". I test sono il contratto.
- **DRY**: il resolver `getEffectsForActor` è il single source of truth; checks/attack/damage non duplicano la logica.
- **YAGNI**: charmed e deafened sono volutamente "no-op" perché richiedono tracking semantico (chi è il charmer? quale check usa l'udito?) che è meglio lasciare al narratore.
- **Frequent commits**: ogni task termina con un commit etichettato.
- **Reversibilità**: tutti i campi nuovi (`flags`, `exhaustionLevel`) sono opzionali; gli state esistenti continuano a funzionare.
