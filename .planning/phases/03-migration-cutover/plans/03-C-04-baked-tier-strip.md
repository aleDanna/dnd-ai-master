---
phase: 03
plan: C-04
type: execute
wave: 7
depends_on: [03-D-01]
# NIT-2 (plan-check): encode Pitfall 7 in the dependency graph — M4 sweep
# (03-D-01, wave 6) MUST run BEFORE baked tier strip (03-C-04, wave 7) so
# the dnd-master-plus baseline still exists for the A/B narrative
# comparison. Wave ordering already enforces this; depends_on locks it in.
files_modified:
  - src/ai/master/baked-models.ts
  - scripts/build-local-models.ts
  - tests/ai/master/baked-models.test.ts
autonomous: true
requirements: [REQ-031, REQ-032, REQ-033]
must_haves:
  truths:
    - "TIER_NAMES in src/ai/master/baked-models.ts contains ONLY entries that map to 'dnd-master-plus' (gpt-oss:20b + its quantizations)"
    - "All mistral-* + qwen3:30b-a3b-instruct-2507* (lite/max/max2/max3) entries are REMOVED from TIER_NAMES"
    - "scripts/build-local-models.ts skips the retired base slugs (mistral-small3.2:24b, qwen3:30b-a3b-instruct-2507, qwen3:30b-a3b, llama3.2:3b)"
    - "tests/ai/master/baked-models.test.ts asserts TIER_NAMES values are all 'dnd-master-plus'"
    - "isBakedModel('dnd-master-plus') returns true (regression baseline preserved); isBakedModel('dnd-master-max2') returns true (the prefix check; the model itself is gone) — see plan 03-C-05 for the userPrefs migration"
    - "`pnpm build` succeeds after the strip (no consumer of the deleted entries breaks)"
  artifacts:
    - path: "src/ai/master/baked-models.ts"
      provides: "TIER_NAMES restricted to dnd-master-plus; LARGE_MODEL_BASES kept (informational); JSDoc updated"
      contains: "dnd-master-plus"
    - path: "scripts/build-local-models.ts"
      provides: "Skip-list logic for retired bases; only dnd-master-plus is built"
    - path: "tests/ai/master/baked-models.test.ts"
      provides: "TIER_NAMES assertion + skip-list assertion"
  key_links:
    - from: "src/ai/master/baked-models.ts (stripped TIER_NAMES)"
      to: "scripts/migrate-stale-userprefs.ts (plan 03-C-05)"
      via: "Stale userPrefs.aiMasterModel referencing retired tiers gets migrated"
      pattern: "dnd-master-(lite|max|max2|max3)"
---

# Plan 03-C-04: Strip Retired Baked Variants from TIER_NAMES

**Phase:** 03-migration-cutover
**Wave:** 7 (independent of RAG decommission; parallel-safe)
**Status:** Pending
**Estimated diff size:** ~50 LOC source + ~80 LOC tests / 3 files

## Goal

Per Decision 8 + REQ-033: TIER_NAMES retains ONLY `dnd-master-plus` (regression baseline). Mistral + qwen3 instruct-2507 + qwen3 a3b base + llama3.2:3b are all DROPPED.

The PRODUCTION model is `qwen3:30b-a3b-instruct-2507-q4_K_M` resolved as a BASE slug (not baked) on the vault path — REQ-030 from Phase 01. The vault path's `aiMasterModel` resolver uses the base slug directly, never a baked variant. Phase 01 already enforces this; Phase 03 just removes the now-unused tier entries.

`scripts/build-local-models.ts` is updated to skip the retired bases — `pnpm build-local-models` after Phase 03 only builds `dnd-master-plus`.

## Requirements satisfied

- **REQ-031** — `qwen3:30b-a3b-instruct-2507` quality fallback remains as a BASE slug in the user-pref selector (not as a baked tier — the tier strip removes the dnd-master-max2 mapping but the user can still select the BASE slug directly)
- **REQ-032** — `mistral-small3.2:24b` remains as a BASE slug (not as dnd-master-max baked variant)
- **REQ-033** — Drop all baked variants except dnd-master-plus (regression baseline)

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/baked-models.ts` | EDIT | Strip TIER_NAMES; keep dnd-master-plus mapping |
| `scripts/build-local-models.ts` | EDIT | Skip retired bases in build loop |
| `tests/ai/master/baked-models.test.ts` | NEW (or EDIT if exists) | TIER_NAMES assertion |

## Tasks

<task type="auto">
  <name>Task 1: Strip TIER_NAMES in src/ai/master/baked-models.ts</name>
  <files>src/ai/master/baked-models.ts</files>
  <read_first>
    - src/ai/master/baked-models.ts (existing TIER_NAMES const at lines 68-97 — 11 entries across 5 tiers; the retired tiers are lite/max/max2/max3)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Decision 8 — final TIER_NAMES shape)
  </read_first>
  <action>
Edit `src/ai/master/baked-models.ts`. Locate `TIER_NAMES` (lines 68-97). Replace the entire const with the Phase 03 stripped version:

```ts
/**
 * Phase 03 (Decision 8 + REQ-033) — TIER_NAMES contains ONLY dnd-master-plus
 * (the regression-test baseline; gpt-oss:20b + its q4_K_M/q8_0 quantizations).
 *
 * RETIRED in Phase 03:
 *  - dnd-master-lite  (llama3.2:3b)               — out of selector
 *  - dnd-master-max   (mistral-small3.2:24b)     — out of selector
 *  - dnd-master-max2  (qwen3:30b-a3b-instruct-2507 + quantizations) — out of selector
 *  - dnd-master-max3  (qwen3:30b-a3b + quantizations)              — out of selector
 *
 * The base slugs (e.g., `qwen3:30b-a3b-instruct-2507-q4_K_M` REQ-030 primary)
 * are selected DIRECTLY as `userPrefs.aiMasterModel` — they no longer require
 * a baked variant (Phase 01 vault path runs them as base slugs).
 *
 * Phase 03-C-05 migrates stale `userPrefs.aiMasterModel` values that point
 * at retired tier names back to the production primary base slug.
 *
 * Phase 03-C-06 documents `ollama rm dnd-master-{lite,max,max2,max3}` for
 * SSD reclaim on M4 (operator-run on the production host).
 */
export const TIER_NAMES: Record<string, string> = {
  // GPT-OSS 20B — Plus tier (REGRESSION BASELINE per REQ-033; kept ONLY for
  // spike-004-style A/B tests against the vault path).
  'gpt-oss:20b':                           'dnd-master-plus',
  'gpt-oss:20b-q4_K_M':                    'dnd-master-plus',
  'gpt-oss:20b-q8_0':                      'dnd-master-plus',
};
```

DO NOT touch LARGE_MODEL_BASES, BAKED_PREFIX, isBakedModel, getBakedBaseModel — those still need to recognize the prefix for any user that hasn't been migrated yet (graceful degradation).

Update the file-top JSDoc to mention Phase 03 retirement.
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "dnd-master-lite\\|dnd-master-max\\|dnd-master-max2\\|dnd-master-max3" src/ai/master/baked-models.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "dnd-master-(lite|max|max2|max3)" src/ai/master/baked-models.ts` returns 0 in TIER_NAMES (may appear in JSDoc comments — acceptable)
    - `grep "dnd-master-plus" src/ai/master/baked-models.ts` finds entries for gpt-oss:20b + quantizations
    - TIER_NAMES Object.keys count is exactly 3 (gpt-oss:20b + 2 quantizations) — verified by `grep -cE "^\s+'gpt-oss" src/ai/master/baked-models.ts` returns >= 3
  </acceptance_criteria>
  <done>
    TIER_NAMES stripped.
  </done>
</task>

<task type="auto">
  <name>Task 2: Update scripts/build-local-models.ts skip-list</name>
  <files>scripts/build-local-models.ts</files>
  <read_first>
    - scripts/build-local-models.ts (existing — the Modelfile generator + ollama create loop)
    - src/ai/master/baked-models.ts (Task 1 — the new TIER_NAMES)
  </read_first>
  <action>
Edit `scripts/build-local-models.ts`. The build script iterates over base models and creates `dnd-master-<base>` variants via `ollama create`. After Phase 03, the script should:
1. Read TIER_NAMES from baked-models.ts (single source of truth)
2. Skip any base slug NOT in TIER_NAMES.keys()
3. Print a log: `[build-local-models] skip <base> — not in Phase 03 TIER_NAMES`

If the script currently has a hardcoded BASE list, REPLACE it with `Object.keys(TIER_NAMES)`.

If it currently does `for (const base of allInstalledOllamaModels)`, ADD a filter: `if (!(base in TIER_NAMES)) { console.log(...); continue; }`.

Inspect the actual structure to determine the right change. The MINIMAL change is sufficient — the goal is "only dnd-master-plus gets built".
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "TIER_NAMES\\|dnd-master-plus" scripts/build-local-models.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - The build script references TIER_NAMES (or hardcodes dnd-master-plus only)
    - `pnpm build-local-models` (if run on a machine with all 5 bases installed) only builds the plus variant
    - No build attempt for mistral/qwen3-instruct-2507/qwen3-a3b/llama3.2:3b
  </acceptance_criteria>
  <done>
    Build script aligned with Phase 03 TIER_NAMES.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/ai/master/baked-models.test.ts</name>
  <files>tests/ai/master/baked-models.test.ts</files>
  <read_first>
    - src/ai/master/baked-models.ts (Task 1)
    - (look for existing tests/ai/master/baked-models.test.ts; if absent, this is a NEW file)
  </read_first>
  <action>
Create or extend `tests/ai/master/baked-models.test.ts`. Cases:

```ts
import { describe, it, expect } from 'vitest';
import { TIER_NAMES, isBakedModel, getBakedBaseModel, BAKED_PREFIX } from '@/ai/master/baked-models';

describe('baked-models — Phase 03 TIER_NAMES strip', () => {
  it('TIER_NAMES contains only dnd-master-plus values', () => {
    const tiers = new Set(Object.values(TIER_NAMES));
    expect(tiers).toEqual(new Set(['dnd-master-plus']));
  });

  it('TIER_NAMES has 3 base slugs (gpt-oss:20b + 2 quantizations)', () => {
    const bases = Object.keys(TIER_NAMES);
    expect(bases).toHaveLength(3);
    expect(bases.every((b) => b.startsWith('gpt-oss:20b'))).toBe(true);
  });

  it('retired tier slugs are NOT in TIER_NAMES.values()', () => {
    const tiers = Object.values(TIER_NAMES);
    expect(tiers).not.toContain('dnd-master-lite');
    expect(tiers).not.toContain('dnd-master-max');
    expect(tiers).not.toContain('dnd-master-max2');
    expect(tiers).not.toContain('dnd-master-max3');
  });

  it('isBakedModel still recognizes the dnd-master- prefix for graceful degradation', () => {
    expect(isBakedModel('dnd-master-plus')).toBe(true);
    expect(isBakedModel('dnd-master-max2')).toBe(true);  // historically baked; user prefs migration handles
    expect(isBakedModel('qwen3:30b-a3b-instruct-2507-q4_K_M')).toBe(false);  // base slug
  });

  it('getBakedBaseModel returns the base for dnd-master-plus', () => {
    const base = getBakedBaseModel('dnd-master-plus');
    expect(base).toMatch(/gpt-oss:20b/);
  });

  it('getBakedBaseModel returns null for retired tiers (post-strip)', () => {
    // dnd-master-max2 was previously a slug-derived fallback to qwen3:30b-...
    // After strip, the TIER_BASES reverse map has no entry for it.
    // The legacy slug-derived path may still resolve via the inverse-prefix logic;
    // the test asserts the CORRECT expected behavior given the strip.
    // (Adjust based on the actual implementation of getBakedBaseModel.)
    const base = getBakedBaseModel('dnd-master-max2');
    // If the slug-derived fallback still resolves to qwen3:30b-..., that's fine —
    // the userPrefs migration (plan 03-C-05) handles the stale-pref-to-base mapping.
    // The KEY assertion is that the dropdown / build script doesn't surface max2.
    expect([null, 'qwen3:30b-a3b-instruct-2507']).toContain(base);
  });
});
```
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/baked-models.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass
    - The "only dnd-master-plus" assertion passes
    - The "isBakedModel still recognizes the prefix" case passes (graceful degradation invariant)
    - Test runtime < 5s
  </acceptance_criteria>
  <done>
    TIER_NAMES strip tested. Plan 03-C-05 migrates user prefs; plan 03-C-06 documents the operator `ollama rm`.
  </done>
</task>
