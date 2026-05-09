# Narrative items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `add_narrative_item` master tool so flavor items the master narrates (notes, mementos, strange amulets) appear in the player's inventory tagged `(narrativo)` instead of vanishing.

**Architecture:** New DB-backed tool handler that creates a `named_item` codex entry with `magical: false` and emits an `add_inventory` mutation. The `state-sse` route is extended to ship an `enrichedInventory: MasterInventoryView[]` view alongside the raw inventory, and the left-pane `CharacterPane` reads it to render the real name + `(narrativo)` suffix when the item is a non-magical named item. No DB schema migration.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM (Postgres), Vitest (+ `@testing-library/react`), Anthropic SDK tool-use schemas.

**Spec:** `docs/superpowers/specs/2026-05-09-narrative-items-design.md`

---

## File Map

| File | Status | Purpose |
| --- | --- | --- |
| `src/engine/tools/add-narrative-item.ts` | **new** | DbToolHandler: validate name, slugify, codex upsert, emit `add_inventory`. |
| `src/engine/tools/handlers.ts` | modify | Register `add_narrative_item` in `TOOL_HANDLERS_DB`. |
| `src/engine/tools/index.ts` | modify | Add JSON schema entry exposing the tool to the master. |
| `src/srd/enrich-inventory.ts` | modify (small) | Extract `InventoryItemKind` union so `MasterInventoryView` is importable client-side without pulling Drizzle row types. |
| `src/lib/inventory.ts` | modify | Add `formatInventoryDisplay(slug, enriched?)` pure formatter returning `{ label, isNarrative }`. |
| `src/components/game/character-pane.tsx` | modify | `InventorySection` accepts an optional `enriched` map and threads it into `InventoryRow`, which renders `(narrativo)` suffix. |
| `src/app/(authed)/sessions/[id]/game-client.tsx` | modify | Read and merge the new `enrichedInventory` field from SSE patches into a separate React state. |
| `src/app/api/sessions/[id]/state/route.ts` | modify | Compute `enrichedInventory` via `enrichInventoryItems` + `formatEnrichedForMaster`, ship it inside the `snapshot` event. |
| `src/ai/master/system-prompt.ts` | modify | Add the `add_narrative_item` line in `MASTER_TOOL_CONTRACT` immediately after `add_item`. |
| `tests/engine/tools/add-narrative-item.test.ts` | **new** | TDD coverage for the new handler (codex insert, dedupe, validation, FK setup via real session). |
| `tests/lib/inventory.test.ts` | **new** | TDD for the pure `formatInventoryDisplay` formatter. |
| `tests/components/game/inventory-section.test.tsx` | **new** | Render test: `(narrativo)` suffix appears for non-magical named items. |

---

## Task 1: Test scaffold for `addNarrativeItem` handler

**Files:**
- Test: `tests/engine/tools/add-narrative-item.test.ts` (new)

This task writes the failing tests. Implementation follows in Task 2.

The handler talks to the real Postgres DB (same pattern as `tests/engine/tools/add-item-db.test.ts` and `tests/sessions/memory/patch.test.ts`). Because `codex_entities.session_id` has a FK to `sessions.id`, the test must create a real session in `beforeAll` and clean it up in `afterAll`.

- [ ] **Step 1.1: Write the failing test file**

```ts
// tests/engine/tools/add-narrative-item.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, codexEntities } from '@/db/schema';
import { addNarrativeItem } from '@/engine/tools/add-narrative-item';
import type { Character, EngineState } from '@/engine/types';

const TEST_USER = 'user_narrative_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';
let pc: Character;
let state: EngineState;

beforeAll(async () => {
  await ensureUser(TEST_USER);
  const w = emptyWizardState();
  w.raceSlug = 'human';
  w.classSlug = 'fighter';
  w.backgroundSlug = 'soldier';
  w.identity.name = 'P';
  const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
  CHAR_ID = charId;
  const [s] = await db
    .insert(sessions)
    .values({ userId: TEST_USER, characterId: charId, premise: 'narrative-items-test' })
    .returning();
  SESSION_ID = s!.id;
  await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });

  pc = {
    id: CHAR_ID, name: 'P', level: 1, xp: 0,
    classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
    abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    proficiencyBonus: 2, hpMax: 10, ac: 10, speed: 30,
    proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, features: [], inventory: [],
    hitDiceMax: 1, hitDieSize: 10,
  };
  state = {
    characters: [pc],
    combatActors: [],
    runtime: { [CHAR_ID]: { actorId: CHAR_ID, hpCurrent: 10, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] } },
    combat: null,
    scene: 'tavern',
  };
});

afterAll(async () => {
  await db.execute(sql`delete from codex_entities where session_id = ${SESSION_ID}`);
  await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
  await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
  await db.execute(sql`delete from users where id = ${TEST_USER}`);
  await pool.end();
});

const ctx = () => ({ sessionId: SESSION_ID, state });

describe('addNarrativeItem', () => {
  it('inserts a new named_item with magical:false and emits add_inventory', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Strano amuleto di osso', description: 'Un amuleto antico.', qty: 1 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({
      op: 'add_inventory',
      characterId: CHAR_ID,
      itemSlug: 'strano-amuleto-di-osso',
      qty: 1,
    });
    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'strano-amuleto-di-osso')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('named_item');
    expect(rows[0]!.name).toBe('Strano amuleto di osso');
    expect((rows[0]!.data as { magical: boolean }).magical).toBe(false);
    expect((rows[0]!.data as { description: string }).description).toBe('Un amuleto antico.');
  });

  it('reuses an existing codex row when slug already present (no second insert)', async () => {
    await addNarrativeItem(ctx(), { name: 'Lettera cifrata' });
    const r2 = await addNarrativeItem(ctx(), { name: 'Lettera cifrata', description: 'whatever' });
    expect(r2.ok).toBe(true);
    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'lettera-cifrata')));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as { description: string }).description).toBe('');
  });

  it('rejects empty name with invalid_name', async () => {
    const r = await addNarrativeItem(ctx(), { name: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
    expect(r.mutations).toHaveLength(0);
  });

  it('rejects name longer than 80 chars with invalid_name', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'a'.repeat(81) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
  });

  it('rejects punctuation-only name with invalid_name (slugify produces empty)', async () => {
    const r = await addNarrativeItem(ctx(), { name: '!!!' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_name');
  });

  it('truncates description to 120 chars', async () => {
    const longDesc = 'x'.repeat(200);
    await addNarrativeItem(ctx(), { name: 'Anello con sigillo', description: longDesc });
    const [row] = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'anello-con-sigillo')));
    expect((row!.data as { description: string }).description).toHaveLength(120);
  });

  it('clamps qty to integer >= 1', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Penna piuma', qty: 0 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toMatchObject({ qty: 1 });

    const r2 = await addNarrativeItem(ctx(), { name: 'Penna piuma', qty: 3.7 });
    expect(r2.mutations[0]).toMatchObject({ qty: 3 });
  });

  it('rejects unknown actor when no PC in state', async () => {
    const emptyState: EngineState = { ...state, characters: [] };
    const r = await addNarrativeItem({ sessionId: SESSION_ID, state: emptyState }, { name: 'Boccale di ferro' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_actor');
  });

  it('returns slug, name, qty, kind in data on success', async () => {
    const r = await addNarrativeItem(ctx(), { name: 'Mappa stracciata', qty: 2 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      slug: 'mappa-stracciata',
      name: 'Mappa stracciata',
      qty: 2,
      kind: 'named_item',
    });
  });
});
```

- [ ] **Step 1.2: Run the file to confirm it fails on import**

Run: `pnpm test tests/engine/tools/add-narrative-item.test.ts`

Expected: All tests fail at module load (`Cannot find module '@/engine/tools/add-narrative-item'`). This is the correct failing state — the handler does not exist yet.

- [ ] **Step 1.3: Commit the failing test**

```bash
git add tests/engine/tools/add-narrative-item.test.ts
git commit -m "test(narrative-items): scaffold addNarrativeItem failing tests"
```

---

## Task 2: Implement `addNarrativeItem` handler

**Files:**
- Create: `src/engine/tools/add-narrative-item.ts`

- [ ] **Step 2.1: Write the handler**

```ts
// src/engine/tools/add-narrative-item.ts
import type { ActionResult, EngineState } from '../types';
import { db } from '@/db/client';
import { codexEntities } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { slugify } from '@/srd/util/slug';

// New flavor-only inventory channel. Unlike `add_item` (which validates the
// slug against SRD catalog + codex named_items), this tool accepts a
// free-form `name`, slugifies it, and persists it as a `named_item` codex
// entry with `magical: false`. The PC's inventory then references the slug
// like any other item. The left-pane UI reads `magical: false` named items
// and renders them with a `(narrativo)` suffix so the player understands
// they have no mechanical effect.
//
// Idempotency: the codex entry is reused on slug collision (no destructive
// upsert; the codex auto-update pipeline owns name/description rewrites).
// The inventory mutation is NOT idempotent (per the master's tool contract)
// — calling twice adds qty twice.

const NAME_MAX = 80;
const DESC_MAX = 120;

export async function addNarrativeItem(
  ctx: { sessionId: string; state: EngineState },
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const pc = ctx.state.characters[0];
  if (!pc) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };

  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  if (!rawName || rawName.length > NAME_MAX) {
    return { ok: false, error: 'invalid_name', rolls: [], mutations: [] };
  }

  let slug: string;
  try {
    slug = slugify(rawName);
  } catch {
    return { ok: false, error: 'invalid_name', rolls: [], mutations: [] };
  }

  const qty = Math.max(1, Math.floor(Number(input.qty ?? 1) || 1));

  const rawDesc = typeof input.description === 'string' ? input.description : '';
  const description = rawDesc.length > DESC_MAX ? rawDesc.slice(0, DESC_MAX) : rawDesc;

  // Read-then-insert. A unique-violation race (codex auto-update inserting
  // the same slug between our SELECT and INSERT) is caught and treated as
  // success — the entry exists, that's all we need before the inventory
  // mutation is queued.
  const [existing] = await db
    .select()
    .from(codexEntities)
    .where(
      and(
        eq(codexEntities.sessionId, ctx.sessionId),
        eq(codexEntities.kind, 'named_item'),
        eq(codexEntities.slug, slug),
      ),
    )
    .limit(1);

  if (!existing) {
    try {
      await db.insert(codexEntities).values({
        sessionId: ctx.sessionId,
        kind: 'named_item',
        slug,
        name: rawName,
        data: { description, magical: false },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate key|unique/i.test(msg)) {
        return { ok: false, error: 'db_failed', rolls: [], mutations: [] };
      }
      // race with concurrent insert — proceed
    }
  }

  return {
    ok: true,
    rolls: [],
    mutations: [{ op: 'add_inventory', characterId: pc.id, itemSlug: slug, qty }],
    data: { slug, name: rawName, qty, kind: 'named_item' },
  };
}
```

- [ ] **Step 2.2: Run the test**

Run: `pnpm test tests/engine/tools/add-narrative-item.test.ts`

Expected: ALL tests pass. If a test fails, read the error and fix the handler — do not patch the test unless the test itself is wrong (unlikely; the spec drove these expectations).

- [ ] **Step 2.3: Commit**

```bash
git add src/engine/tools/add-narrative-item.ts
git commit -m "feat(narrative-items): addNarrativeItem handler with codex named_item upsert"
```

---

## Task 3: Register tool in dispatcher and master schema

**Files:**
- Modify: `src/engine/tools/handlers.ts`
- Modify: `src/engine/tools/index.ts`

- [ ] **Step 3.1: Add import + handler registration**

Edit `src/engine/tools/handlers.ts`. After the existing `import { addItemDb } from './add-item-db';` add an import for the new handler, then add the handler to the `TOOL_HANDLERS_DB` map.

Find this block:

```ts
import { lookupCodex } from './lookup-codex';
import { addItemDb } from './add-item-db';
import { recomputeAcDb } from './recompute-ac-db';
```

Add a line:

```ts
import { lookupCodex } from './lookup-codex';
import { addItemDb } from './add-item-db';
import { addNarrativeItem } from './add-narrative-item';
import { recomputeAcDb } from './recompute-ac-db';
```

Then change the handler map:

```ts
export const TOOL_HANDLERS_DB: Record<string, DbToolHandler> = {
  lookup_codex: (ctx, input) => lookupCodex(ctx, input),
  add_item: (ctx, input) => addItemDb(ctx, input),
  add_narrative_item: (ctx, input) => addNarrativeItem(ctx, input),
  recompute_ac: (ctx, input) => recomputeAcDb(ctx, input),
};
```

- [ ] **Step 3.2: Add JSON schema entry**

Edit `src/engine/tools/index.ts`. The tool definitions live in the `ALWAYS_ON` array (which is re-exported as `TOOL_DEFINITIONS` at the bottom of the file). Find the `add_item` entry inside `ALWAYS_ON` (around line 200) and immediately after its closing `},` insert:

```ts
  {
    name: 'add_narrative_item',
    description:
      "Add a purely-narrative item to the player's inventory (a note, a letter, a strange amulet of unknown power, a holy symbol of an unknown saint, a memento). The item appears in inventory tagged '(narrativo)' and has no mechanical effect (no AC, no damage, no usable action). Use this ONLY for flavor; for weapons, armor, potions, ammo, or anything with stats use `add_item` with an SRD slug. The slug is auto-derived from `name`; if the same slug already exists in the codex this turn, the existing entry is reused (no overwrite). Treat narrative items as non-equippable (do NOT call equip on them).",
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name as the player will see it (e.g. "Strano amuleto di osso").' },
        description: { type: 'string', maxLength: 120, description: 'Optional flavor description; helps the master remember the item on later turns. Truncated at 120 chars.' },
        qty: { type: 'integer', minimum: 1, default: 1 },
      },
    } as never,
  },
```

- [ ] **Step 3.3: Run all engine tests to confirm nothing regressed**

Run: `pnpm test tests/engine`

Expected: PASS. Includes the new `add-narrative-item` tests and the existing `handlers`, `add-item-db`, `recompute-ac-db` suites.

- [ ] **Step 3.4: Commit**

```bash
git add src/engine/tools/handlers.ts src/engine/tools/index.ts
git commit -m "feat(narrative-items): register add_narrative_item in dispatcher + master schema"
```

---

## Task 4: Make `MasterInventoryView` client-importable

**Files:**
- Modify: `src/srd/enrich-inventory.ts`

The current `MasterInventoryView.kind` is typed as `EnrichedInventoryItem['kind']`, and `EnrichedInventoryItem` carries Drizzle `SrdWeapon`/`SrdArmor`/`SrdGear` row types. Importing the view from a client component would drag the DB types into the browser bundle. We extract the kind into a plain string union so the wire-format type is safely importable from the browser.

- [ ] **Step 4.1: Extract `InventoryItemKind`**

In `src/srd/enrich-inventory.ts`, at the top of the file (right after the imports), add:

```ts
export type InventoryItemKind = 'weapon' | 'armor' | 'gear' | 'currency' | 'named_item' | 'unknown';
```

Then change the `MasterInventoryView` interface so `kind` uses the new union directly:

```ts
export interface MasterInventoryView {
  slug: string;
  qty: number;
  equipped?: boolean;
  kind: InventoryItemKind;
  name?: string;
  damage?: string;
  damageType?: string;
  properties?: string[];
  ac?: string;
  category?: string;
  description?: string;
  magical?: boolean;
}
```

Leave the rest of the file unchanged. The structural shape of `EnrichedInventoryItem` already matches `InventoryItemKind` so no other site needs changes.

- [ ] **Step 4.2: Run the existing enrich-inventory tests**

Run: `pnpm test tests/srd/enrich-inventory.test.ts`

Expected: PASS. This is a type-only refactor; the behavior is unchanged.

- [ ] **Step 4.3: Commit**

```bash
git add src/srd/enrich-inventory.ts
git commit -m "refactor(enrich-inventory): extract InventoryItemKind so view is client-importable"
```

---

## Task 5: Test for inventory display formatter

**Files:**
- Test: `tests/lib/inventory.test.ts` (new — file does NOT currently exist; double-check via `ls tests/lib/inventory.test.ts` — if it does exist, append to it instead)

We extract the "show name + optional `(narrativo)`" decision into a pure function in `src/lib/inventory.ts` so it has its own tight unit test and the JSX in `character-pane.tsx` stays trivial.

- [ ] **Step 5.1: Write failing tests**

Create `tests/lib/inventory.test.ts` with the content below. (If the file exists, add the new `describe('formatInventoryDisplay'...)` block.)

```ts
// tests/lib/inventory.test.ts
import { describe, it, expect } from 'vitest';
import { formatInventoryDisplay } from '@/lib/inventory';
import type { MasterInventoryView } from '@/srd/enrich-inventory';

describe('formatInventoryDisplay', () => {
  it('falls back to slugToLabel when no enriched view is provided', () => {
    expect(formatInventoryDisplay('rope-hempen-50ft')).toEqual({
      label: 'Rope Hempen 50ft',
      isNarrative: false,
    });
  });

  it('uses enriched name for SRD weapons', () => {
    const view: MasterInventoryView = { slug: 'longsword', qty: 1, equipped: true, kind: 'weapon', name: 'Longsword' };
    expect(formatInventoryDisplay('longsword', view)).toEqual({
      label: 'Longsword',
      isNarrative: false,
    });
  });

  it('appends "(narrativo)" for non-magical named items', () => {
    const view: MasterInventoryView = {
      slug: 'strano-amuleto-di-osso',
      qty: 1,
      equipped: false,
      kind: 'named_item',
      name: 'Strano amuleto di osso',
      magical: false,
    };
    expect(formatInventoryDisplay('strano-amuleto-di-osso', view)).toEqual({
      label: 'Strano amuleto di osso (narrativo)',
      isNarrative: true,
    });
  });

  it('does NOT append "(narrativo)" for magical named items', () => {
    const view: MasterInventoryView = {
      slug: 'spada-di-aldric',
      qty: 1,
      equipped: true,
      kind: 'named_item',
      name: 'Spada di Aldric',
      magical: true,
    };
    expect(formatInventoryDisplay('spada-di-aldric', view)).toEqual({
      label: 'Spada di Aldric',
      isNarrative: false,
    });
  });

  it('handles named_item with name absent (codex row missing on first paint)', () => {
    const view: MasterInventoryView = {
      slug: 'lettera-cifrata',
      qty: 1,
      kind: 'named_item',
      // No name field — defensive fallback to slugToLabel.
    } as MasterInventoryView;
    expect(formatInventoryDisplay('lettera-cifrata', view)).toEqual({
      label: 'Lettera Cifrata',
      isNarrative: false,
    });
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `pnpm test tests/lib/inventory.test.ts`

Expected: FAIL with `formatInventoryDisplay is not exported from '@/lib/inventory'` (or similar).

- [ ] **Step 5.3: Commit failing test**

```bash
git add tests/lib/inventory.test.ts
git commit -m "test(inventory): scaffold formatInventoryDisplay failing tests"
```

---

## Task 6: Implement `formatInventoryDisplay`

**Files:**
- Modify: `src/lib/inventory.ts`

- [ ] **Step 6.1: Add the formatter**

In `src/lib/inventory.ts`, add this import at the top:

```ts
import type { MasterInventoryView } from '@/srd/enrich-inventory';
```

Then append the formatter to the bottom of the file (after `slugToLabel`):

```ts
/**
 * Decide what label to render for an inventory row, and whether to apply
 * the narrative-item visual treatment. Pure — no DB access.
 *
 * - Falls back to slugToLabel when no enriched view is supplied (older SSE
 *   tick that hasn't shipped enriched data yet).
 * - For named_items, uses `view.name` when present; appends "(narrativo)"
 *   only when `magical === false`. Magical named items get the full name
 *   without suffix (the player should see them as real items).
 */
export function formatInventoryDisplay(
  slug: string,
  view?: MasterInventoryView,
): { label: string; isNarrative: boolean } {
  if (!view) return { label: slugToLabel(slug), isNarrative: false };

  const baseName = view.name && view.name.trim() ? view.name : slugToLabel(slug);
  const isNarrative = view.kind === 'named_item' && view.magical === false;

  return {
    label: isNarrative ? `${baseName} (narrativo)` : baseName,
    isNarrative,
  };
}
```

- [ ] **Step 6.2: Run the test**

Run: `pnpm test tests/lib/inventory.test.ts`

Expected: PASS for all five test cases.

- [ ] **Step 6.3: Commit**

```bash
git add src/lib/inventory.ts
git commit -m "feat(inventory): formatInventoryDisplay returns label + narrative flag"
```

---

## Task 7: Ship `enrichedInventory` from the SSE state route

**Files:**
- Modify: `src/app/api/sessions/[id]/state/route.ts`

The route polls every 1.5s and emits a `snapshot` event. We piggyback the enriched inventory view on that event so the client gets fresh names+kinds without a separate request.

- [ ] **Step 7.1: Import the enrichment helpers**

At the top of `src/app/api/sessions/[id]/state/route.ts`, add (or extend an existing import block):

```ts
import { enrichInventoryItems, formatEnrichedForMaster } from '@/srd/enrich-inventory';
```

- [ ] **Step 7.2: Compute and ship the enriched view**

Find the block (around line 92-108) that selects `character` and constructs `payload`:

```ts
const [character] = await db
  .select({
    id: characters.id,
    name: characters.name,
    level: characters.level,
    xp: characters.xp,
    hpMax: characters.hpMax,
    ac: characters.ac,
    proficiencyBonus: characters.proficiencyBonus,
    inventory: characters.inventory,
    spellcasting: characters.spellcasting,
    features: characters.features,
  })
  .from(characters)
  .where(eq(characters.id, session.characterId))
  .limit(1);
const payload = JSON.stringify({ session, state, actors, character });
```

Replace with:

```ts
const [character] = await db
  .select({
    id: characters.id,
    name: characters.name,
    level: characters.level,
    xp: characters.xp,
    hpMax: characters.hpMax,
    ac: characters.ac,
    proficiencyBonus: characters.proficiencyBonus,
    inventory: characters.inventory,
    spellcasting: characters.spellcasting,
    features: characters.features,
  })
  .from(characters)
  .where(eq(characters.id, session.characterId))
  .limit(1);

// Enriched view for the left-pane UI: lets the client display narrative
// items by name + (narrativo) suffix without a per-item codex lookup.
// Empty inventory short-circuits to skip the round-trip.
const enrichedInventory = character && character.inventory.length > 0
  ? formatEnrichedForMaster(await enrichInventoryItems(character.inventory, { sessionId }))
  : [];

const characterWithEnriched = character ? { ...character, enrichedInventory } : null;
const payload = JSON.stringify({ session, state, actors, character: characterWithEnriched });
```

Then update the `send('snapshot', ...)` call a few lines below from:

```ts
send('snapshot', { session, state, actors, character });
```

to:

```ts
send('snapshot', { session, state, actors, character: characterWithEnriched });
```

- [ ] **Step 7.3: Type-check**

Run: `pnpm typecheck` (or `pnpm exec tsc --noEmit` if no `typecheck` script — check `package.json`).

Expected: no errors.

- [ ] **Step 7.4: Commit**

```bash
git add "src/app/api/sessions/[id]/state/route.ts"
git commit -m "feat(state-sse): ship enrichedInventory alongside raw inventory"
```

---

## Task 8: Wire the enriched inventory through the client state merge

**Files:**
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx`

The merge effect currently copies `patch.inventory` into the `character` React state. We thread `enrichedInventory` through a separate piece of state, then pass it into `CharacterPane`.

- [ ] **Step 8.1: Add a state slot for the enriched view**

In `src/app/(authed)/sessions/[id]/game-client.tsx`, near the existing `setCharacter`/`character` state declarations, add:

```ts
import type { MasterInventoryView } from '@/srd/enrich-inventory';
// ...
const [enrichedInventory, setEnrichedInventory] = React.useState<MasterInventoryView[]>([]);
```

- [ ] **Step 8.2: Update the snapshot-merge effect**

Find the `React.useEffect` that watches `stateSub.snapshot?.character` (currently lines ~62-91). Inside, after the existing `setCharacter(...)`, add:

```ts
const next = (patch as { enrichedInventory?: MasterInventoryView[] }).enrichedInventory;
if (next) setEnrichedInventory(next);
```

Place this *after* the `setCharacter(...)` block but *inside* the same effect. The cast keeps the call site honest about the field being optional during the rollout window.

- [ ] **Step 8.3: Pass it into `CharacterPane`**

Find the `<CharacterPane character={character} state={liveState} />` render around line 292 and change to:

```tsx
<CharacterPane character={character} state={liveState} enrichedInventory={enrichedInventory} />
```

- [ ] **Step 8.4: Type-check**

Run: `pnpm typecheck`

Expected: errors will appear because `CharacterPane` does not yet accept `enrichedInventory`. We fix that in the next task — do NOT commit yet.

---

## Task 9: Render `(narrativo)` in `CharacterPane` / `InventorySection` / `InventoryRow`

**Files:**
- Modify: `src/components/game/character-pane.tsx`

- [ ] **Step 9.1: Extend the prop interfaces**

In `src/components/game/character-pane.tsx`, update the imports at the top:

```ts
import { categorizeInventory, formatInventoryDisplay } from '@/lib/inventory';
import type { MasterInventoryView } from '@/srd/enrich-inventory';
```

(Note `slugToLabel` is no longer imported — it's used inside `formatInventoryDisplay` now. Remove it from the imports if no other site in the file uses it; otherwise keep it.)

Update `CharacterPaneProps`:

```ts
export interface CharacterPaneProps {
  character: Character;
  state: SessionStateRow;
  enrichedInventory?: MasterInventoryView[];
}
```

Update the `CharacterPane` function signature and the `InventorySection` call site:

```tsx
export function CharacterPane({ character, state, enrichedInventory }: CharacterPaneProps) {
  // ... existing code ...
  // (find the line near 160)
  <InventorySection inventory={character.inventory} enriched={enrichedInventory} />
}
```

- [ ] **Step 9.2: Update `InventorySection`**

Replace the existing `InventorySection` signature and body with:

```tsx
function InventorySection({
  inventory,
  enriched,
}: {
  inventory: { slug: string; qty: number; equipped: boolean }[];
  enriched?: MasterInventoryView[];
}) {
  const cat = categorizeInventory(inventory);
  const totalCount = cat.currency.length + cat.equipped.length + cat.other.length;

  // Index enriched rows by slug so InventoryRow lookups are O(1).
  const enrichedMap = React.useMemo(() => {
    const m = new Map<string, MasterInventoryView>();
    for (const e of enriched ?? []) m.set(e.slug, e);
    return m;
  }, [enriched]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* ...currency block stays unchanged... */}

      {cat.equipped.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Equipped</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {cat.equipped.map((it) => (
              <InventoryRow key={it.slug} slug={it.slug} qty={it.qty} equipped enriched={enrichedMap.get(it.slug)} />
            ))}
          </div>
        </div>
      )}

      {cat.other.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Inventory</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {cat.other.map((it) => (
              <InventoryRow key={it.slug} slug={it.slug} qty={it.qty} equipped={false} enriched={enrichedMap.get(it.slug)} />
            ))}
          </div>
        </div>
      )}

      {/* ...empty-state block stays unchanged... */}
    </div>
  );
}
```

You also need `import * as React from 'react';` (or `import { useMemo } from 'react'`) at the top of the file if not already present. Check current imports — if React is not imported, add it.

- [ ] **Step 9.3: Update `InventoryRow`**

Replace the existing `InventoryRow` with:

```tsx
function InventoryRow({
  slug, qty, equipped, enriched,
}: {
  slug: string;
  qty: number;
  equipped: boolean;
  enriched?: MasterInventoryView;
}) {
  const { label } = formatInventoryDisplay(slug, enriched);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '3px 6px',
        borderRadius: 4,
        background: equipped ? 'rgba(122,79,184,0.08)' : 'transparent',
        border: equipped ? '1px solid rgba(122,79,184,0.3)' : '1px solid transparent',
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {qty > 1 && (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
          ×{qty}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 9.4: Type-check the full project**

Run: `pnpm typecheck`

Expected: no errors. (If errors remain, they likely point to a missed import or a reference to `slugToLabel` that needs to be left in place.)

- [ ] **Step 9.5: Run the full test suite to confirm no regression**

Run: `pnpm test`

Expected: PASS. Includes the new and existing tests.

- [ ] **Step 9.6: Commit**

```bash
git add "src/app/(authed)/sessions/[id]/game-client.tsx" src/components/game/character-pane.tsx
git commit -m "feat(character-pane): render narrative items with (narrativo) suffix"
```

---

## Task 10: Render-test the `(narrativo)` suffix in the inventory section

**Files:**
- Test: `tests/components/game/inventory-section.test.tsx` (new)

`InventorySection` is a private function inside `character-pane.tsx`. To test it without making it public, we test the `CharacterPane` wrapper instead — it's the public surface that consumes the prop and renders the same DOM.

- [ ] **Step 10.1: Write the failing test**

```tsx
// tests/components/game/inventory-section.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CharacterPane } from '@/components/game/character-pane';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';
import type { MasterInventoryView } from '@/srd/enrich-inventory';

const mkChar = (inventory: Character['inventory']): Character => ({
  id: 'pc1', name: 'Tharion', level: 1, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  proficiencyBonus: 2, hpMax: 10, ac: 10, speed: 30,
  proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
  spellcasting: null, features: [], inventory,
  hitDiceMax: 1, hitDieSize: 10,
});

const mkState = (): SessionStateRow => ({
  hpCurrent: 10,
  tempHp: 0,
  hitDiceRemaining: 1,
  spellSlotsUsed: {},
  conditions: [],
  resourcesUsed: {},
  inCombat: false,
  combat: null,
  scene: '',
} as unknown as SessionStateRow);

describe('CharacterPane → InventorySection', () => {
  it('renders narrative items with the (narrativo) suffix', () => {
    const inventory = [
      { slug: 'strano-amuleto-di-osso', qty: 1, equipped: false },
    ];
    const enriched: MasterInventoryView[] = [
      { slug: 'strano-amuleto-di-osso', qty: 1, equipped: false, kind: 'named_item', name: 'Strano amuleto di osso', magical: false },
    ];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} enrichedInventory={enriched} />);
    expect(screen.getByText('Strano amuleto di osso (narrativo)')).toBeInTheDocument();
  });

  it('does NOT add the suffix to magical named items', () => {
    const inventory = [{ slug: 'spada-di-aldric', qty: 1, equipped: true }];
    const enriched: MasterInventoryView[] = [
      { slug: 'spada-di-aldric', qty: 1, equipped: true, kind: 'named_item', name: 'Spada di Aldric', magical: true },
    ];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} enrichedInventory={enriched} />);
    expect(screen.getByText('Spada di Aldric')).toBeInTheDocument();
    expect(screen.queryByText(/narrativo/)).not.toBeInTheDocument();
  });

  it('falls back to slug-derived label when enriched view is absent', () => {
    const inventory = [{ slug: 'rope-hempen-50ft', qty: 1, equipped: false }];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} />);
    expect(screen.getByText('Rope Hempen 50ft')).toBeInTheDocument();
  });
});
```

- [ ] **Step 10.2: Run the test**

Run: `pnpm test tests/components/game/inventory-section.test.tsx`

Expected: PASS for all three. (Tasks 4-9 already wired up the rendering path; this is the verification test.)

If it fails because `SessionStateRow` shape mismatches your usage, inspect `src/sessions/client-types.ts` and adjust the cast — the tests don't exercise any state field, so a shallow object satisfies it.

- [ ] **Step 10.3: Commit**

```bash
git add tests/components/game/inventory-section.test.tsx
git commit -m "test(character-pane): verify (narrativo) suffix rendering"
```

---

## Task 11: Update the master system prompt

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

- [ ] **Step 11.1: Insert the prompt entry**

Open `src/ai/master/system-prompt.ts`. In `MASTER_TOOL_CONTRACT`, find the bullet for `add_item` (a long line starting with `` - \`add_item\` / \`remove_item\` `` around line 48). Immediately after that bullet's line ends (just before the `- \`award_xp\`` bullet), insert this new bullet (preserve the existing template-literal indentation/escaping in that file):

```
- \`add_narrative_item\` — for purely descriptive items the player obtains that have no mechanical effect (a note, a strange amulet of unknown power, a mug of ale, a memento, a holy symbol of an unknown saint). These appear in the inventory tagged \`(narrativo)\`. Treat them as non-equippable and not usable in checks (do NOT call \`equip\` on them). Use this so flavor loot the player narrates is visible in the left pane. **Do NOT use this to bypass \`add_item\`** — magical items with effects, weapons, armor, potions, ammo, and currency must still go through \`add_item\` with proper SRD slugs. If you want a flavor item to later become magical, narrate it normally and the codex auto-update will tag it on the next turn — the inventory entry stays the same.
```

- [ ] **Step 11.2: Type-check + run any prompt snapshot tests**

Run: `pnpm typecheck && pnpm test src/ai/master`

Expected: PASS. (If a prompt snapshot test fails because the cached system-prompt text changed, update the snapshot — it's the intended change. Use `pnpm vitest -u src/ai/master/...` if needed.)

- [ ] **Step 11.3: Commit**

```bash
git add src/ai/master/system-prompt.ts
git commit -m "docs(master-prompt): document add_narrative_item with anti-bypass rule"
```

---

## Task 12: Manual smoke test

**Files:** none — exercise the running app.

This step verifies the end-to-end flow in a real browser. Spec requires UI-changing work to be exercised in the browser before being declared done.

- [ ] **Step 12.1: Start the dev server**

Run (in a separate terminal): `pnpm dev`

Wait for the "ready" log line.

- [ ] **Step 12.2: Open a session**

In the browser, sign in and open (or create) a session. Confirm the left pane shows the existing inventory rendering with no regressions (gold, equipped items, etc.).

- [ ] **Step 12.3: Trigger a narrative item**

Send a player message designed to make the master grant a flavor item — for example: `"Frugo nelle tasche del cadavere e prendo qualunque cosa abbia."` and let the master narrate. If the master doesn't naturally pick a narrative item, send `"!testing narrative items: per favore aggiungi alla mia inventory un piccolo amuleto narrativo."` (the `!` prefix puts it OOC; the master can still call tools as part of its OOC reply if you nudge — alternatively just play out a scene where finding a strange trinket is fitting).

- [ ] **Step 12.4: Verify the inventory pane**

Within ~1.5s of the master's turn completing, the new item should appear in the left-pane "Inventory" section labeled like `Strano amuleto di osso (narrativo)`. The suffix must be present, and the item must NOT appear in "Equipped".

- [ ] **Step 12.5: Reload the page**

Hard-reload the browser. Confirm the narrative item is still in the inventory after reload (persisted to DB, codex named_item exists).

- [ ] **Step 12.6: Verify it's removable**

Send `"Lascio cadere l'amuleto sul pavimento del tempio."` — the master should call `remove_item` and the row should disappear from the inventory.

- [ ] **Step 12.7: Stop dev, final review**

Stop `pnpm dev`. Run the full test suite and type-check one last time:

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 12.8: Final commit (if any UI tweaks were needed during the smoke test)**

If you discovered visual issues during the smoke test and edited any file, commit those fixes now with a focused message. If nothing changed, skip.

---

## Verification Checklist

Before declaring the feature complete, confirm:

- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0 (full suite).
- [ ] `add_narrative_item` is visible in the master tool list (inspect `src/engine/tools/index.ts` — schema present).
- [ ] The dispatcher routes `add_narrative_item` to the new handler (inspect `src/engine/tools/handlers.ts`).
- [ ] State SSE event for an open session contains `character.enrichedInventory: [...]` (inspect via browser devtools → Network → state stream).
- [ ] Smoke test (Task 12) passed for create / display / reload / remove.

## Out of Scope (per spec)

- Equip-time engine guard for narrative items (master is told via prompt).
- i18n of the `(narrativo)` suffix.
- Editing a narrative item's name/description after creation.
- Promoting a narrative item to magical (handled by the codex auto-update pipeline already).
- Allowing the master to specify a custom slug.
