# Phase 10 — Research

**Researched:** 2026-05-31
**Synthesized from:** codebase assumptions analysis + A/B/C architecture advisor (two research agents) + live-smoke evidence this session + rulebook grounding.

## Summary

The server ALREADY owns the entire combat mechanical loop; the only missing piece is OPENING the encounter. Phase 10 adds a deterministic, rule-faithful server-side opener (option B) and closes the tracker-staleness gap on dropped SSE. No changes to the v1/v2 resolver math.

## Key findings (with file:line evidence)

### 1. The only thing that opens an encounter today is the model
- Route encounter-write sites: LLM tool-loop dispatch (`loop.ts` ~429), the inline-events text fallback (`loop.ts` Terminator-1, shipped this session), and the v1/v2 resolver emits (`route.ts` ~375-385 / ~450-458). The resolvers are gated on `encounter.active` already true (`route.ts:341`, ~409) — they CANNOT open.
- `event-to-engine-mutation.ts:466-478` confirms encounter events are deliberate Postgres no-ops (vault-native).
- Live `events.md` for the smoke campaign held only `monster_spawn`+`initiative_set` (no `combat_start`, no `hp_change`) — the model leaked them as text; `tool_calls=0` across the session. **Confidence: confirmed.**

### 2. The reducer auto-activates on monster_spawn / initiative_set
- `projector.ts` ~733-749 / ~768-777: a `monster_spawn` or `initiative_set` flips `active=true` even without `combat_start` (added precisely because qwen3 omits combat_start). So the opener emitting `monster_spawn`+`initiative_set` is sufficient to render the tracker; emit `combat_start` too for clarity. **Confidence: confirmed.**

### 3. Server-side combat-intent detection already exists and is tested
- `detectCombatIntent(playerMessage)` in `turn-directive.ts` ~78-84 (IT/EN attack-verb stem regex), currently only steers the prompt directive (~166). Reusable as the opener gate. **Ordering hazard:** a roll-result echoes "attaccare X" and re-trips it — MUST check `isRollResult()` first (documented ~91-94, 121-132). The clean `_playerMessage` is available pre-directive-mangling at `route.ts` ~316-318. **Confidence: confirmed.**

### 4. Rule-faithful trigger = on violence, not behind a roll
- `master_handbook.md:174` "Roll initiative once when violence starts"; `master_handbook_compact.md:58` "Always roll initiative at combat start"; `rules.md:155-159` (surprise → positions → roll initiative → take turns). You can't roll initiative against an unopened encounter → the opener fires on combat-intent. Surprise (rules.md:161-163, 766-770) is in the rules but keep minimal this phase. **Confidence: confirmed (rulebook).**

### 5. monster_spawn data contract the opener must satisfy
- `events-schema.ts` ~1015-1067: `monster_spawn` requires `{id, name, hpMax}`, optional `ac`/`initiativeBonus`/`cr` (cr is relaxed-numeric, allows 0.25/0.5). v1 reads `monster.ac ?? 12` and matches target by exact `name` (`combat-resolver.ts` ~124, ~179) — opener must set name+ac. v2 reads `monster.cr` for the attack table (`monster-turns.ts` ~395, default +4/1d6). `initiative_set.order` MUST contain the PC UUID(s) + monster id(s) or `resolveCombatHandoff` (`combat-handoff.ts` ~60-69) never returns control to the player. **Confidence: confirmed.**

### 6. Monster stats source (deterministic, option B)
- 180 SRD statblocks seeded at `data/vault/handbook/monsters/*.md` (committed); SRD lookup helper + `getBestiaryAttackStats` (`monster-bestiary.ts`) already parse them. CR→stats table in `monster-turns.ts` ~68 for fallback. Strategy: match the intended enemy name/slug to a bestiary entry → use its statblock; on no match → CR-scaled generic statblock keeping the narrative name. Enemy COUNT is heuristic (default 1; log any cap). **Confidence: likely (selection heuristic is the one under-determined point).**

### 7. Tracker refresh (REQ-046)
- Vault never emits the applicator `state` SSE (encounter events are Postgres no-ops; `applicator.ts:133` gate not reached). The ONLY vault `state` source is `emitStateRefresh` in `tools.ts` ~200-205/~377/~414, fired when `dispatchVaultTool` gets `sessionId`. Both resolver emit loops pass `sessionId` (`route.ts` ~380/~454) → a same-wired opener gets tracker refresh free.
- Client recovery: `use-session-stream.ts` maps `state`→`refetch()`; the safety-poll + `finalizedSeq` effect now also call `void refetch()` (`game-client.tsx` ~238/~297, shipped this session). **Residual gap:** a server-resolved combat turn with EMPTY narration persists no master message → safety poll's `masterCount > baseline` never trips → tracker can stay stale though state changed. Close with a refresh signal independent of a new master message (finalizedSeq bump or a `state` NOTIFY). **Confidence: confirmed mechanism; the empty-narration case is the residual to fix.**

### 8. REQ-047 already satisfied by v1 two-step
- HIT branch returns `events:[]` + `damageRequest`, no `monster_hp_change`, does not advance the turn (`combat-resolver.ts` ~191-199); damage applied only in the separate damage branch (~210-218); `enforceResolvedNarration` strips model-emitted damage numbers / roll-asks (~252-277, `route.ts` ~654). Opener must not introduce a path that emits encounter events + damage on the same to-hit turn. **Confidence: confirmed.**

### 9. Regression surface
- All combat hooks are inside `masterBackend==='vault'` + `vaultMutationsEnabled` gates; baked path is a separate early-return; directive builder is byte-identical when new flags falsy; REQ-022 locked prompt hash enforced by `prompt-builder.test.ts`. Pure-helper tests are the verification surface (no route unit test exists — use a headless integration test seeding events.md, per 09 deferred-items ~36-38). 4 known pre-existing unrelated failures excluded. **Confidence: confirmed.**

## Architecture decision (advisor → operator LOCKED)
- **Chosen: B now → A later.** Deterministic server opener (SRD/CR stats); reuses 100% of the shipped resolver stack; zero added per-turn latency on the M4; smallest highest-reliability code path. Custom-boss names preserved, stats SRD/CR-approximated. Option A (constrained-JSON `format` LLM call for bespoke stats — qwen3 honors GBNF-constrained output far better than free tool calls) is a deferred enhancement on the SAME opener hook; keep the monster-selection step swappable.
- **Trigger LOCKED: auto on combat-intent** (rule-faithful), ordered after `isRollResult`.

## Suggested implementation shape
- Pure `open-encounter.ts` helper: `(playerMessage, party, bestiaryLookup, crTable, rng?) → EncounterEvent[]` (combat_start, monster_spawn[], initiative_set), injectable RNG seam mirroring v2. Headless-testable.
- Route hook in the vault branch BEFORE the v1/v2 gates: `if (vaultMutations && !encounter.active && detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage)) { events = openEncounter(...); for (ev of events) await dispatchVaultTool('apply_event', ev, {campaignId, sessionId}); re-read encounter }`.
- Tracker: close the empty-narration refresh gap.
- Tests: headless opener unit tests (RNG-seeded) + a route-level integration test seeding an encounter-less events.md and asserting the emitted opener sequence + active tracker snapshot.

## Open question for the planner
- Monster-selection heuristic (name→bestiary slug match strategy; enemy-count default) is the one genuinely under-determined area — bound it explicitly and `log()` any silent cap.
