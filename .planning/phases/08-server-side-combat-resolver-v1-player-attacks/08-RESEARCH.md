# Phase 08: Server-Side Combat Resolver (v1 Player Attacks) - Research

**Researched:** 2026-05-29
**Domain:** Deterministic server-side combat resolution in a Next.js 16 API route, event-sourced vault state, LLM narration-only mode
**Confidence:** HIGH (all integration points verified against live code; one CONTEXT.md format bug found and corrected)

## Summary

This phase moves PLAYER-attack mechanical resolution out of the LLM into a deterministic pure function (`resolveCombat`) hooked into the vault branch of the turn route. The design is fully locked in the approved spec; this research VERIFIES the live codebase mechanics the planner needs and reports drift from the CONTEXT.md line references (all of which have shifted because `route.ts` is now 936 lines).

Every integration seam exists and is well-shaped for this work: the `monster_hp_change` + `turn_advance` events the resolver emits already have validators and reducers (`events-schema.ts`, `projector.ts`); the server-side emission path is the single-write branch of `dispatchVaultTool` (`tools.ts:371-382`); the hit rule the resolver mirrors is `attack.ts:365` (`hit = naturalCrit || total >= effectiveAc`, nat-1 auto-miss at `:345`); and `isRollResult` already lives at `turn-directive.ts:69`. The test harness is vitest with a `scriptedProvider` mock pattern for the loop and pure-function tests for extracted helpers.

**One blocking finding (HIGH confidence, verified by executing the parser):** the CONTEXT.md/spec damage-request format `"Tira 1d6+3 danni a Veyra"` **silently breaks the stateless two-step**. The client roll-parser's `extractPurpose` (`roll-parser.ts:744`) only captures a purpose into the button label when there is a `per`/`for` lead-in. Without it, the label is the bare formula `1d6+3`, the resulting roll-result echoes `for 1d6+3 (6+3)` with **no target name**, and the resolver's damage path can no longer match a monster → returns `null` → no HP applied. **Fix: emit `"Tira 1d6+3 per danni a Veyra"`** (with `per`). This matches the existing attack-request format (`prompt-builder.ts:132`: `"Tira 1d20+<bonus> per attaccare <target>"`), so the round-trip is symmetric.

**Primary recommendation:** Build `resolveCombat` as a pure function returning `VaultEvent[]` (not envelopes); emit those events server-side by calling the existing `dispatchVaultTool('apply_event', {type, payload}, {campaignId})` per event (it does validate + write + regenerate combat.md + the UUID guard is already relaxed for encounter events); run `runVaultToolLoop` in narration-only mode via a new `dropMutations`/`narrationOnly` flag that drops combat-event `apply_event` tool calls that turn; emit the damage request with a `per` lead-in.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Parse roll-result string → {total, natural, bonus, dice, target, kind} | API / Backend (pure `resolveCombat`) | — | No I/O; the rolled string arrives as the player's turn message. Headless-testable. |
| To-hit / damage decision (hit rule, HP delta) | API / Backend (pure `resolveCombat`) | — | Rules enforced by code, not the model (the whole point of v1). Mirrors `attack.ts`. |
| Persist `monster_hp_change` / `turn_advance` | API / Backend (route → `dispatchVaultTool` → `EventsWriter` + projector) | Database/Storage (`events.md` JSONL) | Existing single-write path; mutex-serialized; regenerates `combat.md`. |
| Narration of the resolved outcome | LLM (`runVaultToolLoop`, narration-only) | — | The LLM colors; the code decides. Combat-event tool calls dropped that turn. |
| Render HP bar / turn order (CombatTracker) | Browser / Client (reads snapshot derived from `combat.md`) | Frontend Server (snapshot wiring) | Unchanged — the projector already feeds `combat.md`→snapshot→`buildVaultActors`. |
| Render 🎲 damage button from prose | Browser / Client (`parseRollRequests` in `narrative-pane.tsx`) | — | Damage-request prose is parsed client-side into a button; format must round-trip. |

## Standard Stack

This phase adds **NO new dependencies**. It is pure TypeScript reusing existing internal modules. [VERIFIED: codebase grep — resolver inputs are `EncounterState` (projector.ts), `VaultEvent` (events-schema.ts), `isRollResult` (turn-directive.ts); all internal.]

### Core (existing modules the resolver consumes / mirrors)
| Module | Path | Purpose | Why Standard |
|--------|------|---------|--------------|
| `events-schema.ts` | `src/ai/master/vault/events-schema.ts` | `VaultEvent` union + `validateEvent`; the resolver constructs `monster_hp_change` / `turn_advance` payloads | The exact shape `dispatchVaultTool` validates and persists [VERIFIED] |
| `projector.ts` | `src/ai/master/vault/projector.ts` | `EncounterState` type (`:661-676`); `monster_hp_change`/`turn_advance` reducer math (`:780-789`, `:767-778`) | The reducer's inline HP math is what v1 reuses; the encounter shape is the resolver input [VERIFIED] |
| `turn-directive.ts` | `src/ai/master/vault/turn-directive.ts` | `isRollResult` (`:69`); the player-side resolve directive to suppress (D-07) | Reuse `isRollResult` for the gate; D-07 suppresses the conflicting directive |
| `tools.ts` | `src/ai/master/vault/tools.ts` | `dispatchVaultTool` — server-side `apply_event` emission path (`:251-383`) | The single-write branch (`:371-382`) is the resolver's emit path; encounter UUID guard already relaxed (`:285`) [VERIFIED] |
| `loop.ts` | `src/ai/master/vault/loop.ts` | `runVaultToolLoop`; needs a narration-only mode (D-06) | The tool-dispatch seam (`:313-343`) is where combat-event calls get dropped [VERIFIED] |
| `roll-parser.ts` | `src/lib/roll-parser.ts` | `extractPurpose` (`:744`), `inferKind` (`:804`), `RollRequest` | Determines whether the emitted damage-request round-trips with the target name [VERIFIED] |

### Reference (do NOT modify — contract/pattern source)
| Module | Path | What it provides |
|--------|------|------------------|
| `attack.ts` | `src/engine/combat/attack.ts` | `makeAttack` hit rule at `:365` (`hit = naturalCrit \|\| total >= effectiveAc`); nat-1 auto-miss `:345`; nat-20 crit `:361`. v1 MIRRORS this on the rolled total — does NOT call it. [VERIFIED] |
| `damage.ts` | `src/engine/combat/damage.ts` | `applyDamage` `:82` — full PC death-save/concentration logic; NOT used (PC-shaped, has resistances). v1 uses the projector's monster HP clamp instead. [VERIFIED] |
| `dice.ts` | `src/engine/dice.ts` | `NdM±K` regex `FORMULA_RE` `:4`; reference for parsing dice exprs. The resolver parses the roll-result STRING, not via these. |
| `modifiers.ts` | `src/engine/modifiers.ts:60-64` | `attackBonus = abilityModifier(STR\|DEX) + prof`. Documents WHY total-vs-AC is correct (bonus is baked into the roll). NOT used in v1. [VERIFIED] |

**Installation:** None. No `npm install`.

## Package Legitimacy Audit

> This phase installs **no external packages**. No audit table needed.

slopcheck was not available in the research environment, but it is moot: the resolver and its tests import only existing internal modules (`@/ai/master/vault/*`, `@/lib/roll-parser`, `vitest`). The planner should add **no** `npm install` task. If a future revision wants a dice-parsing library, that would need its own audit — but the existing `roll-parser.ts` / `dice.ts` regexes already cover `NdM±K`.

## Architecture Patterns

### System Architecture Diagram

```
 Player clicks 🎲 attack button (client)
   │  formatResultText → "🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3)."
   ▼
 POST /api/sessions/[id]/turn  (route.ts, vault branch, masterBackend==='vault')
   │
   ├─ build vaultSys + vaultHistory (UNCHANGED, :300-344)
   ├─ extract _playerMessage = last user turn (ALREADY computed at :355-357)
   │
   ├─ ★ NEW: read encounter EARLY (move/duplicate the POST-LLM read up):
   │      parseEventsFile(eventsPath(campaign.id)) → replayEvents() → { encounter }
   │
   ├─ ★ GATE (D-01): vaultMutations && encounter.active && isRollResult(_playerMessage)
   │      │
   │   ┌──┴─── gate FALSE ───────────────────────────────────────────┐
   │   │  run turn EXACTLY as today (Phase 07 prompt path)            │
   │   │  → directive (:358-372) → runVaultToolLoop (:379) → 07-03    │
   │   │    handoff read at :454-455 (UNCHANGED)                      │
   │   └──────────────────────────────────────────────────────────────┘
   │      │
   │   gate TRUE
   │      ▼
   │   ★ resolver = resolveCombat({ rollResult: _playerMessage, encounter })
   │      │  null → fall through to the normal turn (treat as gate-false)
   │      │  parse total/natural/bonus/dice + kind (1d20+attacc → to-hit; non-d20+danni → damage)
   │      │  to-hit: hit = nat20 || total >= AC(monster.ac ?? 12)
   │      │     miss → events:[turn_advance], directive:"narra MISS", damageRequest:null
   │      │     hit  → events:[],            directive:"narra HIT",  damageRequest:"Tira 1d6+<bonus> per danni a <target>"
   │      │  damage: events:[monster_hp_change(id,-total), turn_advance], directive:"narra -<total> HP"
   │      ▼
   │   ★ EMIT resolver.events server-side:
   │      for each ev → dispatchVaultTool('apply_event', ev, { campaignId: campaign.id })
   │        → validateEvent → EventsWriter.applyEvent(events.md) → regenerateCombatView(combat.md)
   │      ▼
   │   ★ runVaultToolLoop in NARRATION-ONLY mode (resolver.narrationDirective injected;
   │      combat-event apply_event tool calls from the LLM are DROPPED this turn)
   │      ▼
   │   ★ SAFETY NET: if resolver.damageRequest && finalText lacks a roll-request
   │      (no "Tira <dice>" prose) → append resolver.damageRequest to finalText
   │      ▼
   │   persist master message + memory extraction (as today)
   │   ⚠ the 07-03 turnOrder handoff at :454-455 STILL runs in the post-loop
   │      transaction — the resolver already advanced via turn_advance, so the
   │      handoff re-reads the (now-advanced) encounter and hands to the next PC.
   ▼
 client re-renders: CombatTracker HP bar drops (combat.md→snapshot), 🎲 damage button appears
```

File-to-implementation mapping is in the Component Responsibilities table above; the diagram traces the primary use case (player attack → resolve → narrate).

### Recommended Project Structure
```
src/app/api/sessions/[id]/turn/
├── route.ts              # MODIFY — vault branch: early encounter read, gate, resolve, emit, narration-only, safety-net
├── combat-resolver.ts    # NEW — pure resolveCombat + parsing helpers (D-02..D-05)
└── combat-handoff.ts     # UNCHANGED (reference only — 07-03 handoff still runs post-loop)

src/ai/master/vault/
├── loop.ts               # MODIFY — add narration-only mode (drop combat-event apply_event calls)
└── turn-directive.ts     # MODIFY — D-07: suppress the player-side resolve directive when server resolved

tests/app/api/sessions/[id]/turn/
└── combat-resolver.test.ts   # NEW — headless resolver unit tests (mirror src path)
tests/ai/master/vault/
├── loop.test.ts              # EXTEND — narration-only mode (combat-event drop)
└── turn-directive.test.ts    # EXTEND — D-07 suppression
tests/sessions/
└── combat-resolver-integration.test.ts  # NEW — no-double-apply + non-combat regression (pure-helper style)
```

### Pattern 1: Resolver returns `VaultEvent[]`, route wraps + emits (do NOT build envelopes in the resolver)
**What:** `resolveCombat` returns `events: VaultEvent[]` — plain `{type, payload}` objects, NO `id`/`version`/`timestamp` envelope. The route emits each via `dispatchVaultTool('apply_event', ev, {campaignId})`, which allocates the UUID, stamps the timestamp, validates, persists, and regenerates `combat.md`.
**When to use:** Always — this keeps the resolver PURE (no `randomUUID`, no clock, no I/O) so it is headless-testable, and reuses the proven validate+write+regen path verbatim.
**Example:**
```typescript
// resolver (pure)
return {
  kind: 'damage',
  events: [
    { type: 'monster_hp_change', payload: { id: monster.id, delta: -total } },
    { type: 'turn_advance', payload: {} },
  ],
  narrationDirective: `[RESOLVED BY SYSTEM: ${monster.name} subisce ${total} danni] narra in seconda persona`,
  damageRequest: null,
};

// route — emit server-side (mirrors tools.ts:371-382 via the public dispatcher)
for (const ev of resolver.events) {
  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
  if (r.isError) console.warn('[turn] resolver event emit failed:', r.content);
}
```
> Source: `src/ai/master/vault/tools.ts:251-383` (dispatcher); `:285` confirms the UUID guard is skipped for `ENCOUNTER_EVENT_TYPES`, so `monster_hp_change`/`turn_advance` need no `payload.character`. [VERIFIED]

### Pattern 2: Narration-only mode = drop combat-event `apply_event` calls in the loop's dispatch seam
**What:** Add a flag to `VaultLoopInput` (e.g. `suppressCombatMutations?: boolean`). When set, the loop's tool-dispatch loop (`loop.ts:313-343`) skips dispatching any `apply_event` whose `type` is in `ENCOUNTER_EVENT_TYPES`, returning a benign tool_result (e.g. `{ok:true, note:"resolved by system"}`) so the model's turn still completes without a double-apply.
**When to use:** Only on resolution turns (gate fired). Normal turns pass the flag falsy → Phase 07 behavior unchanged.
**Why this seam:** `loop.ts:313-343` is the single place every non-`end_turn` tool call is dispatched. Filtering there (vs. at the dispatcher) keeps the dispatcher's contract intact and the change local. Discretion item per CONTEXT (exact implementation of narration-only mode is Claude's call).
**Example (sketch):**
```typescript
// loop.ts, inside the for (const tu of toolUses) loop
if (suppressCombatMutations && tu.name === 'apply_event'
    && ENCOUNTER_EVENT_TYPES.has((tu.input as {type?:string}).type ?? '')) {
  emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input });
  emit({ type: 'tool_use_end', toolUseId: tu.id, ok: true, rolls: [], mutationCount: 0 });
  toolResults.push({ type:'tool_result', tool_use_id: tu.id,
    content: JSON.stringify({ ok:true, note:'combat resolved server-side this turn' }), is_error:false });
  continue; // do NOT dispatch — server already emitted the authoritative event
}
```
> Note: non-combat `apply_event` calls (e.g. `inventory_add`) must STILL dispatch — only `ENCOUNTER_EVENT_TYPES` are dropped. Import `ENCOUNTER_EVENT_TYPES` from `events-schema.ts:332`.

### Pattern 3: Move the encounter read up, but the 07-03 post-loop read STAYS
**What:** The encounter must be read BEFORE the loop (to gate). The existing POST-LLM read at `route.ts:454-455` feeds the 07-03 `resolveCombatHandoff`. Do NOT delete it — DUPLICATE the read (read early for the gate; the post-loop read re-reads after the resolver's `turn_advance` is persisted, so the handoff sees the advanced state and hands to the next PC).
**When to use:** The early read is gated work; the late read is the unchanged handoff. They read the same file at different times (the resolver's events are written between them).
**Why two reads are correct:** `parseEventsFile`→`replayEvents` is pure and cheap (~1ms/100 events per spike 008, projector.ts JSDoc). The early read sees the pre-resolution encounter (to decide hit/miss/target); the late read sees post-`turn_advance` state (so the handoff advances correctly). Sharing one read would make the handoff act on stale (pre-advance) state.

### Anti-Patterns to Avoid
- **Building `VaultEventEnvelope` inside the resolver:** introduces `randomUUID` + `Date.now` into a function that must stay pure/testable. Let the dispatcher stamp those.
- **Calling `makeAttack`/`applyDamage` from the resolver:** they require a full `Character`/`CombatActor` (abilities, proficiencies, resistances, runtime) the vault path does not have, and they re-roll the d20 (the client already rolled it). The spec's "mirror, don't call" is correct. [VERIFIED: `attack.ts:338-339` rolls its own d20; `damage.ts` branches on `isPc`.]
- **Emitting the damage request without a `per` lead-in:** breaks the round-trip (see Pitfall 1). Always `"Tira <die>+<bonus> per danni a <target>"`.
- **Dropping ALL `apply_event` calls in narration-only mode:** would also drop legit non-combat mutations. Filter to `ENCOUNTER_EVENT_TYPES` only.
- **Hard-throwing on an unparseable roll:** the contract is `null` → graceful fall-through. The resolver must never throw (CONTEXT D-05, D-10).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Persisting events + regenerating the combat view | A bespoke writer/regen in the route | `dispatchVaultTool('apply_event', ev, {campaignId})` | Already mutex-serialized (`EventsWriter`), validated (`validateEvent`), and regenerates `combat.md` synchronously (`tools.ts:371-382`). The encounter UUID guard is already relaxed (`:285`). |
| HP clamp math | Re-deriving `max(0, hp+delta)` + isAlive | The `monster_hp_change` reducer (`projector.ts:780-789`) does it on replay | The resolver only emits the `delta`; the reducer clamps + sets `isAlive` on the next `combat.md` regen. Mirror the rule in tests, don't re-implement persistence. |
| Hit rule | A new to-hit formula | Mirror `attack.ts:365` literally: `hit = natural === 20 || total >= (monster.ac ?? 12)`; `natural === 1` → miss | 5e-faithful, already audited; spec D-03 locks this exact rule. |
| Parsing `NdM±K` | A new dice grammar | The roll-result is a STRING you parse with a small regex; reference `FORMULA_RE` (`dice.ts:4`) only for shape | You parse the rendered breakdown `(15+3)`, not a formula. See Pitfall 2 for the exact regex anchoring. |
| Roll-result detection | A new "did the player roll?" check | `isRollResult` (`turn-directive.ts:69`): `/🎲\|\bI rolled\b/i` | Already proven (07-05); reuse for the gate so behavior matches the existing directive switch. |
| Turn handoff after the resolver advances | New handoff logic | The existing `resolveCombatHandoff` post-loop read (`route.ts:454-456`) | After the resolver emits `turn_advance`, the unchanged 07-03 handoff re-reads and advances to the next PC. Leave it. |

**Key insight:** Every persistence/state primitive this phase needs already exists and is battle-tested across Phases 02/03/06/07. The genuinely new code is ~1 pure function + 1 loop flag + ~10 lines of route glue. The risk is entirely in the SEAMS (parse round-trip, double-apply, encounter read placement), not in new infrastructure.

## Runtime State Inventory

> Not a rename/refactor/migration phase. This section is included only to record the one stateful concern.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `events.md` per campaign gains additional `monster_hp_change`/`turn_advance` lines emitted by the server (previously only LLM-emitted). No schema change; same event types. | None — additive. The projector replays them identically regardless of emitter. |
| Live service config | None — verified. No external service holds combat state; `combat.md` is a materialized view regenerated from `events.md`. | None. |
| OS-registered state | None — verified. No scheduler/daemon involved. | None. |
| Secrets/env vars | None new. `VAULT_CAMPAIGNS_ROOT` (existing) is where `events.md` lives. | None. |
| Build artifacts | None — pure TS, no codegen, no baked-model rebuild (REQ-022 hygiene rule does NOT scope the resolver). | None. |

**The canonical question (server now emits authoritative events):** because the resolver emits the SAME event types the LLM used to emit, and the projector is a pure replay, there is no migration. Existing campaigns' `events.md` replay unchanged; new turns simply have server-authored `monster_hp_change`/`turn_advance` lines.

## Common Pitfalls

### Pitfall 1: Damage-request format without `per` loses the target (BLOCKING)
**What goes wrong:** Emitting `"Tira 1d6+3 danni a Veyra"` (the CONTEXT/spec format). The client's `extractPurpose` (`roll-parser.ts:744`) requires a `per`/`for` lead-in to capture text into the button label. Without it, the button label becomes the bare formula `1d6+3`, the roll-result is `🎲 I rolled **9** for 1d6+3 (6+3).`, and **"Veyra" is gone**. The resolver's damage path then finds no `danni a <target>` substring → returns `null` → no HP applied → silent failure.
**Why it happens:** The spec author assumed the label is passed through verbatim; it is not — it goes through `extractPurpose`'s `per`/`for` gate.
**How to avoid:** Emit `"Tira 1d6+3 per danni a Veyra"` (with `per`). Verified: `extractPurpose` then captures `"danni a Veyra"`, the roll-result is `🎲 I rolled **9** for 1d6+3 (danni a Veyra) (6+3).`, and the resolver's `/danni\s+a\s+([^.;:!?\n)]+)/i` recovers `"Veyra"`. This is symmetric with the existing attack format (`prompt-builder.ts:132`: `"Tira 1d20+<bonus> per attaccare <target>"`).
**Warning signs:** A damage roll during active combat that produces no `monster_hp_change` (HP bar doesn't move) and the turn doesn't advance — the resolver fell through to `null`.
**Provenance:** [VERIFIED: executed `roll-parser.ts` logic on both formats; only the `per` form round-trips.]

### Pitfall 2: The breakdown is the LAST parenthetical, and a `+0` bonus produces NO breakdown
**What goes wrong:** Two sub-traps in natural-20 / natural extraction from the to-hit roll-result:
1. The roll-result has TWO parentheticals: `(attaccare Veyra)` (the label purpose) then `(15+3)` (the breakdown). A regex like `/\((\d+)/` matches the FIRST one ("attaccare" has no digit, but a label like `(attacco 2)` could). Anchor the breakdown regex to the END of string.
2. When the to-hit bonus is `+0` (single d20, no modifier), `formatResultText` sets `showBreakdown = false` (`roll-request-button.tsx:126`) → the roll-result is `🎲 I rolled **18** for 1d20 (attaccare Veyra).` with **no breakdown at all**. A resolver that reads "natural = first breakdown number" will throw or misparse.
**Why it happens:** The single-d20-no-breakdown case is a deliberate UX choice (comments at `roll-request-button.tsx:122-123`: showing `(20)` made the model invent a different number). The resolver inherits this ambiguity.
**How to avoid:**
- Extract the breakdown from the LAST parenthetical: `/\(([\d+\- ]+)\)\s*\.?\s*$/` over the trimmed string; `natural = first number of that group`.
- If NO trailing breakdown matches (the `+0` case), set `natural = total` (correct: with `+0`, the natural die IS the total). This also makes nat-20 detection on `+0` work (total 20 → natural 20).
- `bonus = total - natural` (derive it; don't parse `+3` separately — more robust to spacing).
**Warning signs:** A unit test with `1d20` (no modifier) crashes the parser, or nat-20 on a `+0` attack isn't auto-hit.
**Provenance:** [VERIFIED: executed `formatResultText` for `+3`, `+0`, and nat-20 cases.]

### Pitfall 3: Double-apply if narration-only mode isn't wired (the core risk)
**What goes wrong:** The server emits `monster_hp_change(-9)`. Then the LLM, narrating, ALSO calls `apply_event monster_hp_change`. Now the monster takes 18 damage. The D2 smoke showed local models DO emit these calls when nudged.
**Why it happens:** `runVaultToolLoop` dispatches every `apply_event` it sees (`loop.ts:321`). Without a suppression flag, the LLM's combat-event calls hit the dispatcher and persist a second event.
**How to avoid:** Pattern 2 — drop `ENCOUNTER_EVENT_TYPES` `apply_event` calls in the loop's dispatch seam on resolution turns. ALSO apply D-07: suppress the player-side resolve directive (`turn-directive.ts:97-109`) so the prompt doesn't actively instruct the model to emit `monster_hp_change`/`turn_advance` — otherwise you're dropping calls the prompt asked for (works, but wasteful and confusing). Belt-and-suspenders: both the directive suppression (don't ask) and the loop drop (don't honor if asked anyway).
**Warning signs:** Monster HP drops by 2× the rolled damage; turn advances twice (skips a PC).
**Provenance:** [VERIFIED: `loop.ts:313-343` dispatches all non-end_turn tools; `turn-directive.ts:103-106` is the directive that tells the model to emit these events.]

### Pitfall 4: Gating on the wrong `playerMessage`, or before the gate's encounter read
**What goes wrong:** The route already computes `_playerMessage` at `:356-357` (last user turn of `vaultHistory`) — but note the directive may have been appended to it at `:368-371` (`appendDirectiveToHistory`). Gate on the message BEFORE the directive is appended, and read the encounter BEFORE building/sending the loop. If you read `_playerMessage` after the append, `isRollResult` still matches (the 🎲 is at the start), but you'd be parsing a string with a directive glued on — harmless for `isRollResult` but the resolver should parse the player's ORIGINAL roll text.
**Why it happens:** The directive-append mutates `vaultHistory`; the resolver needs the clean roll-result.
**How to avoid:** Capture the clean `_playerMessage` at `:356-357` (it's already there) and pass THAT to both the gate and `resolveCombat`. Place the early encounter read + gate + resolve BEFORE the `runVaultToolLoop` call (`:379`) — CONTEXT D-01 says hook before the loop (~:379), move the read up to ~:357.
**Warning signs:** The resolver's target-parse picks up directive text; or the gate fires on a non-roll turn.
**Provenance:** [VERIFIED: `route.ts:355-372` shows `_playerMessage` is computed then the directive is appended to history.]

### Pitfall 5: CONTEXT.md line numbers have drifted — verify against the live 936-line route
**What goes wrong:** CONTEXT cites `~:97` (player message), `~:355-357`, `~:379`, `~:454-455`. The file is now **936 lines**. Trusting stale line numbers misplaces the hook.
**How to avoid:** Use these VERIFIED current anchors (route.ts, 2026-05-29):
- Vault branch start: `:278` (`if (masterBackend === 'vault')`)
- `vaultMutationsEnabled` resolved: `:282`
- `_lastUserTurn` / `_playerMessage`: `:355-357` (matches CONTEXT — coincidentally stable)
- directive built + appended: `:358-372`
- `runVaultToolLoop` call: `:379-421` (matches CONTEXT ~:379)
- post-loop transaction opens: `:427`
- **POST-LLM encounter read to duplicate up**: `:454-455` (`parseEventsFile(eventsPath(s.campaignId))` → `replayEvents` → `{ encounter }`) (matches CONTEXT ~:454-455)
- 07-03 `resolveCombatHandoff` call: `:456`
- vault-path early return: `:523`
**Warning signs:** The hook lands in the baked path (`:527+`) or after the early return.
**Provenance:** [VERIFIED: full read of `route.ts`.]

## Code Examples

Verified patterns from the live codebase:

### Parsing the to-hit roll-result (handles both breakdown + no-breakdown)
```typescript
// Input examples (verified against formatResultText):
//   "🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3)."   → total 18, nat 15, bonus 3
//   "🎲 I rolled **18** for 1d20 (attaccare Veyra)."            → total 18, nat 18, bonus 0 (no breakdown)
//   "🎲 I rolled **23** for 1d20+3 (attaccare Veyra) (20+3)."   → total 23, nat 20 → auto-hit
function parseRoll(rollResult: string): { total: number; natural: number; bonus: number; diceKind: string } | null {
  const totalM = /\*\*\s*(\d+)\s*\*\*/.exec(rollResult);
  if (!totalM) return null;
  const total = parseInt(totalM[1]!, 10);
  // dice kind: the FIRST "NdM" token after "for"
  const diceM = /\bfor\s+((?:\d+)?d\d+)/i.exec(rollResult);
  const diceKind = diceM ? diceM[1]!.toLowerCase() : '';
  // breakdown = LAST parenthetical of digits/+/-; absent on +0 single die.
  const bkM = /\(([\d+\-\s]+)\)\s*\.?\s*$/.exec(rollResult.trim());
  const natural = bkM ? parseInt(bkM[1]!.split('+')[0]!.trim(), 10) : total; // fallback: nat = total
  const bonus = total - natural;
  return { total, natural, bonus, diceKind };
}
```
> Source contract: `src/components/game/roll-request-button.tsx:125-134` (`formatResultText`). [VERIFIED by execution.]

### The hit rule (mirror of attack.ts:345/361/365)
```typescript
const ac = monster.ac ?? 12;            // D-08 default
const isCritMiss = natural === 1;       // attack.ts:345 — nat-1 auto-miss
const isCritHit  = natural === 20;      // attack.ts:361 — nat-20 auto-hit
const hit = !isCritMiss && (isCritHit || total >= ac);  // attack.ts:365 rule, applied to the rolled total
```
> Source: `src/engine/combat/attack.ts:345,361,365`. v1 does NOT call `makeAttack` (it re-rolls the d20). [VERIFIED]

### Emitting the damage request with the `per` lead-in (the FIX)
```typescript
// bonus reused from the to-hit roll; defaultDamageDie = "1d6" (D-08)
const damageRequest = `Tira ${defaultDamageDie}+${bonus} per danni a ${monster.name}`;
// → client RollRequestButton label "1d6+3 (danni a Veyra)", kind=damage (inferKind sees "danni")
// → on roll: "🎲 I rolled **9** for 1d6+3 (danni a Veyra) (6+3)."  ← echoes the target ✓
```
> Source contract: `src/lib/roll-parser.ts:744` (`extractPurpose` needs `per`/`for`); `:810` (`inferKind` → 'damage' on "danni"). [VERIFIED by execution.]

### Server-side event emission (reusing the dispatcher)
```typescript
// route.ts, after resolveCombat returns non-null:
for (const ev of resolver.events) {
  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
  if (r.isError) {
    // Defensive: log + continue (CONTEXT D-10 — never hard-fail the turn).
    console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
  }
}
```
> Source: `src/ai/master/vault/tools.ts:251-383`. Encounter events skip the UUID guard (`:285`). Persists to `events.md` + regenerates `combat.md` (`:373-375`). [VERIFIED]

## State of the Art

| Old Approach (Phase 07) | Current Approach (Phase 08 v1) | When Changed | Impact |
|--------------------------|--------------------------------|--------------|--------|
| LLM performs to-hit/damage/HP/turn via prompt directive | Server resolves player attacks deterministically; LLM narrates only | This phase | Fixes the local-model ceiling (free-narrated outcomes, ignored the rolled number) — REQ-039 |
| `monster_hp_change`/`turn_advance` emitted ONLY by the LLM `apply_event` | Emitted by the SERVER (resolver) on resolution turns; LLM combat-event calls dropped that turn | This phase | Deterministic state; no double-apply |
| Player-side "resolve" directive nudges the model to apply the roll (`turn-directive.ts:97`) | Suppressed on server-resolved turns (D-07); server narration directive takes over | This phase | Avoids conflicting instructions |

**Deprecated/outdated:**
- Nothing deprecated. v1 is purely additive to the vault branch. Monster turns (v2), real weapon dice + crits + resistances (v3), and auto-`combat_end` (v3) remain explicitly out of scope.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The damage-request format must use `per danni a <target>` (NOT the CONTEXT.md `danni a <target>`). | Pitfall 1, Code Examples | This is VERIFIED by executing the parser, but it CONTRADICTS the locked spec text. The planner/discuss-phase should confirm the operator accepts the `per` form (semantics identical; it's a one-word fix to make the existing client parser round-trip). LOW risk — the alternative (bare format) is proven broken. |
| A2 | Narration-only mode is implemented as a `runVaultToolLoop` flag that drops `ENCOUNTER_EVENT_TYPES` `apply_event` calls. | Pattern 2 | CONTEXT explicitly leaves "how narration-only mode is implemented" to Claude's discretion. This is a recommendation, not a locked design. Low risk. |
| A3 | The 07-03 post-loop handoff read (`:454-455`) should remain and re-read after the resolver's `turn_advance`. | Pattern 3 | If the planner instead routes handoff off the early read, the next-PC handoff would act on pre-advance state. Medium risk if mis-planned — flagged prominently. |
| A4 | `monster.name` (from `encounter.monsters[].name`) is the string to echo in the damage request and to case-insensitively match on the incoming roll. | D-03/D-04 paths | Verified the shape exists (`projector.ts:666-675`). The match strategy (case-insensitive substring/equality) is Claude's discretion per CONTEXT. Low risk. |

## Open Questions

1. **Multiple monsters with the same/similar name (ambiguous target).**
   - What we know: CONTEXT D-05/D-10 says ambiguous target → return `null` (fall through).
   - What's unclear: How to detect "ambiguous" — exact-match collisions vs. substring collisions (e.g. "Goblin" matching "Goblin Boss"). The `monster_spawn` payload allows duplicate names with distinct `id`s.
   - Recommendation: Resolve by case-insensitive EXACT name match first; if 0 or >1 monsters match exactly, return `null`. Document this in the resolver. Add a unit test for the >1-match case.

2. **What if the player rolls a to-hit while it's NOT a `1d20` (e.g. they manually typed a roll)?**
   - What we know: Kind detection is `1d20 + attacc/colp keyword → to-hit`; `non-d20 + danni → damage`. Anything else → `null`.
   - What's unclear: A `1d20` roll with NO attack keyword (a generic ability check during combat) should NOT be treated as an attack.
   - Recommendation: Require BOTH the dice kind AND the label keyword for each branch; absence of a keyword → `null` → normal turn. This is already in D-03/D-04; just ensure the unit tests cover "1d20 during combat with no attack keyword → null".

3. **Safety-net detection of "LLM already wrote a roll-request".**
   - What we know: D-06 says append the damage request only if the LLM output lacks one.
   - What's unclear: How to detect a roll-request in `finalText` — reuse `parseRollRequests(finalText).length > 0`? That's the most faithful (same parser the client uses).
   - Recommendation: Use `parseRollRequests(finalText).some(r => r.kind === 'damage')` to decide whether to append. Reuses the client contract exactly; avoids a divergent ad-hoc regex.

## Environment Availability

> This phase is pure code/config. The only runtime dependency is the existing vault filesystem + local LLM for the operator smoke.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js + tsx | tests, scripts | ✓ | tsx ^4.21.0 | — |
| vitest | resolver unit + integration tests | ✓ | ^4.1.5 | — |
| `VAULT_CAMPAIGNS_ROOT` filesystem | event emission at runtime (not in unit tests) | ✓ (existing) | — | tests use `tmpdir` mktemp pattern (see `loop.test.ts:99-104`) |
| Ollama + `qwen3:30b-a3b-instruct-2507-q4_K_M` | operator smoke ONLY (layer 3) | n/a in CI | REQ-030 | smoke runs on the operator's M4/M5; unit + integration tests need no LLM (scripted provider) |

**Missing dependencies with no fallback:** None — all automated test layers run headless with mocked providers and tmp filesystems.
**Missing dependencies with fallback:** The LLM is needed only for the manual operator smoke; the two automated layers (resolver unit, integration) are fully headless.

## Validation Architecture

> No `.planning/config.json` exists → `workflow.nyquist_validation` defaults to ENABLED. This section is included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` (two projects: `components` jsdom @ `tests/components/**`, `node` @ `tests/**` excl. components/e2e) |
| Quick run command | `pnpm vitest run tests/app/api/sessions/\[id\]/turn/combat-resolver.test.ts` |
| Full suite command | `pnpm test` (alias for `vitest run`) |
| Typecheck gate | `pnpm tsc --noEmit` (STATE.md shows every prior plan ran this clean) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-039 | to-hit total ≥ AC → hit + damageRequest (with `per`) | unit | `pnpm vitest run -t "to-hit hit"` | ❌ Wave 0 (`tests/app/api/sessions/[id]/turn/combat-resolver.test.ts`) |
| REQ-039 | to-hit total < AC → miss + `turn_advance`, damageRequest null | unit | same file | ❌ Wave 0 |
| REQ-039 | nat 20 < AC → still hit (auto-hit) | unit | same file | ❌ Wave 0 |
| REQ-039 | nat 1 ≥ AC → still miss (auto-miss) | unit | same file | ❌ Wave 0 |
| REQ-039 | `+0` bonus roll (no breakdown) → natural=total, parses correctly | unit | same file | ❌ Wave 0 |
| REQ-039 | damage roll → `monster_hp_change(id,-total)` + `turn_advance` | unit | same file | ❌ Wave 0 |
| REQ-039 | target parsed from `danni a <name>` label (case-insensitive) | unit | same file | ❌ Wave 0 |
| REQ-039 | unknown / ambiguous target → `null` (fall-through) | unit | same file | ❌ Wave 0 |
| REQ-039 | default AC 12 when `monster.ac` absent; default die `1d6` in request | unit | same file | ❌ Wave 0 |
| REQ-039 | non-d20 + no `danni` keyword → `null` | unit | same file | ❌ Wave 0 |
| REQ-039 | damage-request label round-trips with target (`per danni a` form) | unit | same file (assert on `roll-parser.parseRollRequests`) | ❌ Wave 0 |
| REQ-039 | narration-only mode drops LLM `monster_hp_change`/`turn_advance` calls | integration | `pnpm vitest run tests/ai/master/vault/loop.test.ts` | ⚠ EXTEND existing |
| REQ-039 | non-resolution turn → loop dispatches `apply_event` normally (regression) | integration | same loop test | ⚠ EXTEND existing |
| REQ-039 | D-07: resolve directive suppressed when server resolved | unit | `pnpm vitest run tests/ai/master/vault/turn-directive.test.ts` | ⚠ EXTEND existing |

### Sampling Rate
- **Per task commit:** the targeted file (`combat-resolver.test.ts`) — sub-second, runs on every red/green.
- **Per wave merge:** `pnpm vitest run tests/app/api tests/ai/master/vault tests/sessions` (resolver + loop + directive + interleaving) — the affected surface.
- **Phase gate:** `pnpm test` (full suite) green + `pnpm tsc --noEmit` clean before `/gsd-verify-work`. (STATE.md baseline: ~661 vault tests; 1 pre-existing unrelated `applicator/gp-stack` failure noted in 07-03 — confirm it's still the only pre-existing failure.)

### Wave 0 Gaps
- [ ] `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` — NEW; covers REQ-039 resolver math (all unit rows above). Pure function, no mocks needed beyond `EncounterState` fixtures (copy the shape from `vault-combat-turn-interleaving.test.ts:59-68`).
- [ ] `tests/ai/master/vault/loop.test.ts` — EXTEND with a narration-only-mode describe block. Reuse the existing `scriptedProvider` + `vi.mock('@/db/client')` harness (`loop.test.ts:19-89`). Script a response that emits `apply_event monster_hp_change` and assert it is NOT dispatched (no persist) when the flag is set.
- [ ] `tests/ai/master/vault/turn-directive.test.ts` — EXTEND for D-07 suppression.
- [ ] No-double-apply integration: prefer extending `loop.test.ts` (the loop is where the drop happens) over a full route test — the route's `POST` is a `waitUntil` background task with heavy auth/DB coupling and is NOT directly unit-tested in this repo (verified: only `resolveCombatHandoff` and loop-level helpers are tested, not the route handler itself).
- Framework install: none — vitest already present.

## Security Domain

> No `.planning/config.json` → `security_enforcement` defaults to ENABLED. Included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unchanged — the route's Clerk `auth()` + party-access checks (`route.ts:94-119`) are upstream of the vault branch; this phase adds no new entry point. |
| V3 Session Management | no | Unchanged — turn lock (`acquireTurnLock`) already serializes turns. |
| V4 Access Control | yes (inherited) | The resolver runs ONLY inside the already-authorized vault branch (post `checkPartyAccess`). It introduces no new authorization surface. `campaignId` is server-side (`campaign.id`), never LLM-supplied — preserved. |
| V5 Input Validation | yes | The roll-result string is player-controlled input parsed by the resolver. Mitigations: (a) `validateEvent` runs on every emitted event at the dispatcher boundary (`tools.ts:270`); (b) the resolver returns `null` on any unparseable/ambiguous input (never throws); (c) `monster_hp_change` delta is bounded by the monster's HP clamp in the reducer (`projector.ts:786` — even a hostile huge total bottoms HP at 0, can't go negative). |
| V6 Cryptography | no | None — no secrets, no crypto. Event `id` UUIDs are allocated by the existing dispatcher (`randomUUID`), not the resolver. |

### Known Threat Patterns for {Next.js route + player-supplied roll string}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Player crafts a roll-result string to damage an arbitrary monster id | Tampering | The resolver matches by NAME against `encounter.monsters[].name`, then resolves the server-side `id`. The player can name a monster but cannot inject an arbitrary `id`; an unknown name → `null`. The reducer also defensively skips unknown ids (`projector.ts:784`). |
| Player injects a giant damage total to one-shot / overflow | Tampering / DoS | HP clamp `max(0, hp+delta)` (`projector.ts:786`) — no negative HP, no overflow. `monster_hp_change` validator requires a finite number (`events-schema.ts:1089`). |
| Player crafts a string to trigger a resolver exception → 500 / DoS | DoS | Contract: resolver NEVER throws (CONTEXT D-05/D-10) → returns `null` → normal turn. Verify with a "garbage string → null, no throw" unit test. Wrap the emit loop in a try/catch (D-10) so a dispatcher error logs + continues. |
| Double-apply (server + LLM both emit) corrupts HP/turn state | Tampering (integrity) | Pitfall 3 — narration-only mode drops `ENCOUNTER_EVENT_TYPES` LLM calls + D-07 directive suppression. Integrity-critical; this is the headline correctness control of the phase. |
| LLM-supplied `campaignId` writes to another campaign's events.md | Tampering / Elevation | Unchanged & preserved: `campaignId` comes from `campaign.id` (server), the dispatcher rejects non-UUID (`tools.ts:262`), and `apply_event` errors without a server `campaignId` (`:256`). The resolver passes `campaign.id`, never anything player-derived. |

## Sources

### Primary (HIGH confidence — read in full or executed)
- `src/app/api/sessions/[id]/turn/route.ts` (936 lines) — vault branch structure, hook points, line drift
- `src/ai/master/vault/loop.ts` — `runVaultToolLoop`, dispatch seam (`:313-343`)
- `src/ai/master/vault/tools.ts` — `dispatchVaultTool` server-side emission path, encounter UUID-guard relaxation (`:285`)
- `src/ai/master/vault/events-schema.ts` — `VaultEvent` union, `monster_hp_change`/`turn_advance` validators, `ENCOUNTER_EVENT_TYPES` (`:332`)
- `src/ai/master/vault/projector.ts` — `EncounterState` (`:661-676`), encounter reducer math (`:723-801`)
- `src/ai/master/vault/turn-directive.ts` — `isRollResult` (`:69`), the resolve directive to suppress (`:97-109`)
- `src/lib/roll-parser.ts` — `extractPurpose` (`:744`), `inferKind` (`:804`), `formatResultText` contract (executed both)
- `src/components/game/roll-request-button.tsx` — `formatResultText` (`:125-134`) (executed)
- `src/engine/combat/attack.ts` — hit rule (`:345/361/365`); `src/engine/combat/damage.ts` (`:82`); `src/engine/dice.ts`; `src/engine/modifiers.ts:60-64`
- `src/ai/master/vault/campaign-paths.ts` / `events-writer.ts` — emission persistence primitives
- `tests/ai/master/vault/loop.test.ts`, `tests/sessions/vault-combat-turn-interleaving.test.ts` — test harness patterns
- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` — Next.js 16 route handlers (params is a `Promise`, already handled; no change to the POST signature)
- `docs/superpowers/specs/2026-05-29-combat-resolver-v1-design.md` — the approved design
- `.planning/phases/08-.../08-CONTEXT.md` — locked decisions (D-01..D-10)

### Secondary (MEDIUM confidence)
- `scripts/_probe-combat.ts` — operator-smoke harness; its `resolve` mode already simulates the exact roll-result string format
- STATE.md — prior-phase test counts + `tsc` clean baseline; pre-existing `applicator/gp-stack` failure note

### Tertiary (LOW confidence)
- None — every claim is grounded in code read or executed in this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps; every consumed module read in full.
- Architecture / integration seams: HIGH — route, loop, dispatcher, projector all verified; line drift mapped.
- Pitfalls: HIGH — Pitfall 1 and 2 were proven by EXECUTING the actual parser logic, not assumed.
- The one contradiction with the locked spec (damage-request `per` form) is logged as A1 for user confirmation.

**Research date:** 2026-05-29
**Valid until:** 2026-06-28 (stable internal codebase; the only volatility is `route.ts` line numbers — re-verify anchors if other phases land first).
