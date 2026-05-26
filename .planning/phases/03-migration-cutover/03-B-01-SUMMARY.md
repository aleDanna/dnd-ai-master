---
phase: 03-migration-cutover
plan: B-01
subsystem: database
tags: [feature-flag, vault, postgres, source-of-truth, dual-write, preferences, drizzle]

requires:
  - phase: 01-vault-read-path
    provides: resolveMasterBackend parallel-shape resolver pattern + isMasterBackend type guard + DEFAULT_PREFERENCES extension model
  - phase: 02-vault-write-path-event-sourcing
    provides: resolveVaultMutations parallel-shape (Pitfall 5 orthogonal-flags pattern); preferences-vault-mutations.test.ts vi.mock('@/db/client', ...) test shape

provides:
  - "SourceOfTruth type ('postgres' | 'vault') + isSourceOfTruth type guard"
  - "resolveSourceOfTruth(stored) with MASTER_SOURCE_OF_TRUTH env override (defaults to 'postgres' for backward-compat)"
  - "resolveDualWrite(settings) — operator-set per campaign only; NO env override by design (Decision 2 anti-accidental-global-enable)"
  - "CampaignSettings.sourceOfTruth + dualWrite + cutoverAt fields (all optional, all backward-compat defaults)"
  - "UserPreferences parallel-shape mirror (required for Required<UserPreferences> in getResolvedPreferences / getSessionMasterPreferences)"
  - "validateSettingsPatch arms for sourceOfTruth (enum), dualWrite (boolean), cutoverAt (Date.parse-validated ISO-8601)"
  - "DEFAULT_PREFERENCES extended with sourceOfTruth='postgres', dualWrite=false, cutoverAt=''"
  - "getCampaignSettings + getResolvedPreferences return shapes updated with the three new Required<...> fields"

affects:
  - 03-A-10 (wire-dual-writer-in-turn-route — consumes resolveDualWrite to gate the DualWriter.applyEvent fan-out)
  - 03-B-02 (cutover-script — consumes resolveSourceOfTruth + sets cutoverAt via validateSettingsPatch)
  - 03-B-07 (snapshot-pivot — consumes resolveSourceOfTruth to branch buildClientSnapshot reads)

tech-stack:
  added: []
  patterns:
    - "Parallel-shape resolver pattern (Phase 01 masterBackend + Phase 02 vaultMutations) extended to a 3rd flag triplet — same env-override → stored-wins → static-default cascade for sourceOfTruth; deliberately divergent for dualWrite (no env override)"
    - "Audit-only string field (cutoverAt) validated via Date.parse — first non-boolean / non-enum settings field added since Phase 02"
    - "ISO-8601 timestamp as JSONB-stored audit field — survives drizzle round-trip, validates without `Date` object coercion"

key-files:
  created:
    - tests/lib/preferences-source-of-truth.test.ts
    - tests/lib/preferences-dual-write.test.ts
  modified:
    - src/db/schema/campaigns.ts
    - src/db/schema/users.ts
    - src/lib/preferences.ts
    - .planning/phases/03-migration-cutover/deferred-items.md

key-decisions:
  - "dualWrite has NO env override — operator-set per campaign only. Phase 02 vaultMutations and Phase 01 masterBackend both have env defaults; dualWrite deliberately diverges from the parallel-shape pattern because an env-wide DUAL_WRITE=true would risk accidentally enabling the Promise.all([vault, postgres]) fan-out on every campaign at once. The resolver test stubs DUAL_WRITE + MASTER_DUAL_WRITE to lock this in (orphaned env vars MUST NOT be consulted)."
  - "cutoverAt validation uses Date.parse(string) + isNaN check — accepts the full ISO-8601 set (Z suffix, offset, fractional seconds) without taking a `Date` dependency or rolling a regex. Matches the parser the cutover script will use to enforce CUTOVER_ROLLBACK_HOURS."
  - "Default cutoverAt is empty string '' (not undefined or null) — Required<CampaignSettings> requires a non-undefined value, and '' round-trips through Date.parse-as-invalid harmlessly (the cutover script checks for truthy first). Avoids both the Required<> typecheck escape hatch and a sentinel-magic-value pattern."
  - "Tasks 1 + 2 committed atomically as feat(phase-03) instead of splitting because settings-client.tsx references Required<CampaignSettings> — extending CampaignSettings alone would break typecheck (intermediate broken commit). Tasks 3 + 4 split as separate test commits per the per-test-file convention Phase 01 + Phase 02 established."

patterns-established:
  - "Parallel-shape resolver triplet pattern — 3rd flag triplet (sourceOfTruth + dualWrite + cutoverAt) extending the Phase 01 masterBackend + Phase 02 vaultMutations precedent. Future flag triplets (eg. legacyTableRetention in Phase 04) should follow the same shape: type alias + isXxx type guard + envDefaultXxx (when env override is desired) + resolveXxx + DEFAULT_PREFERENCES entry + validateSettingsPatch arm + UserPreferences parallel-shape mirror + getCampaignSettings/getResolvedPreferences return-shape entry."
  - "Operator-only-per-campaign opt-in — when a flag's accidental global-enable could cause catastrophic divergence (dualWrite), the resolver MUST NOT consult env. Lock this in with explicit env-stubbing test assertions."

requirements-completed: [REQ-006]

duration: 7min
completed: 2026-05-26
---

# Phase 03 Plan B-01: sourceOfTruth + dualWrite Settings Fields Summary

**Three new CampaignSettings fields (sourceOfTruth: 'postgres' | 'vault', dualWrite: boolean, cutoverAt: string) plus their resolver / validator / default infrastructure — the cutover flag triplet that plan 03-A-10 (dual-write dispatch gate), plan 03-B-02 (cutover script), and plan 03-B-07 (snapshot read pivot) all consume.**

## Performance

- **Duration:** 7 min 8s
- **Started:** 2026-05-26T20:47:05Z
- **Completed:** 2026-05-26T20:54:13Z
- **Tasks:** 4
- **Files modified:** 4 (2 created, 2 modified — plus deferred-items.md operational note)

## Accomplishments

- Extended `CampaignSettings` with `sourceOfTruth`, `dualWrite`, and `cutoverAt` fields — all optional, all backward-compatible (default to `'postgres'` / `false` / `''`).
- Mirrored the three fields on `UserPreferences` following the Phase 01 `masterBackend` + Phase 02 `vaultMutations` parallel-shape precedent — required for `Required<UserPreferences>` type compatibility.
- Added `resolveSourceOfTruth(stored)` resolver (env override → stored-wins → 'postgres' default), `resolveDualWrite(settings)` resolver (NO env override — operator-only per campaign), `isSourceOfTruth` type guard, and `SourceOfTruth` type alias.
- Added `validateSettingsPatch` arms for all three fields, including `Date.parse`-based ISO-8601 validation for `cutoverAt`.
- Extended `DEFAULT_PREFERENCES`, `getCampaignSettings`, and `getResolvedPreferences` so the three new fields are present in every `Required<CampaignSettings>` / `Required<UserPreferences>` shape.
- Shipped 68 new test cases across two new test files (43 sourceOfTruth + 25 dualWrite) — all passing, no regressions to the 44 Phase 01 + Phase 02 preference tests.

## Task Commits

Each task was committed atomically:

1. **Task 1 + Task 2 (atomic): Add sourceOfTruth/dualWrite/cutoverAt to CampaignSettings + UserPreferences + resolvers + validators + defaults** — `feb502d` (feat)
   - Tasks 1 + 2 combined because Task 1 alone (schema-only) would break `pnpm typecheck` on the downstream `Required<CampaignSettings>` consumer (`settings-client.tsx`). Standard atomic-commit-must-compile rule.
2. **Task 3: Write tests/lib/preferences-source-of-truth.test.ts** — `443e6f5` (test) — 43 cases / 36 describe+it blocks (>= 15 required).
3. **Task 4: Write tests/lib/preferences-dual-write.test.ts** — `4cf76c7` (test) — 25 cases / 30 describe+it blocks (>= 10 required).

_Note: a sibling wave-1 agent's commit (`f5fb6bc` — drizzle migration 0037) landed between my Task 3 and Task 4 commits. Unrelated; no merge conflict with my files._

## Files Created/Modified

- `src/db/schema/campaigns.ts` — Added `sourceOfTruth?`, `dualWrite?`, `cutoverAt?` optional fields to `CampaignSettings` interface (42 LOC added, all JSDoc-cross-referenced to consuming plans).
- `src/db/schema/users.ts` — Mirrored the same three fields on `UserPreferences` (27 LOC added, all marked "campaign-only; never read directly by code").
- `src/lib/preferences.ts` — Added `SourceOfTruth` type, `isSourceOfTruth` guard, `envDefaultSourceOfTruth`, `resolveSourceOfTruth`, `resolveDualWrite`, three new `validateSettingsPatch` arms, three new `DEFAULT_PREFERENCES` entries, three new return-shape entries in both `getCampaignSettings` and `getResolvedPreferences` (122 LOC added).
- `tests/lib/preferences-source-of-truth.test.ts` — NEW (251 LOC, 43 cases).
- `tests/lib/preferences-dual-write.test.ts` — NEW (225 LOC, 25 cases).
- `.planning/phases/03-migration-cutover/deferred-items.md` — Appended re-confirmation note that the pre-existing repo-wide merge conflicts also surfaced during this plan's typecheck (sibling 03-B-03 + 03-A-05 agents already triaged; same workaround applied — filtered grep proves zero new errors in the four files plan 03-B-01 touches).

## Decisions Made

- **dualWrite has NO env override** (rejected `DUAL_WRITE=true` and `MASTER_DUAL_WRITE=true` as resolver inputs). Phase 02's `vaultMutations` and Phase 01's `masterBackend` both have env-default cascades; `dualWrite` deliberately diverges because an env-wide enable would risk accidentally turning on the dual-write fan-out across every campaign. Test `does NOT consult env vars (operator-set per campaign only)` stubs both env vars and asserts the resolver still returns `false`.
- **`cutoverAt` validator uses `Date.parse` + `isNaN`** instead of a regex. Accepts the full ISO-8601 set (Z suffix, +HH:MM offset, fractional seconds) without taking a `Date` dependency. Matches the parser the cutover script (plan 03-B-02) will use to enforce the `CUTOVER_ROLLBACK_HOURS` window.
- **Default `cutoverAt` is empty string `''`** (not `undefined` or `null`). `Required<CampaignSettings>` requires a non-undefined value, and the cutover script will check for truthy first, so `''` is the cleanest default that round-trips through `Date.parse` as invalid harmlessly.
- **Tasks 1 + 2 committed atomically as one `feat()` commit.** Splitting them would have broken typecheck on the intermediate commit (`settings-client.tsx` references `Required<CampaignSettings>` and was missing the three new required fields). Standard atomic-commit-must-compile rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-existing repo-wide unresolved merge conflicts blocked the standard commit flow**

- **Found during:** Task 1 + Task 2 (verify `pnpm typecheck` step).
- **Issue:** `pnpm typecheck` failed with 48 `TS1185 Merge conflict marker encountered` errors across 9 unrelated files (`system-prompt.ts`, `tool-loop.ts`, `game-client.tsx`, `turn/route.ts`, `derive.ts`, `equipment.ts`, `handlers.ts`, `snapshot.ts`, `validate.test.ts`). Additionally, `git ls-files -u` showed stage-1/2/3 entries for 10 files (incl. `use-turn-stream.ts`) with NO `.git/MERGE_HEAD`. This blocked the standard `git commit` path because git refuses commits while the index has unmerged entries.
- **Fix:** Used `git commit --only <files>` to commit ONLY my three modified files (`campaigns.ts` + `users.ts` + `preferences.ts`), which git allowed despite the unrelated unmerged paths (it prints `<file>: needs merge` warnings but still creates the partial commit when explicit pathspecs are passed via `-o`). NON-destructive — zero `git rm`, zero `git clean`, zero `git reset --hard`, zero `git update-ref` of protected branches. The unmerged paths remain unmerged in the working tree exactly as before.
- **Files modified:** none (workaround uses git plumbing only).
- **Verification:** filtered `pnpm typecheck 2>&1 | grep -E "(db/schema/(campaigns|users)|lib/preferences|settings-client)"` returns zero output — zero new typecheck errors in the four files this plan affects. `git diff --diff-filter=D --name-only HEAD~3 HEAD` returns empty — zero unintended deletions across all three commits. Sibling 03-B-03 and 03-A-05 agents previously triaged the same state with the same workaround (documented in `deferred-items.md`).
- **Committed in:** N/A (the workaround is a commit-mechanism change, not a code change).

**2. [Rule 2 - Critical] Extended `getResolvedPreferences` return shape with the three new fields**

- **Found during:** Task 2 (Change 5 in the plan only explicitly extended `getCampaignSettings`, but `getResolvedPreferences` returns `Required<UserPreferences>` and the new fields are on `UserPreferences`).
- **Issue:** Without extending `getResolvedPreferences`, `pnpm typecheck` would fail with `Type ... is missing the following properties from type 'Required<UserPreferences>': sourceOfTruth, dualWrite, cutoverAt`. This was a critical correctness gap, not a feature addition.
- **Fix:** Added `sourceOfTruth: resolveSourceOfTruth(prefs.sourceOfTruth)`, `dualWrite: resolveDualWrite(prefs)`, `cutoverAt: prefs.cutoverAt ?? DEFAULT_PREFERENCES.cutoverAt` to the `getResolvedPreferences` return object, each with a JSDoc note that the user-side resolution is parallel-shape only and never consulted at runtime.
- **Files modified:** `src/lib/preferences.ts`.
- **Verification:** typecheck of the touched files passes (filtered grep confirms zero new errors); the 4 existing Phase 01 + Phase 02 preference tests still pass.
- **Committed in:** `feb502d` (part of Task 1 + Task 2 atomic commit).

---

**Total deviations:** 2 auto-fixed (1 blocking commit-mechanism workaround, 1 critical correctness fix).
**Impact on plan:** Both auto-fixes were essential to complete the plan as specified. No scope creep. The commit-mechanism workaround is operationally noted in `deferred-items.md`; the `getResolvedPreferences` extension is a logical-extension of the plan's Change 5 ("Add corresponding parallel-shape on UserPreferences if such a mirror exists") — the plan's text just didn't spell out the resolver wiring for the user side.

## Issues Encountered

- **Pre-existing repo merge state** (see Deviation #1 above) — surfaced as a Rule 3 blocking issue but did not require any code change to resolve; standard git plumbing (`commit --only`) bypassed it without touching the unrelated unmerged paths.

## Self-Check: PASSED

Verification commands run after writing this SUMMARY:

- `git rev-parse --verify feb502d` → OK (Task 1+2 commit exists)
- `git rev-parse --verify 443e6f5` → OK (Task 3 commit exists)
- `git rev-parse --verify 4cf76c7` → OK (Task 4 commit exists)
- `[ -f src/db/schema/campaigns.ts ]` → FOUND (Task 1)
- `[ -f src/db/schema/users.ts ]` → FOUND (Task 1)
- `[ -f src/lib/preferences.ts ]` → FOUND (Task 2)
- `[ -f tests/lib/preferences-source-of-truth.test.ts ]` → FOUND (Task 3)
- `[ -f tests/lib/preferences-dual-write.test.ts ]` → FOUND (Task 4)
- `grep -c "'postgres'" src/lib/preferences.ts` → 9 (contract required >= 2)
- `grep -cE "sourceOfTruth\|dualWrite\|cutoverAt" src/db/schema/campaigns.ts` → 11 (acceptance required >= 3)
- `grep -cE "resolveSourceOfTruth\|resolveDualWrite\|SourceOfTruth\|isSourceOfTruth" src/lib/preferences.ts` → 15 (acceptance required >= 4)
- `pnpm test tests/lib/preferences-master-backend.test.ts tests/lib/preferences-vault-mutations.test.ts tests/lib/preferences-source-of-truth.test.ts tests/lib/preferences-dual-write.test.ts` → 112 passed / 0 failed across 4 files

## Next Phase Readiness

- Plan 03-A-10 (`wire-dual-writer-in-turn-route`) can now import `resolveDualWrite` from `@/lib/preferences` and gate the `DualWriter.applyEvent` Promise.all fan-out on `resolveDualWrite(campaignSettings)`.
- Plan 03-B-02 (`cutover-script`) can now import `resolveSourceOfTruth` for reads, mutate `campaignSettings.sourceOfTruth + cutoverAt` via the validated `updateCampaignSettings` path, and use the `CUTOVER_ROLLBACK_HOURS` env to enforce the reversibility window.
- Plan 03-B-07 (`snapshot-pivot`) can branch `buildClientSnapshot` reads on `resolveSourceOfTruth(campaign.settings) === 'vault'`.
- The drizzle schema change is additive (optional fields in the existing `settings` jsonb column) — no migration file required; the existing `0031` backfill migration shape is preserved.
- Pre-existing repo merge state is a STANDING blocker that should be resolved by the operator before merging the next round of waves. Documented in `deferred-items.md` — not within any single agent's scope to fix.

---
*Phase: 03-migration-cutover*
*Plan: B-01*
*Completed: 2026-05-26*
