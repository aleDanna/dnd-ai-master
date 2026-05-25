---
phase: 02
plan: 07
type: execute
wave: 3
depends_on: [02-01, 02-02, 02-03, 02-04, 02-05, 02-06]
files_modified:
  - src/ai/master/vault/tools.ts
  - src/ai/master/vault/index.ts
  - src/ai/master/vault/loop.ts
  - tests/ai/master/vault/tools.test.ts
  - tests/ai/master/vault/loop.test.ts
  - tests/ai/master/vault/phase-smoke.test.ts
  - tests/sessions/turn-route-branch.test.ts
  - tests/ai/master/vault/apply-event-integration.test.ts
autonomous: true
requirements: [REQ-005, REQ-010]
must_haves:
  truths:
    - "VAULT_TOOL_DEFINITIONS has exactly 4 entries: read_vault_multi, list_vault, apply_event, end_turn (REQ-010 fully satisfied)"
    - "dispatchVaultTool('apply_event', {type:'hp_change', payload:{character:'<uuid>', delta:-5}}, {campaignId}) → appends one JSONL line to events.md AND regenerates the character view"
    - "dispatchVaultTool('apply_event', ...) without campaignId in ctx returns isError:true with a clear error message"
    - "dispatchVaultTool('apply_event', {type:'unknown', payload:{}}) returns isError:true via the events-schema type guard"
    - "VaultDispatchContext now accepts an optional campaignId field, passed through from the loop"
    - "runVaultToolLoop forwards ctx.campaignId from VaultLoopInput.campaignId into dispatchVaultTool calls"
    - "The phase-smoke test inverts the Phase 01 assertion: VAULT_TOOL_DEFINITIONS.length === 4 AND names include 'apply_event'"
    - "tests/sessions/turn-route-branch.test.ts is inverted: the 3-tool describe block becomes a 4-tool describe block; .toBe(3) becomes .toBe(4); 'exposes the three Phase 01 tools' check is extended to include apply_event"
    - "The barrel export src/ai/master/vault/index.ts re-exports EventsWriter, validateEvent, applyEvent (from projector), eventsPath, characterViewPath, resolveVaultMutations"
    - "The apply_event tool description (in VAULT_TOOL_DEFINITIONS) explicitly states `character` is a UUID, not a character name"
  artifacts:
    - path: "src/ai/master/vault/tools.ts"
      provides: "Extended VAULT_TOOL_DEFINITIONS (4 tools) + dispatchVaultTool apply_event branch"
      contains: "apply_event"
    - path: "src/ai/master/vault/loop.ts"
      provides: "VaultLoopInput.campaignId added; forwarded to dispatchVaultTool ctx"
      contains: "campaignId"
    - path: "tests/ai/master/vault/apply-event-integration.test.ts"
      provides: "End-to-end: tool call → events.md line → view file regeneration → DR roundtrip"
    - path: "tests/sessions/turn-route-branch.test.ts"
      provides: "Inverted from Phase 01's 3-tool assertion to Phase 02's 4-tool assertion"
      contains: "apply_event"
  key_links:
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/events-writer.ts (plan 02-03)"
      via: "EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope)"
      pattern: "EventsWriter\\.applyEvent"
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/projector.ts (plan 02-04)"
      via: "regenerateAffectedViews(ctx.campaignId, envelope) called synchronously after append"
      pattern: "regenerateAffectedViews"
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/events-schema.ts (plan 02-01)"
      via: "validateEvent(input) gates the dispatch before any write"
      pattern: "validateEvent"
    - from: "src/ai/master/vault/loop.ts"
      to: "src/ai/master/vault/tools.ts"
      via: "VaultDispatchContext.campaignId forwarded from VaultLoopInput.campaignId"
      pattern: "campaignId"
---

# Plan 02-07: apply_event Tool (Dispatch + Integration)

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 3 (depends on all Wave 1 + Wave 2 plans — this is the integration step that ties EventsWriter + projector + schema + campaign-paths + cap-bump together)
**Status:** Pending
**Estimated diff size:** ~200 LOC source + ~165 LOC tests / 8 files

## Goal

Extend the Phase 01 vault tool surface from 3 tools to 4 by adding `apply_event`. This is the LOAD-BEARING integration plan — every Wave 1 and Wave 2 plan exists to be consumed here.

The `apply_event` tool:
1. **Tool definition** added to `VAULT_TOOL_DEFINITIONS` array in `src/ai/master/vault/tools.ts`. Description wording from RESEARCH §6 (matches `.claude/skills/spike-findings-dnd-ai-master/references/tool-surface.md`), extended with an explicit "character is a UUID, not a name" clarification (NIT 1 — names are not unique across campaigns; the dispatcher rejects non-UUID character payloads at the validation step indirectly via downstream projector lookup, and the prompt mention in plan 02-08 reinforces this for the LLM).
2. **Dispatch branch** added to `dispatchVaultTool` switch. Validates input via `validateEvent` (plan 02-01), constructs the canonical envelope `{id, version, type, payload, timestamp}`, calls `EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope)` (plan 02-03), then `regenerateAffectedViews(ctx.campaignId, envelope)` (plan 02-04). Returns `{content: JSON.stringify({ok: true, event_id: envelope.id}), isError: false}` per Decision 3.
3. **VaultDispatchContext extension** — add optional `campaignId?: string` field. Without it, `apply_event` returns isError. (Phase 01's read-only tools don't need it — they continue working when ctx is `{vaultRoot}` alone.)
4. **VaultLoopInput extension** — add optional `campaignId?: string` field. The loop forwards it into the dispatch context. The turn route (plan 02-08) passes `campaign.id` from the resolved snapshot.
5. **Read path Decision 4 extension** — `dispatchVaultTool('read_vault_multi', …)` learns to route `/campaigns/<id>/…` paths to `VAULT_CAMPAIGNS_ROOT`. Phase 01's `safeVaultPath(input, root)` already accepts an optional root parameter; this plan promotes it from test seam to production use. The dispatcher inspects the incoming path: if it starts with `/campaigns/`, resolve under `VAULT_CAMPAIGNS_ROOT`; otherwise under `VAULT_ROOT`.
6. **Barrel export** — `src/ai/master/vault/index.ts` re-exports the new modules (EventsWriter, validateEvent, applyEvent, eventsPath, characterViewPath, etc.) so the phase-smoke test passes.
7. **Phase smoke test** — invert the Phase 01 assertion: `VAULT_TOOL_DEFINITIONS.length === 4` AND `names.includes('apply_event')`.
8. **Turn-route branch test inversion (BLOCKER 2 mitigation)** — `tests/sessions/turn-route-branch.test.ts` lines ~88-112 contain a 3-tool-surface assertion that must be inverted in the same commit set, otherwise plan 02-07 lands with a failing pre-existing test. Task 8 below ships the explicit inversion.

Per phase Decision 8 (single-write to events.md only — Postgres untouched for opted-in campaigns), the dispatch branch does NOT touch the Postgres `characters` table. Plan 02-08 handles the UI staleness banner; this plan stays focused on the vault-write-path proper.

## Requirements satisfied

- **REQ-005** EventsWriter mutex — this plan wires the writer into the dispatch path; the only legitimate writer to events.md in the codebase is now `EventsWriter.applyEvent` called from this dispatch branch.
- **REQ-010** 4-tool surface — this plan CLOSES REQ-010 (Phase 01 shipped 3; this plan adds the 4th).

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/tools.ts` | EDIT | Add 4th tool def + apply_event dispatch branch + read_vault_multi root routing. |
| `src/ai/master/vault/index.ts` | EDIT | Add barrel exports for new modules. |
| `src/ai/master/vault/loop.ts` | EDIT | Add VaultLoopInput.campaignId + forward to dispatch ctx. |
| `tests/ai/master/vault/tools.test.ts` | EDIT | Extend with apply_event dispatch cases. |
| `tests/ai/master/vault/loop.test.ts` | EDIT | Add apply_event branch case. |
| `tests/ai/master/vault/phase-smoke.test.ts` | EDIT | Invert "no apply_event" → "has apply_event"; bump count 3 → 4. |
| `tests/sessions/turn-route-branch.test.ts` | EDIT | Invert the 3-tool describe block lines ~88-112 to the 4-tool form (BLOCKER 2). |
| `tests/ai/master/vault/apply-event-integration.test.ts` | NEW | End-to-end: dispatch → events.md → view file + DR roundtrip + property test. |

## Tasks

<task type="auto">
  <name>Task 1: Extend tools.ts — add apply_event definition + dispatch branch + root routing</name>
  <files>src/ai/master/vault/tools.ts</files>
  <read_first>
    - src/ai/master/vault/tools.ts (existing — Phase 01 implementation; lines 17-58 = current 3-tool array; lines 76-86 = VaultDispatchContext + VaultDispatchResult interfaces; lines 92-140 = dispatchVaultTool switch)
    - src/ai/master/vault/events-schema.ts (plan 02-01 — VaultEvent union + validateEvent)
    - src/ai/master/vault/events-writer.ts (plan 02-03 — EventsWriter.applyEvent)
    - src/ai/master/vault/projector.ts (plan 02-04 — regenerateAffectedViews + VaultEventEnvelope)
    - src/ai/master/vault/campaign-paths.ts (plan 02-02 — eventsPath, UUID_REGEX)
    - src/ai/master/vault/path.ts (existing — safeVaultPath signature accepts `root` parameter; VAULT_ROOT and VAULT_CAMPAIGNS_ROOT exports)
    - .claude/skills/spike-findings-dnd-ai-master/references/tool-surface.md (lines 64-77 — canonical apply_event description wording to copy verbatim)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§6 Code Examples — apply_event tool definition; apply_event dispatch branch)
    - .planning/phases/02-vault-write-path-event-sourcing/PLAN.md (Decision 3 — return shape `{ok:true, event_id}` minimal; Decision 4 — read_vault_multi root routing)
  </read_first>
  <action>
Edit `src/ai/master/vault/tools.ts` (preserve everything else verbatim). Six changes:

**Change 1 — Update imports.** Top of file. Add:
```ts
import { randomUUID } from 'node:crypto';
import { validateEvent, EVENT_SCHEMA_VERSION, type VaultEventEnvelope } from './events-schema';
import { EventsWriter } from './events-writer';
import { regenerateAffectedViews } from './projector';
import { eventsPath, UUID_REGEX } from './campaign-paths';
import { VAULT_CAMPAIGNS_ROOT } from './path';
```

**Change 2 — Add `apply_event` to VAULT_TOOL_DEFINITIONS.** Locate the array (lines 17-58). The trailing comment `// apply_event is Phase 02 — intentionally omitted` (line 58) should be REPLACED with the 4th tool entry. Insert before the closing `];`:

```ts
  {
    name: 'apply_event',
    description: 'Append a game-state mutation event (HP change, condition add, slot use, inventory change, etc.). Returns the new event_id on success. One event per call; do not batch.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Event type. One of: hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove.',
        },
        payload: {
          type: 'object',
          description: 'Event-specific data. The `character` field is the character UUID (the value of `id` in the materialized view frontmatter — NOT the character name; names are not unique across campaigns). For hp_change: {character: <uuid>, delta: number}. For condition_add/remove: {character: <uuid>, condition: string}. For spell_slot_use/restore: {character: <uuid>, level: number (1-9)}. For inventory_add/remove: {character: <uuid>, item: string, qty: positive integer < 1000}.',
        },
      },
      required: ['type', 'payload'],
    },
  },
```

Remove the now-stale Phase 01 comment.

**Change 3 — Extend VaultDispatchContext.** Locate the interface (line 76-78). Replace with:

```ts
export interface VaultDispatchContext {
  vaultRoot?: string;
  /**
   * Campaign UUID — required for `apply_event` (the dispatch branch resolves
   * paths under `VAULT_CAMPAIGNS_ROOT/<campaignId>/`). Phase 01 read-only
   * tools (read_vault_multi, list_vault, end_turn) ignore this field.
   *
   * Phase 02 — locked by REQ-007 (per-campaign storage outside repo) and
   * T-02-01/T-02-07 mitigations (server-side-only campaignId; LLM cannot
   * supply this).
   */
  campaignId?: string;
}
```

**Change 4 — Extend read_vault_multi dispatch with root routing (Decision 4).** Inside the `if (name === 'read_vault_multi') { ... }` block, the current implementation uses `readVaultFile(pathStr, vaultRoot)`. Update the per-path read to inspect the path prefix and route under VAULT_CAMPAIGNS_ROOT when appropriate:

```ts
// Before reading: pick the right root based on path prefix (Decision 4).
// /campaigns/<id>/... → VAULT_CAMPAIGNS_ROOT
// everything else      → VAULT_ROOT (or test override via ctx.vaultRoot)
const stripped = pathStr.replace(/^\/+/, '');
const isCampaignPath = stripped.startsWith('campaigns/');
const effectiveRoot = isCampaignPath ? VAULT_CAMPAIGNS_ROOT : vaultRoot;  // vaultRoot may be undefined; readVaultFile handles fallback
// For campaign paths, strip the /campaigns/ prefix because VAULT_CAMPAIGNS_ROOT IS the campaigns/ root.
const effectivePath = isCampaignPath ? '/' + stripped.slice('campaigns/'.length) : pathStr;
const content = await readVaultFile(effectivePath, effectiveRoot);
entries.push({ path: pathStr, content });  // keep ORIGINAL path in the result for LLM legibility
```

The test override (`ctx.vaultRoot`) still works for Phase 01 cases. Phase 02 campaign reads route to VAULT_CAMPAIGNS_ROOT transparently — the LLM types `/campaigns/<id>/characters/aragorn-<id8>.md`, the dispatcher resolves under VAULT_CAMPAIGNS_ROOT, the result has the LLM's original path in the `### <path>` heading.

**Change 5 — Apply the same root routing to list_vault.** Inside the `if (name === 'list_vault') { ... }` block, mirror the prefix check:

```ts
const stripped = (raw.directory as string).replace(/^\/+/, '');
const isCampaignPath = stripped.startsWith('campaigns/');
const effectiveRoot = isCampaignPath ? VAULT_CAMPAIGNS_ROOT : vaultRoot;
const effectivePath = isCampaignPath ? '/' + stripped.slice('campaigns/'.length) : (raw.directory as string);
const children = await listVaultDir(effectivePath, effectiveRoot);
```

**Change 6 — Add the apply_event dispatch branch.** Inside `dispatchVaultTool`, AFTER the `end_turn` branch and BEFORE the final `return { content: 'ERROR: unknown vault tool: ' + name, isError: true };`, insert:

```ts
  if (name === 'apply_event') {
    const raw = (input ?? {}) as { type?: unknown; payload?: unknown };
    if (typeof raw.type !== 'string' || typeof raw.payload !== 'object' || raw.payload === null) {
      return { content: 'ERROR: apply_event requires {type: string, payload: object}', isError: true };
    }
    if (!ctx?.campaignId) {
      return { content: 'ERROR: apply_event requires campaignId in dispatch context (server-side; cannot be supplied by LLM)', isError: true };
    }
    if (!UUID_REGEX.test(ctx.campaignId)) {
      return { content: `ERROR: apply_event campaignId is not a valid UUID: ${ctx.campaignId}`, isError: true };
    }

    // Validate event shape (hand-rolled type guard, no zod — Decision 1).
    const guarded = validateEvent({ type: raw.type, payload: raw.payload as Record<string, unknown> });
    if (!guarded.ok) {
      return { content: `ERROR: ${guarded.error}`, isError: true };
    }

    // Build the canonical event envelope. Timestamp is metadata only —
    // the projector is PURE and does not consume it. The version field
    // allows Phase 03+ schema migrations per spike 008.
    const envelope: VaultEventEnvelope = {
      id: randomUUID(),
      version: EVENT_SCHEMA_VERSION,
      type: guarded.value.type,
      payload: guarded.value.payload,
      timestamp: new Date().toISOString(),
    };

    try {
      // Persist (mutex-serialized — spike 010 pattern).
      await EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope);
      // Regenerate the affected view synchronously (Decision 2 — cheap; <5ms typical).
      await regenerateAffectedViews(ctx.campaignId, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: apply_event failed during persist: ${message}`, isError: true };
    }

    // Minimal success envelope (Decision 3 — preserves prefix-cache hygiene).
    return { content: JSON.stringify({ ok: true, event_id: envelope.id }), isError: false };
  }
```

That's the dispatch branch. Notice:
- The function NEVER throws; all errors surface as `isError: true` marker strings (per Phase 01 contract).
- The catch-all error message includes the original Error message — useful for debugging in dev, surfaced to the LLM as a tool result so it can self-correct.
- The mutex AND the projector both run BEFORE returning to the model. After the return, the next iteration of the loop will see the materialized view file updated (if the model issues a follow-up `read_vault_multi` for the character).

Update the module-level JSDoc at the top of `tools.ts` to: "Phase 02 closed the 4th tool — REQ-010 fully satisfied (Phase 01 shipped 3; Phase 02 added apply_event)."
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/tools.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "name: 'apply_event'" src/ai/master/vault/tools.ts` returns exactly 1
    - `grep -c "VAULT_TOOL_DEFINITIONS" src/ai/master/vault/tools.ts` returns ≥ 2
    - `grep -c "EventsWriter.applyEvent" src/ai/master/vault/tools.ts` returns exactly 1
    - `grep -c "regenerateAffectedViews" src/ai/master/vault/tools.ts` returns exactly 1
    - `grep -c "validateEvent" src/ai/master/vault/tools.ts` returns exactly 1
    - `grep -c "campaignId" src/ai/master/vault/tools.ts` returns ≥ 5 (interface field + multiple usages in dispatch)
    - `grep -c "isCampaignPath" src/ai/master/vault/tools.ts` returns ≥ 2 (read_vault_multi + list_vault branches)
    - `grep -c "character UUID\|NOT the character name" src/ai/master/vault/tools.ts` returns ≥ 1 (NIT 1: tool description clarifies UUID-vs-name)
    - The Phase 01 comment `// apply_event is Phase 02 — intentionally omitted` is GONE
    - `pnpm typecheck` exits 0
    - VAULT_TOOL_DEFINITIONS.length === 4 (verified by the smoke test in Task 5)
  </acceptance_criteria>
  <done>
    apply_event lives in the tool surface and dispatches correctly. Tasks 2-8 add the loop wiring + tests + barrel export + branch-test inversion.
  </done>
</task>

<task type="auto">
  <name>Task 2: Extend loop.ts — forward campaignId to dispatch context</name>
  <files>src/ai/master/vault/loop.ts</files>
  <read_first>
    - src/ai/master/vault/loop.ts (existing — VaultLoopInput interface lines 39-56; ctx assembly in dispatchVaultTool calls at lines 139, 186)
    - src/ai/master/vault/tools.ts (Task 1 — VaultDispatchContext now has campaignId field)
  </read_first>
  <action>
Edit `src/ai/master/vault/loop.ts`. Three changes:

**Change 1 — Add campaignId to VaultLoopInput.** Inside the interface (line 39-56), AFTER `vaultRoot?: string;`, add:

```ts
  /**
   * Campaign UUID — required for `apply_event` (Phase 02). Forwarded into
   * `dispatchVaultTool` as `ctx.campaignId`. When undefined, apply_event
   * calls from the LLM return isError. Phase 01 read-only flows omit this
   * and continue working.
   */
  campaignId?: string;
```

**Change 2 — Destructure in the function body.** Locate the destructuring around line 67-77. Add `campaignId` to the list:
```ts
const {
  provider,
  model,
  systemBlocks,
  history,
  vaultRoot,
  campaignId,           // NEW
  recordUsage,
  onEvent,
  sessionId,
  campaignLanguage,
} = input;
```

**Change 3 — Forward campaignId in both dispatchVaultTool calls.** Locate the existing calls (line ~139 for end_turn, line ~186 for the tool_uses loop). Update both to include `campaignId`:

```ts
// end_turn case
const result = await dispatchVaultTool('end_turn', endTurnCall.input, { vaultRoot, campaignId });
```

```ts
// general tool_use loop
const result = await dispatchVaultTool(tu.name, tu.input, { vaultRoot, campaignId });
```

That's all — minimal pass-through. The loop does NOT call EventsWriter or the projector directly; the dispatcher owns those calls.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/loop.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "campaignId" src/ai/master/vault/loop.ts` returns ≥ 4 (interface field + destructure + 2 dispatch calls)
    - `pnpm typecheck` exits 0
    - Phase 01's loop tests still pass (the field is OPTIONAL — existing tests omit it; behavior unchanged for read-only tools)
  </acceptance_criteria>
  <done>
    Loop forwards the campaign id. Plan 02-08 passes it from the turn route.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update barrel export src/ai/master/vault/index.ts</name>
  <files>src/ai/master/vault/index.ts</files>
  <read_first>
    - src/ai/master/vault/index.ts (existing — Phase 01 barrel)
    - tests/ai/master/vault/phase-smoke.test.ts (will be updated in Task 5 — defines the public surface contract)
  </read_first>
  <action>
Edit `src/ai/master/vault/index.ts` to add Phase 02 exports. Add `export * from './<module>';` lines for each new module:

```ts
export * from './events-schema';        // VaultEvent, VaultEventEnvelope, validateEvent, ...
export * from './events-writer';        // EventsWriter
export * from './projector';            // applyEvent, replayEvents, regenerateCharacterView, ...
export * from './campaign-paths';       // campaignDir, eventsPath, characterViewPath, slugifyCharacterName, UUID_REGEX, ...
```

Re-export the resolver too (it lives outside vault/ but is part of the public surface the consumers use to gate dispatch):

```ts
// Re-export from preferences for convenience (the Phase 02 dispatch surface
// is gated on this resolver from src/lib/preferences.ts).
export { resolveVaultMutations } from '@/lib/preferences';
```

Order the exports lexically grouped: existing (path, prompt-builder, tools, loop), then Phase 02 (events-schema, events-writer, projector, campaign-paths), then cross-module convenience (resolveVaultMutations).

Don't remove any existing exports.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/phase-smoke.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "events-schema\\|events-writer\\|projector\\|campaign-paths" src/ai/master/vault/index.ts` returns ≥ 4
    - `grep -c "resolveVaultMutations" src/ai/master/vault/index.ts` returns ≥ 1
    - `pnpm typecheck` exits 0
    - The Phase 01 phase-smoke test (post-Task 5 update) imports symbols via the barrel and they all resolve
  </acceptance_criteria>
  <done>
    Barrel updated. All Phase 02 modules importable via `@/ai/master/vault`.
  </done>
</task>

<task type="auto">
  <name>Task 4: Extend tests/ai/master/vault/tools.test.ts with apply_event dispatch cases</name>
  <files>tests/ai/master/vault/tools.test.ts</files>
  <read_first>
    - tests/ai/master/vault/tools.test.ts (existing — Phase 01 cases; the pattern for tmpdir setup, dispatchVaultTool invocations, error-marker assertions)
    - src/ai/master/vault/tools.ts (Task 1 — the apply_event dispatch branch)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§Security §V5 Input Validation — payload injection cases to cover; T-02-04, T-02-05, T-02-07 in PLAN.md threat model)
  </read_first>
  <action>
Edit `tests/ai/master/vault/tools.test.ts` (extend; preserve all Phase 01 cases verbatim).

Add a new top-level `describe('dispatchVaultTool — apply_event (Phase 02)')` block with these nested describes:

1. **`describe('tool definition shape')`:**
   - `it('VAULT_TOOL_DEFINITIONS has 4 entries (Phase 02 closes REQ-010)')` → `expect(VAULT_TOOL_DEFINITIONS).toHaveLength(4)`
   - `it('the 4th entry is apply_event with the canonical schema')`:
     ```ts
     const apply = VAULT_TOOL_DEFINITIONS.find(t => t.name === 'apply_event');
     expect(apply).toBeDefined();
     expect(apply.description).toMatch(/Append a game-state mutation event/);
     expect(apply.input_schema.required).toEqual(['type', 'payload']);
     ```
   - `it('the apply_event tool description clarifies that character is a UUID (NIT 1)')`:
     ```ts
     const apply = VAULT_TOOL_DEFINITIONS.find(t => t.name === 'apply_event');
     expect(apply.input_schema.properties.payload.description).toMatch(/character UUID|character.+UUID|NOT the character name/i);
     ```
   - `it('lists all 4 tools by name in expected order')` → `expect(VAULT_TOOL_DEFINITIONS.map(t => t.name)).toEqual(['read_vault_multi', 'list_vault', 'end_turn', 'apply_event'])` (or whatever the Task 1 ordering produced — match the source verbatim)

2. **`describe('apply_event happy path')`:**
   - Setup: `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', tmpdir)`, dynamic re-import. Use `const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';` and `const CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`.
   - First, seed the campaign with a `campaign_initialized` event so subsequent `hp_change` has a valid character state to apply to. Use the schema-reality shape: `{characters: [{id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30}]}` (hp_current present; spell_slots omitted — non-caster fixture).
   - `it('appends one event to events.md and returns {ok, event_id}')`:
     ```ts
     const result = await dispatchVaultTool('apply_event', {
       type: 'hp_change',
       payload: { character: CHAR_UUID, delta: -5 },
     }, { campaignId: CAMPAIGN_UUID });
     expect(result.isError).toBe(false);
     const parsed = JSON.parse(result.content);
     expect(parsed.ok).toBe(true);
     expect(parsed.event_id).toMatch(/^[0-9a-f]{8}-/);  // UUIDv4 shape
     const eventsContent = await readFile(eventsPath(CAMPAIGN_UUID), 'utf8');
     const lines = eventsContent.trim().split('\n');
     expect(lines.length).toBeGreaterThanOrEqual(2);  // seed + hp_change
     const lastEvent = JSON.parse(lines[lines.length - 1]);
     expect(lastEvent.type).toBe('hp_change');
     expect(lastEvent.payload.delta).toBe(-5);
     ```
   - `it('regenerates the character view synchronously')`:
     - After the apply_event above, `readFile(characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID))` returns content; assert frontmatter contains the post-event hp_current value.

3. **`describe('apply_event input validation (no write on error)')`:**
   - `it('rejects missing campaignId in ctx')` → call without `{campaignId}`; assert isError + message contains "campaignId"
   - `it('rejects non-UUID campaignId in ctx')` → `{campaignId: 'not-a-uuid'}`; assert isError + message
   - `it('rejects non-string type')` → `{type: 123, payload: {}}`; assert isError + message contains "string"
   - `it('rejects missing payload')` → `{type: 'hp_change'}` (no payload key); assert isError + message contains "object"
   - `it('rejects null payload')` → `{type: 'hp_change', payload: null}`; assert isError
   - `it('rejects unknown event type via validateEvent')` → `{type: 'unknown', payload: {}}`; assert isError + message references the validation error
   - `it('rejects malformed payload')` → `{type: 'hp_change', payload: {character: CHAR_UUID, delta: 'five'}}` (string delta); assert isError
   - **`it('does NOT touch events.md when validation fails')`**: call with malformed input; then `existsSync(eventsPath(CAMPAIGN_UUID))` returns false (or the file has the same content as before — depending on whether the seed ran first). The KEY invariant: validation errors short-circuit BEFORE EventsWriter.applyEvent.

4. **`describe('apply_event path-traversal defenses (T-02-04/T-02-05/T-02-07)')`:**
   - `it('rejects campaignId that is a traversal sequence')` → `{campaignId: '../../etc/passwd'}`; isError + message
   - `it('character-name field is the character UUID (LLM-supplied), but the materialized view path is computed server-side from the seed-event metadata')` — this is a documentation test: seed with a character whose name has `../../etc/passwd`; apply hp_change; assert the view path lives under campaignDir (it would be `characters/etc-passwd-<id8>.md` per the slug helper).

5. **`describe('read_vault_multi routes /campaigns/ to VAULT_CAMPAIGNS_ROOT (Decision 4)')`:**
   - Setup: stub both VAULT_ROOT and VAULT_CAMPAIGNS_ROOT to different tmpdirs. Seed a file under VAULT_CAMPAIGNS_ROOT/<campaignUuid>/characters/aragorn-<id8>.md with known content. Seed a file under VAULT_ROOT/handbook/test.md with different content.
   - `it('a /campaigns/ path reads from VAULT_CAMPAIGNS_ROOT')`:
     ```ts
     const result = await dispatchVaultTool('read_vault_multi', {
       paths: [`/campaigns/${CAMPAIGN_UUID}/characters/aragorn-${CHAR_UUID.slice(0,8)}.md`]
     }, { campaignId: CAMPAIGN_UUID });
     expect(result.content).toContain('frontmatter-from-campaigns-root');
     ```
   - `it('a /handbook/ path reads from VAULT_ROOT')`:
     ```ts
     const result = await dispatchVaultTool('read_vault_multi', {
       paths: ['/handbook/test.md']
     }, {});
     expect(result.content).toContain('content-from-vault-root');
     ```
   - `it('an unknown campaigns path returns the not-found marker')` — request a path that doesn't exist under VAULT_CAMPAIGNS_ROOT; assert result content includes 'ERROR: file not found' for that entry but isError remains false.

6. **`describe('list_vault routes /campaigns/ similarly')`:**
   - `it('lists characters/ under VAULT_CAMPAIGNS_ROOT/<id>/')` — after seeding two view files, `dispatchVaultTool('list_vault', {directory: `/campaigns/${CAMPAIGN_UUID}/characters`})` returns the two filenames.

Total: 6 describe blocks, ~19 new `it` cases (added to existing Phase 01 cases).

The seed-event preparation can be factored into a helper `seedCampaign(campaignId, characters)` at the top of the new describe block. Use the OPTIONAL-fields shape from plan 02-01 — `hp_current` and `spell_slots` may be omitted depending on the fixture.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/tools.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All Phase 01 cases still pass (~25 from plan 01-03 stay green)
    - All new Phase 02 cases pass (~19)
    - The "does NOT touch events.md when validation fails" test exists and passes
    - The "lists 4 tools in expected order" test exists and passes
    - The "the apply_event tool description clarifies that character is a UUID (NIT 1)" test exists and passes
    - The Decision 4 root routing tests exist and pass
    - `grep -c "apply_event" tests/ai/master/vault/tools.test.ts` returns ≥ 15
    - `grep -c "VAULT_TOOL_DEFINITIONS" tests/ai/master/vault/tools.test.ts` returns ≥ 4 (Phase 01 cases + Phase 02 length + ordering)
  </acceptance_criteria>
  <done>
    Tool dispatcher regression-tested end-to-end. Task 7 layers the integration test on top.
  </done>
</task>

<task type="auto">
  <name>Task 5: Update phase-smoke.test.ts — invert the Phase 01 assertion</name>
  <files>tests/ai/master/vault/phase-smoke.test.ts</files>
  <read_first>
    - tests/ai/master/vault/phase-smoke.test.ts (existing — Phase 01 smoke test; specifically the `toHaveLength(3)` assertion and the "no tool named apply_event" assertion to invert)
  </read_first>
  <action>
Edit `tests/ai/master/vault/phase-smoke.test.ts`. Three changes:

**Change 1 — Bump the tool-count assertion.** Current:
```ts
expect(mod.VAULT_TOOL_DEFINITIONS).toHaveLength(3);
```
Replace with:
```ts
expect(mod.VAULT_TOOL_DEFINITIONS).toHaveLength(4);  // Phase 02 adds apply_event
```

**Change 2 — Replace the negative assertion with a positive one.** Current (last `it` block):
```ts
it('no tool named `apply_event` (Phase 01 scope — Phase 02 will add it)', async () => {
  const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
  const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
  expect(names).not.toContain('apply_event');
});
```
Replace with:
```ts
it('tool named `apply_event` is present (Phase 02 closes REQ-010)', async () => {
  const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
  const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
  expect(names).toContain('apply_event');
});
```

**Change 3 — Add new smoke assertions for Phase 02 modules.** Inside the existing `it('imports all public symbols from the barrel', ...)` block, AFTER the Loop (plan 04) section, add:

```ts
    // Phase 02 — Events schema (plan 02-01)
    expect(typeof mod.validateEvent).toBe('function');
    expect(Array.isArray(mod.VAULT_EVENT_TYPES)).toBe(true);
    expect(mod.VAULT_EVENT_TYPES).toContain('hp_change');
    expect(typeof mod.EVENT_SCHEMA_VERSION).toBe('number');
    // Phase 02 — Campaign paths (plan 02-02)
    expect(typeof mod.eventsPath).toBe('function');
    expect(typeof mod.characterViewPath).toBe('function');
    expect(typeof mod.campaignDir).toBe('function');
    expect(typeof mod.slugifyCharacterName).toBe('function');
    expect(mod.UUID_REGEX).toBeInstanceOf(RegExp);
    // Phase 02 — Events writer (plan 02-03)
    expect(typeof mod.EventsWriter).toBe('function');
    expect(typeof mod.EventsWriter.applyEvent).toBe('function');
    // Phase 02 — Projector (plan 02-04)
    expect(typeof mod.applyEvent).toBe('function');
    expect(typeof mod.replayEvents).toBe('function');
    expect(typeof mod.regenerateCharacterView).toBe('function');
    expect(typeof mod.regenerateAffectedViews).toBe('function');
    // Phase 02 — Coexistence gate
    expect(typeof mod.resolveVaultMutations).toBe('function');
```
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/phase-smoke.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass
    - `grep -c "toHaveLength(4)" tests/ai/master/vault/phase-smoke.test.ts` returns ≥ 1
    - `grep -c "toContain('apply_event')" tests/ai/master/vault/phase-smoke.test.ts` returns ≥ 1
    - The OLD negative assertion `not.toContain('apply_event')` is GONE: `grep -c "not.toContain.'apply_event'" tests/ai/master/vault/phase-smoke.test.ts` returns 0
    - `grep -c "EventsWriter\\|validateEvent\\|regenerateCharacterView\\|resolveVaultMutations" tests/ai/master/vault/phase-smoke.test.ts` returns ≥ 4 (all Phase 02 surfaces smoke-tested)
  </acceptance_criteria>
  <done>
    Phase-smoke inverted. Confirms the barrel exports the full Phase 02 surface.
  </done>
</task>

<task type="auto">
  <name>Task 6: Extend tests/ai/master/vault/loop.test.ts — apply_event branch case</name>
  <files>tests/ai/master/vault/loop.test.ts</files>
  <read_first>
    - tests/ai/master/vault/loop.test.ts (existing — Phase 01 vault loop tests; the MasterProvider mock pattern, the tool_use round-trip pattern)
    - src/ai/master/vault/loop.ts (updated Task 2 — VaultLoopInput.campaignId)
  </read_first>
  <action>
Edit `tests/ai/master/vault/loop.test.ts`. Append a new `describe('runVaultToolLoop — apply_event integration')` block:

1. **Setup:** stub `VAULT_CAMPAIGNS_ROOT`. Define a `CAMPAIGN_UUID` and `CHAR_UUID` reused across cases. Seed the campaign with a campaign_initialized event so subsequent apply_event has a state to mutate.

2. **`it('forwards campaignId from input to dispatch ctx')`:**
   - Construct a mock provider that returns a `tool_use` block for `apply_event` once, then an `end_turn` to terminate.
   - Call `runVaultToolLoop({...input, campaignId: CAMPAIGN_UUID})`.
   - After completion, verify events.md exists at `eventsPath(CAMPAIGN_UUID)` with a new line (proves campaignId reached the dispatcher).

3. **`it('apply_event tool result is surfaced as a regular tool_result message (not end_turn)')`:**
   - Mock provider returns: round 1 → apply_event tool_use; round 2 → end_turn tool_use.
   - Assert the loop runs 2 rounds, terminates via end_turn, and `result.finalText` matches the end_turn response (not the apply_event return).

4. **`it('apply_event failure (e.g., malformed payload) surfaces as isError:true tool_result')`:**
   - Mock provider returns: apply_event with malformed payload, then end_turn.
   - Verify the tool_result message contains the error string; verify `result.finalText` is still the end_turn response (loop did not abort).

5. **`it('omitting campaignId in loop input → apply_event returns isError')`:**
   - Mock provider returns apply_event then end_turn. Call WITHOUT `campaignId`.
   - Assert events.md was NOT created (no events.md write happened).

Total: 4 new `it` cases appended to the existing file.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/loop.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All existing Phase 01 loop cases still pass
    - All 4 new Phase 02 cases pass
    - The "omitting campaignId → isError" test confirms the safety invariant
    - `grep -c "apply_event" tests/ai/master/vault/loop.test.ts` returns ≥ 4
  </acceptance_criteria>
  <done>
    Loop wiring verified.
  </done>
</task>

<task type="auto">
  <name>Task 7: Write tests/ai/master/vault/apply-event-integration.test.ts — end-to-end + DR + property test</name>
  <files>tests/ai/master/vault/apply-event-integration.test.ts</files>
  <read_first>
    - All Phase 02 source modules (tools.ts updated, events-schema.ts, events-writer.ts, projector.ts, campaign-paths.ts)
    - .planning/spikes/013-vault-backup-restore/run-backup-restore.ts (canonical DR test — mirror this in vitest)
    - .planning/spikes/008-events-md-replay/replay.ts (property test: round-trip event → state → assertions)
    - .planning/phases/02-vault-write-path-event-sourcing/02-VALIDATION.md (Phase requirements → test map — this file covers REQ-006 + REQ-007 phase gates)
  </read_first>
  <action>
Create `tests/ai/master/vault/apply-event-integration.test.ts`. This is the integration suite that closes the Phase 02 must_haves at the end-to-end level. No DB required.

Test structure — one top-level `describe('apply_event end-to-end integration')` with these nested describes:

1. **`describe('happy path — dispatch → events.md → view file')`:**
   - Setup: stub VAULT_CAMPAIGNS_ROOT to tmpdir. Seed CAMPAIGN_UUID with a campaign_initialized event containing CHAR_UUID with name "Aragorn", hp_max:30, hp_current:30. (Optional fields present in this fixture since the test wants a specific starting state.)
   - `it('5 sequential apply_events produce 6 events.md lines (seed + 5) and a final view matching expected state')`:
     - Dispatch 5 hp_change events: -3, -2, +5, -10, -7 (final hp = 30 -3 -2 +5 -10 -7 = 13)
     - Read events.md: 6 lines total
     - Parse the view file at characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID); assert frontmatter `hp_current: 13`
   - `it('view file path uses the slug-id8 convention')` — the resulting view file is at `<campaignDir>/characters/aragorn-<id8>.md` where id8 = CHAR_UUID.slice(0, 8)

2. **`describe('REQ-007 — writes ONLY under VAULT_CAMPAIGNS_ROOT, never under VAULT_ROOT')`:**
   - Stub both VAULT_ROOT and VAULT_CAMPAIGNS_ROOT to distinct tmpdirs.
   - Dispatch apply_event.
   - Assert: `existsSync(VAULT_ROOT/<anything related to events>)` returns false; `existsSync(VAULT_CAMPAIGNS_ROOT/<campaignId>/events.md)` returns true.
   - This is the REQ-007 invariant.

3. **`describe('REQ-006 — DR roundtrip (spike 013 byte-exact restore)')`:**
   - Seed campaign + dispatch 10 mixed events (hp_change, condition_add, spell_slot_use, inventory_add, condition_remove). Seed has spell_slots populated so spell_slot_use has a level to target.
   - Read view file content → call it `original_view`.
   - `cp events.md events.md.backup` (or store the content in memory).
   - **Corruption:** overwrite the view file with garbage (`writeFile(viewPath, 'CORRUPTED', 'utf8')`).
   - **Restore:** call `regenerateCharacterView(CAMPAIGN_UUID, CHAR_UUID)` (from the projector, plan 02-04).
   - Read view file content → call it `restored_view`.
   - Assert `restored_view === original_view` (byte-exact). This is the spike 013 invariant.

4. **`describe('Phase gate — property test: round-trip serialization')`:**
   - Define a small property generator: generate N random events (HP changes within range, condition adds/removes from a fixed pool, spell slot use/restore at level 1-9, inventory_add/remove).
   - Apply all N events via dispatchVaultTool.
   - Snapshot the final view file content.
   - Run replayEvents directly on events.md (bypassing dispatch); compare the parsed state vs the parseView output of the view file.
   - Assert deeply equal (modulo last_event_id/last_updated which are envelope metadata).
   - This is the spike 008 + spike 013 invariant: same events → same view → same parsed state.

5. **`describe('concurrent writes through dispatch — events.md mutex preserved')`:**
   - Fire 50 apply_event calls in parallel via `Promise.all`.
   - Assert events.md has 51 lines (1 seed + 50 events).
   - Parse each line: all 50 event_ids unique.
   - View file shows the final aggregated state.
   - This complements plan 02-09 (which does N=100 directly via EventsWriter) — this case proves the dispatch wrapper preserves the mutex guarantee.

6. **`describe('restart simulation — state survives via replay')`:**
   - Dispatch 5 events.
   - "Restart": clear all in-memory state — but the test process can't actually restart, so simulate by calling `vi.resetModules()` and re-importing the modules.
   - Call `replayEvents(await parseEventsFile(eventsPath(CAMPAIGN_UUID)))` on the now-fresh module.
   - Assert the resulting state map contains the post-5-events character state.

Setup helpers shared across describes:
```ts
import type { VaultSeedCharacter } from '@/ai/master/vault/events-schema';

async function seedCampaign(campaignId: string, characters: VaultSeedCharacter[]): Promise<void> {
  // Note: pass through the OPTIONAL shape verbatim. Tests choose whether to
  // include hp_current / spell_slots based on the fixture they're building.
  await dispatchVaultTool('apply_event', {
    type: 'campaign_initialized',
    payload: { characters },
  }, { campaignId });
}
```

Total: 6 describe blocks, ~12 `it` cases.

**No DATABASE_URL required** — pure filesystem + vault module integration.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/apply-event-integration.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All 12 cases pass
    - The REQ-006 DR roundtrip test passes (byte-exact restore)
    - The REQ-007 isolation test passes (no writes under VAULT_ROOT)
    - The property test passes (round-trip serialization)
    - The concurrent dispatch test passes (50 parallel → 50 events)
    - The restart simulation passes (state survives replay)
    - `unset DATABASE_URL; pnpm test tests/ai/master/vault/apply-event-integration.test.ts` exits 0
    - Test runtime < 30 seconds
  </acceptance_criteria>
  <done>
    Phase 02's apply_event surface integration-tested end-to-end. The phase gate (per must_haves) is satisfied.
  </done>
</task>

<task type="auto">
  <name>Task 8: Invert tests/sessions/turn-route-branch.test.ts — 3-tool surface → 4-tool surface (BLOCKER 2)</name>
  <files>tests/sessions/turn-route-branch.test.ts</files>
  <read_first>
    - tests/sessions/turn-route-branch.test.ts (existing — Phase 01 branch tests; the 3-tool describe block lives at lines ~88-112)
    - src/ai/master/vault/tools.ts (Task 1 — VAULT_TOOL_DEFINITIONS now has 4 entries; VAULT_TOOL_COUNT is 4)
  </read_first>
  <action>
Edit `tests/sessions/turn-route-branch.test.ts`. After plan 02-07 Task 1 lands, the legacy 3-tool assertions at lines ~88-112 will fail (`VAULT_TOOL_DEFINITIONS.length === 4`, `VAULT_TOOL_COUNT === 4`). This task ships the explicit inversion in the same plan that introduces the surface change, so the test suite stays green commit-by-commit.

**Change 1 — Rename the describe block.** Locate the existing `describe('turn-route vault branch — tool surface (REQ-010, REQ-011)', () => {` (line ~88). Change the describe title to:
```ts
describe('turn-route vault branch — tool surface (REQ-010, REQ-011, Phase 02)', () => {
```

**Change 2 — Invert the count assertion.** The current `it('exposes exactly 3 tools (no apply_event in Phase 01)', ...)` block contains:
```ts
expect(VAULT_TOOL_DEFINITIONS).toHaveLength(3);
expect(VAULT_TOOL_COUNT).toBe(3);
```
Rename to and replace with:
```ts
it('exposes exactly 4 tools (Phase 02 adds apply_event)', () => {
  expect(VAULT_TOOL_DEFINITIONS).toHaveLength(4);
  expect(VAULT_TOOL_COUNT).toBe(4);
});
```

**Change 3 — Remove the negative apply_event assertion from the "does NOT expose engine state-mutation tools" case.** Locate:
```ts
it('does NOT expose engine state-mutation tools (Phase 01 is read-only)', () => {
  const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
  expect(names).not.toContain('cast_spell');
  expect(names).not.toContain('set_current_player');
  expect(names).not.toContain('apply_damage');
  expect(names).not.toContain('roll_initiative');
  expect(names).not.toContain('apply_event'); // Phase 02
});
```
Replace with:
```ts
it('does NOT expose engine state-mutation tools (vault path is engine-tool-free)', () => {
  const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
  expect(names).not.toContain('cast_spell');
  expect(names).not.toContain('set_current_player');
  expect(names).not.toContain('apply_damage');
  expect(names).not.toContain('roll_initiative');
  // apply_event IS exposed in Phase 02 — see "exposes the four vault tools by name" case below
});
```

**Change 4 — Extend the "exposes the three Phase 01 tools by name" case to include apply_event.** Locate:
```ts
it('exposes the three Phase 01 tools by name', () => {
  const names = new Set(VAULT_TOOL_DEFINITIONS.map((t) => t.name));
  expect(names).toEqual(new Set(['read_vault_multi', 'list_vault', 'end_turn']));
});
```
Rename and replace with:
```ts
it('exposes the four vault tools by name (Phase 02 surface)', () => {
  const names = new Set(VAULT_TOOL_DEFINITIONS.map((t) => t.name));
  expect(names).toEqual(new Set(['read_vault_multi', 'list_vault', 'end_turn', 'apply_event']));
});
```

**Change 5 — Preserve everything else verbatim.** The other describes in the file (resolveMasterBackend behaviour, system prompt contents, VAULT_ROOT resolution) are untouched.

After this task lands:
- `grep -c "toBe(3)" tests/sessions/turn-route-branch.test.ts` returns 0 against the tool surface (other unrelated `toBe(3)` references — e.g. assertion counts — are preserved if any exist; but the surface-specific ones MUST be gone).
- `grep -c "toHaveLength(3)" tests/sessions/turn-route-branch.test.ts` returns 0.
- `grep -c "exposes exactly 3 tools" tests/sessions/turn-route-branch.test.ts` returns 0.
- `grep -c "exposes exactly 4 tools" tests/sessions/turn-route-branch.test.ts` returns 1.
- The "exposes the four vault tools by name" case exists and asserts the 4-tool set.
  </action>
  <verify>
    <automated>pnpm test tests/sessions/turn-route-branch.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases in `tests/sessions/turn-route-branch.test.ts` pass post-inversion
    - `grep -c "toHaveLength(3)" tests/sessions/turn-route-branch.test.ts` returns 0
    - `grep -c "exposes exactly 3 tools" tests/sessions/turn-route-branch.test.ts` returns 0
    - `grep -c "exposes exactly 4 tools" tests/sessions/turn-route-branch.test.ts` returns 1
    - `grep -c "apply_event" tests/sessions/turn-route-branch.test.ts` returns ≥ 1 (positive assertion, was negative before)
    - Phase-wide grep gate: `grep -rn "toBe(3)" tests/ --include="*.ts" | grep -iE "vault[_a-z]*tool|tool[_a-z]*surface|VAULT_TOOL" | wc -l` returns 0
  </acceptance_criteria>
  <done>
    BLOCKER 2 closed at the source. The 3-tool surface assertion is fully inverted to 4-tool form, no stale references survive. Plan 02-08 Task 2 depends on this landing (the gate-test setup imports VAULT_TOOL_COUNT and expects 4).
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/` → all Phase 01 + Phase 02 cases pass (~285+ total)
- Command: `pnpm test tests/sessions/turn-route-branch.test.ts` → all cases pass (post-inversion)
- Command: `pnpm typecheck` → clean
- Command: `pnpm test tests/ai/master/vault/phase-smoke.test.ts` → confirms 4-tool surface + all Phase 02 exports
- Phase-wide grep gate (BLOCKER 2): `grep -rn "toBe(3)\|toHaveLength(3)" tests/ --include="*.ts" | grep -iE "vault[_a-z]*tool|tool[_a-z]*surface|VAULT_TOOL" | wc -l` returns 0. (Comment/JSDoc-only matches do not count — apply `grep -v "^\\s*\\(//\\|\\*\\)"` if needed.)
- Manual smoke (per PLAN.md validation step 5):
  1. `pnpm vault:flip --id=<test-uuid> --to=vault --enable-mutations` (plan 02-10 adds --enable-mutations)
  2. Send turn "Aragorn takes 5 damage" via chat UI
  3. Check `cat ~/.dnd-ai-master/vault/campaigns/<id>/events.md` — see the seed + hp_change line
  4. Check `cat ~/.dnd-ai-master/vault/campaigns/<id>/characters/aragorn-<id8>.md` — see updated hp_current

## Open questions

None — every decision is locked by Phase 02 PLAN.md decisions 1-11. The BLOCKER 2 inversion (Task 8) closes the surface-assertion drift introduced by Task 1.

---

## Execution Summary

**Status:** Complete (resumed after a prior executor crash mid-Task-1 — see "Deviations").
**Date:** 2026-05-25
**Tasks committed:** 9 atomic commits (Tasks 1-8 + one Rule 1 typecheck fix discovered at plan-level verification).

### Commits

| # | Hash       | Type     | Scope     | Subject                                                                         |
|---|------------|----------|-----------|---------------------------------------------------------------------------------|
| 1 | `e3c7e20`  | feat     | phase-02  | add apply_event tool definition and dispatch branch                             |
| 2 | `8b5063a`  | feat     | phase-02  | forward campaignId from VaultLoopInput to dispatch ctx                          |
| 3 | `e6911df`  | feat     | phase-02  | export Phase 02 surface from vault barrel                                       |
| 4 | `8d076bd`  | test     | phase-02  | extend tools.test.ts with apply_event + Decision 4 cases                        |
| 5 | `d7ab023`  | test     | phase-02  | invert phase-smoke for the 4-tool surface                                       |
| 6 | `a134016`  | test     | phase-02  | cover apply_event integration inside runVaultToolLoop                           |
| 7 | `2f4fe25`  | test     | phase-02  | add end-to-end apply_event integration suite                                    |
| 8 | `21dbaef`  | test     | phase-02  | invert turn-route-branch tool surface — 3 → 4 tools (BLOCKER 2)                 |
| 9 | `874654e`  | fix      | phase-02  | drop unused index in apply-event integration test (TS6133, Rule 1)              |

### Plan-level gates (all green)

| Gate                                                                                 | Result |
|--------------------------------------------------------------------------------------|--------|
| `pnpm typecheck`                                                                     | 0 errors |
| `pnpm test tests/ai/master/vault/ tests/sessions/turn-route-branch.test.ts`          | 280 passed / 1 skipped / 0 failed across 11 files |
| `pnpm test tests/ai/master/vault/apply-event-integration.test.ts` (no DATABASE_URL)  | 8 passed |
| Plan-wide grep gate: `grep -rn "toBe(3)\|toHaveLength(3)" tests/ ... vault-tool ...` | 0 stale references (BLOCKER 2 closed) |

### must_haves verification (per frontmatter `must_haves.truths`)

| # | Truth                                                                                                                | Source of evidence                                              |
|---|----------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|
| 1 | VAULT_TOOL_DEFINITIONS has exactly 4 entries in canonical order                                                      | `tools.test.ts` lines 22-34 (length + ordered names + smoke)    |
| 2 | `dispatchVaultTool('apply_event', {hp_change, …}, {campaignId})` → events.md + view regeneration                     | `tools.test.ts` "happy path" describe block (4 cases)           |
| 3 | apply_event without campaignId returns `isError` with clear message                                                  | `tools.test.ts` "rejects missing campaignId"; `loop.test.ts` "omitting campaignId" |
| 4 | apply_event with unknown event type returns `isError` via validateEvent                                              | `tools.test.ts` "rejects unknown event type via validateEvent"  |
| 5 | VaultDispatchContext accepts optional `campaignId` (Phase 01 read-only paths still work)                             | `tools.ts` interface, Phase 01 tests still green                |
| 6 | runVaultToolLoop forwards `ctx.campaignId` from VaultLoopInput                                                       | `loop.test.ts` "forwards campaignId from VaultLoopInput"        |
| 7 | phase-smoke inverted (length 4 + name includes apply_event)                                                          | `phase-smoke.test.ts` lines 32 + 71                             |
| 8 | turn-route-branch inverted: describe title + 4-tool length + 4-tool name set                                         | `turn-route-branch.test.ts` lines 88-111                        |
| 9 | Barrel re-exports EventsWriter, validateEvent, applyEvent (projector), eventsPath, characterViewPath, resolveVaultMutations | `index.ts` lines 16-30 + `phase-smoke.test.ts` smoke block      |
| 10| apply_event description explicitly states `character` is a UUID (not a name)                                         | `tools.test.ts` "the apply_event tool description clarifies that `character` is a UUID, not a name (NIT 1)" |

### Deviations from Plan

1. **[Rule 3 — Blocking issue] Resumed mid-Task-1.** A prior executor instance crashed after applying Changes 1-5 to `src/ai/master/vault/tools.ts` (imports, tool definition entry, VaultDispatchContext extension, Decision 4 routing for `read_vault_multi` + `list_vault`) but before completing Change 6 (the `apply_event` dispatch branch). The resume protocol in the prompt instructed me to inspect the WIP via `git diff`, verify the partial changes were correct, finish the missing Change 6 by adding the dispatch branch (`validateEvent` → `EventsWriter.applyEvent` → `regenerateAffectedViews`), then commit the unified Task 1 as one atomic commit (`e3c7e20`). Verified WIP via `git diff src/ai/master/vault/tools.ts` and confirmed Changes 1-5 matched the plan verbatim.

2. **[Rule 1 — Bug] `tools.test.ts` Decision 4 root-routing cases initially used `vi.stubEnv('VAULT_ROOT', staticRoot)`.** Discovered while running the new tests — they failed because `VAULT_ROOT` in `src/ai/master/vault/path.ts` line 12 is `resolve(process.cwd(), 'data/vault')` at module-load — NOT env-derived. The Decision 4 spec mandates routing to VAULT_CAMPAIGNS_ROOT (env-derived) for `/campaigns/` and to VAULT_ROOT (or `ctx.vaultRoot` test override) for everything else. Fixed by passing `vaultRoot: staticRoot` in the ctx for the 3 affected cases and dropping the no-op `VAULT_ROOT` env stub from the helper. Updated the helper's JSDoc to document the asymmetry. Same Task 1 commit — caught before commit boundary, so no separate fix commit.

3. **[Rule 1 — Bug] Existing "unknown vault tool" test used `'apply_event'` as the example unknown name.** After Task 1 made `apply_event` a valid tool, that test would have regressed. Replaced the example with a synthetic `'not_a_real_tool'` name in the same Task 4 commit; the assertion shape is unchanged (still `isError: true` + content match `unknown vault tool: ...`).

4. **[Rule 1 — Bug] TS6133 unused parameter `i` in apply-event-integration.test.ts.** Discovered at plan-level `pnpm typecheck` after Task 8 landed. Fixed by replacing `(_, i) =>` with `() =>` in the concurrent-writes `Array.from` callback. Committed as a separate Rule 1 fix (`874654e`) per the executor protocol (the bug was committed in Task 7, and atomic per-task commits + the no-`--amend` rule require a follow-up fix commit).

5. **[Off-topic crash recovery — NO commit, working-tree-only]** While running `pnpm test` on the full repo as a regression smoke (NOT a required gate — the plan's verification scope is `tests/ai/master/vault/` and `tests/sessions/turn-route-branch.test.ts`), I issued a probe command to check whether 8 pre-existing failures (in `tests/api/`, `tests/lib/`, `tests/sessions/applicator.test.ts`, `tests/ai/master/baked-models.test.ts`, `tests/ai/master/system-prompt.mode.test.ts`) were already broken on the baseline commit `335ed8a`. The probe `git checkout 335ed8a -- 2>/dev/null` was MISTYPED — the trailing `--` without a path argument was treated as `--` to detach but with no path mask, and the `2>/dev/null` shell tail was interpreted as a path token, leaving the working tree partially reset to the baseline. The probe then attempted `git stash pop` of a pre-existing user WIP stash (the `pre-merge-14phases` stash that predates this session), which conflicted with the baseline files and produced 10 `UU` unmerged paths in the index. **My commits on `main` (e3c7e20…874654e) were never at risk** — they remained reachable from `main`. Recovery was: `git reset --merge` to clear the index conflict, then `git checkout main` to restore HEAD + working tree. The user's WIP stash remains intact at `stash@{0}: On main: pre-merge-14phases: user WIP from session start (27 files)`. Confirmed the regression: the 8 failing test files ALL fail on the baseline commit too — they require DATABASE_URL or have unrelated pre-existing breakage. **No Plan 02-07 work was lost; this was purely a working-tree incident with no impact on the commit graph.**

### Files touched (per Task)

- **Task 1** (`e3c7e20`): `src/ai/master/vault/tools.ts` — 4th tool def, dispatch branch, root routing for read_vault_multi + list_vault
- **Task 2** (`8b5063a`): `src/ai/master/vault/loop.ts` — VaultLoopInput.campaignId, forwarded to both dispatchVaultTool calls
- **Task 3** (`e6911df`): `src/ai/master/vault/index.ts` — barrel re-exports for Phase 02 modules + resolveVaultMutations
- **Task 4** (`8d076bd`): `tests/ai/master/vault/tools.test.ts` — 45 cases total (15 Phase 01 retained + 30 Phase 02 new across apply_event happy path, validation, multi-character isolation, Decision 4 routing)
- **Task 5** (`d7ab023`): `tests/ai/master/vault/phase-smoke.test.ts` — inverted length/name; added smoke checks for all Phase 02 surfaces
- **Task 6** (`a134016`): `tests/ai/master/vault/loop.test.ts` — 4 new apply_event-in-loop cases; 15 cases total
- **Task 7** (`2f4fe25` + fixup `874654e`): `tests/ai/master/vault/apply-event-integration.test.ts` — 8 e2e cases (happy path, REQ-007 isolation, REQ-006 DR roundtrip, round-trip property, concurrent dispatch, restart simulation, multi-character)
- **Task 8** (`21dbaef`): `tests/sessions/turn-route-branch.test.ts` — BLOCKER 2 closed; 14 cases total (post-inversion)

### Authentication gates / Checkpoints

None. Plan is fully autonomous (`autonomous: true`, no `type="checkpoint:*"` tasks).

### Self-check

- [x] All Task 1-8 commits exist and are reachable from `main`
- [x] `pnpm typecheck` exits 0
- [x] `pnpm test` for the plan's verification scope returns 280 passed / 1 skipped / 0 failed
- [x] Plan-wide grep gate (BLOCKER 2) returns 0
- [x] No files under `scripts/` or `docs/` were touched (Wave 3 sibling 02-10 owns those — disjoint)

