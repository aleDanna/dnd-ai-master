---
phase: 02
plan: 04
type: execute
wave: 2
depends_on: [02-01, 02-02]
files_modified:
  - src/ai/master/vault/projector.ts
  - tests/ai/master/vault/projector.test.ts
autonomous: true
requirements: [REQ-004, REQ-006]
must_haves:
  truths:
    - "applyEvent is PURE — same (state, event) input always produces same output; no Date.now / random / env reads"
    - "Replaying [100 events] produces the same state as Replaying the same [100 events] sequentially (determinism)"
    - "A corrupted line in events.md (malformed JSON) aborts replay fast — throws an error with the line number; no silent state divergence"
    - "applyEvent for hp_change clamps next.hp_current to [0, hp_max] (T-02-03 mitigation; spike 008 contract)"
    - "applyEvent for an unknown event type logs and returns state unchanged (graceful degradation per Pitfall 6)"
    - "regenerateCharacterView reads events.md, replays, and writes the materialized view atomically — view file matches the replayed state"
    - "serializeView produces a frontmatter+body markdown file the LLM can read via read_vault_multi"
    - "Round-trip property: parseView(serializeView(state)) === state (modulo whitespace) for any state derivable from the 8 event types"
  artifacts:
    - path: "src/ai/master/vault/projector.ts"
      provides: "applyEvent reducer, replayEvents, regenerateCharacterView, INITIAL_CHARACTER_STATE, serializeView, parseView (test seam)"
      exports: ["applyEvent", "replayEvents", "regenerateCharacterView", "regenerateAffectedViews", "INITIAL_CHARACTER_STATE", "serializeView", "parseView", "type CharacterState"]
  key_links:
    - from: "src/ai/master/vault/projector.ts"
      to: "src/ai/master/vault/events-schema.ts"
      via: "imports VaultEvent + VaultEventEnvelope; exhaustive switch over union members"
      pattern: "VaultEvent|VaultEventEnvelope"
    - from: "src/ai/master/vault/projector.ts"
      to: "src/ai/master/vault/campaign-paths.ts"
      via: "uses characterViewPath + eventsPath to locate disk artifacts"
      pattern: "characterViewPath|eventsPath"
    - from: "src/ai/master/vault/tools.ts (plan 02-07)"
      to: "src/ai/master/vault/projector.ts"
      via: "regenerateAffectedViews called synchronously after each EventsWriter.applyEvent"
      pattern: "regenerateAffectedViews"
---

# Plan 02-04: Event Projector (Replay + Materialized Views)

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 2 (depends on 02-01 for `VaultEvent` union + 02-02 for `characterViewPath`/`eventsPath`)
**Status:** Pending
**Estimated diff size:** ~220 LOC source + ~160 LOC tests / 2 files

## Goal

Ship `src/ai/master/vault/projector.ts` — the PURE event reducer + materialized-view regenerator. The projector is the read side of event sourcing: given an ordered list of events, deterministically produce the current state, then serialize state → markdown frontmatter for the LLM to read via `read_vault_multi`.

Implementation contract from RESEARCH §4 Pattern 2 + Pattern 3 + spike 008:
- `applyEvent(state, event) -> state` is PURE (no `Date.now`, no `random`, no env reads — REQ-022 hygiene applies here too even though the projector doesn't go in the system prompt, because side effects in the reducer would break replay determinism)
- `replayEvents(events) -> CharacterState[]` reads events.md, parses JSONL, reduces through `applyEvent` starting from `INITIAL_CHARACTER_STATE`
- `regenerateCharacterView(campaignId, characterId, characterName)` runs full replay and writes `characters/<slug>-<id8>.md`
- `regenerateAffectedViews(campaignId, event)` is the dispatcher's hook (plan 02-07) — for non-batch events, it figures out which character was touched and regenerates just that view
- Corrupted line aborts replay with a clear error message (spike 008's fail-fast guarantee)

`CharacterState` shape mirrors spike 008's reducer interface:
```ts
interface CharacterState {
  id: string;
  name: string;
  hp_current: number;
  hp_max: number;
  conditions: string[];                                          // unique, deduplicated
  spell_slots: Record<string, { max: number; used: number }>;    // keyed by level (1-9 as strings)
  inventory: { item: string; qty: number }[];                    // by item name, qty aggregated
}
```

`INITIAL_CHARACTER_STATE` for a not-yet-seen character is bootstrapped from the `campaign_initialized` seed event payload. The projector's per-character state lives in a `Map<characterId, CharacterState>` during replay; lookup is by `event.payload.character` (which is the character's ID — the LLM passes the ID, not the name; the slug+id8 is the file naming choice).

The serialized view format is a thin frontmatter+body markdown file:
```markdown
---
id: <uuid>
name: <name>
hp_current: 23
hp_max: 30
conditions: [poisoned]
spell_slots:
  "1": { max: 4, used: 2 }
spell_slots_total: 6
inventory:
  - { item: rope, qty: 1 }
  - { item: torch, qty: 3 }
last_event_id: <uuid>
last_updated: <iso-timestamp>
---

# <name>

(materialized view; do not edit — regenerated by the projector after each apply_event)
```

The `last_event_id` and `last_updated` come from the LAST event's envelope (id + timestamp). These are metadata only — re-replay produces identical state regardless of these fields, but they help debugging and give the LLM a freshness signal.

## Requirements satisfied

- **REQ-004** events.md is source of truth, materialized views are projections — this plan is the projection function.
- **REQ-006** DR procedure = replay events.md → regenerate views; this plan ships the replay + regenerate primitives that plan 02-10's `vault-rebuild-views` script invokes.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/projector.ts` | NEW | Pure reducer + replay + view regeneration. |
| `tests/ai/master/vault/projector.test.ts` | NEW | Vitest: determinism, clamps, corruption fail-fast, view round-trip. |

## Tasks

<task type="auto">
  <name>Task 1: Create projector.ts with applyEvent reducer + replay + view regen</name>
  <files>src/ai/master/vault/projector.ts</files>
  <read_first>
    - .planning/spikes/008-events-md-replay/replay.ts (THE source-of-truth reducer implementation — copy the pattern)
    - .planning/spikes/008-events-md-replay/README.md (lines 64-72 — required pieces for the real build; lines 73-80 — "Signal for the real build")
    - .claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md (lines 79-100 — canonical replay pattern; lines 116-145 — anti-patterns: never write views from outside)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§4 Pattern 2, §4 Pattern 3, Pitfall 6 — graceful degradation on unknown event types)
    - src/ai/master/vault/events-schema.ts (plan 02-01 — the VaultEvent union the reducer consumes)
    - src/ai/master/vault/campaign-paths.ts (plan 02-02 — the path helpers)
    - .planning/phases/02-vault-write-path-event-sourcing/PLAN.md (must_haves section for "Round-trip property" — parseView is a test seam)
  </read_first>
  <action>
Create `src/ai/master/vault/projector.ts` with these exports:

1. **`CharacterState` interface:**
   ```ts
   export interface CharacterState {
     id: string;
     name: string;
     hp_current: number;
     hp_max: number;
     conditions: string[];
     spell_slots: Record<string, { max: number; used: number }>;
     inventory: { item: string; qty: number }[];
     last_event_id?: string;     // envelope.id of the most recent event applied
     last_updated?: string;      // envelope.timestamp of the most recent event
   }
   ```

2. **`INITIAL_CHARACTER_STATE` factory:**
   ```ts
   export function INITIAL_CHARACTER_STATE(seed: { id: string; name: string; hp_max: number; hp_current?: number; spell_slots?: Record<string, { max: number; used: number }> }): CharacterState {
     return {
       id: seed.id,
       name: seed.name,
       hp_current: seed.hp_current ?? seed.hp_max,
       hp_max: seed.hp_max,
       conditions: [],
       spell_slots: seed.spell_slots ?? {},
       inventory: [],
     };
   }
   ```
   Used internally by `replayEvents` when it sees a `campaign_initialized` event — for each character in the payload, it constructs an INITIAL_CHARACTER_STATE and stores it in the per-character state map.

3. **`applyEvent(state: CharacterState, event: VaultEvent): CharacterState`:** the PURE reducer. Uses `structuredClone(state)` to ensure immutability (per spike 008 + RESEARCH §4 Pattern 2). Implementation:

   ```ts
   export function applyEvent(state: CharacterState, event: VaultEvent): CharacterState {
     const next = structuredClone(state);
     switch (event.type) {
       case 'hp_change':
         next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + event.payload.delta));
         return next;
       case 'condition_add':
         if (!next.conditions.includes(event.payload.condition)) {
           next.conditions.push(event.payload.condition);
           next.conditions.sort();  // deterministic ordering for byte-stable view output
         }
         return next;
       case 'condition_remove':
         next.conditions = next.conditions.filter((c) => c !== event.payload.condition);
         return next;
       case 'spell_slot_use': {
         const key = String(event.payload.level);
         const slot = next.spell_slots[key];
         if (slot && slot.used < slot.max) slot.used += 1;
         return next;
       }
       case 'spell_slot_restore': {
         const key = String(event.payload.level);
         const slot = next.spell_slots[key];
         if (slot && slot.used > 0) slot.used -= 1;
         return next;
       }
       case 'inventory_add': {
         const existing = next.inventory.find((i) => i.item === event.payload.item);
         if (existing) existing.qty += event.payload.qty;
         else next.inventory.push({ item: event.payload.item, qty: event.payload.qty });
         next.inventory.sort((a, b) => a.item.localeCompare(b.item));  // deterministic order
         return next;
       }
       case 'inventory_remove': {
         const idx = next.inventory.findIndex((i) => i.item === event.payload.item);
         if (idx === -1) return next;  // remove of non-existent item is a no-op (graceful)
         next.inventory[idx].qty = Math.max(0, next.inventory[idx].qty - event.payload.qty);
         if (next.inventory[idx].qty === 0) next.inventory.splice(idx, 1);
         return next;
       }
       case 'campaign_initialized':
         // Seed events are handled by replayEvents (state-map setup); applyEvent
         // on a campaign_initialized event for an already-existing state is a no-op.
         return next;
       default: {
         // Pitfall 6 — graceful degradation. Future event types not yet known
         // to this projector log to console.warn and return state unchanged.
         // The exhaustiveness check below (assertNever) is the compile-time guard.
         const _exhaustive: never = event;
         console.warn('[projector] unknown event type, state unchanged:', _exhaustive);
         return next;
       }
     }
   }
   ```

   The `default` arm uses TypeScript's `never` type for compile-time exhaustiveness — if a new union member is added in events-schema.ts but NOT handled in this switch, tsc fails. This is the "type-system enforced contract" Decision 1 promises.

4. **`replayEvents(envelopes: VaultEventEnvelope[]): Map<string, CharacterState>`:** pure function from event list to per-character state map.

   ```ts
   export function replayEvents(envelopes: VaultEventEnvelope[]): Map<string, CharacterState> {
     const states = new Map<string, CharacterState>();
     for (const env of envelopes) {
       if (env.type === 'campaign_initialized') {
         const payload = env.payload as { characters: Array<{ id: string; name: string; hp_max: number; hp_current?: number; spell_slots?: Record<string, { max: number; used: number }> }> };
         for (const c of payload.characters) {
           states.set(c.id, INITIAL_CHARACTER_STATE(c));
         }
         continue;
       }
       // All other event types target a specific character by id (the character field in payload is the character id).
       const charId = (env.payload as { character: string }).character;
       const current = states.get(charId);
       if (!current) {
         // Event for a character not yet seeded — skip with warning. Defensive: in practice the seed event should always come first.
         console.warn('[projector] event for unseeded character, skipping:', charId, env.type);
         continue;
       }
       const next = applyEvent(current, { type: env.type, payload: env.payload } as VaultEvent);
       next.last_event_id = env.id;
       next.last_updated = env.timestamp;
       states.set(charId, next);
     }
     return states;
   }
   ```

5. **`parseEventsFile(path: string): Promise<VaultEventEnvelope[]>`:** reads events.md from disk, splits by newline, parses each line as JSON. On any line that fails JSON.parse, throws `new Error(\`[projector] corrupt event at line ${lineNum}: ${err.message}\`)` — spike 008 fail-fast contract. Empty file → empty array (a new campaign before its first event has nothing to replay; the function returns `[]` not an error).

6. **`regenerateCharacterView(campaignId: string, characterId: string): Promise<void>`:** orchestrator that the dispatcher hook below uses. Steps:
   - `const envelopes = await parseEventsFile(eventsPath(campaignId));`
   - `const states = replayEvents(envelopes);`
   - `const state = states.get(characterId);`
   - If `state` is undefined, throw (the character was never seeded; the dispatcher should not have called us for an unknown character).
   - `const viewPath = characterViewPath(campaignId, state.name, characterId);`
   - `await mkdir(dirname(viewPath), { recursive: true });`
   - `await writeFile(viewPath, serializeView(state), 'utf8');`

7. **`regenerateAffectedViews(campaignId: string, event: VaultEventEnvelope): Promise<void>`:** the dispatcher's post-append hook (synchronous after append per Decision 2). For all 7 mutation event types, the `payload.character` is the character ID — regenerate just that one view. For `campaign_initialized`, regenerate ALL views listed in the payload. Implementation:
   ```ts
   export async function regenerateAffectedViews(campaignId: string, event: VaultEventEnvelope): Promise<void> {
     if (event.type === 'campaign_initialized') {
       const payload = event.payload as { characters: Array<{ id: string }> };
       await Promise.all(payload.characters.map((c) => regenerateCharacterView(campaignId, c.id)));
       return;
     }
     const charId = (event.payload as { character: string }).character;
     await regenerateCharacterView(campaignId, charId);
   }
   ```

8. **`serializeView(state: CharacterState): string`:** state → frontmatter+body markdown. Deterministic output (same state always produces byte-identical view — important for spike 013's byte-exact DR test). Use a hand-rolled YAML emitter (avoid `yaml` package dependency); the frontmatter shape is small and known:
   ```ts
   export function serializeView(state: CharacterState): string {
     const lines: string[] = ['---'];
     lines.push(`id: ${state.id}`);
     lines.push(`name: ${JSON.stringify(state.name)}`);
     lines.push(`hp_current: ${state.hp_current}`);
     lines.push(`hp_max: ${state.hp_max}`);
     lines.push('conditions:');
     if (state.conditions.length === 0) lines[lines.length - 1] = 'conditions: []';
     else for (const c of state.conditions) lines.push(`  - ${JSON.stringify(c)}`);
     lines.push('spell_slots:');
     const slotKeys = Object.keys(state.spell_slots).sort();
     if (slotKeys.length === 0) lines[lines.length - 1] = 'spell_slots: {}';
     else for (const k of slotKeys) {
       const s = state.spell_slots[k];
       lines.push(`  "${k}": { max: ${s.max}, used: ${s.used} }`);
     }
     lines.push('inventory:');
     if (state.inventory.length === 0) lines[lines.length - 1] = 'inventory: []';
     else for (const i of state.inventory) lines.push(`  - { item: ${JSON.stringify(i.item)}, qty: ${i.qty} }`);
     if (state.last_event_id) lines.push(`last_event_id: ${state.last_event_id}`);
     if (state.last_updated) lines.push(`last_updated: ${state.last_updated}`);
     lines.push('---');
     lines.push('');
     lines.push(`# ${state.name}`);
     lines.push('');
     lines.push('(materialized view; do not edit — regenerated by the projector after each apply_event)');
     lines.push('');
     return lines.join('\n');
   }
   ```

9. **`parseView(content: string): CharacterState | null`:** test seam — reverse of `serializeView`. Used ONLY by tests to verify the round-trip property. Production code does NOT call this (the projector treats views as write-only outputs; the source of truth is events.md). Implementation: simple line-by-line parser for the known frontmatter shape. Returns `null` if the content does not look like a serialized view (no frontmatter delimiter). Document in JSDoc: "TEST SEAM — production code reads views via the LLM's read_vault_multi tool only."

10. Imports:
    ```ts
    import { readFile, writeFile, mkdir } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import type { VaultEvent, VaultEventEnvelope } from './events-schema';
    import { eventsPath, characterViewPath } from './campaign-paths';
    ```

11. Module-level JSDoc cites REQ-004, REQ-006, spike 008, RESEARCH §4 Pattern 2/3, Decision 2.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/projector.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File `src/ai/master/vault/projector.ts` exists with all 9 exports: `applyEvent`, `replayEvents`, `regenerateCharacterView`, `regenerateAffectedViews`, `INITIAL_CHARACTER_STATE`, `serializeView`, `parseView`, `parseEventsFile`, `CharacterState`
    - `grep -c "case '" src/ai/master/vault/projector.ts` returns ≥ 8 (one per event type)
    - `grep -c "structuredClone" src/ai/master/vault/projector.ts` returns ≥ 1 (immutability in reducer)
    - `grep -c "Date.now\\|Math.random\\|process.env" src/ai/master/vault/projector.ts` returns 0 (PURE reducer — no side effects)
    - `grep -c "_exhaustive: never" src/ai/master/vault/projector.ts` returns 1 (compile-time exhaustiveness check)
    - `pnpm typecheck` exits 0 (compile-time exhaustiveness passes — no unhandled union members)
  </acceptance_criteria>
  <done>
    Projector shipped. Plans 02-07 (dispatcher consumes regenerateAffectedViews) and 02-10 (vault-rebuild-views script consumes regenerateCharacterView) wire it in.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write projector.test.ts (determinism, clamps, corruption fail-fast, round-trip)</name>
  <files>tests/ai/master/vault/projector.test.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (the module under test — just created)
    - src/ai/master/vault/events-schema.ts (plan 02-01)
    - src/ai/master/vault/campaign-paths.ts (plan 02-02)
    - .planning/spikes/008-events-md-replay/replay.ts (canonical replay test — N=100 random events, expected state match, corruption fail-fast — mirror this)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Pitfall 6 — graceful degradation on unknown event types)
  </read_first>
  <action>
Create `tests/ai/master/vault/projector.test.ts`. Pure unit tests + integration tests against tmpdir filesystem. No DATABASE_URL required.

Test structure — one top-level `describe('projector')` with these nested describes:

1. **`describe('applyEvent — pure reducer per event type')`:** one `it` per event type, ~12 cases total:
   - hp_change positive delta: state hp_current goes up, clamped at hp_max
   - hp_change negative delta: hp_current goes down, clamped at 0
   - hp_change zero delta: no-op
   - condition_add new: condition appears in sorted array
   - condition_add duplicate: no double entry
   - condition_remove existing: condition removed
   - condition_remove non-existent: no-op
   - spell_slot_use: slot.used += 1
   - spell_slot_use at max: no-op (used does not exceed max)
   - spell_slot_restore: slot.used -= 1
   - spell_slot_restore at 0: no-op
   - inventory_add new item: appears with qty
   - inventory_add existing item: qty aggregates
   - inventory_remove partial: qty decreases
   - inventory_remove full: item disappears from inventory
   - inventory_remove non-existent: no-op

2. **`describe('applyEvent — purity')`:**
   - `it('does not mutate input state')` → call applyEvent on a state; assert original state unchanged after the call (structuredClone invariant)
   - `it('returns same output for same input')` → call applyEvent twice with deeply-equal inputs; assert results are deeply equal
   - `it('contains no Date.now / Math.random references in source')` → static `readFileSync` + regex check; assert source matches none of these patterns

3. **`describe('replayEvents — determinism')`:**
   - `it('reproduces exact final state across multiple replays')` — generate 100 random events (seed RNG with a fixed value for repeatability), build envelopes, call `replayEvents` twice, assert the two result Maps are deeply equal
   - `it('order matters')` — the same 10 events in two different orders produce different states (e.g., add 5 HP then take 10 damage vs take 10 damage then add 5)
   - `it('processes campaign_initialized as the first event correctly')` — seed event with two characters; subsequent events for both; assert both final states match expected
   - `it('logs and skips events for unseeded characters')` — events without a preceding seed → check `console.warn` is called via `vi.spyOn`; state map does not contain the unseeded id

4. **`describe('parseEventsFile — fail-fast on corruption (spike 008)')`:**
   - `it('parses a well-formed JSONL events.md')` — write a temp file with 5 valid JSON lines; assert parseEventsFile returns 5 envelopes
   - `it('returns empty array for empty file')` — write empty file; parseEventsFile returns `[]`
   - `it('returns empty array for missing file')` — point to non-existent path; parseEventsFile returns `[]` (spike 008 documented gracefully handling new-campaign-no-events case)
   - `it('throws on corrupt JSON line')` — write file with valid line + corrupt line + valid line; assert `await expect(parseEventsFile(path)).rejects.toThrow(/line 2/)` (the error message must include the offending line number — spike 008's fail-fast contract)

5. **`describe('regenerateCharacterView — disk roundtrip')`:**
   - Stub `VAULT_CAMPAIGNS_ROOT` env to a tmpdir.
   - `it('reads events.md → writes view file with replayed state')`:
     - Write a synthetic events.md with seed + 3 hp_change events
     - Call `regenerateCharacterView(campaignUuid, characterUuid)`
     - Read the resulting view file
     - Assert frontmatter contains the expected hp_current value
     - Assert the file lives at the expected `characters/<slug>-<id8>.md` path
   - `it('updates view atomically when called repeatedly')`:
     - First call writes view with state A
     - Append a 4th event
     - Second call writes view with state B (different hp)
     - Read the file; assert state B (no torn write between the two calls)
   - `it('creates parent directories if missing')` — call on a fresh tmpdir with no characters/ subdir; assert it's created

6. **`describe('serializeView + parseView round trip')`:**
   - `it('round-trips a minimal state')` — create a state with all-default fields; serialize; parse; deeply equal
   - `it('round-trips a state with all event types applied')` — start from INITIAL, apply one of each event type; serialize; parse; assert deeply equal (modulo trailing whitespace)
   - `it('serializes empty arrays/maps deterministically')` — empty conditions, empty inventory, empty spell_slots → predictable output
   - `it('byte-stable for the same input')` — call serializeView twice; assert string-equal (spike 013 byte-exact restore depends on this)

7. **`describe('regenerateAffectedViews — dispatcher hook')`:**
   - `it('regenerates one view for a single-character event')` — synthetic events.md + apply hp_change → regenerateAffectedViews fires regenerateCharacterView for that one character; other characters' views untouched
   - `it('regenerates all character views for a campaign_initialized event')` — seed payload with 3 characters → regenerateAffectedViews fires 3 regenerations

8. **`describe('graceful degradation on unknown event types (Pitfall 6)')`:**
   - Cast a fake event with type `'level_up'` (not in the union) to `VaultEvent` via `as any` and pass to `applyEvent`. Spy on `console.warn`. Assert: warn called, state returned unchanged. Documents that the projector won't throw on Phase 03+ event types it doesn't yet know about.

Setup/teardown:
- `beforeEach`: create tmpdir, `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', tmpdir)`, dynamic re-import of campaign-paths.ts so its module-load reads the stub. Use a fixed test campaign UUID + character UUID.
- `afterEach`: rmSync + `vi.unstubAllEnvs()`

Total: 8 describe blocks, ~35 `it` cases.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/projector.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~35 cases pass
    - The "throws on corrupt JSON line" test passes (spike 008 contract preserved)
    - The "byte-stable for the same input" test passes (spike 013 DR roundtrip depends on it)
    - The "graceful degradation on unknown event types" test passes (Pitfall 6)
    - `grep -c "structuredClone\\|deeply equal\\|toEqual" tests/ai/master/vault/projector.test.ts` returns ≥ 10 (purity + determinism coverage)
    - `unset DATABASE_URL; pnpm test tests/ai/master/vault/projector.test.ts` exits 0
    - Test runtime < 10 seconds
  </acceptance_criteria>
  <done>
    Projector regression-tested. Plans 02-07, 02-09, 02-10 layer integration on top.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/projector.test.ts` → all cases pass
- Command: `pnpm typecheck` → clean (exhaustiveness check enforced)
- Behavior smoke: write a 100-event events.md by hand, run `replayEvents` via a tsx one-liner, compare to expected — sanity check on the spike 008 replay equivalence
- Grep gate: `grep -c "console.warn\\|console.error" src/ai/master/vault/projector.ts` returns ≤ 2 (only the Pitfall 6 warn and the unseeded-character warn — no debug logging)

## Open questions

None — replay determinism + corruption fail-fast + view byte-stability are locked by spike 008 + spike 013. The exhaustiveness pattern is canonical TypeScript.
