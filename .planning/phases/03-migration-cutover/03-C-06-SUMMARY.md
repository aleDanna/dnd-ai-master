---
phase: 03-migration-cutover
plan: C-06
subsystem: docs+operators
tags: [operator-runbook, ollama, decommission, rag, baked-models, REQ-033, cutover, rollback]

# Dependency graph
requires:
  - phase: 01-vault-read-path
    provides: masterBackend flag pattern + vault-backend operator guide (style reference)
  - phase: 02-vault-write-path-event-sourcing
    provides: vault-backup operator runbook (style + structure reference)
  - phase: 03-migration-cutover (in-flight)
    provides: every CLI documented by this playbook (vault-cutover, migrate-campaigns-to-vault, bench-phase-03-m4, migrate-stale-userprefs)
provides:
  - End-to-end operator playbook for the Phase 03 cutover ceremony (11 numbered steps)
  - Interactive `pnpm decommission-baked` CLI — single command vs 5 manual `ollama rm` invocations
  - `decommission-baked` package.json script entry
  - 25 unit + CLI tests covering MODELS_TO_REMOVE contract, parseArgs, parseOllamaList, and CLI surface (--help, --dry-run, unknown-arg)
affects: [phase-04+ post-30d Postgres drop, future operator workflows, future regression baselines, REQ-021 closure procedure]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Operator-facing markdown playbook with numbered steps + smoke campaign references at every step (extends Phase 02 vault-backup.md structure)"
    - "Interactive CLI wrapper pattern: parseArgs / dry-run / yes / help — same shape as scripts/vault-cutover.ts (Phase 03-B-02)"
    - "Test-without-spawn: export the pure pieces (MODELS_TO_REMOVE, parseArgs, parseOllamaList) so unit tests don't need the Ollama daemon"
    - "CLI smoke tests gate by binary presence (ollamaAvailable probe) — keeps the suite green on CI hosts without Ollama"

key-files:
  created:
    - "docs/operators/phase-03-cutover.md (751 lines — END-TO-END playbook)"
    - "scripts/decommission-baked.ts (252 lines — interactive ollama rm wrapper)"
    - "tests/scripts/decommission-baked.test.ts (222 lines — 25 tests)"
  modified:
    - "package.json (1 line added — decommission-baked script entry)"

key-decisions:
  - "Script name `decommission-baked` (not `decommission-baked-prefs`) — matches the contract artifact path AND aligns with the operator-mental-model of `ollama rm` as the unit-of-work, not user-pref rewriting (the separate `migrate-stale-userprefs` script handles prefs)"
  - "Default mode is INTERACTIVE with per-model prompt — REQ-033 + Decision 8 want explicit operator consent for each ~3-18GB removal; --yes flag exists for CI automation but is opt-in not default"
  - "Models listed in size-ascending order (lite → max → max2 → max3 → embed) — operator can ctrl-C after the small ones to defer the big variants if SSD pressure is unexpected"
  - "Playbook explicitly documents Step 10 (post-30d drop) as DEFERRED with the phrase `DO NOT run this in Phase 03` — preventing operator drift / out-of-window destructive ops"
  - "Test file gates the `--dry-run` CLI smoke on `ollamaAvailable()` probe — Ollama is not assumed present in CI; unit-test coverage handles the pure pieces"
  - "Used `migrate-stale-userprefs` (the actual script shipping in parallel plan 03-C-05) NOT `migrate-stale-baked-prefs` (contract typo) — verified the parallel plan's frontmatter to confirm the canonical name"

patterns-established:
  - "Pattern: Operator playbook structure — numbered steps + per-step smoke + per-step refused-precondition + per-step env-knob reference + closing summary tables (env, daily commands, baselines, limitations)"
  - "Pattern: Interactive ollama-CLI wrapper — listInstalled() before prompt + skip-if-not-installed + per-model yes/no + summary counters (removed/skipped/failed) + appropriate exit code (failed > 0 → 1)"
  - "Pattern: CLI script test surface — export internals + spawnSync the help/unknown-arg/dry-run branches; full E2E left to manual smoke documented in playbook"

requirements-completed: [REQ-033]

# Metrics
duration: 12min
completed: 2026-05-27
---

# Phase 03 Plan C-06: Operator Playbook + Decommission Script Summary

**End-to-end Phase 03 cutover operator playbook (11 numbered steps) + interactive `pnpm decommission-baked` ollama rm wrapper preserving the regression-baseline `dnd-master-plus`**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-27T22:30:22Z
- **Completed:** 2026-05-27T22:43:00Z
- **Tasks:** 3
- **Files created:** 3
- **Files modified:** 1
- **LOC delivered:** 1225 (751 docs + 252 script + 222 tests)
- **Tests added:** 25 (all passing)
- **Typecheck:** clean

## Accomplishments

- **End-to-end Phase 03 operator playbook** (`docs/operators/phase-03-cutover.md`, 751 lines, 11 numbered steps) covering pre-flight → completeness audit → bulk migration → dual-write enablement → divergence monitoring → summarizer → M4 bench → REQ-021 closure → cutover → rollback procedure → RAG decommission → baked-variant decommission → DEFERRED post-30d Postgres drop → final verification, with the One Piece (`3ef630db`) smoke campaign referenced at every step
- **Interactive `pnpm decommission-baked` CLI** wrapping `ollama rm` for the 4 retired tier variants (`dnd-master-{lite,max,max2,max3}`) + the RAG embedder (`nomic-embed-text`); PRESERVES `dnd-master-plus` regression baseline + the 3 production base slugs (qwen3 primary, qwen3 quality fallback, mistral offline content)
- **Three operator modes:** default interactive (per-model `yes/no` prompt), `--yes` (auto-confirm for CI), `--dry-run` (preview only)
- **25 unit + CLI tests** covering MODELS_TO_REMOVE contract (each retired slug + each preserved slug), parseArgs flag handling (--yes/-y, --dry-run, --help/-h, combinations), parseOllamaList parsing (typical table, blank lines, empty, `:latest` normalization, multi-tag preservation), and CLI surface (--help exits 0, unknown-arg exits 2, --dry-run smoke gated on Ollama binary)
- **Package.json wiring** so the playbook's `pnpm decommission-baked` invocation resolves end-to-end

## Task Commits

Each task was committed atomically:

1. **Task 1: Write docs/operators/phase-03-cutover.md** — `d7cb87c` (docs)
2. **Task 2: Write scripts/decommission-baked.ts + tests** — `92144ae` (feat)
3. **Task 3: Add decommission-baked to package.json** — `bb482f9` (chore)

**Plan metadata:** (this SUMMARY + STATE/ROADMAP updates ship in the final-commit step)

## Files Created/Modified

- `docs/operators/phase-03-cutover.md` (NEW, 751 lines) — END-TO-END Phase 03 cutover playbook
- `scripts/decommission-baked.ts` (NEW, 252 lines) — Interactive `ollama rm` wrapper preserving regression baseline
- `tests/scripts/decommission-baked.test.ts` (NEW, 222 lines) — 25 tests covering pure pieces + CLI smoke
- `package.json` (+1 line) — `decommission-baked` script entry

## Decisions Made

1. **Script name = `decommission-baked`** (not `decommission-baked-prefs`). The script's unit of work is `ollama rm` for retired models; user-pref rewriting is the separate `migrate-stale-userprefs` script (plan 03-C-05). The operator playbook orchestrates both in Step 9 (`migrate-stale-userprefs` FIRST → then `decommission-baked`) so no user row lands a 404 on the next turn after the variants are gone (Pitfall 6 mitigation).
2. **Default mode INTERACTIVE; `--yes` opt-in for CI.** REQ-033 + Decision 8 want explicit operator consent for each ~3-18GB removal — a single keystroke prevents an accidental `pnpm decommission-baked` in the wrong terminal from nuking 50GB of SSD. CI / automation operators use `--yes` deliberately.
3. **Models offered in size-ascending order** (lite ~3GB → max ~14GB → max2/max3 ~18GB → embed ~270MB). The operator can ctrl-C after the small ones to defer the big variants if SSD pressure is unexpected. Embed is last because it's the smallest of the bunch but topically RAG-distinct.
4. **Step 10 (post-30d Postgres drop) EXPLICITLY DEFERRED.** The playbook documents the future `pnpm decommission-legacy-state --confirm` shape but tells the operator in bold caps: `DO NOT run this in Phase 03. The post-30d drop is a separate, manually-gated migration that lands in Phase 04+`. Decision 5 (rollback window) made this an out-of-Phase-03 deliverable; the playbook preserves the gate.
5. **Test surface: export internals + CLI smoke only.** MODELS_TO_REMOVE / parseArgs / parseOllamaList are exported so 18 of the 25 tests need zero subprocess + zero Ollama daemon. The 7 CLI smoke tests cover --help / unknown-arg / --dry-run only (no actual `ollama rm` calls); --dry-run gates on `ollamaAvailable()` probe so CI without Ollama still goes green.
6. **Used `migrate-stale-userprefs` (actual sibling-plan script name)** NOT `migrate-stale-baked-prefs` (contract typo). Confirmed by reading the parallel plan 03-C-05's frontmatter (`files_modified: scripts/migrate-stale-userprefs.ts`) — playbook references the canonical name so operator invocations actually work.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Exported MODELS_TO_REMOVE, parseArgs, parseOllamaList**
- **Found during:** Task 2 (script implementation)
- **Issue:** The plan's reference implementation kept MODELS_TO_REMOVE + helpers as module-internal `const`. Without exports, the test file (also in the plan's contract — `tests/scripts/decommission-baked.test.ts`) would have to either (a) spawn the CLI for every assertion (slow + requires Ollama daemon) or (b) duplicate the model list inline (drift hazard — script and test contracts could diverge silently).
- **Fix:** Made MODELS_TO_REMOVE / parseArgs / parseOllamaList exported with explicit type signatures (`ReadonlyArray<{readonly name; readonly sizeNote}>`). Added an `invokedDirectly` guard so importing the module from tests does NOT trigger main() side effects (the script still runs normally under tsx/pnpm).
- **Verification:** 18 unit tests assert the contract directly (no subprocess); 7 CLI tests exercise the spawn paths. `pnpm typecheck` clean.
- **Committed in:** `92144ae` (Task 2 commit — together with the script itself, since the export decision is part of the script's interface)

**2. [Rule 2 - Missing critical] Added invokedDirectly guard around main() call**
- **Found during:** Task 2 (implementing exports per Deviation 1)
- **Issue:** Without the guard, `import { MODELS_TO_REMOVE } from '../../scripts/decommission-baked'` from the test file would execute `main()` at module-load — which calls `execSync('ollama list')` and could crash the test runner on hosts without the daemon.
- **Fix:** Wrapped the `main()` invocation in `if (invokedDirectly) { ... }` where `invokedDirectly` checks `process.argv[1]` resolves to this file (`.ts` or `.js` suffix). Works for both `tsx scripts/decommission-baked.ts` direct invocation and pnpm-wrapped invocation; tests import the module and never trip the guard.
- **Verification:** Tests pass on a host where `ollama list` is gated; the script itself still runs end-to-end via `pnpm decommission-baked --help`.
- **Committed in:** `92144ae` (Task 2 commit)

**3. [Rule 1 - Bug] Used canonical `migrate-stale-userprefs` script name (contract had `migrate-stale-baked-prefs`)**
- **Found during:** Task 1 (playbook authoring)
- **Issue:** The contract block for this plan referenced `pnpm migrate-stale-baked-prefs` as the sibling script the playbook should mention. But grep of the parallel 03-C-05 plan revealed the actual script being shipped is `scripts/migrate-stale-userprefs.ts` (with pnpm entry `migrate-stale-userprefs`). Documenting the contract name verbatim would have produced a playbook where the operator's `pnpm migrate-stale-baked-prefs` invocation would fail with `command not found`.
- **Fix:** Used the canonical name `migrate-stale-userprefs` throughout the playbook. The Phase 03-C-05 sibling plan's frontmatter (read during execution) is the source of truth.
- **Verification:** `grep "migrate-stale-userprefs" docs/operators/phase-03-cutover.md` returns multiple matches in Step 9; `grep "migrate-stale-baked-prefs"` returns 0.
- **Committed in:** `d7cb87c` (Task 1 commit)

**4. [Rule 2 - Missing critical] Added a `decommission summary` section to script output**
- **Found during:** Task 2 (writing the runtime output)
- **Issue:** The plan's reference implementation printed `[removed]` / `[skip]` lines per model but no final tally. For an interactive ceremony with 5 prompts, the operator wants to see at the end: "you removed 3, skipped 1 (not installed), declined 1, failed 0". Without the summary, the operator has to scroll back through the prompt history to know what just happened.
- **Fix:** Added `removed / skippedNotInstalled / skippedDeclined / failed` counters and a final 5-line summary block. Exit code is 1 iff failed > 0 (idempotency-friendly: if you re-run and everything is gone, exit 0).
- **Verification:** Exercised in the CLI smoke test (the `--help` path skips the summary; the `--dry-run` path emits it).
- **Committed in:** `92144ae` (Task 2 commit)

**Total deviations:** 4 auto-fixed (1 bug, 3 missing-critical). All are in the test/dev ergonomics + script output surface; none change the operator-visible contract or the model list. No scope creep.

## Issues Encountered

- **Parallel Wave 8 staging interaction:** While creating Task 2's commit, the staging area unexpectedly contained `.planning/STATE.md` modifications + `03-C-03-SUMMARY.md` from the parallel C-03 plan (which had landed concurrently). The commit was for the script+test work, but the metadata files rode along. This is benign — they were going to be committed by some plan anyway — but it means the Task 2 commit (`92144ae`) is slightly larger than the pure script work. Future executors should be aware that Wave 8 disjoint-file parallelism still shares the staging area.
- **Lint noise:** `pnpm lint` reports 48,187 pre-existing issues across the repo (none in this plan's files; verified via `grep -E "(decommission-baked|phase-03-cutover)"` on the lint output → 0 matches). Out of scope per the deviation rules `SCOPE BOUNDARY`.

## Next Phase Readiness

- **Phase 03-99 (SUMMARY):** Plan 03-99 ships the phase SUMMARY.md aggregating all 24 plans. This playbook is the operator-facing reference; the phase SUMMARY will link to it.
- **Phase 04+ pickup items:**
  - `pnpm decommission-legacy-state --confirm` script (Step 10 placeholder) — drops `characters`, `session_state`, `combat_actors` after 30d
  - SSE event-source replacement (Postgres LISTEN/NOTIFY → filesystem watcher or EventsWriter event-emitter)
  - `pnpm vault:cutover --all` bulk flag (currently documented as a psql + shell loop)
  - "Click to install" UI for `mistral-small3.2:24b` (REQ-032 ergonomics polish)
  - Operator-facing Settings UI for `dualWrite` (currently psql-only)

## Self-Check: PASSED

Verification of claims in this SUMMARY:

- ✓ `docs/operators/phase-03-cutover.md` exists (751 lines)
- ✓ `scripts/decommission-baked.ts` exists (252 lines)
- ✓ `tests/scripts/decommission-baked.test.ts` exists (222 lines)
- ✓ `package.json` contains `decommission-baked` entry (grep -c → 1)
- ✓ Task 1 commit `d7cb87c` present in `git log --oneline -5`
- ✓ Task 2 commit `92144ae` present in `git log --oneline -5`
- ✓ Task 3 commit `bb482f9` present in `git log --oneline -5`
- ✓ `pnpm typecheck` exits 0
- ✓ `pnpm test tests/scripts/decommission-baked.test.ts` → 25/25 passing
- ✓ `pnpm decommission-baked --help` resolves end-to-end via package.json entry

---
*Phase: 03-migration-cutover*
*Plan: C-06 (Wave 8 — parallel with 03-C-03 + 03-C-05)*
*Completed: 2026-05-27*
