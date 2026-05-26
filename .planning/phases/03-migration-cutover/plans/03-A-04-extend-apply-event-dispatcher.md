---
phase: 03
plan: A-04
type: execute
wave: 3
depends_on: [03-A-02]
files_modified:
  - src/ai/master/vault/tools.ts
  - tests/ai/master/vault/tools.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "The apply_event tool description in VAULT_TOOL_DEFINITIONS lists every Phase 03 event type alongside the Phase 02 types, with concise payload shape hints"
    - "dispatchVaultTool('apply_event', {type: 'temp_hp_set', payload: {character, tempHp}}, {campaignId}) succeeds end-to-end: validateEvent passes, EventsWriter appends, regenerateAffectedViews updates the view"
    - "dispatchVaultTool('apply_event', {type: 'death_save_fail', payload: {character, critical: true}}, {campaignId}) succeeds and the resulting events.md line round-trips to a CharacterState with death_saves.failures incremented by 2"
    - "All Phase 02 dispatch behavior is preserved (the existing 8 types continue to work with their existing payload contracts)"
  artifacts:
    - path: "src/ai/master/vault/tools.ts"
      provides: "Updated apply_event tool description with every Phase 03 type; dispatch path unchanged (validateEvent does the work)"
    - path: "tests/ai/master/vault/tools.test.ts"
      provides: "Dispatch-layer tests for every Phase 03 event type — happy path + reject malformed payload"
  key_links:
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/events-schema.ts (validateEvent, extended in 03-A-02)"
      via: "Dispatcher already calls validateEvent — new types flow through transparently"
      pattern: "validateEvent"
---

# Plan 03-A-04: Extend apply_event Dispatcher (Tool Description + Validation Coverage)

**Phase:** 03-migration-cutover
**Wave:** 3 (depends on 03-A-02 — needs the extended VaultEvent union)
**Status:** Pending
**Estimated diff size:** ~80 LOC source + ~150 LOC tests / 2 files

## Goal

Plan 03-A-02 extended `VaultEvent` + `validateEvent`. Plan 03-A-03 extended the projector. The `apply_event` tool dispatcher in `src/ai/master/vault/tools.ts` (shipped in Phase 02 plan 02-07) already calls `validateEvent` — so the NEW types FLOW through the dispatcher with zero code changes to the dispatch logic itself.

This plan does two small but load-bearing things:
1. **Updates the apply_event tool DESCRIPTION** so the LLM sees the new event types in the tool surface (currently lists only the 8 Phase 02 types).
2. **Adds dispatch-level smoke tests** for representative new event types — confirms the end-to-end path (validate → write → regenerate) works for the new types under the existing dispatch shape.

The LLM cannot use an event type it doesn't see in the tool description. Without updating the description, plan 03-A-09 (DualWriter) wires the parity-check infrastructure but the LLM never emits the new events.

## Requirements satisfied

- **REQ-006** — Completes the surface-update half of the audit closure: schema in 03-A-02, reducer in 03-A-03, tool description here.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/tools.ts` | EDIT | Update the apply_event tool `description` field (and optionally the `input_schema.properties.payload.description`) to enumerate the new event types |
| `tests/ai/master/vault/tools.test.ts` | EDIT (additive) | Dispatch-level happy-path + reject cases for representative new types |

## Tasks

<task type="auto">
  <name>Task 1: Update apply_event tool description in VAULT_TOOL_DEFINITIONS</name>
  <files>src/ai/master/vault/tools.ts</files>
  <read_first>
    - src/ai/master/vault/tools.ts (existing — VAULT_TOOL_DEFINITIONS array; the apply_event entry from Phase 02 plan 02-07; the description field lists 7 type names + brief payload hints)
    - src/ai/master/vault/events-schema.ts (plan 03-A-02 — VAULT_EVENT_TYPES + VaultEvent union; copy payload shapes from here verbatim)
    - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (full event-type taxonomy with payload semantics)
  </read_first>
  <action>
Edit `src/ai/master/vault/tools.ts`. Locate the `apply_event` entry in the `VAULT_TOOL_DEFINITIONS` array (from Phase 02 plan 02-07). The Phase 02 description listed 7 types: `hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove`.

**Change 1 — Update the `description` field.** Replace the Phase 02 description with a Phase 03 version that lists ALL event types from `VAULT_EVENT_TYPES` (8 original + Phase 03 additions). Keep it concise — the LLM has limited prompt budget for tool descriptions.

```ts
  {
    name: 'apply_event',
    description: 'Append a game-state mutation event (HP, conditions, slots, inventory, death saves, concentration, attunements, resources, XP, levels). Returns the new event_id on success. One event per call; do not batch.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Event type. One of: hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove, temp_hp_set, death_save_success, death_save_fail, death_save_stabilize, concentration_break, concentration_set, exhaustion_set, hit_dice_use, hit_dice_restore, attune, unattune, resource_use, inspiration_grant, inspiration_spend, xp_award, level_up.',
        },
        payload: {
          type: 'object',
          description: 'Event-specific data. `character` is the character UUID (the value of `id` in materialized view frontmatter — NOT the name). Per-type payloads: hp_change {character, delta:number}; condition_add/remove {character, condition:string}; spell_slot_use/restore {character, level:1-9}; inventory_add/remove {character, item:string, qty:1-999}; temp_hp_set {character, tempHp:number>=0}; death_save_success/stabilize {character}; death_save_fail {character, critical?:boolean}; concentration_set {character, spellSlug, slotLevel:1-9, startedRound:int}; concentration_break {character}; exhaustion_set {character, level:0-10}; hit_dice_use/restore {character, count:1-50}; attune/unattune {character, itemSlug}; resource_use {character, resourceKey:string, delta:int}; inspiration_grant/spend {character}; xp_award {character, amount:1-999999}; level_up {character, newLevel:1-20, classSlug?:string}.',
        },
      },
      required: ['type', 'payload'],
    },
  },
```

Match the actual (c) list from the audit — the above is the RESEARCH estimate. If the audit found fewer or different types, adjust.

NO changes to the dispatch logic in `dispatchVaultTool` — the `apply_event` branch already calls `validateEvent` which the plan 03-A-02 update extends transparently. The dispatcher does not need new switch arms.

**Change 2 (optional, recommended) — Update the tools.ts module JSDoc** to mention Phase 03's extension:

```ts
/**
 * ...existing JSDoc...
 *
 * Phase 03 extension — Decision 10 (Completeness Audit):
 *   The `apply_event` tool description now enumerates the extended event
 *   types from `COMPLETENESS-AUDIT.md`. The dispatcher itself does NOT
 *   need code changes — `validateEvent` (extended in plan 03-A-02)
 *   absorbs the new union members transparently.
 */
```
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/tools.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "temp_hp_set\|death_save_success\|death_save_fail\|concentration_set\|exhaustion_set\|hit_dice_use\|attune\|resource_use\|inspiration_grant\|xp_award\|level_up" src/ai/master/vault/tools.ts` returns ≥ 10 (Phase 03 types appear in the tool description)
    - The existing apply_event dispatch branch (the `if (name === 'apply_event')` block) is unchanged
    - The tool surface still has EXACTLY 4 tools (REQ-010 unchanged): `grep -c "name: '\(read_vault_multi\|list_vault\|apply_event\|end_turn\)'" src/ai/master/vault/tools.ts` returns 4
    - Phase 02 dispatch tests still pass
  </acceptance_criteria>
  <done>
    Tool description updated. Task 2 adds dispatch-level smoke tests for the new types.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add dispatch-level smoke tests for Phase 03 event types</name>
  <files>tests/ai/master/vault/tools.test.ts</files>
  <read_first>
    - tests/ai/master/vault/tools.test.ts (existing Phase 02 dispatch tests; the seed-campaign pattern; tmpdir stub for VAULT_CAMPAIGNS_ROOT)
    - src/ai/master/vault/tools.ts (Task 1 — updated description; dispatch logic unchanged)
    - src/ai/master/vault/projector.ts (plan 03-A-03 — INITIAL_CHARACTER_STATE for setup)
  </read_first>
  <action>
Append a new `describe('dispatchVaultTool — apply_event Phase 03 types')` block to `tests/ai/master/vault/tools.test.ts`. Use the same `seedCampaign` helper Phase 02 introduced — seed CHAR_UUID with hp_max:30.

For each representative new event type, add 1-2 dispatch cases:

```ts
describe('dispatchVaultTool — apply_event Phase 03 types', () => {
  const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
  const CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(async () => {
    // seed (as in Phase 02 plan 02-07 pattern)
    await seedCampaign(CAMPAIGN_UUID, [{ id: CHAR_UUID, name: 'Aragorn', hp_max: 30 }]);
  });

  it('temp_hp_set dispatch end-to-end', async () => {
    const r = await dispatchVaultTool('apply_event', {
      type: 'temp_hp_set',
      payload: { character: CHAR_UUID, tempHp: 5 },
    }, { campaignId: CAMPAIGN_UUID });
    expect(r.isError).toBe(false);
    // events.md has a new line
    const events = await readFile(eventsPath(CAMPAIGN_UUID), 'utf8');
    expect(events).toMatch(/"type":"temp_hp_set"/);
    // view file has updated temp_hp
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/temp_hp:\s*5/);
  });

  it('death_save_fail with critical: true increments failures by 2', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'death_save_fail',
      payload: { character: CHAR_UUID, critical: true },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/death_saves:\s*\{[^}]*"failures":\s*2/);
  });

  it('death_save_stabilize sets flags.stable = true', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'death_save_stabilize',
      payload: { character: CHAR_UUID },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/"stable":\s*true/);
  });

  it('concentration_set + concentration_break round-trip', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'concentration_set',
      payload: { character: CHAR_UUID, spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
    }, { campaignId: CAMPAIGN_UUID });
    let view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/"spellSlug":\s*"bless"/);

    await dispatchVaultTool('apply_event', {
      type: 'concentration_break',
      payload: { character: CHAR_UUID },
    }, { campaignId: CAMPAIGN_UUID });
    view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/concentrating_on:\s*null/);
  });

  it('exhaustion_set persists', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'exhaustion_set',
      payload: { character: CHAR_UUID, level: 3 },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/exhaustion_level:\s*3/);
  });

  it('attune + unattune are idempotent', async () => {
    // Two attune calls for the same item produce ONE entry
    await dispatchVaultTool('apply_event', {
      type: 'attune',
      payload: { character: CHAR_UUID, itemSlug: 'wand-of-fireballs' },
    }, { campaignId: CAMPAIGN_UUID });
    await dispatchVaultTool('apply_event', {
      type: 'attune',
      payload: { character: CHAR_UUID, itemSlug: 'wand-of-fireballs' },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/"wand-of-fireballs"/);
    // Count occurrences = 1
    const matches = (view.match(/"wand-of-fireballs"/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it('resource_use accumulates per-key', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'resource_use',
      payload: { character: CHAR_UUID, resourceKey: 'rage_uses', delta: 1 },
    }, { campaignId: CAMPAIGN_UUID });
    await dispatchVaultTool('apply_event', {
      type: 'resource_use',
      payload: { character: CHAR_UUID, resourceKey: 'rage_uses', delta: 1 },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/"rage_uses":\s*2/);
  });

  it('xp_award + level_up sequence', async () => {
    await dispatchVaultTool('apply_event', {
      type: 'xp_award',
      payload: { character: CHAR_UUID, amount: 300 },
    }, { campaignId: CAMPAIGN_UUID });
    await dispatchVaultTool('apply_event', {
      type: 'level_up',
      payload: { character: CHAR_UUID, newLevel: 2 },
    }, { campaignId: CAMPAIGN_UUID });
    const view = await readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID), 'utf8');
    expect(view).toMatch(/xp:\s*300/);
    expect(view).toMatch(/level:\s*2/);
  });

  it('rejects malformed payload for new type (e.g., death_save_fail with non-boolean critical)', async () => {
    const r = await dispatchVaultTool('apply_event', {
      type: 'death_save_fail',
      payload: { character: CHAR_UUID, critical: 'yes' as unknown as boolean },
    }, { campaignId: CAMPAIGN_UUID });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/critical/i);
  });

  it('rejects unknown event type (e.g., a typo)', async () => {
    const r = await dispatchVaultTool('apply_event', {
      type: 'tempHpSet',  // wrong format
      payload: { character: CHAR_UUID, tempHp: 5 },
    }, { campaignId: CAMPAIGN_UUID });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/unknown event type/i);
  });

  it('tool definition description includes Phase 03 types', () => {
    const apply = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event')!;
    expect(apply.description).toMatch(/HP|conditions|slots|inventory/);  // Phase 02 categories
    expect(apply.input_schema.properties.payload.description).toMatch(/temp_hp_set/);
    expect(apply.input_schema.properties.payload.description).toMatch(/death_save_/);
    expect(apply.input_schema.properties.payload.description).toMatch(/concentration_/);
    expect(apply.input_schema.properties.payload.description).toMatch(/exhaustion_set/);
  });
});
```

Total ~10-12 new it() blocks. The seedCampaign helper is the one introduced in Phase 02 plan 02-07; just call it.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/tools.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All Phase 01 + 02 tools.test.ts cases still pass (~45 from Phase 02)
    - All Phase 03 new cases pass (10-12 new blocks)
    - The "tool definition description includes Phase 03 types" assertion passes
    - `grep -c "type: 'temp_hp_set'\|type: 'death_save_\|type: 'concentration_\|type: 'exhaustion_set'\|type: 'attune'\|type: 'resource_use'\|type: 'xp_award'\|type: 'level_up'" tests/ai/master/vault/tools.test.ts` returns ≥ 8
    - Test runtime stays < 15s
  </acceptance_criteria>
  <done>
    Dispatcher fully wired for Phase 03 event types. The LLM can now emit any of the new types via apply_event.
  </done>
</task>
