---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in_progress
last_updated: "2026-05-29T15:55:26.084Z"
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 11
  completed_plans: 25
  percent: 100
---

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Vault Ability Checks (Manual Rolls)
- Phase 6 added: Vault Combat State Foundation (D1)
- Phase 7 added: Vault Combat Playable (D2)
- Phase 8 added: Server-Side Combat Resolver (v1 Player Attacks) — captured as groundwork, not yet designed

### Phase 05 — Plan 01 Execution (2026-05-28)

- Tasks 1 and 2 committed (a9e1190, ff8933f)
- Paused at Task 3 (checkpoint:human-verify) — operator smoke required
- Decision: manualRolls-gated `## Rolls` block added to buildVaultSystemPrompt; wired from userPrefs in vault-branch route call

### Phase 06 — Plan 01 Execution (2026-05-28)

- All tasks completed: ac7e5fe, 36e911b, 98e7e6d
- Decisions: replayEvents returns { chars, encounter }; encounter reducer is additive (single pass); ENCOUNTER_EVENT_TYPES Set exported for O(1) routing; applyEncounterEvent default arm is not never-typed (reducer handles subset of VaultEvent); event-to-engine-mutation.ts encounter arms are no-ops (REQ-037 — no Postgres combat writes in D1)
- 6 encounter event types added to events-schema.ts (28→34); combat.md materialized view added; 28 headless tests all pass

### Phase 06 — Plan 02 Execution (2026-05-28)

- All tasks completed: 58af5ca, 2b4b7ac
- Decisions: materializeFromVault returns VaultMaterializeResult { state, encounter } (single replay pass serves both); buildVaultActors exported from client-snapshot.ts (session-layer concern); Postgres combat_actors query fully skipped on vault path (not just ignored — vault campaigns never write there); snapshot-reader.test.ts updated to access r!.state.field (Rule 1 fix)
- inCombat/combat now encounter-derived; vault actors from encounter.monsters; 26 new headless tests; 657 total vault tests all pass; pnpm tsc --noEmit clean

### Phase 07 — Plan 01 Execution (2026-05-28)

- All tasks completed: 182efa5 (RED tests), 4214782 (feat Task 1), df02ba8 (feat Task 2)
- Decisions: UUID guard relaxation scoped to ENCOUNTER_EVENT_TYPES.has(type) — character events retain UUID validation; seed-bestiary.ts uses Node.js built-ins only; 180 SRD monster .md files committed as static vault knowledge
- apply_event tool description extended with 6 encounter types + payload shapes; apply_event.md created; index.md updated to 4 tools; 180 monster files seeded from data/monsters.csv; 661 vault tests pass; pnpm tsc --noEmit clean

### Phase 07 — Plan 02 Execution (2026-05-28)

- All tasks completed: 465eb77 (RED tests), 1020ab3 (feat implementation)
- Decisions: combatLifecycleBlock() takes no arguments (static/deterministic, preserves REQ-022); prose reference to roster section uses "character roster above" not the literal "## Available characters" header (Rule 1 fix — avoids roster-absent test false-positive); block inserted between applyEventMention and character roster blocks
- Combat-lifecycle block gated on vaultMutations === true; covers lifecycle/monster-stats/turn-rule semantic areas; locked read-only hash 60e56767...c54b14e unchanged; 56 tests pass; pnpm tsc --noEmit clean

### Phase 07 — Plan 03 Execution (2026-05-28)

- All tasks completed: 372baf7 (RED tests), 5266e1a (feat implementation GREEN)
- Decisions: resolveCombatHandoff() pure helper returns 3-way union ('advance'/'skip'/'fallback'); parseEventsFile+replayEvents used directly (not materializeFromVault — that requires characterId not available in transaction context); combatHandoffDone flag gates fallback; entire combat block in try/catch
- Combat-active turns: turnOrder[currentIdx] PC UUID → cpcId set + turn-change; monster id → no handoff; inactive/empty/error → detectAddressee/computeTurnAdvance unchanged; 8 new tests pass; pnpm tsc --noEmit clean; no new test failures (1 pre-existing applicator/gp-stack)

### Phase 07 — Plan 05 Execution (2026-05-29)

- Task 1 committed: 402de30 (feat — buildTurnDirective + appendDirectiveToHistory + route wiring)
- Paused at Task 2 (checkpoint:human-verify) — operator smoke required
- Decisions: directive is a separate module (REQ-022 untouched); null return for read-only campaigns; Italian directive language (primary play language); route uses narrow cast for MessageParam string-content invariant; language param reserved for future expansion
- 24 unit tests; pnpm tsc --noEmit clean; no new test failures
