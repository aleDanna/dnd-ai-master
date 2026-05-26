---
phase: 03
plan: A-01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "COMPLETENESS-AUDIT.md exists at .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md"
    - "Every key in TOOL_HANDLERS exported from src/engine/tools/handlers.ts is listed in the audit (60+ entries — match `grep -cE '^\\s+[a-z_]+: \\(state' src/engine/tools/handlers.ts`)"
    - "Each handler is classified into exactly one of (a) already-covered by a Phase 02 event type, (b) stateless, (c) needs-new-event-type"
    - "For each (c) entry, the audit specifies the proposed event type name (e.g., temp_hp_set), the payload shape, the CharacterState fields it mutates, and a one-line rationale"
    - "The audit document closes with a concrete (c) list ready for plan 03-A-02 to ship as new VaultEvent union members + plan 03-A-03 to ship as projector arms"
  artifacts:
    - path: ".planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md"
      provides: "Authoritative classification of engine handlers; (c) list drives Phase 03-A-02 and 03-A-03 implementation"
      contains: "needs-new-event-type"
  key_links:
    - from: ".planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (c) list"
      to: "src/ai/master/vault/events-schema.ts (plan 03-A-02 extension)"
      via: "Each (c) entry becomes a new VaultEvent union member"
      pattern: "needs-new-event-type"
    - from: ".planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md (c) list"
      to: "src/ai/master/vault/projector.ts (plan 03-A-03 extension)"
      via: "Each (c) entry becomes a reducer arm + INITIAL_CHARACTER_STATE field if new"
      pattern: "needs-new-event-type"
---

# Plan 03-A-01: Mutation-Event Completeness Audit (GATING)

**Phase:** 03-migration-cutover
**Wave:** 1 (gating pre-task — Phase 03-A-02 + 03-A-03 + 03-A-09 depend on the (c) list this plan produces)
**Status:** Pending
**Estimated diff size:** ~250 LOC docs (the audit itself) / 1 file

## Goal

Phase 02 ships 8 event types in `VAULT_EVENT_TYPES` (`hp_change`, `condition_add/remove`, `spell_slot_use/restore`, `inventory_add/remove`, `campaign_initialized` seed). The engine handlers in `src/engine/tools/handlers.ts` ship 60+ mutation handlers. Many touch persisted `SessionState` / `Character` fields without a current vault counterpart.

If dual-write turns on for a campaign before the gap closes, every combat turn that triggers an uncovered handler will write to Postgres but NOT to vault → parity-check fires divergence → divergence rate ~100% on combat turns (Pitfall 1 in RESEARCH).

This plan is the GATING audit. Output is a markdown report at `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` that classifies every `TOOL_HANDLERS` entry as:
- **(a) Already covered** — the handler's persisted mutation maps to an existing Phase 02 event type (e.g., `apply_damage` → `hp_change` with negative delta).
- **(b) Stateless** — the handler doesn't mutate persisted state (e.g., `roll_dice`, `ability_check` only emits dice rolls; the dice log is separate from session state).
- **(c) Needs a new event type** — the handler mutates persisted state in a way no Phase 02 event captures (e.g., `make_death_save` → new `death_save_success` / `death_save_fail`; `apply_damage` with `tempHp` involvement → new `temp_hp_set`).

The audit is the input to plan 03-A-02 (extend events-schema.ts with the (c) list) and plan 03-A-03 (extend projector with reducer arms + new INITIAL_CHARACTER_STATE fields).

## Requirements satisfied

- **REQ-006** DR via events.md replay — DR is only valid if events.md captures EVERY persisted mutation. The audit guarantees this for the dual-write window onwards. Without the (c) coverage, replay reproduces an incomplete state on a restored campaign.

## Files touched

| File | Action | Why |
|---|---|---|
| `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` | NEW | The audit report. Authoritative reference for plans 03-A-02 + 03-A-03 + 03-A-09. |

## Tasks

<task type="auto">
  <name>Task 1: Enumerate every TOOL_HANDLERS entry in src/engine/tools/handlers.ts</name>
  <files>.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md</files>
  <read_first>
    - src/engine/tools/handlers.ts (entire file — the `TOOL_HANDLERS` const lives at the top; per-handler arrow functions span lines 99-1100+)
    - src/engine/types.ts (or wherever `CharacterState` / `SessionState` / `EngineState` / `TurnState` types are defined — the persisted state shapes)
    - src/db/schema/session-state.ts (the actual Postgres-persisted SessionState columns — hp_current, temp_hp, hit_dice_remaining, spell_slots_used, conditions, resources_used, death_saves, flags, exhaustion_level, concentrating_on, turn_state, position, in_combat, combat, scene, inventory_delta, status_flag, ...)
    - src/db/schema/characters.ts (the Character row — hp_max, spellcasting.slotsMax, spellSlotsUsed, inventory, ...)
    - src/ai/master/vault/events-schema.ts (the existing 8 VaultEvent types — establish what counts as "already covered")
    - src/ai/master/vault/projector.ts (the existing applyEvent reducer + CharacterState shape — establish what fields vault currently tracks)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Pitfall 1 + Decision 10 — the audit rationale)
  </read_first>
  <action>
Create `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md`.

Step 1: Generate the raw handler list. Run (the output goes into the audit document):
```
grep -nE '^\s+[a-z_]+: \(state' src/engine/tools/handlers.ts
```
This returns 60+ handler names with line numbers. Use this list as the spine of the audit — every entry MUST be classified.

Step 2: For EACH handler, READ the handler body in `src/engine/tools/handlers.ts` (use the line numbers from step 1 + Read with offset/limit) and inspect:
- Does it `state.character.X = ...` or `state.X = ...`? (mutation → check what column persists this)
- Does it only emit dice rolls / read state without write? (stateless)
- What `SessionState` or `Character` field does it touch?
- Does the persisted column have a Phase 02 event type mapping?

Step 3: Write the audit document with this exact structure:

```markdown
# Phase 03 — Mutation Event Completeness Audit

**Phase:** 03-migration-cutover
**Plan:** 03-A-01 (gating pre-task — output drives 03-A-02 + 03-A-03)
**Date:** 2026-05-26

## Purpose

Phase 02 ships 8 event types covering HP, conditions, spell slots, inventory, and the campaign seed. The engine handlers in `src/engine/tools/handlers.ts` ship 60+ mutations. If dual-write activates without closing the gap, divergence rate is ~100% on combat turns (RESEARCH Pitfall 1).

This audit classifies every `TOOL_HANDLERS` entry as:
- **(a) Already covered** — maps cleanly onto an existing Phase 02 event type
- **(b) Stateless** — no persisted state mutation (dice rolls, read-only checks)
- **(c) Needs a new event type** — Phase 03-A-02 ships the union member, Phase 03-A-03 ships the projector arm

## Methodology

Source: `src/engine/tools/handlers.ts` at HEAD. Each handler key inspected for `state.X = ...` writes. Cross-referenced against:
- `src/db/schema/session-state.ts` (persisted SessionState columns)
- `src/db/schema/characters.ts` (Character row)
- `src/ai/master/vault/events-schema.ts` Phase 02 event types
- `src/ai/master/vault/projector.ts` CharacterState shape

## Classification Table

| Handler | Line | Persisted Mutation | Class | Vault Event |
|---|---|---|---|---|
| `roll_dice` | 99 | (none — emits dice log only) | (b) | — |
| `ability_check` | 115 | (none — derived check + dice log) | (b) | — |
| ... | ... | ... | ... | ... |
| `apply_damage` | 201 | `state.hp_current -= damage`, may set `state.tempHp = 0` if temp HP absorbed | (a) PLUS (c) | `hp_change` + NEW `temp_hp_set` |
| `apply_condition` | 292 | `state.conditions.push(...)` | (a) | `condition_add` |
| `make_death_save` | 458 | `state.deathSaves.successes++` or `state.deathSaves.failures++`, may set `state.flags.stable = true` or `state.flags.dead = true` | (c) | NEW `death_save_success`, `death_save_fail`, `death_save_stabilize`, `death_save_died` |
| ... | ... | ... | ... | ... |

[Continue for every handler — 60+ rows. Aim for one row per handler.]

## Summary

- **(a) Already covered:** N handlers
- **(b) Stateless:** N handlers
- **(c) Needs new event type:** N distinct new event types (M handlers map to them)

## (c) — New Event Types to Ship in Plan 03-A-02

This is the authoritative list. Plan 03-A-02 adds each as a new `VaultEvent` union member; plan 03-A-03 adds a reducer arm + INITIAL_CHARACTER_STATE field where needed.

### Event type: `temp_hp_set`

**Triggering handlers:** `apply_damage` (when target has temp HP), `use_resource` (when resource grants temp HP — e.g., Aid spell), `short_rest` (when feature restores temp HP)

**Payload shape:**
```ts
{ type: 'temp_hp_set', payload: { character: string; tempHp: number } }
```

**Persisted field:** `state.tempHp` (existing `session_state.temp_hp` column, integer >= 0)

**Projector arm (plan 03-A-03):** reducer sets `state.temp_hp = Math.max(0, payload.tempHp)`. INITIAL_CHARACTER_STATE adds `temp_hp: 0` default.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && Number.isFinite(tempHp) && tempHp >= 0`.

**Rationale:** Combat handlers set/reset tempHp orthogonally to hp_current — separate event type avoids overloading `hp_change`.

### Event type: `death_save_success`

**Triggering handlers:** `make_death_save` when roll succeeds

**Payload shape:**
```ts
{ type: 'death_save_success', payload: { character: string } }
```

**Persisted field:** `state.deathSaves.successes` (existing `session_state.death_saves` JSONB column)

**Projector arm (plan 03-A-03):** `state.death_saves.successes++`; if `successes === 3`, also set `state.flags.stable = true` and reset both counters. INITIAL_CHARACTER_STATE adds `death_saves: { successes: 0, failures: 0 }`.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0`.

**Rationale:** Death-save state is critical for combat continuity; replaying after restart MUST reproduce the death-save counter exactly.

### Event type: `death_save_fail`

**Triggering handlers:** `make_death_save` when roll fails (or critical failure → +2)

**Payload shape:**
```ts
{ type: 'death_save_fail', payload: { character: string; critical?: boolean } }
```

**Persisted field:** `state.deathSaves.failures`

**Projector arm (plan 03-A-03):** `state.death_saves.failures += critical ? 2 : 1`; if `failures >= 3`, also set `state.flags.dead = true`. INITIAL_CHARACTER_STATE: same as above.

**Validator (plan 03-A-02):** `typeof character === 'string' && character.length > 0 && (critical === undefined || typeof critical === 'boolean')`.

### Event type: `death_save_stabilize`

**Triggering handlers:** `stabilize` (line ~465)

**Payload shape:**
```ts
{ type: 'death_save_stabilize', payload: { character: string } }
```

**Persisted field:** `state.flags.stable = true`, resets `state.deathSaves` to `{ successes: 0, failures: 0 }`

**Projector arm (plan 03-A-03):** sets `state.flags.stable = true`, zeros death_saves.

### Event type: `concentration_break`

**Triggering handlers:** `concentration_check` when fails, OR `apply_condition` for incapacitating conditions

**Payload shape:**
```ts
{ type: 'concentration_break', payload: { character: string } }
```

**Persisted field:** `state.concentratingOn` (existing `session_state.concentrating_on` JSONB column, nullable)

**Projector arm (plan 03-A-03):** `state.concentrating_on = null`. INITIAL_CHARACTER_STATE adds `concentrating_on: null`.

### Event type: `concentration_set`

**Triggering handlers:** When a player casts a concentration spell

**Payload shape:**
```ts
{ type: 'concentration_set', payload: { character: string; spellSlug: string; slotLevel: number; startedRound: number } }
```

**Persisted field:** `state.concentratingOn`

**Projector arm:** sets `state.concentrating_on = { spellSlug, slotLevel, startedRound }`.

### Event type: `exhaustion_set`

**Triggering handlers:** `apply_starvation`, `apply_dehydration`, `forced_march`, `apply_suffocation`

**Payload shape:**
```ts
{ type: 'exhaustion_set', payload: { character: string; level: number } }
```

**Persisted field:** `state.exhaustionLevel` (integer 0-10)

**Projector arm:** `state.exhaustion_level = Math.max(0, Math.min(10, payload.level))`. INITIAL_CHARACTER_STATE adds `exhaustion_level: 0`.

### Event type: `hit_dice_use`

**Triggering handlers:** `short_rest` (when player spends hit dice for healing)

**Payload shape:**
```ts
{ type: 'hit_dice_use', payload: { character: string; count: number } }
```

**Persisted field:** `state.hitDiceRemaining` (integer)

**Projector arm:** `state.hit_dice_remaining = Math.max(0, state.hit_dice_remaining - payload.count)`. INITIAL_CHARACTER_STATE seeds from `state.hitDiceRemaining` at flip time.

### Event type: `hit_dice_restore`

**Triggering handlers:** `long_rest` (full restore = level/2)

**Payload shape:**
```ts
{ type: 'hit_dice_restore', payload: { character: string; count: number } }
```

**Projector arm:** `state.hit_dice_remaining = Math.min(state.hit_dice_max, state.hit_dice_remaining + payload.count)`.

### Event type: `attune`

**Triggering handlers:** `attune` (line ~549)

**Payload shape:**
```ts
{ type: 'attune', payload: { character: string; itemSlug: string } }
```

**Persisted field:** `state.attunements` (NEW field — currently lives in `state.inventoryDelta` or character attunement slots)

**Projector arm:** appends to `state.attunements`. INITIAL_CHARACTER_STATE adds `attunements: []`.

### Event type: `unattune`

**Triggering handlers:** `unattune` (line ~589)

**Payload shape:**
```ts
{ type: 'unattune', payload: { character: string; itemSlug: string } }
```

**Projector arm:** removes from `state.attunements`.

### Event type: `resource_use`

**Triggering handlers:** `use_resource` (line ~316), `use_class_feature`, `use_action_surge`, `use_channel_divinity`, `use_lay_on_hands`, `start_rage`, `end_rage`, `grant_bardic_inspiration`

**Payload shape:**
```ts
{ type: 'resource_use', payload: { character: string; resourceKey: string; delta: number } }
```

**Persisted field:** `state.resourcesUsed` (existing `session_state.resources_used` JSONB column)

**Projector arm:** `state.resources_used[resourceKey] = (state.resources_used[resourceKey] ?? 0) + delta`. INITIAL_CHARACTER_STATE adds `resources_used: {}`.

**Rationale:** Single generic event covers all per-feature/per-class resource counters (rage uses, channel divinity uses, action surge uses, etc.) instead of one event type per feature.

### Event type: `inspiration_grant`

**Triggering handlers:** `grant_inspiration` (line ~487)

**Payload shape:**
```ts
{ type: 'inspiration_grant', payload: { character: string } }
```

**Persisted field:** `state.flags.inspiration` (new boolean OR existing field in `state.flags`)

**Projector arm:** `state.flags.inspiration = true`. INITIAL_CHARACTER_STATE adds `flags: { inspiration: false }`.

### Event type: `inspiration_spend`

**Triggering handlers:** `spend_inspiration` (line ~494)

**Payload shape:**
```ts
{ type: 'inspiration_spend', payload: { character: string } }
```

**Projector arm:** `state.flags.inspiration = false`.

### Event type: `xp_award`

**Triggering handlers:** `award_xp` (line ~413)

**Payload shape:**
```ts
{ type: 'xp_award', payload: { character: string; amount: number } }
```

**Persisted field:** `state.xp` (NEW field at vault level; currently lives in `characters.xp` column)

**Projector arm:** `state.xp = (state.xp ?? 0) + payload.amount`. INITIAL_CHARACTER_STATE seeds from `characters.xp` at flip time.

### Event type: `level_up`

**Triggering handlers:** `level_up` (line ~359), `add_class_level` (line ~377)

**Payload shape:**
```ts
{ type: 'level_up', payload: { character: string; newLevel: number; classSlug?: string } }
```

**Persisted field:** `state.level` + `state.classes` (or similar)

**Projector arm:** sets `state.level = newLevel`. Multi-class info captured via optional `classSlug`. INITIAL_CHARACTER_STATE seeds from characters.classLevels.

[Continue for the full (c) list — the actual audit fills in every handler. Aim for 8-15 new event types per RESEARCH estimate.]

## (a) — Already-covered handler mapping

Quick reference for plan 03-A-09 DualWriter parity-check author — these handlers DO have a vault event already.

| Handler | Phase 02 event | Notes |
|---|---|---|
| `apply_damage` | `hp_change` (delta < 0) | Plus `temp_hp_set` for tempHp interactions (see (c) above) |
| `apply_condition` | `condition_add` | |
| `remove_condition` | `condition_remove` | |
| (use_resource for spell slots) | `spell_slot_use` | |
| `short_rest` (spell-slot recovery) | `spell_slot_restore` | Warlock-style short rest restores |
| `long_rest` (full spell-slot restore) | multiple `spell_slot_restore` events, one per used level |
| `add_item` | `inventory_add` | |
| `remove_item` | `inventory_remove` | |

## (b) — Stateless handlers

These handlers don't mutate persisted SessionState/Character columns. Dual-write does NOT need to emit a vault event for them; the LLM tool call surfaces in the message log but produces no state delta.

- `roll_dice` — dice log only
- `ability_check`, `saving_throw`, `roll_initiative`, `make_attack` — derived rolls + dice log
- `end_turn`, `end_combat`, `take_action`, `move_to_band` — turn-state mutations (in `turn_state` JSONB) but these are NOT replayed for game-state recovery — the turn structure is per-session UI, regenerated from events on demand
- `recompute_ac` — derived calculation
- `set_travel_pace`, `set_light_level`, `set_marching_order`, `set_senses`, `check_vision`, `apply_falling` (instantaneous damage handled via `apply_damage` event)
- `set_mount_mode`, `mount`, `dismount`, `embark_vehicle`, `disembark_vehicle` — narrative metadata
- `swap_attack_target` — combat-turn metadata only

NOTE: any handler currently classified (b) MUST be re-confirmed by reading the body — some may write to `state.X` and need reclassification to (a) or (c).

## (c) Final list — for plan 03-A-02

```
1. temp_hp_set
2. death_save_success
3. death_save_fail
4. death_save_stabilize
5. concentration_break
6. concentration_set
7. exhaustion_set
8. hit_dice_use
9. hit_dice_restore
10. attune
11. unattune
12. resource_use
13. inspiration_grant
14. inspiration_spend
15. xp_award
16. level_up
```

Each entry maps to:
- A new `VaultEvent` union member (plan 03-A-02)
- A reducer arm in `applyEvent` (plan 03-A-03)
- A `validateEvent` case (plan 03-A-02)
- A test case in `tests/ai/master/vault/events-schema.test.ts` + `tests/ai/master/vault/projector.test.ts` (plans 03-A-02/03)

## Open items for the planner

If the audit surfaces a handler that has CROSS-CHARACTER side effects (e.g., AOE damage hits 3 characters), the event-per-character pattern STILL works — emit N events, one per affected character — but the LLM tool dispatch loop must emit each event individually. The dispatcher already supports this (one tool call per event).

If the audit surfaces a handler that mutates session-level state (not character-level) — e.g., `set_bastion` mutates `state.bastion`, which has no per-character semantics — the seed shape (`campaign_initialized`) needs an extension OR a new `session_state_set` event type. Defer this decision to plan 03-A-02 IF such handlers exist; the audit must flag them under a new "(d) Session-level state" subsection.

## Confidence

HIGH on the methodology (mechanical grep + read); MEDIUM on the (c) count estimate — the actual count emerges when the audit is performed. RESEARCH Assumption A2 budgets 8-15 new event types; this audit confirms or refines.

## Sign-off

Audit author: (executor)
Audit reviewed by: (operator)
Date: 2026-05-26
```

Step 4: After writing the audit, RUN the actual grep + classification work. The example rows above are PLACEHOLDERS — the real audit fills them in from the source. Use grep + Read to inspect each handler:

```
grep -nE '^\s+[a-z_]+: \(state' src/engine/tools/handlers.ts > /tmp/handlers.txt
```

Then for EACH line in /tmp/handlers.txt, Read the surrounding 30 lines to inspect the body, classify, and fill in the row.

The deliverable is the FULL audit document with EVERY handler classified — not a placeholder. The (c) section MUST list each new event type with its payload shape, persisted field, projector behavior, and validator rule.
  </action>
  <verify>
    <automated>test -f .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md && grep -c "Class" .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md | xargs -I {} test {} -ge 1 && grep -cE "^\| \`[a-z_]+\` \|" .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md</automated>
  </verify>
  <acceptance_criteria>
    - File `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` exists
    - `grep -c "^\| \`[a-z_]+\` \|" .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` returns ≥ 50 (one row per handler — 50+ classified)
    - `grep -c "(a) Already covered\|(b) Stateless\|(c) Needs" .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` returns ≥ 3 (all three classes documented)
    - `grep -c "## (c) Final list" .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` returns exactly 1
    - The "(c) Final list" section has between 6 and 20 numbered event types (RESEARCH estimate is 8-15; cover the full range to accommodate audit surprise)
    - Every (c) entry has: payload shape (TypeScript-typed), persisted field, projector arm description, validator rule
    - The handler count in the table matches `grep -cE '^\s+[a-z_]+: \(state' src/engine/tools/handlers.ts` (the source list)
    - No PLACEHOLDER rows — every row must have real values
  </acceptance_criteria>
  <done>
    Audit complete. Plans 03-A-02 (events-schema extension) and 03-A-03 (projector extension) consume the (c) list directly.
  </done>
</task>

---

## SUMMARY (03-A-01 execution)

**Status:** COMPLETE
**Commit:** `5548e3c` — `docs(phase-03): COMPLETENESS-AUDIT for engine mutation events (plan 03-A-01)`
**Duration:** ~9 min (audit research + write + verify)
**Output artifact:** `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` (729 lines, 56 KB)

### Acceptance criteria — all PASS

| Criterion | Result |
|---|---|
| File `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` exists | PASS |
| Handler row count >= 50 | 83 rows (PASS) |
| All 3 classes (a)/(b)/(c) documented | 6 hits (PASS) |
| `## (c) Final list` header exactly 1 | 1 (PASS) |
| 6-20 numbered event types in `(c) Final list` | 20 (PASS — at upper bound) |
| Every (c) entry has payload + persisted field + projector arm + validator | 22 detailed specs covering all entries (PASS) |
| Handler count matches source (61 TOOL_HANDLERS in handlers.ts) | audit covers all 61 + 7 TOOL_HANDLERS_DB (PASS) |
| No PLACEHOLDER rows | 0 hits (PASS) |

### Findings summary

- **(a) Already covered:** 18 handlers (full or partial overlap with Phase 02's 7 mutation event types)
- **(b) Stateless / out-of-vault-scope:** 11 handlers
- **(c) Needs new event type:** 47 handlers → **20 hard new event types** required for parity (numbered roster in COMPLETENESS-AUDIT.md §"(c) Final list")
- **Recommended additions for multi-class support:** `level_up` + `class_level_add` (total 22)
- **Provisional / planner-decision events:** up to 6 more (`tonal_frame_set`, `engagement_profile_set`, `npc_beats_update`, `long_rest_stamp`, `ac_recompute`, `senses_set`) — see Open Items §(d)/§(f)/§(j) in the audit

The audit EXCEEDS RESEARCH Assumption A2's 8-15 budget by 5-13 events. Rationale documented (death-save variants, exhaustion stacking, per-feature resources, multi-class, focus/attunement/inspiration subsystems Phase 02 did not enumerate).

### Critical blocker flagged for Phase 03 Wave 2

**`src/engine/tools/handlers.ts` contains UNRESOLVED Git merge conflict markers** at lines 942, 2277, 3186, 3196, 3213, 3375, 3379 (`<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes`). This was in the repo state BEFORE plan 03-A-01 started (NOT caused by this plan). The audit was authored over BOTH conflict-block sides as a union.

- **Impact on 03-A-01:** none (audit is OUTPUT-ONLY on engine files)
- **Impact on 03-A-02:** BLOCKING — cannot extend `events-schema.ts` while `tsc` cannot compile `handlers.ts`
- **Required action before Wave 2:** operator resolves the merge conflict (choose `Updated upstream` / `Stashed changes` / hand-merge)

Deferred to `.planning/phases/03-migration-cutover/deferred-items.md` (file pre-exists; appending advisable but out of scope per contract).

### Deviations from plan

**Contamination of second commit 261805e:** `scripts/vault-flip-helpers.ts` was inadvertently included in the SUMMARY-append commit. This file is owned by plan 03-A-06 (helpers extraction from `scripts/vault-flip.ts`) and was present as a staged file in the working tree before plan 03-A-01 began. The first commit `5548e3c` was clean (audit file only); the second commit picked up the residual staged file even though `git add` was scoped to the plan markdown.

**Impact assessment:**
- The file content is from plan 03-A-06's agent's working state (already extracted by that plan's executor).
- Plan 03-A-06 will discover this file already committed when it runs; it can ADD additional content or document the early commit.
- No destructive recovery attempted (per `destructive_git_prohibition` rules: NEVER `git rm` on files not explicitly created by the current task; NEVER amend).
- Files in commit 261805e: `03-A-01-completeness-audit.md` (mine) + `scripts/vault-flip-helpers.ts` (contamination).

**Root cause:** unresolved merge state in the repo at plan start (UU markers on 11 files, A on the contaminating file). The contract specified "atomic commit per task" but the staged index already contained plan 03-A-06 work. The first commit's `git reset HEAD --` unstaging step missed listing `scripts/vault-flip-helpers.ts` (only the UU and explicit conflict files were unstaged).

**Mitigation handoff:** plan 03-A-06's executor should `git log -p scripts/vault-flip-helpers.ts` to inspect what was captured in commit 261805e, then add any additional helpers / tests / fixtures in a NEW commit. If plan 03-A-06's executor's working state has diverged from this version, they will need to reconcile.

Plan 03-A-01's PRIMARY OUTPUT (the audit document) is unaffected — that commit (5548e3c) is clean.

### Open items handed off to planner (in COMPLETENESS-AUDIT.md §"Open items for the planner")

- **§(d)** Campaign-level / NPC-level / session-level events — Option A (extend VaultEvent), Option B (extend seed + new event types), or Option C (Phase 03 acceptable divergence). Audit recommends **Option B**.
- **§(e)** Cross-character side effects — no new infrastructure needed (already handled by per-event dispatch).
- **§(f)** `recompute_ac` classification — (c) `ac_recompute` event vs (b) post-replay derivation. Audit recommends **(b) + derivation step**.
- **§(g)** `consume_ammo` — reuse `inventory_remove` (no new event needed).
- **§(h)** Long-rest condition cleanup — dual-write layer must translate `remove_condition('exhaustion')` → `exhaustion_decrement` vault event.
- **§(i)** Cross-turn `add_inventory` dedup — intentional divergence between Postgres (deduped) and vault (literal). Plan 03-A-09 must honor the applicator's `cross_turn_suppressed` warning as a vault-no-emit signal.

### Self-check

- COMPLETENESS-AUDIT.md exists at expected path: VERIFIED via `git ls-tree HEAD`
- Commit `5548e3c` present in `git log --all`: VERIFIED
- 1 file changed (+729 lines), zero deletions: VERIFIED via `git diff --diff-filter=D HEAD~1 HEAD` (empty)
- All 8 acceptance criteria PASS (re-run via Bash above): VERIFIED

**Result: PASSED**
