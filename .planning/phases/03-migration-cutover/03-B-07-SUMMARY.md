---
phase: 03-migration-cutover
plan: B-07
subsystem: sessions
tags: [sessions, client-snapshot, source-of-truth, pivot, cutover, vault, materialize, postgres-fallback]

requires:
  - phase: 03-migration-cutover
    plan: B-01
    provides: resolveSourceOfTruth resolver + SourceOfTruth type + CampaignSettings.sourceOfTruth field
  - phase: 03-migration-cutover
    plan: B-06
    provides: materializeFromVault(campaignId, characterId, sessionId) translator returning Partial<SessionState> | null

provides:
  - "buildClientSnapshot sourceOfTruth pivot — when campaign.settings.sourceOfTruth === 'vault' AND the viewer has a campaign-instance character, the snapshot's `state` field is materialized from events.md replay instead of read from session_state"
  - "Defensive Postgres fallback — null/throw from materializeFromVault, missing viewerCharacterId, or absent campaign all fall back to the existing Postgres path; UI never breaks during a half-flipped state"
  - "Snapshot shape stability — every path returns the same envelope keys (session, campaign, state, character, actors, party, currentPlayerCharacterId, viewerCharacterId) with the same SessionState column set; UI consumers don't need branch-specific code"
  - "13 test cases covering 7 scenarios (~520 LOC tests) — postgres default, postgres explicit, postgres-with-stale-vault, vault materialization (3 sub-cases), 4 fallback paths, end-to-end pivot proof, shape stability"

affects:
  - "Phase 03 sub-phase B (cutover) — closes the snapshot-READ half. Together with plan 03-A-10 (dual-write) and plan 03-B-02 (vault-cutover script), this completes the migration boundary for read+write pivots."
  - "All callers of buildClientSnapshot (/api/sessions/[id] GET + /api/sessions/[id]/stream SSE init) — both routes now consume the pivot transparently because the function signature and return shape are unchanged."

tech-stack:
  added: []
  patterns:
    - "Source-of-truth pivot at the read boundary — first such pivot in the codebase. Pattern: resolve a campaign-level flag → branch ON the resolved value → defensive fallback to legacy path on any signal (null return, throw, missing viewer character). Convention: the pivot lives at the BOUNDARY where the caller demands a specific shape; the translator owns the shape conversion."
    - "Defensive try/catch around the new path — when integrating a brand-new read source into an existing function, wrap the new call in try/catch + console.warn so a vault read bug doesn't break the entire snapshot (the UI loses everything if the function throws). Logs the error for ops visibility, falls through to the proven Postgres path."
    - "DB-gated test pattern with raw-SQL fixture — mirrors tests/sessions/dual-writer.test.ts. Uses (HAS_DB ? describe : describe.skip), inserts characters/sessions via raw SQL to bypass the broken saveCharacter pipeline (tracked in deferred-items.md), and pre-stubs VAULT_CAMPAIGNS_ROOT before importing the module under test."

key-files:
  created:
    - tests/sessions/client-snapshot-pivot.test.ts
  modified:
    - src/sessions/client-snapshot.ts

key-decisions:
  - "Pivot gate condition is (sourceOfTruth === 'vault' AND campaign AND viewerCharId) — three preconditions ANDed. campaign comes from the leftJoin (legacy single-character sessions without a campaignId stay on Postgres). viewerCharId requires a campaign-instance match (templateId IS NOT NULL + userId match); spectators and legacy sessions fall back. Reason: materializeFromVault needs a characterId to look up in the seed map; without the viewer's own campaign-instance, we have no good candidate (the host's character may not be in the vault seed)."
  - "Vault read errors are caught + logged + fall through, NOT re-thrown — the original buildClientSnapshot contract is `state: SessionState | null`. If the vault path throws (corrupted events.md, unexpected reducer state, FS error), the snapshot must STILL load from Postgres so the UI keeps working. The console.warn provides ops visibility; the Postgres fallback provides correctness."
  - "Drizzle `[state] = await db.select()` returns `T | undefined` on 0 rows — coerced to null via `?? null` to keep the snapshot's `state` field in its documented `SessionState | null` shape. The original code relied on TypeScript inferring `state` as the row union type but the new explicit `let state: SessionState | null` declaration surfaced the mismatch. Fix: destructure as `pgState`, then assign `state = pgState ?? null`."
  - "Test file uses raw-SQL inserts for characters — the broken saveCharacter pipeline is a known issue tracked in deferred-items.md (cross-plan, same workaround tests/sessions/dual-writer.test.ts uses). Raw SQL writes every required column explicitly; the alternative would be fixing the merge-conflict-broken saveCharacter pipeline, which is out of scope for this plan."
  - "FK order: campaigns row inserted BEFORE characters with campaign_id FK — the initial test draft inserted characters first, hitting a `characters_campaign_id_campaigns_id_fk` violation. Fix is purely fixture-ordering and unrelated to the pivot logic."
  - "The shape-stability test asserts top-level Object.keys equality AND a per-column subset check on the state field — top-level proves the snapshot envelope is identical across paths; the state-column check proves the translator emits every Postgres column the UI's SessionStateRow consumer reads. Stronger than a single `toEqual` because it tolerates the legitimate value differences (hp_current=20 vault vs 25 postgres) while catching shape drift."

patterns-established:
  - "Source-of-truth pivot — first instance in the codebase. Future cutovers (e.g., Phase 04 codex read pivot, party-roster read pivot) should follow the same structure: campaign-resolved flag → try new path → fall back to legacy path on null/throw/missing-precondition. The fallback path MUST be the existing legacy code path with zero changes — that's what guarantees backward compatibility."
  - "Stale-vs-current value test — the strongest assertion that the pivot fires end-to-end is to set Postgres to value A and vault to value B (A ≠ B) and assert the snapshot returns B when sourceOfTruth=vault. This proves the pivot is not silently reading Postgres twice. Adopt this pattern for any future read pivot tests."

requirements-completed: [REQ-006]

duration: ~25min
completed: 2026-05-27
---

# Phase 03 Plan B-07: buildClientSnapshot Pivot Summary

**`buildClientSnapshot` now branches on `campaign.settings.sourceOfTruth`: when 'vault' AND the viewer has a campaign-instance character, the snapshot's `state` field is materialized from events.md replay via `materializeFromVault` instead of reading `session_state` from Postgres. All other fields (session, campaign, character, actors, party, currentPlayerCharacterId, viewerCharacterId) keep reading from Postgres; the snapshot shape is identical across paths so UI consumers need zero changes.**

## Performance

- **Duration:** ~25 min (Tasks 1 + 2 + summary, single agent, main repo)
- **Started:** 2026-05-27T08:17Z (approx — first plan Read)
- **Completed:** 2026-05-27T08:42Z
- **Tasks:** 2
- **Files created:** 1 (`tests/sessions/client-snapshot-pivot.test.ts`, 521 LOC)
- **Files modified:** 1 (`src/sessions/client-snapshot.ts`, +62 LOC, 79 → 141 LOC)
- **Test runtime:** 17.31s for the new pivot test (13/13 passing, DB-gated; under the 20s plan budget)
- **Regression tests:** snapshot.test.ts (6 cases), vault-mutations-gate.test.ts (16 cases), vault-mutations-resume.test.ts (11 cases), and snapshot-reader.test.ts (21 cases) all pass — 54 sibling tests verified.

## Accomplishments

- Modified `src/sessions/client-snapshot.ts` to add the Phase 03-B (Decision 4) sourceOfTruth pivot. The function now imports `resolveSourceOfTruth` from `@/lib/preferences` and `materializeFromVault` from `@/ai/master/vault/snapshot-reader`. When the resolver returns `'vault'` AND the viewer has a campaign-instance character AND the campaign row exists, the function calls `materializeFromVault(campaign.id, viewerCharId, sessionId)` and uses the returned `Partial<SessionState>` as the snapshot's `state` field. The cast to `SessionState` is safe because the translator emits explicit defaults for every Postgres column (verified by plan 03-B-06's UI-only field tests).
- The pivot is wrapped in try/catch: if `materializeFromVault` throws (corrupted events.md, unexpected reducer state, FS error), the snapshot logs a `console.warn` and falls through to the Postgres read. This preserves the UI's ability to render even when the vault is in a half-flipped state.
- When `materializeFromVault` returns `null` (events.md missing, empty file, or character not in seed), the function falls through to the same Postgres read. The vault-cutover script (plan 03-B-02) guarantees this state shouldn't arise post-flip, but the safety net is essentially free and avoids surprising UI breakage during operator error.
- Drizzle's `[state] = await db.select()...limit(1)` returns `T | undefined`; coerced explicitly to `null` so the snapshot's `state` field stays in its documented `SessionState | null` shape. This is a minor cleanup the pivot uncovered (the original implicit narrowing relied on the absence of an explicit `state` declaration).
- Shipped `tests/sessions/client-snapshot-pivot.test.ts` with 13 cases across 7 scenarios: (a) Postgres default + explicit + with-stale-vault-present, (b) vault materialization fires (3 sub-cases including hp_change event projection + sessionId echo), (c) vault fallback on missing events.md, (d) vault fallback on character-not-in-seed + empty events.md, (e) vault fallback when the viewer has no campaign-instance character (spectator case), (f) end-to-end pivot proof (Postgres hp=25 vs vault hp=12, snapshot returns 12), (g) snapshot shape unchanged across paths (top-level envelope keys + state column subset).
- DB-gated via `(HAS_DB ? describe : describe.skip)` — skips cleanly when DATABASE_URL is absent. Raw-SQL fixture inserts bypass the broken saveCharacter pipeline (cross-plan known issue, tracked in deferred-items.md). VAULT_CAMPAIGNS_ROOT is stubbed via `vi.stubEnv` BEFORE the dynamic imports inside beforeAll, exactly matching the pattern in tests/sessions/dual-writer.test.ts.

## Files

### Created

- `tests/sessions/client-snapshot-pivot.test.ts` (521 LOC) — 13 cases / 7 scenarios

### Modified

- `src/sessions/client-snapshot.ts` (79 → 141 LOC; +62 LOC) — added 2 imports, expanded JSDoc with Phase 03-B section, added the sourceOfTruth pivot branch with try/catch + console.warn, wrapped the Postgres read in `if (!state)` so it serves both the default path and the vault fallback

## Verification

- `pnpm typecheck` → exits 0 (the function modifications compile cleanly; the only remaining errors at one point were sibling Wave 5b loop.ts WIP edits, which resolved when 03-B-05 committed 9955867)
- `grep -c "resolveSourceOfTruth\|materializeFromVault" src/sessions/client-snapshot.ts` → 7 (well above the >=2 plan requirement)
- `pnpm test tests/sessions/client-snapshot-pivot.test.ts` (with DATABASE_URL) → 13/13 pass in 17.31s
- `pnpm test tests/sessions/snapshot.test.ts` (regression) → 6/6 pass
- `pnpm test tests/sessions/vault-mutations-gate.test.ts tests/sessions/vault-mutations-resume.test.ts` (regression) → 27/27 pass
- `pnpm test tests/ai/master/vault/snapshot-reader.test.ts` (Wave 5a regression) → 21/21 pass

## Commits

- `8d9ede0` — `feat(phase-03): pivot buildClientSnapshot to vault when sourceOfTruth='vault'` (Task 1 — implementation)
- `1a147d9` — `test(phase-03): cover buildClientSnapshot sourceOfTruth pivot end-to-end` (Task 2 — 13 test cases / 7 scenarios)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Drizzle destructured row was `T | undefined`, not `T | null`**

- **Found during:** Task 1 typecheck
- **Issue:** With the explicit `let state: SessionState | null` declaration, `[state] = await db.select()...limit(1)` failed to typecheck because Drizzle's destructure produces `SessionState | undefined` when no rows match. The implicit narrowing in the original code masked this because there was no explicit `null` union.
- **Fix:** Destructure into `pgState`, then `state = pgState ?? null`. Keeps the snapshot's `state` field in its documented `SessionState | null` shape and explicitly handles the 0-row case.
- **Files modified:** `src/sessions/client-snapshot.ts`
- **Commit:** `8d9ede0` (included in Task 1)

**2. [Rule 3 - Blocking] Test fixture FK order violation**

- **Found during:** Task 2 first test run (DATABASE_URL provided locally)
- **Issue:** `INSERT INTO characters` ran before `INSERT INTO campaigns`, hitting `characters_campaign_id_campaigns_id_fk` violation.
- **Fix:** Reordered fixture inserts to users → campaigns → characters → sessions → session_state. Pure fixture ordering, unrelated to the pivot logic.
- **Files modified:** `tests/sessions/client-snapshot-pivot.test.ts`
- **Commit:** `1a147d9` (included in Task 2)

### Out-of-scope discoveries (NOT auto-fixed)

- **Wave 5b in-progress edits to `src/ai/master/vault/loop.ts` produced typecheck noise mid-execution** — During Task 1's typecheck, 4 unused-import errors appeared in `loop.ts` (the sibling Wave 5b agent for plan 03-B-05 was adding `maybeCondense` wiring concurrently). The errors resolved without my intervention when 03-B-05 committed `9955867` between my Task 1 and Task 2. No action taken from this plan; sibling self-resolved per parallelization contract.
- **Sibling test file `tests/ai/master/vault/loop.test.ts` shows as modified in `git status`** — Same Wave 5b origin, not part of this plan's scope.

## Self-Check: PASSED

- File `src/sessions/client-snapshot.ts` exists and contains the pivot logic (`grep` returns 7 matches for `resolveSourceOfTruth|materializeFromVault`).
- File `tests/sessions/client-snapshot-pivot.test.ts` exists at 521 LOC.
- Commit `8d9ede0` present in `git log --oneline`.
- Commit `1a147d9` present in `git log --oneline`.
- All 13 pivot tests pass under DATABASE_URL.
- All 54 sibling regression tests pass.
