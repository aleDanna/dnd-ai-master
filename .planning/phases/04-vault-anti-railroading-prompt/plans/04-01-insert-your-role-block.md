---
phase: 04-vault-anti-railroading-prompt
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/ai/master/vault/prompt-builder.ts
  - tests/ai/master/vault/prompt-builder.test.ts
autonomous: true
requirements: [REQ-035]

must_haves:
  truths:
    - "buildVaultSystemPrompt output contains a `## Your role` block (both vaultMutations states)"
    - "Block contains 'second person', 'never invent actions', GOOD:/BAD: markers, 'BY NAME'"
    - "REQ-022 holds: 1000 builds of identical input → 1 SHA256"
    - "Vault prompt < 2048 bytes"
  artifacts:
    - path: "src/ai/master/vault/prompt-builder.ts"
      provides: "static ## Your role block inserted between the DM identity line and ## Knowledge layout"
      contains: "## Your role"
    - path: "tests/ai/master/vault/prompt-builder.test.ts"
      provides: "block content assertions + regenerated locked-snapshot/hash expected values"
      contains: "## Your role"
  key_links:
    - from: "## Your role block"
      to: "__forbidden-patterns.ts REQ-022 lint"
      via: "no Date.now/Math.random/process.env/new Date/randomUUID in the block"
      pattern: "Date\\.now|Math\\.random|process\\.env"
---

<objective>
TDD insert of the static `## Your role` anti-railroading block into
`buildVaultSystemPrompt`, implementing REQ-035. The block is UNCONDITIONAL
(present whether `vaultMutations` is true or false — unlike the conditional
`applyEventMention`/roster blocks) and STATIC/DETERMINISTIC (preserves REQ-022
byte-stability). The exact block content is LOCKED in 04-CONTEXT.md and must be
reproduced verbatim.

Purpose: Make the vault-path DM narrate consequences of declared actions in
second person without inventing the PC's actions/dialogue/decisions/outcomes.
TDD because the deliverable is a precise content contract — assert the LOCKED
tokens RED-first, then make them pass.

Output: Modified `prompt-builder.ts` + extended/reconciled
`prompt-builder.test.ts`. No other files.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/04-vault-anti-railroading-prompt/04-CONTEXT.md
@docs/superpowers/specs/2026-05-28-vault-anti-railroading-design.md
@src/ai/master/vault/prompt-builder.ts
@tests/ai/master/vault/prompt-builder.test.ts
@src/ai/master/vault/__forbidden-patterns.ts
</context>

<interface_contract>
The LOCKED block content (verbatim from 04-CONTEXT.md §"Exact block content" /
spec §"The prompt block"). Reproduce EXACTLY — the tests assert specific tokens
and the locked-snapshot is byte-exact:

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

NOTE on em-dashes and ellipsis: the block uses the same Unicode characters as
the existing prompt (em-dash `—` U+2014 appears in the `## Knowledge layout`
"reserved — populated" line; the ellipsis in `"you …"` is U+2026). Match the
04-CONTEXT.md source bytes exactly.

Insertion point (from the existing `lines` array, prompt-builder.ts):
the array currently opens:
```
'You are an experienced D&D 5e Dungeon Master.',
'',
'## Knowledge layout',
```
The block goes BETWEEN `''` (after the identity line) and `'## Knowledge layout'`.

Implementer's discretion (per 04-CONTEXT.md §"Claude's Discretion"): emit the
block either as a module-level `const ROLE_BLOCK_LINES: readonly string[]` spread
into `lines`, or as inline `lines.push(...)` / array literal entries. Either is
fine as long as (a) every physical line is an explicit array element joined with
`\n` (matching the file's stated paranoia about `\r\n`), and (b) byte-stability
holds. Do NOT use a multi-line template literal for the block — that is exactly
the `\r\n`-drift risk the file comment warns against.
</interface_contract>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: RED content tests + insert the unconditional `## Your role` block</name>
  <files>src/ai/master/vault/prompt-builder.ts, tests/ai/master/vault/prompt-builder.test.ts</files>
  <read_first>
    - src/ai/master/vault/prompt-builder.ts (the `lines` array in buildVaultSystemPrompt — insertion point after the DM identity line; study applyEventMention + roster blocks for the explicit-`\n`-array style)
    - tests/ai/master/vault/prompt-builder.test.ts (BASE_INPUT, READ_WRITE constants; the existing "content sanity" + "Phase 02 gate" describe blocks to extend)
    - .planning/phases/04-vault-anti-railroading-prompt/04-CONTEXT.md (§"Exact block content" — the verbatim source)
    - src/ai/master/vault/__forbidden-patterns.ts (the REQ-022 patterns the block must NOT trip)
  </read_first>
  <behavior>
    New describe block "buildVaultSystemPrompt — Phase 04 anti-railroading (REQ-035)":
    - Test: base read-only prompt contains '## Your role'
    - Test: read-write prompt (vaultMutations:true, toolCount:4) ALSO contains '## Your role' (unconditional)
    - Test: contains 'second person'
    - Test: contains 'never invent actions'
    - Test: contains 'GOOD:' AND 'BAD:'
    - Test: contains 'BY NAME'
    - Test: vault prompt byte length < 2048 for BASE_INPUT (Buffer.byteLength(prompt, 'utf8') < 2048)
    - Test: REQ-022 — 1000 builds of BASE_INPUT → 1 hash (this already exists at top of file; do NOT duplicate — rely on it staying green)
  </behavior>
  <action>
    TDD RED→GREEN, single file pair.

    RED: In tests/ai/master/vault/prompt-builder.test.ts add a new describe block
    "buildVaultSystemPrompt — Phase 04 anti-railroading (REQ-035)" with the assertions
    listed in &lt;behavior&gt;. Use the existing BASE_INPUT for the read-only case and
    a {vaultRoot:'data/vault', campaignId:'test', toolCount:4, vaultMutations:true}
    literal for the unconditional/read-write case. For the size bound assert
    Buffer.byteLength(buildVaultSystemPrompt(BASE_INPUT), 'utf8') is less than 2048.
    Run the file — the new content/unconditional tests MUST fail (block not yet present);
    the size + REQ-022 tests will pass.

    GREEN: In src/ai/master/vault/prompt-builder.ts insert the LOCKED block (see this
    plan's &lt;interface_contract&gt; — reproduce verbatim from 04-CONTEXT.md) into the
    `lines` array, placed AFTER the `''` that follows
    'You are an experienced D&amp;D 5e Dungeon Master.' and BEFORE '## Knowledge layout'.
    Emit each physical line as an explicit array element (or a spread of a module-level
    `readonly string[]`); end the block with a trailing `''` so the existing blank-line
    rhythm before '## Knowledge layout' is preserved. Do NOT gate it on vaultMutations —
    it is unconditional. Do NOT introduce Date.now/Math.random/process.env/new Date/
    randomUUID/process.hrtime (REQ-022). Re-run the file: the new content tests pass.

    Do NOT touch turn-advance, tools, system-prompt.ts, fetchOllamaModels, or any other file.
  </action>
  <acceptance_criteria>
    - `grep -c '## Your role' src/ai/master/vault/prompt-builder.ts` returns at least 1.
    - In the test file the new describe asserts all of: '## Your role' (read-only AND vaultMutations:true), 'second person', 'never invent actions', 'GOOD:', 'BAD:', 'BY NAME', and a Buffer.byteLength(...) < 2048 check. Verify with: `grep -E "Your role|second person|never invent actions|GOOD:|BAD:|BY NAME|byteLength" tests/ai/master/vault/prompt-builder.test.ts` shows each token present.
    - No forbidden pattern in the block: `grep -nE 'Date\.now|Math\.random|process\.env|new[[:space:]]+Date|randomUUID|process\.hrtime' src/ai/master/vault/prompt-builder.ts` returns no NEW matches inside the inserted block (the file had none before).
    - The Phase 04 describe block's content + unconditional + size assertions all pass.
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run tests/ai/master/vault/prompt-builder.test.ts -t "Phase 04 anti-railroading"</automated>
  </verify>
  <done>
    The `## Your role` block is present in buildVaultSystemPrompt output for both
    vaultMutations true and false; the Phase 04 content/size assertions pass; no
    forbidden pattern introduced.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Regenerate locked-snapshot + natural-hash-divergence expected values; full-file + REQ-022 + typecheck green</name>
  <files>tests/ai/master/vault/prompt-builder.test.ts, src/ai/master/vault/prompt-builder.ts</files>
  <read_first>
    - tests/ai/master/vault/prompt-builder.test.ts (the "matches the locked snapshot for a fixed input" test at the content-sanity block — the hardcoded array literal that now omits the block; plus the REQ-022 stability + Phase 02 hash-divergence tests)
    - src/ai/master/vault/prompt-builder.ts (the now-updated `lines` array, to copy the exact block lines into the snapshot literal)
  </read_first>
  <behavior>
    - The "matches the locked snapshot for a fixed input" test's expected array must
      include the new `## Your role` block lines in the correct position (after the
      identity line + blank, before '## Knowledge layout'), so it passes against the
      updated builder.
    - REQ-022 "1000 builds → 1 hash" (base + language:'it' + vaultMutations:true)
      remain green (block is static — they should pass with NO edit; if any fail,
      the block is non-deterministic and must be fixed, NOT the test).
    - The Phase 02 "natural hash divergence (read-only vs read-write)" and the
      sensitivity tests remain green (the block is identical across both modes, so
      it cancels out — divergence still comes from applyEventMention; no expected-value
      change needed there, but confirm).
  </behavior>
  <action>
    Reconcile the snapshot/hash tests against the longer prompt. The block is the
    same bytes in every mode and does NOT vary by language, so ONLY the byte-exact
    locked-snapshot literal needs regenerating; the hash-divergence/sensitivity tests
    compare two prompts that BOTH gained the identical block, so their relative
    inequality is unchanged.

    Update the "matches the locked snapshot for a fixed input" test
    (campaignId:'test-camp', toolCount:3): insert the exact `## Your role` block lines
    into the expected `[...]` array at the correct position (after
    'You are an experienced D&amp;D 5e Dungeon Master.' and its following '', before
    '## Knowledge layout'). Regenerate by copying the lines from the updated builder —
    do NOT hand-retype (avoid em-dash/ellipsis drift); the goal is byte-identical.

    Run the FULL test file. If the REQ-022 1000-builds tests fail, the block is
    non-deterministic — fix the BLOCK (remove the offending construct), never weaken
    the test. If the locked-snapshot still fails, diff actual-vs-expected and align the
    expected literal to the actual bytes (regenerate, don't fight it).

    Then run `npx tsc --noEmit` and `npx eslint src/ai/master/vault/prompt-builder.ts`.
  </action>
  <acceptance_criteria>
    - `npx vitest run tests/ai/master/vault/prompt-builder.test.ts` → ALL tests pass (existing REQ-022 stability, sensitivity, Phase 02 gate, Phase 02.1 roster, the regenerated locked-snapshot, and the new Phase 04 block tests).
    - The locked-snapshot expected array literal contains the line '## Your role' (verify: `grep -c "## Your role" tests/ai/master/vault/prompt-builder.test.ts` returns at least 2 — one in the Phase 04 describe, one in the snapshot literal).
    - `npx tsc --noEmit` exits 0 (no new type errors).
    - `npx eslint src/ai/master/vault/prompt-builder.ts` exits 0 (REQ-022 ESLint rule + lint test satisfied).
    - The REQ-022 "1000 builds → 1 hash" tests (base, language:'it', vaultMutations:true) are unmodified and still green.
  </acceptance_criteria>
  <verify>
    <automated>npx vitest run tests/ai/master/vault/prompt-builder.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>
    Full prompt-builder test file is green (including regenerated locked-snapshot),
    REQ-022 stability preserved unchanged, typecheck and eslint clean.
  </done>
</task>

</tasks>

<verification>
- `npx vitest run tests/ai/master/vault/prompt-builder.test.ts` → all green.
- `npx tsc --noEmit` → 0 errors.
- `npx eslint src/ai/master/vault/prompt-builder.ts` → clean.
- Manual confirmation: `buildVaultSystemPrompt(BASE_INPUT)` byte length < 2048.
</verification>

<success_criteria>
- [ ] `## Your role` block present (verbatim from 04-CONTEXT.md), unconditional, between identity line and `## Knowledge layout`.
- [ ] Phase 04 content assertions pass: '## Your role', 'second person', 'never invent actions', 'GOOD:', 'BAD:', 'BY NAME'.
- [ ] Vault prompt < 2048 bytes.
- [ ] REQ-022 1000-builds-1-hash tests unchanged and green.
- [ ] No forbidden pattern introduced (lint + lint-test green).
- [ ] Locked-snapshot expected value regenerated; full test file + tsc green.
</success_criteria>

<output>
Create `.planning/phases/04-vault-anti-railroading-prompt/04-01-SUMMARY.md` when done.
</output>

---

## EXECUTION SUMMARY (appended on completion)

**Status:** COMPLETE — 2/2 tasks, all gates green.

Full SUMMARY: `.planning/phases/04-vault-anti-railroading-prompt/04-01-SUMMARY.md`

- Inserted the LOCKED `## Your role` block byte-identical (verified via programmatic substring match against 04-CONTEXT.md: em-dash U+2014 ×4, ellipsis U+2026 ×1), unconditional, between the DM identity line and `## Knowledge layout`. Prompt = 1603 bytes (< 2048).
- REQ-022 "1000 builds → 1 hash" tests unchanged and green. No forbidden non-deterministic construct introduced.
- Regenerated the locked-snapshot expected literal (copied, not retyped).
- **Deviation (Rule 1):** Fixed Phase 02.1 "roster order is preserved" test — the new worked example's prose "Luffy" collided with the bare `indexOf('Luffy')`; rescoped to the unique `Name: \`uuid\`` roster-line form. LOCKED block untouched.

**Commits:**
- `ec64538` feat(phase-04): insert unconditional `## Your role` anti-railroading block (REQ-035)
- `46859ca` test(phase-04): regenerate locked snapshot; fix roster-order collision

**Final gates:** `vitest run` 38/38 pass · `tsc --noEmit` exit 0 · `eslint` on touched file exit 0.
