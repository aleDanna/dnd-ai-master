---
phase: 02
plan: 08
type: execute
wave: 3
depends_on: [02-05, 02-07]
files_modified:
  - src/app/api/sessions/[id]/turn/route.ts
  - src/ai/master/vault/prompt-builder.ts
  - tests/sessions/vault-mutations-gate.test.ts
  - tests/sessions/vault-mutations-resume.test.ts
autonomous: false
requirements: [REQ-004, REQ-007, REQ-010]
must_haves:
  truths:
    - "The turn route reads campaignSettings.vaultMutations via resolveVaultMutations() and passes campaignId to runVaultToolLoop only when the resolver returns true"
    - "A campaign with vaultMutations:false (or undefined) NEVER has campaignId forwarded to the loop — apply_event tool calls (if the LLM hallucinates one) return isError without writes"
    - "A campaign with vaultMutations:true AND masterBackend:'vault' gets the apply_event tool exposed with a valid campaignId — writes work"
    - "The vault system prompt (buildVaultSystemPrompt) emits toolCount: 4 only when vaultMutations is true; toolCount: 3 (read-only) when vaultMutations is false"
    - "Existing Phase 01 campaigns (masterBackend:'vault', vaultMutations not set) continue using the 3-tool read-only surface; no regression"
    - "Server restart preserves state: a vault campaign with events on disk shows the post-replay state when next read via read_vault_multi"
    - "Operator-facing documentation describes the single-write semantics + stale-UI banner expectation"
    - "The apply_event mention in the prompt explicitly states that `character` is a UUID (not a name) — prevents the LLM from passing character names which would fail downstream lookup"
  artifacts:
    - path: "src/app/api/sessions/[id]/turn/route.ts"
      provides: "Gates apply_event exposure on resolveVaultMutations() + forwards campaignId"
      contains: "resolveVaultMutations"
    - path: "src/ai/master/vault/prompt-builder.ts"
      provides: "buildVaultSystemPrompt accepts vaultMutations:boolean and adjusts toolCount + apply_event mention"
      contains: "vaultMutations"
    - path: "tests/sessions/vault-mutations-gate.test.ts"
      provides: "Branch coverage for vaultMutations flag honored by turn route"
    - path: "tests/sessions/vault-mutations-resume.test.ts"
      provides: "Post-restart state survives via replay"
  key_links:
    - from: "src/app/api/sessions/[id]/turn/route.ts (vault branch)"
      to: "src/lib/preferences.ts"
      via: "resolveVaultMutations(userPrefs) — gate apply_event tool exposure"
      pattern: "resolveVaultMutations"
    - from: "src/app/api/sessions/[id]/turn/route.ts (vault branch)"
      to: "src/ai/master/vault/loop.ts"
      via: "runVaultToolLoop({campaignId: campaign.id, ...}) — only when gate is true"
      pattern: "campaignId: campaign\\.id"
---

# Plan 02-08: Coexistence Semantics + Turn-Route Gate

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 3 (depends on plan 02-05 for `resolveVaultMutations` and plan 02-07 for the dispatch surface)
**Status:** Pending
**Estimated diff size:** ~120 LOC source + ~90 LOC tests / 4 files
**Autonomous:** **false** — contains one checkpoint:human-verify for the stale-UI banner copy (the operator needs to confirm the banner messaging before the implementation locks)

## Goal

Wire the `vaultMutations` opt-in flag into the turn route. When `resolveVaultMutations(userPrefs)` returns `true`, the vault path receives the campaignId AND the system prompt declares 4 tools (including `apply_event`). When the resolver returns `false` (default for existing campaigns OR baked campaigns OR vault campaigns without explicit opt-in), the vault path runs in Phase-01-equivalent read-only mode (3 tools, no campaignId, apply_event tool calls from the LLM return isError per the dispatcher's safety check).

Per phase Decision 8 (single-write only — no dual-write to Postgres for Phase 02), the UI continues reading from Postgres. The operator sees a banner at /settings or on the campaign card: "Vault mutations active — UI reflects last Postgres state until session refresh." Phase 03 handles dual-write reconciliation; Phase 02 is single-write only. **This is the HIGH-risk operational caveat — the operator must confirm the banner copy via the checkpoint:human-verify task before this plan is "done".**

The implementation is a thin extension to Phase 01's vault branch (which lives at `src/app/api/sessions/[id]/turn/route.ts` lines 248-409 per the Phase 01 plan 07 doc). Three changes:

1. After `getSessionMasterPreferences(sessionId)`, call `resolveVaultMutations(userPrefs)` to get the boolean gate.
2. When passing inputs to `runVaultToolLoop`, conditionally include `campaignId: campaign.id` only when the gate is `true`.
3. When calling `buildVaultSystemPrompt`, conditionally pass `vaultMutations: true` so the prompt mentions `apply_event` only when the LLM can actually call it.

The prompt-builder (`src/ai/master/vault/prompt-builder.ts` from Phase 01 plan 02) needs a small extension: a new `vaultMutations?: boolean` input that, when true, bumps the `toolCount` reference from 3 to 4 in the prompt body and adds a brief mention of `apply_event` to the tool catalog. The pure-function contract (REQ-022) is preserved — the input is a plain boolean, no side effects.

## Requirements satisfied

- **REQ-004** events.md is source of truth — this plan ensures writes happen ONLY for opted-in campaigns; non-opted-in campaigns continue using Postgres untouched.
- **REQ-007** campaign data outside repo — the campaignId forwarding is the load-bearing wire that activates per-campaign vault paths.
- **REQ-010** 4-tool surface — this plan determines which campaigns SEE the 4th tool. The dispatcher (plan 02-07) always has 4 entries; this plan gates whether the LLM is TOLD about apply_event.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/app/api/sessions/[id]/turn/route.ts` | EDIT (~20 LOC in the vault branch) | Add resolveVaultMutations call + conditional campaignId + conditional vaultMutations prompt arg. |
| `src/ai/master/vault/prompt-builder.ts` | EDIT (~15 LOC) | Accept vaultMutations input; adjust tool catalog mention. |
| `tests/sessions/vault-mutations-gate.test.ts` | NEW | Branch coverage: 4 cases (vault+true, vault+false, baked+true, baked+false). |
| `tests/sessions/vault-mutations-resume.test.ts` | NEW | State survives Next.js restart (replay-on-read invariant). |

## Tasks

<task type="auto">
  <name>Task 1: Extend buildVaultSystemPrompt to accept vaultMutations input</name>
  <files>src/ai/master/vault/prompt-builder.ts</files>
  <read_first>
    - src/ai/master/vault/prompt-builder.ts (existing — Phase 01 implementation; the input shape `VaultPromptInput`; the toolCount substitution; the `hashVaultPrompt(prompt: string)` helper at lines 62-64; REQ-022 purity contract)
    - .planning/phases/01-vault-read-path/plans/02-vault-prompt-builder.md (style + REQ-022 enforcement)
  </read_first>
  <action>
Edit `src/ai/master/vault/prompt-builder.ts` (preserve everything verbatim except the changes below; REQ-022 forbids any new env/random/timestamp source).

**Change 1 — Extend the input interface.** Locate the `VaultPromptInput` interface. Add an optional field:

```ts
  /**
   * Phase 02 — when true, the prompt advertises 4 tools (including
   * apply_event) and mentions the mutation surface. When false or
   * undefined, the prompt is the Phase-01-equivalent read-only form
   * (3 tools, no apply_event mention).
   *
   * The campaign's `vaultMutations` setting (resolved via
   * `resolveVaultMutations` in `src/lib/preferences.ts`) feeds this
   * input. REQ-022 hygiene preserved (boolean input, no side effect).
   */
  vaultMutations?: boolean;
```

**Change 2 — Adjust toolCount substitution.** The existing prompt template references `input.toolCount` for the tool count. The CALLER (turn/route.ts) is responsible for passing the right `toolCount` (3 or 4) — but for safety, add an internal consistency assertion: if `vaultMutations === true` AND `toolCount !== 4`, throw `new Error('buildVaultSystemPrompt: vaultMutations:true requires toolCount:4 (got <n>)')`. This catches the consistency bug at the entry point. Similarly if `vaultMutations === false` (or undefined) AND `toolCount !== 3`, throw the symmetric error.

**Change 3 — Append apply_event mention to the tool catalog when vaultMutations is true.** Locate the section of the prompt template that mentions tool usage (the "Tool usage protocol" block in the existing builder). Define the conditional mention text and append it where the tool catalog hints live:

```ts
const applyEventMention = input.vaultMutations === true
  ? 'When the player describes a game-state change (damage taken, spell cast, condition applied), call `apply_event` with the appropriate type and payload. The `character` field MUST be the character UUID (the value of `id` in the materialized view frontmatter — not the character name; names are not unique across campaigns and the dispatcher rejects non-UUID values). One event per call; do not batch.'
  : '';
```

Insert `applyEventMention` (with a leading `''` separator line so the prompt stays readable when it's empty) into the prompt body in a sensible location (after the tool-listing section, before the campaign context block). The exact placement should mirror Phase 01's existing builder structure — read the file to identify the right insertion point.

The mention is INTENTIONALLY brief — the LLM is supposed to read `/tools/apply_event.md` (or whatever the lazy tool-doc convention is) for the full schema; the system prompt just signals the tool exists AND clarifies the most common LLM mistake (passing a character name instead of UUID).

**Change 4 — Hash divergence is NATURAL (no separate signature change to `hashVaultPrompt`).** `hashVaultPrompt(prompt: string)` at lines 62-64 takes the FULL PROMPT TEXT, not a structured input. The conditional `applyEventMention` text in Change 3 already produces hash divergence: a prompt built with `vaultMutations: true` contains the apply_event sentence, a prompt built with `vaultMutations: false` does not — different bytes, different hash, no prefix-cache cross-contamination.

Document this explicitly with a JSDoc comment ABOVE `hashVaultPrompt` (do NOT change its signature):

```ts
/**
 * SHA256 hex digest of a built prompt. Used by:
 *  - The stability test (1000 builds → 1 unique hash).
 *  - Future runtime telemetry that wants to log prompt-cache identity
 *    without storing the prompt itself.
 *
 * Phase 02 note: prompts built with vaultMutations:true vs false produce
 * different bytes (the conditional applyEventMention text in
 * buildVaultSystemPrompt diverges between modes). This means
 * hashVaultPrompt(promptA_readonly) !== hashVaultPrompt(promptA_readwrite)
 * naturally — no separate signature change is needed to keep prefix-cache
 * identity isolated between the two surfaces.
 */
```

NO new parameter is added to `hashVaultPrompt`; the previous iteration of this plan mentioned restructuring its signature, which was ambiguous. The signature stays `(prompt: string) => string`. The Task 1 prompt-builder test (Phase 01) gets a new case asserting `hashVaultPrompt(promptVaultMutations: true) !== hashVaultPrompt(promptVaultMutations: false)` (see acceptance criteria).

**Change 5 — Preserve REQ-022 purity.** Run the existing forbidden-pattern check (Phase 01's `__forbidden-patterns.ts`) — the new code does NOT add any `Date.now()`, `Math.random`, `process.env`, `randomUUID`, `process.hrtime`, hostname reference. Pure boolean input.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/prompt-builder.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "vaultMutations" src/ai/master/vault/prompt-builder.ts` returns ≥ 3
    - `grep -c "apply_event" src/ai/master/vault/prompt-builder.ts` returns ≥ 1
    - `grep -c "character UUID\|character is a UUID\|character uuid" src/ai/master/vault/prompt-builder.ts` returns ≥ 1 (NIT 1 fix: the UUID-vs-name clarification is explicit in the prompt text)
    - `grep -cE "Date\\.now\\(|Math\\.random|process\\.env|randomUUID|process\\.hrtime" src/ai/master/vault/prompt-builder.ts` returns 0 (REQ-022 hygiene preserved)
    - The signature of `hashVaultPrompt` is UNCHANGED — still `(prompt: string): string`. `grep -c "hashVaultPrompt(prompt: string)" src/ai/master/vault/prompt-builder.ts` returns ≥ 1
    - Phase 01's prompt-builder tests still pass (existing assertions about toolCount=3 are still valid for the read-only case)
    - The new consistency assertion (vaultMutations:true requires toolCount:4) is exercised by a test case
    - A new test case asserts hash divergence: `hashVaultPrompt(buildVaultSystemPrompt({...base, vaultMutations: true, toolCount: 4})) !== hashVaultPrompt(buildVaultSystemPrompt({...base, vaultMutations: false, toolCount: 3}))` — confirms Change 4's "natural hash divergence" claim
  </acceptance_criteria>
  <done>
    Prompt builder extended. Task 2 uses it from the turn route. hashVaultPrompt signature unchanged.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire vaultMutations gate into the turn route</name>
  <files>src/app/api/sessions/[id]/turn/route.ts</files>
  <read_first>
    - src/app/api/sessions/[id]/turn/route.ts (existing — Phase 01 vault branch at lines 248-409; find the exact lines via grep "// ── Vault path" or "masterBackend === 'vault'")
    - src/lib/preferences.ts (resolveVaultMutations + isMasterBackend exports — Phase 02-05)
    - src/ai/master/vault/prompt-builder.ts (Task 1 — vaultMutations input)
    - src/ai/master/vault/loop.ts (campaignId input — Phase 02-07)
    - src/ai/master/vault/tools.ts (VAULT_TOOL_DEFINITIONS, VAULT_TOOL_COUNT — Phase 02-07 has 4 entries; the route needs the right COUNT for the prompt)
  </read_first>
  <action>
Edit `src/app/api/sessions/[id]/turn/route.ts`. Modify the existing vault branch (Phase 01 plan 07's inserted block).

**Change 1 — Import resolveVaultMutations.** Top of file, in the existing preferences import block:
```ts
import { resolveMasterBackend, resolveVaultMutations, type MasterBackend } from '@/lib/preferences';
```

**Change 2 — Resolve the gate.** Inside the vault branch (after `const masterBackend = resolveMasterBackend(userPrefs.masterBackend);`), add:
```ts
const vaultMutationsEnabled = resolveVaultMutations(userPrefs);
console.log('[turn]', sessionId, 'vault path: vaultMutations=', vaultMutationsEnabled);
```

**Change 3 — Adjust prompt builder call.** Locate the existing `buildVaultSystemPrompt` call (currently passes `toolCount: VAULT_TOOL_COUNT` where VAULT_TOOL_COUNT is 4 in Phase 02 source). Pass the right toolCount based on the gate:

```ts
const vaultSys = buildVaultSystemPrompt({
  vaultRoot: VAULT_ROOT,
  campaignId: campaign.id,
  toolCount: vaultMutationsEnabled ? 4 : 3,    // 3 read-only or 4 with apply_event
  vaultMutations: vaultMutationsEnabled,
  language: campaign.language ?? snap.language ?? undefined,
});
```

**Change 4 — Conditionally pass campaignId to runVaultToolLoop.** Locate the existing `runVaultToolLoop({...})` call. Add `campaignId` conditionally:

```ts
const result = await runVaultToolLoop({
  provider,
  model: masterModel,
  systemBlocks: [{ type: 'text', text: vaultSys }],
  history: vaultHistory,
  sessionId,
  campaignLanguage: campaign.language ?? snap.language ?? undefined,
  ...(vaultMutationsEnabled && { campaignId: campaign.id }),    // NEW: only forward when gate is true
  recordUsage: async (usage) => { ... },
  onEvent: (ev) => { ... },
});
```

The pattern `...(condition && { key: value })` is a clean JS idiom for optional property forwarding — preserves the Phase 01 behavior for non-opted-in campaigns (campaignId is undefined → loop does not forward → dispatcher returns isError on any apply_event hallucination).

**Change 5 — Tool definitions in the loop are still ALWAYS 4 (Phase 02-07).** This is intentional: the model receives `VAULT_TOOL_DEFINITIONS` (4 entries) but the gate at the dispatch layer (campaignId presence) determines whether `apply_event` writes. This is BELT-AND-SUSPENDERS: prompt-level gating (the LLM is told 3 tools if not opted in) plus dispatch-level gating (apply_event fails if campaignId missing). A misbehaving model that hallucinates apply_event against a non-opted-in campaign sees a clean error response.

**Change 6 — Document the single-write semantics.** Update the existing vault branch comment block at the top of the branch:

```
// ── Vault path (Phase 01 read-only + Phase 02 conditional write) ──────
//
// Phase 02 adds the vaultMutations opt-in. Resolution:
//   - masterBackend === 'baked' → not vault at all (handled by the
//     non-vault branch below); vaultMutations has no effect.
//   - masterBackend === 'vault' + vaultMutations === false (default)
//     → Phase 01 read-only mode: 3 tools, no campaignId forwarded,
//     LLM hallucinated apply_event returns isError.
//   - masterBackend === 'vault' + vaultMutations === true
//     → Phase 02 read-write mode: 4 tools, campaignId forwarded,
//     apply_event writes to events.md + regenerates view.
//
// Coexistence semantics (Decision 8): single-write to events.md only.
// Postgres `characters` table is NOT touched for opted-in campaigns.
// UI continues reading from Postgres — operator sees a stale-state
// banner. Phase 03 implements dual-write + reconciliation.
//
// See .planning/phases/02-vault-write-path-event-sourcing/PLAN.md.
```

**Change 7 — Invert the legacy 3-tool surface assertion in turn-route-branch.test.ts (BLOCKER 2 mitigation).** Plan 02-07 Task 5 already inverts `tests/ai/master/vault/phase-smoke.test.ts`, but `tests/sessions/turn-route-branch.test.ts` ALSO contains a 3-tool assertion (lines ~88-112) that this plan's gate semantics will break unless updated together with the turn-route gate. The detailed edit set lives in plan 02-07 Task 8 (added in the same revision); this task only needs to reference it. The acceptance criteria below ensure the `toBe(3)` assertion is gone by the time this plan completes.
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-gate.test.ts && pnpm test tests/sessions/turn-route-branch.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "resolveVaultMutations" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 1
    - `grep -c "vaultMutationsEnabled" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 3 (declaration + prompt-builder arg + loop arg)
    - `grep -c "campaignId: campaign.id" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 1
    - `tests/sessions/turn-route-branch.test.ts` does NOT assert `.toHaveLength(3)` or `.toBe(3)` against `VAULT_TOOL_DEFINITIONS` / `VAULT_TOOL_COUNT` anymore (BLOCKER 2 — the inversion is performed in plan 02-07 Task 8, this plan depends on it landing)
    - `grep -c "exposes exactly 3 tools" tests/sessions/turn-route-branch.test.ts` returns 0 (the legacy describe is renamed to "exactly 4 tools" by plan 02-07 Task 8)
    - Phase 01's `tests/sessions/turn-route-branch.test.ts` post-inversion still passes
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>
    Turn-route gate wired. Tasks 3 + 4 verify the branches and the resume invariant. Phase-wide grep gate (verification section below) confirms NO `toBe(3)` survives against the tool surface.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/sessions/vault-mutations-gate.test.ts — 4-quadrant branch coverage</name>
  <files>tests/sessions/vault-mutations-gate.test.ts</files>
  <read_first>
    - tests/sessions/turn-route-branch.test.ts (Phase 01 — THE template; mock patterns for getSessionMasterPreferences, runVaultToolLoop, runToolLoop)
    - src/app/api/sessions/[id]/turn/route.ts (Task 2 update — the new branching logic)
  </read_first>
  <action>
Create `tests/sessions/vault-mutations-gate.test.ts`. Mirror the structure of `tests/sessions/turn-route-branch.test.ts` (Phase 01) but focus on the vaultMutations flag.

Test structure — one top-level `describe('turn route — vaultMutations gate')`:

**Quadrant 1: `describe('masterBackend=vault + vaultMutations=true → full vault write path')`:**
- Mock `getSessionMasterPreferences` to return `{masterBackend: 'vault', vaultMutations: true, aiMasterModel: 'qwen3:30b-a3b-instruct-2507-q4_K_M', ...}`
- Mock `runVaultToolLoop` as a spy (don't actually run the loop)
- POST the turn endpoint
- Assert `runVaultToolLoop` called once with `{campaignId: <campaign.id>}` (the campaignId IS forwarded)
- Assert the systemBlocks[0].text was built with toolCount: 4 (capture the buildVaultSystemPrompt call args via spy and assert)
- Assert the prompt contains "apply_event" (the mention from Task 1's change 3)
- Assert the prompt contains "character UUID" or equivalent UUID-vs-name clarification (NIT 1)

**Quadrant 2: `describe('masterBackend=vault + vaultMutations=false → read-only vault path')`:**
- Mock prefs `{masterBackend: 'vault', vaultMutations: false, ...}`
- Assert `runVaultToolLoop` called WITHOUT campaignId (or with campaignId:undefined)
- Assert toolCount: 3 in the prompt
- Assert the prompt does NOT contain "apply_event"

**Quadrant 3: `describe('masterBackend=vault + vaultMutations=undefined → read-only (default)')`:**
- Mock prefs `{masterBackend: 'vault'}` (no vaultMutations key)
- Same assertions as Quadrant 2 (default is read-only)

**Quadrant 4: `describe('masterBackend=baked + vaultMutations=true → baked path, gate ignored (Pitfall 5)')`:**
- Mock prefs `{masterBackend: 'baked', vaultMutations: true, ...}` (the operator set the flag on a baked campaign — should have no effect)
- Assert `runToolLoop` (baked path) called once
- Assert `runVaultToolLoop` called ZERO times
- Assert the baked path's behavior is identical to a baked campaign with vaultMutations: false (no side effects from the orphan flag)

**Bonus describe: `describe('env override interaction')`:**
- `it('env MASTER_BACKEND=vault + no stored masterBackend + vaultMutations:true in settings → full vault write path')` — stub env, mock prefs without masterBackend; assert vault write path active.
- `it('env MASTER_BACKEND=vault + masterBackend:baked stored → stored wins, vaultMutations has no effect')` — the stored explicit value overrides env.

Total: 5 describe blocks, ~11 `it` cases (the 4 quadrants × 2-3 assertions each + UUID-vs-name).
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-gate.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~11 cases pass
    - The "baked + vaultMutations:true → gate ignored" test exists and passes (Pitfall 5 enforced at the route layer too)
    - The "vault + vaultMutations:undefined → default false" test exists and passes
    - The "vault + vaultMutations:true → campaignId forwarded" test exists and passes
    - The UUID-vs-name clarification test exists and passes (NIT 1)
    - `grep -c "vaultMutations" tests/sessions/vault-mutations-gate.test.ts` returns ≥ 10
  </acceptance_criteria>
  <done>
    Gate enforcement verified at the route boundary. All four quadrants of the (masterBackend, vaultMutations) Cartesian product covered.
  </done>
</task>

<task type="auto">
  <name>Task 4: Write tests/sessions/vault-mutations-resume.test.ts — state survives via replay</name>
  <files>tests/sessions/vault-mutations-resume.test.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (plan 02-04 — replayEvents, regenerateCharacterView, INITIAL_CHARACTER_STATE fallbacks)
    - src/ai/master/vault/events-schema.ts (plan 02-01 — VaultSeedCharacter; hp_current + spell_slots are OPTIONAL)
    - src/db/schema/characters.ts (informational — hpMax always present; spellcasting may be null)
    - src/db/schema/session-state.ts (informational — hpCurrent lives per-session; may not exist)
    - tests/ai/master/vault/apply-event-integration.test.ts (plan 02-07 — restart simulation pattern via vi.resetModules)
    - .planning/phases/02-vault-write-path-event-sourcing/02-VALIDATION.md (Phase gate row: "Restart preserves state via events.md replay on session resume")
  </read_first>
  <action>
Create `tests/sessions/vault-mutations-resume.test.ts`. Cover the Phase-gate invariant: "Restart of Next.js server preserves state via events.md replay on session resume" from the ROADMAP.

**Seed fixture shape (mirrors plan 02-01 + plan 02-10 Task 4 schema reality):**

The synthetic seed events written in this test file MUST match what the flip script actually produces. That means:
- `id`, `name`, `hp_max` are REQUIRED (top-level required fields per validateEvent).
- `hp_current` is OPTIONAL — include it ONLY in fixtures that simulate a campaign with a played session (session_state.hpCurrent existed); OMIT it in fixtures that simulate freshly-created campaigns (the projector defaults to hp_max).
- `spell_slots` is OPTIONAL — include it ONLY for caster PCs (characters.spellcasting non-null in the simulated Postgres state); OMIT it for non-casters.

This is the BLOCKER 1 mitigation at the test layer: the resume test must exercise the same OPTIONAL shape that the flip script actually emits, otherwise the test passes against a fictional event shape and the live system fails at runtime.

Test structure — one top-level `describe('vault-mutations resume — replay-on-read invariant')`:

1. **Setup helper** (top of file):
   ```ts
   import type { VaultEventEnvelope, VaultSeedCharacter } from '@/ai/master/vault/events-schema';

   async function writeSeedEvent(
     campaignId: string,
     characters: VaultSeedCharacter[],
   ): Promise<void> {
     // Build a VaultEventEnvelope for campaign_initialized and append.
     // Uses EventsWriter directly so the test owns the test process's
     // module identity and can simulate restart via vi.resetModules.
   }
   ```

2. **`it('a campaign with 0 events has empty replay state')`:**
   - Stub VAULT_CAMPAIGNS_ROOT, create campaignDir
   - Do NOT write any events.md (file does not exist)
   - Call `replayEvents(await parseEventsFile(eventsPath(uuid)))` → returns empty Map
   - This documents the new-campaign starting state.

3. **`it('freshly-created campaign seed (no hp_current, no spell_slots) → state.hp_current === hp_max, state.spell_slots === {}')`:**
   - This is the BLOCKER 1 ground-truth fixture: simulates the most common case at flip time — operator runs `pnpm vault:flip --enable-mutations` on a campaign whose characters have never been in a session, so session_state is absent and (assuming a fighter PC) spellcasting is null.
   - Seed: `[{id: 'char-uuid-1', name: 'Rogan the Fighter', hp_max: 25}]` (no hp_current, no spell_slots)
   - `await writeSeedEvent(CAMPAIGN_UUID, seed)`
   - Call `replayEvents(await parseEventsFile(eventsPath(CAMPAIGN_UUID)))`
   - Assert state map has one entry for 'char-uuid-1' with `hp_current: 25` (fallback to hp_max), `spell_slots: {}` (fallback to empty), `hp_max: 25`.
   - This proves the projector's `INITIAL_CHARACTER_STATE` defaults work end-to-end.

4. **`it('played-session campaign seed (hp_current present, spell_slots present) → state matches seed verbatim')`:**
   - Simulates the case after the operator has played a session before flipping: session_state.hpCurrent has a value (12 of 25 hp), the wizard PC has spell_slots populated.
   - Seed: `[{id: 'char-uuid-2', name: 'Elara the Wizard', hp_max: 25, hp_current: 12, spell_slots: {'1': {max: 4, used: 2}, '2': {max: 2, used: 0}}}]`
   - `await writeSeedEvent(CAMPAIGN_UUID, seed)`
   - Call `replayEvents(...)`
   - Assert: `hp_current: 12`, `spell_slots: {'1': {max: 4, used: 2}, '2': {max: 2, used: 0}}`, `hp_max: 25`.

5. **`it('mixed seed (one fresh, one played) → each character defaults independently')`:**
   - Seed: `[{id: 'a', name: 'A', hp_max: 20}, {id: 'b', name: 'B', hp_max: 30, hp_current: 15}]` (first no hp_current, second has it)
   - Replay; assert state['a'].hp_current === 20 (fallback) and state['b'].hp_current === 15 (provided).

6. **`it('a campaign with seed + 5 mutations has the post-mutation state')`:**
   - Seed (use the played-session fixture): a wizard with hp_max:25, hp_current:25 (full hp), spell_slots present.
   - Write seed + 5 hp_change events
   - Call replayEvents → state.hp_current is the expected aggregate (25 + sum of deltas, clamped to [0, 25]).

7. **`it('regenerateCharacterView produces the same view on first call and after simulated restart')`:**
   - Write the events to events.md (use the freshly-created-campaign fixture — no hp_current/no spell_slots — to exercise the defaults path on both module loads).
   - Call regenerateCharacterView → snapshot view file content as `view_v1`
   - Simulate restart: `vi.resetModules()`; re-import the projector module
   - Call regenerateCharacterView again from the fresh module → snapshot as `view_v2`
   - Assert `view_v1 === view_v2` byte-for-byte (proves the replay is deterministic across module load boundaries; spike 008 + 013 invariant at the integration level)

8. **`it('a view file corrupted post-restart can be restored via regenerate')`:**
   - Setup with valid view in place (use the played-session fixture so the view has non-default fields)
   - Corrupt the view file (overwrite with garbage)
   - Call regenerateCharacterView (simulating the recovery script from plan 02-10)
   - Read view file; assert it matches the original (DR roundtrip — spike 013 invariant)

9. **`it('the dispatcher does not duplicate state across two apply_event calls separated by a simulated restart')`:**
   - Seed the campaign (use the freshly-created-campaign fixture so the wizard starts at hp_max).
   - Wait, use a played-session fixture for this one: seed `[{id: 'c', name: 'Caster', hp_max: 20, hp_current: 20, spell_slots: {'1': {max: 3, used: 0}}}]`.
   - Call apply_event via dispatchVaultTool to add +5 HP (which clamps to hp_max=20 — net delta 0; choose a -5 delta instead for clarity). Actually use: -5 hp delta (hp now 15).
   - Simulate restart: vi.resetModules
   - Re-import tools module
   - Call apply_event via the fresh dispatcher to add another -3 HP
   - Read final view: hp_current = 20 - 5 - 3 = 12 (NOT 20 - 5 + (20 - 3) = 32; the second module's reducer correctly replays the first session's event before applying the second session's event).

Total: 1 describe block, ~9 `it` cases (3 of them are the BLOCKER 1 ground-truth fixtures: freshly-created seed, played-session seed, mixed seed).

No DATABASE_URL required (uses the projector + tools directly).
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-resume.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~9 cases pass
    - The "freshly-created campaign seed → hp_max fallback + empty spell_slots fallback" test exists and passes (BLOCKER 1 — fresh-campaign ground truth)
    - The "played-session seed → state matches seed verbatim" test exists and passes (BLOCKER 1 — played-session ground truth)
    - The "mixed seed" test exists and passes (BLOCKER 1 — characters default independently)
    - The "view file corrupted post-restart can be restored via regenerate" test exists and passes (DR roundtrip)
    - The "no duplicate state across simulated restart" test exists and passes (replay determinism)
    - `grep -c "vi.resetModules" tests/sessions/vault-mutations-resume.test.ts` returns ≥ 2 (restart simulation pattern used)
    - `grep -c "VaultSeedCharacter" tests/sessions/vault-mutations-resume.test.ts` returns ≥ 1 (types imported from events-schema, no ad-hoc shape)
    - `grep -c "hp_current: undefined\|hp_current:" tests/sessions/vault-mutations-resume.test.ts` shows BOTH presence and absence of `hp_current` are exercised (the BLOCKER 1 ground truth)
    - `unset DATABASE_URL; pnpm test tests/sessions/vault-mutations-resume.test.ts` exits 0
  </acceptance_criteria>
  <done>
    Phase gate (restart preserves state) is regression-tested. The OPTIONAL hp_current + spell_slots seed shape (BLOCKER 1) is exercised end-to-end at the projector boundary.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 5: Operator confirms the stale-UI banner copy</name>
  <what-built>
    Phase 02 ships single-write semantics (Decision 8): events.md is the source of truth for opted-in campaigns, but the UI continues reading from Postgres until Phase 03. The operator needs an in-app banner so vault-flagged campaigns show "Vault mutations active — UI reflects last Postgres state until session refresh" or similar.

    This checkpoint is BEFORE implementation of the UI banner — confirming the copy + placement BEFORE the operator commits to a phrasing avoids a re-implement.

    Three options to choose from:

    **Option A — Settings-page banner (informational):**
    On the campaign Settings page, show a yellow banner above the vault-mutations toggle that says:
    > "Vault mutations is currently a developer-preview feature. While enabled, game state writes to the markdown vault (`events.md`) but the chat UI continues showing the Postgres state from the previous read. Refresh the campaign page after each session to see the updated view. Phase 03 will sync these automatically."

    **Option B — Campaign-card pill:**
    On the campaigns list, vault-mutations-flagged campaigns get a small pill next to the campaign name reading "VAULT (preview)" — clicking the pill opens a modal with the full explanation.

    **Option C — No banner; rely on docs only.**
    Skip the in-app banner entirely; add the explanation to `docs/operators/vault-backup.md` (plan 02-10) and trust the operator to remember. Justification: only the developer-operator has access to flip the flag; no public users will encounter the stale-UI state.

    Recommendation: **Option A** — minimal UI surface area, clear signal at the toggle point (the moment the operator could be confused), and lives in the page the operator must visit to enable the flag.
  </what-built>
  <how-to-verify>
    1. Read the three options above.
    2. Pick A, B, or C (or describe a fourth alternative).
    3. If A or B: confirm the wording is acceptable. Suggest edits if not.
    4. If C: confirm the operator-facing doc is sufficient.
    5. Type the choice (e.g., "approved-A" or "approved-A with edit: ...").
  </how-to-verify>
  <resume-signal>Type "approved-A", "approved-B", "approved-C", or describe a fourth alternative</resume-signal>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/sessions/vault-mutations-gate.test.ts tests/sessions/vault-mutations-resume.test.ts` → all cases pass
- Command: `pnpm test` (full suite) → still green
- Command: `pnpm typecheck` → clean
- Phase-wide grep gate (BLOCKER 2 — prevents regression of the 3-tool surface assertion): `grep -rn "toBe(3)\|toHaveLength(3)" tests/ --include="*.ts" | grep -iE "vault[_a-z]*tool|tool[_a-z]*surface|VAULT_TOOL" | wc -l` returns 0. Comment-only matches (lines starting with `//` or inside JSDoc) DO NOT count — use `grep -v "^\\s*\\(//\\|\\*\\)"` if needed.
- Manual smoke (per PLAN.md validation step 5):
  1. `pnpm vault:flip --id=<test-uuid> --to=vault --enable-mutations`
  2. Send a combat turn via chat UI
  3. Verify events.md updated
  4. Verify view file updated
  5. Restart `pnpm dev`
  6. Send another turn (read-only) — confirm replay shows the post-restart state

## Open questions

None — phase Decision 8 commits to single-write semantics for Phase 02; the checkpoint task confirms the banner UX choice. If the operator picks Option C (no banner), the UI work is zero and only plan 02-10's operator doc covers the caveat. hashVaultPrompt signature stays `(prompt: string)` (BLOCKER 3 Option A — natural hash divergence via the conditional prompt text).

---

# SUMMARY

**Status:** Complete
**Date:** 2026-05-25
**Wave:** 3b (parallel with plan 02-09 — disjoint files preserved)

## What shipped

1. **`src/ai/master/vault/prompt-builder.ts`** — extended `VaultPromptInput` with optional `vaultMutations?: boolean`. When `true`, the builder bumps the advertised tool count to 4 and appends a brief `apply_event` mention to the protocol block. The mention explicitly clarifies that the `character` field is a **UUID** (not a name) — NIT 1 fix. A symmetric consistency assertion enforces the `(vaultMutations, toolCount)` pairing: `(true, 4)` or `(false|undefined, 3)`; any other combo throws at the entry point.
2. **`hashVaultPrompt(prompt: string)` signature stays UNCHANGED** (BLOCKER 3 Option A). The conditional `applyEventMention` text in the prompt naturally produces hash divergence between read-only and read-write builds. JSDoc above the function documents this natural divergence.
3. **`src/app/api/sessions/[id]/turn/route.ts`** — vault branch now reads `resolveVaultMutations(userPrefs)` once per turn. The resolved `vaultMutationsEnabled` boolean drives: (a) `buildVaultSystemPrompt` `toolCount` + `vaultMutations` inputs, (b) conditional `campaignId: campaign.id` spread into the `runVaultToolLoop` input. Belt-and-suspenders gating: prompt-level (3 vs 4 advertised) + dispatch-level (campaignId presence). Updated comment block documents the 4-quadrant matrix (baked vs vault × vaultMutations true vs false) plus Decision 8 single-write semantics.
4. **`tests/sessions/vault-mutations-gate.test.ts`** — NEW. 19 cases covering the 4 quadrants of (masterBackend, vaultMutations), the env-override interaction (`MASTER_BACKEND=vault`), and the belt-and-suspenders dispatch surface invariant. Mirrors the unit-level pattern of Phase 01's `turn-route-branch.test.ts`.
5. **`tests/sessions/vault-mutations-resume.test.ts`** — NEW. 8 cases covering the phase-gate invariant "Restart preserves state via events.md replay on session resume". Exercises the BLOCKER 1 ground-truth fixtures (freshly-created seed → fallback defaults; played-session seed → verbatim state; mixed seed → per-character independence) plus DR roundtrip (spike 013) and no-duplicate-state across simulated restart.
6. **`src/lib/preferences.ts`** — exported `VAULT_MUTATIONS_STALE_UI_BANNER` constant locking the operator-approved Italian copy: **`"Vault attivo — ricarica per vedere lo stato più recente"`**. Plan 02-10's operator doc + future Settings UI panel reference this constant. Regression test added.
7. **Phase-wide grep gate satisfied** — `grep -rn "toBe(3)\|toHaveLength(3)" tests/ ... | grep -iE "vault[_a-z]*tool|tool[_a-z]*surface|VAULT_TOOL" | wc -l` returns `0`. The legacy 3-tool assertion is gone phase-wide.
8. **Companion update in `tests/sessions/turn-route-branch.test.ts`** — the legacy case that built a 4-tool prompt without `vaultMutations: true` now passes the flag explicitly (the builder's consistency assertion required the pair).

## Checkpoint resolution

**Task 5 (checkpoint:human-verify):** pre-resolved by the user before execution. Decision = **`approved-A`** with exact copy `"Vault attivo — ricarica per vedere lo stato più recente"`. The decision is locked in code as `VAULT_MUTATIONS_STALE_UI_BANNER` and regression-tested. The actual Settings-page UI rendering is part of plan 02-10 (operator doc + UI panel).

## Acceptance criteria — all met

- **Task 1 (prompt-builder):**
  - `grep -c "vaultMutations" src/ai/master/vault/prompt-builder.ts` → 12 (≥ 3 ✓)
  - `grep -c "apply_event" src/ai/master/vault/prompt-builder.ts` → 4 (≥ 1 ✓)
  - `grep -cE "character UUID|character is a UUID|character uuid" src/ai/master/vault/prompt-builder.ts` → 2 (≥ 1 ✓; NIT 1 ✓)
  - REQ-022 forbidden pattern scan → 0 violations ✓
  - `hashVaultPrompt(prompt: string)` signature unchanged ✓
  - Existing Phase 01 prompt-builder tests still green ✓
  - Consistency assertion exercised in tests ✓
  - Hash divergence asserted via `hashVaultPrompt(read-only) !== hashVaultPrompt(read-write)` ✓
- **Task 2 (turn-route gate):**
  - `grep -c "resolveVaultMutations" route.ts` → 2 (≥ 1 ✓)
  - `grep -c "vaultMutationsEnabled" route.ts` → 5 (≥ 3 ✓)
  - `grep -c "campaignId: campaign.id" route.ts` → 2 (≥ 1 ✓)
  - `tests/sessions/turn-route-branch.test.ts` no longer asserts `toBe(3)`/`toHaveLength(3)` against the tool surface ✓
  - Phase 01 turn-route-branch tests post-inversion still pass ✓
  - `pnpm typecheck` exits 0 ✓
- **Task 3 (gate test):**
  - 19 cases pass (plan expected ~11 — exceeded) ✓
  - "baked + vaultMutations:true → gate ignored" exercised ✓ (Pitfall 5)
  - "vault + vaultMutations:undefined → default false" exercised ✓
  - "vault + vaultMutations:true → campaignId forwarded" exercised ✓
  - UUID-vs-name clarification exercised ✓ (NIT 1)
  - `grep -c "vaultMutations" tests/sessions/vault-mutations-gate.test.ts` → 29 (≥ 10 ✓)
- **Task 4 (resume test):**
  - 8 cases pass ✓
  - Freshly-created seed → hp_max fallback + empty spell_slots fallback ✓ (BLOCKER 1)
  - Played-session seed → verbatim state ✓ (BLOCKER 1)
  - Mixed seed → independent defaults ✓ (BLOCKER 1)
  - View corruption → regenerate restores byte-exact ✓ (DR roundtrip — spike 013)
  - No duplicate state across simulated restart ✓ (replay determinism)
  - `grep -c "vi.resetModules" + "freshVaultModule"` → 9 (≥ 2 ✓)
  - `grep -c "VaultSeedCharacter"` → 9 (≥ 1 ✓)
  - `hp_current` presence + absence both exercised ✓
  - Runs without `DATABASE_URL` ✓
- **Task 5 (checkpoint pre-resolved):**
  - Approved Option A, exact Italian copy locked in `VAULT_MUTATIONS_STALE_UI_BANNER` ✓
  - Regression test in `preferences-vault-mutations.test.ts` ✓
- **Plan-level verification:**
  - `pnpm test tests/sessions/vault-mutations-gate.test.ts tests/sessions/vault-mutations-resume.test.ts` → 27/27 passing ✓
  - `pnpm typecheck` → clean ✓
  - Phase-wide grep gate (`toBe(3)|toHaveLength(3)` against tool surface) → 0 matches ✓
  - Full vault test suite (`tests/ai/master/vault/`) → 282 passed, 2 skipped ✓
  - Pre-existing `tests/sessions/applicator.test.ts` failure: unrelated to this plan (engine inventory test; verified on stashed pre-change tree).

## Commits

| # | Hash      | Scope        | Title |
|---|-----------|--------------|-------|
| 1 | `05ac258` | phase-02     | feat: extend vault prompt builder with vaultMutations gate |
| 2 | `27d50e6` | turn-route   | feat: wire vaultMutations gate into the vault branch |
| 3 | `2e33724` | phase-02     | test: branch coverage for vaultMutations gate at turn-route |
| 4 | `eef81c9` | phase-02     | test: resume invariant — state survives via events.md replay |
| 5 | `a493764` | phase-02     | feat: lock stale-UI banner copy (operator approved — Option A) |

## Files touched

| File | Action | LOC |
|---|---|---|
| `src/ai/master/vault/prompt-builder.ts` | EDIT | +50 -3 |
| `src/app/api/sessions/[id]/turn/route.ts` | EDIT | +30 -16 |
| `src/lib/preferences.ts` | EDIT | +15 |
| `tests/ai/master/vault/prompt-builder.test.ts` | EDIT | +68 -2 |
| `tests/sessions/turn-route-branch.test.ts` | EDIT | +2 -0 |
| `tests/lib/preferences-vault-mutations.test.ts` | EDIT | +14 -0 |
| `tests/sessions/vault-mutations-gate.test.ts` | NEW | +234 |
| `tests/sessions/vault-mutations-resume.test.ts` | NEW | +311 |

Total: ~720 LOC across 8 files (~120 source, ~600 tests). The test ratio reflects the BLOCKER 1 ground-truth fixtures (Task 4) and the 4-quadrant branch coverage (Task 3).

## Deviations from plan

None — Tasks 1-5 executed exactly as written. The pre-resolved Task 5 checkpoint shortened the planned UI banner-rendering step into a constant-export + regression test; plan 02-10 owns the actual Settings-page rendering. The route.ts comment block was updated to document the 4-quadrant matrix verbatim per the plan's Task 2 Change 6 specification.

## Wave 3b coordination

Plan 02-09 (concurrent-write-smoke) ran in parallel on disjoint files (`tests/ai/master/vault/events-writer-stress.test.ts` only). No file collisions. The Phase 02 dispatch surface (4 tools) was already in place from Wave 3a (plan 02-07), so the prompt-builder + turn-route extensions land cleanly without touching shared infrastructure.
