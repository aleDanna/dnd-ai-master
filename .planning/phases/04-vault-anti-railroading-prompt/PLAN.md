---
phase: 04-vault-anti-railroading-prompt
type: phase-overview
waves: 1
total_plans: 1
requirements: [REQ-035]
autonomous: true

must_haves:
  truths:
    - "buildVaultSystemPrompt output contains a `## Your role` block with second-person narration guidance"
    - "The block contains the phrase 'never invent actions' and a soft body-language allowance"
    - "The block contains the worked-example GOOD: and BAD: markers"
    - "The block contains 'BY NAME' multiplayer hand-off guidance (feeds detectAddressee)"
    - "The block appears for BOTH vaultMutations: true AND vaultMutations: false (unconditional)"
    - "REQ-022 byte-stability holds: 1000 builds of identical input produce exactly 1 SHA256"
    - "The vault system prompt stays under 2048 bytes"
  artifacts:
    - path: "src/ai/master/vault/prompt-builder.ts"
      provides: "buildVaultSystemPrompt with the static ## Your role block inserted between the DM identity line and ## Knowledge layout"
      contains: "## Your role"
    - path: "tests/ai/master/vault/prompt-builder.test.ts"
      provides: "extended content assertions for the block + regenerated locked-snapshot/hash expected values"
      contains: "## Your role"
  key_links:
    - from: "src/ai/master/vault/prompt-builder.ts (## Your role block)"
      to: "src/ai/master/vault/__forbidden-patterns.ts (REQ-022 lint)"
      via: "no Date.now/Math.random/process.env/new Date/randomUUID in the block"
      pattern: "Date\\.now|Math\\.random|process\\.env|randomUUID|new\\s+Date"
    - from: "buildVaultSystemPrompt block text"
      to: "src/multiplayer/turn-advance.ts (detectAddressee)"
      via: "'address the next character BY NAME' instruction gives detectAddressee material"
      pattern: "BY NAME"
---

<objective>
Add a static `## Your role` anti-railroading block to `buildVaultSystemPrompt`
so the vault-path Dungeon Master narrates the world (environment, NPCs, and the
consequences of actions the player declared) in second person, but never invents
the player character's actions, dialogue, decisions, or outcomes (REQ-035).

This is piece A of 4 in the "game-mechanics on the vault path" effort. Pieces B
(roll discipline + action→event), C (dice system), D (combat state machine) are
OUT of scope (future phases 05/06/07).

Purpose: The 2026-05-28 gemma4-vs-qwen3 A/B experiment proved both models railroad
the PC on the minimal vault prompt ("provo ad attaccarlo" → master writes "Luffy
si lancia... GUM GUM!"). The fix is the anti-railroading discipline the baked path
already carries, distilled into a concise block + one worked Italian example
(weak models ignore abstract rules; the worked example anchors them).

Output: A modified `src/ai/master/vault/prompt-builder.ts` and extended
`tests/ai/master/vault/prompt-builder.test.ts`. No other files change.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| model ← system prompt | The block adds static DM instructions. It interpolates NO new user-controlled data (vaultRoot/campaignId/characters interpolation is unchanged from Phase 02). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-01 | Information disclosure | `## Your role` block | accept | Block is a fixed English/Italian string; no user data interpolated → prompt-injection surface is unchanged from Phase 02. No mitigation needed. |
| T-04-02 | Denial of service (availability/perf) | REQ-022 prefix-cache identity | mitigate | Block is static and deterministic. Enforce via existing "1000 builds → 1 hash" test (must still pass) + the __forbidden-patterns.ts lint test (no Date.now/Math.random/process.env/new Date/randomUUID added by the block). |

This is a low-threat, static-string change. No package installs, no new input
parsing, no network surface.
</threat_model>

<plan_index>
| Wave | Plan | Objective | Autonomous |
|------|------|-----------|------------|
| 1 | [04-01-insert-your-role-block](plans/04-01-insert-your-role-block.md) | TDD: extend content tests (RED), insert the static `## Your role` block, regenerate locked-snapshot + hash-divergence expected values, verify REQ-022 stability + lint + typecheck (GREEN) | true |
</plan_index>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/04-vault-anti-railroading-prompt/04-CONTEXT.md
@docs/superpowers/specs/2026-05-28-vault-anti-railroading-design.md
</context>

<verification>
- `npx vitest run tests/ai/master/vault/prompt-builder.test.ts` → all tests pass (existing + new block assertions).
- `npx tsc --noEmit` → no new type errors.
- `npx eslint src/ai/master/vault/prompt-builder.ts` → clean (REQ-022 ESLint rule + forbidden-pattern lint test green).
- The vault system prompt is < 2048 bytes for the base read-only input.
</verification>

<success_criteria>
- [ ] `## Your role` block present in `buildVaultSystemPrompt` output, between the DM identity line and `## Knowledge layout`.
- [ ] Block is unconditional (present for both `vaultMutations: true` and `false`).
- [ ] Block contains the LOCKED tokens the tests assert: `## Your role`, "second person", "never invent actions", `GOOD:`, `BAD:`, `BY NAME`.
- [ ] REQ-022: 1000 builds of identical input → exactly 1 SHA256 (existing test green).
- [ ] No forbidden patterns introduced (lint test green).
- [ ] Vault prompt < 2048 bytes.
- [ ] Locked-snapshot test + natural-hash-divergence tests have regenerated expected values (prompt is intentionally longer).
- [ ] `tsc --noEmit` clean; full test file green.
</success_criteria>

<output>
Plan `04-01` writes its SUMMARY to
`.planning/phases/04-vault-anti-railroading-prompt/04-01-SUMMARY.md` when done.
</output>
