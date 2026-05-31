---
phase: 10-server-authoritative-combat-and-tracker
plan: "02"
subsystem: api
tags: [bestiary, srd, frontmatter, combat, monster-stats]

# Dependency graph
requires:
  - phase: 10-server-authoritative-combat-and-tracker/10-01
    provides: runEncounterOpener pure helper that calls bestiaryLookup
provides:
  - exported async getBestiaryStatblock(name) returning {hpMax?,ac?,cr?}|null from SRD frontmatter
  - test suite asserting goblin reads real seeded {hpMax:7,ac:15,cr:'1/4'}
affects:
  - 10-03-PLAN.md (route wiring uses getBestiaryStatblock as injected bestiaryLookup)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inline frontmatter parse: bounded per-line scan of ---…--- block, no external YAML parser"
    - "Path-safe vault read: slugify + readVaultFile (safeVaultPath) — never raw concat"
    - "Null-on-any-miss pattern: getBestiaryStatblock returns null, never throws"

key-files:
  created:
    - tests/app/api/sessions/[id]/turn/monster-bestiary-statblock.test.ts
  modified:
    - src/app/api/sessions/[id]/turn/monster-bestiary.ts

key-decisions:
  - "BestiaryStatblock interface has all fields optional (hpMax?,ac?,cr?) to handle partial frontmatter gracefully"
  - "Inline frontmatter parser: first --- triggers open; second --- closes; content before first --- returns null immediately"
  - "cr stored as string after quote-stripping so '1/4' is the string '1/4', not 0.25"
  - "Returns null (not empty object) when no hpMax/ac/cr fields are found in frontmatter"
  - "getBestiaryAttackStats and all v1/v2 files left byte-identical (strict isolation)"

patterns-established:
  - "Colocate statblock reader alongside attack-stats reader in monster-bestiary.ts"
  - "TDD RED commit first, GREEN implementation commit second — strict gate order observed"

requirements-completed: [REQ-045]

# Metrics
duration: 5min
completed: 2026-05-31
---

# Phase 10 Plan 02: getBestiaryStatblock SRD Frontmatter Reader Summary

**New exported `getBestiaryStatblock(name)` reads hpMax/ac/cr from handbook/monsters/ YAML frontmatter via readVaultFile/safeVaultPath — goblin returns real seeded {hpMax:7,ac:15,cr:'1/4'}**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-31T21:45:00Z
- **Completed:** 2026-05-31T21:50:00Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 2

## Accomplishments
- Exported `getBestiaryStatblock(name): Promise<BestiaryStatblock | null>` colocated in monster-bestiary.ts
- 5-case TDD test suite: goblin real stats, case/whitespace normalization, unknown monster null, traversal null
- Path-safety proven: slugify + readVaultFile(safeVaultPath) — no raw filesystem concatenation (T-10-04/T-10-06)
- All pre-existing getBestiaryAttackStats tests (18) still pass — strict isolation maintained
- `tsc --noEmit` clean project-wide

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — pin getBestiaryStatblock to the goblin's REAL seeded frontmatter** - `71ca7fb` (test)
2. **Task 2: GREEN — implement getBestiaryStatblock (path-safe read, inline frontmatter parse)** - `bd84594` (feat)

_TDD: test commit (RED) before implementation commit (GREEN) — gate order verified in git log._

## Files Created/Modified
- `src/app/api/sessions/[id]/turn/monster-bestiary.ts` - Added `BestiaryStatblock` interface and `getBestiaryStatblock` export (96 lines added; existing functions unchanged)
- `tests/app/api/sessions/[id]/turn/monster-bestiary-statblock.test.ts` - 5-case TDD suite asserting goblin real frontmatter stats + null cases

## Decisions Made
- **All fields optional on BestiaryStatblock:** `{hpMax?,ac?,cr?}` so partial frontmatter files degrade gracefully (e.g. a file with only `ac:` still returns `{ac:N}`)
- **Inline frontmatter parser:** No external YAML library — bounded per-line scan of the `---…---` block; returns null if no opening delimiter found before body content (safe for files with no frontmatter)
- **cr as string:** Quote-stripped from `"1/4"` → `'1/4'`; NOT coerced to numeric 0.25 — preserves the SRD fraction display value the UI expects
- **Return null not empty object:** When hpMax/ac/cr are all absent, return null so callers distinguish "file found but no stats" from "file found with partial stats"

## Deviations from Plan

None — plan executed exactly as written. TDD RED→GREEN order followed. `getBestiaryAttackStats` and all v1/v2 combat files byte-identical.

## Issues Encountered

None. The `[id]` bracket in the test path required passing a filename substring to `npx vitest run` rather than the full escaped path — standard vitest filter workaround, not a code issue.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns beyond what the plan's `<threat_model>` already covers (T-10-04/T-10-05/T-10-06). The new function is read-only, colocated with existing bestiary code, and never imported by a route directly (that is 10-03's job).

## Known Stubs

None. `getBestiaryStatblock('goblin')` returns the real committed values `{hpMax:7,ac:15,cr:'1/4'}` from `data/vault/handbook/monsters/goblin.md` — no hardcoded placeholder values.

## TDD Gate Compliance

- RED gate: `test(10): add failing getBestiaryStatblock tests against real goblin SRD frontmatter` — `71ca7fb`
- GREEN gate: `feat(10): add getBestiaryStatblock SRD frontmatter reader` — `bd84594`
- Both gates present in git log in correct order.

## Next Phase Readiness
- `getBestiaryStatblock` is ready to be injected as `bestiaryLookup` in the encounter opener (10-01) via route wiring in 10-03
- The function's `BestiaryStatblock` interface and null-on-miss contract match what 10-01's `BestiaryStats` parameter expects

---
*Phase: 10-server-authoritative-combat-and-tracker*
*Completed: 2026-05-31*
