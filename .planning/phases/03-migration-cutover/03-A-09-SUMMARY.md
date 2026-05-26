---
phase: 03-migration-cutover
plan: A-09
subsystem: sessions
tags: [dual-write, fan-out, parity-check, audit, fire-and-forget, phase-gate]

requires:
  - phase: 02-vault-write-path-event-sourcing
    provides: EventsWriter.applyEvent (mutex-serialized vault append, spike 010); regenerateAffectedViews (synchronous view regen, spike 008); VaultEventEnvelope shape + EVENT_SCHEMA_VERSION; eventsPath canonical absolute-path resolver
  - phase: 03-migration-cutover (Wave 1 sibling)
    provides: dual_write_divergences audit table schema (plan 03-A-05); DualWriteDivergence/DualWriteDivergenceInsert types
  - phase: 03-migration-cutover (Wave 2 sibling)
    provides: VaultEvent union with 28 arms (plan 03-A-02 events-schema); CharacterState reducer (plan 03-A-03 projector); parityCheck(campaignId, characterId, sessionId) → ParityResult | null (plan 03-A-08)

provides:
  - "src/sessions/dual-writer.ts exporting dualWriteApplyEvent(envelope, applyEngineMutation, ctx) → Promise<DualWriteResult>"
  - "DualWriteContext interface { campaignId, sessionId, characterId: string | null } — characterId nullable for session-level events"
  - "DualWriteResult interface { divergence: boolean, reason?: string } — reason carries the parityCheck summary on divergence"
  - "src/sessions/divergence-record.ts exporting recordDivergence(input) — typed alias for `db.insert(dualWriteDivergences).values(...)`"
  - "RecordDivergenceInput interface { sessionId, campaignId, characterId, eventType, parityResult } — direct field-to-column mapping"
  - "tests/sessions/dual-writer.test.ts — 8 DATABASE_URL-gated cases (happy path + divergence + 2 error paths + parallel-timing + audit-failure fire-and-forget + null-characterId + 100-write phase-gate)"
  - "tests/sessions/divergence-record.test.ts — 2 DATABASE_URL-gated cases (round-trip + nullable characterId)"

affects:
  - 03-A-10 (turn-route wiring — the apply_event dispatcher imports dualWriteApplyEvent and closes over the engine-mutation chain to pass as the callback; this plan defines the contract that 03-A-10 implements against)
  - "Operator runbook (Phase 03 cutover gate): the 100-synced-writes test establishes the baseline (0 audit rows under perfect sync); production divergence rate is monitored against `SELECT count(*) FROM dual_write_divergences WHERE created_at > now() - interval '24h'` and gates the cutover decision (REQ-006 SLO < 0.1% over 2 weeks)"

tech-stack:
  added: []
  patterns:
    - "Promise.all parallel fan-out for dual-write: writes to vault (events.md append) and Postgres (engine mutation callback) run concurrently; total latency is max(vault, pg) instead of sum. Slow-leg latency dominates (Postgres ~50-100ms over Supabase; vault ~5-20ms on tmpfs)."
    - "Synchronous post-write parity-check (RESEARCH Decision 2 Option B): the diff runs in the same async tick as the writes, so the LLM sees the divergence flag in the same turn — operator awareness is critical during the coexistence window. Async reconciliation was REJECTED in RESEARCH."
    - "Fire-and-forget audit insert: `void recordDivergence(...).catch(...)` detaches the audit-table write so a transient DB hiccup recording the divergence does NOT cause the LLM turn to fail. The divergence info is already returned to the caller; the audit row exists for offline operator inspection."
    - "Callback decoupling for engine-mutation: `applyEngineMutation: () => Promise<void>` is a closure the dispatcher (plan 03-A-10) builds around the existing applyMutations chain. dual-writer.ts knows nothing about applicator.ts function names — keeps the primitive composable across future engine-layer refactors."
    - "Partial-success semantics (NIT 6 documented in JSDoc): if either parallel write fails, the function re-throws. NO view regen, NO parity-check, NO audit row. The vault may have appended an event while Postgres did not (or vice versa); the operator inspects events.md + the thrown error trace, NOT an audit row (audit rows are reserved for the both-succeeded-but-disagree case)."

key-files:
  created:
    - src/sessions/dual-writer.ts
    - src/sessions/divergence-record.ts
    - tests/sessions/dual-writer.test.ts
    - tests/sessions/divergence-record.test.ts
    - .planning/phases/03-migration-cutover/03-A-09-SUMMARY.md (this file)
  modified: []

key-decisions:
  - "Followed the detailed plan's function-based API (`dualWriteApplyEvent` exported function) rather than the original contract's class API (`DualWriter.applyEvent` static method). The function-based API is what plan 03-A-10 will consume (per the must_haves), and matches the pattern Wave 1 established in 03-A-06 (vault-flip-helpers.ts exports named functions, not classes). The class shape in the contract was advisory; the must_haves + acceptance criteria specify the function signature."
  - "regenerateAffectedViews runs synchronously AFTER Promise.all but BEFORE parityCheck (NIT 6 resolution). Rationale: parityCheck reads from events.md (which was just appended), not from the view files — so the view-regen ordering doesn't change parity-check correctness. But the regen MUST run BEFORE parityCheck because a subsequent read_vault_multi call (after the LLM sees the divergence flag) needs fresh views, and the parity-check failure path SHOULD see fresh views too. Placing regen between Promise.all and parityCheck preserves both invariants without nesting it inside the Promise.all (which would risk a partial-success state where vault is written but view is stale)."
  - "Audit-insert is intentionally NOT awaited inside dualWriteApplyEvent: `void recordDivergence(...).catch(...)` detaches the promise. Rationale: the caller has already received `{divergence: true, reason}` and can decide policy (alert, log, retry); the audit row is for OFFLINE operator inspection (`SELECT * FROM dual_write_divergences WHERE ...`). Blocking the LLM turn on the audit write would add 50-200ms (Supabase round-trip) for no caller-visible benefit. The `.catch` traps any error so the detached promise does not crash Node with an unhandled rejection."
  - "Used direct `db.insert(characters).values({...})` via raw SQL in the test fixture instead of `saveCharacter` from `@/characters/persist`. Same workaround as plans 03-A-05, 03-A-06, 03-A-08 — `src/characters/derive.ts` has unresolved merge-conflict markers (preexisting from sibling plans, tracked in deferred-items.md). Raw SQL keeps the test self-contained against the conflict state."
  - "The parallel-timing assertion uses stubbed delays (500ms per leg) rather than the real Postgres latency. Rationale: Supabase round-trips have ~50ms variance which makes a real-DB timing test flaky. Stubs give deterministic upper bounds (sequential floor = 1000ms; parallel ≈ 500ms + downstream) and prove the Promise.all dispatcher behavior independently of network noise."

patterns-established:
  - "Phase 03 dual-write fan-out pattern (used by plan 03-A-10 turn-route wiring): caller builds the canonical envelope + a Postgres-mutation closure, passes both to `dualWriteApplyEvent`. The function handles parallel dispatch + view regen + parity-check + audit-insert as a single transactional unit (transactional at the audit level — either both writes succeed and any divergence is recorded, or one fails and the function re-throws). Consumers do NOT need to coordinate the four phases manually."
  - "Fire-and-forget detached-promise pattern with mandatory .catch: `void asyncFn(...).catch((e: unknown) => console.error(...))`. Used here for audit-table inserts; the pattern is reusable for any best-effort write that should not block the request-path. The mandatory `.catch` prevents unhandledRejection crashes; the `console.error` keeps the failure observable for operator debugging."
  - "Stub-based timing assertions: when a real-DB integration test needs to assert parallelism (max(t1,t2) vs sum), stub the leg implementations with `vi.spyOn(...).mockImplementation(async () => sleep(N))` instead of relying on real latency. The stubs give a deterministic sequential floor (2*N) that real parallel dispatch cannot reach; the test passes iff elapsed < floor."

threat-mitigation:
  - "REQ-006 partial — DualWriter is the primitive that enables Phase 03 dual-write coexistence; plan 03-A-10 wires it into the apply_event dispatcher to actually orchestrate vault+Postgres parity. Without this plan, Phase 03 cannot validate divergence rate before cutover."
  - "NIT 6 (plan-check) — partial-success semantics documented in JSDoc + enforced by the implementation: if either write rejects, NO view regen, NO parity-check, NO audit row. The thrown error is the operator's signal; no half-state lands silently."
  - "RESEARCH §3.1 anti-pattern avoided — NO auto-correction. The DualWriter records the divergence; the operator decides remediation (compensating event OR `pnpm vault:rebuild-views --campaign=<uuid>`). This is enforced by the absence of any state-mutation in the divergence branch."

deviations:
  - "Test runtime > 30s acceptance criterion not strictly met: the full dual-writer suite runs in ~38s (vs <30s target). Root cause is the 100-synced-writes phase-gate test (~30s alone) which performs 100 × parityCheck round-trips over the Supabase pooler (~200-300ms each). The 30s budget assumed sub-100ms round-trips (local Postgres). Reducing to 50 iterations would meet the budget but weakens the phase-gate's statistical baseline (the SLO is < 0.1% over weeks of production turns; the test is a smoke for 0 divergences under perfect sync, which 100 iterations validates with comfortable margin). Decision: accept the 38s runtime as a wired-up baseline; the CI gate is correctness (0 audit rows), not duration."
  - "Acceptance criterion 'grep -c \"void recordDivergence\" returns 1' returns 2 because the JSDoc comment also references the pattern. Both occurrences are intentional (one in active code, one in the documentation of why the pattern is used). No action needed."

metrics:
  loc-source: 249
  loc-test: 626
  files-created: 4
  test-cases-added: 10
  test-cases-passing: 31 # 8 dual-writer + 2 divergence-record + 4 dual-write-divergences (regression) + 17 parity-check (regression)
  commits: 4
  duration-minutes: ~35
  completed: 2026-05-27
---

# Phase 03 Plan A-09: DualWriter Class Summary

DualWriter primitive: synchronous parallel dual-write (vault + Postgres) + post-write parity-check + fire-and-forget divergence audit, implemented as the `dualWriteApplyEvent` function plus the `recordDivergence` audit-table wrapper. Validated by 10 new integration cases including a 100-write phase-gate baseline (0 audit rows under perfect sync).

## Goal achieved

Per RESEARCH Decision 2 (Option B — in-process function): wrap `EventsWriter.applyEvent` + caller-supplied Postgres-mutation callback in `Promise.all`, run synchronous `parityCheck` post-write, record divergence to `dual_write_divergences` fire-and-forget. Plan 03-A-10 (turn-route wiring, next Wave 4 plan) will close over the engine-mutation chain and dispatch dual-writes per apply_event call.

## What shipped

**`src/sessions/dual-writer.ts`** (179 LOC including JSDoc):
- `dualWriteApplyEvent(envelope, applyEngineMutation, ctx)` — the fan-out function.
- `DualWriteContext` — the parity scope (campaignId + sessionId + characterId).
- `DualWriteResult` — `{divergence: boolean, reason?: string}` on success; re-throws on write failure.
- 4 distinct phases: Promise.all → view regen → parity-check (skip when characterId null) → fire-and-forget audit insert.

**`src/sessions/divergence-record.ts`** (70 LOC including JSDoc):
- `recordDivergence(input)` — typed `db.insert(dualWriteDivergences).values(...)` alias.
- `RecordDivergenceInput` — direct field-to-column mapping for the audit table.

**`tests/sessions/dual-writer.test.ts`** (490 LOC, 8 cases):
1. Happy path — vault + Postgres in sync, divergence=false, no audit row.
2. Divergence detected — vault hp=25 vs postgres hp=30 (no-op pg callback), audit row written with full vaultState/postgresState/summary jsonb.
3. Vault write failure re-throws (EventsWriter.applyEvent stubbed to reject); no audit row.
4. Postgres callback failure re-throws; no audit row.
5. Parallel-timing — stubbed 500ms-per-leg delays prove Promise.all dispatched concurrently (elapsed < 1000ms sequential floor).
6. recordDivergence failure is non-fatal — caller still gets divergence flag; console.error logged via fire-and-forget .catch.
7. characterId === null skips parity-check entirely (session-level events).
8. Phase-gate baseline — 100 sequential synced writes produce 0 audit rows (REQ-006 < 0.1% SLO).

**`tests/sessions/divergence-record.test.ts`** (143 LOC, 2 cases):
1. Insert + read-back preserves vault/postgres/summary jsonb shape and Postgres-default-filled id + createdAt.
2. characterId === null accepted (session-level divergences).

## Commits

| Hash | Type | Message |
|---|---|---|
| 956c86f | feat(sessions) | add recordDivergence audit-row writer |
| c5be83f | feat(sessions) | add dualWriteApplyEvent fan-out + parity-check |
| bb4c19a | test(sessions) | dualWriteApplyEvent integration suite (8 cases) |
| cf100e7 | test(sessions) | recordDivergence insert + read-back smoke (2 cases) |

## Verification

- `pnpm typecheck` exits 0.
- `grep -c "Promise.all" src/sessions/dual-writer.ts` = 6 (≥ 1 required).
- `grep -c "parityCheck\\|recordDivergence" src/sessions/dual-writer.ts` = 12 (≥ 2 required).
- `grep -c "void recordDivergence" src/sessions/dual-writer.ts` = 2 (1 code + 1 JSDoc reference).
- `grep -c "^export async function recordDivergence" src/sessions/divergence-record.ts` = 1.
- `grep -c "dualWriteDivergences" src/sessions/divergence-record.ts` = 2 (import + insert call).
- Full suite (dual-writer + divergence-record + sibling regression): 31/31 pass.

## What's next (plan 03-A-10)

Wire `dualWriteApplyEvent` into the apply_event dispatch path in `src/app/api/sessions/[id]/turn/route.ts`. The dispatcher needs to:
1. Resolve the per-event characterId from the payload.
2. Build the `applyEngineMutation` closure around the existing `applyMutations(sessionId, [...], [])` chain (the BAKED engine pathway), translating the VaultEvent payload to the Mutation discriminated union.
3. Pass envelope + callback + ctx to `dualWriteApplyEvent`.
4. Emit the result's `divergence` flag to telemetry / structured logs.

## Self-Check: PASSED

- `src/sessions/dual-writer.ts` — FOUND
- `src/sessions/divergence-record.ts` — FOUND
- `tests/sessions/dual-writer.test.ts` — FOUND
- `tests/sessions/divergence-record.test.ts` — FOUND
- Commit 956c86f — FOUND
- Commit c5be83f — FOUND
- Commit bb4c19a — FOUND
- Commit cf100e7 — FOUND
