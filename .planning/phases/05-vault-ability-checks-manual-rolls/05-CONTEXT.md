# Phase 5: Vault Ability Checks (Manual Rolls) - Context

**Gathered:** 2026-05-28
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-28-vault-ability-checks-design.md`)

<domain>
## Phase Boundary

Make the vault-path Dungeon Master **call for ability checks, saving throws, and
attack/damage rolls** using the existing manual-roll surface. Prompt + setting
only: add a `manualRolls`-gated `## Rolls` block to `buildVaultSystemPrompt` that
instructs the master to write roll requests in prose the client parser already
recognizes, so the existing 🎲 button flow renders and resolves. Wire the
`manualRolls` + `showDifficultyNumbers` preferences into the builder at the turn
route's vault branch. Turn on `manualRolls` for the One Piece campaign.

This is **piece B** of the 4-part "game-mechanics on the vault path" effort
(A: anti-railroading prompt — shipped as Phase 04; B: this; C: dice system —
satisfied here by *reusing* the existing dice UI rather than building a new one;
D: combat state machine — a separate later phase). Combat depends on this piece
(attacks are rolls), which is why rolls ship first.

**Out of this phase:** auto-roll / server-side RNG; any change to the roll
parser, the client roll components, or the engine; combat state / initiative /
monster spawning (piece D).
</domain>

<decisions>
## Implementation Decisions

### Approach (LOCKED — operator chose "A: reuse manual-roll block")
- **Manual rolls, not auto-roll.** The player taps the 🎲 button. The vault path
  has no rolling tools and the user explicitly wants to make the rolls
  ("voglio fare io i tiri"). No new tool, no new event type, no engine bridge.
- **Prompt + setting only.** ZERO changes to `src/lib/roll-parser.ts`, the client
  components (`narrative-pane.tsx`, `roll-request-*.tsx`), or the engine.

### Gating (LOCKED)
- The `## Rolls` block is emitted ONLY when `manualRolls === true` — analogous to
  how `applyEventMention` is gated on `vaultMutations`. Gated on `manualRolls`
  ALONE, independent of `vaultMutations`.
- A vault campaign with `manualRolls=false` keeps today's behavior (no rolls) —
  documented limitation, not a regression.

### Inputs & wiring (LOCKED)
- Add `manualRolls?: boolean` and `showDifficultyNumbers?: boolean` to
  `VaultPromptInput`.
- Wire them at `src/app/api/sessions/[id]/turn/route.ts:296-309` from the
  already-resolved `userPrefs.manualRolls` and `userPrefs.showDifficultyNumbers`
  (the baked branch already passes `showDifficultyNumbers` at line 625).

### Language- and DC-awareness (LOCKED)
- Respects `input.language`: Italian campaigns get Italian phrasings + an
  anti-mixing rule ("never `Roll una prova di Perception`"); otherwise English.
- Respects `showDifficultyNumbers`: when false, omit the numeric DC (blind rolls)
  and add a hidden-difficulty line. Mirrors `buildManualRollsRule({ language,
  hideDC })`.

### Resolution semantics (LOCKED)
- Ability check / saving throw → the button rolls a bare `d20`. The master reads
  the character's relevant modifier from their sheet in the vault, adds it to the
  authoritative bold number, then compares to the DC.
- Attack / damage → the bonus is embedded in the formula, so the bold number is
  the final total — used as-is.
- The bold number in `I rolled **<TOTAL>** for <label>` is AUTHORITATIVE — never
  recompute, re-roll, or invent it.

### Block placement (LOCKED)
- Insert the block in the `lines` array AFTER the apply_event mention / character
  roster section and BEFORE the existing `Respond in language:` clause. (Any fixed
  deterministic position; this keeps mechanics instructions grouped.)

### REQ-022 byte-stability (LOCKED — must preserve)
- The block is deterministic given its inputs (`manualRolls`, `language`,
  `showDifficultyNumbers`). No `Date.now` / `Math.random` / `process.env`.
- The read-only default (`manualRolls` undefined/false) produces byte-identical
  output → the existing locked-snapshot hash
  `60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` (for
  `{vaultRoot:'data/vault', campaignId:'test-camp', toolCount:3}`) MUST NOT
  change. This is the safety check that the block is truly additive/gated.

### Exact block content (LOCKED — from spec §"The prompt block")
Canonical case `manualRolls:true, language:'it', showDifficultyNumbers:true`:
```
## Rolls

When the outcome of an action is uncertain AND failure would be interesting,
call for a roll. Do NOT roll for trivial actions (they just succeed) or
impossible ones (they just fail). Difficulty anchors: Easy 10, Medium 15,
Hard 20.

The app turns each roll request you write into a tap-to-roll button for the
player; the result returns as the next player message in the exact form
"I rolled **<TOTAL>** for <label>." The bold number is AUTHORITATIVE — never
recompute or re-roll it, and never invent a result that was not sent. If no
roll message arrived, ask again; do not fabricate one.

- Ability check or saving throw: the button rolls a bare d20. Read the
  character's relevant modifier from their sheet in the vault, add it to the
  bold number, then compare to the DC.
- Attack or damage: put the bonus in the formula, so the bold number is the
  final total — use it as-is.

Write roll requests using these phrasings (the in-app parser is tuned for
them; in Italian use the Italian verb and skill names — never mix languages
like "Roll una prova di Perception" or the button will not appear):
- "Tira una prova di Percezione (CD 15)."   (prova di abilità)
- "Tira un TS Destrezza (CD 14)."           (tiro salvezza)
- "Tira 1d20+<bonus> per attaccare <NOME DEL BERSAGLIO> (CA <ca>)."  (attacco)
- "Tira 2d6+<bonus> danni <tipo>."          (danni)
```
English variant (`language` absent / not `'it'`): same prose; anti-mixing clause
phrased for English; examples `"Roll a DC 15 Perception check." / "Roll a DC 14
Dexterity save." / "Roll 1d20+<bonus> to attack <TARGET NAME> (AC <ac>)." /
"Roll 2d6+<bonus> <type> damage."`.
Hidden-difficulty variant (`showDifficultyNumbers:false`): drop `(CD N)`/`DC N`
from every example and append: *"Hidden difficulty is ON: do NOT write the
numeric DC/AC in the roll request … You still know the DC internally and use it
to judge the result."*

### Claude's Discretion
- Exact wording polish is fine AS LONG AS these survive (the tests assert them):
  the `## Rolls` header; "uncertain"; "Easy 10, Medium 15, Hard 20";
  "AUTHORITATIVE"; the bare-d20 + "add … modifier" rule for checks/saves; the
  four example phrasings per language; the anti-mixing clause; and the
  hidden-difficulty omission behavior.
- Whether to inline the block in the `lines` array or extract a module-level
  helper (both preserve byte-stability) — implementer's choice.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec
- `docs/superpowers/specs/2026-05-28-vault-ability-checks-design.md` — the full design (this CONTEXT derives from it).

### Code to modify
- `src/ai/master/vault/prompt-builder.ts` — `buildVaultSystemPrompt` (insertion point) + `VaultPromptInput` (add `manualRolls?`, `showDifficultyNumbers?`) + `hashVaultPrompt` (byte-stability) + existing `applyEventMention` / character-roster blocks for the gating/style pattern.
- `src/app/api/sessions/[id]/turn/route.ts` — vault branch lines 296-309 (the `buildVaultSystemPrompt({...})` call); add `manualRolls` + `showDifficultyNumbers` from `userPrefs`. Line 625 shows the baked branch already passing `showDifficultyNumbers`.
- `tests/ai/master/vault/prompt-builder.test.ts` — extend REQ-022 stability + content + locked-snapshot tests (read-only hash stays unchanged; add gated content assertions for it/en + hideDC; assert ABSENT when `manualRolls` false/undefined).

### Reference (do NOT modify — pattern / proven-wording source)
- `src/ai/master/system-prompt.ts` lines ~1710-1789 — `buildManualRollsRule({ hideDC, language })`: the proven, parser-tuned content + the authoritative-number contract this block distills. Drop its baked-only "do not call the rolling tools" sentence (vault has no such tools).
- `src/lib/roll-parser.ts` — `parseRollRequests`: patterns #1a/#1b (tagged/bare formula, IT+EN), #2/#3 (English check/save), #4/#5 (Italian check/save → bare `1d20`). The block's phrasings MUST match these.
- `src/components/game/narrative-pane.tsx` line 425 — roll buttons gated on `manualRolls && !disabled ? parseRollRequests(...) : []` (backend-agnostic). `src/components/game/roll-request-group.tsx` — button group.
- `src/lib/preferences.ts` — `manualRolls` default `false` (:245), `showDifficultyNumbers` default `true` (:256); both resolved onto `userPrefs`.
</canonical_refs>

<specifics>
## Specific Ideas

- Cardinal assumption (VERIFIED during brainstorming): the 🎲 button flow is 100%
  client-side and backend-agnostic — it renders whenever `manualRolls=true`
  regardless of `MASTER_BACKEND`. The parser already handles natural Italian
  ("Tira una prova di Percezione (CD 15)", "Tira un TS Destrezza (CD 14)") and
  English, plus formula-based attacks/damage.
- One Piece is the smoke campaign (gemma4, Italian). After shipping, set
  `manualRolls=true` on it (existing settings toggle or one-off DB update) and
  smoke: "esamino con attenzione la stanza" → master writes "Tira una prova di
  Percezione (CD 15)" + a 🎲 button appears.
- Same automated-vs-smoke split as Phase 04: unit tests verify the prompt
  CONTAINS the discipline + is gated/byte-stable; model obedience is observed in
  the operator smoke, not unit-tested.
</specifics>

<deferred>
## Deferred Ideas

- Auto-roll / server-side RNG on the vault path (operator chose manual).
- Combat state machine, initiative, monster spawning, combat-tracker on the vault
  path — piece D, a separate later phase.
- History-anchoring hardening (per-turn POV/roll reminder) if a weak model keeps
  skipping rolls on a long history — One Piece runs on the steerable gemma4, so
  out of scope here unless observed.
- Modifier-precision hardening for bare-d20 checks (local models may add the
  wrong/no modifier at resolution) — accepted for v1; the reported problem is the
  master *not asking* for rolls.
</deferred>

---

*Phase: 05-vault-ability-checks-manual-rolls*
*Context gathered: 2026-05-28 via PRD Express Path*
