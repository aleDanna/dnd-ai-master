---
phase: 03-migration-cutover
plan: A-10
subsystem: turn-route
tags: [dual-write, dispatcher-gate, apply-event, turn-route, wave-4, coexistence]

requires:
  - phase: 03-migration-cutover (plan 03-A-09)
    provides: dualWriteApplyEvent(envelope, applyEngineMutation, ctx) → Promise<DualWriteResult> (parallel vault + Postgres + parity-check + fire-and-forget audit)
  - phase: 03-migration-cutover (plan 03-B-01)
    provides: resolveDualWrite(settings) → boolean (operator-set coexistence gate; no env override by design)
  - phase: 02-vault-write-path-event-sourcing (plan 02-07)
    provides: dispatchVaultTool apply_event branch with VaultDispatchContext + EventsWriter.applyEvent + regenerateAffectedViews single-write semantics (Phase 02 fallback path)
  - phase: 02-vault-write-path-event-sourcing (plan 02-08)
    provides: vaultMutations gate at the route boundary (this plan extends the gate with an orthogonal dualWrite flag, coupled at the route to keep apply_event-reachability consistent)

provides:
  - "src/sessions/event-to-engine-mutation.ts exporting invokeEnginePathwayFromEvent(envelope, sessionId, characterId) — the Postgres-leg reverse lookup that the dispatcher closes over as the dual-writer's applyEngineMutation callback"
  - "VaultDispatchContext extended with dualWrite?: boolean, sessionId?: string, characterId?: string | null (all optional; defaults preserve Phase 02 single-write semantics)"
  - "dispatchVaultTool apply_event branch with the dual-write gate: when ctx.dualWrite === true AND ctx.sessionId is set, the call fans out via dualWriteApplyEvent; otherwise the Phase 02 single-write path runs unchanged"
  - "VaultLoopInput extended with dualWrite?: boolean + the loop's per-tool-call extractCharacterIdFromToolInput helper that pulls payload.character out of apply_event tool inputs for forwarding"
  - "Turn route (src/app/api/sessions/[id]/turn/route.ts) resolving dualWrite via resolveDualWrite + coupling it to vaultMutationsEnabled (no apply_event reachability ⇒ no dual-write)"
  - "tests/sessions/turn-route-dual-write.test.ts — 4 DATABASE_URL-gated end-to-end cases proving the gate quadrants through runVaultToolLoop"

affects:
  - "Sub-phase 03-A is COMPLETE — REQ-006 (Phase 03 dual-write coexistence) is now end-to-end wired. Opted-in campaigns dual-write on every apply_event; the operator can monitor `SELECT count(*) FROM dual_write_divergences WHERE created_at > now() - interval '24h'` and use the parity-rate as the cutover gate (target < 0.1% per REQ-006 SLO)."
  - "Operator runbook (Phase 03 enablement): flip a campaign with `UPDATE campaigns SET settings = settings || '{\"dualWrite\":true}'::jsonb WHERE id = '<uuid>'`. The next LLM turn observes the flag through resolveDualWrite + writes to both stores. The vault-flip script (plan 03-B-02) is the proper UI, but the manual SQL works for ad-hoc enablement of a single campaign."
  - "Plan 03-B-07 (snapshot reader cutover) — when sourceOfTruth flips to 'vault', the parity-rate from this plan's dual-write tells the operator whether the vault state is trustworthy. Without 03-A-10 the operator would have no signal before flipping reads."

tech-stack:
  added: []
  patterns:
    - "Dispatcher-level gate with fail-closed defensive fallback: the apply_event branch checks `ctx.dualWrite === true && typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0`. If dualWrite is true but sessionId is missing (route misconfiguration), the branch falls through to Phase 02 single-write rather than half-configuring a dual-write. The route-side coupling (dualWriteEnabled = vaultMutationsEnabled && resolveDualWrite(...)) ensures sessionId is always set when dualWrite reaches the dispatcher in production."
    - "Direct-Drizzle reverse lookup (event-to-engine-mutation.ts): rather than route the Postgres leg through the engine's applyMutations (which carries notifySession + dedup + SessionContext side effects that would re-emit state notifications + misroute multi-PC events), the dual-write Postgres callback performs the EXACT column update per event type that the engine's baked path would have produced. The mapping is documented arm-by-arm against COMPLETENESS-AUDIT.md §(a)/(c)."
    - "Dynamic imports inside the apply_event branch (`await import('@/sessions/dual-writer')` + `await import('@/sessions/event-to-engine-mutation')`) so the Phase 01 read-only vault path does not pay the module-load cost for the Postgres dual-writer (which transitively pulls in drizzle + the DB client + ~6MB of pg dependency graph). Read-only test fixtures stay minimal."
    - "extractCharacterIdFromToolInput helper at the loop boundary: pulls payload.character out of the LLM's apply_event tool input and forwards it as ctx.characterId so the dispatcher does not have to re-parse the validated envelope. Tools other than apply_event return null (loop-internal contract — the dispatcher only consults characterId inside the apply_event branch)."
    - "Conditional-spread routing pattern (mirrors Phase 02 campaignId): `...(dualWriteEnabled && { dualWrite: true })`. Keeps the loop input object minimal when the flag is off and matches the existing route-level pattern Phase 02 established for vaultMutations gating."

key-files:
  created:
    - src/sessions/event-to-engine-mutation.ts
    - tests/sessions/turn-route-dual-write.test.ts
    - .planning/phases/03-migration-cutover/03-A-10-SUMMARY.md (this file)
  modified:
    - src/ai/master/vault/tools.ts # +90 LOC — VaultDispatchContext extension + apply_event dual-write branch
    - src/ai/master/vault/loop.ts # +64 LOC — VaultLoopInput.dualWrite + extractCharacterIdFromToolInput + dispatch ctx forwarding
    - src/app/api/sessions/[id]/turn/route.ts # +20 LOC — resolveDualWrite import + dualWriteEnabled coupling + conditional-spread forward
    - .planning/phases/03-migration-cutover/deferred-items.md # +25 LOC — note pre-existing applicator.test.ts gp-currency failure as out-of-scope

key-decisions:
  - "Direct-Drizzle reverse lookup (NOT applyMutations) for the Postgres leg. The plan's task action suggested direct Drizzle UPDATE statements rather than routing through `applyMutations` from src/sessions/applicator.ts. Architecturally the applicator path would have given single-source-of-truth re-use, but it carries side effects (notifySession, dedup logic, multi-PC SessionContext routing keyed off the host PC, internal transaction) that the dual-write path must NOT trigger per-event. Direct Drizzle gives the dispatch loop the EXACT column update the parity-check then diffs — no extra events, no misrouting in party play."
  - "Coupled the route-level dualWrite gate to vaultMutationsEnabled: `dualWriteEnabled = vaultMutationsEnabled && resolveDualWrite(userPrefs)`. The plan's contract called for the route to 'forward dualWrite via VaultDispatchContext' but didn't specify the coupling. Decision rationale: dual-write only makes sense when apply_event is reachable; with vaultMutations false, apply_event is gated off and the dispatcher dual-write branch would never fire anyway. Coupling at the route avoids a misleading log line ('dualWrite=true' but never observable in the dispatcher) and keeps the runtime gate semantically consistent — operator sees ONE coupled status at the route boundary, not two orthogonal flags they have to reason about."
  - "Defensive fallthrough on missing sessionId: `if (ctx.dualWrite === true && typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0)`. The plan's contract specified `dualWrite=true without sessionId in ctx → falls back to Phase 02 path defensively` as a test case (case 4). Implementation: the empty-string check is the belt-and-suspenders layer alongside the typeof check — both handle the case where a future refactor of the route forgets to set sessionId. The dispatcher never half-configures a dual-write."
  - "Carry divergence reason in the success envelope when divergence detected: `JSON.stringify({ ok: true, event_id, divergence: result.reason })`. The plan didn't specify what to return to the LLM on divergence; choices were (a) silent success, (b) include the reason in the success envelope, (c) treat as isError. Chose (b): the operator-side audit row in dual_write_divergences is the authoritative record; the LLM-visible reason field is informational only (a curious model can mention the issue in narration). Treating as isError would falsely tell the LLM the apply_event itself failed (it didn't — both stores wrote successfully)."
  - "Used dynamic imports (`await import('@/sessions/dual-writer')`) inside the apply_event dual-write branch rather than top-level imports. Rationale: Phase 01 read-only vault tests don't need the Postgres dual-writer or the engine-mutation alias loaded into the module graph (would force drizzle + pg into the read-only test surface). Top-level imports work, but the dynamic-import keeps the Phase 01 test fixture footprint minimal — matches the spike-009 'least-cost-by-default' principle."
  - "Test design choice: invoke `runVaultToolLoop` with a stub MasterProvider rather than the full POST handler. The handler requires Clerk auth + SSE notify + DB session row + lock acquisition + provider routing. The Phase 02 gate test (vault-mutations-gate.test.ts) established the precedent of unit-testing the decision logic + the inputs the vault branch passes to the loop. This plan extends the pattern: stub the LLM's tool_use sequence, run the loop, assert side effects on vault + Postgres + dual_write_divergences. End-to-end POST testing is reserved for the manual smoke checklist in the verification block."

patterns-established:
  - "Phase 03 apply_event dual-write dispatch (the wire-up pattern future event-sourced tools will follow): dispatcher branch checks the gate field on ctx, dynamic-imports the dual-writer + the Postgres-equivalent callback module, builds the closure, calls dualWriteApplyEvent with (envelope, callback, audit-context), returns JSON success with optional divergence field. Same shape as the Phase 02 single-write branch, with the dual-write fan-out as a strict superset."
  - "Direct-Drizzle event-to-mutation alias: when adding a new VaultEvent type, add a matching `case` arm in src/sessions/event-to-engine-mutation.ts that performs the corresponding session_state / characters column update. The `default: const _exhaustive: never = event` arm guarantees tsc catches a missed event-type at compile time. Per-arm comments reference the applicator.ts equivalent for grep-traceability."
  - "Coupled gate evaluation at the route boundary: when two campaign settings flags interact (here: vaultMutations + dualWrite), compute the AND at the route and forward the single resulting boolean. Avoids the dispatcher having to know about routing semantics; keeps the runtime decision local to the route's per-turn resolution step."

threat-mitigation:
  - "REQ-006 closed end-to-end — opted-in campaigns now dual-write on every apply_event with synchronous parity-check + audit row on divergence. The cutover gate (parity-rate < 0.1% over 2 weeks of production) is now monitorable."
  - "T-02-07 (server-side-only context fields) preserved + extended — dualWrite, sessionId, characterId are all server-resolved like campaignId; the LLM cannot supply or influence them. Resolution happens once per turn at the route, the same place vaultMutations + campaignId are resolved."
  - "Pitfall 5 alignment — the route-level coupling (dualWriteEnabled requires vaultMutationsEnabled) mirrors the resolver-level enforcement in resolveVaultMutations (returns false when masterBackend !== 'vault'). Both layers fail-closed so an orphan flag (dualWrite:true on a non-vault or non-mutations campaign) silently no-ops instead of causing a half-configured dual-write."

deviations:
  - "[Rule 1 - Bug] Test fixture initial NormalizedUsage shape used `totalTokens: 150` (and similar) which is not a field of NormalizedUsage (cacheReadTokens + cacheCreationTokens are). Fixed via global replace in the test file — three stub responses now use the correct shape. Discovered during the first `pnpm typecheck` after writing the test; resolved before commit. Files modified: tests/sessions/turn-route-dual-write.test.ts. No commit-separate fix — folded into the Task 3 commit."
  - "[Out-of-scope discovery] tests/sessions/applicator.test.ts has 1/98 failure (`add_inventory + remove_inventory + set_equipped persist to characters.inventory` — gp currency, expected qty:60 got qty:50). The failure is pre-existing (`git log` on applicator.ts last touch 7ad8533, predates this plan) and unrelated to the 03-A-10 file scope. Per SCOPE BOUNDARY rule, logged to .planning/phases/03-migration-cutover/deferred-items.md (2026-05-27 entry); NOT fixed in this plan."

metrics:
  loc-source: 484 # 415 event-to-engine-mutation.ts + 90 tools.ts + 64 loop.ts + 20 route.ts (-105 deletions/comments mixed)
  loc-test: 501
  files-created: 2
  files-modified: 4 # tools.ts, loop.ts, route.ts, deferred-items.md
  test-cases-added: 4
  test-cases-passing: 47 # 4 turn-route-dual-write + 8 dual-writer (regression) + 2 divergence-record (regression) + 14 turn-route-branch (regression) + 19 vault-mutations-gate (regression)
  commits: 3
  duration-minutes: ~40
  completed: 2026-05-27
---

# Phase 03 Plan A-10: Wire DualWriter Into the Turn Route Summary

Closes REQ-006 dual-write coexistence end-to-end: the apply_event dispatcher now consults a server-resolved `dualWrite` flag and routes through `dualWriteApplyEvent` (parallel vault + Postgres + parity-check + fire-and-forget audit) when set, preserving Phase 02 single-write semantics otherwise. Validated by 4 new end-to-end cases through `runVaultToolLoop` + 43 regression cases across the dependent subsystems (dual-writer, divergence-record, vault-mutations-gate, turn-route-branch).

## Goal achieved

Per the plan's contract: extended `VaultDispatchContext` with `dualWrite + sessionId + characterId` (all optional), added a conditional branch inside the `apply_event` dispatcher that fans out via `dualWriteApplyEvent` when `ctx.dualWrite === true && ctx.sessionId` is set, preserved the verbatim Phase 02 single-write path for all other cases. Shipped the new `event-to-engine-mutation.ts` reverse-lookup module (NIT-3 from plan-check) so the dual-writer's Postgres-leg callback has a single composable source for the column updates per event type. Wired the turn route to resolve `dualWrite` via `resolveDualWrite` + couple it to `vaultMutationsEnabled` so the dispatcher only sees `dualWrite:true` when apply_event is actually reachable.

## What shipped

**`src/sessions/event-to-engine-mutation.ts`** (415 LOC including JSDoc):
- `invokeEnginePathwayFromEvent(envelope, sessionId, characterId)` — direct-Drizzle reverse lookup from VaultEvent envelope to session_state / characters column update.
- One arm per Phase 02 + Phase 03 event type (28 total, all covered with the exception of `campaign_initialized` which is a deferred no-op and `level_up` which is not exposed via the vault apply_event surface). Mapping documented arm-by-arm against `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` §(a)/(c).
- `default: const _exhaustive: never = event` arm guarantees tsc catches missed event types at compile-time. Runtime fallthrough returns silently.

**`src/ai/master/vault/tools.ts`** (+90 LOC):
- `VaultDispatchContext` gains `dualWrite?: boolean`, `sessionId?: string`, `characterId?: string | null`. All optional; absent defaults preserve Phase 02 single-write behavior. JSDoc documents the server-side resolution path (route → loop → dispatcher) and the LLM-cannot-supply invariant for each.
- `apply_event` dispatch branch gains the dual-write conditional. When `ctx.dualWrite === true && typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0`, dynamic-imports `dualWriteApplyEvent` + `invokeEnginePathwayFromEvent`, builds the closure, calls the fan-out, returns JSON success with optional `divergence` field. Otherwise the Phase 02 single-write path runs verbatim.

**`src/ai/master/vault/loop.ts`** (+64 LOC):
- `VaultLoopInput` gains `dualWrite?: boolean`.
- `extractCharacterIdFromToolInput(name, input)` helper — returns `payload.character` UUID for `apply_event`, null otherwise. Used at every tool-dispatch site to forward characterId into the dispatch ctx.
- Both `dispatchVaultTool` call-sites (end_turn + general tool dispatch) now forward `dualWrite + sessionId + characterId` alongside the existing `vaultRoot + campaignId`.

**`src/app/api/sessions/[id]/turn/route.ts`** (+20 LOC):
- Imports `resolveDualWrite` from `@/lib/preferences`.
- Inside the vault branch: `const dualWriteEnabled = vaultMutationsEnabled && resolveDualWrite(userPrefs)`. Coupled gate — dual-write makes no sense without apply_event being reachable.
- `runVaultToolLoop` call extended with the conditional spread `...(dualWriteEnabled && { dualWrite: true })`. Mirrors the existing `...(vaultMutationsEnabled && { campaignId: campaign.id })` Phase 02 pattern.
- Log line updated to surface both flags: `vaultMutations=... dualWrite=...`.

**`tests/sessions/turn-route-dual-write.test.ts`** (501 LOC, 4 cases):
1. `dualWrite=false → Phase 02 single-write (events.md grows, Postgres untouched)`. Regression for the unchanged path: confirms the absence of dualWrite preserves Phase 02 behavior.
2. `dualWrite=true synchronized → both stores update, no audit row`. The happy path: dispatcher routes to dualWriteApplyEvent, vault hp_change(-5) projects to 25, Postgres callback also reaches 25, parity-check sees match.
3. `dualWrite=true with pre-existing mismatch → divergence audit row inserted`. Forces a divergence by directly setting `hpCurrent=1` in Postgres before the loop — hp_change(-5) brings vault to 25 but Postgres clamps to 0. Audit row written with `event_type='hp_change'`, character_id, summary mentioning hp_current.
4. `dualWrite=true without sessionId → defensive fallback to Phase 02 path`. Directly invokes `dispatchVaultTool` with a malformed context (dualWrite:true, sessionId absent). The dispatcher's `typeof ctx.sessionId === 'string'` guard catches it; vault appends via the Phase 02 path; Postgres untouched; no audit row.

Skip-all when DATABASE_URL absent (mirrors `dual-writer.test.ts` pattern). Runtime: 7.89s for the 4 cases (well below the 30s budget).

## Verification (manual + automated)

**Automated — passing as of completion:**
- `pnpm typecheck` → exit 0
- `pnpm test tests/sessions/turn-route-dual-write.test.ts` → 4/4 passed in 7.89s
- `pnpm test tests/sessions/dual-writer.test.ts` → 8/8 passed (regression for plan 03-A-09)
- `pnpm test tests/sessions/divergence-record.test.ts tests/ai/master/vault/parity-check.test.ts` → 19/19 passed (regression)
- `pnpm test tests/sessions/turn-route-branch.test.ts` → 14/14 passed (Phase 01 regression)
- `pnpm test tests/sessions/vault-mutations-gate.test.ts` → 19/19 passed (Phase 02 regression)
- `pnpm test tests/ai/master/vault/` → 553/555 passed (2 unrelated skips)

**Manual — recommended before flipping a real campaign:**
1. Bring up a local Postgres + a freshly-flipped campaign: `pnpm vault:flip --campaign=<uuid>`.
2. Flip dual-write on: `UPDATE campaigns SET settings = settings || '{"dualWrite":true}'::jsonb WHERE id = '<uuid>'`.
3. Run a short combat scenario (3-5 turns with apply_event calls per turn).
4. Verify `events.md` for the campaign contains the expected events; `SELECT * FROM session_state WHERE session_id = '<sid>'` shows matching hp/conditions/slots; `SELECT count(*) FROM dual_write_divergences WHERE session_id = '<sid>'` returns 0.
5. Provoke a divergence (manually mutate session_state outside the dispatcher) + run one more apply_event turn — the audit row should appear with the diff summary.

## Plan execution notes

- 3 atomic commits (one per task) + this SUMMARY commit. All commits on `main` (no branching strategy per `config.json`).
- All commits include the Co-Authored-By trailer.
- Plan-check NITs all addressed pre-execution by the planner. Implementation followed the contract; only one substantive decision adjustment was made — coupling `dualWriteEnabled` to `vaultMutationsEnabled` at the route boundary (key decision 2 above). The contract did not require nor forbid this; coupling is the defensible choice for semantic consistency.

## Deviations from plan

**Auto-fixed:**

**1. [Rule 1 - Bug] NormalizedUsage shape mismatch in test stub**
- **Found during:** Task 3 (first typecheck after writing the test)
- **Issue:** test stub used `{ inputTokens, outputTokens, totalTokens }` — `totalTokens` is not a field of `NormalizedUsage` (the type has `cacheReadTokens + cacheCreationTokens` instead).
- **Fix:** global-replace in the test file: three stub responses now use `{ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 }`.
- **Files modified:** tests/sessions/turn-route-dual-write.test.ts
- **Commit:** 644dc58 (folded into Task 3 commit; pre-commit typecheck caught it)

**Out-of-scope discoveries:**

**2. tests/sessions/applicator.test.ts has 1/98 pre-existing failure**
- `add_inventory + remove_inventory + set_equipped persist to characters.inventory` expects `qty:60` on the `gp` slug, gets `qty:50`. The cross-denomination payCurrency special-case (src/sessions/currency.ts) likely evolved without the test expectation updating.
- Pre-existing per git log (applicator.ts last touched at 7ad8533, predates plan 03-A-10). Plan 03-A-10 modifies ZERO files involved in this test.
- Per SCOPE BOUNDARY rule, logged in `.planning/phases/03-migration-cutover/deferred-items.md` (2026-05-27 entry); NOT fixed.

## Self-Check: PASSED

- All claimed created files exist: `src/sessions/event-to-engine-mutation.ts`, `tests/sessions/turn-route-dual-write.test.ts`, `.planning/phases/03-migration-cutover/03-A-10-SUMMARY.md` (this file). Verified via `[ -f path ]`.
- All claimed commits exist on `main` per `git log --oneline -10`: 02f3e63, 66ac772, 644dc58.
- All file modifications verified via `git diff --stat` on the commits above.
- All test claims verified via direct test execution with `DATABASE_URL` set from `.env.local`.
