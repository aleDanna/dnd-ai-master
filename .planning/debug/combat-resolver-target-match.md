---
status: resolved
trigger: "Phase 07-04 operator smoke: combat started + monsters spawned, but the player's attack applied no proper damage and the enemies never took their turn."
created: "2026-06-01T12:15:00Z"
updated: "2026-06-04T11:20:00Z"
phase: "07-04"
key_files:
  - src/app/api/sessions/[id]/turn/combat-resolver.ts
  - src/app/api/sessions/[id]/turn/route.ts
  - src/ai/master/vault/projector.ts
  - src/ai/master/vault/turn-directive.ts
---

# Debug: vault combat resolver falls through on article-prefixed / duplicate-named targets

## Symptoms

- **Expected:** Player attacks a monster → server resolves to-hit vs AC → damage roll → `monster_hp_change` + `turn_advance` → turn advances to the next actor → Phase-09 monster-turn loop runs the monster's attack → round alternates → `combat_end` clears the tracker.
- **Actual:** Combat started and monsters spawned, but the player's attack applied no proper damage (only an arbitrary LLM `-2`), the turn never advanced, and the enemies never took their turn (the master narrated "È il turno del pirata… Che fai?" — incoherently asking the PLAYER to act on the monster's turn).
- **Errors:** No thrown error. Silent fall-through. (`route.ts:439` would have logged `combat-resolver fell through on a roll-result during ACTIVE combat` to server stdout — not captured, but consistent.)
- **Timeline:** Surfaced at the Phase 07-04 operator smoke (2026-06-01). The combat-resolver (Phase 08) + monster-turn loop (Phase 09) + encounter opener (Phase 10) all landed after Phase 07's LLM-driven combat design; this is their first live integrated smoke on One Piece.
- **Reproduction:** One Piece campaign (vault sourceOfTruth, vaultMutations=true, manualRolls=true, model qwen3:30b-a3b-instruct). Start a fight → master spawns multiple identically-named monsters ("Pirata di Buggy" x3) → declare an attack on "il Pirata di Buggy con il naso enorme" → roll the 🎲 attack → server resolver returns null → combat stalls.

## Current Focus

hypothesis: |
  `matchMonster()` (combat-resolver.ts:118-133) requires a CASE-INSENSITIVE EXACT
  match of the player-named target against `encounter.monsters[].name`. The roll
  label's extracted target carries an Italian article + descriptor ("il Pirata di
  Buggy con…") that never equals the bare monster name "Pirata di Buggy" → 0
  matches → resolveCombat returns null → LLM fallback (qwen3) applies an arbitrary
  monster_hp_change with NO turn_advance → turn never advances → Phase-09 monster
  loop (gated on the active turnOrder actor being a live monster) never runs.
test: "RED unit test in the existing combat-resolver suite: 3 monsters all named 'Pirata di Buggy' + roll label 'attaccare il Pirata di Buggy con…' currently → resolveCombat returns null; must resolve to a to-hit HIT against one live pirate."
expecting: "After fix: resolveCombat returns a 'to-hit' HIT result (18 vs AC 13) with a damage request; on the follow-up damage roll it emits monster_hp_change + turn_advance."
next_action: "Confirm root cause with a RED test (TDD), then (1) deterministic UNIQUE monster naming (number on collision) + (2) matchMonster article/descriptor normalization. See 'Design Decision' below."
tdd_checkpoint: "RED test required before any fix edit (project strict-TDD combat convention; systematic-debugging Phase 4.1)."

## Evidence

- timestamp: 2026-06-01T12:00:00Z
  finding: |
    resolveCombat gate fires correctly on the attack-roll turn (route.ts:425):
    vaultMutationsEnabled=true, isRollResult=true (label has 🎲), encounter.active=true.
    So resolveCombat IS invoked — the failure is INSIDE it, returning null.
- timestamp: 2026-06-01T12:01:00Z
  finding: |
    parseRoll on "🎲 I rolled **18** for 1d20+4 (attaccare il Pirata di Buggy con…) (14+4)."
    → {total:18, natural:14, bonus:4, diceKind:"1d20"}. isD20=true, hasAttackKeyword=true
    ("attaccare" matches /attacc|colp/). To-hit branch entered.
- timestamp: 2026-06-01T12:02:00Z
  finding: |
    Target regex /(?:attaccare|attacca|colpire|colpisci)\s+([^.;:!?\n)]+)/ captures
    "il Pirata di Buggy con…" (article "il" + truncated descriptor "con il naso enorme",
    stops at the ")"). matchMonster needle "il pirata di buggy con…" has 0 exact-name
    matches against monsters named "Pirata di Buggy" → returns null → resolveCombat null.
- timestamp: 2026-06-01T12:03:00Z
  finding: |
    AUTHORITATIVE: events.md recorded `monster_hp_change pirata-buggy-1 delta -2` with
    NO paired turn_advance. The server resolver ALWAYS pairs hp_change+turn_advance
    (combat-resolver.ts:210-218), so the lone hp_change proves the event came from the
    LLM fallback, not the server. combat.md was stuck at currentIdx 0 (Luffy, init 15).
- timestamp: 2026-06-01T12:04:00Z
  finding: |
    session_messages confirm: master asked "Tira 1d20+4 per attaccare il Pirata di Buggy
    con il naso enorme"; after the roll, narrated "...È il turno del pirata con il naso
    enorme. Che fai?" — claims the monster's turn while asking the player to act, and no
    turn_advance was emitted, so the engine still thinks it is the PC's turn.
- timestamp: 2026-06-01T12:05:00Z
  finding: |
    matchMonster ALREADY has duplicate-name disambiguation (lines 126-130: narrow to
    alive AND in turnOrder when >1 exact match). But it only runs AFTER an exact match
    count >1. Here the exact count is 0 (article+descriptor), so it never engages. AND
    even if it did, 3 live identical "Pirata di Buggy" in turnOrder would still be >1 →
    still null. So BOTH normalization AND a "pick first live in turnOrder for identical
    mooks" rule are needed.

## Eliminated

- hypothesis: "The LLM (qwen3) failed to emit combat tools at all (obedience gap)."
  why: |
    Disproven — the LLM DID emit monster_spawn x3 + initiative_set + a monster_hp_change.
    Tool obedience works. The failure is the SERVER resolver disengaging, then the LLM
    fallback being unreliable (no turn_advance). Fixing the server resolver is the target.
- hypothesis: "Stale cross-session encounter state caused the stall."
  why: |
    Contributing noise, not the cause. combat.md was active:true round 2 with zombie
    freya monsters from May 30 (the May-30 fight never emitted combat_end). Already
    mitigated: emitted combat_end to reset One Piece (combat.md now active:false). The
    target-match null happens regardless of the stale monsters.

## Design Decision (RESOLVED by user — 2026-06-01)

The user REJECTED the "pick first live mook" relaxation of T-08-01. Instead, the chosen
strategy is **deterministic UNIQUE monster names**:

> "Non dovrebbero chiamarsi uguale. Ogni mostro deve avere un nome unico, e.g. Pirata di
> Buggy 1, Pirata di Buggy 2, Pirata di Buggy 3. Il numero va messo SOLO se esistono
> almeno 2 nomi uguali."

Rules:
- When ≥2 monsters in the encounter share the same base name → number them ALL in order:
  "Base 1", "Base 2", "Base 3" (the FIRST is numbered too — NOT "Base, Base 2, Base 3").
- A lone monster with a unique base name stays UNNUMBERED ("Pirata di Buggy").
- Must be DETERMINISTIC + server-side (must NOT depend on the LLM choosing distinct names).
- T-08-01 stays STRICT (0 or >1 → null). With unique names, the >1 case no longer arises
  for numbered mooks, so the "pick first" relaxation is NOT implemented.

## Proposed Fix Direction (validate via TDD — do NOT skip RED)

1. **Unique naming (PRIMARY, deterministic).** Make `EncounterState.monsters[].name`
   unique by numbering base-name collisions, per the Design Decision above. Likely spot:
   the projector (`src/ai/master/vault/projector.ts`) — either in the `monster_spawn`
   reducer or a post-replay display-name derivation so the FIRST collider is also numbered
   ("1,2,3", not "base,2,3") and the result is deterministic on replay. The numbered names
   land in `combat.md` (the tracker), so the master + player see and target them precisely.
   Keep ids (`pirata-buggy-1/2/3`) untouched — they are already unique; only the NAME is
   deduped. RED tests: 3 same-base spawns → "X 1/2/3"; 1 spawn → "X"; mixed (2 Goblin + 1
   Orc) → "Goblin 1","Goblin 2","Orc".
2. **matchMonster normalization (SECONDARY, still needed).** Strip leading IT/EN articles
   (il/lo/la/i/gli/le/un/uno/una/l'/the/a/an) + descriptor tail ("con"/"with"/comma) so a
   roll label "attaccare il Pirata di Buggy 2" → "Pirata di Buggy 2" → exact match on the
   now-unique name. PRECEDENT: commit 6875b9f normalized extractMonsterName the same way.
   Keep T-08-01 strict (0 or >1 → null). RED test: roll "attaccare il Pirata di Buggy 2"
   vs monsters ["Pirata di Buggy 1/2/3"] → resolves to pirata-buggy-2.
3. **Master must reference the exact tracker name.** With numbered names, the attack-roll
   request the master builds must use the exact name from combat.md (e.g. "Tira 1d20+4 per
   attaccare il Pirata di Buggy 2") so the roll label carries the number. EVALUATE whether
   the combat directive / prompt-builder needs a reinforcement line ("usa il nome esatto
   del mostro dal tracker, incluso il numero"). If the master uses a prose descriptor
   instead of the number when ≥2 numbered mooks exist, normalization yields the bare base
   name which matches NONE of the numbered names → still null. Flag/handle this.
4. **Defensive turn_advance (TERTIARY, optional).** Consider a server-side turn_advance (or
   explicit handling) when resolveCombat returns null on a roll-result during an ACTIVE
   encounter, so an LLM that forgets turn_advance can't stall the fight. Secondary — only
   matters on fall-through.
5. **Verify the full flow restores:** to-hit HIT → damage request → damage roll →
   monster_hp_change + turn_advance → Phase-09 monster loop engages → monsters attack.

## Constraints / project context

- resolveCombat is a PURE function (no clock/env/randomness) — keep it pure; it NEVER
  throws (D-05/D-10): return null on any unparseable/ambiguous input.
- HP clamp lives in the monster_hp_change reducer (projector.ts:786), not the resolver.
- Mechanics decisions: Skill spike-findings-dnd-ai-master + memory rulebook-grounded-mechanics.
- Test baseline: memory dnd-known-flaky-failing-tests — pre-existing failures (applicator/gp-stack,
  scene-image-coalesce, tts-coalesce, preferences-local, job-claims, game-client-begin-stuck) are
  NOT regressions. Run `pnpm tsc --noEmit` (whole-project) + the combat-resolver test file.
- This blocks Phase 07-04 (operator smoke checkpoint) — 07-04 stays incomplete until the fix
  lands and the smoke re-passes.

## Re-test 2026-06-02 — fix #1 necessary but INSUFFICIENT; refined root cause + new fix direction

Fix #1 (unique naming + matchMonster normalization, commits d065851/5599cf2) shipped and
WORKS at the data layer: combat.md now shows "Pirata di Buggy 1/2/3". But the live re-test
smoke STILL failed. Evidence:

- timestamp: 2026-06-02T18:53:00Z
  finding: |
    combat.md confirms dedup works — monsters render as "Pirata di Buggy 1/2/3". The player
    even used the numbered name in the declaration ("attacco pirata di buggy 1 con un gum
    gum pistol").
- timestamp: 2026-06-02T18:54:00Z
  finding: |
    BUT the master (qwen3) authored the TO-HIT roll request with a PROSE DESCRIPTOR, not the
    canonical name: "Tira 1d20+4 per attaccare il Pirata di Buggy con il naso enorme." So the
    roll label became "attaccare il Pirata di Buggy con…" → normalizeTargetName strips article
    + "con…" tail → "Pirata di Buggy" → which no longer matches the NOW-NUMBERED names
    "Pirata di Buggy 1/2/3" → 0 exact matches → resolveCombat returns null → LLM fallback.
    (Fix #1's unique naming is correct; the regression-of-convenience is that a bare base name
    can no longer match — but the real defect is upstream: the LLM authored a non-canonical
    target.)
- timestamp: 2026-06-02T18:55:00Z
  finding: |
    AUTHORITATIVE: events.md after the 18:53 spawns/initiative shows NO monster_hp_change and
    NO turn_advance from the attack. The master LEAKED the apply_event as PROSE — "Applica il
    danno: con id: \"pirata-buggy-1\" e delta: -8. Poi, chiama turn_advance." — instead of
    calling the tool. Nothing persisted. enforceResolvedNarration (which strips such leaked
    tool-prose) only runs when the resolver FIRED; on the null fallback it never ran.

REFINED ROOT CAUSE: the TO-HIT roll request is LLM-authored. qwen3 (a) puts a non-canonical
prose descriptor as the target (defeating server matching) and (b) leaks apply_event as text.
The DAMAGE request is already server-authored (resolveCombat builds "Tira XdY per danni a
<canonical name>", combat-resolver.ts:198) and is reliable — the asymmetry IS the bug. Combat
reliability requires removing the LLM from to-hit targeting too.

NEW FIX DIRECTION (user-approved 2026-06-02 — "to-hit lato server"):
1. Add a SERVER-AUTHORED TO-HIT step in route.ts on the attack-DECLARATION turn (gate:
   vaultMutations && encounter.active && detectCombatIntent(playerMessage) &&
   !isRollResult(playerMessage)). Parse the target from the PLAYER's message (reuse
   normalizeTargetName + matchMonster from combat-resolver.ts). If a unique LIVE monster
   matches, build the canonical to-hit request "Tira 1d20+<bonus> per attaccare <monster.name>"
   and ENFORCE it on the master's reply (strip the master's own "Tira … 1dN …" roll-request
   line(s) like enforceResolvedNarration does, then append the canonical one). This makes the
   roll-result label carry the canonical (numbered) name → resolveCombat matches reliably.
2. PC attack-bonus sourcing is a sub-problem to investigate: either read the PC stats, or
   preserve the master's proposed "+N" bonus while canonicalizing ONLY the target name in the
   roll request (smaller change). Pick the cleaner option; surface it only if it's a real fork.
3. Extend the leaked-tool-prose stripping (enforceResolvedNarration-style) to run on these
   combat declaration turns too, so "Applica il danno… chiama turn_advance" prose is removed
   even before the resolver fires. (Once to-hit resolves server-side, the resolver fires on the
   damage roll and enforceResolvedNarration cleans the rest — but the declaration turn needs
   its own guard.)
4. Verify end-to-end: declare attack on "pirata di buggy 1" → server emits canonical to-hit
   request → roll → resolveCombat HITs "Pirata di Buggy 1" → server damage request → damage
   roll → monster_hp_change + turn_advance → Phase-09 monster loop → monsters attack.
5. TDD: RED first. Likely test seams: a route-level or extracted helper unit test that, given a
   player declaration + active encounter with ["Pirata di Buggy 1/2/3"], produces a to-hit
   request whose label carries "Pirata di Buggy 1"; plus a resolveCombat test that the resulting
   label resolves to pirata-buggy-1. Keep resolveCombat pure.

## Re-test 2026-06-04 (gemma4:12b-mlx) + DECISION: server-owned to-hit request

Switched the One Piece campaign model qwen3:30b-a3b-instruct → gemma4:12b-mlx and re-tested.

Findings:
- gemma4 has BETTER tool obedience than qwen3: it EMITS the apply_event tool (e.g. monster_hp_change -8 at 09:00:47), narrates CLEANLY (no "Applica il danno…" prose leak), and uses the canonical numbered name. At 09:06:46, on an ACTIVE encounter, gemma4 correctly produced "Tira 1d20+4 per attaccare Pirata di Buggy 1" — the targeting fix works up to the to-hit roll.
- The repeated live failures were largely CONFOUNDED by the orchestrator's own combat_end resets: they left the encounter active:false, so resolveCombat's `if (encounter.active)` gate blocked, the monster_hp_change reducer skipped (`if (!active) return`), and the player kept rolling stale buttons against a dead encounter. (Operator-debugging lesson: reset to a clean ACTIVE encounter, never to inactive, when prepping a combat test.)
- gemma4 also tends to COLLAPSE to-hit+damage into one step (applies damage on the to-hit roll instead of asking for a separate damage roll). On an ACTIVE encounter the server resolver would intercept and impose the two-step + suppress gemma4's premature mutation — but the remaining LLM-owned seam (the to-hit REQUEST) is the fragility.

DECISION (user, 2026-06-04 — "basta test, ricostruisci"): stop model-swapping / live-testing; make the combat turn SERVER-OWNED. This is NOT a from-scratch rebuild — the server already owns damage resolution (resolveCombat), monster turns (Phase 09 loop), and unique naming. The ONLY remaining LLM-owned mechanic is the PC's to-hit roll REQUEST. Make that server-owned too + strip leaks on every combat turn.

### BUILD SPEC (TDD — RED first)
1. SERVER-OWNED TO-HIT REQUEST. In route.ts, on the player's combat-DECLARATION turn — gate: `vaultMutationsEnabled && encounter.active && detectCombatIntent(_playerMessage) && !isRollResult(_playerMessage)` AND the current turn actor `turnOrder[currentIdx]` is a PC (party member, not a monster) — REPLACE the current `canonicalizeToHitTarget` call (route.ts ~742, `6v-canonicalize` block) with an APPEND-AUTHORITATIVE step: parse target from `_playerMessage` → matchMonster → if matched, STRIP any LLM roll-request lines + leaked mechanics prose from finalText, then APPEND the server's canonical request `Tira 1d20+<bonus> per attaccare <monster.name>`. So the request is ALWAYS present + canonical regardless of what the LLM wrote (or didn't write). No match → leave finalText unchanged (fall through).
2. STRIP LEAKS ON EVERY COMBAT TURN. Run the leaked-mechanics strippers (EVENT_LABEL, EVENT_JSON, LEAKED_APPLY in combat-resolver.ts) on ALL combat-context turns (declaration, to-hit, damage), not only when resolveCombat fired — so qwen3/gemma4 mechanics-prose leaks never reach the player on a fall-through.
3. PC ATTACK BONUS. Pragmatic: PRESERVE the bonus the LLM proposed in its "Tira 1d20+N" line when present (gemma4 reliably writes "+4"); if the LLM wrote no roll request, default (e.g. +0, or read a character attack bonus if cheaply available). The bonus value is NOT the crux — guaranteed presence + canonical TARGET is. Document the choice.
4. KEEP intact: resolveCombat, the Phase-09 monster loop, unique naming (deduplicateMonsterNames), enforceResolvedNarration. Don't regress them.
5. The server-appended "Tira 1d20+N per attaccare <name>" renders as a roll button via roll-parser.ts `bareRe` (already handles this format) — NO client changes needed.
6. Extract a pure, unit-testable helper (e.g. `buildServerToHitRequest(finalText, playerMessage, encounter, opts)`); RED tests: appends canonical request + strips LLM roll-asks/leaks; falls through on no/ambiguous match; preserves bonus. Verify tsc clean + combat-resolver/projector/route suites green (known-baseline failures excepted).

Net effect: nothing combat-mechanical depends on the LLM anymore. The LLM only narrates; the server owns every roll request, every mutation, and turn advancement (PC + monster).

## Resolution

root_cause: |
  matchMonster() performed case-insensitive EXACT comparison of the roll-label
  target against encounter.monsters[].name. Two co-causes:
  (1) The master emitted roll labels with Italian articles + descriptor tails
      ("il Pirata di Buggy con il naso enorme") that never matched bare monster
      names ("Pirata di Buggy") → 0 matches → resolveCombat returned null.
  (2) Three monsters shared the identical name "Pirata di Buggy" in the tracker,
      so even a perfect bare-name reference matched 3 monsters → T-08-01 ambiguity
      → also null. The LLM fallback then applied an arbitrary -2 hp with no
      turn_advance, stalling the fight.

fix: |
  FIX #1 (commits d065851/5599cf2 — necessary but insufficient):
  1. deduplicateMonsterNames() added to projector.ts (exported, pure, idempotent):
     when ≥2 monsters share a base name, ALL are numbered ("X 1", "X 2", "X 3").
  2. normalizeTargetName() added to combat-resolver.ts: strips leading IT/EN
     articles + descriptor tails from roll-label targets.
  3. turn-directive.ts: added numbered-name reminder line.
  RESULT: combat.md now shows "Pirata di Buggy 1/2/3". But live re-test showed
  the TO-HIT request was still LLM-authored with a prose descriptor — so the
  roll label carried "il Pirata di Buggy con il naso enorme" → normalizeTargetName
  strips to "Pirata di Buggy" → matches NONE of the numbered names → still null.

  FIX #2 (this session — server-authoritative TO-HIT, Phase 08-03):
  4. canonicalizeToHitTarget() exported from combat-resolver.ts: pure helper that
     (a) parses the PLAYER message to find the intended target (reusing
         normalizeTargetName + matchMonster), (b) rewrites the master's
         "Tira 1d20+N per attaccare <prose>" line to the canonical numbered name,
         preserving the bonus +N, (c) strips leaked apply_event prose
         ("Applica il danno…", "chiama turn_advance", bare event labels, JSON).
     Falls through safely when no unique match, no Tira-d20 line, or encounter
     inactive. Never throws (D-05/D-10).
  5. route.ts wire-up: new 6v-canonicalize block in the _finalNarration else branch
     (gate: vaultMutationsEnabled && detectCombatIntent && !isRollResult). Reads
     events.md post-LLM, calls canonicalizeToHitTarget on the LLM finalText before
     persistence. The resulting roll button carries "Pirata di Buggy 1" →
     resolveCombat matches → server handles hit/miss/damage/turn_advance reliably.

  PC ATTACK BONUS CHOICE: canonicalizeToHitTarget extracts the +N bonus from the
  LLM's "Tira 1d20+N" line when present (gemma4 reliably writes it). If the LLM
  wrote no roll request, defaults to +0. The bonus is NOT the reliability crux —
  canonical target name is. Bonus precision can be improved later via PC stat lookup
  without touching the server-ownership invariant.

verification: |
  FIX #1 (d065851/5599cf2):
  - projector.test.ts: 151/151 passed (6 new RED→GREEN)
  - combat-resolver.test.ts: 30/30 passed (6 new RED→GREEN)
  - turn-directive.test.ts: 44/44 passed (1 constant updated)

  FIX #2 (commits b4b14a1/9fdfccd — 2026-06-04):
  - pnpm tsc --noEmit → clean (0 errors)
  - combat-resolver.test.ts: 38/38 passed (8 new RED→GREEN for canonicalizeToHitTarget)
  - Full node suite: 3551 passed, 6 known-baseline failures (game-client-begin-stuck,
    scene-image-coalesce, tts-coalesce, job-claims, preferences-local, applicator/gp-stack)
    — no regressions introduced.

files_changed:
  - src/app/api/sessions/[id]/turn/combat-resolver.ts (canonicalizeToHitTarget export)
  - src/app/api/sessions/[id]/turn/route.ts (6v-canonicalize wire-up in _finalNarration)
  - tests/app/api/sessions/[id]/turn/combat-resolver.test.ts (8 new RED→GREEN tests)

residual_caveat: |
  canonicalizeToHitTarget parses the PLAYER message to extract the target.
  If the player uses a highly ambiguous reference that does not uniquely match
  any live monster (e.g. "attacco qualcuno"), matchMonster returns null and the
  function falls through to the LLM's unmodified text — resolveCombat will then
  return null on the roll-result and the LLM fallback engages (same as before fix #2,
  no worse). The common case — player says "attacco pirata di buggy 1" with numbered
  monsters in the encounter — is now fully server-authoritative and reliable.
  If the player does not include ANY attack verb (pure narrative context switch),
  detectCombatIntent returns false and the 6v-canonicalize block is skipped entirely.

## Fix #3 — server-OWNED to-hit (Phase 08-04, 2026-06-04) — FINAL

Live re-tests with BOTH qwen3:30b AND gemma4:12b-mlx confirmed the model is not the
fix: qwen3 leaked mechanics as prose; gemma4 has better tool obedience but collapses
to-hit+damage and omits turn_advance. Decision (user): make the to-hit request fully
server-OWNED so nothing combat-mechanical depends on the LLM.

Changes (commits 0782f52 RED → 8252224 GREEN):
- combat-resolver.ts `canonicalizeToHitTarget` is now APPEND-AUTHORITATIVE: when the
  model writes no parseable "Tira … 1d20 … per attaccare …" line, the server APPENDS
  a canonical "Tira 1d20 per attaccare <name>" so the player always gets a resolvable
  roll button (previously: returned finalText unchanged → no button → stuck). When the
  model DID write a line, the target is still canonicalized and the bonus preserved.
- new `stripLeakedMechanics()` (combat-resolver.ts): strips leaked apply_event prose /
  event labels / JSON on any combat turn where the resolver did not fire.
- route.ts 6v block: PC attack declaration → canonicalizeToHitTarget; any other
  active-combat turn (incl. an unmatched roll-result) → stripLeakedMechanics.

verification (08-04): combat-resolver 41/41; vault+sessions sweep 1158 passed, 1
known-baseline failure (applicator/gp-stack, pre-existing, unrelated); tsc --noEmit
clean. resolveCombat, Phase-09 monster loop, deduplicateMonsterNames, and
enforceResolvedNarration unchanged.

files_changed (08-04):
- src/app/api/sessions/[id]/turn/combat-resolver.ts (append-authoritative + stripLeakedMechanics)
- src/app/api/sessions/[id]/turn/route.ts (6v block)
- tests/app/api/sessions/[id]/turn/combat-resolver.test.ts (+4 tests, 41 total)

operator note: live verification pending on a CLEAN ACTIVE encounter (do NOT reset to
inactive — that desyncs the conversation from the encounter state and confounds the test).
Net: the LLM only narrates; the server owns every roll request, mutation, and turn
advancement (PC + monster). Phase 07-04 operator smoke can re-run once verified.
