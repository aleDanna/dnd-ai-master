---
status: resolved
trigger: "Phase 07-04 operator smoke: combat started + monsters spawned, but the player's attack applied no proper damage and the enemies never took their turn."
created: "2026-06-01T12:15:00Z"
updated: "2026-06-01T14:30:00Z"
phase: "07-04"
key_files:
  - src/app/api/sessions/[id]/turn/combat-resolver.ts
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
  1. deduplicateMonsterNames() added to projector.ts (exported, pure, idempotent):
     when ≥2 monsters share a base name, ALL are numbered ("X 1", "X 2", "X 3");
     a lone unique-base-name monster stays unnumbered. Called at the end of the
     monster_spawn reducer in applyEncounterEvent so every replay yields
     deterministically unique names in the tracker. Ids untouched.
  2. normalizeTargetName() added to combat-resolver.ts: strips leading IT/EN
     articles (il/lo/la/l'/i/gli/le/the/a/an) and descriptor tails
     (con/with/comma) from the roll-label target before the exact-name lookup.
     T-08-01 (strict 0-or->1→null) unchanged.
  3. turn-directive.ts (manualRolls path, NOT hash-locked): added a reminder line
     instructing the master to use the exact tracker name, number included, in
     attack-roll requests — reduces the probability of bare-base-name references.

verification: |
  - pnpm tsc --noEmit → clean (0 errors)
  - tests/ai/master/vault/projector.test.ts: 151/151 passed (6 new RED→GREEN)
  - tests/app/api/sessions/[id]/turn/combat-resolver.test.ts: 30/30 passed (6 new RED→GREEN)
  - tests/ai/master/vault/turn-directive.test.ts: 44/44 passed (1 constant updated)
  - Full node suite: 3365 passed, 4 known-baseline failures (applicator, scene-image-coalesce,
    tts-coalesce, preferences-local) — no regressions introduced.

files_changed:
  - src/ai/master/vault/projector.ts (deduplicateMonsterNames export + monster_spawn wiring)
  - src/app/api/sessions/[id]/turn/combat-resolver.ts (normalizeTargetName + matchMonster update)
  - src/ai/master/vault/turn-directive.ts (numbered-name reminder in manualRolls section)
  - tests/ai/master/vault/projector.test.ts (6 new RED→GREEN tests for deduplicateMonsterNames)
  - tests/app/api/sessions/[id]/turn/combat-resolver.test.ts (6 new RED→GREEN tests for article normalization)
  - tests/ai/master/vault/turn-directive.test.ts (PHASE_08_GENERAL constant updated)

residual_caveat: |
  The directive reinforcement improves prompt reliability but cannot guarantee
  100% compliance from the local model (qwen3:30b-a3b-instruct). If the master
  still uses a bare base name or a prose descriptor instead of the exact numbered
  name, normalizeTargetName strips the article but the base name ("Pirata di
  Buggy") will match NONE of the numbered names ("Pirata di Buggy 1/2/3") →
  resolveCombat still returns null → LLM fallback. This is acceptable: the
  server-side guarantee covers the common case where the master follows the
  directive; the unreliable case degrades gracefully to the pre-existing LLM path
  (now no worse than before this fix).
