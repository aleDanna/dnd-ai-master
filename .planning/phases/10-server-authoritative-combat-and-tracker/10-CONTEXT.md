# Phase 10: Server-Authoritative Combat & Tracker Refresh - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning
**Source:** Operator discussion (AskUserQuestion decisions) + rulebook grounding + 2 research agents (assumptions analysis, A/B/C advisor)

<domain>
## Phase Boundary

**Delivers:** A server-authoritative combat ENCOUNTER OPENER for the vault path, so a fight reliably starts (combat_start + monster_spawn + initiative_set applied) without depending on qwen3 emitting `apply_event` tool calls mid-conversation; plus closing the combat-tracker staleness gap when the completion SSE is dropped. The v1 player-attack resolver and v2 monster-turn loop already exist and stay UNTOUCHED — this phase only adds the missing OPEN step in front of them and the UI refresh behind them.

**Root cause being fixed (verified live this session):** qwen3:30b-a3b-instruct emits `tool_calls=0` mid-conversation and writes encounter events as markdown TEXT. The server already owns the whole mechanical loop (resolveCombat v1, runMonsterTurnLoop v2, CR→stats table, 180-monster SRD bestiary, resolveCombatHandoff) but ALL of it is gated on `encounter.active === true` — and the only thing that flips `active` today is the model. So encounters silently never open → tracker shows "No active combat", HP never applies, raw JSON leaks into prose.

**NOT in this phase (deferred):**
- Option A (constrained-JSON LLM opener for bespoke custom-monster STATS via Ollama `format`). This phase is option B (deterministic SRD/CR-sourced stats). A is a later enhancement on the SAME opener hook.
- v3 combat polish / action economy (REQ-039 v3).
- Free-text-attack→roll-request reliability beyond what combat-intent detection needs (Phase 08 Finding 2 territory).
</domain>

<decisions>
## Implementation Decisions

### Architecture (LOCKED — operator chose "B now → A later")
- The encounter OPENER is DETERMINISTIC and server-side: detect combat intent → select monster stat block from the seeded SRD bestiary (`data/vault/handbook/monsters/<slug>.md`, 180 monsters) or the CR table when no bestiary match → emit `combat_start` + `monster_spawn` (with `cr`) + `initiative_set` via `dispatchVaultTool('apply_event', …)` passing `sessionId` (so `emitStateRefresh` fires).
- Reuse the existing tested stack with ZERO changes to its math: `resolveCombat` (v1), `runMonsterTurnLoop` (v2), the CR→stats table (`monster-turns.ts`), `getBestiaryAttackStats`, `resolveCombatHandoff`. The opener only PRODUCES the encounter state those consumers already expect.
- Custom-boss NAMES are preserved (the narrative can call it "Ombra Incarcerata"); custom STATS derive from SRD/CR approximation in this phase. Bespoke LLM-invented stats are the deferred option-A enhancement.

### Opener trigger (LOCKED — operator: "fedele alle regole scritte")
- Rule-grounded: initiative is rolled "when violence starts" — `master_handbook.md:174` ("Roll initiative once when violence starts"), `master_handbook_compact.md:58` ("Always roll initiative at combat start"), `rules.md:155-159` (surprise → positions → roll initiative → take turns). So the opener fires on detected ATTACK/COMBAT INTENT, NOT behind a prior roll (you cannot roll initiative against an encounter that has not opened).
- Reuse the existing, tested `detectCombatIntent(playerMessage)` (`turn-directive.ts`) as the gate. MUST be ordered AFTER `isRollResult()` (a roll-result echoes "attaccare X" and would re-trip the intent regex → loop). Gate: `vaultMutations && !encounter.active && detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage)`.
- Surprise (rules.md:161-163, 766-770) exists in the rules. Keep MINIMAL this phase: default to no-surprise initiative unless an obvious stealth/ambush signal is cheap to detect; do NOT over-build a surprise subsystem. Note for the planner, not a hard requirement.

### Monster selection (server-side, deterministic)
- Parse the intended target/enemy from the player's combat-intent message; match by name/slug against the SRD bestiary first; on no match, synthesize a CR-scaled generic statblock (reuse the CR table) keeping the narrative name. Enemy COUNT from the message is heuristic (default 1 when ambiguous) — `log()`/comment any heuristic cap so it is not silently wrong.
- `monster_spawn` requires `{id, name, hpMax}` (+ optional `ac`/`initiativeBonus`/`cr`) per `events-schema.ts`. The reducer auto-activates the encounter on `monster_spawn`/`initiative_set` even if `combat_start` is omitted (`projector.ts`), but emit all three for clarity.
- `initiative_set.order` MUST include the PC UUID(s) AND each monster id, or `resolveCombatHandoff` never returns control to the player (empty/PC-less turnOrder → `fallback`/`skip` forever).

### Tracker refresh (REQ-046)
- The vault path never emits the legacy applicator `state` SSE (encounter events are Postgres no-ops). Server-resolved encounter emits already pass `sessionId` → `emitStateRefresh` → `notifySession({type:'state'})` → client `refetch()`. The client safety-poll + `finalizedSeq` effect now also call `void refetch()` (shipped this session).
- Residual gap to CLOSE: a server-resolved combat turn that produces an EMPTY narration persists no new master message, so the safety poll's `masterCount > baseline` never trips and the tracker can stay stale though `turn_advance`/`hp_change` already changed state. Fix: ensure such turns still trigger a tracker refresh (bump `finalizedSeq` / fire a `state` NOTIFY / emit a recoverable signal the client maps to `refetch()`).

### Sequencing invariant (REQ-047)
- Damage is applied only AFTER the damage roll; never inferred from to-hit. Already enforced by the v1 two-step (HIT → `events:[]` + `damageRequest`, no `monster_hp_change`; damage roll → `monster_hp_change`+`turn_advance`). The opener work MUST NOT introduce a path that emits encounter events on the same turn as a to-hit roll in a way that pre-applies damage.

### Regression discipline
- All new logic lives INSIDE the `masterBackend === 'vault'` + `vaultMutationsEnabled` gates; baked path and non-combat vault turns stay byte-identical.
- Preserve REQ-022 prompt byte-stability (locked SHA `60e56767…`) — any prompt change stays inside the `vaultMutations`-gated combat block, never the read-only prompt.
- 4 known PRE-EXISTING unrelated test failures (applicator gp-stack, scene-image-coalesce, tts-coalesce, preferences-local-validation) are NOT charged to this phase.
- The existing inline-events fallback parser (shipped this session) stays as defense-in-depth; the deterministic opener is the primary path.

### Claude's Discretion
- Exact module layout (e.g. a new `open-encounter.ts` pure helper + a route hook in the vault branch), naming, and test file organization.
- How combat-intent target extraction maps to bestiary slugs (fuzzy match strategy).
- Whether the no-narration tracker-refresh fix is client-side (finalizedSeq bump) or server-side (state NOTIFY) — pick the smallest correct one.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Rulebook (mechanics must be faithful — REQ-045 trigger)
- `data/master_handbook.md` (§7.1 line 174 — "Roll initiative once when violence starts"; line 85 — approach-driven skill selection)
- `data/master_handbook_compact.md` (line 58 — "Always roll initiative at combat start")
- `data/rules.md` (lines 155-167 combat sequence + initiative; 161-163 + 766-770 surprise)

### Existing server combat stack (reuse untouched)
- `src/app/api/sessions/[id]/turn/route.ts` (vault branch: v1 gate ~341, v2 monster hook ~401-458, server-side emit loops passing sessionId, suppressCombatMutations wiring)
- `src/app/api/sessions/[id]/turn/combat-resolver.ts` (`resolveCombat` to-hit/damage two-step; `enforceResolvedNarration`)
- `src/app/api/sessions/[id]/turn/monster-turns.ts` (`runMonsterTurnLoop`, CR→stats table ~68, stop conditions)
- `src/app/api/sessions/[id]/turn/monster-bestiary.ts` (`getBestiaryAttackStats`, prose parser)
- `src/app/api/sessions/[id]/turn/combat-handoff.ts` (`resolveCombatHandoff` — turnOrder contract)
- `src/ai/master/vault/turn-directive.ts` (`detectCombatIntent`, `isRollResult` — opener trigger gate)
- `src/ai/master/vault/events-schema.ts` (encounter event payloads; `monster_spawn` requires id/name/hpMax, optional cr)
- `src/ai/master/vault/projector.ts` (encounter reducer — monster_spawn/initiative_set auto-activate)
- `src/ai/master/vault/tools.ts` (`dispatchVaultTool`, `emitStateRefresh`)

### Tracker / SSE (REQ-046)
- `src/app/(authed)/sessions/[id]/game-client.tsx` (`startSafetyPoll`, `finalizedSeq` effect, combat tracker render)
- `src/sessions/use-session-stream.ts` (SSE event handling; `state`→refetch; finalizedSeq)
- `src/sessions/notify.ts` (`notifySession` event types)

### Monster data
- `data/vault/handbook/monsters/*.md` (180 seeded SRD statblocks) + the SRD lookup helper

### Phase docs
- `.planning/phases/09-v2-monster-turns/deferred-items.md` (Finding 1 = tracker SSE-drop staleness; Finding 2 = free-text attack gap; root-cause notes)
- `.planning/phases/08-server-side-combat-resolver-v1-player-attacks/` (v1 resolver design)
</canonical_refs>

<specifics>
## Specific Ideas

- New pure helper (suggested): `open-encounter.ts` — given `{playerMessage, party, bestiaryLookup, crTable}` returns the ordered list of encounter events to emit (combat_start, monster_spawn[], initiative_set), injectable RNG for initiative (mirror the v2 `rng ?? defaultRng` seam). Pure → headless-testable like resolveCombat/resolveMonsterTurn.
- Route hook: in the vault branch, BEFORE the v1/v2 resolver gates, add `if (vaultMutationsEnabled && !encounter.active && detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage)) { open the encounter via the helper → dispatch events with sessionId → re-read encounter }`. Then the existing roll-gated path handles the first attack on the next turn.
- Headless integration test (per 09 deferred-items recommendation): seed an events.md with no encounter, drive a combat-intent player message, assert the route emits combat_start+monster_spawn+initiative_set with a valid turnOrder (PC UUID + monster id) and the tracker snapshot shows active combat.
- The advisor flagged Ollama `format` JSON-schema (GBNF constrained decoding) as the reliable channel for the FUTURE option-A opener — out of scope here but keep the helper's monster-selection step swappable so A drops in later.
</specifics>

<deferred>
## Deferred Ideas

- **Option A** — constrained-JSON (`format` schema) LLM call at encounter open to invent bespoke custom-monster stat blocks (qwen3 honors GBNF-constrained output far better than free tool calls). Drops into the same opener hook's monster-selection step. Separate future phase.
- **Surprise subsystem** — full Stealth-vs-Passive-Perception surprise determination (rules.md:161-163). Minimal/no-surprise default this phase.
- **Free-text → roll-request reliability** beyond combat-intent opening (Phase 08 Finding 2).
- **v3 combat** — action economy / polish (REQ-039 v3).
</deferred>

---

*Phase: 10-server-authoritative-combat-and-tracker*
*Context gathered: 2026-05-31 via operator discussion + rulebook grounding*
