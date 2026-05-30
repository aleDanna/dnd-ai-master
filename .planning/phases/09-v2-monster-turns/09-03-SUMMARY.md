---
phase: 09-v2-monster-turns
plan: 03
subsystem: combat / monster-turns
tags: [bestiary, parser, regex, path-safety, redos, srd]
# Dependency graph (for cross-phase queries)
requires: [src/ai/master/vault/path.ts (readVaultFile/safeVaultPath), src/srd/util/slug.ts (slugify), src/engine/dice.ts (rollDamage grammar)]
provides: [parseFirstAttackFromProse, getBestiaryAttackStats]
affects: [src/app/api/sessions/[id]/turn/monster-bestiary.ts]
# Tech stack (for pattern queries)
tech-stack:
  added: []
  patterns: [path-safe-vault-read, redos-bounded-per-block-regex, null-on-miss-never-throw, colocated-pure-helper]
# Key files (for navigation)
key-files:
  created:
    - src/app/api/sessions/[id]/turn/monster-bestiary.ts
    - tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts
  modified: []
# Decisions (for decision queries)
key-decisions:
  - "Replicated parseNamedBlocks' colon/parenthetical split locally in monster-bestiary.ts instead of exporting it from src/srd/parsers/monsters.ts — keeps the module isolated (D-07) and leaves monsters.ts unmodified per plan scope."
  - "Wrapped slugify in try/catch in getBestiaryAttackStats: slugify throws on empty-slug input (e.g. '!!!'), and the never-throw contract requires returning null instead."
  - "ATTACK_HIT_RE/DAMAGE_DICE_RE use bounded quantifiers and run per-block-description, never as a single greedy pass over the multi-line body (ReDoS mitigation T-09-09)."
# Requirements completed (for traceability)
requirements-completed: [D-04, D-07]
# Metrics
duration: 12 min
completed: 2026-05-30
---

# Phase 09 Plan 03: Isolated SRD Bestiary Attack-Prose Parser Summary

## Performance

ReDoS-bounded: the 5,000-char pathological-input test completes in < 1s (asserted in-test; observed sub-millisecond). The regexes carry no nested unbounded quantifiers and run on a single bounded block description at a time.

## What Was Built

A deliberately ISOLATED (D-07) colocated helper `src/app/api/sessions/[id]/turn/monster-bestiary.ts` that turns SRD bestiary `## Actions` prose into a `{attackBonus, damageDice}` profile. `parseFirstAttackFromProse(actionsText)` extracts the first attack (skipping `Multiattack`/no-`+N to hit` blocks), and `getBestiaryAttackStats(name)` slug-normalizes a monster name, reads `data/vault/handbook/monsters/<slug>.md` through the existing path-safe `readVaultFile`, and parses its Actions section. Both return `null` on any miss so the 09-04 loop cleanly falls back to the D-05 CR table / D-06 default. The module has NO dependency on the smoke-critical custom-monster (CR) path and on the sibling Wave-1 plans (09-01/09-02).

## Key Implementation Details

- **`parseFirstAttackFromProse(actionsText): {attackBonus, damageDice} | null`** — splits the body into `{name, description}` blocks (local `splitActionBlocks`), then iterates: for the FIRST block whose description matches `ATTACK_HIT_RE = /\+(\d+)\s{0,4}to\s{1,4}hit/i` it reads `attackBonus` and extracts `damageDice` via `DAMAGE_DICE_RE = /(\d+d\d+(?:[+-]\d+)?)/` from that SAME block; a block with a hit but no dice is skipped (`continue`). Returns `null` if no block yields both.
  - Multiattack-first lines (troll, bandit-captain, adult-red-dragon) carry no `+N to hit` and are skipped — the first real attack wins.
  - Compound damage (`2d10+8 piercing + 4d6 fire`) → the first `XdY±K` match (`2d10+8`) is the primary die; the rider is ignored for v2 (no resistance modeling).
- **`getBestiaryAttackStats(name): Promise<{attackBonus, damageDice} | null>`** — `slugify(name)` (reused so lookup slugs match seed-bestiary's on-disk filenames), then `readVaultFile('handbook/monsters/<slug>.md')`. If the result starts with `ERROR` (file-not-found / unsafe path), returns `null`; otherwise extracts the `## Actions` section body (`extractActionsSection`, a bounded per-line scan to the next `## ` heading) and delegates to `parseFirstAttackFromProse`.
- **Path safety (T-09-08):** the only filesystem access is via `readVaultFile` → `safeVaultPath` (traversal/symlink/null-byte guarded). No hand-rolled `node:fs`/`node:path`/`path.join`. `'../../../etc/passwd'` slugifies to a harmless `etc-passwd` which is then confined to the bestiary dir; the test asserts `null`.
- **ReDoS safety (T-09-09):** regexes run per-block-description (bounded), never over the whole multi-line body.
- **Never throws (T-09-10):** empty/invalid name, empty-slug input (`slugify` throws → caught), missing file, unsafe path, missing `## Actions`, or unparseable prose all return `null`.
- **Isolation (D-07):** `parseNamedBlocks` is module-private in `src/srd/parsers/monsters.ts`; rather than export it (and couple this module to the SRD parser / modify a file outside plan scope), the minimal colon/parenthetical split was re-implemented locally. No `next/*` imports — it is a pure helper, not a route handler (confirmed against the non-standard Next.js route-handler guide).

## Files

- **Created** `src/app/api/sessions/[id]/turn/monster-bestiary.ts` — `parseFirstAttackFromProse` + `getBestiaryAttackStats` (+ private `splitActionBlocks`, `extractActionsSection`), 168 lines.
- **Created** `tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts` — 19 unit tests: 6 real prose forms (goblin/orc/zombie/bandit-captain/troll/adult-red-dragon), Multiattack skip, no-match null, empty-input null, hit-without-dice null, 5k-char ReDoS-bounded input, real-file lookups (goblin/bandit-captain/troll), missing-file null, traversal null, empty-slug null, and rollDamage-consumability of returned dice.

## Deviations from Plan

**[Rule 2 - Missing critical robustness] Guard `slugify`'s throw-on-empty-slug**
- **Found during:** Task 1 (GREEN)
- **Issue:** `slugify` (src/srd/util/slug.ts) throws when the input normalizes to an empty slug (e.g. `'!!!'`, `''`). The plan mandates `getBestiaryAttackStats` NEVER throws (T-09-10), and the 09-04 loop relies on a `null` return to fall back.
- **Fix:** Wrapped the `slugify(name)` call in try/catch returning `null`, plus an early `null` guard for empty/whitespace names. Added two tests (`'!!!'` and `''` → resolves to `null`).
- **Files modified:** src/app/api/sessions/[id]/turn/monster-bestiary.ts, tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts
- **Verification:** `getBestiaryAttackStats > returns null (never throws) for a name that cannot produce a usable slug` passes.
- **Commit:** GREEN commit (feat 09-03)

**Total deviations:** 1 auto-fixed (Rule 2: never-throw robustness). **Impact:** Strengthens the documented never-throw contract; no scope or interface change.

Note (not a deviation): the plan's troll behavior example uses a synthetic `2d6+4` string; the real `troll.md` bite is `1d6+4`. Both are tested — the synthetic string via `parseFirstAttackFromProse` and the real file via `getBestiaryAttackStats('Troll')` → `{attackBonus:7, damageDice:'1d6+4'}`.

## Issues Encountered

`git status --short` briefly showed the test file as untracked immediately after `git add` due to the `[id]` path being interpreted as a glob bracket-expression in a plain pathspec. Confirmed via `git ls-files`/`git show --stat` that the commit captured it correctly; switched subsequent `git add`/commit calls to `:(literal)` pathspecs to avoid the ambiguity. No content impact.

## Next Steps

- 09-04 (Wave 2) can call `getBestiaryAttackStats(name)` FIRST in its 3-level monster-attack fallback; a `null` return cedes to the D-05 CR table / D-06 default.
- Sibling Wave-1 plans 09-01 (events-schema/projector) and 09-02 (monster-turns) remain independent — this plan touched neither.

## For Next Phase/Plan

- Import surface: `import { getBestiaryAttackStats, parseFirstAttackFromProse, type BestiaryAttackStats } from '@/app/api/sessions/[id]/turn/monster-bestiary'`.
- Contract: `getBestiaryAttackStats` is `async` and returns `BestiaryAttackStats | null`; it never throws. `damageDice` is always a `rollDamage`-consumable `NdM(±K)` string.
- v2 limitation (intentional): only the primary die of compound-damage attacks is returned; secondary riders (e.g. `+4d6 fire`) and ranged-vs-melee selection are out of scope.

## Task Commits

1. **Task 1 (TDD RED): failing bestiary parser tests** — `42b010d` (test)
2. **Task 1 (TDD GREEN): parser + lookup implementation** — `3429d81` (feat)

**Plan metadata:** `9ee0b58` (docs: complete plan) + `cf000b3` (docs: sync STATE/ROADMAP)

## Self-Check: PASSED

- `src/app/api/sessions/[id]/turn/monster-bestiary.ts` — FOUND on disk.
- `tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts` — FOUND on disk.
- Commit `42b010d` (test 09-03 RED) — FOUND in git log.
- Commit `3429d81` (feat 09-03 GREEN) — FOUND in git log.
- `npx vitest run tests/app/api/sessions/[id]/turn/monster-bestiary.test.ts` → 18 passed, exit 0.
- `npx tsc --noEmit` → exit 0 (re-confirmed after sibling Wave-1 plans 09-01/09-02 settled on the shared branch).
- Acceptance criteria AC1–AC5 all PASS (vitest 18/18, both exports present, readVaultFile routing with NO hand-rolled fs/path, per-block bounded regex, tsc clean).
- Scope: each of the two task commits touched exactly ONE of the two plan files (`git show --stat`: RED → test only; GREEN → source only). No sibling Wave-1 files (events-schema/projector/monster-turns) were modified.
