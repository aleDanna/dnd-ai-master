# Narrative items — Design

**Status:** Draft · **Date:** 2026-05-09 · **Author:** brainstormed with Claude
**Touches:** `src/engine/tools/add-narrative-item.ts` (new), `src/engine/tools/handlers.ts`, `src/engine/tools/index.ts`, `src/app/api/sessions/[id]/state/route.ts`, `src/components/game/character-pane.tsx`, `src/lib/inventory.ts` (minor), `src/ai/master/system-prompt.ts`, plus tests.

## Problem

`add_item` validates the slug against three sources: SRD catalog (`srd_weapon` / `srd_armor` / `srd_gear`), currency codes (`gp/sp/cp/ep/pp`), and session-scoped `named_item` codex entries. When the master narrates an item that has no SRD slug and no pre-existing codex entry — a strange amulet, a cryptic letter, a holy symbol of an unknown saint — `add_item` returns `unknown_item:{slug}` and the inventory is **not** mutated.

The master has no other tool to create such an entry: the codex auto-update runs between turns, not on demand, and there is no master-callable `upsert_codex` API. The result is that flavor items the master narrates *vanish* — the player hears about them in prose, but the left-pane inventory never reflects them. This breaks the player's mental model ("you said I picked up the amulet — where is it?") and forces the master into the awkward choice of either narrating loot it cannot persist or constraining itself to SRD-only items, hurting flavor.

The player has explicitly asked for these flavor items to appear in the inventory, tagged so it is clear they have no mechanical effect.

## Goals

1. The master can grant a purely-flavor item to the player in a single tool call, without needing a pre-existing codex entry.
2. The item appears in the left-pane inventory with its narrative name and a `(narrativo)` suffix that signals "this has no stats — narrative only".
3. The item persists across reloads and session reopens (it lives in the same inventory the SRD items live in).
4. The narrative item is visible to the master on subsequent turns, so the master does not "forget" the player has it.
5. `add_item` continues to be strict about SRD slugs — narrative items go through a separate, explicitly-named tool.

## Non-goals (deferred)

- ❌ Localization of the `(narrativo)` suffix per session language. Italian-only hardcoded for now; if a non-Italian session needs `(narrative)` later, it ties into the session `language` and is a follow-up.
- ❌ Editing a narrative item's name/description after creation. The master can `remove_item` + recreate, or the codex auto-update can promote it to magical via the existing pipeline.
- ❌ Promoting a narrative item to a real magical `named_item`. If the master later decides the cryptic letter has a power, the codex auto-update flips `magical: true` on the next turn — the inventory entry stays the same.
- ❌ Allowing the master to specify a custom slug. Slug is always derived from the name (slugify) so we cannot end up with two narrative items the master gave the same name.
- ❌ Stats / effects on narrative items (AC, damage, save bonuses). The whole point is "no mechanics".
- ❌ Backfilling existing inventory rows that are tagged `unknown` in `enrich-inventory.ts`. That bucket is for legacy rows from before catalog validation; we leave it alone.
- ❌ Engine-level equip-time guard for narrative items. `equip()` is currently pure/sync and does not touch the catalog (the catalog is consulted only in `recomputeAC` via a pre-loaded `ArmorSpecMap`). Adding a DB-backed equip wrapper just to reject narrative items is out of scope for this feature. Instead the master is told in the prompt that narrative items cannot be equipped; if the master tries anyway, `equip` succeeds, the item appears in the Equipped section as a cosmetic wart, and `recomputeAC` ignores it (no AC change). If this surfaces as a real problem in play we add the guard in a follow-up.

## Architecture

A new tool `add_narrative_item` is added to the `TOOL_HANDLERS_DB` registry alongside `add_item`. Its handler:

1. Validates and trims `name`. Slugifies it (`slugify(name)` → e.g. `"Strano amuleto di osso"` → `"strano-amuleto-di-osso"`).
2. Checks `codex_entities` for an existing `(sessionId, kind='named_item', slug)` row.
   - **Hit**: reuse the existing entry. Do not overwrite name/description (the codex pipeline owns updates).
   - **Miss**: insert a new `named_item` with `data: { description: description ?? '', magical: false }`.
3. Emits a single mutation `{ op: 'add_inventory', characterId, itemSlug: slug, qty }` exactly like `add_item` — the inventory layer is unchanged.

Display path:

- The state SSE (`src/app/api/sessions/[id]/state/route.ts`) currently ships `inventory: characters.inventory` (raw `{slug, qty, equipped}` triples). It is extended with a parallel `enrichedInventory: MasterInventoryView[]` field, computed via the existing `enrichInventoryItems(...)` + `formatEnrichedForMaster(...)` pipeline. Raw `inventory` stays for backwards compatibility with anything that reads it.
- `character-pane.tsx` reads `enrichedInventory` (when present), passes each row's `name` and `kind`/`magical` flag down to `InventoryRow`.
- `InventoryRow` renders `<name> (narrativo)` when `kind === 'named_item' && magical === false`. SRD items render as today (`slugToLabel(slug)` fallback).
- `categorizeInventory` keeps narrative items in the `other` bucket as long as their `equipped` flag is false (the master is told not to equip them; if a stray equip slips through, the item appears in Equipped — see non-goals).

Master prompt:

- `MASTER_TOOL_CONTRACT` gains a one-line entry for `add_narrative_item` immediately after `add_item`, explaining when to use it and the hard rule against using it as an SRD bypass.

## Data model

**No schema migration.** The existing `codex_entities` table already supports `kind='named_item'` rows with `data: { description, magical }`. Narrative items are simply `magical: false` named items.

The existing `MasterInventoryView` type (`src/srd/enrich-inventory.ts`) already encodes `kind: 'named_item'` with `name`, `description`, and `magical`. The same type ships to the client; nothing new to define for the wire format beyond exposing it.

The `description` field for a narrative item may be empty (`''`). When non-empty, it is truncated to 120 chars by `formatEnrichedForMaster` exactly like other named items.

## Tool: `add_narrative_item`

### Schema (`src/engine/tools/index.ts`)

```ts
{
  name: 'add_narrative_item',
  description:
    "Add a purely-narrative item to the player's inventory (a note, a letter, a strange amulet of unknown power, a holy symbol of an unknown saint, a memento). The item appears in inventory tagged '(narrativo)' and has no mechanical effect (no AC, no damage, no usable action). Use this ONLY for flavor; for weapons, armor, potions, ammo, or anything with stats use `add_item` with an SRD slug. The slug is auto-derived from `name`; if the same slug already exists in the codex this turn, the existing entry is reused (no overwrite).",
  input_schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name as the player will see it (e.g. "Strano amuleto di osso").' },
      description: { type: 'string', maxLength: 120, description: 'Optional flavor description; helps the master remember the item on later turns. Truncated at 120 chars.' },
      qty: { type: 'integer', minimum: 1, default: 1 },
    },
  },
}
```

No `actor` parameter — single-PC MVP. The handler resolves `actor` to the only character in `state.characters[0]`.

### Handler (`src/engine/tools/add-narrative-item.ts`)

```ts
export async function addNarrativeItem(
  ctx: { sessionId: string; state: EngineState },
  input: Record<string, unknown>,
): Promise<ActionResult>
```

Steps:

1. Resolve PC: `state.characters[0]`. If absent → `{ ok: false, error: 'unknown_actor' }`.
2. Validate `name`: trim, reject empty / >80 chars → `invalid_name`.
3. Compute `slug = slugify(name)` using the existing helper at `@/srd/util/slug` (lowercase, NFD-normalised, dash-separated, strips apostrophes and diacritics; throws on inputs that produce an empty slug — caught and remapped to `invalid_name`).
4. Validate `qty`: `Math.max(1, Math.floor(qty ?? 1))`.
5. Truncate `description` to 120 chars; default to `''`.
6. Codex upsert (read-then-insert):
   - SELECT 1 row from `codex_entities` WHERE `sessionId` AND `kind='named_item'` AND `slug` matches.
   - If found: skip insert.
   - If missing: INSERT with `name = name`, `data = { description, magical: false }`.
   - Race condition: a concurrent insert from the codex auto-update is unlikely (auto-update runs after the turn completes, our handler runs during the turn). If it ever races, the unique index `(sessionId, kind, slug)` causes a write failure that we catch and treat as "already exists".
7. Return `{ ok: true, mutations: [{ op: 'add_inventory', characterId, itemSlug: slug, qty }], data: { slug, qty, name, kind: 'named_item' }, rolls: [] }`.

### Registration

Added to `TOOL_HANDLERS_DB` in `src/engine/tools/handlers.ts`:

```ts
export const TOOL_HANDLERS_DB: Record<string, DbToolHandler> = {
  lookup_codex: (ctx, input) => lookupCodex(ctx, input),
  add_item: (ctx, input) => addItemDb(ctx, input),
  add_narrative_item: (ctx, input) => addNarrativeItem(ctx, input),
  recompute_ac: (ctx, input) => recomputeAcDb(ctx, input),
};
```

Tool schema registered in the same array as `add_item` in `src/engine/tools/index.ts`. The master sees both tools in every turn.

## Display path

### State SSE payload (`src/app/api/sessions/[id]/state/route.ts`)

After the `db.select(...)` of `character` (around line 92-107), call:

```ts
const enrichedInventory = await enrichInventoryItems(character.inventory, { sessionId });
const inventoryView = formatEnrichedForMaster(enrichedInventory);
```

and ship it inside the snapshot:

```ts
send('snapshot', { session, state, actors, character: { ...character, enrichedInventory: inventoryView } });
```

Tradeoff: this adds two DB roundtrips per SSE tick (1500 ms cadence). Acceptable: inventories are small (≤50 items typically), the queries are batched IN-lookups, and the existing `state-sse` already does ~5 selects per tick. We diff `payload` before sending so identical snapshots don't re-broadcast.

### Client (`src/components/game/character-pane.tsx`)

`InventorySection` receives both `inventory` (raw, current) and `enrichedInventory` (new, optional). It indexes the enriched array by `slug` and looks each row up at render time. When enriched data is missing (older SSE tick before enrichment lands), it falls back to today's `slugToLabel(slug)` rendering — no broken state during deploy.

`InventoryRow` gains optional props:

```ts
function InventoryRow({
  slug, qty, equipped,
  displayName,           // from enrichedInventory[slug].name (when present)
  isNarrative,           // true when kind === 'named_item' && magical === false
}: { ... })
```

Render logic:

- When `displayName` is set, use it; else `slugToLabel(slug)`.
- When `isNarrative`, append `' (narrativo)'` after the name in the same `<span>`. No separate badge — minimal visual change to keep the inventory pane clean. The suffix uses the same color as the qty (`var(--fg-muted)`).

### Categorization (`src/lib/inventory.ts`)

`categorizeInventory(items)` is unchanged in interface; it still buckets into `currency`/`equipped`/`other` based on slug + `equipped` flag. Narrative items, never equipped, fall into `other`. They mix with mundane gear visually (intentional — the `(narrativo)` suffix is the visual differentiator, not the section header).

## Master system prompt update

In `src/ai/master/system-prompt.ts`, in `MASTER_TOOL_CONTRACT`, immediately after the `add_item` line, add:

```
- `add_narrative_item({ name, description?, qty? })` — for purely descriptive items the player obtains that have no mechanical effect (a note, a strange amulet of unknown power, a mug of ale, a memento, a holy symbol of an unknown saint). These appear in the inventory tagged `(narrativo)`. Treat them as non-equippable and not usable in checks (do not call `equip` on them). Use this so flavor loot the player narrates is visible in the left pane. **Do NOT use this to bypass `add_item`** — magical items with effects, weapons, armor, potions, ammo, and currency must still go through `add_item` with proper SRD slugs. If you want a flavor item to later become magical, narrate it normally and the codex auto-update will tag it on the next turn — the inventory entry stays the same.
```

The "no `actor`" detail is implicit (the schema has no `actor` field — the master sees that in the JSON schema).

## Error handling

`add_narrative_item` returns these errors:

- `unknown_actor` — no PC in state (should never happen in practice).
- `invalid_name` — empty after trim, >80 chars, or `slugify` produced an empty slug (e.g. name was punctuation-only).
- `db_failed` — codex insert failed for a non-uniqueness reason. Surfaced as a tool error; master adapts narration.

A unique-constraint violation on the codex insert is caught and treated as success (the item already exists; we proceed to add it to inventory). This makes the handler idempotent under retry.

## Idempotency

Like `add_item`, `add_narrative_item` is **NOT idempotent on inventory** — calling it twice adds qty twice. The existing `MASTER_TOOL_CONTRACT` rule "State-mutating tools are NOT idempotent" already covers this; no additional language needed.

Codex creation IS idempotent — second call hits the existing row and skips the insert.

## Tests

New / updated:

- `tests/engine/tools/add-narrative-item.test.ts` (new):
  - Slugifies name correctly (diacritics, spaces, mixed case).
  - Inserts new codex `named_item` with `magical: false` when slug is fresh.
  - Reuses existing codex row when slug already present (no second insert).
  - Returns `add_inventory` mutation with the correct slug + qty.
  - Rejects empty name → `invalid_name`.
  - Rejects name >80 chars → `invalid_name`.
  - Truncates description to 120 chars.
  - qty defaults to 1, floored to integer, minimum 1.
  - Race / unique-violation path: simulate concurrent insert, verify success without crash.

- `tests/srd/enrich-inventory.test.ts` (extend):
  - Verifies `magical: false` named items round-trip through `formatEnrichedForMaster` with the `magical: false` flag intact.

- UI test (`character-pane` render): renders `(narrativo)` suffix when row's `enrichedInventory` entry is `kind: 'named_item' && magical === false`. (Use the existing test setup pattern.)

## Open questions

None — design decisions captured in this doc:

| Decision | Choice |
| --- | --- |
| New tool vs `add_item` overload | New tool `add_narrative_item` |
| Persistence | `named_item` codex entry, `magical: false` |
| Slug source | Auto-slugify from `name` |
| UI label | `<name> (narrativo)`, hardcoded Italian |
| Equippable | Discouraged in prompt; no engine-level guard (deferred) |
| Description max | 120 chars (matches `NAMED_ITEM_DESC_BUDGET`) |
| `actor` param | Omitted (single-PC MVP) |
