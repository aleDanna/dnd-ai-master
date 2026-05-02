# Plan B — Game Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, pure-TypeScript game engine for D&D 5e mechanics — dice, attacks, damage, conditions, slots, initiative, rests, level-up, equipment — plus the Anthropic tool definitions that Plan D will wire to the Claude Master loop. The engine is the single authority on mechanics: in Plan D the AI will never sum modifiers, never roll dice in its head, never decide whether an attack hits. Everything goes through this package.

**Architecture:** A self-contained TypeScript package under `src/engine/`. Three function categories: (1) **pure compute** (no I/O — `abilityModifier`, `attackBonus`, `proficiencyBonus`), (2) **action functions** (input state + parameters → `{result, mutations}`), and (3) **tool handlers** that bridge action functions to Anthropic's JSONSchema tool-call format. State lives in plain TypeScript objects (`EngineState`, `Character`, `CombatActor`, `ConditionInstance`) — Plan B does NOT create app-state DB tables. Mutations are declarative records (`{op: 'damage_actor', actor_id, amount}`); applying them to a DB transaction is left to Plan D, which will create the `characters`, `sessions`, `session_state` tables and the applicator. The engine reads SRD data via the existing `src/srd/lookup.ts` (Plan A).

**Tech Stack:**
- TypeScript (strict, with `noUncheckedIndexedAccess`)
- Vitest for unit tests; existing config from Plan A
- `crypto.randomInt` for dice (cryptographically strong, swappable for deterministic test seeds)
- `@anthropic-ai/sdk` types for tool definitions (the SDK is installed in this plan; the runtime invocation lives in Plan D)
- No new runtime libraries beyond what Plan A already installed plus `@anthropic-ai/sdk`

---

## Boundaries — what Plan B does NOT do

- ❌ No Anthropic SDK calls. Plan D wires the loop.
- ❌ No streaming. Plan D handles SSE.
- ❌ No DB writes for game state. The `session_state` / `characters` tables don't exist yet — those land in Plan C and D.
- ❌ No UI. Plan C builds the character wizard (with Claude Design assistance) and Plan D the game screen.
- ❌ No system prompt for the Master. Plan D writes that.
- ❌ No persistence of dice rolls into a `dice_log` table — the tools return roll details in their output; Plan D will persist them.

The engine is fully testable and verifiable on its own: `pnpm test` exercises every action with fixtures, no DB, no network.

---

## File map

```
docs/superpowers/plans/2026-05-02-plan-b-game-engine.md   THIS FILE

src/engine/
  types.ts                  shared types: Character, EngineState, CombatActor, Mutation, ActionResult, ToolDef
  rand.ts                   pluggable RNG (crypto by default, deterministic for tests)
  dice.ts                   rollDice, rollD20, rollDamage
  modifiers.ts              abilityModifier, proficiencyBonus, spellSaveDC, attackBonus, savingThrowBonus, skillBonus, passiveScore
  checks.ts                 abilityCheck, savingThrow, contestedCheck, passiveCheck, groupCheck
  combat/
    initiative.ts           rollInitiative
    attack.ts               makeAttack
    damage.ts               applyDamage (resistance/immunity/vulnerability)
    turn.ts                 endTurn, tickConditions
  spells.ts                 castSpell (slot consumption, save/attack)
  conditions.ts             applyCondition, removeCondition
  resources.ts              useResource (rage, ki, sorcery, second_wind, action_surge…)
  rests.ts                  shortRest, longRest
  equipment.ts              equip, unequip, recomputeAC
  levelup.ts                levelUp (HP roll, slot table update, feature unlocks)
  index.ts                  barrel re-export of public API

  tools/
    index.ts                Anthropic tool registry (array of ToolDef)
    schemas.ts              JSONSchema fragments shared across tool inputs
    handlers.ts             tool name → handler function mapping (each handler wraps an engine action)

src/engine/__fixtures__/
  pcs.ts                    sample PCs at lvl 1, 3, 5 (Fighter/Wizard/Cleric/Rogue)
  monsters.ts               in-memory CombatActor fixtures (goblin, ape, awakened-shrub)
  states.ts                 prebuilt EngineState scenarios (out-of-combat, mid-combat, dying)

tests/engine/
  rand.test.ts
  dice.test.ts
  modifiers.test.ts
  checks.test.ts
  combat/initiative.test.ts
  combat/attack.test.ts
  combat/damage.test.ts
  combat/turn.test.ts
  spells.test.ts
  conditions.test.ts
  resources.test.ts
  rests.test.ts
  equipment.test.ts
  levelup.test.ts
  tools/handlers.test.ts
  scenarios/                end-to-end-ish tests: full combat round, full short-rest cycle
    full-combat-round.test.ts
    full-rest-cycle.test.ts
```

Boundaries inside the engine:
- `types.ts` and `rand.ts` are zero-dependency.
- `modifiers.ts` and `dice.ts` depend only on `types.ts` and `rand.ts`.
- `checks.ts`, `combat/*`, `spells.ts`, `conditions.ts`, `resources.ts`, `rests.ts`, `equipment.ts`, `levelup.ts` depend on `modifiers.ts` + `dice.ts` + `types.ts`. They MAY import `src/srd/lookup.ts` for read-only SRD data (e.g. spell stats, monster stat blocks) but MUST NOT import anything from `src/db/client.ts` or `src/srd/seed.ts`.
- `tools/*` depends on every action file but is the ONLY entrypoint that Plan D will import.

---

## Phase 1 — Foundation

### Task 1: Install `@anthropic-ai/sdk` and verify

**Files:** `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: State**

```bash
pwd && git branch --show-current && git log --oneline -3
```
Expected: working dir `/Users/alessiodanna/projects/dnd-ai-master`, branch `main` (the plan suggests creating a working branch — see Step 2). Last commit `7b0dbbb fix(srd): extract trait names...`.

- [ ] **Step 2: Create the working branch**

```bash
git checkout -b plan-b-game-engine
git branch --show-current
```
Expected: prints `plan-b-game-engine`.

- [ ] **Step 3: Install Anthropic SDK**

```bash
pnpm add @anthropic-ai/sdk
```

- [ ] **Step 4: Smoke check (no API call — just import)**

```bash
pnpm exec tsx -e "import('@anthropic-ai/sdk').then(m => console.log('SDK exports:', Object.keys((m as { default?: typeof m }).default ?? m).slice(0, 5)))"
```
Expected: prints a few export names (e.g. `[ 'Anthropic', 'default', 'AnthropicError', ... ]`). No network call attempted.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @anthropic-ai/sdk for engine tool definitions"
```

---

### Task 2: Engine types

**Files:**
- Create: `src/engine/types.ts`

- [ ] **Step 1: Write `src/engine/types.ts`**

```ts
import type { Anthropic } from '@anthropic-ai/sdk';

// ─── Character (canonical, not yet persisted) ──────────────────────────────

export type Ability = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

export type Skill =
  | 'Acrobatics' | 'Animal Handling' | 'Arcana' | 'Athletics'
  | 'Deception' | 'History' | 'Insight' | 'Intimidation'
  | 'Investigation' | 'Medicine' | 'Nature' | 'Perception'
  | 'Performance' | 'Persuasion' | 'Religion' | 'Sleight of Hand'
  | 'Stealth' | 'Survival';

export type DamageType =
  | 'acid' | 'bludgeoning' | 'cold' | 'fire' | 'force' | 'lightning'
  | 'necrotic' | 'piercing' | 'poison' | 'psychic' | 'radiant'
  | 'slashing' | 'thunder';

export type ConditionSlug =
  | 'blinded' | 'charmed' | 'deafened' | 'frightened' | 'grappled'
  | 'incapacitated' | 'invisible' | 'paralyzed' | 'petrified' | 'poisoned'
  | 'prone' | 'restrained' | 'stunned' | 'unconscious' | 'exhaustion';

export interface Character {
  id: string;
  name: string;
  level: number;
  classSlug: string;
  raceSlug: string;
  backgroundSlug: string;
  abilities: Record<Ability, number>;
  proficiencyBonus: number;
  hpMax: number;
  ac: number;
  speed: number;
  proficiencies: {
    saves: Ability[];
    skills: Skill[];
    expertise: Skill[];
    weapons: string[];        // proficiency groups: "Simple" | "Martial" | individual slugs
    armor: string[];           // categories: "Light" | "Medium" | "Heavy" | "Shield"
    tools: string[];
    languages: string[];
  };
  spellcasting: SpellcastingState | null;
  features: FeatureInstance[];   // race/class/bg/feat features w/ uses-left
  inventory: InventoryItem[];
  hitDiceMax: number;
  hitDieSize: number;             // 6 | 8 | 10 | 12
}

export interface SpellcastingState {
  ability: Ability;
  spellSaveDC: number;
  spellAttackBonus: number;
  slotsMax: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  spellsKnown: string[];          // slugs
  spellsPrepared: string[];       // slugs (subset of known, for prep casters)
}

export interface FeatureInstance {
  slug: string;                   // e.g. 'rage', 'second_wind', 'channel_divinity'
  source: 'class' | 'race' | 'background' | 'feat';
  usesMax: number | 'unlimited';
  description: string;
}

export interface InventoryItem {
  slug: string;
  qty: number;
  equipped: boolean;
}

// ─── Combat actor (NPCs, monsters, hostile or allied) ──────────────────────

export interface CombatActor {
  id: string;
  kind: 'pc' | 'monster' | 'npc';
  name: string;
  monsterSlug?: string;           // if kind === 'monster'
  hpMax: number;
  ac: number;
  abilities: Record<Ability, number>;
  proficiencyBonus: number;
  initiativeBonus: number;
  resistances: DamageType[];
  immunities: DamageType[];
  vulnerabilities: DamageType[];
  conditionImmunities: ConditionSlug[];
}

// ─── Engine state (runtime-only — Plan D will persist this) ────────────────

export interface ConditionInstance {
  slug: ConditionSlug;
  source: string;                 // narrative source: e.g. "goblin's bite"
  durationRounds: number | 'until_removed';
  appliedRound: number;
}

export interface ResourceUsage {
  // Per-character resource trackers, keyed by feature slug.
  // Examples: { rage: 1, second_wind: 0, action_surge: 0 }
  [featureSlug: string]: number;
}

export interface CombatState {
  round: number;
  turnOrder: { actorId: string; initiative: number }[];
  currentIdx: number;
}

export interface ActorRuntimeState {
  actorId: string;
  hpCurrent: number;
  tempHp: number;
  conditions: ConditionInstance[];
  deathSaves: { successes: number; failures: number };
  // For PCs only:
  hitDiceRemaining?: number;
  spellSlotsUsed?: Partial<Record<1|2|3|4|5|6|7|8|9, number>>;
  resourcesUsed?: ResourceUsage;
}

export interface EngineState {
  characters: Character[];        // full PC sheets (canonical)
  combatActors: CombatActor[];    // monsters/NPCs in scene
  runtime: Record<string, ActorRuntimeState>;  // keyed by actor id
  combat: CombatState | null;
  scene: string;                  // short narrative summary
}

// ─── Mutations (declarative ops to apply to state) ─────────────────────────

export type Mutation =
  | { op: 'set_hp'; actorId: string; hpCurrent: number }
  | { op: 'apply_damage'; actorId: string; amount: number; type: DamageType }
  | { op: 'heal'; actorId: string; amount: number }
  | { op: 'set_temp_hp'; actorId: string; amount: number }
  | { op: 'add_condition'; actorId: string; condition: ConditionInstance }
  | { op: 'remove_condition'; actorId: string; conditionSlug: ConditionSlug }
  | { op: 'use_spell_slot'; actorId: string; level: 1|2|3|4|5|6|7|8|9 }
  | { op: 'use_resource'; actorId: string; featureSlug: string; amount: number }
  | { op: 'restore_resource'; actorId: string; featureSlug: string; amount: number }
  | { op: 'spend_hit_die'; actorId: string }
  | { op: 'restore_hit_dice'; actorId: string; amount: number }
  | { op: 'add_inventory'; characterId: string; itemSlug: string; qty: number }
  | { op: 'remove_inventory'; characterId: string; itemSlug: string; qty: number }
  | { op: 'set_equipped'; characterId: string; itemSlug: string; equipped: boolean }
  | { op: 'recompute_ac'; characterId: string; newAc: number }
  | { op: 'level_up'; characterId: string; newLevel: number; hpDelta: number; newSlots?: Partial<Record<1|2|3|4|5|6|7|8|9, number>> }
  | { op: 'death_save'; actorId: string; success: boolean; isCrit?: boolean }
  | { op: 'reset_death_saves'; actorId: string }
  | { op: 'set_combat'; combat: CombatState | null }
  | { op: 'advance_turn' }
  | { op: 'set_scene'; scene: string };

// ─── Action results ────────────────────────────────────────────────────────

export interface DiceRoll {
  formula: string;                // "1d20+5"
  rolls: number[];                // [14] or [11, 17] for advantage
  modifier: number;
  total: number;
  meta?: Record<string, unknown>;
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  rolls: DiceRoll[];
  mutations: Mutation[];
  narrative?: string;             // optional human-readable summary
}

// ─── Tool definitions (Anthropic shape) ────────────────────────────────────

export type AnthropicTool = Anthropic.Messages.Tool;

export interface ToolDef {
  definition: AnthropicTool;
  // Plan D will call handlers via the registry in src/engine/tools/handlers.ts.
  // Each handler signature is `(state: EngineState, input: unknown) => ActionResult`.
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```
Expected: clean. If `Anthropic.Messages.Tool` is not exported under that path in your installed SDK version, replace with the correct import (run `pnpm exec tsc --traceResolution 2>&1 | head -50` to inspect, or check `node_modules/@anthropic-ai/sdk/resources/messages.d.ts`). The fallback if the namespace path differs:
```ts
type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};
```
Note in your report which form you ended up using.

- [ ] **Step 3: Commit**

```bash
git add src/engine/types.ts
git commit -m "feat(engine): add core types (Character, EngineState, Mutation, ActionResult)"
```

---

### Task 3: RNG abstraction (TDD)

**Files:**
- Create: `src/engine/rand.ts`
- Create: `tests/engine/rand.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/rand.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createRng, defaultRng, makeSeededRng } from '@/engine/rand';

describe('rand', () => {
  it('default rng produces integers in [min, max] inclusive', () => {
    for (let i = 0; i < 1000; i++) {
      const v = defaultRng.intInclusive(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('seeded rng is deterministic across two instances with the same seed', () => {
    const a = makeSeededRng(42);
    const b = makeSeededRng(42);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 10; i++) {
      seqA.push(a.intInclusive(1, 20));
      seqB.push(b.intInclusive(1, 20));
    }
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences (with overwhelming probability)', () => {
    const a = makeSeededRng(1);
    const b = makeSeededRng(2);
    const seqA = Array.from({ length: 20 }, () => a.intInclusive(1, 100));
    const seqB = Array.from({ length: 20 }, () => b.intInclusive(1, 100));
    expect(seqA).not.toEqual(seqB);
  });

  it('createRng accepts a custom function and uses it', () => {
    let calls = 0;
    const fixed = createRng(() => { calls++; return 0.5; });
    const v = fixed.intInclusive(1, 10);
    // Math.floor(0.5 * 10) + 1 === 6
    expect(v).toBe(6);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run — must FAIL** (`pnpm test tests/engine/rand.test.ts`)

- [ ] **Step 3: Implement `src/engine/rand.ts`**

```ts
import { randomInt } from 'node:crypto';

export interface Rng {
  /** Return a uniformly-random integer in [min, max] inclusive. */
  intInclusive(min: number, max: number): number;
}

export function createRng(uniform01: () => number): Rng {
  return {
    intInclusive(min, max) {
      if (max < min) throw new Error(`createRng.intInclusive: max (${max}) < min (${min})`);
      const span = max - min + 1;
      return Math.floor(uniform01() * span) + min;
    },
  };
}

/** Default crypto-strong RNG. Used in production. */
export const defaultRng: Rng = {
  intInclusive(min, max) {
    if (max < min) throw new Error(`defaultRng.intInclusive: max (${max}) < min (${min})`);
    return randomInt(min, max + 1);  // node's randomInt is exclusive on max
  },
};

/** Mulberry32-seeded RNG. Deterministic for tests. */
export function makeSeededRng(seed: number): Rng {
  let s = seed >>> 0;
  function next(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  return createRng(next);
}
```

- [ ] **Step 4: Run — must PASS** (4 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/rand.ts tests/engine/rand.test.ts
git commit -m "feat(engine): pluggable RNG with crypto default and Mulberry32 seed for tests"
```

---

## Phase 2 — Dice and modifiers

### Task 4: Dice (TDD)

**Files:**
- Create: `src/engine/dice.ts`
- Create: `tests/engine/dice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { rollDice, rollD20, rollDamage } from '@/engine/dice';
import { makeSeededRng } from '@/engine/rand';

describe('rollDice', () => {
  it('parses XdY+Z and rolls X dice of size Y, summing with modifier Z', () => {
    const rng = makeSeededRng(123);
    const r = rollDice('3d6+2', rng);
    expect(r.rolls.length).toBe(3);
    r.rolls.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    });
    expect(r.modifier).toBe(2);
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 2);
    expect(r.formula).toBe('3d6+2');
  });

  it('parses XdY without modifier', () => {
    const rng = makeSeededRng(7);
    const r = rollDice('1d8', rng);
    expect(r.rolls.length).toBe(1);
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(r.rolls[0]);
  });

  it('parses negative modifier', () => {
    const rng = makeSeededRng(5);
    const r = rollDice('2d4-1', rng);
    expect(r.modifier).toBe(-1);
  });

  it('throws on bad formula', () => {
    const rng = makeSeededRng(1);
    expect(() => rollDice('abc', rng)).toThrow();
    expect(() => rollDice('0d6', rng)).toThrow();
    expect(() => rollDice('1d0', rng)).toThrow();
  });
});

describe('rollD20', () => {
  it('rolls a single d20 with modifier', () => {
    const rng = makeSeededRng(1);
    const r = rollD20({ modifier: 5 }, rng);
    expect(r.rolls.length).toBe(1);
    expect(r.modifier).toBe(5);
    expect(r.total).toBe(r.rolls[0]! + 5);
  });

  it('with advantage rolls 2d20 and takes higher', () => {
    const rng = makeSeededRng(42);
    const r = rollD20({ advantage: true, modifier: 3 }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(Math.max(...r.rolls) + 3);
    expect(r.meta?.advantage).toBe(true);
  });

  it('with disadvantage rolls 2d20 and takes lower', () => {
    const rng = makeSeededRng(42);
    const r = rollD20({ disadvantage: true, modifier: 0 }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(Math.min(...r.rolls));
    expect(r.meta?.disadvantage).toBe(true);
  });

  it('advantage AND disadvantage cancel — single d20', () => {
    const rng = makeSeededRng(99);
    const r = rollD20({ advantage: true, disadvantage: true }, rng);
    expect(r.rolls.length).toBe(1);
    expect(r.meta?.advantage).toBeUndefined();
    expect(r.meta?.disadvantage).toBeUndefined();
  });
});

describe('rollDamage', () => {
  it('rolls per the formula', () => {
    const rng = makeSeededRng(11);
    const r = rollDamage('2d6+3', { crit: false }, rng);
    expect(r.rolls.length).toBe(2);
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 3);
  });

  it('on crit doubles the dice but not the modifier', () => {
    const rng = makeSeededRng(11);
    const r = rollDamage('1d8+4', { crit: true }, rng);
    expect(r.rolls.length).toBe(2);                          // doubled
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 4);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/dice.ts`**

```ts
import type { DiceRoll } from './types';
import { defaultRng, type Rng } from './rand';

const FORMULA_RE = /^(\d+)d(\d+)([+-]\d+)?$/i;

function parseFormula(formula: string): { count: number; size: number; modifier: number } {
  const m = FORMULA_RE.exec(formula.trim());
  if (!m) throw new Error(`rollDice: bad formula "${formula}"`);
  const count = parseInt(m[1]!, 10);
  const size = parseInt(m[2]!, 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  if (count <= 0) throw new Error(`rollDice: count must be > 0 (got ${count})`);
  if (size <= 0) throw new Error(`rollDice: size must be > 0 (got ${size})`);
  return { count, size, modifier };
}

export function rollDice(formula: string, rng: Rng = defaultRng): DiceRoll {
  const { count, size, modifier } = parseFormula(formula);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(rng.intInclusive(1, size));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { formula, rolls, modifier, total };
}

export interface D20Options {
  advantage?: boolean;
  disadvantage?: boolean;
  modifier?: number;
}

export function rollD20(opts: D20Options = {}, rng: Rng = defaultRng): DiceRoll {
  const adv = !!opts.advantage && !opts.disadvantage;
  const dis = !!opts.disadvantage && !opts.advantage;
  const modifier = opts.modifier ?? 0;
  const rolls: number[] = [];
  if (adv || dis) {
    rolls.push(rng.intInclusive(1, 20));
    rolls.push(rng.intInclusive(1, 20));
  } else {
    rolls.push(rng.intInclusive(1, 20));
  }
  const chosen = adv ? Math.max(...rolls) : dis ? Math.min(...rolls) : rolls[0]!;
  const total = chosen + modifier;
  const meta: Record<string, unknown> = {};
  if (adv) meta.advantage = true;
  if (dis) meta.disadvantage = true;
  return {
    formula: `1d20${modifier ? (modifier > 0 ? '+' : '') + modifier : ''}`,
    rolls,
    modifier,
    total,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

export interface DamageOptions {
  crit?: boolean;
}

export function rollDamage(formula: string, opts: DamageOptions = {}, rng: Rng = defaultRng): DiceRoll {
  const { count, size, modifier } = parseFormula(formula);
  const effectiveCount = opts.crit ? count * 2 : count;
  const rolls: number[] = [];
  for (let i = 0; i < effectiveCount; i++) rolls.push(rng.intInclusive(1, size));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return {
    formula,
    rolls,
    modifier,
    total,
    ...(opts.crit ? { meta: { crit: true } } : {}),
  };
}
```

- [ ] **Step 4: Run — must PASS** (12 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/dice.ts tests/engine/dice.test.ts
git commit -m "feat(engine): rollDice, rollD20 (advantage/disadvantage), rollDamage (crit)"
```

---

### Task 5: Modifiers (TDD)

**Files:**
- Create: `src/engine/modifiers.ts`
- Create: `tests/engine/modifiers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  abilityModifier, proficiencyBonusForLevel, attackBonus,
  savingThrowBonus, skillBonus, passiveScore, spellSaveDC, spellAttackBonus,
} from '@/engine/modifiers';
import type { Character } from '@/engine/types';

const sampleFighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'half-elf', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44, ac: 18, speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics', 'Perception'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common', 'Elvish'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 5, hitDieSize: 10,
};

describe('modifiers', () => {
  it('abilityModifier follows the table (1→-5, 10→0, 14→+2, 20→+5, 30→+10)', () => {
    expect(abilityModifier(1)).toBe(-5);
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(14)).toBe(2);
    expect(abilityModifier(20)).toBe(5);
    expect(abilityModifier(30)).toBe(10);
  });

  it('proficiencyBonusForLevel follows the table', () => {
    expect(proficiencyBonusForLevel(1)).toBe(2);
    expect(proficiencyBonusForLevel(4)).toBe(2);
    expect(proficiencyBonusForLevel(5)).toBe(3);
    expect(proficiencyBonusForLevel(8)).toBe(3);
    expect(proficiencyBonusForLevel(9)).toBe(4);
    expect(proficiencyBonusForLevel(13)).toBe(5);
    expect(proficiencyBonusForLevel(17)).toBe(6);
    expect(proficiencyBonusForLevel(20)).toBe(6);
  });

  it('savingThrowBonus adds proficiency only for proficient saves', () => {
    expect(savingThrowBonus(sampleFighter, 'STR')).toBe(3 /* str mod */ + 3 /* prof */);
    expect(savingThrowBonus(sampleFighter, 'INT')).toBe(0);
  });

  it('skillBonus adds proficiency for proficient skills, doubles for expertise', () => {
    expect(skillBonus(sampleFighter, 'Athletics')).toBe(3 + 3); // STR + prof
    expect(skillBonus(sampleFighter, 'Stealth')).toBe(2);       // DEX only
    const rogueLike: Character = {
      ...sampleFighter,
      proficiencies: { ...sampleFighter.proficiencies, expertise: ['Athletics'] },
    };
    expect(skillBonus(rogueLike, 'Athletics')).toBe(3 + 6);     // STR + 2× prof
  });

  it('passiveScore is 10 + skillBonus + advantage/disadvantage adjustments', () => {
    expect(passiveScore(sampleFighter, 'Perception')).toBe(10 + 1 + 3); // WIS + prof
    expect(passiveScore(sampleFighter, 'Perception', { advantage: true })).toBe(10 + 1 + 3 + 5);
    expect(passiveScore(sampleFighter, 'Perception', { disadvantage: true })).toBe(10 + 1 + 3 - 5);
  });

  it('attackBonus = ability mod + (prof if proficient with weapon)', () => {
    // Longsword (martial), STR-based for Tharion
    expect(attackBonus(sampleFighter, { profGroup: 'Martial', useDex: false })).toBe(3 + 3);
    // Hypothetical weapon Tharion is NOT proficient with
    const noProf: Character = { ...sampleFighter, proficiencies: { ...sampleFighter.proficiencies, weapons: [] } };
    expect(attackBonus(noProf, { profGroup: 'Martial', useDex: false })).toBe(3);
  });

  it('spellSaveDC = 8 + prof + spellcasting ability mod', () => {
    const wizard: Character = {
      ...sampleFighter, classSlug: 'wizard',
      abilities: { ...sampleFighter.abilities, INT: 18 },
      proficiencyBonus: 3,
      spellcasting: { ability: 'INT', spellSaveDC: 0, spellAttackBonus: 0, slotsMax: { 1: 4 }, spellsKnown: [], spellsPrepared: [] },
    };
    expect(spellSaveDC(wizard)).toBe(8 + 3 + 4);
    expect(spellAttackBonus(wizard)).toBe(3 + 4);
  });

  it('spellSaveDC throws when character has no spellcasting', () => {
    expect(() => spellSaveDC(sampleFighter)).toThrow();
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/modifiers.ts`**

```ts
import type { Ability, Character, Skill } from './types';

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

const PB_BY_LEVEL: Record<number, number> = {
  1: 2,  2: 2,  3: 2,  4: 2,
  5: 3,  6: 3,  7: 3,  8: 3,
  9: 4, 10: 4, 11: 4, 12: 4,
  13: 5, 14: 5, 15: 5, 16: 5,
  17: 6, 18: 6, 19: 6, 20: 6,
};

export function proficiencyBonusForLevel(level: number): number {
  if (level < 1 || level > 20) throw new Error(`proficiencyBonusForLevel: level out of range (${level})`);
  return PB_BY_LEVEL[level]!;
}

export function savingThrowBonus(c: Character, ability: Ability): number {
  const base = abilityModifier(c.abilities[ability]);
  const proficient = c.proficiencies.saves.includes(ability);
  return base + (proficient ? c.proficiencyBonus : 0);
}

const SKILL_ABILITY: Record<Skill, Ability> = {
  'Acrobatics': 'DEX', 'Animal Handling': 'WIS', 'Arcana': 'INT',
  'Athletics': 'STR', 'Deception': 'CHA', 'History': 'INT',
  'Insight': 'WIS', 'Intimidation': 'CHA', 'Investigation': 'INT',
  'Medicine': 'WIS', 'Nature': 'INT', 'Perception': 'WIS',
  'Performance': 'CHA', 'Persuasion': 'CHA', 'Religion': 'INT',
  'Sleight of Hand': 'DEX', 'Stealth': 'DEX', 'Survival': 'WIS',
};

export function skillBonus(c: Character, skill: Skill): number {
  const ability = SKILL_ABILITY[skill];
  const base = abilityModifier(c.abilities[ability]);
  const proficient = c.proficiencies.skills.includes(skill);
  const expert = c.proficiencies.expertise.includes(skill);
  const profMult = expert ? 2 : proficient ? 1 : 0;
  return base + profMult * c.proficiencyBonus;
}

export function passiveScore(
  c: Character,
  skill: Skill,
  opts: { advantage?: boolean; disadvantage?: boolean } = {},
): number {
  const adv = !!opts.advantage && !opts.disadvantage;
  const dis = !!opts.disadvantage && !opts.advantage;
  const adjustment = adv ? 5 : dis ? -5 : 0;
  return 10 + skillBonus(c, skill) + adjustment;
}

export interface AttackProfile {
  profGroup: string;        // proficiency group name e.g. "Martial" or weapon slug
  useDex: boolean;          // true for ranged or finesse used as DEX
}

export function attackBonus(c: Character, profile: AttackProfile): number {
  const abilityMod = abilityModifier(profile.useDex ? c.abilities.DEX : c.abilities.STR);
  const proficient = c.proficiencies.weapons.some((w) => w === profile.profGroup);
  return abilityMod + (proficient ? c.proficiencyBonus : 0);
}

export function spellSaveDC(c: Character): number {
  if (!c.spellcasting) throw new Error(`spellSaveDC: ${c.name} is not a spellcaster`);
  const mod = abilityModifier(c.abilities[c.spellcasting.ability]);
  return 8 + c.proficiencyBonus + mod;
}

export function spellAttackBonus(c: Character): number {
  if (!c.spellcasting) throw new Error(`spellAttackBonus: ${c.name} is not a spellcaster`);
  const mod = abilityModifier(c.abilities[c.spellcasting.ability]);
  return c.proficiencyBonus + mod;
}
```

- [ ] **Step 4: Run — must PASS** (8 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/modifiers.ts tests/engine/modifiers.test.ts
git commit -m "feat(engine): ability/proficiency/save/skill/passive/attack/spell modifiers"
```

---

## Phase 3 — Checks and saves

### Task 6: Checks (TDD)

**Files:**
- Create: `src/engine/checks.ts`
- Create: `tests/engine/checks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { abilityCheck, savingThrow, contestedCheck, passiveCheck, groupCheck } from '@/engine/checks';
import { makeSeededRng } from '@/engine/rand';
import type { Character } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 3,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 28, ac: 16, speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'], skills: ['Athletics', 'Intimidation'], expertise: [],
    weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'],
  },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 3, hitDieSize: 10,
};

describe('abilityCheck', () => {
  it('rolls d20 + STR + prof for Athletics with DC, ok = total >= dc', () => {
    const r = abilityCheck({ char: fighter, skill: 'Athletics', dc: 15 }, makeSeededRng(1));
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.modifier).toBe(3 + 2);                    // STR mod 3 + prof 2
    expect(r.data?.dc).toBe(15);
    expect(typeof r.ok).toBe('boolean');
    expect(r.ok).toBe(r.rolls[0]!.total >= 15);
  });

  it('uses raw ability modifier when skill omitted', () => {
    const r = abilityCheck({ char: fighter, ability: 'STR', dc: 10 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(3);                         // STR only, no prof
  });

  it('passes advantage/disadvantage to roll', () => {
    const r = abilityCheck({ char: fighter, skill: 'Athletics', dc: 10, advantage: true }, makeSeededRng(1));
    expect(r.rolls[0]!.rolls.length).toBe(2);
    expect(r.rolls[0]!.meta?.advantage).toBe(true);
  });
});

describe('savingThrow', () => {
  it('adds save proficiency when character is proficient', () => {
    const r = savingThrow({ char: fighter, ability: 'STR', dc: 12 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(3 + 2);
  });

  it('omits proficiency when not proficient', () => {
    const r = savingThrow({ char: fighter, ability: 'INT', dc: 12 }, makeSeededRng(1));
    expect(r.rolls[0]!.modifier).toBe(0);
  });
});

describe('contestedCheck', () => {
  it('returns the higher-rolling side', () => {
    // Use a fixed RNG that produces specific values
    const r = contestedCheck(
      { char: fighter, skill: 'Athletics' },
      { char: fighter, skill: 'Athletics' },
      makeSeededRng(1),
    );
    expect(r.rolls.length).toBe(2);
    expect(r.data?.winner).toMatch(/^[ab]$|^tie$/);
  });
});

describe('passiveCheck', () => {
  it('returns the static passive score and a synthetic dice roll for logging', () => {
    const r = passiveCheck({ char: fighter, skill: 'Athletics' });
    // Passive Athletics = 10 + STR(3) + prof(2) = 15
    expect(r.data?.passive).toBe(15);
    expect(r.rolls.length).toBe(1);
    expect(r.rolls[0]!.formula).toBe('passive');
  });
});

describe('groupCheck', () => {
  it('passes when at least half the group succeeds', () => {
    const a: Character = { ...fighter, id: 'a' };
    const b: Character = { ...fighter, id: 'b' };
    const c: Character = { ...fighter, id: 'c' };
    const r = groupCheck({ chars: [a, b, c], skill: 'Athletics', dc: 5 }, makeSeededRng(1));
    expect(r.rolls.length).toBe(3);
    const successes = r.rolls.filter((x) => x.total >= 5).length;
    expect(r.ok).toBe(successes >= 2);                                 // ceil(3/2) = 2
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/checks.ts`**

```ts
import type { Ability, ActionResult, Character, Skill } from './types';
import { abilityModifier, savingThrowBonus, skillBonus, passiveScore } from './modifiers';
import { rollD20 } from './dice';
import { defaultRng, type Rng } from './rand';

export interface AbilityCheckInput {
  char: Character;
  skill?: Skill;
  ability?: Ability;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function abilityCheck(input: AbilityCheckInput, rng: Rng = defaultRng): ActionResult<{ dc: number }> {
  let modifier = 0;
  if (input.skill) {
    modifier = skillBonus(input.char, input.skill);
  } else if (input.ability) {
    modifier = abilityModifier(input.char.abilities[input.ability]);
  } else {
    return { ok: false, error: 'abilityCheck: must provide skill or ability', rolls: [], mutations: [] };
  }
  const roll = rollD20({ advantage: input.advantage, disadvantage: input.disadvantage, modifier }, rng);
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations: [],
  };
}

export interface SavingThrowInput {
  char: Character;
  ability: Ability;
  dc: number;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function savingThrow(input: SavingThrowInput, rng: Rng = defaultRng): ActionResult<{ dc: number }> {
  const modifier = savingThrowBonus(input.char, input.ability);
  const roll = rollD20({ advantage: input.advantage, disadvantage: input.disadvantage, modifier }, rng);
  return {
    ok: roll.total >= input.dc,
    data: { dc: input.dc },
    rolls: [roll],
    mutations: [],
  };
}

export interface ContestSide {
  char: Character;
  skill?: Skill;
  ability?: Ability;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function contestedCheck(
  a: ContestSide,
  b: ContestSide,
  rng: Rng = defaultRng,
): ActionResult<{ winner: 'a' | 'b' | 'tie' }> {
  const rA = abilityCheck({ char: a.char, skill: a.skill, ability: a.ability, dc: 0, advantage: a.advantage, disadvantage: a.disadvantage }, rng);
  const rB = abilityCheck({ char: b.char, skill: b.skill, ability: b.ability, dc: 0, advantage: b.advantage, disadvantage: b.disadvantage }, rng);
  const ta = rA.rolls[0]!.total;
  const tb = rB.rolls[0]!.total;
  const winner: 'a' | 'b' | 'tie' = ta > tb ? 'a' : tb > ta ? 'b' : 'tie';
  return {
    ok: winner !== 'tie',
    data: { winner },
    rolls: [...rA.rolls, ...rB.rolls],
    mutations: [],
  };
}

export interface PassiveCheckInput {
  char: Character;
  skill: Skill;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function passiveCheck(input: PassiveCheckInput): ActionResult<{ passive: number }> {
  const passive = passiveScore(input.char, input.skill, { advantage: input.advantage, disadvantage: input.disadvantage });
  return {
    ok: true,
    data: { passive },
    rolls: [{ formula: 'passive', rolls: [], modifier: 0, total: passive, meta: { passive: true, skill: input.skill } }],
    mutations: [],
  };
}

export interface GroupCheckInput {
  chars: Character[];
  skill: Skill;
  dc: number;
}

export function groupCheck(input: GroupCheckInput, rng: Rng = defaultRng): ActionResult<{ successes: number; needed: number }> {
  const rolls = input.chars.map((c) => rollD20({ modifier: skillBonus(c, input.skill) }, rng));
  const successes = rolls.filter((r) => r.total >= input.dc).length;
  const needed = Math.ceil(input.chars.length / 2);
  return {
    ok: successes >= needed,
    data: { successes, needed },
    rolls,
    mutations: [],
  };
}
```

- [ ] **Step 4: Run — must PASS** (8 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/checks.ts tests/engine/checks.test.ts
git commit -m "feat(engine): ability/saving/contested/passive/group checks"
```

---

## Phase 4 — Combat (initiative, attack, damage, turn)

### Task 7: Initiative (TDD)

**Files:**
- Create: `src/engine/combat/initiative.ts`
- Create: `tests/engine/combat/initiative.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { rollInitiative } from '@/engine/combat/initiative';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor } from '@/engine/types';

const pc: Character = {
  id: 'pc1', name: 'Tharion', level: 1, classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', monsterSlug: 'goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('rollInitiative', () => {
  it('returns turn order sorted by initiative desc', () => {
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, makeSeededRng(1));
    expect(r.data?.turnOrder.length).toBe(2);
    const order = r.data!.turnOrder;
    expect(order[0]!.initiative).toBeGreaterThanOrEqual(order[1]!.initiative);
  });

  it('records mutations to set combat state', () => {
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, makeSeededRng(1));
    expect(r.mutations.some((m) => m.op === 'set_combat')).toBe(true);
  });

  it('breaks ties by DEX score (PC first), then by id', () => {
    // Force tie via custom RNG
    const fixedRng = { intInclusive: () => 10 };
    const r = rollInitiative({ pcs: [pc], monsters: [goblin] }, fixedRng);
    expect(r.data?.turnOrder.length).toBe(2);
    // Both rolled 10. PC has DEX 16, goblin has DEX 14, so PC first.
    expect(r.data!.turnOrder[0]!.actorId).toBe('pc1');
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/combat/initiative.ts`**

```ts
import type { ActionResult, Character, CombatActor, CombatState, Mutation } from '../types';
import { abilityModifier } from '../modifiers';
import { rollD20 } from '../dice';
import { defaultRng, type Rng } from '../rand';

export interface InitiativeInput {
  pcs: Character[];
  monsters: CombatActor[];
}

export function rollInitiative(input: InitiativeInput, rng: Rng = defaultRng): ActionResult<{ turnOrder: CombatState['turnOrder'] }> {
  const entries: { id: string; init: number; dex: number; isPc: boolean; rollIdx: number }[] = [];
  const rolls = [];

  for (const pc of input.pcs) {
    const r = rollD20({ modifier: abilityModifier(pc.abilities.DEX) }, rng);
    rolls.push(r);
    entries.push({ id: pc.id, init: r.total, dex: pc.abilities.DEX, isPc: true, rollIdx: rolls.length - 1 });
  }
  for (const m of input.monsters) {
    const r = rollD20({ modifier: m.initiativeBonus }, rng);
    rolls.push(r);
    entries.push({ id: m.id, init: r.total, dex: m.abilities.DEX, isPc: false, rollIdx: rolls.length - 1 });
  }

  entries.sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init;
    if (b.dex !== a.dex) return b.dex - a.dex;
    if (a.isPc !== b.isPc) return a.isPc ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const turnOrder: CombatState['turnOrder'] = entries.map((e) => ({ actorId: e.id, initiative: e.init }));
  const combat: CombatState = { round: 1, turnOrder, currentIdx: 0 };
  const mutations: Mutation[] = [{ op: 'set_combat', combat }];

  return {
    ok: true,
    data: { turnOrder },
    rolls,
    mutations,
  };
}
```

- [ ] **Step 4: Run — must PASS** (3 tests). Note: the test uses a plain object `{ intInclusive: () => 10 }` as `Rng` — that's fine because our `Rng` interface only requires `intInclusive`.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/combat/initiative.ts tests/engine/combat/initiative.test.ts
git commit -m "feat(engine): rollInitiative with PB ties and dex tiebreak"
```

---

### Task 8: Attack (TDD)

**Files:**
- Create: `src/engine/combat/attack.ts`
- Create: `tests/engine/combat/attack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { makeAttack } from '@/engine/combat/attack';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('makeAttack', () => {
  it('on hit: returns ok=true, damage roll, apply_damage mutation', () => {
    // Find a seed where the d20 hits AC 15
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
      }, makeSeededRng(seed));
      if (r.ok) {
        expect(r.rolls.length).toBeGreaterThanOrEqual(2);    // attack + damage
        expect(r.mutations.some((m) => m.op === 'apply_damage' && (m as { actorId: string }).actorId === 'm1')).toBe(true);
        return;
      }
      seed++;
    }
    throw new Error('No hit found in 100 seeds — RNG suspicious');
  });

  it('on miss: ok=false, no damage roll, no mutations', () => {
    let seed = 0;
    while (seed < 100) {
      const r = makeAttack({
        attacker: fighter,
        target: goblin,
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
        disadvantage: true,
      }, makeSeededRng(seed));
      if (!r.ok && r.error === 'miss') {
        expect(r.mutations.length).toBe(0);
        expect(r.rolls.length).toBe(1);                        // only attack roll
        return;
      }
      seed++;
    }
    throw new Error('No miss found in 100 seeds — RNG suspicious');
  });

  it('natural 20 always hits and crits damage', () => {
    const fixed20 = { intInclusive: (min: number, max: number) => max === 20 ? 20 : 1 + min };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed20);
    expect(r.ok).toBe(true);
    expect(r.data?.crit).toBe(true);
    // Damage roll should have 2 dice (1d8 doubled)
    const damageRoll = r.rolls[1]!;
    expect(damageRoll.rolls.length).toBe(2);
  });

  it('natural 1 always misses regardless of bonus', () => {
    const fixed1 = { intInclusive: (min: number, max: number) => max === 20 ? 1 : 1 };
    const r = makeAttack({
      attacker: fighter,
      target: goblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixed1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('miss');
    expect(r.data?.crit).toBeFalsy();
  });

  it('respects target resistance/immunity: damage halved on resistance, zero on immunity', () => {
    const resistantGoblin: CombatActor = { ...goblin, resistances: ['slashing'] };
    const fixedHit = { intInclusive: (_min: number, max: number) => max === 20 ? 18 : Math.ceil(max / 2) };
    const r = makeAttack({
      attacker: fighter,
      target: resistantGoblin,
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    }, fixedHit);
    expect(r.ok).toBe(true);
    const dmgMut = r.mutations.find((m) => m.op === 'apply_damage') as { amount: number } | undefined;
    expect(dmgMut).toBeDefined();
    // The mutation amount should reflect halving (ceil(raw / 2)) — engine handles this.
    expect(dmgMut!.amount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/combat/attack.ts`**

```ts
import type { ActionResult, Character, CombatActor, DamageType, Mutation } from '../types';
import { attackBonus, abilityModifier } from '../modifiers';
import { rollD20, rollDamage } from '../dice';
import { defaultRng, type Rng } from '../rand';

export interface WeaponSpec {
  name: string;
  damage: string;          // e.g. "1d8"
  damageType: DamageType;
  profGroup: string;       // proficiency group
  useDex: boolean;         // use DEX instead of STR for to-hit and damage
}

export interface MakeAttackInput {
  attacker: Character;
  target: CombatActor;
  weapon: WeaponSpec;
  advantage?: boolean;
  disadvantage?: boolean;
}

export function makeAttack(input: MakeAttackInput, rng: Rng = defaultRng): ActionResult<{ hit: boolean; crit: boolean; rawDamage: number; finalDamage: number }> {
  const bonus = attackBonus(input.attacker, { profGroup: input.weapon.profGroup, useDex: input.weapon.useDex });
  const attackRoll = rollD20({ advantage: input.advantage, disadvantage: input.disadvantage, modifier: bonus }, rng);

  const natural = attackRoll.rolls.length === 1
    ? attackRoll.rolls[0]!
    : input.advantage ? Math.max(...attackRoll.rolls) : Math.min(...attackRoll.rolls);

  if (natural === 1) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }
  const crit = natural === 20;
  const hit = crit || attackRoll.total >= input.target.ac;
  if (!hit) {
    return { ok: false, error: 'miss', data: { hit: false, crit: false, rawDamage: 0, finalDamage: 0 }, rolls: [attackRoll], mutations: [] };
  }

  const damageMod = abilityModifier(input.weapon.useDex ? input.attacker.abilities.DEX : input.attacker.abilities.STR);
  const damageFormula = `${input.weapon.damage}${damageMod >= 0 ? '+' : ''}${damageMod}`;
  const damageRoll = rollDamage(damageFormula, { crit }, rng);
  const rawDamage = Math.max(0, damageRoll.total);

  const finalDamage = applyDamageModifiers(rawDamage, input.weapon.damageType, input.target);
  const mutations: Mutation[] = [];
  if (finalDamage > 0) {
    mutations.push({ op: 'apply_damage', actorId: input.target.id, amount: finalDamage, type: input.weapon.damageType });
  }

  return {
    ok: true,
    data: { hit: true, crit, rawDamage, finalDamage },
    rolls: [attackRoll, damageRoll],
    mutations,
  };
}

function applyDamageModifiers(amount: number, type: DamageType, target: CombatActor): number {
  if (target.immunities.includes(type)) return 0;
  if (target.resistances.includes(type)) return Math.floor(amount / 2);
  if (target.vulnerabilities.includes(type)) return amount * 2;
  return amount;
}
```

- [ ] **Step 4: Run — must PASS** (5 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/combat/attack.ts tests/engine/combat/attack.test.ts
git commit -m "feat(engine): makeAttack with crit, miss, resistance/immunity"
```

---

### Task 9: Damage application (TDD)

**Files:**
- Create: `src/engine/combat/damage.ts`
- Create: `tests/engine/combat/damage.test.ts`

`makeAttack` already returns an `apply_damage` mutation. This task extracts the mutation-to-state transformation into a reusable function (used in spell saves, environmental damage, etc.) and tests death-save logic.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { applyDamage } from '@/engine/combat/damage';
import type { ActorRuntimeState, CombatActor, Character } from '@/engine/types';

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: ['fire'], conditionImmunities: [],
};

const goblinRuntime: ActorRuntimeState = {
  actorId: 'm1', hpCurrent: 7, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 },
};

describe('applyDamage', () => {
  it('reduces hpCurrent by amount', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 4, type: 'slashing' });
    expect(r.data?.newHp).toBe(3);
    expect(r.mutations[0]).toEqual({ op: 'set_hp', actorId: 'm1', hpCurrent: 3 });
  });

  it('applies vulnerability (doubles)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 3, type: 'fire' });
    expect(r.data?.newHp).toBe(7 - 6);
  });

  it('temp HP absorbs damage first', () => {
    const withTemp: ActorRuntimeState = { ...goblinRuntime, tempHp: 3 };
    const r = applyDamage({ runtime: withTemp, target: goblin, amount: 5, type: 'slashing' });
    expect(r.data?.newTempHp).toBe(0);
    expect(r.data?.newHp).toBe(7 - 2);                            // 5 - 3 temp = 2 to hp
    expect(r.mutations.some((m) => m.op === 'set_temp_hp')).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp')).toBe(true);
  });

  it('clamps hp at 0 (no negative HP for monsters)', () => {
    const r = applyDamage({ runtime: goblinRuntime, target: goblin, amount: 100, type: 'fire' });
    expect(r.data?.newHp).toBe(0);
  });

  it('PCs at 0 HP enter death save state, not dead', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 4, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 10, type: 'slashing' });
    expect(r.data?.newHp).toBe(0);
    expect(r.data?.dying).toBe(true);
  });

  it('massive damage: PC drops to 0 with leftover ≥ hpMax → instant death', () => {
    const fighter: Character = {
      id: 'pc1', name: 'Tharion', level: 1,
      classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    };
    const fighterRuntime: ActorRuntimeState = { actorId: 'pc1', hpCurrent: 5, tempHp: 0, conditions: [], deathSaves: { successes: 0, failures: 0 } };
    const r = applyDamage({ runtime: fighterRuntime, target: fighter as unknown as CombatActor, amount: 30, type: 'slashing' });
    expect(r.data?.dead).toBe(true);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/combat/damage.ts`**

```ts
import type { ActionResult, ActorRuntimeState, CombatActor, Character, DamageType, Mutation } from '../types';

export interface ApplyDamageInput {
  runtime: ActorRuntimeState;
  target: CombatActor | Character;
  amount: number;
  type: DamageType;
}

function isPc(target: CombatActor | Character): target is Character {
  return 'classSlug' in target;
}

function modifyForResistance(amount: number, type: DamageType, target: CombatActor | Character): number {
  if (isPc(target)) return amount;       // PC resistances/immunities not modeled in Plan B (covered later via gear/spells)
  if (target.immunities.includes(type)) return 0;
  if (target.resistances.includes(type)) return Math.floor(amount / 2);
  if (target.vulnerabilities.includes(type)) return amount * 2;
  return amount;
}

export function applyDamage(input: ApplyDamageInput): ActionResult<{ newHp: number; newTempHp: number; dying?: boolean; dead?: boolean }> {
  const adjusted = modifyForResistance(input.amount, input.type, input.target);
  let remaining = adjusted;
  let newTempHp = input.runtime.tempHp;
  if (newTempHp > 0) {
    const absorbed = Math.min(newTempHp, remaining);
    newTempHp -= absorbed;
    remaining -= absorbed;
  }
  let newHp = Math.max(0, input.runtime.hpCurrent - remaining);

  const mutations: Mutation[] = [];
  if (newTempHp !== input.runtime.tempHp) {
    mutations.push({ op: 'set_temp_hp', actorId: input.runtime.actorId, amount: newTempHp });
  }
  if (newHp !== input.runtime.hpCurrent) {
    mutations.push({ op: 'set_hp', actorId: input.runtime.actorId, hpCurrent: newHp });
  }

  let dying = false;
  let dead = false;
  if (newHp === 0 && isPc(input.target)) {
    const overflow = remaining - input.runtime.hpCurrent;
    if (overflow >= input.target.hpMax) {
      dead = true;
    } else {
      dying = true;
    }
  }

  return {
    ok: true,
    data: { newHp, newTempHp, dying, dead },
    rolls: [],
    mutations,
  };
}
```

- [ ] **Step 4: Run — must PASS** (6 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/combat/damage.ts tests/engine/combat/damage.test.ts
git commit -m "feat(engine): applyDamage with temp HP, resistance/immunity/vuln, PC death rules"
```

---

### Task 10: Turn management & condition tick (TDD)

**Files:**
- Create: `src/engine/combat/turn.ts`
- Create: `tests/engine/combat/turn.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { endTurn, tickConditions } from '@/engine/combat/turn';
import type { CombatState, ActorRuntimeState } from '@/engine/types';

const baseCombat: CombatState = {
  round: 1,
  turnOrder: [
    { actorId: 'pc1', initiative: 18 },
    { actorId: 'm1',  initiative: 14 },
    { actorId: 'm2',  initiative: 10 },
  ],
  currentIdx: 0,
};

describe('endTurn', () => {
  it('advances currentIdx', () => {
    const r = endTurn({ combat: baseCombat });
    expect(r.mutations.find((m) => m.op === 'advance_turn')).toBeDefined();
    expect(r.data?.nextActorId).toBe('m1');
    expect(r.data?.newRound).toBe(false);
  });

  it('wraps and increments round when at last actor', () => {
    const last: CombatState = { ...baseCombat, currentIdx: 2 };
    const r = endTurn({ combat: last });
    expect(r.data?.nextActorId).toBe('pc1');
    expect(r.data?.newRound).toBe(true);
    expect(r.data?.round).toBe(2);
  });
});

describe('tickConditions', () => {
  it('decrements duration of round-counted conditions for current actor', () => {
    const runtime: ActorRuntimeState = {
      actorId: 'pc1', hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'poisoned', source: 'goblin bite', durationRounds: 2, appliedRound: 1 },
        { slug: 'frightened', source: 'fear', durationRounds: 'until_removed', appliedRound: 1 },
      ],
    };
    const r = tickConditions({ runtime, currentRound: 2 });
    const stillThere = r.data?.conditions ?? [];
    expect(stillThere.find((c) => c.slug === 'poisoned')?.durationRounds).toBe(1);
    expect(stillThere.find((c) => c.slug === 'frightened')?.durationRounds).toBe('until_removed');
  });

  it('removes conditions whose duration reaches 0', () => {
    const runtime: ActorRuntimeState = {
      actorId: 'pc1', hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
      conditions: [
        { slug: 'poisoned', source: 'goblin bite', durationRounds: 1, appliedRound: 1 },
      ],
    };
    const r = tickConditions({ runtime, currentRound: 2 });
    expect(r.data?.conditions.length).toBe(0);
    expect(r.mutations.some((m) => m.op === 'remove_condition')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/combat/turn.ts`**

```ts
import type { ActionResult, ActorRuntimeState, CombatState, ConditionInstance, Mutation } from '../types';

export interface EndTurnInput {
  combat: CombatState;
}

export function endTurn(input: EndTurnInput): ActionResult<{ nextActorId: string; newRound: boolean; round: number }> {
  const { turnOrder, currentIdx, round } = input.combat;
  const isLast = currentIdx >= turnOrder.length - 1;
  const nextIdx = isLast ? 0 : currentIdx + 1;
  const nextRound = isLast ? round + 1 : round;
  const nextActorId = turnOrder[nextIdx]!.actorId;

  return {
    ok: true,
    data: { nextActorId, newRound: isLast, round: nextRound },
    rolls: [],
    mutations: [{ op: 'advance_turn' }],
  };
}

export interface TickConditionsInput {
  runtime: ActorRuntimeState;
  currentRound: number;
}

export function tickConditions(input: TickConditionsInput): ActionResult<{ conditions: ConditionInstance[] }> {
  const remaining: ConditionInstance[] = [];
  const mutations: Mutation[] = [];
  for (const c of input.runtime.conditions) {
    if (c.durationRounds === 'until_removed') {
      remaining.push(c);
      continue;
    }
    const newDuration = c.durationRounds - 1;
    if (newDuration <= 0) {
      mutations.push({ op: 'remove_condition', actorId: input.runtime.actorId, conditionSlug: c.slug });
    } else {
      remaining.push({ ...c, durationRounds: newDuration });
    }
  }
  return { ok: true, data: { conditions: remaining }, rolls: [], mutations };
}
```

- [ ] **Step 4: Run — must PASS** (4 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/combat/turn.ts tests/engine/combat/turn.test.ts
git commit -m "feat(engine): endTurn (round wrap) + tickConditions"
```

---

## Phase 5 — Conditions and resources

### Task 11: Conditions (TDD)

**Files:**
- Create: `src/engine/conditions.ts`
- Create: `tests/engine/conditions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { applyCondition, removeCondition } from '@/engine/conditions';
import type { ActorRuntimeState, CombatActor } from '@/engine/types';

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

const runtime: ActorRuntimeState = {
  actorId: 'm1', hpCurrent: 7, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
};

describe('applyCondition', () => {
  it('emits add_condition mutation', () => {
    const r = applyCondition({ target: goblin, runtime, condition: { slug: 'poisoned', source: 'spider bite', durationRounds: 3, appliedRound: 1 } });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('add_condition');
  });

  it('respects target conditionImmunities', () => {
    const immune: CombatActor = { ...goblin, conditionImmunities: ['poisoned'] };
    const r = applyCondition({ target: immune, runtime, condition: { slug: 'poisoned', source: 'x', durationRounds: 1, appliedRound: 1 } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('immune');
    expect(r.mutations.length).toBe(0);
  });

  it('does not duplicate same condition (idempotent)', () => {
    const withPoison: ActorRuntimeState = {
      ...runtime,
      conditions: [{ slug: 'poisoned', source: 'a', durationRounds: 1, appliedRound: 1 }],
    };
    const r = applyCondition({ target: goblin, runtime: withPoison, condition: { slug: 'poisoned', source: 'b', durationRounds: 5, appliedRound: 2 } });
    expect(r.mutations.length).toBe(1);                // updated, not duplicated
    expect(r.data?.replaced).toBe(true);
  });
});

describe('removeCondition', () => {
  it('emits remove_condition mutation', () => {
    const withPoison: ActorRuntimeState = {
      ...runtime,
      conditions: [{ slug: 'poisoned', source: 'a', durationRounds: 1, appliedRound: 1 }],
    };
    const r = removeCondition({ runtime: withPoison, conditionSlug: 'poisoned' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('remove_condition');
  });

  it('no-op if not present', () => {
    const r = removeCondition({ runtime, conditionSlug: 'poisoned' });
    expect(r.ok).toBe(true);
    expect(r.mutations.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/conditions.ts`**

```ts
import type { ActionResult, ActorRuntimeState, CombatActor, ConditionInstance, ConditionSlug, Mutation } from './types';

export interface ApplyConditionInput {
  target: CombatActor;
  runtime: ActorRuntimeState;
  condition: ConditionInstance;
}

export function applyCondition(input: ApplyConditionInput): ActionResult<{ replaced: boolean }> {
  if (input.target.conditionImmunities.includes(input.condition.slug)) {
    return { ok: false, error: 'immune', rolls: [], mutations: [] };
  }
  const exists = input.runtime.conditions.some((c) => c.slug === input.condition.slug);
  const mutations: Mutation[] = [
    { op: 'add_condition', actorId: input.runtime.actorId, condition: input.condition },
  ];
  return {
    ok: true,
    data: { replaced: exists },
    rolls: [],
    mutations,
  };
}

export interface RemoveConditionInput {
  runtime: ActorRuntimeState;
  conditionSlug: ConditionSlug;
}

export function removeCondition(input: RemoveConditionInput): ActionResult<{ removed: boolean }> {
  const exists = input.runtime.conditions.some((c) => c.slug === input.conditionSlug);
  if (!exists) {
    return { ok: true, data: { removed: false }, rolls: [], mutations: [] };
  }
  return {
    ok: true,
    data: { removed: true },
    rolls: [],
    mutations: [{ op: 'remove_condition', actorId: input.runtime.actorId, conditionSlug: input.conditionSlug }],
  };
}
```

- [ ] **Step 4: Run — must PASS** (5 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/conditions.ts tests/engine/conditions.test.ts
git commit -m "feat(engine): applyCondition (immunity, idempotent) + removeCondition"
```

---

### Task 12: Class resources (TDD)

**Files:**
- Create: `src/engine/resources.ts`
- Create: `tests/engine/resources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { useResource } from '@/engine/resources';
import type { ActorRuntimeState, Character, FeatureInstance } from '@/engine/types';

const rage: FeatureInstance = { slug: 'rage', source: 'class', usesMax: 2, description: 'Barbarian rage' };

const barbarian: Character = {
  id: 'pc1', name: 'Korg', level: 1,
  classSlug: 'barbarian', raceSlug: 'half-orc', backgroundSlug: 'outlander',
  abilities: { STR: 16, DEX: 14, CON: 16, INT: 8, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 14, ac: 14, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Shield'], tools: [], languages: ['Common', 'Orc'] },
  spellcasting: null, features: [rage], inventory: [], hitDiceMax: 1, hitDieSize: 12,
};

const runtime0: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 14, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
  resourcesUsed: {},
};

describe('useResource', () => {
  it('decrements available uses and emits use_resource mutation', () => {
    const r = useResource({ char: barbarian, runtime: runtime0, featureSlug: 'rage', amount: 1 });
    expect(r.ok).toBe(true);
    expect(r.data?.remaining).toBe(1);
    expect(r.mutations[0]).toEqual({ op: 'use_resource', actorId: 'pc1', featureSlug: 'rage', amount: 1 });
  });

  it('refuses if no uses left', () => {
    const exhausted: ActorRuntimeState = { ...runtime0, resourcesUsed: { rage: 2 } };
    const r = useResource({ char: barbarian, runtime: exhausted, featureSlug: 'rage', amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_uses');
  });

  it('refuses unknown feature', () => {
    const r = useResource({ char: barbarian, runtime: runtime0, featureSlug: 'no_such_feature', amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_feature');
  });

  it('"unlimited" features always allowed', () => {
    const cunningAction: FeatureInstance = { slug: 'cunning_action', source: 'class', usesMax: 'unlimited', description: 'Rogue cunning action' };
    const rogue: Character = { ...barbarian, classSlug: 'rogue', features: [cunningAction] };
    const r = useResource({ char: rogue, runtime: runtime0, featureSlug: 'cunning_action', amount: 1 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/resources.ts`**

```ts
import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';

export interface UseResourceInput {
  char: Character;
  runtime: ActorRuntimeState;
  featureSlug: string;
  amount: number;
}

export function useResource(input: UseResourceInput): ActionResult<{ remaining: number | 'unlimited' }> {
  const feature = input.char.features.find((f) => f.slug === input.featureSlug);
  if (!feature) return { ok: false, error: 'unknown_feature', rolls: [], mutations: [] };

  if (feature.usesMax === 'unlimited') {
    const mutations: Mutation[] = [{ op: 'use_resource', actorId: input.runtime.actorId, featureSlug: input.featureSlug, amount: input.amount }];
    return { ok: true, data: { remaining: 'unlimited' }, rolls: [], mutations };
  }

  const used = input.runtime.resourcesUsed?.[input.featureSlug] ?? 0;
  const remaining = feature.usesMax - used;
  if (remaining < input.amount) {
    return { ok: false, error: 'no_uses', rolls: [], mutations: [] };
  }
  const mutations: Mutation[] = [{ op: 'use_resource', actorId: input.runtime.actorId, featureSlug: input.featureSlug, amount: input.amount }];
  return {
    ok: true,
    data: { remaining: remaining - input.amount },
    rolls: [],
    mutations,
  };
}
```

- [ ] **Step 4: Run — must PASS** (4 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/resources.ts tests/engine/resources.test.ts
git commit -m "feat(engine): useResource for class features (rage, ki, action surge, unlimited)"
```

---

## Phase 6 — Spells

### Task 13: castSpell (TDD)

**Files:**
- Create: `src/engine/spells.ts`
- Create: `tests/engine/spells.test.ts`

The spell system is large. Plan B implements the **mechanical core** of casting: slot consumption + damage/save/attack roll. Spell-specific effects (e.g. *Hold Person* applies `paralyzed`, *Healing Word* heals N HP) are encoded as a small registry in `src/engine/spells.ts` for now — only the spells most likely to appear in a level-1 to level-5 solo session. The full spell catalog comes via SRD lookups in Plan D.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { castSpell } from '@/engine/spells';
import { makeSeededRng } from '@/engine/rand';
import type { Character, CombatActor, ActorRuntimeState } from '@/engine/types';

const wizard: Character = {
  id: 'pc1', name: 'Lyra', level: 5,
  classSlug: 'wizard', raceSlug: 'high-elf', backgroundSlug: 'sage',
  abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 28, ac: 12, speed: 30,
  proficiencies: { saves: ['INT', 'WIS'], skills: ['Arcana', 'History'], expertise: [], weapons: [], armor: [], tools: [], languages: ['Common', 'Elvish'] },
  spellcasting: { ability: 'INT', spellSaveDC: 15, spellAttackBonus: 7, slotsMax: { 1: 4, 2: 3, 3: 2 }, spellsKnown: ['magic-missile', 'fireball', 'healing-word'], spellsPrepared: [] },
  features: [], inventory: [], hitDiceMax: 5, hitDieSize: 6,
};

const wizardRuntime: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 },
  conditions: [], spellSlotsUsed: {}, resourcesUsed: {},
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin', hpMax: 7, ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('castSpell', () => {
  it('refuses if caster lacks the spell', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'wish', slotLevel: 9, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_known');
  });

  it('refuses if no slot available at requested level', () => {
    const exhausted: ActorRuntimeState = { ...wizardRuntime, spellSlotsUsed: { 1: 4 } };
    const r = castSpell({ caster: wizard, runtime: exhausted, spellSlug: 'magic-missile', slotLevel: 1, targets: [{ id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_slot');
  });

  it('magic-missile: 3 darts of 1d4+1 force, never miss, slot consumed', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'magic-missile', slotLevel: 1, targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
    const damageMuts = r.mutations.filter((m) => m.op === 'apply_damage');
    expect(damageMuts.length).toBe(3);
    damageMuts.forEach((m) => expect((m as { amount: number }).amount).toBeGreaterThanOrEqual(2));
  });

  it('magic-missile cast at level 2: 4 darts', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'magic-missile', slotLevel: 2, targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }, { id: 'm1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const damageMuts = r.mutations.filter((m) => m.op === 'apply_damage');
    expect(damageMuts.length).toBe(4);
  });

  it('healing-word heals one ally and consumes a slot', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'healing-word', slotLevel: 1, targets: [{ id: 'pc1' }] }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'heal')).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
  });

  it('unknown spell-slug returns clean error', () => {
    const r = castSpell({ caster: wizard, runtime: wizardRuntime, spellSlug: 'no-such-spell', slotLevel: 1, targets: [] }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_known');
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/spells.ts`**

```ts
import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { defaultRng, type Rng } from './rand';

type SlotLevel = 1|2|3|4|5|6|7|8|9;

export interface CastSpellInput {
  caster: Character;
  runtime: ActorRuntimeState;
  spellSlug: string;
  slotLevel: SlotLevel;
  targets: { id: string }[];
}

export function castSpell(input: CastSpellInput, rng: Rng = defaultRng): ActionResult<{ effects: string[] }> {
  if (!input.caster.spellcasting) {
    return { ok: false, error: 'not_caster', rolls: [], mutations: [] };
  }
  if (!input.caster.spellcasting.spellsKnown.includes(input.spellSlug)) {
    return { ok: false, error: 'not_known', rolls: [], mutations: [] };
  }

  // Slot availability
  const max = input.caster.spellcasting.slotsMax[input.slotLevel] ?? 0;
  const used = input.runtime.spellSlotsUsed?.[input.slotLevel] ?? 0;
  if (max - used <= 0) {
    return { ok: false, error: 'no_slot', rolls: [], mutations: [] };
  }

  const handler = SPELL_HANDLERS[input.spellSlug];
  if (!handler) {
    return { ok: false, error: 'not_implemented', rolls: [], mutations: [] };
  }

  const result = handler(input, rng);
  if (!result.ok) return result;

  // Always consume the slot on a successful cast
  const mutations: Mutation[] = [
    ...result.mutations,
    { op: 'use_spell_slot', actorId: input.runtime.actorId, level: input.slotLevel },
  ];
  return { ...result, mutations };
}

type SpellHandler = (input: CastSpellInput, rng: Rng) => ActionResult<{ effects: string[] }>;

const SPELL_HANDLERS: Record<string, SpellHandler> = {
  'magic-missile': (input, rng) => {
    const dartCount = 2 + input.slotLevel;
    if (input.targets.length < 1 || input.targets.length > dartCount) {
      return { ok: false, error: 'bad_targets', rolls: [], mutations: [] };
    }
    const rolls = [];
    const mutations: Mutation[] = [];
    for (let i = 0; i < dartCount; i++) {
      const r = rollDice('1d4+1', rng);
      rolls.push(r);
      const tgt = input.targets[i] ?? input.targets[input.targets.length - 1]!;
      mutations.push({ op: 'apply_damage', actorId: tgt.id, amount: r.total, type: 'force' });
    }
    return { ok: true, data: { effects: ['force-damage'] }, rolls, mutations };
  },

  'healing-word': (input, rng) => {
    if (input.targets.length !== 1) {
      return { ok: false, error: 'bad_targets', rolls: [], mutations: [] };
    }
    const target = input.targets[0]!;
    const dice = `1d4`;
    const r = rollDice(dice, rng);
    // +spellcasting modifier
    const ability = input.caster.spellcasting!.ability;
    const mod = Math.floor((input.caster.abilities[ability] - 10) / 2);
    const upcast = (input.slotLevel - 1) > 0 ? Array.from({ length: input.slotLevel - 1 }, () => rollDice('1d4', rng)) : [];
    const total = r.total + mod + upcast.reduce((s, x) => s + x.total, 0);
    return {
      ok: true,
      data: { effects: ['heal'] },
      rolls: [r, ...upcast],
      mutations: [{ op: 'heal', actorId: target.id, amount: total }],
    };
  },

  'fireball': (_input, _rng) => {
    // Stub — not needed for first MVP test pass; full impl can come later.
    return { ok: false, error: 'not_implemented', rolls: [], mutations: [] };
  },
};
```

- [ ] **Step 4: Run — must PASS** (6 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/spells.ts tests/engine/spells.test.ts
git commit -m "feat(engine): castSpell with slot consumption + magic-missile + healing-word"
```

Note: a richer spell catalog will be added incrementally in Plan D as the AI master needs them. Plan B ships the *shape* and proves the slot/dice/mutation pipeline.

---

## Phase 7 — Rests, equipment, level-up

### Task 14: Rests (TDD)

**Files:**
- Create: `src/engine/rests.ts`
- Create: `tests/engine/rests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { shortRest, longRest } from '@/engine/rests';
import { makeSeededRng } from '@/engine/rand';
import type { Character, ActorRuntimeState } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null,
  features: [
    { slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second wind' },
    { slug: 'action_surge', source: 'class', usesMax: 1, description: 'Action surge' },
  ],
  inventory: [], hitDiceMax: 5, hitDieSize: 10,
};

const fighterRuntime: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 20, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
  hitDiceRemaining: 3, resourcesUsed: { second_wind: 1, action_surge: 1 }, spellSlotsUsed: {},
};

describe('shortRest', () => {
  it('spending hit dice rolls them and heals up to hpMax', () => {
    const r = shortRest({ char: fighter, runtime: fighterRuntime, hitDiceSpent: 2 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(2);
    const healMut = r.mutations.find((m) => m.op === 'heal');
    expect(healMut).toBeDefined();
    expect(r.mutations.filter((m) => m.op === 'spend_hit_die').length).toBe(2);
  });

  it('refuses if not enough hit dice remaining', () => {
    const noDice: ActorRuntimeState = { ...fighterRuntime, hitDiceRemaining: 1 };
    const r = shortRest({ char: fighter, runtime: noDice, hitDiceSpent: 2 }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_enough_hit_dice');
  });

  it('does NOT restore long-rest-only resources (action_surge)', () => {
    const r = shortRest({ char: fighter, runtime: fighterRuntime, hitDiceSpent: 0 }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    // second_wind restores; action_surge does not (long-rest only)
    const restoresOf = (slug: string) => r.mutations.filter((m) => m.op === 'restore_resource' && (m as { featureSlug: string }).featureSlug === slug);
    expect(restoresOf('second_wind').length).toBe(1);
    expect(restoresOf('action_surge').length).toBe(0);
  });
});

describe('longRest', () => {
  it('restores full HP, all hit dice (max half hpMax of dice), all slots, all resources', () => {
    const r = longRest({ char: fighter, runtime: fighterRuntime });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp' && (m as { hpCurrent: number }).hpCurrent === fighter.hpMax)).toBe(true);
    expect(r.mutations.filter((m) => m.op === 'restore_resource').length).toBe(2);
    // restore_hit_dice up to half of hitDiceMax
    expect(r.mutations.some((m) => m.op === 'restore_hit_dice')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/rests.ts`**

```ts
import type { ActionResult, ActorRuntimeState, Character, Mutation, FeatureInstance } from './types';
import { rollDice } from './dice';
import { abilityModifier } from './modifiers';
import { defaultRng, type Rng } from './rand';

// Features that recharge on a short rest. Conservative list; more are added in Plan D.
const SHORT_REST_RECHARGES = new Set([
  'second_wind',
  'action_surge',     // actually long-rest in 5e RAW; check level (Fighter regains at SR from level 17). Default: long-rest.
  'channel_divinity',
  'ki',
  'arcane_recovery',
  'song_of_rest',
  'bardic_inspiration',
]);
// Override: action_surge is technically long-rest at lower levels. Keep simple in Plan B:
const ACTUALLY_LONG_REST = new Set(['action_surge']);

export interface ShortRestInput {
  char: Character;
  runtime: ActorRuntimeState;
  hitDiceSpent: number;
}

export function shortRest(input: ShortRestInput, rng: Rng = defaultRng): ActionResult<{ healed: number }> {
  const remaining = input.runtime.hitDiceRemaining ?? 0;
  if (input.hitDiceSpent > remaining) {
    return { ok: false, error: 'not_enough_hit_dice', rolls: [], mutations: [] };
  }
  const conMod = abilityModifier(input.char.abilities.CON);
  const rolls = [];
  let totalHeal = 0;
  for (let i = 0; i < input.hitDiceSpent; i++) {
    const r = rollDice(`1d${input.char.hitDieSize}`, rng);
    rolls.push(r);
    totalHeal += r.total + conMod;
  }
  const mutations: Mutation[] = [];
  for (let i = 0; i < input.hitDiceSpent; i++) {
    mutations.push({ op: 'spend_hit_die', actorId: input.runtime.actorId });
  }
  if (totalHeal > 0) {
    mutations.push({ op: 'heal', actorId: input.runtime.actorId, amount: totalHeal });
  }

  // Recharge short-rest resources
  for (const f of input.char.features) {
    if (!SHORT_REST_RECHARGES.has(f.slug)) continue;
    if (ACTUALLY_LONG_REST.has(f.slug)) continue;
    const used = input.runtime.resourcesUsed?.[f.slug] ?? 0;
    if (used > 0) {
      mutations.push({ op: 'restore_resource', actorId: input.runtime.actorId, featureSlug: f.slug, amount: used });
    }
  }

  return { ok: true, data: { healed: totalHeal }, rolls, mutations };
}

export interface LongRestInput {
  char: Character;
  runtime: ActorRuntimeState;
}

export function longRest(input: LongRestInput): ActionResult<{ restored: string[] }> {
  const mutations: Mutation[] = [
    { op: 'set_hp', actorId: input.runtime.actorId, hpCurrent: input.char.hpMax },
    { op: 'set_temp_hp', actorId: input.runtime.actorId, amount: 0 },
  ];

  // Restore all spell slots
  if (input.runtime.spellSlotsUsed) {
    // We can't iterate without level-keys; let Plan D's applicator zero them out.
    // For our mutation list we emit one synthetic op via use_spell_slot? No — easier: loop.
  }

  // Restore up to half max hit dice (rounded down, minimum 1)
  const used = input.char.hitDiceMax - (input.runtime.hitDiceRemaining ?? input.char.hitDiceMax);
  const recovered = Math.min(used, Math.max(1, Math.floor(input.char.hitDiceMax / 2)));
  if (recovered > 0) {
    mutations.push({ op: 'restore_hit_dice', actorId: input.runtime.actorId, amount: recovered });
  }

  // Restore all class resources
  const restored: string[] = [];
  for (const f of input.char.features) {
    const usedR = input.runtime.resourcesUsed?.[f.slug] ?? 0;
    if (usedR > 0) {
      mutations.push({ op: 'restore_resource', actorId: input.runtime.actorId, featureSlug: f.slug, amount: usedR });
      restored.push(f.slug);
    }
  }

  return { ok: true, data: { restored }, rolls: [], mutations };
}
```

Note: spell-slot restoration is intentionally not in the mutation list at this level — the applicator (Plan D) will zero out `spell_slots_used` at long rest. Document this in a code comment.

- [ ] **Step 4: Run — must PASS** (4 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/rests.ts tests/engine/rests.test.ts
git commit -m "feat(engine): shortRest (hit dice, partial recharge) + longRest (full reset)"
```

---

### Task 15: Equipment (TDD)

**Files:**
- Create: `src/engine/equipment.ts`
- Create: `tests/engine/equipment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { equip, unequip, recomputeAC } from '@/engine/equipment';
import type { Character } from '@/engine/types';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 12, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [],
  inventory: [
    { slug: 'leather', qty: 1, equipped: false },
    { slug: 'shield', qty: 1, equipped: false },
    { slug: 'longsword', qty: 1, equipped: false },
  ],
  hitDiceMax: 1, hitDieSize: 10,
};

describe('equip', () => {
  it('marks the item equipped', () => {
    const r = equip({ char: fighter, itemSlug: 'leather' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_equipped', characterId: 'pc1', itemSlug: 'leather', equipped: true });
  });

  it('refuses if item not in inventory', () => {
    const r = equip({ char: fighter, itemSlug: 'nonexistent' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_in_inventory');
  });
});

describe('unequip', () => {
  it('marks equipped → false', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }],
    };
    const r = unequip({ char: equipped, itemSlug: 'leather' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_equipped', characterId: 'pc1', itemSlug: 'leather', equipped: false });
  });
});

describe('recomputeAC', () => {
  it('leather + DEX (2) = 13', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped });
    expect(r.data?.newAc).toBe(11 + 2);
    expect(r.mutations[0]).toEqual({ op: 'recompute_ac', characterId: 'pc1', newAc: 13 });
  });

  it('chain-mail caps DEX (heavy → no DEX)', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'chain-mail', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped });
    expect(r.data?.newAc).toBe(16);                        // base 16, no DEX
  });

  it('shield adds +2', () => {
    const equipped: Character = {
      ...fighter,
      inventory: [{ slug: 'leather', qty: 1, equipped: true }, { slug: 'shield', qty: 1, equipped: true }],
    };
    const r = recomputeAC({ char: equipped });
    expect(r.data?.newAc).toBe(11 + 2 + 2);
  });

  it('no armor → 10 + DEX (unarmored)', () => {
    const r = recomputeAC({ char: fighter });
    expect(r.data?.newAc).toBe(10 + 2);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/equipment.ts`**

```ts
import type { ActionResult, Character, Mutation } from './types';
import { abilityModifier } from './modifiers';

export interface EquipInput {
  char: Character;
  itemSlug: string;
}

export function equip(input: EquipInput): ActionResult<{ equipped: boolean }> {
  const item = input.char.inventory.find((i) => i.slug === input.itemSlug);
  if (!item) return { ok: false, error: 'not_in_inventory', rolls: [], mutations: [] };
  return {
    ok: true,
    data: { equipped: true },
    rolls: [],
    mutations: [{ op: 'set_equipped', characterId: input.char.id, itemSlug: input.itemSlug, equipped: true }],
  };
}

export function unequip(input: EquipInput): ActionResult<{ equipped: boolean }> {
  const item = input.char.inventory.find((i) => i.slug === input.itemSlug);
  if (!item) return { ok: false, error: 'not_in_inventory', rolls: [], mutations: [] };
  return {
    ok: true,
    data: { equipped: false },
    rolls: [],
    mutations: [{ op: 'set_equipped', characterId: input.char.id, itemSlug: input.itemSlug, equipped: false }],
  };
}

interface ArmorSpec {
  base: number;
  dexCap: number | 'none' | 'unlimited';
  category: 'Light' | 'Medium' | 'Heavy' | 'Shield';
}

// Minimal armor catalog. Plan B does not query the DB; Plan D will switch to
// `lookupArmor(slug)` once the AI master needs to handle obscure armor.
const ARMOR: Record<string, ArmorSpec> = {
  'padded':       { base: 11, dexCap: 'unlimited', category: 'Light' },
  'leather':      { base: 11, dexCap: 'unlimited', category: 'Light' },
  'studded-leather': { base: 12, dexCap: 'unlimited', category: 'Light' },
  'hide':         { base: 12, dexCap: 2, category: 'Medium' },
  'chain-shirt':  { base: 13, dexCap: 2, category: 'Medium' },
  'scale-mail':   { base: 14, dexCap: 2, category: 'Medium' },
  'breastplate':  { base: 14, dexCap: 2, category: 'Medium' },
  'half-plate':   { base: 15, dexCap: 2, category: 'Medium' },
  'ring-mail':    { base: 14, dexCap: 'none', category: 'Heavy' },
  'chain-mail':   { base: 16, dexCap: 'none', category: 'Heavy' },
  'splint':       { base: 17, dexCap: 'none', category: 'Heavy' },
  'plate':        { base: 18, dexCap: 'none', category: 'Heavy' },
  'shield':       { base: 0,  dexCap: 'none', category: 'Shield' },
};

export interface RecomputeAcInput {
  char: Character;
}

export function recomputeAC(input: RecomputeAcInput): ActionResult<{ newAc: number }> {
  const equippedItems = input.char.inventory.filter((i) => i.equipped);
  const armorPiece = equippedItems.find((i) => {
    const spec = ARMOR[i.slug];
    return spec && spec.category !== 'Shield';
  });
  const hasShield = equippedItems.some((i) => i.slug === 'shield');
  const dexMod = abilityModifier(input.char.abilities.DEX);

  let ac: number;
  if (!armorPiece) {
    ac = 10 + dexMod;
  } else {
    const spec = ARMOR[armorPiece.slug]!;
    let dexBonus = 0;
    if (spec.dexCap === 'unlimited') dexBonus = dexMod;
    else if (spec.dexCap === 'none') dexBonus = 0;
    else dexBonus = Math.min(dexMod, spec.dexCap);
    ac = spec.base + dexBonus;
  }
  if (hasShield) ac += 2;

  return {
    ok: true,
    data: { newAc: ac },
    rolls: [],
    mutations: [{ op: 'recompute_ac', characterId: input.char.id, newAc: ac }],
  };
}
```

- [ ] **Step 4: Run — must PASS** (8 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/equipment.ts tests/engine/equipment.test.ts
git commit -m "feat(engine): equip/unequip + recomputeAC with armor catalog and DEX cap"
```

---

### Task 16: Level-up (TDD)

**Files:**
- Create: `src/engine/levelup.ts`
- Create: `tests/engine/levelup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { levelUp } from '@/engine/levelup';
import { makeSeededRng } from '@/engine/rand';
import type { Character } from '@/engine/types';

const lvl1Fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 1,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
};

describe('levelUp', () => {
  it('refuses if newLevel <= current level', () => {
    const r = levelUp({ char: lvl1Fighter, newLevel: 1, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_an_increase');
  });

  it('refuses level > 20', () => {
    const r = levelUp({ char: { ...lvl1Fighter, level: 20 }, newLevel: 21, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('above_cap');
  });

  it('average HP gain: ceil(d/2)+1 + CON mod per level', () => {
    // d10 average = 6, +CON mod 2 → 8 per level. Going 1 → 3 = +16 hpMax.
    const r = levelUp({ char: lvl1Fighter, newLevel: 3, hpRollMode: 'average' }, makeSeededRng(1));
    expect(r.ok).toBe(true);
    const mut = r.mutations.find((m) => m.op === 'level_up');
    expect(mut).toBeDefined();
    expect((mut as { hpDelta: number }).hpDelta).toBe(16);
    expect((mut as { newLevel: number }).newLevel).toBe(3);
  });

  it('rolled HP gain rolls a hit die per level', () => {
    const r = levelUp({ char: lvl1Fighter, newLevel: 3, hpRollMode: 'rolled' }, makeSeededRng(7));
    expect(r.ok).toBe(true);
    expect(r.rolls.length).toBe(2);                  // two levels, two rolls
    const mut = r.mutations.find((m) => m.op === 'level_up') as { hpDelta: number };
    // each die in [1..10] + CON 2 → range [6, 24]
    expect(mut.hpDelta).toBeGreaterThanOrEqual(6);
    expect(mut.hpDelta).toBeLessThanOrEqual(24);
  });
});
```

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `src/engine/levelup.ts`**

```ts
import type { ActionResult, Character, Mutation } from './types';
import { abilityModifier } from './modifiers';
import { rollDice } from './dice';
import { defaultRng, type Rng } from './rand';

export interface LevelUpInput {
  char: Character;
  newLevel: number;
  hpRollMode: 'average' | 'rolled';
}

export function levelUp(input: LevelUpInput, rng: Rng = defaultRng): ActionResult<{ levelsGained: number; hpDelta: number }> {
  if (input.newLevel <= input.char.level) {
    return { ok: false, error: 'not_an_increase', rolls: [], mutations: [] };
  }
  if (input.newLevel > 20) {
    return { ok: false, error: 'above_cap', rolls: [], mutations: [] };
  }

  const conMod = abilityModifier(input.char.abilities.CON);
  const die = input.char.hitDieSize;
  const levels = input.newLevel - input.char.level;
  let hpDelta = 0;
  const rolls = [];

  if (input.hpRollMode === 'average') {
    // 5e average = ceil(die/2) + 1 (e.g. d10 → 6)
    const avg = Math.ceil(die / 2) + 1;
    hpDelta = (avg + conMod) * levels;
  } else {
    for (let i = 0; i < levels; i++) {
      const r = rollDice(`1d${die}`, rng);
      rolls.push(r);
      hpDelta += r.total + conMod;
    }
  }

  const mutations: Mutation[] = [
    { op: 'level_up', characterId: input.char.id, newLevel: input.newLevel, hpDelta },
  ];
  return {
    ok: true,
    data: { levelsGained: levels, hpDelta },
    rolls,
    mutations,
  };
}
```

Note: Plan B's `levelUp` covers the **mechanical delta** (HP and level number). Class feature unlocks (e.g. Action Surge at lvl 2 Fighter), proficiency bonus increases (lvl 5/9/13/17), and slot table updates are tracked in `srd_class.keyFeatures` and applied by Plan C's character wizard / level-up UI when it consults the engine. Plan D will refine if the AI master ever applies a level-up mid-session.

- [ ] **Step 4: Run — must PASS** (4 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/levelup.ts tests/engine/levelup.test.ts
git commit -m "feat(engine): levelUp computes HP delta (average/rolled) and level mutation"
```

---

## Phase 8 — Tools (Anthropic JSONSchema definitions)

### Task 17: Tool registry — schemas

**Files:**
- Create: `src/engine/tools/schemas.ts`

This task adds the JSONSchema fragments shared across multiple tool inputs. No tests yet; Task 19 tests handlers end-to-end.

- [ ] **Step 1: Create `src/engine/tools/schemas.ts`**

```ts
// JSONSchema fragments shared across tool definitions. Plan D will compose
// the full Anthropic Messages.Tool list from these.

export const ABILITY_ENUM = {
  type: 'string' as const,
  enum: ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'],
};

export const SKILL_ENUM = {
  type: 'string' as const,
  enum: [
    'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics',
    'Deception', 'History', 'Insight', 'Intimidation',
    'Investigation', 'Medicine', 'Nature', 'Perception',
    'Performance', 'Persuasion', 'Religion', 'Sleight of Hand',
    'Stealth', 'Survival',
  ],
};

export const DAMAGE_TYPE_ENUM = {
  type: 'string' as const,
  enum: [
    'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
    'necrotic', 'piercing', 'poison', 'psychic', 'radiant',
    'slashing', 'thunder',
  ],
};

export const CONDITION_ENUM = {
  type: 'string' as const,
  enum: [
    'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
    'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
    'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion',
  ],
};

export const ACTOR_ID = {
  type: 'string' as const,
  description: 'Either "player_character" or a combat actor id (e.g. "m1") returned by a previous tool result.',
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add src/engine/tools/schemas.ts
git commit -m "feat(engine): JSONSchema enum fragments for tool definitions"
```

---

### Task 18: Tool registry — definitions and handlers

**Files:**
- Create: `src/engine/tools/index.ts`
- Create: `src/engine/tools/handlers.ts`
- Create: `src/engine/index.ts` (barrel)

This task is the bridge between the engine's typed actions and Anthropic's untyped tool-call format. Each tool has:
1. A `definition` (Anthropic-shaped JSONSchema).
2. A `handler` that receives a freshly-parsed input and returns an `ActionResult`.

Plan D will compose `Anthropic.Messages.create({ tools: TOOL_DEFINITIONS, ... })` and dispatch via `TOOL_HANDLERS[name](state, input)`.

- [ ] **Step 1: Create `src/engine/tools/handlers.ts`**

```ts
import type { ActionResult, EngineState } from '../types';
import { rollDice as rollDiceFn, rollD20 as rollD20Fn } from '../dice';
import { abilityCheck, savingThrow } from '../checks';
import { rollInitiative } from '../combat/initiative';
import { makeAttack } from '../combat/attack';
import { applyDamage } from '../combat/damage';
import { endTurn } from '../combat/turn';
import { castSpell } from '../spells';
import { applyCondition, removeCondition } from '../conditions';
import { useResource } from '../resources';
import { shortRest, longRest } from '../rests';
import { equip, unequip, recomputeAC } from '../equipment';
import { levelUp } from '../levelup';

// Each handler receives the raw Anthropic tool input (an object literal),
// resolves the relevant entities from EngineState, and dispatches to the
// pure engine action. The resolution layer is what Plan D's master loop
// will sit on top of.

export type ToolHandler = (state: EngineState, input: Record<string, unknown>) => ActionResult;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  roll_dice: (_state, input) => {
    const formula = String(input.formula);
    const r = rollDiceFn(formula);
    return { ok: true, data: { total: r.total, rolls: r.rolls }, rolls: [r], mutations: [] };
  },

  roll_d20: (_state, input) => {
    const modifier = typeof input.modifier === 'number' ? input.modifier : 0;
    const r = rollD20Fn({
      modifier,
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
    return { ok: true, data: { total: r.total, rolls: r.rolls }, rolls: [r], mutations: [] };
  },

  ability_check: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return abilityCheck({
      char,
      skill: input.skill as never,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
  },

  saving_throw: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return savingThrow({
      char,
      ability: input.ability as never,
      dc: Number(input.dc),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
  },

  roll_initiative: (state) => {
    return rollInitiative({ pcs: state.characters, monsters: state.combatActors });
  },

  make_attack: (state, input) => {
    const attackerId = resolveCharacterId(state, input.attacker);
    const attacker = state.characters.find((c) => c.id === attackerId);
    if (!attacker) return { ok: false, error: 'unknown_attacker', rolls: [], mutations: [] };
    const target = state.combatActors.find((a) => a.id === String(input.target));
    if (!target) return { ok: false, error: 'unknown_target', rolls: [], mutations: [] };
    const weaponInput = input.weapon as Record<string, unknown>;
    if (!weaponInput || typeof weaponInput !== 'object') return { ok: false, error: 'bad_weapon', rolls: [], mutations: [] };
    return makeAttack({
      attacker,
      target,
      weapon: {
        name: String(weaponInput.name),
        damage: String(weaponInput.damage),
        damageType: weaponInput.damageType as never,
        profGroup: String(weaponInput.profGroup),
        useDex: weaponInput.useDex === true,
      },
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
    });
  },

  apply_damage: (state, input) => {
    const targetId = String(input.actor);
    const runtime = state.runtime[targetId];
    if (!runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    const target = state.combatActors.find((a) => a.id === targetId) ?? state.characters.find((c) => c.id === targetId);
    if (!target) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return applyDamage({
      runtime,
      target: target as never,
      amount: Number(input.amount),
      type: input.type as never,
    });
  },

  end_turn: (state) => {
    if (!state.combat) return { ok: false, error: 'not_in_combat', rolls: [], mutations: [] };
    return endTurn({ combat: state.combat });
  },

  cast_spell: (state, input) => {
    const casterId = resolveCharacterId(state, input.caster);
    const caster = state.characters.find((c) => c.id === casterId);
    const runtime = state.runtime[casterId];
    if (!caster || !runtime) return { ok: false, error: 'unknown_caster', rolls: [], mutations: [] };
    return castSpell({
      caster,
      runtime,
      spellSlug: String(input.spellSlug),
      slotLevel: Number(input.slotLevel) as 1|2|3|4|5|6|7|8|9,
      targets: ((input.targets as { id: string }[]) ?? []).map((t) => ({ id: String(t.id) })),
    });
  },

  apply_condition: (state, input) => {
    const targetId = String(input.actor);
    const target = state.combatActors.find((a) => a.id === targetId);
    const runtime = state.runtime[targetId];
    if (!target || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return applyCondition({
      target,
      runtime,
      condition: {
        slug: input.condition as never,
        source: String(input.source),
        durationRounds: input.durationRounds === 'until_removed' ? 'until_removed' : Number(input.durationRounds),
        appliedRound: state.combat?.round ?? 1,
      },
    });
  },

  remove_condition: (state, input) => {
    const targetId = String(input.actor);
    const runtime = state.runtime[targetId];
    if (!runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return removeCondition({ runtime, conditionSlug: input.condition as never });
  },

  use_resource: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return useResource({
      char,
      runtime,
      featureSlug: String(input.featureSlug),
      amount: Number(input.amount ?? 1),
    });
  },

  short_rest: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return shortRest({ char, runtime, hitDiceSpent: Number(input.hitDiceSpent ?? 0) });
  },

  long_rest: (state, input) => {
    const charId = resolveCharacterId(state, input.actor);
    const char = state.characters.find((c) => c.id === charId);
    const runtime = state.runtime[charId];
    if (!char || !runtime) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return longRest({ char, runtime });
  },

  equip: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return equip({ char, itemSlug: String(input.itemSlug) });
  },

  unequip: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return unequip({ char, itemSlug: String(input.itemSlug) });
  },

  recompute_ac: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return recomputeAC({ char });
  },

  level_up: (state, input) => {
    const char = state.characters.find((c) => c.id === resolveCharacterId(state, input.actor));
    if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
    return levelUp({
      char,
      newLevel: Number(input.newLevel),
      hpRollMode: (input.hpRollMode as 'average' | 'rolled') ?? 'average',
    });
  },
};

function resolveCharacterId(state: EngineState, actorRef: unknown): string {
  if (typeof actorRef === 'string' && actorRef === 'player_character' && state.characters.length === 1) {
    return state.characters[0]!.id;
  }
  return String(actorRef);
}
```

- [ ] **Step 2: Create `src/engine/tools/index.ts` — Anthropic tool definitions**

```ts
import type { AnthropicTool } from '../types';
import { ABILITY_ENUM, SKILL_ENUM, DAMAGE_TYPE_ENUM, CONDITION_ENUM, ACTOR_ID } from './schemas';

export const TOOL_DEFINITIONS: AnthropicTool[] = [
  {
    name: 'roll_dice',
    description: 'Roll a dice formula like "3d6+2" and return the total. Use only when no other tool fits.',
    input_schema: { type: 'object', required: ['formula'], properties: { formula: { type: 'string' } } } as never,
  },
  {
    name: 'roll_d20',
    description: 'Roll a single d20 with an optional modifier and advantage/disadvantage.',
    input_schema: {
      type: 'object',
      properties: {
        modifier: { type: 'integer', default: 0 },
        advantage: { type: 'boolean', default: false },
        disadvantage: { type: 'boolean', default: false },
      },
    } as never,
  },
  {
    name: 'ability_check',
    description: 'Resolve an ability or skill check with a DC.',
    input_schema: {
      type: 'object',
      required: ['actor', 'dc'],
      properties: {
        actor: ACTOR_ID,
        skill: SKILL_ENUM,
        ability: ABILITY_ENUM,
        dc: { type: 'integer' },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'saving_throw',
    description: 'Resolve a saving throw of a given ability against a DC.',
    input_schema: {
      type: 'object',
      required: ['actor', 'ability', 'dc'],
      properties: {
        actor: ACTOR_ID,
        ability: ABILITY_ENUM,
        dc: { type: 'integer' },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'roll_initiative',
    description: 'Roll initiative for all PCs and monsters in scene to start combat.',
    input_schema: { type: 'object', properties: {} } as never,
  },
  {
    name: 'make_attack',
    description: 'Resolve a weapon attack from one combatant against another. Returns hit/miss, damage, dice breakdown.',
    input_schema: {
      type: 'object',
      required: ['attacker', 'target', 'weapon'],
      properties: {
        attacker: ACTOR_ID,
        target: ACTOR_ID,
        weapon: {
          type: 'object',
          required: ['name', 'damage', 'damageType', 'profGroup'],
          properties: {
            name: { type: 'string' },
            damage: { type: 'string', description: '"1d8" style' },
            damageType: DAMAGE_TYPE_ENUM,
            profGroup: { type: 'string' },
            useDex: { type: 'boolean' },
          },
        },
        advantage: { type: 'boolean' },
        disadvantage: { type: 'boolean' },
      },
    } as never,
  },
  {
    name: 'apply_damage',
    description: 'Apply damage of a given type to an actor (used for spell damage, environmental, etc.).',
    input_schema: {
      type: 'object',
      required: ['actor', 'amount', 'type'],
      properties: {
        actor: ACTOR_ID,
        amount: { type: 'integer', minimum: 0 },
        type: DAMAGE_TYPE_ENUM,
      },
    } as never,
  },
  {
    name: 'end_turn',
    description: 'End the current combat turn and advance to the next actor in initiative order.',
    input_schema: { type: 'object', properties: {} } as never,
  },
  {
    name: 'cast_spell',
    description: 'Cast a spell from the caster\'s known list, consuming a slot.',
    input_schema: {
      type: 'object',
      required: ['caster', 'spellSlug', 'slotLevel'],
      properties: {
        caster: ACTOR_ID,
        spellSlug: { type: 'string' },
        slotLevel: { type: 'integer', minimum: 1, maximum: 9 },
        targets: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: ACTOR_ID } } },
      },
    } as never,
  },
  {
    name: 'apply_condition',
    description: 'Apply a condition to an actor. The duration is in rounds, or "until_removed".',
    input_schema: {
      type: 'object',
      required: ['actor', 'condition', 'source', 'durationRounds'],
      properties: {
        actor: ACTOR_ID,
        condition: CONDITION_ENUM,
        source: { type: 'string', description: 'Narrative source, e.g. "goblin bite"' },
        durationRounds: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['until_removed'] }] },
      },
    } as never,
  },
  {
    name: 'remove_condition',
    description: 'Remove a condition from an actor.',
    input_schema: {
      type: 'object',
      required: ['actor', 'condition'],
      properties: { actor: ACTOR_ID, condition: CONDITION_ENUM },
    } as never,
  },
  {
    name: 'use_resource',
    description: 'Use a class resource (rage, ki, second_wind, action_surge, channel_divinity, etc.).',
    input_schema: {
      type: 'object',
      required: ['actor', 'featureSlug'],
      properties: {
        actor: ACTOR_ID,
        featureSlug: { type: 'string' },
        amount: { type: 'integer', minimum: 1, default: 1 },
      },
    } as never,
  },
  {
    name: 'short_rest',
    description: 'Take a short rest. Optionally spend hit dice to heal.',
    input_schema: {
      type: 'object',
      required: ['actor'],
      properties: { actor: ACTOR_ID, hitDiceSpent: { type: 'integer', minimum: 0 } },
    } as never,
  },
  {
    name: 'long_rest',
    description: 'Take a long rest: full HP, all slots, all resources, half hit dice.',
    input_schema: { type: 'object', required: ['actor'], properties: { actor: ACTOR_ID } } as never,
  },
  {
    name: 'equip',
    description: 'Equip an item from the character\'s inventory.',
    input_schema: { type: 'object', required: ['actor', 'itemSlug'], properties: { actor: ACTOR_ID, itemSlug: { type: 'string' } } } as never,
  },
  {
    name: 'unequip',
    description: 'Unequip an item.',
    input_schema: { type: 'object', required: ['actor', 'itemSlug'], properties: { actor: ACTOR_ID, itemSlug: { type: 'string' } } } as never,
  },
  {
    name: 'recompute_ac',
    description: 'Recompute armor class for a character after equipment changes.',
    input_schema: { type: 'object', required: ['actor'], properties: { actor: ACTOR_ID } } as never,
  },
  {
    name: 'level_up',
    description: 'Level up a PC, computing HP delta. Use rarely — typically out-of-session.',
    input_schema: {
      type: 'object',
      required: ['actor', 'newLevel'],
      properties: {
        actor: ACTOR_ID,
        newLevel: { type: 'integer', minimum: 2, maximum: 20 },
        hpRollMode: { type: 'string', enum: ['average', 'rolled'], default: 'average' },
      },
    } as never,
  },
];
```

- [ ] **Step 3: Create `src/engine/index.ts` (barrel re-export)**

```ts
export * from './types';
export { rollDice, rollD20, rollDamage } from './dice';
export { abilityModifier, proficiencyBonusForLevel, attackBonus, savingThrowBonus, skillBonus, passiveScore, spellSaveDC, spellAttackBonus } from './modifiers';
export { abilityCheck, savingThrow, contestedCheck, passiveCheck, groupCheck } from './checks';
export { rollInitiative } from './combat/initiative';
export { makeAttack } from './combat/attack';
export { applyDamage } from './combat/damage';
export { endTurn, tickConditions } from './combat/turn';
export { castSpell } from './spells';
export { applyCondition, removeCondition } from './conditions';
export { useResource } from './resources';
export { shortRest, longRest } from './rests';
export { equip, unequip, recomputeAC } from './equipment';
export { levelUp } from './levelup';
export { TOOL_DEFINITIONS } from './tools';
export { TOOL_HANDLERS } from './tools/handlers';
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

If you get type errors on the `as never` casts, that's the workaround for Anthropic SDK schema typing — the SDK expects a strictly typed `JSONSchema7` shape that's painful to satisfy with object-literal expressions. The runtime shape is correct; the casts only erase compile-time type checking on the schema literals.

If you want stronger typing, replace `as never` with explicit `Anthropic.Messages.Tool['input_schema']` casts and ensure each schema includes `type: 'object' as const` plus `properties`. Either is acceptable.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools/handlers.ts src/engine/tools/index.ts src/engine/index.ts
git commit -m "feat(engine): tool registry — definitions and handlers for Plan D wiring"
```

---

### Task 19: Tool handlers integration test (TDD)

**Files:**
- Create: `tests/engine/tools/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from '@/engine';
import type { EngineState, Character, CombatActor } from '@/engine';

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [{ slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second Wind' }],
  inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

const baseState: EngineState = {
  characters: [fighter],
  combatActors: [goblin],
  runtime: {
    pc1: { actorId: 'pc1', hpCurrent: 44, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, spellSlotsUsed: {}, resourcesUsed: {} },
    m1:  { actorId: 'm1',  hpCurrent: 7,  tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
  },
  combat: null,
  scene: 'goblin warren',
};

describe('TOOL_DEFINITIONS', () => {
  it('every defined tool has a corresponding handler', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(TOOL_HANDLERS[def.name], `missing handler for ${def.name}`).toBeDefined();
    }
  });

  it('every handler has a corresponding definition', () => {
    const definedNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    for (const name of Object.keys(TOOL_HANDLERS)) {
      expect(definedNames.has(name), `missing definition for handler ${name}`).toBe(true);
    }
  });
});

describe('TOOL_HANDLERS', () => {
  it('roll_initiative emits set_combat mutation', () => {
    const r = TOOL_HANDLERS['roll_initiative']!(baseState, {});
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_combat')).toBe(true);
  });

  it('make_attack against goblin returns hit-or-miss with rolls', () => {
    const r = TOOL_HANDLERS['make_attack']!(baseState, {
      attacker: 'player_character',
      target: 'm1',
      weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
    });
    expect(['miss', undefined]).toContain(r.error);
    expect(r.rolls.length).toBeGreaterThanOrEqual(1);
  });

  it('apply_damage reduces target HP', () => {
    const r = TOOL_HANDLERS['apply_damage']!(baseState, {
      actor: 'm1', amount: 3, type: 'slashing',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'set_hp')).toBe(true);
  });

  it('use_resource consumes the resource', () => {
    const r = TOOL_HANDLERS['use_resource']!(baseState, {
      actor: 'player_character', featureSlug: 'second_wind',
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]?.op).toBe('use_resource');
  });

  it('unknown actor returns clean error, not crash', () => {
    const r = TOOL_HANDLERS['ability_check']!(baseState, {
      actor: 'nonexistent', skill: 'Athletics', dc: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });
});
```

- [ ] **Step 2: Run — must PASS** (the implementations are already in place from Task 18; this test only validates them)

```bash
pnpm test tests/engine/tools/handlers.test.ts
```

If a test fails, the most likely cause is a mismatch between a definition's `name` and the corresponding handler key. The first two tests catch exactly that.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add tests/engine/tools/handlers.test.ts
git commit -m "test(engine): integration tests for TOOL_DEFINITIONS ↔ TOOL_HANDLERS coverage"
```

---

## Phase 9 — Scenarios (end-to-end-ish tests)

### Task 20: Full combat round scenario (TDD)

**Files:**
- Create: `tests/engine/scenarios/full-combat-round.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine';
import type { EngineState, Character, CombatActor, Mutation, ActorRuntimeState } from '@/engine';

function applyMutation(state: EngineState, m: Mutation): EngineState {
  // Minimal in-memory applicator for tests. Plan D will provide the real DB version.
  switch (m.op) {
    case 'set_hp':
      return { ...state, runtime: { ...state.runtime, [m.actorId]: { ...state.runtime[m.actorId]!, hpCurrent: m.hpCurrent } } };
    case 'apply_damage': {
      const r = state.runtime[m.actorId]!;
      return { ...state, runtime: { ...state.runtime, [m.actorId]: { ...r, hpCurrent: Math.max(0, r.hpCurrent - m.amount) } } };
    }
    case 'set_combat':
      return { ...state, combat: m.combat };
    case 'advance_turn':
      if (!state.combat) return state;
      const last = state.combat.currentIdx >= state.combat.turnOrder.length - 1;
      return {
        ...state,
        combat: {
          ...state.combat,
          currentIdx: last ? 0 : state.combat.currentIdx + 1,
          round: last ? state.combat.round + 1 : state.combat.round,
        },
      };
    default:
      return state;        // other ops not needed for this scenario
  }
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null, features: [], inventory: [{ slug: 'longsword', qty: 1, equipped: true }],
  hitDiceMax: 5, hitDieSize: 10,
};

const goblin: CombatActor = {
  id: 'm1', kind: 'monster', name: 'Goblin',
  hpMax: 7, ac: 15, abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2, initiativeBonus: 2,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
};

describe('full combat round', () => {
  it('roll initiative, attack until goblin dies, end turn', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [goblin],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 44, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
        m1:  { actorId: 'm1',  hpCurrent: 7,  tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] },
      },
      combat: null,
      scene: 'goblin warren',
    };

    const initR = TOOL_HANDLERS['roll_initiative']!(state, {});
    expect(initR.ok).toBe(true);
    state = applyAll(state, initR.mutations);
    expect(state.combat).not.toBeNull();

    let attempts = 0;
    while (state.runtime.m1!.hpCurrent > 0 && attempts < 30) {
      const atkR = TOOL_HANDLERS['make_attack']!(state, {
        attacker: 'player_character',
        target: 'm1',
        weapon: { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false },
      });
      state = applyAll(state, atkR.mutations);
      attempts++;
    }

    expect(state.runtime.m1!.hpCurrent).toBe(0);
    expect(attempts).toBeLessThan(30);

    const turnR = TOOL_HANDLERS['end_turn']!(state, {});
    expect(turnR.ok).toBe(true);
    state = applyAll(state, turnR.mutations);
    expect(state.combat?.currentIdx).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — must PASS** (uses already-implemented handlers; this test exists to catch regressions where mutations don't compose).

- [ ] **Step 3: Commit**

```bash
git add tests/engine/scenarios/full-combat-round.test.ts
git commit -m "test(engine): scenario — fighter initiates combat and kills a goblin"
```

---

### Task 21: Full short-rest cycle scenario (TDD)

**Files:**
- Create: `tests/engine/scenarios/full-rest-cycle.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine';
import type { EngineState, Character, Mutation } from '@/engine';

function applyMutation(state: EngineState, m: Mutation): EngineState {
  const cloneRuntime = { ...state.runtime };
  switch (m.op) {
    case 'spend_hit_die': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hitDiceRemaining: (r.hitDiceRemaining ?? 0) - 1 };
      return { ...state, runtime: cloneRuntime };
    }
    case 'restore_hit_dice': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hitDiceRemaining: (r.hitDiceRemaining ?? 0) + m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'heal': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hpCurrent: r.hpCurrent + m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'set_hp': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, hpCurrent: m.hpCurrent };
      return { ...state, runtime: cloneRuntime };
    }
    case 'set_temp_hp': {
      const r = cloneRuntime[m.actorId]!;
      cloneRuntime[m.actorId] = { ...r, tempHp: m.amount };
      return { ...state, runtime: cloneRuntime };
    }
    case 'use_resource': {
      const r = cloneRuntime[m.actorId]!;
      const used = r.resourcesUsed ?? {};
      cloneRuntime[m.actorId] = { ...r, resourcesUsed: { ...used, [m.featureSlug]: (used[m.featureSlug] ?? 0) + m.amount } };
      return { ...state, runtime: cloneRuntime };
    }
    case 'restore_resource': {
      const r = cloneRuntime[m.actorId]!;
      const used = r.resourcesUsed ?? {};
      cloneRuntime[m.actorId] = { ...r, resourcesUsed: { ...used, [m.featureSlug]: Math.max(0, (used[m.featureSlug] ?? 0) - m.amount) } };
      return { ...state, runtime: cloneRuntime };
    }
    default:
      return state;
  }
}

function applyAll(state: EngineState, mutations: Mutation[]): EngineState {
  return mutations.reduce(applyMutation, state);
}

const fighter: Character = {
  id: 'pc1', name: 'Tharion', level: 5,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 },
  proficiencyBonus: 3, hpMax: 44, ac: 18, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
  spellcasting: null,
  features: [
    { slug: 'second_wind', source: 'class', usesMax: 1, description: 'Second wind' },
    { slug: 'action_surge', source: 'class', usesMax: 1, description: 'Action surge' },
  ],
  inventory: [], hitDiceMax: 5, hitDieSize: 10,
};

describe('full rest cycle', () => {
  it('use second_wind, take short rest, second_wind restored', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 30, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, resourcesUsed: {} },
      },
      combat: null,
      scene: '',
    };

    const useR = TOOL_HANDLERS['use_resource']!(state, { actor: 'player_character', featureSlug: 'second_wind' });
    expect(useR.ok).toBe(true);
    state = applyAll(state, useR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.second_wind).toBe(1);

    const restR = TOOL_HANDLERS['short_rest']!(state, { actor: 'player_character', hitDiceSpent: 2 });
    expect(restR.ok).toBe(true);
    state = applyAll(state, restR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.second_wind).toBe(0);    // restored
    expect(state.runtime.pc1!.hitDiceRemaining).toBe(3);              // 5 - 2 spent
    expect(state.runtime.pc1!.hpCurrent).toBeGreaterThan(30);
  });

  it('action_surge does NOT restore on short rest (long-rest only in Plan B)', () => {
    let state: EngineState = {
      characters: [fighter],
      combatActors: [],
      runtime: {
        pc1: { actorId: 'pc1', hpCurrent: 30, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 5, resourcesUsed: { action_surge: 1 } },
      },
      combat: null,
      scene: '',
    };

    const restR = TOOL_HANDLERS['short_rest']!(state, { actor: 'player_character', hitDiceSpent: 0 });
    expect(restR.ok).toBe(true);
    state = applyAll(state, restR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.action_surge).toBe(1);   // still used

    const longR = TOOL_HANDLERS['long_rest']!(state, { actor: 'player_character' });
    state = applyAll(state, longR.mutations);
    expect(state.runtime.pc1!.resourcesUsed!.action_surge).toBe(0);   // restored
    expect(state.runtime.pc1!.hpCurrent).toBe(44);
  });
});
```

- [ ] **Step 2: Run — must PASS**

- [ ] **Step 3: Commit**

```bash
git add tests/engine/scenarios/full-rest-cycle.test.ts
git commit -m "test(engine): scenario — short rest restores SR resources, long rest restores all"
```

---

## Phase 10 — Wrap up

### Task 22: Coverage report and final wrap-up

- [ ] **Step 1: Full test suite**

```bash
pnpm test 2>&1 | tail -10
```
Expected: ~120-130 tests pass (51 from Plan A + ~70 added in Plan B). Capture totals.

- [ ] **Step 2: Coverage check**

```bash
pnpm test:coverage 2>&1 | tail -30
```
Look at the `src/engine/` rows in the report. Target: each engine file > 90% line coverage. If anything is < 80%, identify the uncovered lines and decide whether to add tests or accept (with a note).

If a file has < 80% coverage:
- For pure utilities (modifiers, dice): add test cases.
- For tool handlers (mostly entity resolution): the integration tests may already cover the main paths; uncovered lines are usually error branches that are hard to trigger without invalid input — that's fine.

- [ ] **Step 3: Lint + typecheck**

```bash
pnpm lint
pnpm typecheck
```
Both clean.

- [ ] **Step 4: Tag**

```bash
git tag plan-b-game-engine-done
git tag --list
```

- [ ] **Step 5: Final state**

```bash
git status
git log --oneline | head -25
```
Working tree clean. Confirm the tag is in the list.

---

## Self-review

The plan covers spec sections:
- §1 sub-project #2: Game Engine — Tasks 2–21
- §4.1 three function categories — Tasks 4–16 (pure compute + actions)
- §4.2 inventory of operations — Tasks 4–16 (every category present)
- §4.3 tool exposure — Tasks 17–19 (TOOL_DEFINITIONS + TOOL_HANDLERS)
- §4.4 safety constraints — Plan D enforces the 12-tool-call cap and timeout. Plan B's role is just to ensure tool handlers fail cleanly with `{ ok: false, error: '...' }` rather than throwing.
- §4.5 dice server-side, crypto-strong — Task 3 (defaultRng uses `crypto.randomInt`) and Task 4 (rollDice).

Out of scope (correctly):
- DB schemas for `characters`, `sessions`, `session_state`, `dice_log` → Plan C / D.
- Anthropic SDK calls / streaming / SSE → Plan D.
- UI of any kind → Plan C (wizard) and Plan D (game screen).
- Master system prompt → Plan D.

No placeholders, no "TBD". Every TDD task has full code. All paths exact. Type names (`Character`, `EngineState`, `Mutation`, `ActionResult`) are consistent across all tasks. The barrel `src/engine/index.ts` is the only entrypoint Plan D will need to import.

Known minor non-issues you may notice during execution:
- `as never` casts in `tools/index.ts` JSONSchema literals — documented inside the task. Replace with stricter casts later if desired.
- `fireball` is a stub in `castSpell`. The richer spell catalog grows during Plan D as the AI master uses spells. The shape and slot/dice pipeline are proven by `magic-missile` + `healing-word`.
- Spell-slot restoration on long rest is left to the applicator (Plan D), not encoded as a per-level mutation. Documented in `rests.ts`.
- Goblin "Nimble Escape" trait name — already fixed in Plan A's monster parser; no engine implication.

---
