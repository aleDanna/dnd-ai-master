# Phase 11: Class Features (Sneak Attack, Rage, Action Surge, Channel Divinity, Bardic Inspiration, Lay on Hands)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare engine helpers + tool per le 6 class features più impattanti del PHB. Ognuna con resource tracking (uses-per-rest) + effect resolution. Sblocca ~5 punti coverage portando "Class Features" da 30% a ~75%.

**Architecture:**

Le features già hanno tracking in `Character.features` (slug + usesMax) e `runtime.resourcesUsed` (uso corrente). Mancano gli **engine helpers** che le risolvono e i **tool** che l'AI Master invoca.

Le 6 features:

| Feature | Class | Mechanic | Tool |
|---|---|---|---|
| **Sneak Attack** | Rogue | +Nd6 damage on attack with ADV (or ally adjacent) | `apply_sneak_attack` extra-damage handler |
| **Rage** | Barbarian | Bonus action; +damage, resistance to bludg/pierc/slash; advantage on STR checks/saves; lasts 10 rounds; uses-per-day | `start_rage` / `end_rage` |
| **Action Surge** | Fighter | One additional action this turn; uses-per-short-rest | `use_action_surge` (resets actionUsed flag) |
| **Channel Divinity** | Cleric/Paladin | Various effects (Turn Undead, Sacred Weapon, etc.); uses-per-short-rest | `use_channel_divinity({ effect })` (generic) |
| **Bardic Inspiration** | Bard | Bonus action; gives ally a die (d6/d8/d10/d12 by level); uses-per-short-rest at L5+ | `grant_bardic_inspiration({ targetId, dieSize })` + condition tracking |
| **Lay on Hands** | Paladin | Pool of HP (5×level); spend N to heal; cure poison costs 5 | `use_lay_on_hands({ targetId, points, curePoison })` |

**Tech Stack:** TypeScript strict, Vitest, Drizzle (no schema changes — uses existing `resourcesUsed` + `features`). Builds on Phase 1-10.

---

## File Structure

### File da creare:
- `src/engine/class-features.ts` — pure helpers (sneakAttackDice, ragePerLevel, bardicInspirationDie, layOnHandsPool)
- `tests/engine/class-features.test.ts`
- `tests/engine/scenarios/class-features-loop.test.ts`

### File da modificare:
- `src/engine/types.ts` — extend ConditionSlug with 'raging', 'bardic_inspired', 'sacred_weapon', 'channel_divinity_used'; mutations `use_class_feature`, `restore_class_feature`
- `src/engine/condition-effects.ts` — applier for 'raging' (advantage on STR checks/saves); 'bardic_inspired' (no-op)
- `src/engine/combat/attack.ts` — Sneak Attack triggers + Rage damage bonus when raging
- `src/sessions/applicator.ts` — handlers for new mutations
- `src/engine/tools/handlers.ts` — 6 new handlers
- `src/engine/tools/index.ts` — schema
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Helpers + types

```ts
// src/engine/class-features.ts

/** PHB Rogue: Sneak Attack damage = ceil(level / 2) d6. */
export function sneakAttackDice(rogueLevel: number): number {
  return Math.ceil(rogueLevel / 2);
}

/** PHB Barbarian: rage damage bonus by level. */
export function rageDamageBonus(barbLevel: number): number {
  if (barbLevel >= 16) return 4;
  if (barbLevel >= 9) return 3;
  return 2;  // L1-8
}

/** PHB Barbarian: rage uses per long rest. */
export function rageUsesPerDay(barbLevel: number): number {
  if (barbLevel >= 17) return Infinity;  // unlimited
  if (barbLevel >= 12) return 5;
  if (barbLevel >= 6) return 4;
  if (barbLevel >= 3) return 3;
  return 2;
}

/** PHB Fighter: Action Surge uses per short/long rest. */
export function actionSurgeUses(fighterLevel: number): number {
  if (fighterLevel >= 17) return 2;
  return fighterLevel >= 2 ? 1 : 0;
}

/** PHB Cleric/Paladin: Channel Divinity uses per short rest (cleric) or long rest (paladin). */
export function channelDivinityUses(level: number, classSlug: 'cleric' | 'paladin'): number {
  if (classSlug === 'cleric') {
    if (level >= 18) return 3;
    if (level >= 6) return 2;
    return level >= 2 ? 1 : 0;
  }
  // paladin: 1 use, recharges on short rest at L3+
  return level >= 3 ? 1 : 0;
}

/** PHB Bard: Bardic Inspiration die size. */
export function bardicInspirationDie(bardLevel: number): 6 | 8 | 10 | 12 {
  if (bardLevel >= 15) return 12;
  if (bardLevel >= 10) return 10;
  if (bardLevel >= 5) return 8;
  return 6;
}

/** PHB Bard: Bardic Inspiration uses per short/long rest. */
export function bardicInspirationUses(bardLevel: number, chaMod: number): number {
  // Uses per long rest = max(1, CHA mod). At L5+ recharges on short rest.
  return Math.max(1, chaMod);
}

/** PHB Paladin: Lay on Hands pool = 5 × paladin level. */
export function layOnHandsPool(paladinLevel: number): number {
  return paladinLevel * 5;
}
```

Tests covering each helper at multiple level breakpoints.

Commit: `feat(class-features): helpers for Sneak Attack, Rage, Action Surge, Channel Divinity, Bardic Inspiration, Lay on Hands`.

---

## Task 2: Conditions + types

In `types.ts`, extend `ConditionSlug`:
```ts
| 'raging' | 'bardic_inspired' | 'sacred_weapon' | 'channel_divinity_used'
```

(existing slugs preserved.)

In `condition-effects.ts`, add appliers:
```ts
raging: (f) => {
  // PHB Barbarian Rage: advantage on STR checks/saves; resistance to bludgeoning/piercing/slashing.
  // We model the ADV via a 'rageActive' flag the engine consults.
  // Resistance handled in damage handler when target has 'raging' condition.
  // For simplicity: just set a marker; specific behaviors gated by feature flags in attack/checks.
  // If we want STR ADV automatically, we'd hook checks.ts; doing so would over-apply (rage ADV is on STR checks/saves only, not all).
  // We mark the condition but the Master/engine decides per-roll.
},
bardic_inspired: () => {
  // No automatic effect — the recipient consumes the die manually.
},
sacred_weapon: () => {
  // Buff: no automatic engine effect (Master applies +CHA mod to attack rolls when relevant).
},
channel_divinity_used: () => {
  // Marker, no automatic effect.
},
```

Mutations:
```ts
| { op: 'use_class_feature'; actorId: string; featureSlug: string; uses?: number }
| { op: 'restore_class_feature'; actorId: string; featureSlug: string; uses?: number }
| { op: 'modify_lay_on_hands_pool'; actorId: string; delta: number }
```

Applicator handlers for these. The `use_class_feature` increments resourcesUsed[featureSlug] by `uses ?? 1`. The `modify_lay_on_hands_pool` modifies a runtime field (or uses a feature with uses).

Commit: `feat(applicator): class feature use/restore mutations`.

---

## Task 3: Tools

### use_class_feature (generic)

Pure handler. Validates feature exists in character + has uses remaining. Emits `use_class_feature` mutation.

```ts
{
  name: 'use_class_feature',
  description: 'Generic class feature consumption. Validates the feature exists and has uses remaining; emits a use_class_feature mutation. For specific features (rage, lay on hands) prefer the dedicated tools below.',
  input_schema: { ..., properties: { actor, featureSlug, uses?: number } },
}
```

### start_rage

Validates: actor is barbarian, has rage feature with uses remaining. Emits use_class_feature(rage) + add_condition(raging, durationRounds=10).

### end_rage

Removes raging condition (manual end before duration ends).

### use_action_surge

Validates: actor is fighter L2+, has action_surge feature with uses remaining. Emits use_class_feature(action_surge) + a special mutation `restore_action_for_action_surge` that resets `turnState.actionUsed = false`.

### use_channel_divinity

Validates: actor is cleric/paladin, has channel_divinity feature, uses remaining. Accepts an `effect` string (turn_undead, sacred_weapon, etc.) — narrative; engine just consumes the use.

### grant_bardic_inspiration

Validates: actor is bard, has bardic_inspiration feature, uses remaining. Target gets `bardic_inspired` condition with metadata about the die size.

### use_lay_on_hands

Validates: actor is paladin L1+, has lay_on_hands feature with sufficient pool. Validates `points` (≤ pool remaining) or `curePoison: true` (costs 5 from pool). Emits heal mutation on target + modify_lay_on_hands_pool.

Tests for each.

Commit: `feat(tools): 6 class feature tools (rage, action_surge, channel_divinity, bardic_inspiration, lay_on_hands, use_class_feature)`.

---

## Task 4: Combat integration

### Sneak Attack in make_attack

When the attacker is a rogue with sneak_attack feature, optionally pass `useSneakAttack: true`. Validates:
- One use per turn (track via `turnState.sneakAttackUsed?: boolean`)
- Either: attack has ADV, OR attack has DIS (NO — DIS prevents Sneak Attack!), OR ally adjacent to target (master-determined via input flag)
- Weapon must be finesse or ranged

On hit: roll extra `sneakAttackDice(rogueLevel)d6` damage. Append to damage roll.

```ts
useSneakAttack?: boolean;
```

### Rage damage bonus

When attacker has 'raging' condition AND uses melee weapon with STR for damage: add `rageDamageBonus(barbLevel)` to damage.

This is already implementable via condition check in damage formula. Add a check in the damage section.

### Rage resistance

When target has 'raging' condition AND damage type is bludgeoning/piercing/slashing: half damage (resistance).

This is independent of the existing resistance/vulnerability/immunity arrays — extend `applyDamageModifiers` to also check rage.

Tests in attack.test.ts.

Commit: `feat(combat): Sneak Attack + Rage bonus/resistance integration`.

---

## Task 5: System prompt

```
### Class Features (PHB classes)

The engine implements 6 key class features as dedicated tools. The Master
calls them when the PC uses the feature; the engine validates uses-remaining,
applies effects, and emits the right mutations.

**Sneak Attack (Rogue)**: pass `useSneakAttack: true` to make_attack. Engine
checks: attack has ADV (or no DIS) AND weapon is finesse/ranged. On hit, adds
ceil(rogueLevel/2)d6 damage. Once per turn.

**Rage (Barbarian)**: call `start_rage({ actor })`. Sets 'raging' condition
(10 rounds), gives advantage on STR checks/saves (apply via input.advantage
when relevant), +rage_damage_bonus on melee STR weapon damage, resistance to
bludgeoning/piercing/slashing. Call `end_rage` to manually end early. Uses
per long rest by level (2 → unlimited at L17).

**Action Surge (Fighter)**: call `use_action_surge({ actor })`. Resets
`turnState.actionUsed` so the fighter can take another action this turn.
1 use at L2, 2 uses at L17. Recharges on short rest.

**Channel Divinity (Cleric/Paladin)**: call `use_channel_divinity({ actor, effect })`.
Consumes 1 use; effect is a narrative string (turn_undead, sacred_weapon,
divine_sense, etc.). Cleric: short-rest recharge; Paladin: long-rest L3-X,
short-rest L11+.

**Bardic Inspiration (Bard)**: call `grant_bardic_inspiration({ actor, target, dieSize })`.
Target gets 'bardic_inspired' condition with metadata. They can spend the die
to add to a d20 roll within 10 minutes. Bonus action.

**Lay on Hands (Paladin)**: call `use_lay_on_hands({ actor, target, points?,
curePoison? })`. Pool = 5 × paladin level. Spend points to heal that many HP;
spend 5 to cure poison; or both. Pool resets on long rest.

---

Italiano: Phase 11 aggiunge 6 class features come tool dedicati con resource tracking.
```

Commit: `docs(prompt): document 6 class features (Phase 11)`.

---

## Task 6: E2E + smoke

`tests/engine/scenarios/class-features-loop.test.ts`:
1. Rogue L5 makes attack with ADV + useSneakAttack:true → +3d6 damage.
2. Same rogue tries 2nd Sneak Attack same turn → fails (one per turn).
3. Barbarian L5 starts rage → 'raging' condition added, use consumed.
4. Raging barbarian melee with longsword → +2 rage damage on hit.
5. Fighter L5 uses Action Surge → actionUsed reset to false.
6. Paladin L5 uses Lay on Hands 10 points on ally → ally healed +10, pool -10 (pool was 25, now 15).
7. Bard L5 grants bardic inspiration to ally → ally gets bardic_inspired condition.

Smoke + commit.

---

## Stima sforzo

- Task 1 (helpers): 1.5h
- Task 2 (conditions + applicator): 2h
- Task 3 (6 tools): 2.5h
- Task 4 (combat integration): 1.5h
- Task 5 (system prompt): 30min
- Task 6 (E2E): 1h

**Totale: ~9h** developer; subagent-driven: ~1.5 giornate.
