# Coverage 90% — Phase 8: Combat Completeness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere i gap residui di combat (Cover, weapon properties, two-weapon fighting) per portare l'area Combat da ~70% a ~90%. Pre-requisito CI: fix tts-cache schema drift.

**Architecture:**
- **Cover** (PHB §3.12): nuovo input `cover?: 'half'|'three-quarters'|'total'` su `make_attack`. Cover modifica AC del target nei calcoli to-hit:
  - half: +2 AC
  - three-quarters: +5 AC
  - total: ok:false 'target_in_total_cover' (impossibile colpire)
  - Stesso bonus si applica a DEX saves (per AoE) — nuovo input opzionale su `saving_throw`.
- **Weapon properties** (PHB §9.4):
  - **Reach**: weapon.properties.includes('reach') → meleeRange diventa 10ft (default 5ft) se non specificato. `make_attack` ricava se è in reach automaticamente.
  - **Loading**: weapon.properties.includes('loading') → only 1 attack per action/bonus/reaction (anche con Extra Attack). Tracked via `turnState.loadingShotUsed: boolean`.
  - **Ammunition**: weapon.properties.includes('ammunition') + `weapon.ammoSlug` → consume 1 ammo per attack. Errors `out_of_ammo` if nothing in inventory.
- **Two-weapon fighting** (PHB §3.15): nuovo flag `offHand?: boolean` su `make_attack`. Quando true:
  - Usa bonus action invece di action
  - No ability mod sul damage (eccetto se negativo)
  - Richiede entrambe le mani con weapon `light` property
  - Solo possibile DOPO un Attack action standard nello stesso turno (verifica `turnState.actionUsed`)

**Tech Stack:** TypeScript strict, Vitest, Drizzle (no migration). Builds on Phase 1-7.

---

## File Structure

### File da creare:
- `src/engine/combat/cover.ts` — pure helpers (coverAcBonus, coverDexSaveBonus, isTotal)
- `src/engine/combat/weapon-properties.ts` — pure helpers (hasProperty, isReach, isLoading, isAmmunition, isLight)
- `tests/engine/combat/cover.test.ts`
- `tests/engine/combat/weapon-properties.test.ts`
- `tests/engine/combat/two-weapon.test.ts`
- `tests/engine/scenarios/combat-completeness-loop.test.ts`

### File da modificare:
- `src/engine/types.ts` — `CoverLevel` type; `WeaponSpec.properties: string[]`, `WeaponSpec.ammoSlug?`, `WeaponSpec.range?: { normal, long }`; mutation `consume_ammo`; `TurnState.loadingShotUsed?: boolean`, `TurnState.offHandAttackUsed?: boolean`
- `src/engine/combat/attack.ts` — accept `cover`, `offHand`; reach via weapon properties; loading enforcement; ammo consumption
- `src/engine/checks.ts` (saving_throw) — accept `cover` for DEX AoE saves
- `src/engine/combat/turn-state.ts` — add canOffHandAttack helper
- `src/engine/tools/handlers.ts` — wire new params through
- `src/engine/tools/index.ts` — schema additions
- `src/sessions/applicator.ts` — handler `consume_ammo`
- `src/ai/master/system-prompt.ts` — guidance section

### Files for CI fix:
- `tests/api/tts-cache.test.ts` — add provider field to test insert (fix schema drift)
- Lint warnings in pre-existing code (left alone or fixed)

---

## Task 0: CI hotfix

### Step 1: Fix tts-cache test
Read `tests/api/tts-cache.test.ts` line 50. Find the insert without `provider`. Add provider: 'openai' (or whatever default the schema expects).

### Step 2: Verify tests pass
```bash
pnpm test tts-cache
```

### Step 3: Commit
```bash
git add tests/api/tts-cache.test.ts
git commit -m "fix(tests): add provider field to tts_cache test insert"
```

---

## Task 1: Cover system (PHB §3.12)

### Step 1: Helpers + types

```ts
// types.ts
export type CoverLevel = 'none' | 'half' | 'three-quarters' | 'total';
```

```ts
// src/engine/combat/cover.ts
import type { CoverLevel } from '../types';

export function coverAcBonus(cover: CoverLevel): number {
  switch (cover) {
    case 'none': return 0;
    case 'half': return 2;
    case 'three-quarters': return 5;
    case 'total': return Infinity;  // never hit
  }
}

export function coverDexSaveBonus(cover: CoverLevel): number {
  // PHB §3.12: same bonuses on DEX saves
  return coverAcBonus(cover);
}

export function isTotalCover(cover: CoverLevel | undefined): boolean {
  return cover === 'total';
}
```

### Step 2: Test

```ts
import { coverAcBonus, coverDexSaveBonus, isTotalCover } from '@/engine/combat/cover';

describe('cover helpers', () => {
  it('none = 0 AC bonus', () => expect(coverAcBonus('none')).toBe(0));
  it('half = +2 AC', () => expect(coverAcBonus('half')).toBe(2));
  it('three-quarters = +5 AC', () => expect(coverAcBonus('three-quarters')).toBe(5));
  it('total = Infinity (cannot hit)', () => expect(coverAcBonus('total')).toBe(Infinity));
  it('coverDexSaveBonus mirrors AC bonus', () => {
    expect(coverDexSaveBonus('half')).toBe(2);
    expect(coverDexSaveBonus('three-quarters')).toBe(5);
  });
  it('isTotalCover detects total only', () => {
    expect(isTotalCover('total')).toBe(true);
    expect(isTotalCover('half')).toBe(false);
    expect(isTotalCover(undefined)).toBe(false);
  });
});
```

### Step 3: Integrate into attack.ts

Add `cover?: CoverLevel` to `MakeAttackInput`. In `makeAttack`:
1. After existing validation, check `if (input.cover === 'total') return { ok: false, error: 'target_in_total_cover', ... }`. NB: action budget should NOT be consumed if total cover.
2. After computing `attackTotal`, modify the AC compare: `effectiveAc = input.target.ac + coverAcBonus(input.cover ?? 'none')`. Use `effectiveAc` in the hit check.

Tests in attack.test.ts: half cover gives target +2 AC; three-quarters +5; total = ok:false with no consume; nat 20 still crits through half/three-quarters but NOT total (PHB: total cover means cannot be targeted at all).

### Step 4: Integrate into saving_throw

Add `cover?: CoverLevel` to `SavingThrowInput`. PHB §3.12 second half: cover gives bonus to DEX saves vs effects originating from the OTHER side of the cover (e.g., fireball through a doorway). Apply only if `input.ability === 'DEX'`.

In savingThrow: `modifier += coverDexSaveBonus(input.cover ?? 'none')` when ability is DEX.

Tests: DEX save with half cover gets +2; STR save unaffected by cover.

### Step 5: Tool schema

Update `make_attack` and `saving_throw` schemas with optional `cover` enum. System prompt note.

### Step 6: Commit
`feat(combat): cover system (PHB §3.12) — half/three-quarters/total + DEX save bonus`.

---

## Task 2: Weapon properties enforcement

### Step 1: Types

```ts
// types.ts (modify WeaponSpec)
export interface WeaponSpec {
  name: string;
  damage: string;
  damageType: DamageType;
  profGroup: string;
  useDex: boolean;
  /** PHB §9.4 properties: 'finesse'|'heavy'|'light'|'loading'|'reach'|'thrown'|'two-handed'|'versatile'|'ammunition'|... */
  properties?: string[];
  /** Inventory slug of the ammunition consumed per attack (for 'ammunition' property). */
  ammoSlug?: string;
  /** Range bands for ranged/thrown weapons. */
  range?: { normal: number; long: number };
}

// TurnState (add):
loadingShotUsed?: boolean;
offHandAttackUsed?: boolean;

// Mutation:
| { op: 'consume_ammo'; characterId: string; ammoSlug: string; qty: number }
```

### Step 2: Helpers

```ts
// src/engine/combat/weapon-properties.ts
import type { WeaponSpec } from '../types';

export function hasProperty(weapon: WeaponSpec, prop: string): boolean {
  return weapon.properties?.includes(prop) ?? false;
}

export function isReach(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'reach');
}

export function isLoading(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'loading');
}

export function isAmmunition(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'ammunition');
}

export function isLight(weapon: WeaponSpec): boolean {
  return hasProperty(weapon, 'light');
}

export function meleeReachFor(weapon: WeaponSpec): number {
  return isReach(weapon) ? 10 : 5;
}
```

### Step 3: Tests

```ts
describe('weapon-properties', () => {
  const longsword: WeaponSpec = { name: 'Longsword', damage: '1d8', damageType: 'slashing', profGroup: 'Martial', useDex: false, properties: ['versatile'] };
  const halberd: WeaponSpec = { ...longsword, properties: ['heavy', 'reach', 'two-handed'] };
  const lightCrossbow: WeaponSpec = { name: 'Light Crossbow', damage: '1d8', damageType: 'piercing', profGroup: 'Simple', useDex: true, properties: ['ammunition', 'loading', 'two-handed'], ammoSlug: 'crossbow-bolt' };
  const dagger: WeaponSpec = { ...longsword, name: 'Dagger', damage: '1d4', properties: ['finesse', 'light', 'thrown'] };

  it('isReach detects reach property', () => {
    expect(isReach(longsword)).toBe(false);
    expect(isReach(halberd)).toBe(true);
  });
  it('meleeReachFor returns 10 for reach, 5 otherwise', () => {
    expect(meleeReachFor(longsword)).toBe(5);
    expect(meleeReachFor(halberd)).toBe(10);
  });
  it('isLoading detects loading property', () => {
    expect(isLoading(lightCrossbow)).toBe(true);
    expect(isLoading(longsword)).toBe(false);
  });
  it('isLight detects light property', () => {
    expect(isLight(dagger)).toBe(true);
    expect(isLight(longsword)).toBe(false);
  });
  it('isAmmunition + ammoSlug', () => {
    expect(isAmmunition(lightCrossbow)).toBe(true);
    expect(lightCrossbow.ammoSlug).toBe('crossbow-bolt');
  });
});
```

### Step 4: Integrate into attack.ts

#### Reach
Replace the existing `meleeWithin5 = isMelee && (input.meleeRange ?? 5) <= 5`. Now:
```ts
const reach = meleeReachFor(input.weapon);
const within5ft = isMelee && (input.meleeRange ?? reach) <= 5;
const withinReach = isMelee && (input.meleeRange ?? reach) <= reach;
```

If `withinReach === false` for melee → return `ok: false, error: 'out_of_reach'` (no consume).

The 5ft-only effects (auto-crit on paralyzed, prone melee ADV) keep using `within5ft`.

#### Loading
Before the action budget check:
```ts
if (isLoading(input.weapon) && input.attackerRuntime?.turnState?.loadingShotUsed && !input.useReaction) {
  return { ok: false, error: 'loading_shot_already_used', ... };
}
```

After successful attack (in all return paths), if `isLoading(weapon)`, append a mutation that sets `loadingShotUsed: true`. Need a new mutation op `set_loading_shot_used` OR fold into `consume_action` semantics. Simpler: emit `set_loading_shot` boolean op.

Actually cleaner: extend `consume_action` mutation with optional `setLoading?: boolean`. NB: simpler still — add a new mutation `mark_loading_shot` that sets `turnState.loadingShotUsed = true`. The applicator handles it.

On `start_turn` (already resets turnState to fresh), loadingShotUsed naturally resets to false.

#### Ammunition
Before resolving the attack:
```ts
if (isAmmunition(input.weapon)) {
  const ammoSlug = input.weapon.ammoSlug;
  if (!ammoSlug) return { ok: false, error: 'weapon_missing_ammoSlug', ... };
  const inventory = input.attacker.inventory ?? [];
  const ammoItem = inventory.find((i) => i.slug === ammoSlug);
  if (!ammoItem || ammoItem.qty < 1) return { ok: false, error: 'out_of_ammo', ... };
}
```
On hit/miss/crit (any successful resolution), append `consume_ammo` mutation.

The applicator's `consume_ammo` handler decrements the inventory item by 1.

### Step 5: Tests

attack.test.ts new describe blocks:
- 'reach property': halberd at 10ft melee succeeds; out of reach returns out_of_reach
- 'loading property': second attack with loading weapon errors loading_shot_already_used
- 'ammunition property': missing ammo errors out_of_ammo; successful attack emits consume_ammo

### Step 6: Commit
`feat(combat): weapon properties enforcement (reach, loading, ammunition)`.

---

## Task 3: Two-weapon fighting (PHB §3.15)

### Step 1: Types

```ts
// MakeAttackInput (add):
/** PHB §3.15: this is the off-hand attack of two-weapon fighting. Consumes a bonus action.
 *  Requires: actor used Attack action this turn, both weapons have 'light' property. */
offHand?: boolean;
```

### Step 2: Logic

In `makeAttack`:
1. If `input.offHand`:
   - Check `input.attacker.actionUsed` — must be true (already used Attack action).
   - Check weapon has `light` property → if not, return `error: 'offhand_requires_light_weapon'`.
   - Check turnState.bonusUsed → if true, return `error: 'bonus_already_used'`.
   - Check turnState.offHandAttackUsed → if true, return `error: 'offhand_already_used'`.
   - On hit, damage roll does NOT add ability modifier (PHB: "you don't add your ability modifier to the damage of the bonus attack, unless that modifier is negative"). EXCEPT: if mod is negative, do add (PHB exception).
   - Emit `consume_action` with `kind: 'bonus'` instead of action.
   - Emit `mark_offhand_attack` mutation (sets offHandAttackUsed = true).

### Step 3: Tests

```ts
describe('makeAttack — two-weapon fighting (PHB §3.15)', () => {
  it('offHand:true requires light weapon', () => {
    const fighter = pcAttacker();
    const longsword = { ...sword, properties: [] };  // not light
    const r = makeAttack({ attacker: fighter, attackerRuntime: rt(fighter, { actionUsed: true }), target, targetRuntime: rt(target), weapon: longsword, offHand: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offhand_requires_light_weapon');
  });

  it('offHand:true on light weapon consumes bonus action, not action', () => {
    const fighter = pcAttacker();
    const dagger = { ...sword, properties: ['light', 'finesse'] };
    const r = makeAttack({ attacker: fighter, attackerRuntime: rt(fighter, { actionUsed: true }), target, targetRuntime: rt(target), weapon: dagger, offHand: true });
    expect(r.ok).toBe(true);
    const consume = r.mutations.find((m) => m.op === 'consume_action');
    expect(consume).toMatchObject({ kind: 'bonus' });
  });

  it('offHand without prior Attack action errors', () => {
    const fighter = pcAttacker();
    const dagger = { ...sword, properties: ['light'] };
    const r = makeAttack({ attacker: fighter, attackerRuntime: rt(fighter, { actionUsed: false }), target, targetRuntime: rt(target), weapon: dagger, offHand: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offhand_requires_attack_action');
  });

  it('offHand damage does NOT add ability mod (when positive)', () => {
    // STR 16 (mod +3); damage formula should be just '1d4', not '1d4+3'
    // Check that the damageRoll formula doesn't include the modifier
  });

  it('offHand damage DOES add ability mod when negative', () => {
    // STR 8 (mod -1); damage should be '1d4-1' (the exception)
  });

  it('offHand with bonus already used errors', () => {
    const fighter = pcAttacker();
    const dagger = { ...sword, properties: ['light'] };
    const r = makeAttack({ attacker: fighter, attackerRuntime: rt(fighter, { actionUsed: true, bonusUsed: true }), target, targetRuntime: rt(target), weapon: dagger, offHand: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bonus_already_used');
  });
});
```

### Step 4: Commit
`feat(combat): two-weapon fighting (PHB §3.15) — offHand flag with bonus action + light weapon check`.

---

## Task 4: Applicator + system prompt + E2E + smoke

### Step 1: Applicator handlers

Add 3 new mutations:
- `mark_loading_shot`: sets turnState.loadingShotUsed = true.
- `mark_offhand_attack`: sets turnState.offHandAttackUsed = true.
- `consume_ammo`: decrements inventory[ammoSlug].qty by 1 (or removes if 0). PC-only.

Tests in applicator test file. Use the same pattern as Phase 3 turnState handlers.

### Step 2: System prompt

Add new section in MASTER_TOOL_CONTRACT:

```
### Cover & Weapon Properties (PHB §3.12, §9.4)

**Cover** (PHB §3.12): when a target is partially obscured, pass `cover` to make_attack:
- `'half'`: +2 AC (low wall, large furniture, narrow tree, creature in the way)
- `'three-quarters'`: +5 AC (portcullis, arrow slit, thick tree)
- `'total'`: cannot be targeted; tool errors `target_in_total_cover` (no consumption).

The same bonus applies to DEX saves vs AoE through cover — pass `cover` to saving_throw when ability='DEX'.

**Weapon properties** (PHB §9.4):
- `reach`: melee reach is 10ft instead of 5ft. The engine reads this from
  weapon.properties.includes('reach'). Out of reach → `out_of_reach` error.
- `loading`: only one shot per action/bonus/reaction (PHB §3.15). The engine
  blocks subsequent calls with `loading_shot_already_used` until next turn.
- `ammunition`: each attack consumes 1 of weapon.ammoSlug from inventory.
  Out of ammo → `out_of_ammo`. Recovery is narrative (PHB: half on 1-min search).

**Two-Weapon Fighting** (PHB §3.15): when the PC has light weapons in both
hands, after the Attack action they can use a bonus action to attack with
the off-hand. Pass `offHand: true` to make_attack. Engine validates:
- weapon must have `light` property
- attacker must have used Attack action this turn (actionUsed=true)
- bonus and offhand-attack must not have been used yet

Off-hand damage does NOT add ability modifier (PHB exception: negative
modifiers do apply).

---

Italiano: Phase 8 aggiunge cover (+2/+5/total), weapon properties (reach/loading/ammunition),
e two-weapon fighting (offHand:true → bonus action, no mod sul danno se positivo).
```

### Step 3: E2E scenarios

Create `tests/engine/scenarios/combat-completeness-loop.test.ts`:
1. PC attacks goblin behind half cover → +2 AC; same total roll might miss.
2. PC attacks behind total cover → ok:false 'target_in_total_cover', no action consumed.
3. Halberd PC attacks at 10ft → ok; same attack at 15ft → 'out_of_reach'.
4. Crossbow attack consumes 1 bolt → inventory bolts -1; second attack same turn → 'loading_shot_already_used'.
5. PC takes Attack action (longsword), then offHand dagger (bonus) → both succeed; second offHand same turn → 'offhand_already_used'.
6. Fireball DEX save through half cover → modifier +2.

### Step 4: Final smoke + push

```bash
pnpm test
pnpm typecheck
git push -u origin feat/combat-completeness
```

Commit final tweaks if needed.

---

## Self-review checklist

- [ ] Coverage delta: Combat 70% → ~90%.
- [ ] Backward compat: cover/offHand/properties opzionali.
- [ ] Total cover errors WITHOUT consuming action.
- [ ] Loading/offhand flags reset on start_turn (already guaranteed by newTurnState).
- [ ] Ammo consume_ammo applies before crit/dmg (so we don't consume on out_of_ammo error).

---

## Stima sforzo Phase 8

- Task 0 (CI hotfix): 30min
- Task 1 (Cover): 1.5h
- Task 2 (Weapon properties): 2.5h
- Task 3 (Two-weapon): 1.5h
- Task 4 (E2E + prompt + push): 1h

**Totale: ~7h** developer; subagent-driven: ~1 giornata.
