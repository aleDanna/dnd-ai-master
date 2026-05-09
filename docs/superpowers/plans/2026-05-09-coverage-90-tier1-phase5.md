# Coverage 90% — Tier 1 Phase 5: Magic Item Rarity + Attunement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sblocca +6 punti coverage portando "Equipment & Magic Items" da 52% a ~80%. Quattro pezzi:
1. Magic item rarity tiers (common → artifact) con sale price reference
2. Item categories (armor/weapons/wondrous/potions/scrolls/rings/rods/staves/wands)
3. Attunement system (max 3 attuned items per PC, 1h short rest, prerequisites validation)
4. Cursed/Sentient flags (basic markers, narrative responsibility)

**Architecture:**
- **Codex schema**: `codex_entities` (kind='named_item') gains JSONB metadata fields: `rarity`, `category`, `attunement_required`, `attunement_prereq` (free-text or struct), `cursed`, `sentient`. PHB §10 rarity values: `common, uncommon, rare, very_rare, legendary, artifact`. Sale prices reference values (informational, not enforced).
- **Character.attunedItems**: `string[]` of item slugs. Max 3 (PHB §10.1). Tracked on `characters` table.
- **Tools**: `attune({ character, itemSlug })` validates cap and prerequisites; `unattune({ character, itemSlug })` removes from list.
- **Snapshot**: shows "Attuned: 2/3 (item1, item2)".

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration). Builds on Phase 1-4.

---

## File Structure

### File da creare:
- `src/engine/items.ts` — pure helpers (rarity tiers, sale price reference, validation)
- `tests/engine/items.test.ts`
- `tests/engine/scenarios/attunement-loop.test.ts`
- `drizzle/0015_*.sql`

### File da modificare:
- `src/engine/types.ts` — `Rarity`, `ItemCategory` types; `Character.attunedItems: string[]`; mutations `attune` / `unattune` / `set_item_meta`
- `src/db/schema/characters.ts` — colonna `attuned_items` jsonb default `[]`
- `src/db/schema/codex-entities.ts` — colonne `rarity`, `category`, `attunement_required`, `attunement_prereq`, `cursed`, `sentient` (tutti su `properties` jsonb se possibile, OR colonne separate)
- `src/sessions/applicator.ts` — handler per `attune` / `unattune`
- `src/sessions/snapshot.ts` — hydrate attunedItems + item meta
- `src/engine/tools/handlers.ts` — `attune` / `unattune` handlers
- `src/engine/tools/index.ts` — schema dei nuovi tool
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Types + helpers + tests

```ts
// types.ts
export type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';
export type ItemCategory = 'armor' | 'weapon' | 'wondrous' | 'potion' | 'scroll' | 'ring' | 'rod' | 'staff' | 'wand';

export interface ItemMeta {
  rarity?: Rarity;
  category?: ItemCategory;
  attunementRequired?: boolean;
  attunementPrereq?: string;  // narrative/textual: e.g. "wizard or sorcerer"
  cursed?: boolean;
  sentient?: boolean;
}

export interface Character {
  // ...existing
  attunedItems?: string[];  // slugs of items currently attuned (max 3)
}

// Mutations:
| { op: 'attune'; characterId: string; itemSlug: string }
| { op: 'unattune'; characterId: string; itemSlug: string }
```

```ts
// src/engine/items.ts
import type { Rarity } from './types';

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'very_rare', 'legendary', 'artifact'];

export function rarityTier(r: Rarity): number {
  return RARITY_ORDER.indexOf(r);
}

export function rarityComparedTo(a: Rarity, b: Rarity): -1 | 0 | 1 {
  const ai = rarityTier(a), bi = rarityTier(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export function rarityRefSalePrice(r: Rarity): number {
  // PHB §10.1 (informational; actual prices vary by table/economy)
  switch (r) {
    case 'common': return 100;
    case 'uncommon': return 400;
    case 'rare': return 4_000;
    case 'very_rare': return 40_000;
    case 'legendary': return 200_000;
    case 'artifact': return -1;  // priceless / unique
  }
}

export const MAX_ATTUNED = 3;
```

Tests: rarity ordering, sale price lookup, MAX_ATTUNED constant.

Commit: `feat(items): rarity types + sale price reference + helpers`.

---

## Task 2: Schema + applicator + snapshot

### Step 1: Schema

```ts
// src/db/schema/characters.ts
attunedItems: jsonb('attuned_items').$type<string[]>().notNull().default([]),

// src/db/schema/codex-entities.ts (or wherever named_items live)
// Either add separate columns OR add to a properties jsonb. For simplicity, separate columns:
rarity: varchar('rarity', { length: 16 }),  // nullable
category: varchar('category', { length: 16 }),
attunementRequired: boolean('attunement_required').notNull().default(false),
attunementPrereq: text('attunement_prereq'),  // nullable
cursed: boolean('cursed').notNull().default(false),
sentient: boolean('sentient').notNull().default(false),
```

### Step 2: Migration

```bash
pnpm db:generate
pnpm db:migrate
```

### Step 3: Applicator handlers

```ts
case 'attune': {
  // Read current attunedItems list
  const [c] = await tx.select({ attunedItems: charactersTable.attunedItems })
    .from(charactersTable).where(eq(charactersTable.id, m.characterId));
  if (!c) break;
  if (c.attunedItems.includes(m.itemSlug)) break;  // already attuned, no-op
  await tx.update(charactersTable)
    .set({ attunedItems: [...c.attunedItems, m.itemSlug] })
    .where(eq(charactersTable.id, m.characterId));
  break;
}

case 'unattune': {
  const [c] = await tx.select({ attunedItems: charactersTable.attunedItems })
    .from(charactersTable).where(eq(charactersTable.id, m.characterId));
  if (!c) break;
  const next = c.attunedItems.filter((s) => s !== m.itemSlug);
  await tx.update(charactersTable)
    .set({ attunedItems: next })
    .where(eq(charactersTable.id, m.characterId));
  break;
}
```

### Step 4: Snapshot hydration

In `src/sessions/snapshot.ts`, hydrate `character.attunedItems = row.attunedItems ?? []`.

### Step 5: Tests

3 applicator tests: attune adds, attune already-present is no-op, unattune removes.

Commit: `feat(applicator): attune/unattune handlers + migration 0015 (rarity, category, attunement on codex)`.

---

## Task 3: attune/unattune tools

### Step 1: Handlers

```ts
import { MAX_ATTUNED } from '../items';

export async function handleAttune(
  ctx: ToolCtx, state: EngineState,
  input: { character: string; itemSlug: string },
): Promise<ActionResult<{ attuned: boolean; reason?: string }>> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  const currentAttuned = char.attunedItems ?? [];
  
  // Already attuned → no-op
  if (currentAttuned.includes(input.itemSlug)) {
    return { ok: true, data: { attuned: false, reason: 'already_attuned' }, rolls: [], mutations: [] };
  }
  
  // Cap check (PHB §10.1: max 3)
  if (currentAttuned.length >= MAX_ATTUNED) {
    return { ok: false, error: 'attunement_cap_reached', rolls: [], mutations: [] };
  }
  
  // Verify item is in the inventory (must possess to attune)
  const hasItem = char.inventory.some((i) => i.slug === input.itemSlug);
  if (!hasItem) {
    return { ok: false, error: 'item_not_in_inventory', rolls: [], mutations: [] };
  }
  
  // OPTIONAL: lookup item meta from codex/SRD to verify attunement is supported
  // and prerequisites match. For Phase 5, leave the prerequisites enforcement
  // as a Master decision (narrative); the engine just gates by cap + ownership.
  
  return {
    ok: true, data: { attuned: true },
    rolls: [],
    mutations: [{ op: 'attune', characterId: char.id, itemSlug: input.itemSlug }],
  };
}

export async function handleUnattune(
  ctx: ToolCtx, state: EngineState,
  input: { character: string; itemSlug: string },
): Promise<ActionResult<{ unattuned: boolean }>> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  const currentAttuned = char.attunedItems ?? [];
  if (!currentAttuned.includes(input.itemSlug)) {
    return { ok: true, data: { unattuned: false }, rolls: [], mutations: [] };
  }
  
  return {
    ok: true, data: { unattuned: true },
    rolls: [],
    mutations: [{ op: 'unattune', characterId: char.id, itemSlug: input.itemSlug }],
  };
}
```

### Step 2: Tool definitions

```ts
{
  name: 'attune',
  description: 'PHB §10.1: attune to a magic item. The PC must possess the item. Max 3 attuned items per PC. The attunement bond is established during a 1-hour short rest (narrative — the engine just tracks the slug). Returns attunement_cap_reached or item_not_in_inventory on errors. The Master is responsible for verifying the item has attunementRequired=true and any prerequisites are met.',
  input_schema: {
    type: 'object',
    properties: {
      character: { type: 'string' },
      itemSlug: { type: 'string', description: 'Inventory slug of the item being attuned' },
    },
    required: ['character', 'itemSlug'],
  },
},
{
  name: 'unattune',
  description: 'Break an attunement. The PC may unattune voluntarily (as a long rest action) or by losing the item.',
  input_schema: {
    type: 'object',
    properties: {
      character: { type: 'string' },
      itemSlug: { type: 'string' },
    },
    required: ['character', 'itemSlug'],
  },
},
```

### Step 3: Tests

`tests/engine/tools/attunement.test.ts`:
- attune happy path (returns mutation, attuned: true)
- already attuned (no-op)
- attunement_cap_reached (3 already attuned)
- item_not_in_inventory (PC doesn't have the item)
- unattune happy path
- unattune item not attuned (no-op)

Commit: `feat(tools): attune and unattune tools (PHB §10.1)`.

---

## Task 4: System prompt

Add new section in MASTER_TOOL_CONTRACT:

```
### Magic Items: Rarity & Attunement (PHB §10.1)

**Rarities**: common (~100 gp), uncommon (~400), rare (~4k), very rare (~40k),
legendary (~200k), artifact (priceless / unique).

**Categories**: armor, weapon, wondrous, potion, scroll, ring, rod, staff, wand.

**Attunement**: many items require a 1-hour bonding (during a short rest) where
the PC becomes mystically linked to the item. A creature can attune to AT MOST
**3 items** at once.

To grant attunement, narrate the bonding ritual (e.g., "stringi l'anello e senti
un calore familiare diffondersi nel braccio") and call `attune({ character, itemSlug })`.
The engine validates: max 3, item must be in inventory.

To break attunement (long rest, item lost, voluntary), call `unattune`.

**Prerequisites**: some items require the PC to be a specific class/race or to
have a minimum ability score. The engine doesn't validate these — YOU enforce
them narratively before calling `attune`.

**Cursed items**: marked with `cursed: true` in the codex. Attunement to a
cursed item is hard to break (Remove Curse spell or specific quest required).
The engine doesn't enforce; you narrate the curse's effect.

**Sentient items**: marked with `sentient: true`. They have alignment, language,
and goals. Use them sparingly for narrative weight.

**Snapshot field**: `character.attunedItems: string[]` shows the current list.
The Master's UI shows "Attuned: N/3 (item1, item2, ...)".

---

Italiano: Rarità e attunement con cap di 3 oggetti per PG. Chiama `attune` dopo
aver narrato il rituale (1h short rest). I prerequisiti sono responsabilità
narrativa del Master.
```

Commit: `docs(prompt): document magic item rarity, categories, attunement (PHB §10.1)`.

---

## Task 5: E2E + smoke

E2E `tests/engine/scenarios/attunement-loop.test.ts`:
1. PC attunes 3 items → 4th attune errors `attunement_cap_reached`.
2. PC unattunes one → can attune another.
3. PC tries to attune item not in inventory → `item_not_in_inventory`.
4. Multiple PCs can each have 3 attuned items.

Smoke `pnpm test`, `pnpm typecheck`. Commit if minor tweaks.

---

## Self-review checklist

- [ ] Coverage delta: Equipment area 52% → ~80%.
- [ ] Backward compat: Phase 1-4 tests still green; attunedItems opzionale.
- [ ] Idempotency: attune già attuned → ok: true, attuned: false (no-op).
- [ ] Cap correctness: exactly 3 max.
- [ ] PHB §10.1: 1h short rest is narrative, not engine-enforced.

---

## Stima sforzo Phase 5

- Task 1 (types + helpers): 1h
- Task 2 (schema + applicator + migration): 2h
- Task 3 (tools): 1.5h
- Task 4 (system prompt): 30min
- Task 5 (E2E + smoke): 1h

**Totale: ~6h** developer; subagent-driven: ~1 giornata.
