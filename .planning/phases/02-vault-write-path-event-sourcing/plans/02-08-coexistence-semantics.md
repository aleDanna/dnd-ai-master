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

The prompt-builder (`src/ai/master/vault/prompt-builder.ts` from Phase 01 plan 02) needs a small extension: a new `vaultMutations?: boolean` input that, when true, bumps the `toolCount` reference from 3 to 4 in the prompt body and adds a one-line mention of `apply_event` to the tool catalog. The pure-function contract (REQ-022) is preserved — the input is a plain boolean, no side effects.

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
    - src/ai/master/vault/prompt-builder.ts (existing — Phase 01 implementation; the input shape; the toolCount substitution; REQ-022 purity contract)
    - .planning/phases/01-vault-read-path/plans/02-vault-prompt-builder.md (style + REQ-022 enforcement)
  </read_first>
  <action>
Edit `src/ai/master/vault/prompt-builder.ts` (preserve everything verbatim except the changes below; REQ-022 forbids any new env/random/timestamp source).

**Change 1 — Extend the input interface.** Locate the input type (probably `BuildVaultSystemPromptInput` or similar). Add an optional field:

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

**Change 3 — Append apply_event mention to the tool catalog when vaultMutations is true.** Locate the section of the prompt template that mentions the tools (or hints at the tool index). Append a conditional line:

```ts
const applyEventMention = input.vaultMutations === true
  ? '\nWhen the player describes a game-state change (damage taken, spell cast, condition applied), call `apply_event` with the appropriate type and payload. One event per call; do not batch.\n'
  : '';
```

Insert `applyEventMention` into the prompt body in a sensible location (after the tool-listing section, before the campaign context block). The exact placement should mirror Phase 01's existing builder structure — read the file to identify the right insertion point.

The mention is INTENTIONALLY brief — the LLM is supposed to read `/tools/apply_event.md` (or whatever the lazy tool-doc convention is) for the schema; the system prompt just signals the tool exists.

**Change 4 — Update hashVaultPrompt to include vaultMutations in the hash.** If `hashVaultPrompt` exists (Phase 01 sibling helper), make sure its input shape includes vaultMutations so prompts with different gating produce different hashes (prevents prefix-cache cross-contamination between read-only and read-write sessions). Implementation: just pass `vaultMutations: input.vaultMutations ?? false` into the hash input record.

**Change 5 — Preserve REQ-022 purity.** Run the existing forbidden-pattern check (Phase 01's `__forbidden-patterns.ts`) — the new code does NOT add any `Date.now()`, `Math.random`, `process.env`, `randomUUID`, `process.hrtime`, hostname reference. Pure boolean input.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/prompt-builder.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "vaultMutations" src/ai/master/vault/prompt-builder.ts` returns ≥ 3
    - `grep -c "apply_event" src/ai/master/vault/prompt-builder.ts` returns ≥ 1
    - `grep -cE "Date\\.now\\(|Math\\.random|process\\.env|randomUUID|process\\.hrtime" src/ai/master/vault/prompt-builder.ts` returns 0 (REQ-022 hygiene preserved)
    - Phase 01's prompt-builder tests still pass (existing assertions about toolCount=3 are still valid for the read-only case)
    - The new consistency assertion (vaultMutations:true requires toolCount:4) is exercised by a test case
  </acceptance_criteria>
  <done>
    Prompt builder extended. Task 2 uses it from the turn route.
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
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-gate.test.ts && pnpm test tests/sessions/turn-route-branch.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "resolveVaultMutations" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 1
    - `grep -c "vaultMutationsEnabled" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 3 (declaration + prompt-builder arg + loop arg)
    - `grep -c "campaignId: campaign.id" src/app/api/sessions/[id]/turn/route.ts` returns ≥ 1
    - Phase 01's `tests/sessions/turn-route-branch.test.ts` still passes (Phase 01 cases didn't set vaultMutations; the resolver returns false; behavior unchanged)
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>
    Turn-route gate wired. Tasks 3 + 4 verify the branches and the resume invariant.
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

Total: 5 describe blocks, ~10 `it` cases (the 4 quadrants × 2-3 assertions each).
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-gate.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~10 cases pass
    - The "baked + vaultMutations:true → gate ignored" test exists and passes (Pitfall 5 enforced at the route layer too)
    - The "vault + vaultMutations:undefined → default false" test exists and passes
    - The "vault + vaultMutations:true → campaignId forwarded" test exists and passes
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
    - src/ai/master/vault/projector.ts (plan 02-04 — replayEvents, regenerateCharacterView)
    - tests/ai/master/vault/apply-event-integration.test.ts (plan 02-07 — restart simulation pattern via vi.resetModules)
    - .planning/phases/02-vault-write-path-event-sourcing/02-VALIDATION.md (Phase gate row: "Restart preserves state via events.md replay on session resume")
  </read_first>
  <action>
Create `tests/sessions/vault-mutations-resume.test.ts`. Cover the Phase-gate invariant: "Restart of Next.js server preserves state via events.md replay on session resume" from the ROADMAP.

Test structure — one top-level `describe('vault-mutations resume — replay-on-read invariant')`:

1. **Setup helper** (top of file):
   ```ts
   async function simulateSession(events: VaultEventEnvelope[]): Promise<CharacterState> {
     // Stub env, write events to events.md, call replayEvents, return the character state.
   }
   ```

2. **`it('a campaign with 0 events has empty replay state')`:**
   - Stub VAULT_CAMPAIGNS_ROOT, create campaignDir
   - Do NOT write any events.md (file does not exist)
   - Call `replayEvents(await parseEventsFile(eventsPath(uuid)))` → returns empty Map
   - This documents the new-campaign starting state.

3. **`it('a campaign with seed event has the seeded character')`:**
   - Write campaign_initialized event to events.md by hand
   - Call replayEvents → state map contains the seeded character
   - The state's hp_current equals the seed's hp_current value (or hp_max if hp_current not specified).

4. **`it('a campaign with seed + 5 mutations has the post-mutation state')`:**
   - Write seed + 5 hp_change events
   - Call replayEvents → state.hp_current is the expected aggregate.

5. **`it('regenerateCharacterView produces the same view on first call and after simulated restart')`:**
   - Write the events to events.md
   - Call regenerateCharacterView → snapshot view file content as `view_v1`
   - Simulate restart: `vi.resetModules()`; re-import the projector module
   - Call regenerateCharacterView again from the fresh module → snapshot as `view_v2`
   - Assert `view_v1 === view_v2` byte-for-byte (proves the replay is deterministic across module load boundaries; spike 008 + 013 invariant at the integration level)

6. **`it('a view file corrupted post-restart can be restored via regenerate')`:**
   - Setup with valid view in place
   - Corrupt the view file (overwrite with garbage)
   - Call regenerateCharacterView (simulating the recovery script from plan 02-10)
   - Read view file; assert it matches the original (DR roundtrip — spike 013 invariant)

7. **`it('the dispatcher does not duplicate state across two apply_event calls separated by a simulated restart')`:**
   - Call apply_event via dispatchVaultTool to add +5 HP (campaign + seed + hp_change=+5)
   - Simulate restart: vi.resetModules
   - Re-import tools module
   - Call apply_event via the fresh dispatcher to add -3 HP
   - Read final view: hp_current = seed.hp_max + 5 - 3 (NOT seed.hp_max + 5 + 5 - 3; the second module's reducer correctly replays the first session's event before applying the second session's event)

Total: 1 describe block, ~7 `it` cases.

No DATABASE_URL required (uses the projector + tools directly).
  </action>
  <verify>
    <automated>pnpm test tests/sessions/vault-mutations-resume.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~7 cases pass
    - The "view file corrupted post-restart can be restored via regenerate" test exists and passes (DR roundtrip)
    - The "no duplicate state across simulated restart" test exists and passes (replay determinism)
    - `grep -c "vi.resetModules" tests/sessions/vault-mutations-resume.test.ts` returns ≥ 2 (restart simulation pattern used)
    - `unset DATABASE_URL; pnpm test tests/sessions/vault-mutations-resume.test.ts` exits 0
  </acceptance_criteria>
  <done>
    Phase gate (restart preserves state) is regression-tested.
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
- Manual smoke (per PLAN.md validation step 5):
  1. `pnpm vault:flip --id=<test-uuid> --to=vault --enable-mutations`
  2. Send a combat turn via chat UI
  3. Verify events.md updated
  4. Verify view file updated
  5. Restart `pnpm dev`
  6. Send another turn (read-only) — confirm replay shows the post-restart state

## Open questions

None — phase Decision 8 commits to single-write semantics for Phase 02; the checkpoint task confirms the banner UX choice. If the operator picks Option C (no banner), the UI work is zero and only plan 02-10's operator doc covers the caveat.
