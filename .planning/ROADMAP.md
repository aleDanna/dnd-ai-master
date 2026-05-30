# Roadmap

Milestone: **Vault-LLM-Wiki Migration**

The migration is decomposed into 3 phases. Each phase ships independently (the system remains functional via the existing Postgres+RAG path until cutover in Phase 03).

## Phase 01: Vault Read Path

**Goal:** The LLM master can answer rules/lore questions using ONLY the markdown vault for static knowledge, with no RAG retrieval and no `MASTER_TOOL_CONTRACT` injection. Behind a feature flag — the existing baked-variant + RAG path is untouched.

**Scope:**
- Vault layout scaffolded under `data/vault/` (handbook + tools dirs)
- Static handbook + lore migrated from existing `data/master_handbook.md` + `data/master_world_lore.md` into per-entity markdown files
- New tool surface: `read_vault_multi`, `list_vault`, `end_turn` exposed via Ollama tool calls
- `SystemPromptBuilder` pure function (REQ-022)
- ESLint rule + CI test for prompt stability
- Lenient discovery protocol (`/tools/index.md`)
- Feature flag `MASTER_BACKEND=vault|baked` at request level
- M4 benchmark gate: re-run spike 003 + 011 setup against the integrated Next.js path, confirm warm wall-clock < 10s

**Success criteria:**
- ✓ A turn that asks "Quanto danno fa Fireball al livello 5?" works end-to-end via vault path
- ✓ `prompt_eval_count` per turn drops from ~8,800 (baked) to ~3,000-5,000 (vault) — measured in `ai_usage`
- ✓ Warm wall-clock turn < 10s on M4 (measured via existing telemetry)
- ✓ Feature flag toggle works in both directions (baked ↔ vault) per request
- ✓ All existing E2E tests pass with `MASTER_BACKEND=baked` (default)
- ✓ New E2E test covers `MASTER_BACKEND=vault` happy path on 5 rules-lookup turns

**Depends on:** none (foundation)

**Requirements:** REQ-001, REQ-002, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-021, REQ-022, REQ-030, REQ-033

---

## Phase 02: Vault Write Path (Event Sourcing)

**Goal:** Game-state mutations (HP changes, condition adds, spell-slot use, narrative events) write to `events.md` per-campaign via `EventsWriter`, with materialized views (`characters/<name>.md`, session logs) regenerated on read. Campaign data lives under a configurable `VAULT_CAMPAIGNS_ROOT` outside the codebase repo (REQ-007). Still behind feature flag — Postgres remains the source of truth for any campaign not opted in.

**Scope:**
- `VAULT_CAMPAIGNS_ROOT` env-driven path resolver (default `~/.dnd-ai-master/vault/campaigns/`) — separate from the static `VAULT_ROOT`
- `EventsWriter` class with in-process Map<path, Promise> mutex (spike 010 pattern), keyed on campaign id
- `apply_event(type, payload)` Ollama tool exposed in the LLM vault tool surface
- Event projector module: converts events.md → in-memory state, then serializes to `characters/<name>.md` frontmatter
- Event type schema: `hp_change`, `condition_add`, `condition_remove`, `spell_slot_use`, `spell_slot_restore`, `inventory_add`, `inventory_remove`, plus extension hooks
- Materialized-view regeneration triggered by every `apply_event` call (cheap; ~5ms per regeneration for a small campaign)
- Concurrent-write smoke test in CI (100 parallel applyEvent calls, assert 0 lost — spike 010 pattern)
- Per-campaign opt-in flag: `vault_mutations: true` in campaign settings
- Backup strategy chosen + documented (REQ-007): tarball+cron, or separate git repo, or S3 sync (decision deferred to Phase 02 planning)
- Vault campaign tools (`read_vault_campaign_multi`, `list_vault_campaign`?) — or extend existing `read_vault_multi` to accept paths in both roots transparently (Phase 02 planner decides)

**Success criteria:**
- ✓ A turn that resolves combat damage produces an `apply_event` tool call that lands in `events.md` AND updates `characters/<name>.md` frontmatter atomically
- ✓ Concurrent stress test (100 parallel applyEvents on same campaign) passes with 0 lost / 0 corrupted / 0 duplicated
- ✓ Restart of Next.js server preserves state via events.md replay on session resume
- ✓ Both backends (Postgres + Vault) can run side-by-side per campaign (some campaigns opted in, others not)
- ✓ Property test: round-trip serialization (event → state → view → assert state derivable back)

**Depends on:** Phase 01

**Requirements:** REQ-004, REQ-005, REQ-006, REQ-007, REQ-010

## Phase 03: Migration & Cutover

**Goal:** Existing Postgres campaigns (campaigns + characters + session_state) exported to vault format. Dual-write coexistence period validates parity. Cutover flips source-of-truth to vault. RAG layer (pgvector + embedder) retired. Baked variants other than `dnd-master-plus` regression-baseline removed.

**Scope:**
- Export script: `scripts/migrate-campaigns-to-vault.ts` — reads Postgres campaigns, generates `events.md` + materialized views per campaign
- Dual-write coexistence layer: both Postgres and Vault receive mutations; reconciliation check on every session-resume
- Divergence alarm: if Postgres and Vault states disagree, log alarm and prefer Postgres (until cutover)
- Cutover script: flip the source-of-truth flag, validate, archive Postgres tables (don't drop until +30 days)
- Decommission RAG: remove `src/ai/master/rag/*`, `scripts/build-rag-index.ts`, embedder model, `pgvector` extension
- Decommission baked variants: remove `dnd-master-{lite,max}` from build script; retain `dnd-master-plus` as regression baseline; free SSD
- Per-turn summarization implementation (REQ-023): cumulative prompt > 15K tok → condense prior 5 turns to ~200-word summary block
- Final M4 sweep: spike 004 + 011 + 014 setup re-run against the cutover state; produce a "post-migration" results bundle

**Success criteria:**
- ✓ All existing campaigns (>=1) migrated to vault format with bit-exact state reconstruction
- ✓ Dual-write divergence rate < 0.1% over 2 weeks of coexistence
- ✓ Cutover script is reversible (can flip back to Postgres if 24h post-cutover something breaks)
- ✓ M4 final sweep: G1 warm < 5s, G2 lenient 100%, narrative quality not degraded
- ✓ SSD usage drops by >30GB (no embedder model + decommissioned baked variants)
- ✓ RAG code paths fully removed; build succeeds without pgvector
- ✓ Per-turn summarization activates at 15K tok and keeps avg turn flat over a 20-turn session

**Depends on:** Phase 02

**Requirements:** REQ-006, REQ-020, REQ-023, REQ-031, REQ-032, REQ-033, REQ-034

---

## Phase 04: Vault Anti-Railroading Prompt

**Goal:** The vault-path Dungeon Master stops railroading the player character. It narrates the world (environment, NPCs, and the consequences of actions the player declared) in second person, but never invents the PC's actions, dialogue, decisions, or outcomes. Prompt-only change to the vault system-prompt builder; the existing automatic turn-advance (`computeTurnAdvance` + `detectAddressee`) handles multiplayer hand-off, so no new tool is needed. Fixes the model-independent railroading surfaced by the 2026-05-28 gemma4-vs-qwen3 A/B experiment (both models railroaded on the minimal vault prompt). This is piece A of 4 in the "game-mechanics on the vault path" effort; B (roll discipline + action→event), C (dice system), D (combat state machine) are future phases.

**Scope:**
- Static `## Your role` block inserted into `buildVaultSystemPrompt` (`src/ai/master/vault/prompt-builder.ts`) between the DM identity line and `## Knowledge layout` — unconditional (present on every vault turn, both `vaultMutations` true and false)
- Block content: second-person narration; the player decides PC actions/words/intentions; soft strictness (brief connective body language allowed, never decisions/dialogue/outcomes the player didn't declare); multiplayer "never speak or decide for any PG, close the beat addressing the next character BY NAME"; end with an open cue, never a numbered menu
- One worked example in Italian anchoring weak models: player "provo ad attaccarlo" → GOOD (narrate consequence) / BAD (invent the PC's action+dialogue+outcome)
- REQ-022 byte-stability preserved (static deterministic block; 1000 builds → 1 hash; no Date.now/Math.random/process.env)
- Design ref: `docs/superpowers/specs/2026-05-28-vault-anti-railroading-design.md`

**Success criteria:**
- ✓ `buildVaultSystemPrompt` output contains the `## Your role` block with second-person guidance + "never invent actions" + the `GOOD:`/`BAD:` worked-example markers
- ✓ Block present with BOTH `vaultMutations: true` and `vaultMutations: false` (unconditional)
- ✓ REQ-022 holds: 1000 builds with identical input → exactly 1 unique SHA256
- ✓ Vault system prompt stays under 2KB
- ✓ Operator smoke: "provo ad attaccarlo" on gemma4/qwen3 narrates the consequence and hands agency back (e.g. "…che fai?") instead of inventing the PC's full action + dialogue + outcome

**Depends on:** Phase 02

**Requirements:** REQ-035

**Plans:** 1/1 plans complete

Plans:
- [x] 04-01-insert-your-role-block.md — TDD insert of the static `## Your role` anti-railroading block; regenerate locked-snapshot/hash expected values; REQ-022 stability + typecheck green

## Phase 05: Vault Ability Checks (Manual Rolls)

**Goal:** The vault-path Dungeon Master calls for ability checks, saving throws, and attack/damage rolls via the existing manual-roll surface — writing parser-compatible roll requests in prose so the client's 🎲 buttons render and resolve. Prompt + setting only (a `manualRolls`-gated `## Rolls` block in `buildVaultSystemPrompt`); no parser/engine/tool changes; REQ-022 byte-stability preserved.

**Scope:**
- `manualRolls`-gated `## Rolls` block inserted into `buildVaultSystemPrompt` (`src/ai/master/vault/prompt-builder.ts`) — language- and DC-aware, content adapted from the proven baked `buildManualRollsRule` but self-contained (no baked-tool mention)
- New `VaultPromptInput` fields `manualRolls?` + `showDifficultyNumbers?`, wired from `userPrefs` at the turn route vault branch (`route.ts:296-309`; baked already passes `showDifficultyNumbers` at :625)
- Block content: when-to-roll + DC anchors (Easy 10 / Medium 15 / Hard 20); authoritative-number contract; bare-d20 + sheet-modifier rule for checks/saves, embedded-bonus for attacks/damage; parser-compatible IT/EN phrasings; hidden-difficulty variant
- Reuse the existing client roll-button flow (parser + `RollRequestGroup`) — ZERO changes to `roll-parser.ts`, the client components, or the engine
- Enable `manualRolls=true` on the One Piece campaign
- Design ref: `docs/superpowers/specs/2026-05-28-vault-ability-checks-design.md`

**Success criteria:**
- ✓ `buildVaultSystemPrompt` emits the `## Rolls` block when `manualRolls:true` (contains `## Rolls`, "Easy 10, Medium 15, Hard 20", "AUTHORITATIVE", the bare-d20 + "modifier" rule, the parser phrasings) and OMITS it when `manualRolls` is false/undefined
- ✓ `language:'it'` → Italian phrasings ("Tira una prova di Percezione (CD 15)") + the anti-mixing clause; default → English ("Roll a DC 15 Perception check.")
- ✓ `showDifficultyNumbers:false` → examples omit the numeric DC and the hidden-difficulty line is present
- ✓ REQ-022 holds: 1000 builds with identical input → exactly 1 SHA256; the read-only default hash (`60e567…c54b14e`) is UNCHANGED (block is gated/additive)
- ✓ The turn route passes `manualRolls` + `showDifficultyNumbers` from `userPrefs` to `buildVaultSystemPrompt`
- ✓ Operator smoke on One Piece (gemma4, `manualRolls=true`): an uncertain action → master writes a roll request → 🎲 button renders → tapping returns "I rolled **N**" → master resolves with N + the sheet modifier

**Depends on:** Phase 04

**Requirements:** REQ-036

**Plans:** 1/1 plans complete

Plans:
- [x] 05-01-PLAN.md — Extend VaultPromptInput, emit gated ## Rolls block, wire manualRolls + showDifficultyNumbers at turn route vault branch; operator smoke on One Piece campaign

## Phase 06: Vault Combat State Foundation (D1)

**Goal:** The vault path tracks combat state via event sourcing: encounter-scoped events in `events.md` → a projector encounter reducer → a `combat.md` materialized view → snapshot wiring that feeds the existing backend-agnostic `CombatTracker`. Vault-native (replayable, Postgres-free), fully headless-testable. Sub-phase **D1** of piece D (combat); D2 adds the LLM tools/prompt/bestiary/turn-interleaving, D3 the action economy.

**Scope:**
- 6 encounter-scoped event types in `events-schema.ts` (`combat_start`, `monster_spawn` [fat/self-contained: deterministic id + stat block in payload], `initiative_set`, `turn_advance`, `monster_hp_change`, `combat_end`); relax the per-PC "UUID required" guard for them
- Projector encounter reducer (alongside the per-character `Map`) + `combat.md` materialized-view serialization; EventsWriter regenerates `combat.md` on encounter events
- Snapshot wiring: `snapshot-reader.ts` surfaces encounter-derived `combat`/`inCombat`; `client-snapshot.ts` sources `actors` from the vault encounter view for vault campaigns
- Reuse `CombatTracker` unchanged; PC HP reused from existing character views (only monsters live in encounter state)
- Headless tests (no LLM): reducer, `combat.md` round-trip, replay determinism, snapshot shape, regression
- Design ref: `docs/superpowers/specs/2026-05-28-vault-combat-d1-state-foundation-design.md`

**Success criteria:**
- ✓ A headless event sequence (`combat_start` → `monster_spawn`×2 → `initiative_set` → `turn_advance`×N → `monster_hp_change` → `combat_end`) produces correct EncounterState (round wrap, `isAlive` flips at hp≤0, `active` flips)
- ✓ `combat.md` round-trips (event→state→view→state derivable back) and replay is deterministic (same `events.md` → identical EncounterState)
- ✓ `buildClientSnapshot` for a `sourceOfTruth:'vault'` campaign mid-encounter surfaces `state.combat {round,currentIdx,turnOrder}` + `inCombat:true` + `actors` in the exact `CombatTracker`-consumed shape; after `combat_end` → `combat:null, inCombat:false, actors:[]`
- ✓ No writes to Postgres `combat_actors` / `session_state.combat`; combat state lives only in `events.md` + the `combat.md` view
- ✓ Existing per-character projector + vault tests stay green (encounter reducer is additive)
- ✓ REQ-004 / REQ-007 honored (events.md source of truth; campaign data outside the repo)

**Depends on:** Phase 02

**Requirements:** REQ-037

**Plans:** 2/2 plans complete

Plans:
- [x] 06-01-PLAN.md — Event schema (6 encounter types), EncounterState reducer, combat.md view, regeneration hook, headless reducer/round-trip/determinism tests
- [x] 06-02-PLAN.md — Snapshot wiring (snapshot-reader + client-snapshot), vault actors from encounter, snapshot-shape tests

## Phase 07: Vault Combat Playable (D2)

**Goal:** Make vault combat LLM-playable on top of D1: the master starts/runs/ends combat by emitting the D1 encounter events via `apply_event`, monsters come from a seeded SRD bestiary (+ master-invented custom bosses), turns interleave PCs and monsters (master acts for monsters), and the combat renders live in the `CombatTracker`. Sub-phase **D2** of piece D (combat); D3 adds action economy + in-combat conditions.

**Scope:**
- Tool exposure (`tools.ts`): relax the UUID guard for `ENCOUNTER_EVENT_TYPES`; advertise the 6 encounter types + payloads in the `apply_event` schema description; add `data/vault/tools/apply_event.md` + index entry
- `vaultMutations`-gated "Combat lifecycle" prompt block in `buildVaultSystemPrompt` (REQ-022-stable): lifecycle, monster-stats rule (SRD bestiary vs custom-via-payload), turn rule
- Bestiary: `scripts/seed-bestiary.ts` generates `data/vault/handbook/monsters/<slug>.md` for all 180 `data/monsters.csv` monsters (committed); custom bosses via the fat `monster_spawn` payload
- Turn interleaving (`route.ts` vault branch): drive handoff from `EncounterState.turnOrder` (master runs monster turns, hands to the PC on a PC turn; `detectAddressee` fallback); non-combat handoff unchanged
- One Piece `sourceOfTruth:'vault'` flip + operator smoke
- Design ref: `docs/superpowers/specs/2026-05-28-vault-combat-d2-playable-design.md`

**Success criteria:**
- ✓ `apply_event` dispatcher accepts the 6 encounter events (UUID guard skipped) and the schema description lists all 6 types
- ✓ Combat-lifecycle prompt block present when `vaultMutations:true`, absent otherwise; REQ-022 1000-build stability holds
- ✓ `scripts/seed-bestiary.ts` produces 180 `handbook/monsters/<slug>.md` files; `goblin.md` frontmatter maps to a valid `monster_spawn` payload
- ✓ Turn route: in an active encounter, handoff is driven by `turnOrder` (PC turn → `currentPlayerCharacterId` set; monster turn → no PC handoff); `detectAddressee` fallback; **non-combat multiplayer handoff unchanged (regression test)**
- ✓ One Piece `sourceOfTruth:'vault'`; operator smoke: a fight spawns a monster, sets initiative, renders in the tracker, turns alternate, HP changes land, combat ends
- ✓ No new combat tool; no change to `CombatTracker` rendering

**Depends on:** Phase 06

**Requirements:** REQ-038

**Plans:** 4/5 plans executed

Plans:
- [x] 07-01-PLAN.md — UUID guard relaxed for ENCOUNTER_EVENT_TYPES; apply_event description extended with 6 encounter types + payloads; apply_event.md + index.md; 180-monster SRD bestiary seeded and committed
- [x] 07-02-PLAN.md — vaultMutations-gated Combat-lifecycle prompt block (lifecycle sequence + monster-stats rule + turn rule); REQ-022 byte-stable; existing locked-snapshot hash unchanged
- [x] 07-03-PLAN.md — turnOrder-driven turn handoff in vault branch (PC actor → cpcId set; monster actor → no handoff; detectAddressee fallback); non-combat regression test suite
- [x] 07-04-PLAN.md — _set-source-of-truth.ts script; One Piece sourceOfTruth:'vault'; (smoke deferred to 07-05 — combat blocked by history-anchoring)
- [x] 07-05-PLAN.md — per-turn anti-anchoring directive (2nd-person POV + use apply_event for combat + ask for rolls) appended after history; fixes history-anchoring tool-suppression (validated: clean→combat_start, narration-history→0 tools, +directive→combat_start); re-smoke

## Phase 08: Server-Side Combat Resolver (v1 Player Attacks)

**Status:** PLANNED (2026-05-29) — 3 plans in 2 waves. Spec: `docs/superpowers/specs/2026-05-29-combat-resolver-v1-design.md`. Next: `/gsd-execute-phase 08`.

**Goal:** Move combat MECHANICAL RESOLUTION server-side (the fix for the local-model ceiling found in the D2 smoke: models start combat + ask for rolls but free-narrate outcomes, ignore the rolled number, never apply HP/turns). When a roll-result arrives during an active vault encounter, the turn route resolves deterministically (roll → AC → hit/miss → damage → `monster_hp_change` → `turn_advance`) reusing the engine math, and the LLM only NARRATES the server-determined outcome. **v1 scope = player attacks** (clean: the rolled total already carries the PC's bonus, so only the monster AC is needed — no PC-stats bridge).

**Scope (v1 — to be refined in the design session):**
- Server-side resolver hooked in the turn route BEFORE `runVaultToolLoop`, gated on `vaultMutations && encounter.active && isRollResult(playerMessage)`
- Parse the roll-result label → kind (to-hit vs damage) + target name → monster id (match `EncounterState.monsters`)
- To-hit: rolled total vs monster AC (+ default fallback) → hit/miss; on hit → damage roll → `monster_hp_change`; then `turn_advance`
- Reuse `src/engine/{combat,dice,modifiers}` math (pure, crypto-RNG); LLM narrates the outcome via a directive
- Groundwork ref: `docs/superpowers/specs/2026-05-29-server-side-combat-resolver-groundwork.md` (reusable math file:lines, hook point, data wrinkle, open decisions)

**Decomposition:** v1 player attacks (this phase) · v2 monster turns (PC-AC Postgres bridge + monster attack data) · v3 polish (conditions, multi-attack, crit/resistances, auto `combat_end`).

**Success criteria (provisional — finalize in design):**
- ✓ A player attack roll during combat is resolved server-side (hit/miss vs monster AC) — the model no longer decides the outcome
- ✓ On a hit, damage is applied via `monster_hp_change` and the monster's HP drops in the `CombatTracker`
- ✓ The turn advances (`turn_advance`) after the player's action resolves
- ✓ The LLM narrates the server-determined outcome (no contradiction between narration and mechanics)

**Depends on:** Phase 07

**Requirements:** REQ-039

**Plans:** 3/3 plans complete

Plans:
**Wave 1**
- [x] 08-01-PLAN.md — Pure `resolveCombat` (to-hit/damage/miss, nat-20/nat-1, default AC 12 / die 1d6, `per danni a` round-trip, null on edges) + headless REQ-039 unit suite [Wave 1]
- [x] 08-02-PLAN.md — `suppressCombatMutations` narration-only drop in `loop.ts` + D-07 `serverResolved` directive suppression in `turn-directive.ts` (no-double-apply guards) + test extensions [Wave 1]

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 08-03-PLAN.md — Vault-branch wiring in `route.ts` (early read, gate, server-side emit, narration-only loop, safety-net append, 07-03 handoff preserved) + regression + operator smoke [Wave 2]

## Phase 09: v2 Monster Turns

**Goal:** Move MONSTER-turn mechanical resolution server-side (extends the Phase 08 v1 player-attack resolver). When the active actor in an active vault encounter is a monster, the server rolls its attack via an injectable RNG seam, picks a random live PC, pulls the PC's AC from Postgres, applies damage via `hp_change`, advances the turn, and loops consecutive monster turns in one request — stopping cleanly on a PC turn / party-KO / safety cap. Monster attack stats come from a 3-level fallback (bestiary prose parse -> LLM `cr`-hint table -> named-constant default). The LLM only NARRATES the server-determined outcomes in one combined pass.

**Requirements:** No REQ-IDs mapped; tracked against the 16 LOCKED decisions D-01..D-16 in 09-CONTEXT.md (this phase's de-facto requirement set).
**Depends on:** Phase 08
**Plans:** 6 plans in 3 waves

Plans:

**Wave 1** *(parallel, autonomous)*
- [ ] 09-01-PLAN.md — Additive `cr?` on the monster_spawn event + validator + projector propagation into EncounterState.monsters[] (D-08; closes state-gap 2)
- [ ] 09-02-PLAN.md — CR->stats table + named-constant defaults + pure `resolveMonsterTurn` (v1 hit rule, injected RNG, random live-PC target) (D-05, D-06, D-09, D-10, D-11)
- [ ] 09-03-PLAN.md — Isolated SRD bestiary attack-prose parser via the path-safe vault reader (D-04, D-07; non-blocking to the smoke)

**Wave 2** *(parallel, autonomous)*
- [ ] 09-04-PLAN.md — `runMonsterTurnLoop` driver (3-level stat fallback, stop conditions, safety cap, in-memory event application) + single combined Italian narration directive (D-03, D-03c, D-14, D-15)
- [ ] 09-05-PLAN.md — Advertise `cr` in the apply_event tool/prompt + `monsterResolved` directive suppression (D-08, D-16; REQ-022 byte-stability preserved)

**Wave 3** *(has checkpoint)*
- [ ] 09-06-PLAN.md — Route vault-branch wiring: monster-loop hook, PC-AC/PC-HP maps, server-side emission, suppression + combined narration, 07-03 handoff preserved + operator smoke (D-01, D-02, D-12, D-13, D-16)

---
