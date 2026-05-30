---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: milestone_complete
last_updated: "2026-05-30T19:30:52.769Z"
progress:
  total_phases: 9
  completed_phases: 3
  total_plans: 17
  completed_plans: 31
  percent: 100
---

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Vault Ability Checks (Manual Rolls)
- Phase 6 added: Vault Combat State Foundation (D1)
- Phase 7 added: Vault Combat Playable (D2)
- Phase 8 added: Server-Side Combat Resolver (v1 Player Attacks) — captured as groundwork, not yet designed
- Phase 9 added: v2 Monster Turns (PC-AC Postgres bridge + monster attack data; v2 slice of the combat-resolver decomposition)

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

### Phase 08 — Plan 01 Execution (2026-05-29)

- All tasks completed: e80293f (feat — pure resolveCombat + parsing helpers), 1722ac4 (test — 16-case headless REQ-039 suite)
- Decisions: damage request uses the `per danni a <target>` lead-in (corrects spec `danni a` — extractPurpose needs per/for to keep the target; RESEARCH Pitfall 1, round-trip verified); hit rule MIRRORED on the rolled total (hit = natural !== 1 && (natural === 20 || total >= ac)) — does NOT call makeAttack (re-rolls d20, needs full Character, D-09); target match case-insensitive EXACT against monsters[].name then resolve server-side id (T-08-01); 0 or >1 → null; +0/no-breakdown roll → natural=total (nat-20-on-+0 auto-hits, Pitfall 2); HIT emits NO events (advance after damage roll), MISS emits turn_advance, DAMAGE emits monster_hp_change(-total)+turn_advance; never-throws → null on any fall-through (T-08-03)
- resolveCombat is pure (no Date.now/Math.random/randomUUID/process.env/fs); 16 headless tests pass; pnpm tsc --noEmit clean. REQ-039 resolver math delivered; route wiring + narration-only loop + D-07 suppression remain (Plans 08-02/08-03). No deviations.

### Phase 08 — Plan 02 Execution (2026-05-29)

- All tasks completed (TDD test→feat): c46f952 (RED loop tests), 77b5230 (feat — suppressCombatMutations narration-only mode), 7086539 (RED directive tests), 0c070f1 (feat — D-07 serverResolved suppression)
- Decisions: suppressCombatMutations drops ONLY ENCOUNTER_EVENT_TYPES apply_event calls at the loop dispatch seam (non-combat hp_change/inventory_add still dispatch — T-08-05); dropped call still emits start/end(ok:true)+benign tool_result so the turn completes, placed after toolCallCount+=1 for cap parity; D-07 serverResolved suppresses ALL THREE combat-mutation re-ask directives (resolve branch + combat-intent combat-start + general apply_event catalog) — the roll-result echoes "attaccare <target>" tripping detectCombatIntent and the general catalog lists monster_hp_change, so a literal "fall through" would re-ask the dropped events; both flags default-falsy → Phase 07 byte-identical when absent
- Deviation [Rule 1/2]: plan said "skip only the isRollResult branch, fall through to combat-intent/general directive" but that re-introduces the monster_hp_change re-ask the must_have forbids (T-08-04 double-apply) — gated all three re-ask directives on !serverResolved; directive now returns POV-only general block on a server-resolved turn (08-03 must inject resolver.narrationDirective for combat semantics)
- 6 new tests (3 loop + 3 directive); full vault suite 708 passing; pnpm tsc --noEmit clean. Pre-existing unrelated applicator.test.ts (inventory) failure logged to 08/deferred-items.md (out of scope — last touched by 7ad8533, before Phase 08). Both double-apply guards (T-08-04) unit-proven; Plan 08-03 wires them at the route.
