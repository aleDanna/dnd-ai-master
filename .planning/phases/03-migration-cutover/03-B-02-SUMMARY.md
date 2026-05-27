---
phase: 03-migration-cutover
plan: B-02
subsystem: infra
tags: [cli, vault, cutover, source-of-truth, rollback-window, audit-log, drizzle, vitest, spawn-sync]

requires:
  - phase: 02-vault-write-path-event-sourcing
    provides: scripts/vault-flip.ts CLI template (short-prefix UUID resolver + listCampaigns + _env-loader pattern)
  - phase: 03-migration-cutover
    provides:
      - 03-A-06 vault-flip-helpers.ts (flipSourceOfTruth — defensive helper with vault-target preconditions + cutoverAt stamping)
      - 03-B-01 sourceOfTruth + dualWrite + cutoverAt fields in CampaignSettings; resolveSourceOfTruth resolver
      - 03-A-07 migrate-campaigns-to-vault.test.ts (spawnSync CLI test pattern + DATABASE_URL skip-gate + tmpdir fixture)

provides:
  - "pnpm vault:cutover --id=<short|full-uuid> CLI — flips sourceOfTruth: postgres → vault, stamps cutoverAt, writes audit JSON"
  - "pnpm vault:cutover --id=<...> --rollback CLI — flips back to postgres if within CUTOVER_ROLLBACK_HOURS window (default 24h)"
  - "pnpm vault:cutover (no args) — lists campaigns with sourceOfTruth + cutoverAt + rollback eligibility column"
  - "pnpm vault:cutover --id=<...> --dry-run — previews flip without touching DB or audit dir"
  - "Per-campaign cutover audit log at .planning/phases/03-migration-cutover/cutover-audit/<id-prefix>-<iso-ts>.json"
  - "CUTOVER_AUDIT_DIR env override (testable sandbox); CUTOVER_ROLLBACK_HOURS env override (operator extends window)"
  - "Defensive preconditions for forward cutover: masterBackend=vault AND vaultMutations=true AND dualWrite=true (REFUSED with operator-friendly error otherwise)"

affects:
  - 03-D-XX (final-m4-sweep — operator uses pnpm vault:cutover to flip the smoke campaign before running pnpm bench-phase-03-m4)
  - Phase 04+ (post-rollback-window decommission — operators rely on the audit log to confirm which campaigns are safely past their window before running the legacy-table drop migration)
  - Operator runbooks (docs/operators/) — cutover + rollback procedures now have a single named CLI surface instead of `pnpm vault:flip --source-of-truth=vault` (which remains as a low-level escape hatch for power users)

tech-stack:
  added: []
  patterns:
    - "Tiered CLI shape — no args (list mode) | --id only (mutation) | --id + --rollback (reversal) | --id + --dry-run (preview) — mirrors `scripts/vault-flip.ts` operator UX so a user familiar with one knows the other"
    - "Audit-file write co-located with the operation it records — JSON entry per CLI invocation (not append-only log) keeps each invocation's audit grep-able by filename timestamp prefix"
    - "Env-tunable policy windows (CUTOVER_ROLLBACK_HOURS) enforced AT THE CLI layer, NOT the helper — Decision 5 explicit separation so the helper stays a pure flag-flipper and the policy stays operator-adjustable per invocation"
    - "spawnSync CLI test pattern with CUTOVER_AUDIT_DIR=tmpdir env injection — extends the migrate-campaigns-to-vault.test.ts shape; per-test setCampaignSettings reset bypasses the script (direct db.update) so each scenario starts from a known baseline without depending on previous test ordering"

key-files:
  created:
    - scripts/vault-cutover.ts
    - tests/scripts/vault-cutover.test.ts
  modified:
    - package.json

key-decisions:
  - "Forward-cutover preconditions enforced UP-FRONT in the CLI BEFORE invoking flipSourceOfTruth, NOT just by the helper. The helper throws too (vault-flip-helpers.ts is the contract surface for direct callers), but the CLI gates on the THREE-flag set (masterBackend, vaultMutations, dualWrite) while the helper currently gates on only the first two. The dualWrite gate is in the CLI because dualWrite is a Decision-2 coexistence-policy gate (operator-facing semantics), whereas the helper's two gates are structural (can the JSONB flip even make sense). Adding dualWrite to the helper would couple cutover policy into the helper module, which the migration script (Phase 03-A) does NOT want to inherit."
  - "Audit-file directory is configurable via CUTOVER_AUDIT_DIR env, defaulting to .planning/phases/03-migration-cutover/cutover-audit/. The plan template said the default path is fixed; the env override was added for test isolation (tests cannot pollute the in-repo .planning/ dir with per-suite audit JSONs that would accumulate over CI runs). Production operators leave the default — it's the only place the audit JSONs are committed against the phase directory for the audit trail."
  - "Idempotent no-op when sourceOfTruth already matches target — the script returns exit 0 with a 'no-op' line and does NOT write an audit JSON. Rationale: an operator who hits the same campaign twice during a cutover sweep shouldn't double-log; only state TRANSITIONS get audited. Matches the helper's `changed: false` contract."
  - "Short-prefix UUID resolution (8 chars or longer) is shared verbatim with vault-flip.ts via the same `${campaigns.id}::text LIKE` sql template. Operators can type `pnpm vault:cutover --id=abc12345` against the same id prefix they used for `pnpm vault:flip --id=abc12345`. No new disambiguation rules — same 'exactly-one-match' policy with `process.exit(2)` on zero or multiple matches."
  - "Test runtime budget — the 11-case suite runs in 21s vs the 30s plan budget. Each test uses a fresh setCampaignSettings to reset the fixture so all 11 can run sequentially without DB cleanup between them; the afterAll wipes all rows for the per-suite tag (cutovertest<timestamp>) on completion."

patterns-established:
  - "CLI policy gates live in the CLI, not the helper — when a precondition is operator-facing (eg. coexistence-window enforcement), the CLI gates first with a friendly error message. The helper still throws as a structural defense, but the message uses the SAME wording the CLI gate uses so a programmatic caller and an operator see consistent diagnostics."
  - "Audit-log dir as env-overridable default — production-default path lives in the phase directory; tests inject a tmpdir via env so they can assert against listAuditFiles() without polluting the repo. Future CLI scripts that need audit trails should follow this pattern: const dir = process.env.<NAME>_DIR?.trim() || DEFAULT_DIR; mkdirSync(dir, {recursive: true}); writeFileSync(join(dir, ...), ...)"
  - "spawnSync CLI test fixture isolation via per-test reset — direct db.update bypasses the script for state setup so each test's preconditions are explicit; the script under test only ever sees the assert-target state. Avoids the migrate-campaigns test's reliance on test-order (which would also work but is fragile)."

requirements-completed: [REQ-006]

duration: 8min
completed: 2026-05-27
---

# Phase 03 Plan B-02: Cutover Script Summary

**Operator-facing CLI (`pnpm vault:cutover`) that flips campaign sourceOfTruth between 'postgres' and 'vault' with defensive preconditions, audit logging, and a CUTOVER_ROLLBACK_HOURS rollback window — wraps the Phase 03-A-06 `flipSourceOfTruth` helper with policy enforcement.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-27T08:18:36Z
- **Completed:** 2026-05-27T08:26:30Z
- **Tasks:** 3
- **Files modified:** 3 (2 new, 1 edited)

## Accomplishments

- New CLI `pnpm vault:cutover` shipped with five operator modes (list, cutover, rollback, dry-run, help) and prefix UUID resolution shared with `vault:flip`
- Three-flag forward-cutover precondition (`masterBackend=vault` AND `vaultMutations=true` AND `dualWrite=true`) enforced with operator-friendly REFUSED error pointing at the exact prior CLI to run
- `CUTOVER_ROLLBACK_HOURS` (default 24) window enforcement with explicit override-hint when expired; `CUTOVER_AUDIT_DIR` env knob added for test isolation
- Per-invocation audit JSON written to `.planning/phases/03-migration-cutover/cutover-audit/<id-prefix>-<iso-ts>.json` with the full audit record (action, previousSourceOfTruth, newSourceOfTruth, timestamp, operator, cutoverAtRecorded, rollbackWindowHours)
- 11 spawnSync-based tests covering every branch: happy path, three precondition REFUSALs, idempotent no-op, rollback within window, rollback past window, rollback respecting env override, dry-run no-mutation, missing-id usage hint, no-args list mode

## Task Commits

Each task was committed atomically:

1. **Task 1: Write scripts/vault-cutover.ts** — `868a80a` (feat)
2. **Task 2: Add vault:cutover to package.json** — `23cc48f` (chore — also re-alphabetized the vault:* script block)
3. **Task 3: Write tests/scripts/vault-cutover.test.ts** — `f6c1d24` (test)

_Wave 5a sibling commits (03-B-04, 03-B-06) interleaved on `main` between Task 2 and Task 3 — disjoint scope, no conflict._

## Files Created/Modified

- `scripts/vault-cutover.ts` (NEW, 395 LOC) — operator CLI; parseArgs + listCampaigns + resolveCampaignId + 3-flag precondition gates + rollback window enforcement + audit-file writer; single named call to `flipSourceOfTruth` (no inline JSONB mutation)
- `tests/scripts/vault-cutover.test.ts` (NEW, 391 LOC) — 11 spawnSync cases with per-test setCampaignSettings reset; CUTOVER_AUDIT_DIR=tmpdir for sandbox; DATABASE_URL skip-gate inherited from migrate-campaigns-to-vault.test.ts pattern
- `package.json` — added `"vault:cutover": "tsx scripts/vault-cutover.ts"` AND re-alphabetized the four vault:* entries (backup → cutover → flip → rebuild-views)

## Decisions Made

- **Forward-cutover preconditions gated UP-FRONT (3 flags) at the CLI** — the helper checks only `masterBackend` + `vaultMutations`; the CLI adds the `dualWrite=true` gate because dualWrite is operator-facing coexistence policy (Decision 2) that shouldn't pollute the helper. Both layers emit the SAME wording so direct callers and operators see consistent diagnostics.
- **Audit dir is env-overridable** — production default is `.planning/phases/03-migration-cutover/cutover-audit/`; tests inject `CUTOVER_AUDIT_DIR=<tmpdir>` to assert on `listAuditFiles()` without polluting the repo. Production operators leave the default so the per-campaign JSONs end up alongside the phase deliverables.
- **Idempotent no-op writes NO audit JSON** — only state TRANSITIONS get audited; an operator re-running the cutover on an already-cutover campaign sees the no-op line and the audit dir stays clean.
- **Test fixture isolation via direct db.update reset** — each test starts from a known baseline by bypassing the script for setup (matches `migrate-campaigns-to-vault.test.ts` reset pattern but per-test instead of per-suite). 11 cases run in 21s, well under the 30s budget.
- **Short-prefix UUID resolution reused from `vault-flip.ts`** — same `LIKE` sql template, same exit codes, same disambiguation rules. Operators can pass the same prefix they used for `pnpm vault:flip`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `dualWrite=true` to the forward-cutover precondition set**
- **Found during:** Task 1 (writing the script)
- **Issue:** The plan's task template listed only `masterBackend=vault` AND `vaultMutations=true` as preconditions. The contract from the executor prompt explicitly stated three preconditions: "campaign.settings.masterBackend === 'vault' AND campaign.settings.vaultMutations === true AND campaign.settings.dualWrite === true (must be in coexistence first)." Decision 2 in 03-RESEARCH.md confirms dualWrite IS the coexistence gate. Cutting over WITHOUT dualWrite=true means Postgres won't receive the writes that keep it as a rollback target — the very next `--rollback` would resurrect a stale Postgres state.
- **Fix:** Added the third precondition check with a tailored REFUSED message explaining the operator must enable dualWrite first.
- **Files modified:** scripts/vault-cutover.ts
- **Verification:** Test case "cutover refused — dualWrite=false" exercises this gate; passes.
- **Committed in:** 868a80a (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added `CUTOVER_AUDIT_DIR` env override**
- **Found during:** Task 1 (writing the script)
- **Issue:** The plan task 3 says "The audit-file write CAN go to a tmpdir via env override (add a `CUTOVER_AUDIT_DIR` env in the script if not present; the test stubs it)." The test (task 3) requires this env; without it, every test invocation would write JSONs into the actual repo `.planning/...` dir, polluting commits across CI runs.
- **Fix:** Added `auditDir()` resolver that reads `CUTOVER_AUDIT_DIR` with the production default as fallback.
- **Files modified:** scripts/vault-cutover.ts
- **Verification:** Test injects the env via spawnSync; assertions on `listAuditFiles()` use the tmpdir; production default is documented in `--help`.
- **Committed in:** 868a80a (Task 1 commit)

**3. [Rule 2 - Missing Critical] Added no-args list mode + prefix UUID resolution**
- **Found during:** Task 1 (writing the script)
- **Issue:** The executor contract said "`pnpm vault:cutover` (no args) → list campaigns with their sourceOfTruth + cutoverAt + rollback eligibility" and "`--id=<short|full-uuid>`" — but the plan template's draft code skeleton showed only direct `db.select().where(eq(campaigns.id, args.id))` (full-UUID-only) and `process.exit(2)` when `--id` is missing.
- **Fix:** Ported `resolveCampaignId(prefix)` verbatim from `scripts/vault-flip.ts` (same `LIKE` sql + same disambiguation exits) and added a `listCampaigns()` function that emits a table with backend, mut, dw, sot, cutoverAt, rollback-remaining columns.
- **Files modified:** scripts/vault-cutover.ts
- **Verification:** Test "no args → list mode" passes; test "missing --id with --rollback flag → exit 2" exercises the require-id branch.
- **Committed in:** 868a80a (Task 1 commit)

**4. [Rule 1 - Bug] `runCli` env override type was `NodeJS.ProcessEnv` (requires NODE_ENV)**
- **Found during:** Task 3 (post-test typecheck)
- **Issue:** TypeScript 5 strict-process-env complained that `NodeJS.ProcessEnv` requires `NODE_ENV` to be present. The test injects only `CUTOVER_ROLLBACK_HOURS` (and the spread happens INSIDE runCli) — the parameter shape `NodeJS.ProcessEnv` was overspecified.
- **Fix:** Changed parameter type to `Record<string, string>` (the spread inside the function still merges with full `process.env` so child-process env is complete).
- **Files modified:** tests/scripts/vault-cutover.test.ts
- **Verification:** `pnpm typecheck` exits 0; test suite still passes 11/11.
- **Committed in:** f6c1d24 (Task 3 commit)

**5. [Rule 1 - Bug] Re-alphabetized the entire vault:* script block in package.json**
- **Found during:** Task 2 (positioning the new entry)
- **Issue:** The plan said "Position alphabetically with the other vault:* entries (between vault:backup and vault:flip)" but the existing block was NOT alphabetized (flip → backup → rebuild-views). Inserting between backup and flip while leaving the block non-alphabetized would have been internally inconsistent.
- **Fix:** Re-ordered the four entries to backup → cutover → flip → rebuild-views (true alphabetical) in a single edit.
- **Files modified:** package.json (3 lines moved)
- **Verification:** `grep -n "vault:" package.json` shows alphabetical; `grep -c "vault:cutover"` returns 1.
- **Committed in:** 23cc48f (Task 2 commit)

---

**Total deviations:** 5 auto-fixed (3 missing-critical, 2 bug)
**Impact on plan:** Every deviation aligned the implementation with the executor contract or the test acceptance criteria as stated. No scope creep — every added behavior was either explicitly contracted (list mode, prefix UUID, audit-dir env, dualWrite precondition) or fixed a typecheck regression / package.json hygiene.

## Issues Encountered

- **DATABASE_URL skip-gate during local test execution.** Running `pnpm test tests/scripts/vault-cutover.test.ts` initially showed 11 skipped because the runner's `process.env.DATABASE_URL` is unset at module load (vitest's dotenvx auto-load fires AFTER the top-level `HAS_DB` check). Solved by injecting the real URL ahead of pnpm: `DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | sed 's/.../') pnpm test ...`. This is inherent to the shared test pattern (`tests/scripts/migrate-campaigns-to-vault.test.ts` has the same gate) and is documented in the test file's header.
- **First attempt at extracting DATABASE_URL via `node -e "require('dotenv').config(...)"` returned dotenvx's verbose banner text** (`◇ injected env (49) from .env.local //...`) instead of the URL — dotenvx hijacks `require('dotenv')`. Solved by parsing `.env.local` directly with grep + sed (no module load).

## Self-Check: PASSED

All claimed files exist on disk:
- `scripts/vault-cutover.ts` — present
- `tests/scripts/vault-cutover.test.ts` — present
- `package.json` `vault:cutover` entry — present (line 35)

All claimed commits exist in `git log --all`:
- 868a80a feat(phase-03): add vault-cutover CLI operator script
- 23cc48f chore(phase-03): wire vault:cutover script entry in package.json
- f6c1d24 test(phase-03): cover vault-cutover CLI happy paths + refusals + rollback window

## Next Phase Readiness

- **03-B-07 (snapshot-pivot)** unblocked — once the snapshot-reader consumer wires up `resolveSourceOfTruth` in `buildClientSnapshot`, this CLI is the operator handle that flips real production traffic to the vault read path.
- **03-D (final-m4-sweep)** unblocked — operator can run `pnpm vault:cutover --id=<bench-campaign>` before `pnpm bench-phase-03-m4` to measure post-cutover G1 warm latency end-to-end.
- **Operator runbook update needed** (docs/operators/) — the cutover + rollback procedures should reference `pnpm vault:cutover` as the canonical surface and reserve `pnpm vault:flip --source-of-truth=...` as a debugging escape hatch.
- **No known blockers.** The 30-day Postgres-table drop migration is OUT OF SCOPE for this plan (deferred to a Phase 04 decommission migration per Decision 5).

---
*Phase: 03-migration-cutover*
*Completed: 2026-05-27*
