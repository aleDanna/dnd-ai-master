---
phase: 03
slug: migration-cutover
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-26
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> 24 plans across 9 waves; 60+ individual tasks. Every task has an automated
> verification command OR an explicit Wave 0 dependency.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 (`"test": "vitest run"`) |
| **Config file** | `vitest.config.ts` (existing — Phase 01 + 02 cumulative 399 passed / 2 skipped baseline) |
| **Quick run command** | `pnpm test tests/ai/master/vault/ tests/lib/ tests/sessions/ tests/scripts/ tests/db/` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | Phase 03 cumulative target: ~10s for vault+sessions+lib subsets; ~30s for full suite (with DATABASE_URL-gated tests) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test tests/<area>/` for the area touched (e.g., tests/ai/master/vault/ for plans 03-A-02..04, 03-B-04..06)
- **After every plan wave (1-9):** Run `pnpm test` (full Vitest suite)
- **Before `/gsd-verify-work`:** Full suite must be green + `pnpm bench-phase-03-m4` MUST pass on M4
- **Max feedback latency:** ~10 seconds for the vault+sessions+lib subset (no DB-gated tests in the quick path)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-A-01-T1 | 03-A-01 | 1 | REQ-006 | — | Audit document enumerates every TOOL_HANDLERS key with classification | manual-only | grep + Read confirms COMPLETENESS-AUDIT.md has >= 50 classified handler rows; >= 6 (c) entries with full payload spec | ✅ docs only | ⬜ pending |
| 03-A-02-T1 | 03-A-02 | 2 | REQ-006 | T-03-02 | Phase 03 event types added to VaultEvent union additively; Phase 02 types preserved | unit | `pnpm typecheck && grep -c "type: 'temp_hp_set'" src/ai/master/vault/events-schema.ts` | ✅ | ⬜ pending |
| 03-A-02-T2 | 03-A-02 | 2 | REQ-006 | T-03-02 | validateEvent rejects malformed Phase 03 payloads with clear error messages (T-03-02 boundary check) | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-02-T3 | 03-A-02 | 2 | REQ-006 | T-03-02 | Vitest cases cover happy + edge cases per new event type | unit | `pnpm test tests/ai/master/vault/events-schema.test.ts` | ✅ | ⬜ pending |
| 03-A-03-T1 | 03-A-03 | 3 | REQ-006 | T-03-02 | CharacterState + INITIAL_CHARACTER_STATE extended with new persisted fields | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-03-T2 | 03-A-03 | 3 | REQ-006 | T-03-02 | applyEvent reducer arms for every new event type; tsc exhaustiveness check satisfied | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-03-T3 | 03-A-03 | 3 | REQ-006 | T-03-02 | serializeView/parseView round-trip new fields byte-stably | unit | `pnpm test tests/ai/master/vault/projector.test.ts -t "byte-stab"` | ✅ | ⬜ pending |
| 03-A-03-T4 | 03-A-03 | 3 | REQ-006 | T-03-02 | Vitest reducer + serialize round-trip cases per event type | unit | `pnpm test tests/ai/master/vault/projector.test.ts` | ✅ | ⬜ pending |
| 03-A-04-T1 | 03-A-04 | 3 | REQ-006 | T-03-05 | apply_event tool description enumerates every Phase 03 type; dispatcher uses validateEvent transparently | unit | `pnpm typecheck && grep -c "temp_hp_set" src/ai/master/vault/tools.ts` | ✅ | ⬜ pending |
| 03-A-04-T2 | 03-A-04 | 3 | REQ-006 | T-03-02 | Dispatch end-to-end for representative Phase 03 types (temp_hp_set, death_save_*, concentration_*, etc.) | integration | `pnpm test tests/ai/master/vault/tools.test.ts` | ✅ | ⬜ pending |
| 03-A-05-T1 | 03-A-05 | 1 | REQ-006 | T-03-02 | dualWriteDivergences schema with FK constraints + (session_id, created_at DESC) index | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-05-T2 | 03-A-05 | 1 | REQ-006 | T-03-02 | Barrel export reachable | unit | `pnpm typecheck && grep "dual-write-divergences" src/db/schema/index.ts` | ✅ | ⬜ pending |
| 03-A-05-T3 | 03-A-05 | 1 | REQ-006 | T-03-02 | drizzle migration applies; CREATE TABLE + CREATE INDEX | smoke | `pnpm db:migrate` | ❌ Wave 0 generates | ⬜ pending |
| 03-A-05-T4 | 03-A-05 | 1 | REQ-006 | T-03-02 | Insert + read-back round-trip; index check via pg_indexes | integration | `pnpm test tests/db/dual-write-divergences.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-A-06-T1 | 03-A-06 | 1 | REQ-006 | T-03-03 | Named helpers extracted from vault-flip.ts main(); flipSourceOfTruth helper for plan 03-B-02 | unit | `pnpm typecheck && grep -c "^export " scripts/vault-flip-helpers.ts` | ✅ | ⬜ pending |
| 03-A-06-T2 | 03-A-06 | 1 | REQ-006 | T-03-03 | vault-flip.ts CLI collapsed to a thin shell — behavior unchanged | smoke | `pnpm vault:flip` (lists campaigns) | ✅ | ⬜ pending |
| 03-A-06-T3 | 03-A-06 | 1 | REQ-006 | T-03-03 | flipCampaignToVault idempotency + enableMutationsForCampaign idempotency + flipSourceOfTruth preconditions | integration | `pnpm test tests/scripts/vault-flip-helpers.test.ts` | ✅ | ⬜ pending |
| 03-A-07-T1 | 03-A-07 | 3 | REQ-006 | T-03-03 | Bulk migration CLI with idempotency + dry-run + filter + per-campaign error isolation | unit | `pnpm typecheck && pnpm migrate-campaigns-to-vault --dry-run --limit=0` | ✅ | ⬜ pending |
| 03-A-07-T2 | 03-A-07 | 3 | REQ-006 | T-03-03 | package.json script entry | smoke | `grep -c "migrate-campaigns-to-vault" package.json` | ✅ | ⬜ pending |
| 03-A-07-T3 | 03-A-07 | 3 | REQ-006 | T-03-03 | End-to-end migration of 3 fixture campaigns + idempotent re-run + filter + error isolation | integration | `pnpm test tests/scripts/migrate-campaigns-to-vault.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-A-08-T1 | 03-A-08 | 2 | REQ-006 | T-03-02 | parityCheck compares normalized vault + Postgres state; returns null on match; ParityResult on divergence | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-08-T2 | 03-A-08 | 2 | REQ-006 | T-03-02 | Field-by-field comparison per Phase 02 + Phase 03 persisted fields | integration | `pnpm test tests/ai/master/vault/parity-check.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-A-09-T1 | 03-A-09 | 4 | REQ-006 | T-03-02 | dualWriteApplyEvent parallel writes via Promise.all + synchronous parity-check + fire-and-forget audit | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-09-T2 | 03-A-09 | 4 | REQ-006 | T-03-02 | recordDivergence inserts ParityResult fields into dual_write_divergences | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-09-T3 | 03-A-09 | 4 | REQ-006 | T-03-02 | 100-write phase-gate: 0 false-positive divergences when both stores converge | integration | `pnpm test tests/sessions/dual-writer.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-A-09-T4 | 03-A-09 | 4 | REQ-006 | T-03-02 | recordDivergence schema round-trip | integration | `pnpm test tests/sessions/divergence-record.test.ts` | ✅ | ⬜ pending |
| 03-A-10-T1 | 03-A-10 | 4 | REQ-006 | T-03-02 | Dispatcher branches on ctx.dualWrite; event-to-engine-mutation reverse-lookup function | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-A-10-T2 | 03-A-10 | 4 | REQ-006 | T-03-02 | Turn-route resolves dualWrite + forwards via VaultDispatchContext | unit | `pnpm typecheck && pnpm test tests/sessions/turn-route-branch.test.ts` | ✅ | ⬜ pending |
| 03-A-10-T3 | 03-A-10 | 4 | REQ-006 | T-03-02 | End-to-end gated dual-write through the turn route | integration | `pnpm test tests/sessions/turn-route-dual-write.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-B-01-T1 | 03-B-01 | 1 | REQ-006 | T-03-04 | sourceOfTruth + dualWrite + cutoverAt added to CampaignSettings | unit | `pnpm typecheck && grep -c "sourceOfTruth" src/db/schema/campaigns.ts` | ✅ | ⬜ pending |
| 03-B-01-T2 | 03-B-01 | 1 | REQ-006 | T-03-04 | resolveSourceOfTruth + resolveDualWrite + validators added; Phase 02 tests still green | unit | `pnpm typecheck && pnpm test tests/lib/preferences-master-backend.test.ts tests/lib/preferences-vault-mutations.test.ts` | ✅ | ⬜ pending |
| 03-B-01-T3 | 03-B-01 | 1 | REQ-006 | T-03-04 | sourceOfTruth resolver + validator unit tests | unit | `pnpm test tests/lib/preferences-source-of-truth.test.ts` | ✅ | ⬜ pending |
| 03-B-01-T4 | 03-B-01 | 1 | REQ-006 | T-03-04 | dualWrite resolver + validator unit tests | unit | `pnpm test tests/lib/preferences-dual-write.test.ts` | ✅ | ⬜ pending |
| 03-B-02-T1 | 03-B-02 | 5 | REQ-006 | T-03-04 | vault:cutover CLI with --rollback + window enforcement + audit log | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-B-02-T2 | 03-B-02 | 5 | REQ-006 | T-03-04 | package.json entry | smoke | `grep -c "vault:cutover" package.json` | ✅ | ⬜ pending |
| 03-B-02-T3 | 03-B-02 | 5 | REQ-006 | T-03-04 | Cutover + rollback + precondition + window-expiry behavior tests | integration | `pnpm test tests/scripts/vault-cutover.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-B-03-T1 | 03-B-03 | 1 | REQ-023 | T-03-11 | summaryBlock jsonb column added to session_state schema | unit | `pnpm typecheck && grep "summaryBlock" src/db/schema/session-state.ts` | ✅ | ⬜ pending |
| 03-B-03-T2 | 03-B-03 | 1 | REQ-023 | T-03-11 | drizzle ALTER TABLE migration applies | smoke | `pnpm db:migrate` | ❌ Wave 0 generates | ⬜ pending |
| 03-B-03-T3 | 03-B-03 | 1 | REQ-023 | T-03-11 | Insert + read-back round-trip; default null | integration | `pnpm test tests/db/session-state-summary-block.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-B-04-T1 | 03-B-04 | 5 | REQ-023, REQ-034 | T-03-06, T-03-07 | maybeCondense fires at threshold; uses same model (REQ-034); Italian prompt (T-03-06) | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-B-04-T2 | 03-B-04 | 5 | REQ-023, REQ-034 | T-03-06, T-03-07 | Threshold + env override + persistence tests | unit + integration | `pnpm test tests/ai/master/vault/condense.test.ts` | ✅ | ⬜ pending |
| 03-B-05-T1 | 03-B-05 | 5 | REQ-023 | T-03-11 | runVaultToolLoop restores summaryBlock on entry + calls maybeCondense before completeMessage | unit | `pnpm typecheck && grep -c "maybeCondense" src/ai/master/vault/loop.ts` | ✅ | ⬜ pending |
| 03-B-05-T2 | 03-B-05 | 5 | REQ-023 | T-03-11 | Loop end-to-end with summarizer trigger + restart-restore | integration | `pnpm test tests/ai/master/vault/loop.test.ts` | ✅ | ⬜ pending |
| 03-B-06-T1 | 03-B-06 | 5 | REQ-006 | T-03-04 | materializeFromVault returns Partial<SessionState> from events.md replay; null on skip cases | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-B-06-T2 | 03-B-06 | 5 | REQ-006 | T-03-04 | Field-by-field translation + byte-stable replay | unit | `pnpm test tests/ai/master/vault/snapshot-reader.test.ts` | ✅ | ⬜ pending |
| 03-B-07-T1 | 03-B-07 | 5 | REQ-006 | T-03-04 | buildClientSnapshot pivots on sourceOfTruth=vault; falls back to Postgres on null | unit | `pnpm typecheck && pnpm test tests/sessions/` | ✅ | ⬜ pending |
| 03-B-07-T2 | 03-B-07 | 5 | REQ-006 | T-03-04 | End-to-end pivot + fallback + shape parity | integration | `pnpm test tests/sessions/client-snapshot-pivot.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-D-01-T1 | 03-D-01 | 6 | REQ-020, REQ-031, REQ-032 | T-03-10 | bench-phase-03-m4 orchestrates spike 004 + 011 + 014; aggregates results; pass/fail gates | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-D-01-T2 | 03-D-01 | 6 | REQ-020 | T-03-10 | package.json entry | smoke | `grep -c "bench-phase-03-m4" package.json` | ✅ | ⬜ pending |
| 03-D-01-T3 | 03-D-01 | 6 | REQ-020 | T-03-10 | Parser unit tests (extract metrics from representative spike output) | unit | `pnpm test tests/scripts/bench-phase-03-m4.test.ts` | ✅ | ⬜ pending |
| 03-D-02-T1 | 03-D-02 | 6 | REQ-020 | T-03-10 | Operator manually updates Phase 01 SUMMARY.md M4 table from bench JSON | manual-only | Visual inspection by operator + git diff | ✅ docs only | ⬜ checkpoint |
| 03-C-01-T1 | 03-C-01 | 7 | REQ-033 | T-03-05 | RAG caller audit produces enumeration of every src/ + tests/ caller | manual-only | grep enumeration captured in RAG-CALLER-AUDIT.md | ✅ docs only | ⬜ pending |
| 03-C-02-T1 | 03-C-02 | 7 | REQ-033 | T-03-05 | src/ai/master/rag/ + tests/ai/master/rag/ deleted | smoke | `! ls src/ai/master/rag` | ✅ | ⬜ pending |
| 03-C-02-T2 | 03-C-02 | 7 | REQ-033 | T-03-05 | scripts/build-rag-index.ts + RAG admin route deleted | smoke | `! test -f scripts/build-rag-index.ts` | ✅ | ⬜ pending |
| 03-C-02-T3 | 03-C-02 | 7 | REQ-033 | T-03-05 | turn-route.ts no longer imports rag | unit | `pnpm typecheck && ! grep "from '@/ai/master/rag" src/app/api/sessions/\[id\]/turn/route.ts` | ✅ | ⬜ pending |
| 03-C-02-T4 | 03-C-02 | 7 | REQ-033 | T-03-05 | local-services.ts cleaned | unit | `pnpm typecheck && ! grep "pingEmbedder" src/lib/local-services.ts` | ✅ | ⬜ pending |
| 03-C-02-T5 | 03-C-02 | 7 | REQ-033 | T-03-05 | package.json build-rag-index entry removed | smoke | `! grep "build-rag-index" package.json` | ✅ | ⬜ pending |
| 03-C-02-T6 | 03-C-02 | 7 | REQ-033 | T-03-05 | Production build succeeds without RAG | smoke | `pnpm build` | ✅ | ⬜ pending |
| 03-C-03-T1 | 03-C-03 | 8 | REQ-033 | T-03-09 | Hand-written drop-pgvector migration with ordered DROPs | smoke | grep order in migration file: DROP INDEX, DROP TABLE, DROP EXTENSION | ✅ | ⬜ pending |
| 03-C-03-T2 | 03-C-03 | 8 | REQ-033 | T-03-09 | Schema + barrel export removed | unit | `pnpm typecheck && ! test -f src/db/schema/rag-chunks.ts` | ✅ | ⬜ pending |
| 03-C-03-T3 | 03-C-03 | 8 | REQ-033 | T-03-09 | Migration applies on fresh PG; extension + table gone | smoke | `pnpm db:migrate && psql ... -c "\\dx" \| ! grep vector` | ✅ | ⬜ pending |
| 03-C-04-T1 | 03-C-04 | 7 | REQ-031, REQ-032, REQ-033 | — | TIER_NAMES contains only dnd-master-plus | unit | `pnpm typecheck && pnpm test tests/ai/master/baked-models.test.ts -t "only dnd-master-plus"` | ✅ | ⬜ pending |
| 03-C-04-T2 | 03-C-04 | 7 | REQ-033 | — | build-local-models.ts skips retired bases | smoke | grep -c "TIER_NAMES" scripts/build-local-models.ts | ✅ | ⬜ pending |
| 03-C-04-T3 | 03-C-04 | 7 | REQ-031, REQ-032, REQ-033 | — | TIER_NAMES assertion tests | unit | `pnpm test tests/ai/master/baked-models.test.ts` | ✅ | ⬜ pending |
| 03-C-05-T1 | 03-C-05 | 8 | REQ-030, REQ-033 | T-03-08 | migrate-stale-userprefs CLI with --dry-run + idempotency | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-C-05-T2 | 03-C-05 | 8 | REQ-033 | T-03-08 | package.json entry | smoke | `grep -c "migrate-stale-userprefs" package.json` | ✅ | ⬜ pending |
| 03-C-05-T3 | 03-C-05 | 8 | REQ-030, REQ-033 | T-03-08 | End-to-end migration + idempotency + soft-delete exclusion | integration | `pnpm test tests/scripts/migrate-stale-userprefs.test.ts` (DATABASE_URL gated) | ✅ | ⬜ pending |
| 03-C-06-T1 | 03-C-06 | 8 | REQ-033 | T-03-01 | Operator playbook with 11 numbered steps covering migrate → cutover → bench → decommission → post-30d-reminder | manual-only | wc -l docs/operators/phase-03-cutover.md >= 200 | ✅ docs only | ⬜ pending |
| 03-C-06-T2 | 03-C-06 | 8 | REQ-033 | T-03-01 | decommission-baked interactive script wraps ollama rm for retired tiers + embedder | smoke | `pnpm typecheck` | ✅ | ⬜ pending |
| 03-C-06-T3 | 03-C-06 | 8 | REQ-033 | T-03-01 | package.json entry | smoke | `grep -c "decommission-baked" package.json` | ✅ | ⬜ pending |
| 03-99-T1 | 03-99 | 9 | REQ-006, REQ-020, REQ-023, REQ-031, REQ-032, REQ-033, REQ-034 | — | SUMMARY.md documents every plan + REQ traceability + threat dispositions + open items | manual-only | wc -l .planning/phases/03-migration-cutover/SUMMARY.md >= 500 + all 7 REQs cited + 11 threats listed | ✅ docs only | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Plan 03-A-01 (completeness audit) is a Wave-0-like gating task — it produces the (c) Final list that plans 03-A-02 + 03-A-03 + 03-A-04 consume. Without it landing first, those plans cannot ship.

Other Wave 0 (test scaffold + migration generation) items:
- [ ] `drizzle/XXXX_dual_write_divergences.sql` — generated by `pnpm db:generate` after schema file lands (plan 03-A-05)
- [ ] `drizzle/XXXX_session_state_summary_block.sql` — generated by `pnpm db:generate` (plan 03-B-03)
- [ ] `drizzle/XXXX_drop_pgvector.sql` — HAND-WRITTEN per Pitfall 5 (plan 03-C-03)
- [ ] `tests/ai/master/vault/condense.test.ts` — NEW test scaffold for REQ-023 (plan 03-B-04)
- [ ] `tests/ai/master/vault/parity-check.test.ts` — NEW test scaffold (plan 03-A-08)
- [ ] `tests/sessions/dual-writer.test.ts` + `tests/sessions/divergence-record.test.ts` — NEW (plan 03-A-09)
- [ ] `tests/scripts/migrate-campaigns-to-vault.test.ts` — NEW (plan 03-A-07)
- [ ] `tests/scripts/vault-cutover.test.ts` — NEW (plan 03-B-02)
- [ ] `tests/ai/master/vault/snapshot-reader.test.ts` — NEW (plan 03-B-06)

All test files are created INSIDE their respective plans (per the task structures above). Phase 03 has no separate Wave 0 "scaffold all tests at the start" — each plan owns its tests.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| M4 production bench numbers | REQ-020, REQ-021 | Requires Mac Mini M4 hardware (CI runs on shared cloud runners) | Operator runs `pnpm bench-phase-03-m4` on M4 + reviews JSON output |
| Phase 01 SUMMARY.md M4 table update | REQ-021 (closure) | Manual table edit; numbers come from prior step | Operator opens SUMMARY.md + replaces 'Deferred' cells per bench JSON |
| ollama rm for retired baked variants | REQ-033 | Requires shell access to M4 production host | Operator runs `pnpm decommission-baked` interactively on M4 |
| Cutover rollback decision | T-03-04 | Requires operator judgment within CUTOVER_ROLLBACK_HOURS window | Operator monitors campaign behavior after cutover; runs `pnpm vault:cutover --rollback` if needed |
| Post-30d Postgres-table drop | T-03-04 | EXPLICITLY DEFERRED to Phase 04+ | Documented in operator playbook (plan 03-C-06); not shipped in Phase 03 |
| Mutation completeness audit accuracy | REQ-006 | Requires reading 60+ engine handler bodies + classifying each | Operator reviews COMPLETENESS-AUDIT.md before plan 03-A-02 ships |
| Smoke turn from One Piece campaign | All | UI smoke test — hard to fully automate without Playwright E2E setup | Operator manually fires a turn after each waveland; confirms HP/conditions/etc. as expected |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (every plan's tasks share `pnpm typecheck` + per-area test commands)
- [x] Wave 0 covers all MISSING references (drizzle migrations + new test files enumerated)
- [x] No watch-mode flags
- [x] Feedback latency < 10s for quick path (vault + lib + sessions subset)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-26 (planner)
