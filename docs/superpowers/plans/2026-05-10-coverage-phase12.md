# Phase 12: Magic Item Creation + Crafting + Downtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Implementare downtime activities + magic item crafting + scroll/potion creation. PHB §6 (downtime) + DMG crafting rules. Sblocca ~3 punti coverage.

**Architecture:**

Tre macro-aree:
1. **Crafting items** (PHB §5: "crafting") — non-magical items dal book equipment_gear: tempo = price × 5 sp/day, ingredient cost = half list price.
2. **Magic item crafting** (DMG): tempo + costo per rarity. Common: 4 days, 50 gp. Uncommon: 20 days, 200 gp. Rare: 100 days, 2000 gp. Very Rare: 500 days, 20000 gp. Legendary: 2500 days, 100000 gp.
3. **Scroll/potion crafting**: scroll cost ~2× spell level price; brewing potions per Healer's Kit / alchemy.

**Tools**:
- `start_crafting({ character, recipeSlug, kind: 'item'|'magic_item'|'scroll'|'potion' })` — initiates a crafting project; tracks days remaining + gp spent.
- `progress_crafting({ character, projectId, daysSpent })` — advance the project.
- `complete_crafting({ character, projectId })` — when days reach 0, completes; emits add_item.
- `cancel_crafting({ character, projectId })` — abandon (no refund).

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: crafting_projects on characters or session-state). Builds on Phase 1-11.

---

## File Structure

### File da creare:
- `src/engine/crafting.ts` — pure helpers (craftingDaysFor, craftingCostFor, scrollCost, potionCost)
- `tests/engine/crafting.test.ts`
- `tests/engine/scenarios/crafting-loop.test.ts`
- `drizzle/0020_*.sql`

### File da modificare:
- `src/engine/types.ts` — `CraftingKind`, `CraftingProject` interface; mutations `start_crafting`, `progress_crafting`, `complete_crafting`, `cancel_crafting`; Character.craftingProjects
- `src/db/schema/characters.ts` — colonna `crafting_projects` jsonb
- `src/sessions/applicator.ts` — handlers per le 4 mutations
- `src/sessions/snapshot.ts` — hydrate craftingProjects
- `src/engine/tools/handlers.ts` — 4 new handlers
- `src/engine/tools/index.ts` — schema
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Pure helpers + types

```ts
// types.ts
export type CraftingKind = 'item' | 'magic_item' | 'scroll' | 'potion';

export interface CraftingProject {
  id: string;          // unique per character
  recipeSlug: string;  // e.g. 'longsword' or 'potion-of-healing'
  kind: CraftingKind;
  daysRemaining: number;
  gpSpent: number;
  startedRound?: number;  // narrative bookkeeping
}

// Character (extend):
craftingProjects?: CraftingProject[];

// Mutations:
| { op: 'start_crafting'; characterId: string; project: CraftingProject }
| { op: 'progress_crafting'; characterId: string; projectId: string; daysSpent: number }
| { op: 'complete_crafting'; characterId: string; projectId: string }
| { op: 'cancel_crafting'; characterId: string; projectId: string }
```

```ts
// src/engine/crafting.ts
import type { CraftingKind } from './types';

export interface CraftingRequirements {
  daysRequired: number;
  gpRequired: number;
}

/** PHB §5: non-magical crafting. Item with price P gp requires P × 5 sp/day, cost = P/2. */
export function nonMagicalCraftingRequirements(itemPriceGp: number): CraftingRequirements {
  // Days = ceil(price_in_sp / 5sp_per_day) = ceil(price_gp * 10 / 5) = ceil(2 * price)
  const daysRequired = Math.max(1, Math.ceil(itemPriceGp * 2));
  const gpRequired = Math.ceil(itemPriceGp / 2);
  return { daysRequired, gpRequired };
}

/** DMG: magic item crafting per rarity. */
export function magicItemCraftingRequirements(rarity: 'common'|'uncommon'|'rare'|'very_rare'|'legendary'): CraftingRequirements {
  switch (rarity) {
    case 'common':    return { daysRequired: 4,    gpRequired: 50 };
    case 'uncommon':  return { daysRequired: 20,   gpRequired: 200 };
    case 'rare':      return { daysRequired: 100,  gpRequired: 2_000 };
    case 'very_rare': return { daysRequired: 500,  gpRequired: 20_000 };
    case 'legendary': return { daysRequired: 2500, gpRequired: 100_000 };
  }
}

/** PHB §11 Wizard / scroll crafting. Days = 2 × spell level. Cost = spell level² × 25 gp + 25 gp basic. */
export function scrollCraftingRequirements(spellLevel: 0|1|2|3|4|5|6|7|8|9): CraftingRequirements {
  if (spellLevel === 0) return { daysRequired: 1, gpRequired: 15 };  // cantrip scroll
  return {
    daysRequired: Math.max(2, 2 * spellLevel),
    gpRequired: spellLevel * spellLevel * 25 + 25,
  };
}

/** Healer's Kit / alchemy brewing of healing potion. Common potion = 4 days + 50 gp (matches DMG common magic item). */
export function potionCraftingRequirements(spellLevel: 0|1|2|3|4|5|6|7|8|9): CraftingRequirements {
  // Treat potion as common magic item up to L1 spells; uncommon for L2-3, rare for L4+
  if (spellLevel <= 1) return magicItemCraftingRequirements('common');
  if (spellLevel <= 3) return magicItemCraftingRequirements('uncommon');
  if (spellLevel <= 5) return magicItemCraftingRequirements('rare');
  return magicItemCraftingRequirements('very_rare');
}
```

Tests covering each helper.

Commit: `feat(crafting): pure helpers for crafting requirements (PHB §5, DMG)`.

---

## Task 2: Schema + applicator

Add `characters.crafting_projects` jsonb default `[]`.

Generate migration `drizzle/0020_*.sql`, apply.

Snapshot hydrates `character.craftingProjects = row.craftingProjects ?? []`.

Applicator handlers (4):
- `start_crafting`: append to array
- `progress_crafting`: decrement project.daysRemaining by `daysSpent` (clamp at 0)
- `complete_crafting`: validate daysRemaining === 0, remove project from array, emit add_item via the recipe slug as item slug
- `cancel_crafting`: remove project from array (no refund)

Tests in applicator.test.ts.

Commit: `feat(applicator): crafting project mutations + migration 0020`.

---

## Task 3: Tools

Handlers:
- `handleStartCrafting(character, recipeSlug, kind, customDays?, customGp?)` — looks up requirements based on kind + recipeSlug (or accepts overrides), validates character has enough gp (assume not — narrative handles), generates project ID, emits start_crafting
- `handleProgressCrafting(character, projectId, daysSpent)` — emits progress_crafting
- `handleCompleteCrafting(character, projectId)` — validates project exists + days remaining = 0, emits complete_crafting (which adds item)
- `handleCancelCrafting(character, projectId)` — emits cancel_crafting

Tool definitions in `src/engine/tools/index.ts`. Register in TOOL_HANDLERS.

Tests for each. ~15 tests.

Commit: `feat(tools): start_crafting, progress_crafting, complete_crafting, cancel_crafting`.

---

## Task 4: System prompt

```
### Magic Item Creation & Crafting (PHB §5, DMG crafting rules)

The PC can craft items, magic items, scrolls, and potions during downtime.
The engine tracks projects on `character.craftingProjects`.

**Tools**:
- `start_crafting({ character, recipeSlug, kind })` — kind: 'item' | 'magic_item' | 'scroll' | 'potion'
- `progress_crafting({ character, projectId, daysSpent })` — advance project
- `complete_crafting({ character, projectId })` — when daysRemaining=0, completes + adds item
- `cancel_crafting({ character, projectId })` — abandon (no refund)

**Days/GP requirements**:
| Kind | Days | GP cost |
|---|---|---|
| Non-magical item @ price P gp | ceil(P × 2) | ceil(P / 2) |
| Common magic item | 4 | 50 |
| Uncommon magic item | 20 | 200 |
| Rare magic item | 100 | 2,000 |
| Very rare magic item | 500 | 20,000 |
| Legendary magic item | 2500 | 100,000 |
| Spell scroll @ level N (1-9) | max(2, 2N) | 25N² + 25 |
| Cantrip scroll | 1 | 15 |
| Potion @ spell level N | matches magic item rarity (≤1=common, 2-3=uncommon, 4-5=rare, 6+=very rare) | |

The Master narrates the crafting process. Multi-day projects can be advanced
in chunks via `progress_crafting`.

---

Italiano: Phase 12 aggiunge il sistema di crafting. La PG può creare oggetti
non magici, item magici, pergamene, e pozioni durante downtime.
```

Commit.

---

## Task 5: E2E

`tests/engine/scenarios/crafting-loop.test.ts`:
1. Start non-magical longsword crafting (price 15 gp) → 30 days, 7 gp.
2. Progress 10 days → 20 days remaining.
3. Progress 20 more days → 0 days remaining.
4. Complete crafting → longsword added to inventory.
5. Start uncommon magic item crafting → 20 days, 200 gp.
6. Cancel partway through → project removed, no item added.
7. Start scroll crafting (L3 spell) → 6 days, 250 gp.

Smoke + commit.

---

## Stima sforzo Phase 12

- Task 1 (helpers): 1.5h
- Task 2 (schema + applicator): 1.5h
- Task 3 (4 tools): 2h
- Task 4 (prompt): 30min
- Task 5 (E2E): 1h

**Totale: ~6.5h** developer; subagent: ~1 giornata.
