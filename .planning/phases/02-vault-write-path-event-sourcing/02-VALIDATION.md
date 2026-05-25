---
phase: 02
slug: vault-write-path-event-sourcing
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-25
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 (`"test": "vitest run"`) |
| **Config file** | `vitest.config.ts` (Phase 01 already passes 123 tests) |
| **Quick run command** | `pnpm test tests/ai/master/vault/ tests/lib/preferences-vault-mutations.test.ts tests/sessions/vault-mutations-gate.test.ts tests/sessions/vault-mutations-resume.test.ts tests/sessions/turn-tool-call-cap.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds (default N=1000 stress incl.); ~60-90 seconds at STRESS_N=10000 |

**Critical inherited rule from Phase 01:** vitest scans ONLY `tests/**/*.test.{ts,tsx}` (see `vitest.config.ts:31-40`). Colocated `src/**/*.test.ts` files are NOT picked up. **Every Phase 02 test lives under `tests/`, never colocated.** ([cited from Phase 01 SUMMARY line 51](.planning/phases/01-vault-read-path/SUMMARY.md))

---

## Sampling Rate

- **After every task commit:** Run the quick command (vault-only subset, ~5-10 seconds)
- **After every plan wave merge:** Run `pnpm test` (full Vitest suite — Phase 01 baseline 123 tests + Phase 02 additions ~196 new)
- **Before `/gsd-verify-work`:** Full suite must be green + manual M4/M5 Pro smoke per PLAN.md validation step 5
- **Max feedback latency:** ~10 seconds (per-task subset); ~60 seconds (full suite incl. stress)

---

## Per-Task Verification Map

Format: `<plan>-<task>` | plan number | wave | requirement(s) | threat(s) | secure behavior | test type | command | file exists | status

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|---|---|
| 02-01-01 | 01 | 1 | REQ-005, REQ-010 | T-02-03 | Type guard rejects unknown event types and out-of-range payloads at the LLM boundary before any disk write | unit | `pnpm test tests/ai/master/vault/events-schema.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | REQ-005 | T-02-03 | Validator covers all 8 event types + all rejection classes (NaN, wrong type, out-of-range, missing field) | unit | `pnpm test tests/ai/master/vault/events-schema.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | REQ-007 | T-02-04, T-02-05, T-02-07 | UUID regex fail-closed on non-UUID campaignId; slugify strips traversal sequences; path-prefix invariant on character view paths | unit | `pnpm test tests/ai/master/vault/campaign-paths.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | REQ-007 | T-02-04, T-02-05, T-02-07 | All path-resolution helpers tested with both happy paths and traversal attempts; UUID guards on campaignId AND characterId | unit | `pnpm test tests/ai/master/vault/campaign-paths.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | REQ-005 | T-02-02 | EventsWriter mutex serializes writes per absolute path; mutex releases correctly even on filesystem error | unit/integration | `pnpm test tests/ai/master/vault/events-writer.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | REQ-005 | T-02-02 | N=100 parallel applyEvent → 100 distinct events; per-path isolation; error-path mutex release | unit/integration | `pnpm test tests/ai/master/vault/events-writer.test.ts` | ❌ W0 | ⬜ pending |
| 02-04-01 | 04 | 2 | REQ-004, REQ-006 | T-02-03, T-02-12 | Pure reducer (no Date/random/env); compile-time exhaustiveness; HP clamp to [0, hp_max]; graceful degradation on unknown types | unit | `pnpm test tests/ai/master/vault/projector.test.ts` | ❌ W0 | ⬜ pending |
| 02-04-02 | 04 | 2 | REQ-004, REQ-006 | T-02-12 | Corruption fail-fast (line number in error); byte-stable view output; round-trip property | unit/integration | `pnpm test tests/ai/master/vault/projector.test.ts` | ❌ W0 | ⬜ pending |
| 02-05-01 | 05 | 1 | REQ-004 | — | CampaignSettings.vaultMutations field added with backward-compatible default (undefined = off) | unit | `pnpm typecheck && pnpm test tests/lib/preferences-master-backend.test.ts` | ❌ W0 | ⬜ pending |
| 02-05-02 | 05 | 1 | REQ-004, REQ-007 | T-02-01 | Resolver enforces Pitfall 5: vaultMutations:true on baked campaign → false at the resolver layer | unit | `pnpm test tests/lib/preferences-vault-mutations.test.ts` | ❌ W0 | ⬜ pending |
| 02-05-03 | 05 | 1 | REQ-004 | — | validateSettingsPatch arm rejects non-boolean vaultMutations | unit | `pnpm test tests/lib/preferences-vault-mutations.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-01 | 06 | 1 | REQ-010 | T-02-08 | VAULT_TURN_TOOL_CALL_CAP = 20 exported alongside TURN_TOOL_CALL_CAP = 12; baked loop unchanged | unit | `pnpm typecheck && pnpm test tests/sessions/turn-tool-call-cap.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-02 | 06 | 1 | REQ-010 | T-02-08 | Vault loop default cap is the new constant; 20-tool turn does not truncate; 21-tool turn does | unit | `pnpm test tests/sessions/turn-tool-call-cap.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-03 | 06 | 1 | REQ-010 | T-02-08 | Static assertion: baked loop source does NOT import VAULT_TURN_TOOL_CALL_CAP | unit | `pnpm test tests/sessions/turn-tool-call-cap.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-01 | 07 | 3 | REQ-005, REQ-010 | T-02-01, T-02-04, T-02-07 | apply_event in VAULT_TOOL_DEFINITIONS (4 entries); dispatch validates schema + UUID before any write; campaignId required from server-side ctx | unit | `pnpm test tests/ai/master/vault/tools.test.ts` | EXTEND | ⬜ pending |
| 02-07-02 | 07 | 3 | REQ-010 | T-02-01 | Vault loop forwards campaignId from input to dispatch ctx | unit | `pnpm test tests/ai/master/vault/loop.test.ts` | EXTEND | ⬜ pending |
| 02-07-03 | 07 | 3 | REQ-010 | — | Barrel exports all Phase 02 modules; phase-smoke asserts 4-tool surface | unit | `pnpm test tests/ai/master/vault/phase-smoke.test.ts` | EXTEND | ⬜ pending |
| 02-07-04 | 07 | 3 | REQ-005, REQ-010 | T-02-03 | tools.test.ts extended: validation errors short-circuit before write; path-traversal defense on campaignId; root routing for /campaigns/ paths | unit/integration | `pnpm test tests/ai/master/vault/tools.test.ts` | EXTEND | ⬜ pending |
| 02-07-05 | 07 | 3 | REQ-010 | — | phase-smoke.test.ts inverted: VAULT_TOOL_DEFINITIONS.length === 4; names include 'apply_event'; all Phase 02 surfaces importable via barrel | unit | `pnpm test tests/ai/master/vault/phase-smoke.test.ts` | EXTEND | ⬜ pending |
| 02-07-06 | 07 | 3 | REQ-010 | T-02-01 | Loop tests: missing campaignId in input → apply_event returns isError; failure surfaces as tool_result without aborting loop | unit | `pnpm test tests/ai/master/vault/loop.test.ts` | EXTEND | ⬜ pending |
| 02-07-07 | 07 | 3 | REQ-004, REQ-005, REQ-006, REQ-007 | T-02-02, T-02-07, T-02-12 | End-to-end integration: dispatch → events.md → view file; REQ-007 isolation (no writes under VAULT_ROOT); DR roundtrip; property test; concurrent dispatch | integration | `pnpm test tests/ai/master/vault/apply-event-integration.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-01 | 08 | 3 | REQ-010 | — | buildVaultSystemPrompt accepts vaultMutations input; toolCount consistency assertion; REQ-022 hygiene preserved (no Date/random/env) | unit | `pnpm test tests/ai/master/vault/prompt-builder.test.ts` | EXTEND | ⬜ pending |
| 02-08-02 | 08 | 3 | REQ-004, REQ-007, REQ-010 | T-02-01 | Turn route honors vaultMutations gate: 4-tool prompt + campaignId forwarded ONLY when resolveVaultMutations is true | integration | `pnpm test tests/sessions/vault-mutations-gate.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-03 | 08 | 3 | REQ-004 | — | Branch coverage: 4-quadrant (vault+true, vault+false, baked+true, baked+false); Pitfall-5 enforcement at route layer | integration | `pnpm test tests/sessions/vault-mutations-gate.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-04 | 08 | 3 | REQ-004, REQ-006 | T-02-12 | Resume invariant: state survives Next.js restart via events.md replay; DR roundtrip at integration level | integration | `pnpm test tests/sessions/vault-mutations-resume.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-05 | 08 | 3 | — | — | Operator confirms stale-UI banner copy (Settings page banner per Decision 8) | checkpoint:human-verify | (manual) | n/a | ⬜ pending |
| 02-09-01 | 09 | 3 | REQ-005 | T-02-02 | N=1000 parallel applyEvent (CI default): 0 lost, 0 duplicated, 0 corrupted | integration | `pnpm test tests/ai/master/vault/events-writer-stress.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-02 | 09 | 3 | REQ-005 | T-02-02 | N=100 dispatch-layer stress: validation + write + view regen + view consistency under load | integration | `pnpm test tests/ai/master/vault/events-writer-stress.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-03 | 09 | 3 | REQ-006 | T-02-12 | Truncated-tail recovery: fail-fast with line number; manual rollback restores parseability | integration | `pnpm test tests/ai/master/vault/events-writer-stress.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-04 | 09 | 3 | REQ-005 | T-02-07 | 5 campaigns × 100 events in parallel: per-path mutex isolation; no cross-contamination | integration | `pnpm test tests/ai/master/vault/events-writer-stress.test.ts` | ❌ W0 | ⬜ pending |
| 02-10-01 | 10 | 3 | REQ-006, REQ-007 | — | Operator picks default backup strategy (git / tarball / both-no-default) | checkpoint:decision | (manual) | n/a | ⬜ pending |
| 02-10-02 | 10 | 3 | REQ-006 | T-02-06, T-02-11 | vault:backup git strategy: initializes repo + refuses commit on non-append edits; tarball strategy: rotation + timestamped output | unit/integration | `pnpm test tests/scripts/vault-backup.test.ts` | ❌ W0 | ⬜ pending |
| 02-10-03 | 10 | 3 | REQ-006 | — | vault:rebuild-views: byte-exact restore from events.md (spike 013 invariant at script level) | manual integration | (covered indirectly by `apply-event-integration.test.ts` DR roundtrip) | ✓ via 02-07-07 | ⬜ pending |
| 02-10-04 | 10 | 3 | REQ-004, REQ-007 | — | vault:flip --enable-mutations: writes vaultMutations:true + appends campaign_initialized seed event sourced from Postgres characters | manual smoke | (covered by PLAN.md validation step 5) | n/a | ⬜ pending |
| 02-10-05 | 10 | 3 | REQ-006, REQ-007 | — | docs/operators/vault-backup.md describes both strategies + recovery one-liner + Decision 8 caveat | doc inspection | `grep -c "vault:backup\\|REQ-006\\|REQ-007" docs/operators/vault-backup.md` ≥ 4 | ❌ W0 | ⬜ pending |
| 02-10-06 | 10 | 3 | — | — | CLI parsing tests: invalid --strategy + invalid --keep | unit | `pnpm test tests/scripts/vault-backup.test.ts` | ❌ W0 | ⬜ pending |
| 02-11-01 | 11 | 4 | REQ-004, REQ-005, REQ-006, REQ-007, REQ-010 | — | SUMMARY.md with REQ traceability matrix + Phase 03 hand-offs + performance baseline + test totals | doc inspection | `test -f .planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md && grep -c "REQ-" .planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md` ≥ 10 | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Coverage check:** every requirement ID (REQ-004, REQ-005, REQ-006, REQ-007, REQ-010) appears in ≥ 3 task rows. Every threat in the PLAN.md threat model (T-02-01 through T-02-12) appears in ≥ 1 task row (T-02-09 disposition=accept-phase02, T-02-10 disposition=mitigate-operational; both covered by docs/operators/vault-backup.md in 02-10-05).

**Nyquist sampling check:** no 3 consecutive task rows lack `<automated>` verify — only the human-verify (02-08-05), decision (02-10-01), and manual smoke (02-10-04) gates are non-automated, and they are interspersed with automated tasks.

---

## Wave 0 Requirements

Wave 0 = test scaffolding that must exist BEFORE the corresponding source code is written (TDD-adjacent — even though `workflow.tdd_mode` is false for this phase, the planner front-loads test file creation in each plan's tasks so the executor implements toward a known target).

New test files (each plan creates its own test scaffold as Task 2/Task 3):

- [ ] `tests/ai/master/vault/events-schema.test.ts` — REQ-005, REQ-010 (plan 02-01 Task 2)
- [ ] `tests/ai/master/vault/campaign-paths.test.ts` — REQ-007 (plan 02-02 Task 2)
- [ ] `tests/ai/master/vault/events-writer.test.ts` — REQ-005 (plan 02-03 Task 2)
- [ ] `tests/ai/master/vault/projector.test.ts` — REQ-004, REQ-006 (plan 02-04 Task 2)
- [ ] `tests/lib/preferences-vault-mutations.test.ts` — REQ-004, REQ-007 (plan 02-05 Task 3)
- [ ] `tests/sessions/turn-tool-call-cap.test.ts` — REQ-010 (plan 02-06 Task 3)
- [ ] `tests/ai/master/vault/apply-event-integration.test.ts` — REQ-004/005/006/007/010 phase-gate integration (plan 02-07 Task 7)
- [ ] `tests/sessions/vault-mutations-gate.test.ts` — REQ-004 (plan 02-08 Task 3)
- [ ] `tests/sessions/vault-mutations-resume.test.ts` — REQ-004, REQ-006 (plan 02-08 Task 4)
- [ ] `tests/ai/master/vault/events-writer-stress.test.ts` — REQ-005, REQ-006 (plan 02-09 Task 1)
- [ ] `tests/scripts/vault-backup.test.ts` — REQ-006, REQ-007 (plan 02-10 Task 7)

Extended test files (Phase 01 tests inverted/extended by Phase 02):

- [ ] `tests/ai/master/vault/tools.test.ts` — EXTEND with apply_event dispatch cases (plan 02-07 Task 4)
- [ ] `tests/ai/master/vault/loop.test.ts` — EXTEND with apply_event branch case (plan 02-07 Task 6)
- [ ] `tests/ai/master/vault/phase-smoke.test.ts` — EXTEND: invert "no apply_event" to "has apply_event"; bump count 3→4 (plan 02-07 Task 5)
- [ ] `tests/ai/master/vault/prompt-builder.test.ts` — EXTEND with vaultMutations input cases (plan 02-08 Task 1)

**Framework install:** none — Vitest 4.1.5 is already configured (Phase 01 inheritance).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|---|---|---|---|
| Operator stale-UI banner copy approved | (Decision 8) | Requires human aesthetic/UX judgment on the operator-facing message | Read the three options in plan 02-08 Task 5; pick A/B/C or propose an alternative. |
| Default backup strategy chosen | REQ-007 | Per-environment preference; operator may want offline-first | Read the three options in plan 02-10 Task 1; pick git/tarball/both-no-default. |
| M4 warm wall-clock smoke for vault-mutations turns | REQ-021 (not REQ-004/005/006/007/010 but adjacent) | M4 production hardware required (REQ-020); M5 Pro is not the gate | Set `campaigns.settings.masterBackend = 'vault'` AND `vaultMutations = true` for a test campaign on M4. Send a combat turn ("Aragorn attacks the goblin"). Observe `ai_usage` row + wall-clock. Confirm < 10s warm (Phase 02 doesn't gate on this — it's the Phase 03 cutover gate). |
| Live smoke: turn → apply_event → events.md → view file | REQ-004, REQ-005, REQ-007, REQ-010 | End-to-end through the actual Next.js server + Ollama provider | Per PLAN.md "How to validate phase completion" step 5 — flip a campaign to vault+vaultMutations:true; send a combat turn; inspect events.md and the character view file. |
| Backup + restore roundtrip with real campaign data | REQ-006, REQ-007 | Real-world filesystem state (vs in-memory tests) | Per PLAN.md validation step 4: run `pnpm vault:backup`, corrupt a view file, run `pnpm vault:rebuild-views --campaign=<uuid>`, confirm view restored. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies declared (only the 3 manual gates are non-automated, and they are clearly marked checkpoint:* tasks)
- [x] Sampling continuity: no 3 consecutive task rows without automated verify
- [x] Wave 0 covers all MISSING references (11 new test files declared above)
- [x] No watch-mode flags (every command is `pnpm test ...` — single run)
- [x] Feedback latency < 60s (quick subset ~10s; full subset ~30s; stress 30-60s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending — set to `approved <YYYY-MM-DD>` after Phase 02 plans have been executed and the per-task statuses (Status column) are all ✅ green.
