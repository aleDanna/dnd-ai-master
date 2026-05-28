# Phase 04: Vault Anti-Railroading Prompt - Context

**Gathered:** 2026-05-28
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-28-vault-anti-railroading-design.md`)

<domain>
## Phase Boundary

Prompt-only fix: the vault-path Dungeon Master must stop railroading the player
character. Add a static `## Your role` block to `buildVaultSystemPrompt` so the
master narrates the world (environment, NPCs, consequences of declared actions)
in second person but never invents the PC's actions, dialogue, decisions, or
outcomes. Single file change (`src/ai/master/vault/prompt-builder.ts`) + its
test. No new tool, no turn-advance change, no other files.

This is piece A of 4 ("game-mechanics on the vault path"). Pieces B (roll
discipline + action→event), C (dice system), D (combat state machine) are
explicitly OUT of scope — future phases.
</domain>

<decisions>
## Implementation Decisions

### Prompt block placement & lifecycle (LOCKED)
- Insert a static `## Your role` block in the `lines` array of
  `buildVaultSystemPrompt`, between the DM identity line ("You are an experienced
  D&D 5e Dungeon Master.") and the `## Knowledge layout` section.
- The block is UNCONDITIONAL — present on every vault turn, both
  `vaultMutations: true` and `vaultMutations: false`. (Unlike the `applyEventMention`
  which is conditional on vaultMutations.)

### Strictness (LOCKED — operator chose "soft")
- The player decides their character's actions, words, intentions.
- The master narrates the OUTCOME of an action the player declared — never
  invents actions, dialogue, decisions, or successes not declared.
- Brief connective body language for the PC IS allowed ("ti volti di scatto",
  "stringi la presa") but NEVER a decision, a line of dialogue, or an undeclared outcome.

### Multiplayer (LOCKED — prompt-only)
- The vault path already auto-advances turns via `computeTurnAdvance` +
  `detectAddressee` (turn route vault branch). No `set_current_player` tool needed.
- The block instructs: never speak/decide for ANY PG; close the beat addressing
  the next character BY NAME so `detectAddressee` hands over the turn.

### Verbosity (LOCKED — Approach 2: concise + one worked example)
- Concise rules + ONE worked Italian example anchoring weak models, because both
  gemma4 (8B) and qwen3 (30B) railroaded on the abstract minimal prompt.

### REQ-022 byte-stability (LOCKED — must preserve)
- The block is static/deterministic → 1000 builds with identical input must
  still produce exactly 1 unique SHA256.
- No `Date.now` / `Math.random` / `process.env` introduced.
- The block does NOT vary by `input.language` (only the existing "Respond in
  language:" clause does) — same bytes for every campaign.

### Exact block content (LOCKED — from spec §"The prompt block")
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

### Claude's Discretion
- Exact wording polish of the block is fine as long as the LOCKED semantics +
  the GOOD/BAD markers + "second person" + "never invent actions" survive
  (the tests assert these tokens).
- Whether to extract the block as a module-level `const` or inline it in the
  `lines` array — implementer's choice (both preserve byte-stability).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec
- `docs/superpowers/specs/2026-05-28-vault-anti-railroading-design.md` — the full design (this CONTEXT is derived from it).

### Code to modify
- `src/ai/master/vault/prompt-builder.ts` — `buildVaultSystemPrompt` (insertion point) + `hashVaultPrompt` (byte-stability) + the existing `applyEventMention` / character-roster blocks for style.
- `tests/ai/master/vault/prompt-builder.test.ts` — existing REQ-022 stability + content + locked-snapshot tests to extend/update.

### Reference (do NOT modify — pattern source)
- `src/ai/master/system-prompt.ts` lines ~1245, ~1853 — the baked path's anti-railroading discipline ("NEVER voice another PG", "PCs are controlled by their players") — the proven wording this block distills.
- `src/multiplayer/turn-advance.ts` — `computeTurnAdvance` + `detectAddressee` (already automatic; the block's "address by name" guidance feeds detectAddressee).
</canonical_refs>

<specifics>
## Specific Ideas

- The worked example uses the real One Piece case ("provo ad attaccarlo") that
  the gemma4 experiment captured railroading on — anchors the model on the
  actual failure.
- Single-player campaigns (party ≤ 1, e.g. One Piece): the multiplayer bullet is
  harmless — `computeTurnAdvance` returns `skip` for party ≤ 1.
</specifics>

<deferred>
## Deferred Ideas

- Piece B — roll discipline + action→apply_event translation (Phase 05 candidate).
- Piece C — dice/roll system (d20, manualRolls flow) on the vault path (Phase 06).
- Piece D — combat state machine (initiative, combat_actors, combat-tracker UI)
  on the vault path (Phase 07).
- Tightening soft→strict body-language rule if models over-use the allowance
  (one-line prompt edit, only if observed).
</deferred>

---

*Phase: 04-vault-anti-railroading-prompt*
*Context gathered: 2026-05-28 via PRD Express Path*
