# Design — Vault Ability Checks (Manual Rolls on the Vault Path)

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — ready for implementation plan
**Type:** Production feature (vault path game-mechanics, piece B of 4).

## Purpose

On the vault backend the Dungeon Master never asks the player to roll. The
2026-05-28 gemma4/qwen3 session surfaced it directly: *"Non mi fa fare dei tiri
di abilità."* The cause is structural — the vault system prompt
(`buildVaultSystemPrompt`) says nothing about rolls, and the vault tool surface
has no rolling tools (only `read_vault_multi`, `list_vault`, `end_turn`,
`apply_event`). So the master just narrates outcomes and never invokes a check.

The baked path solves this two ways: *auto-roll* (the master calls
`ability_check` / `saving_throw` / `make_attack`, server RNG) and *manual-roll*
(`manualRolls=true`: the master writes the roll request in prose, the client
parses it into a tap-to-roll 🎲 button, the player rolls, the result returns as
the next player message). The manual-roll flow is **purely client-side + prompt**
— it has no server, DB, or engine dependency, and the same `NarrativePane`
renders it for both backends.

This piece makes the vault master **call for ability checks and saving throws
(and attack/damage rolls) using the existing manual-roll surface**, with a
prompt-only change that mirrors the proven baked `buildManualRollsRule`. It is
**piece B** of the 4-part "game-mechanics on the vault path" effort
(A: anti-railroading prompt — shipped as Phase 04; B: this; C: dice system —
satisfied here by *reusing* the existing dice UI rather than building a new one;
D: combat state machine — a later, larger phase). The user chose to do rolls
before combat; combat (initiative/turn state) explicitly depends on this piece
because attacks are rolls.

## Scope decisions (from brainstorming)

- **Manual rolls, not auto-roll** (operator chose Approach A). The user wants to
  make the rolls themselves ("voglio fare io i tiri"). The vault path has no
  rolling tools anyway, and the manual-roll client flow is free to reuse. No new
  tool, no new event type, no engine bridge.
- **Prompt + setting only.** Zero changes to the roll parser
  (`src/lib/roll-parser.ts`), the client components (`narrative-pane.tsx`,
  `roll-request-*.tsx`), or the engine. The parser already supports natural
  Italian ("Tira una prova di Percezione (CD 15)", "Tira un TS Destrezza (CD
  14)") and English, plus formula-based attacks/damage.
- **Gated on `manualRolls`.** The roll block is emitted only when
  `manualRolls === true` (analogous to how `applyEventMention` is gated on
  `vaultMutations`). A vault campaign with `manualRolls=false` keeps today's
  behavior (no rolls) — a documented limitation, not a regression. One Piece gets
  `manualRolls` turned on (toggle already exists in campaign settings).
- **Language- and DC-aware.** The block respects `input.language` (Italian
  campaigns get Italian phrasings + an anti-mixing rule) and
  `showDifficultyNumbers` (when false, omit the numeric DC → blind rolls). This
  matches the proven baked `buildManualRollsRule({ language, hideDC })`.
- **Reuse proven content, self-contained.** The block's wording is adapted from
  `buildManualRollsRule` but lives in the vault builder and drops the baked-only
  sentence about not calling rolling tools (the vault path has none). The two
  builders stay parallel (same precedent as Phase 04, which re-wrote the
  anti-railroading wording in the vault builder instead of importing from
  `system-prompt.ts`).

## Architecture

Single source file: `src/ai/master/vault/prompt-builder.ts`
(`buildVaultSystemPrompt`). Add two optional inputs to `VaultPromptInput` —
`manualRolls?: boolean` and `showDifficultyNumbers?: boolean` — and emit a
`## Rolls` block when `manualRolls === true`. Wire the two inputs at the single
call site (`src/app/api/sessions/[id]/turn/route.ts:296-309`) from the
already-resolved `userPrefs.manualRolls` and `userPrefs.showDifficultyNumbers`
(the baked branch already passes `showDifficultyNumbers` at line 625).

The block is **deterministic given its inputs** → REQ-022 byte-stability holds
(same input → same bytes → 1 hash over 1000 builds). It legitimately *varies* by
`manualRolls`, `language`, and `showDifficultyNumbers` — those are inputs, so
byte-stability is per-input, exactly like the existing `vaultMutations` /
`language` dimensions. No `Date.now` / `Math.random` / `process.env`.

**Placement in the `lines` array:** after the apply_event mention / character
roster section and before the existing `Respond in language:` clause. (Any fixed
deterministic position is fine; this one keeps the mechanics instructions grouped
after the tool protocol.)

## The prompt block (exact content)

Canonical case — `manualRolls: true`, `language: 'it'`, `showDifficultyNumbers:
true`:

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

**English variant** (`language` absent or not `'it'`) — same prose, with the
last paragraph's anti-mixing clause phrased for English and these examples:

```
Write roll requests using these phrasings (the in-app parser is tuned for
them; keep the verb and skill names in the same language as your narration):
- "Roll a DC 15 Perception check."
- "Roll a DC 14 Dexterity save."
- "Roll 1d20+<bonus> to attack <TARGET NAME> (AC <ac>)."
- "Roll 2d6+<bonus> <type> damage."
```

**Hidden-difficulty variant** (`showDifficultyNumbers: false`): drop the `(CD
N)` / `DC N` from every example and append one line:

```
Hidden difficulty is ON: do NOT write the numeric DC/AC in the roll request
(e.g. "Tira una prova di Percezione." with no CD). You still know the DC
internally and use it to judge the result.
```

Exact wording polish is at the implementer's discretion **as long as** these
survive (the tests assert them): the `## Rolls` header; "uncertain"; the
"Easy 10, Medium 15, Hard 20" anchors; "AUTHORITATIVE"; the bare-d20 +
"add ... modifier" rule for checks/saves; the four example phrasings per
language; the anti-mixing clause; and the hidden-difficulty omission behavior.

## Components

| Unit | Responsibility | Change |
|---|---|---|
| `buildVaultSystemPrompt` (prompt-builder.ts) | assemble the vault system prompt | Add `manualRolls?` + `showDifficultyNumbers?` to `VaultPromptInput`; emit the `## Rolls` block when `manualRolls===true`, language/hideDC-aware, at a fixed position |
| turn route vault branch (`route.ts:296-309`) | build the prompt per turn | Pass `manualRolls: userPrefs.manualRolls` and `showDifficultyNumbers: userPrefs.showDifficultyNumbers` |
| `tests/ai/master/vault/prompt-builder.test.ts` | byte-stability + content + sensitivity | Add content assertions for the block; assert it is ABSENT when `manualRolls` is false/undefined; cover it/en + hideDC variants; regenerate the locked-snapshot hash (the read-only default — `manualRolls` undefined — stays byte-identical, so the existing hash is UNCHANGED) |
| One Piece campaign settings | enable manual rolls | Set `manualRolls=true` (data change, via existing settings toggle / one-off script) |

## Testing

1. **REQ-022 byte-stability** (existing test must still pass): 1000 builds with
   identical input → exactly 1 SHA256, for each input combination.
2. **Read-only default unchanged**: with `manualRolls` undefined/false the output
   is byte-identical to today → the existing locked-snapshot hash
   (`60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e` for
   `{vaultRoot:'data/vault', campaignId:'test-camp', toolCount:3}`) does NOT
   change. This is the safety check that the block is truly additive/gated.
3. **New content assertions** — the block is gated on `manualRolls` ALONE,
   independent of `vaultMutations`, so the primary content test uses
   `{manualRolls:true, toolCount:3}` (vaultMutations undefined, valid per the
   builder's toolCount assertion) to prove that independence:
   - contains `## Rolls`, "uncertain", "Easy 10, Medium 15, Hard 20",
     "AUTHORITATIVE"
   - check/save rule present ("bare d20" + "modifier")
   - `language:'it'` → contains "Tira una prova di Percezione (CD 15)" and the
     anti-mixing clause; `language` default → contains "Roll a DC 15 Perception
     check."
   - `showDifficultyNumbers:false` → examples contain no "CD 15"/"DC 15" and the
     hidden-difficulty line is present
   - block ABSENT when `manualRolls` false/undefined
4. **Operator smoke** on One Piece (gemma4, `manualRolls=true`): "esamino con
   attenzione la stanza" → the master writes "Tira una prova di Percezione (CD
   15)" (or similar) and a 🎲 button appears; tapping it sends "I rolled **N**
   …", and the master narrates the outcome using N + the sheet modifier.

## Error handling / edge cases

- **`manualRolls=false` on a vault campaign**: no roll block → current behavior
  (the master narrates without rolls). Documented limitation; the fix is the
  setting toggle. Not a regression.
- **History-anchoring** (Phase 04 lesson): on a long history with no prior rolls,
  a weak model may keep skipping rolls despite the block. One Piece runs on
  gemma4 (steerable). If it bites, the remedy is a per-turn reminder (the same
  Phase 05 candidate raised for anti-railroading) — out of scope here.
- **Modifier precision on bare-d20 checks**: local models may add the wrong/no
  modifier at resolution. Accepted for v1 — the reported problem is the master
  *not asking* for rolls; precise math is a later refinement. (Attacks/damage
  embed the bonus in the formula, so they are exact.)
- **Attack + damage in one message**: the parser already filters the damage
  button out when an attack button is present (roll-parser.ts safety net), so the
  player never sees a premature damage roll. No combat extension needed here.
- **Prompt growth**: the block adds ~250–350 tokens. The Phase 04 "<2KB" figure
  was that block's local note, not a global cap; this stays well within the
  migration's prompt budget (baked ~8,800 → vault target ~3,000–5,000
  `prompt_eval_count`).

## Non-goals (explicit)

- Does NOT add a vault tool (surface stays at 3/4) or an event type.
- Does NOT touch `roll-parser.ts`, the client roll components, or the engine.
- Does NOT implement auto-roll / server-side RNG on the vault path.
- Does NOT implement combat state, initiative, monster spawning, or the
  combat-tracker (piece D — a separate later phase).
- Does NOT change turn-advance / `detectAddressee` (already automatic) or any
  other file beyond the two listed.

## Verification of success

After this ships and One Piece has `manualRolls=true`, an exploration/social/
hazard moment produces a roll request the client renders as a 🎲 button, the
player rolls, and the master resolves it. Automated tests verify the prompt
CONTAINS the roll discipline (header, anchors, phrasings, authoritative-number
contract) and that it is gated/byte-stable; model obedience is observed in the
operator smoke, not unit-tested (same split as Phase 04).
