---
phase: 03-migration-cutover
plan: C-04
subsystem: ai
tags: [baked-models, ollama, gpt-oss, qwen3, mistral, llama, tier-strip, decommission]

# Dependency graph
requires:
  - phase: 01-vault-read-path
    provides: production tier (qwen3:30b-a3b-instruct-2507-q4_K_M) validated as a base slug on the vault path — no longer needs a baked variant; M5 Pro baseline 8012ms avg
  - phase: 03-migration-cutover/03-D-01
    provides: bench-phase-03-m4 runner output capturing dnd-master-plus regression baseline numbers BEFORE the strip (wave-ordering dependency)
provides:
  - TIER_NAMES restricted to dnd-master-plus + its gpt-oss:20b quantizations (REQ-033 regression baseline)
  - scripts/build-local-models.ts gated on TIER_NAMES — auto-discovery only builds dnd-master-plus; --base flag remains a developer escape-hatch
  - Bug fix in TIER_BASES reverse-map (collision when multiple base slugs collapse to one tier name)
  - Test coverage for the strip + graceful-degradation invariant
affects: [03-C-05 stale-userPrefs migration, 03-C-06 operator playbook, Phase 04+ baked-variant decisions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Curated-tier gate: scripts that auto-discover Ollama base models filter against Object.keys(TIER_NAMES) by default; explicit --base bypass remains for one-off developer experiments"
    - "Many-to-one reverse-map insertion guard: when multiple keys map to the same tier value (quantizations collapse), the FIRST entry in the source map wins (canonical-slug-first convention)"

key-files:
  created: []
  modified:
    - "src/ai/master/baked-models.ts — TIER_NAMES stripped to gpt-oss:20b + q4_K_M + q8_0 only; file-top JSDoc + TIER_NAMES JSDoc rewritten; TIER_BASES reverse-map switched from Map-overwrite to insertion-guard"
    - "scripts/build-local-models.ts — isCuratedTierBase gate applied to auto-discovery branch; --base flag bypass preserved; skip-list log surfaces retired bases"
    - "tests/ai/master/baked-models.test.ts — new Phase 03 TIER_NAMES strip describe block; updated getBakedModelName + getBakedBaseModel reverse-map assertions to match post-strip behavior"
    - "tests/lib/local-services-ollama.test.ts — fixture assertion updated to reflect that only dnd-master-plus surfaces in the Settings dropdown post-strip"

key-decisions:
  - "TIER_BASES reverse-map bug discovered during Task 3 test execution: pre-strip, every tier name had a unique base slug entry, so Map overwrite semantics were inert. Post-strip the three gpt-oss quantizations all collapse to dnd-master-plus, so the LAST entry (gpt-oss:20b-q8_0) was winning the reverse lookup instead of the canonical gpt-oss:20b. Fixed via insertion-order guard (if !has) to preserve canonical-slug-first invariant."
  - "Kept LARGE_MODEL_BASES untouched (still contains qwen3:30b + qwen3:30b-a3b + qwen3:30b-a3b-instruct-2507 + gpt-oss:20b + mistral-small3.2:24b) — it serves the runtime-prompt-hash manifest selector, which still needs to classify a base as large/small even when the user is running the base slug directly via the vault path (no baked variant). Stripping it would force a false-positive guard-rail manifest on raw base slugs."
  - "build-local-models.ts --base <slug> escape-hatch preserved: developer testing of unbaked bases for one-off experiments stays unblocked; curated-tier gate only applies to the no-arg auto-discovery branch."

patterns-established:
  - "TIER strip as a one-source-of-truth change: TIER_NAMES is the canonical curated set; consumers (build script, local-services dropdown filter, settings UI) all derive from it"
  - "Graceful degradation for stale userPrefs: isBakedModel keeps recognising the dnd-master- prefix even for retired tiers, returning null from getBakedBaseModel so callers fall back to runtime defaults; the userPrefs migration in 03-C-05 is the structural cleanup"

requirements-completed: [REQ-031, REQ-032, REQ-033]

# Metrics
duration: 7min
completed: 2026-05-27
---

# Phase 03 Plan C-04: Strip Retired Baked Variants from TIER_NAMES Summary

**TIER_NAMES stripped to dnd-master-plus only (REQ-033 regression baseline); build-local-models.ts gated on the curated set; latent TIER_BASES reverse-map bug fixed in passing.**

## Performance

- **Duration:** 7m 23s
- **Started:** 2026-05-27T21:52:22Z
- **Completed:** 2026-05-27T21:59:45Z
- **Tasks:** 3 / 3
- **Files modified:** 4 (3 source/test + 1 deferred-items log)

## Accomplishments

- Removed `dnd-master-lite` (llama3.2:3b), `dnd-master-max` (mistral-small3.2:24b), `dnd-master-max2` (qwen3:30b-a3b-instruct-2507 + 3 quantizations), `dnd-master-max3` (qwen3:30b-a3b + 3 quantizations) from `TIER_NAMES`. Only `gpt-oss:20b` + `q4_K_M` + `q8_0` survive, all mapped to `dnd-master-plus`.
- `scripts/build-local-models.ts` now imports `TIER_NAMES` and applies `isCuratedTierBase` to the auto-discovery branch; running `pnpm build-local-models` post-Phase-03 only attempts to bake `dnd-master-plus`. Skipped bases get a visible log entry instead of silent drop.
- Fixed a previously-masked bug in `TIER_BASES`: with a 3:1 base-to-tier collapse, the Map-overwrite semantics of `new Map(entries)` were causing `getBakedBaseModel('dnd-master-plus')` to return `gpt-oss:20b-q8_0` (the last quantization) instead of the canonical `gpt-oss:20b`. This would have broken `runtime-prompt-hash.ts` (false-positive staleness warnings because `isLargeModelBase` doesn't recognize quantized slugs) and the Settings display label.
- 37/37 tests pass in `tests/ai/master/baked-models.test.ts`; 4/4 in `tests/lib/local-services-ollama.test.ts`; `pnpm typecheck` exits 0; `pnpm build` succeeds.

## Task Commits

Each task was committed atomically:

1. **Task 1: Strip TIER_NAMES in src/ai/master/baked-models.ts** — `8373913` (feat)
2. **Task 2: Update scripts/build-local-models.ts skip-list** — `bf78cf4` (feat)
3. **Task 3: Update tests/ai/master/baked-models.test.ts + fix reverse-map bug + update local-services-ollama fixture** — `159c7e3` (test, includes Rule 1 bug fix)

## Files Created/Modified

- `src/ai/master/baked-models.ts` — TIER_NAMES literal collapsed to 3 entries (gpt-oss:20b + q4_K_M + q8_0 → dnd-master-plus); file-top JSDoc + TIER_NAMES JSDoc rewritten to document Phase 03 retirement + graceful degradation contract; TIER_BASES reverse-map switched to insertion-guard.
- `scripts/build-local-models.ts` — imported TIER_NAMES; added `isCuratedTierBase`; auto-discovery branch filters via the new helper and logs skipped buildable bases; `--base <slug>` escape-hatch unchanged.
- `tests/ai/master/baked-models.test.ts` — added "Phase 03 TIER_NAMES strip" describe block (6 cases asserting the strip invariants + graceful degradation); updated existing `getBakedModelName` and `getBakedBaseModel — tier name reverse map` blocks to match the post-strip legacy-slug-derived fallback behavior.
- `tests/lib/local-services-ollama.test.ts` — fixture test updated: `fetchOllamaModels` previously asserted `[dnd-master-lite, dnd-master-max, dnd-master-plus]` in the dropdown; post-strip only `dnd-master-plus` surfaces because `TIER_LABELS` no longer contains the retired tier entries.
- `.planning/phases/03-migration-cutover/deferred-items.md` — appended a note re-confirming the pre-existing `system-prompt.mode.test.ts > RAG chunks` failures (originally flagged in 03-A-03) are out of scope for 03-C-04.

## Decisions Made

- **Keep `LARGE_MODEL_BASES` untouched.** The set is informational and still serves the runtime-prompt-hash manifest selector for raw base slugs used on the vault path. Stripping it would force false-positive guard-rail manifests on un-baked production runs (qwen3:30b-a3b-instruct-2507-q4_K_M is the Phase 01 primary). The set's purpose is "which bases are large enough to skip the ultra-slim handbook" — that classification is independent of whether the base is baked.
- **`--base <slug>` developer escape-hatch preserved.** The curated-tier gate only applies when `pnpm build-local-models` runs without arguments. Developers experimenting with a non-curated base (e.g., during Phase 04+ spike work) can still pass `--base qwen3:14b` and the gate is bypassed. This matches the existing `isBuildableBase` helper's "still allow explicit opt-in" pattern.
- **Skip-list log format includes the curated set membership.** When the auto-discovery branch drops a buildable base, the log line includes `(curated set: gpt-oss:20b, gpt-oss:20b-q4_K_M, gpt-oss:20b-q8_0)` so operators see WHY the skip happened without grepping `TIER_NAMES`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TIER_BASES many-to-one reverse-map collision**
- **Found during:** Task 3 (test execution surfaced the bug)
- **Issue:** `TIER_BASES` was built via `new Map(Object.entries(TIER_NAMES).map(([base, tier]) => [tier, base]))`. With a 3:1 base-to-tier collapse post-strip (three `gpt-oss:20b*` keys → one `dnd-master-plus` value), the Map ended up with only the LAST iterated entry (`'dnd-master-plus' → 'gpt-oss:20b-q8_0'`). Pre-strip every tier name had a unique base, so the bug was latent; the strip exposed it. Consumers of `getBakedBaseModel('dnd-master-plus')` — most importantly `runtime-prompt-hash.ts:37` which calls `isLargeModelBase(baseSlug)` to choose between the lean and guard-rail manifests — would have seen `'gpt-oss:20b-q8_0'`, which is NOT in `LARGE_MODEL_BASES` (only the canonical `'gpt-oss:20b'` is), so the runtime would pick the guard-rail manifest while the bake script used the lean manifest, producing a permanent hash mismatch and false-positive staleness warnings on every dnd-master-plus turn.
- **Fix:** Replaced the inline-map constructor with an IIFE that iterates entries and skips an insertion when the tier key is already present: `if (!m.has(tier)) m.set(tier, base);`. This preserves the canonical-slug-first invariant (TIER_NAMES is hand-written with the canonical slug as the first key under each tier).
- **Files modified:** `src/ai/master/baked-models.ts` (`TIER_BASES` construction at lines ~134-153)
- **Verification:** New test case `getBakedBaseModel returns the gpt-oss base for dnd-master-plus` asserts the canonical resolution; pre-fix the test failed with `expected 'gpt-oss:20b-q8_0' to be 'gpt-oss:20b'`; post-fix 37/37 pass.
- **Committed in:** `159c7e3` (rolled into Task 3 commit since the test that surfaced the bug also covers the fix)

**2. [Rule 1 - Bug] Updated `tests/lib/local-services-ollama.test.ts` fixture assertion**
- **Found during:** Task 3 verification (running broader test suite)
- **Issue:** The fixture test `returns ONLY baked dnd-master-* variants (raw base models are hidden from Settings)` asserted that `fetchOllamaModels` returned `[dnd-master-lite, dnd-master-max, dnd-master-plus]` given a fixture with all three installed. Post-Task-1 strip, `TIER_LABELS` (which the filter inside `fetchOllamaModels` consults) contains only `dnd-master-plus`, so the lite + max baked variants — even when present in the Ollama install — are correctly filtered out. The assertion was asserting the pre-Phase-03 behavior, not a regression in our code.
- **Fix:** Updated the assertion to `['dnd-master-plus']` and rewrote the test name + comment to document the Phase 03 strip + REQ-031/032/033 alignment (retired tiers still installed locally remain accessible via the raw-base-slug path, just not as baked tier entries in the Settings dropdown).
- **Files modified:** `tests/lib/local-services-ollama.test.ts`
- **Verification:** 4/4 pass post-update.
- **Committed in:** `159c7e3` (rolled into Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — latent bugs exposed by the strip)
**Impact on plan:** Both auto-fixes are direct consequences of the Phase 03 TIER_NAMES collapse. The reverse-map bug would have caused a permanent false-positive staleness warning on the regression baseline (the only surviving tier), defeating the purpose of keeping `dnd-master-plus` around. The fixture test update was a downstream test that asserted pre-strip behavior. No scope creep — both fixes live within the plan's `files_modified` manifest (the bug fix is in `baked-models.ts` which the plan already owned; the fixture is in a sibling test file that directly tests behavior the plan changed).

## Issues Encountered

- During post-Task-3 verification, observed 2 failing tests in `tests/ai/master/system-prompt.mode.test.ts > buildMasterSystemPrompt — RAG chunks`. Verified via `git diff --name-only HEAD~3 HEAD -- 'src/ai/master/system-prompt*' 'src/ai/master/rag*' 'tests/ai/master/system-prompt.mode.test*'` that none of the 03-C-04 commits touched these files. The failures are pre-existing (also flagged in 03-A-03 deferred-items, same describe block). Logged in `.planning/phases/03-migration-cutover/deferred-items.md` per SCOPE BOUNDARY rule; not fixed by this plan.
- Briefly mishandled the user's pre-existing `git stash` entry while running an "is this regression mine?" check — recovered it via `git stash store <hash>` from the still-reachable dropped-stash object before final commit. No data loss.

## User Setup Required

None — no external service configuration required. The downstream operator step (`ollama rm dnd-master-{lite,max,max2,max3}` on the production M4 to reclaim SSD) is documented in plan 03-C-06 (operator playbook), not actioned here.

## Next Phase Readiness

- **03-C-05 (stale userPrefs migration)** can proceed: TIER_NAMES is now the authoritative curated set, and `isBakedModel` still recognises the legacy prefix so the migration's detect-and-rewrite step has stable contracts to read against.
- **03-C-06 (operator playbook for ollama rm)** can proceed: the BUILD-side decommission is complete; the operator-side `ollama rm` step is the matching action on the production host.
- **Phase 04+ baked-variant decisions:** the curated-tier gate pattern in `build-local-models.ts` makes adding a new baked variant a one-line change to TIER_NAMES; the gate logic carries forward unchanged.

## Self-Check: PASSED

**Files verified to exist:**
- `src/ai/master/baked-models.ts` — FOUND
- `scripts/build-local-models.ts` — FOUND
- `tests/ai/master/baked-models.test.ts` — FOUND
- `tests/lib/local-services-ollama.test.ts` — FOUND
- `.planning/phases/03-migration-cutover/deferred-items.md` — FOUND

**Commits verified in git log:**
- `8373913` (Task 1) — FOUND
- `bf78cf4` (Task 2) — FOUND
- `159c7e3` (Task 3 + Rule 1 fixes) — FOUND

**Invariants verified:**
- `Object.values(TIER_NAMES)` contains ONLY `'dnd-master-plus'` — verified via test `TIER_NAMES contains only dnd-master-plus values`
- `pnpm typecheck` exits 0 — verified
- `pnpm build` succeeds — verified
- 37/37 tests pass in `tests/ai/master/baked-models.test.ts` — verified
- 4/4 tests pass in `tests/lib/local-services-ollama.test.ts` — verified

---

*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
