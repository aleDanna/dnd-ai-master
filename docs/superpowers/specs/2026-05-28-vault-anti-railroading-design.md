# Design — Phase 04: Anti-Railroading Vault Prompt

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — ready for implementation plan
**Type:** Production feature (vault path game-mechanics, piece A of 4).

## Purpose

The gemma4-vs-qwen3 experiment (2026-05-28) revealed via A/B control that the
vault path's Dungeon Master **railroads the player character**: both models
narrate the PC's actions, words, and outcomes instead of letting the player
declare them ("provo ad attaccarlo" → master writes "Luffy si lancia... GUM GUM
BARRAGE!"). The cause is the vault system prompt being minimal — it lacks the
anti-railroading discipline the baked path's system prompt carries ("PCs are
controlled by their players, NOT by you").

This is **piece A** of a 4-part "game-mechanics on the vault path" effort
(A: anti-railroading prompt; B: roll-discipline + action→event; C: dice system;
D: combat state machine). A is the smallest and highest-value piece — it fixes
the most jarring problem (the master playing the player's character) with a
prompt-only change. B/C/D become Phase 05/06/07 with their own spec→plan→execute
cycles.

## Scope decisions (from brainstorming)

- **Single + multiplayer**, prompt-only. The vault path already advances the
  turn automatically (`computeTurnAdvance` + `detectAddressee` in the turn
  route's vault branch, lines 408-419) — round-robin + addressee detection from
  the master's prose. No `set_current_player` tool is needed; the model just
  closes its beat addressing the next character by name and the existing
  machinery hands over the turn.
- **Soft strictness**: the master MAY add brief connective body language for the
  PC ("ti volti", "stringi la presa") but NEVER a decision, line of dialogue, or
  outcome the player did not declare. It MUST still narrate the consequences of
  actions the player DID declare (that's the master's job + drives apply_event).
- **Concise + one worked example** prompt block (Approach 2). The worked example
  is what enforces the rule on weak models — both gemma4 (8B) and qwen3 (30B)
  ignored the abstract minimal prompt; the baked path uses worked examples for
  exactly this reason.

## Architecture

Single file: `src/ai/master/vault/prompt-builder.ts` (`buildVaultSystemPrompt`).
Insert a static `## Your role` block immediately after the DM identity line and
before `## Knowledge layout`. The block is **unconditional** — present on every
vault turn regardless of `vaultMutations`. No new tool, no turn-advance change.

The block is **static and deterministic** → preserves REQ-022 byte-stability
(1000 builds → 1 hash). It increases the prompt length by a constant ~14 lines
(~700 bytes), keeping the vault prompt well under 2KB.

## The prompt block (exact content)

```
## Your role

Narrate in second person ("you …"). You control the world — environment,
NPCs, and the CONSEQUENCES of what the player declares. You do NOT control
the player's character.

- The player decides their character's actions, words, and intentions.
  Narrate the OUTCOME of an action the player stated — never invent actions,
  dialogue, decisions, or successes the player did not declare.
- Brief connective body language is allowed ("ti volti di scatto",
  "stringi la presa") but NEVER a decision, a line of dialogue, or an
  outcome the player didn't declare.
- Multiplayer: never speak or decide for ANY player character. When another
  character should act next, close your beat by addressing them BY NAME —
  the system hands them the turn.
- End with an open cue ("Che fai?"). Never a numbered menu of options.

Example — player writes "provo ad attaccarlo":
  GOOD: "Ti lanci in avanti; la tua lama trova un varco nella guardia
        del nemico, che barcolla con un grugnito."
  BAD:  "Luffy si lancia e decide di colpire al fianco. 'GUM GUM!' grida,
        mettendo a segno il colpo." (invents the PC's action, words, outcome)
```

The block is written in English (consistent with the rest of the vault prompt)
with the worked example in Italian — anchoring the model on the real One Piece
case and on the language the campaign plays in. The block is the same bytes for
every campaign (it does NOT vary by `input.language` — only the existing
"Respond in language:" clause does that), so it does not add a per-language hash
dimension.

## Components

| Unit | Responsibility | Change |
|---|---|---|
| `buildVaultSystemPrompt` (prompt-builder.ts) | assemble the vault system prompt | Insert the static `## Your role` block in the `lines` array between the DM identity line and `## Knowledge layout` |
| `tests/ai/master/vault/prompt-builder.test.ts` | byte-stability + content + sensitivity | Add content assertions for the new block; update any test that hardcodes the prompt's expected hash or a locked-snapshot string |

## Testing

1. **REQ-022 byte-stability** (existing test, must still pass): 1000 builds with
   identical input → exactly 1 unique SHA256. The block is deterministic, so this
   holds.
2. **New content assertions**:
   - prompt contains `## Your role`
   - contains "second person" and "never invent actions"
   - contains the `GOOD:` and `BAD:` worked-example markers
   - the block appears with BOTH `vaultMutations: true` and `vaultMutations: false`
     (unconditional)
   - contains "addressing them BY NAME" (so `detectAddressee` has material)
3. **Locked-snapshot update**: the Phase 01 "matches the locked snapshot for a
   fixed input" test (if present) and any hash-divergence tests need their
   expected values regenerated — the prompt is intentionally longer now.

## Error handling / edge cases

- The block is static — no input can make it throw or vary (REQ-022 purity
  preserved: no Date.now / Math.random / process.env).
- Single-player campaigns (party.length === 1, e.g. One Piece): the multiplayer
  bullet is harmless (no other PC to address) — `computeTurnAdvance` returns
  `skip` for party ≤ 1, so the "address by name" guidance simply doesn't fire.
- The soft-strictness body-language allowance is a known, accepted railroading
  risk surface (the operator chose it over strict); if models over-use it, a
  future tightening is a one-line prompt edit.

## Non-goals (explicit)

- Does NOT touch turn-advance / detectAddressee (already automatic).
- Does NOT add a tool (vault surface stays at 4).
- Does NOT implement dice rolls (#2 / piece C) or combat state machine
  (#1 / piece D) — those are later phases.
- Does NOT change `fetchOllamaModels` or any other file.

## Verification of success

After this ships, re-running the One Piece smoke prompt "provo ad attaccarlo"
on gemma4 (or qwen3) should produce narration that stops at the consequence and
hands agency back ("...che fai?") instead of inventing the PC's full action +
dialogue + outcome. This is a qualitative check by the operator; the automated
tests verify the prompt CONTAINS the discipline, not that the model OBEYS it
(model obedience is observed in the smoke, not unit-tested).
