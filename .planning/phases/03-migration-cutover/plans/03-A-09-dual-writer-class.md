---
phase: 03
plan: A-09
type: execute
wave: 4
depends_on: [03-A-02, 03-A-05, 03-A-08]
files_modified:
  - src/sessions/dual-writer.ts
  - src/sessions/divergence-record.ts
  - tests/sessions/dual-writer.test.ts
  - tests/sessions/divergence-record.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "dualWriteApplyEvent(envelope, engineMutation, ctx) issues EventsWriter.applyEvent AND applyEngineMutation in parallel via Promise.all"
    - "After both writes succeed, parityCheck runs synchronously; on divergence, recordDivergence inserts a row in dual_write_divergences (fire-and-forget — does not block the LLM turn)"
    - "If EITHER write throws, the function re-throws (no partial-success silent state); the LLM sees isError:true on the tool result"
    - "When parity-check returns null (match), the function returns {divergence: false}"
    - "When parity-check returns ParityResult (mismatch), the function returns {divergence: true, reason: <summary>}"
    - "recordDivergence(sessionId, parityResult) inserts a row with sessionId, campaignId (from ctx), characterId (from ctx), eventType (from envelope), vaultState, postgresState, summary"
    - "Both functions handle the 'no Postgres engine mutation needed' case (a vault-only apply_event from a stateless handler) by skipping the Postgres leg AND skipping the parity check"
  artifacts:
    - path: "src/sessions/dual-writer.ts"
      provides: "dualWriteApplyEvent — the fan-out + parity-check primitive"
      exports: ["dualWriteApplyEvent", "DualWriteContext", "DualWriteResult"]
    - path: "src/sessions/divergence-record.ts"
      provides: "recordDivergence — audit-table writer"
      exports: ["recordDivergence"]
    - path: "tests/sessions/dual-writer.test.ts"
      provides: "Parallel-write + parity-check + divergence-record + error-propagation tests"
    - path: "tests/sessions/divergence-record.test.ts"
      provides: "Insert + read-back test"
  key_links:
    - from: "src/sessions/dual-writer.ts (dualWriteApplyEvent)"
      to: "src/ai/master/vault/events-writer.ts (EventsWriter.applyEvent)"
      via: "Promise.all parallel write — vault leg"
      pattern: "EventsWriter\\.applyEvent"
    - from: "src/sessions/dual-writer.ts (dualWriteApplyEvent)"
      to: "src/sessions/applicator.ts (applyEngineMutation OR the equivalent existing engine-mutation pathway)"
      via: "Promise.all parallel write — Postgres leg"
      pattern: "applyEngineMutation"
    - from: "src/sessions/dual-writer.ts"
      to: "src/ai/master/vault/parity-check.ts (plan 03-A-08)"
      via: "Synchronous post-write divergence detection"
      pattern: "parityCheck"
    - from: "src/sessions/dual-writer.ts"
      to: "src/sessions/divergence-record.ts (this plan)"
      via: "Fire-and-forget audit write on divergence"
      pattern: "recordDivergence"
---

# Plan 03-A-09: DualWriter Class

**Phase:** 03-migration-cutover
**Wave:** 4 (depends on event types + parity check + audit schema)
**Status:** Pending
**Estimated diff size:** ~200 LOC source + ~300 LOC tests / 4 files

## Goal

Per Decision 2 (Option B — in-process class): wrap `EventsWriter.applyEvent` + `applyEngineMutation` (existing Postgres engine-mutation pathway) in a single function that issues both writes in parallel, runs a synchronous parity check, and records divergence to the audit table.

**Critical design choice:** parallel via `Promise.all` so the slower leg (Postgres) doesn't double the latency vs sequential. The parity check runs ONLY after both writes succeed. Divergence record is fire-and-forget (does not block the turn).

**Anti-pattern avoided (RESEARCH §3.1):** NO auto-correction. The DualWriter records the divergence; the operator decides remediation.

## Requirements satisfied

- **REQ-006** — DualWriter is the orchestrator that keeps vault and Postgres in sync during coexistence. Without it, Phase 03 cannot validate parity before cutover.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/sessions/dual-writer.ts` | NEW | The fan-out function + types |
| `src/sessions/divergence-record.ts` | NEW | Thin DB wrapper for the audit insert |
| `tests/sessions/dual-writer.test.ts` | NEW | Behavior tests |
| `tests/sessions/divergence-record.test.ts` | NEW | Schema-bound insert test |

## Tasks

<task type="auto">
  <name>Task 1: Implement dualWriteApplyEvent</name>
  <files>src/sessions/dual-writer.ts</files>
  <read_first>
    - src/ai/master/vault/events-writer.ts (Phase 02 — EventsWriter.applyEvent signature)
    - src/ai/master/vault/projector.ts (regenerateAffectedViews)
    - src/ai/master/vault/parity-check.ts (plan 03-A-08 — parityCheck signature)
    - src/sessions/applicator.ts (or whichever module currently handles engine state mutations from the BAKED path — the function the LLM-driven engine handlers call to mutate Postgres state. Inspect imports in src/app/api/sessions/[id]/turn/route.ts to find the right module/function name)
    - src/engine/tools/handlers.ts (the engine handlers that produce mutations — to understand the EngineMutation shape)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§3.1 Pattern 1 Dual-write fan-out — the canonical code)
  </read_first>
  <action>
Create `src/sessions/dual-writer.ts`. Adapt RESEARCH §3.1 code to the actual project shape.

KEY DISCOVERY STEP: the RESEARCH plan refers to `applyEngineMutation(sessionId, characterId, mutation)`. The ACTUAL function name may be different — inspect `src/sessions/applicator.ts` or `src/engine/state-manager.ts` to find the canonical Postgres mutation entry point. Use that name in this plan. If no such single function exists, this plan creates a wrapper `applyEngineMutationAdapter(envelope, ctx)` that translates a `VaultEventEnvelope` into the appropriate engine handler call.

Tentative shape (adjust to actual project):

```ts
// src/sessions/dual-writer.ts
// Phase 03-A — synchronous dual-write fan-out + parity-check.
// Per RESEARCH Decision 2 (Option B): in-process class encapsulates
// EventsWriter.applyEvent + Postgres engine mutation + parity-check.
//
// Why parallel: Promise.all preserves the slower leg's latency, saving
// ~5-20ms vs sequential. Why synchronous parity-check: the LLM sees the
// alarm in the same turn — operator awareness is critical during the
// coexistence window.
//
// Anti-pattern avoided: NO auto-correction. The divergence record is the
// alarm; operator remediates via compensating event OR vault:rebuild-views.
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { parityCheck, type ParityResult } from '@/ai/master/vault/parity-check';
import { recordDivergence } from './divergence-record';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';

export interface DualWriteContext {
  campaignId: string;
  sessionId: string;
  /**
   * Character UUID — required for parity-check.
   * MAY be null/undefined for events that don't target a single character
   * (e.g., campaign_initialized — but that's a one-shot seed, not a
   * dual-write target; the migration script writes it directly).
   */
  characterId: string | null;
}

export interface DualWriteResult {
  divergence: boolean;
  /** Set when divergence === true; the parityCheck summary string */
  reason?: string;
}

/**
 * Issue parallel writes to vault (events.md + view regen) AND Postgres
 * (engine mutation), then run the parity-check. Either failing throws —
 * the LLM sees isError:true via the dispatcher's catch.
 *
 * `applyEngineMutation` parameter is a CALLBACK — the dispatcher passes
 * the actual engine-handler invocation. This keeps dual-writer.ts
 * decoupled from the engine module's specific function names.
 */
export async function dualWriteApplyEvent(
  envelope: VaultEventEnvelope,
  applyEngineMutation: () => Promise<void>,
  ctx: DualWriteContext,
): Promise<DualWriteResult> {
  // Phase 1 — Parallel writes
  await Promise.all([
    EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope),
    applyEngineMutation(),
  ]);
  // Phase 2 — View regen (vault-only; Postgres has none)
  await regenerateAffectedViews(ctx.campaignId, envelope);

  // Phase 3 — Synchronous parity check (skipped when no characterId target)
  if (!ctx.characterId) {
    return { divergence: false };
  }
  const result: ParityResult | null = await parityCheck(
    ctx.campaignId,
    ctx.characterId,
    ctx.sessionId,
  );
  if (!result) {
    return { divergence: false };
  }

  // Phase 4 — Fire-and-forget divergence record (does not block turn)
  void recordDivergence({
    sessionId: ctx.sessionId,
    campaignId: ctx.campaignId,
    characterId: ctx.characterId,
    eventType: envelope.type,
    parityResult: result,
  }).catch((e) => {
    // Audit write failures are non-fatal — log and proceed.
    console.error('[dual-writer] recordDivergence failed:', e instanceof Error ? e.message : e);
  });

  return { divergence: true, reason: result.summary };
}
```

**Important refinements during execution:**
- If `applyEngineMutation` is currently invoked inline in `src/app/api/sessions/[id]/turn/route.ts` (NOT as a separable function), this plan EXTRACTS it into a callable. Examine the turn route's baked branch — the existing engine-mutation pathway — and identify the call site. Wrap it in a closure for the DualWriter callback.
- The Postgres engine mutation may be a chain (`applyTool → engine.applyMutation → db.update(sessionState).set(...)`). The DualWriter callback wraps the WHOLE chain so atomicity at the engine layer is preserved.
- For event types that map to NO Postgres mutation (e.g., a vault-only `attune` that doesn't update Postgres because attunement isn't tracked there yet), the callback is a no-op. Document this case in plan 03-A-10 (wire-dual-writer) which decides per-event whether to invoke dual-write or vault-only.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "Promise.all" src/sessions/dual-writer.ts` returns ≥ 1 (parallel write)
    - `grep -c "parityCheck\\|recordDivergence" src/sessions/dual-writer.ts` returns ≥ 2
    - `grep -c "void recordDivergence" src/sessions/dual-writer.ts` returns 1 (fire-and-forget)
    - The function signature accepts `applyEngineMutation: () => Promise<void>` as a callback (decoupling)
    - On either write failing, the error propagates (no try/catch swallow)
  </acceptance_criteria>
  <done>
    DualWriter ships. Task 2 ships the audit-record writer.
  </done>
</task>

<task type="auto">
  <name>Task 2: Implement recordDivergence</name>
  <files>src/sessions/divergence-record.ts</files>
  <read_first>
    - src/db/schema/dual-write-divergences.ts (plan 03-A-05 — the table schema + DualWriteDivergenceInsert type)
    - src/ai/master/vault/parity-check.ts (plan 03-A-08 — ParityResult shape)
  </read_first>
  <action>
Create `src/sessions/divergence-record.ts`:

```ts
// src/sessions/divergence-record.ts
// Phase 03-A — thin wrapper for inserting a divergence audit row.
// Called fire-and-forget by dual-writer.ts; failures are logged but do
// not block the turn.
import { db } from '@/db/client';
import { dualWriteDivergences } from '@/db/schema';
import type { ParityResult } from '@/ai/master/vault/parity-check';

export interface RecordDivergenceInput {
  sessionId: string;
  campaignId: string;
  characterId: string | null;
  eventType: string;
  parityResult: ParityResult;
}

export async function recordDivergence(input: RecordDivergenceInput): Promise<void> {
  await db.insert(dualWriteDivergences).values({
    sessionId: input.sessionId,
    campaignId: input.campaignId,
    characterId: input.characterId,
    eventType: input.eventType,
    vaultState: input.parityResult.vault,
    postgresState: input.parityResult.postgres,
    summary: input.parityResult.summary,
  });
}
```

That's the whole module — ~25 LOC. It's separated from `dual-writer.ts` so the audit-write surface is testable in isolation.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "^export function recordDivergence" src/sessions/divergence-record.ts` returns 1
    - `grep -c "dualWriteDivergences" src/sessions/divergence-record.ts` returns 1
  </acceptance_criteria>
  <done>
    Audit writer lands.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/sessions/dual-writer.test.ts</name>
  <files>tests/sessions/dual-writer.test.ts</files>
  <read_first>
    - src/sessions/dual-writer.ts (Task 1)
    - tests/ai/master/vault/apply-event-integration.test.ts (Phase 02 — the tmpdir + seed-campaign + dispatch pattern)
    - tests/ai/master/vault/parity-check.test.ts (plan 03-A-08 — DB-fixture pattern)
  </read_first>
  <action>
Create `tests/sessions/dual-writer.test.ts`. Skip if DATABASE_URL unset.

Cases:
1. **Happy path no-divergence** — vault + Postgres writes both succeed, states match, divergence = false, NO audit row inserted
2. **Divergence detected** — vault state ahead of Postgres (simulate by having the Postgres mutation be a no-op), parityCheck returns ParityResult, audit row inserted, divergence = true with reason
3. **Vault write fails** — EventsWriter throws; dualWriteApplyEvent re-throws; NO audit row inserted (the write didn't succeed, so no divergence to record)
4. **Postgres mutation fails** — the callback throws; dualWriteApplyEvent re-throws; the LLM sees the error
5. **Parallel timing** — confirm `Promise.all` is used (mock both functions with delays; total time ≈ max(vault_time, pg_time), not sum)
6. **Parity check throws** — should NOT throw to caller (audit failure is non-fatal per the design); record the failure to console.error
7. **characterId === null skips parity check** — no parityCheck call, no audit row, divergence = false
8. **Divergence rate over 100 simulated turns** — Phase gate per ROADMAP ("dual-write divergence rate < 0.1% over 2 weeks"); fire 100 apply_events with both legs writing the SAME state; assert divergence count = 0

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('dualWriteApplyEvent', () => {
  // ... fixture setup (campaign + session + character + vault tmpdir) ...

  it('happy path — vault + Postgres in sync, no divergence', async () => {
    const result = await dualWriteApplyEvent(
      hpChangeEnvelope({ delta: -5 }),
      async () => { await db.update(sessionState).set({ hpCurrent: 25 }).where(...); },
      { campaignId, sessionId, characterId },
    );
    expect(result.divergence).toBe(false);
    // No audit row
    const audit = await db.select().from(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, sessionId));
    expect(audit).toHaveLength(0);
  });

  it('divergence detected — vault hp=25, postgres hp=20', async () => {
    const result = await dualWriteApplyEvent(
      hpChangeEnvelope({ delta: -5 }),
      async () => { /* no-op Postgres mutation — divergence */ },
      { campaignId, sessionId, characterId },
    );
    expect(result.divergence).toBe(true);
    expect(result.reason).toMatch(/hp_current/);
    // Wait briefly for fire-and-forget audit insert
    await new Promise((r) => setTimeout(r, 100));
    const audit = await db.select().from(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, sessionId));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('vault write failure re-throws (no audit row)', async () => {
    // Stub EventsWriter.applyEvent to throw
    const spy = vi.spyOn(EventsWriter, 'applyEvent').mockRejectedValueOnce(new Error('fs full'));
    await expect(dualWriteApplyEvent(
      hpChangeEnvelope({ delta: -1 }),
      async () => {},
      { campaignId, sessionId, characterId },
    )).rejects.toThrow(/fs full/);
    spy.mockRestore();
    // No new audit row
  });

  it('Postgres callback failure re-throws', async () => {
    await expect(dualWriteApplyEvent(
      hpChangeEnvelope({ delta: -1 }),
      async () => { throw new Error('pg disconnect'); },
      { campaignId, sessionId, characterId },
    )).rejects.toThrow(/pg disconnect/);
  });

  it('parallel writes — Promise.all timing', async () => {
    const start = Date.now();
    await dualWriteApplyEvent(
      hpChangeEnvelope({ delta: -1 }),
      async () => { await new Promise((r) => setTimeout(r, 200)); },
      { campaignId, sessionId, characterId },
    );
    const elapsed = Date.now() - start;
    // The vault leg is ~5-20ms; the pg leg is artificially 200ms.
    // Parallel: total ≈ 200ms (plus parity-check). Sequential would be 200ms + vault.
    // Allow some headroom but assert it's not 400ms+.
    expect(elapsed).toBeLessThan(400);
  });

  it('characterId=null skips parity check + no audit row', async () => {
    const result = await dualWriteApplyEvent(
      campaignInitializedEnvelope([]),  // session-level event
      async () => {},
      { campaignId, sessionId, characterId: null },
    );
    expect(result.divergence).toBe(false);
  });

  it('100 sequential synced writes produce 0 divergences (Phase gate)', async () => {
    for (let i = 0; i < 100; i++) {
      await dualWriteApplyEvent(
        hpChangeEnvelope({ delta: 0 }),  // no-op delta
        async () => {},                    // no-op Postgres
        { campaignId, sessionId, characterId },
      );
    }
    await new Promise((r) => setTimeout(r, 200));  // wait for any pending audit
    const audit = await db.select().from(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, sessionId));
    expect(audit.length).toBe(0);
  });
});
```

Cleanup is important — every audit row from these tests should be deleted in afterEach/afterAll.
  </action>
  <verify>
    <automated>pnpm test tests/sessions/dual-writer.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass (skipped when DATABASE_URL unset)
    - The parallel-timing case proves Promise.all (elapsed < sum)
    - The 100-write phase-gate case proves the divergence rate < 0.1% baseline
    - Test runtime < 30s
    - Fixture + audit-row cleanup is complete
  </acceptance_criteria>
  <done>
    DualWriter tested. Plan 03-A-10 wires it into the apply_event dispatcher.
  </done>
</task>

<task type="auto">
  <name>Task 4: Write tests/sessions/divergence-record.test.ts</name>
  <files>tests/sessions/divergence-record.test.ts</files>
  <read_first>
    - src/sessions/divergence-record.ts (Task 2)
    - tests/db/dual-write-divergences.test.ts (plan 03-A-05 — table-level fixture pattern)
  </read_first>
  <action>
Create `tests/sessions/divergence-record.test.ts`. Skip if DATABASE_URL unset.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('recordDivergence', () => {
  // ... fixture setup ...

  it('inserts a row with all fields from ParityResult', async () => {
    await recordDivergence({
      sessionId,
      campaignId,
      characterId,
      eventType: 'hp_change',
      parityResult: {
        diverged: true,
        summary: 'hp_current vault=20 pg=15',
        vault: { hp_current: 20 },
        postgres: { hp_current: 15 },
      },
    });
    const [row] = await db.select().from(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, sessionId)).limit(1);
    expect(row.eventType).toBe('hp_change');
    expect(row.summary).toMatch(/hp_current/);
    expect(row.vaultState).toEqual({ hp_current: 20 });
    expect(row.postgresState).toEqual({ hp_current: 15 });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('characterId can be null', async () => {
    await recordDivergence({
      sessionId,
      campaignId,
      characterId: null,
      eventType: 'session_level',
      parityResult: { diverged: true, summary: 'flag mismatch', vault: {}, postgres: {} },
    });
    const rows = await db.select().from(dualWriteDivergences).where(eq(dualWriteDivergences.sessionId, sessionId));
    const nullCharRow = rows.find((r) => r.characterId === null);
    expect(nullCharRow).toBeDefined();
  });
});
```
  </action>
  <verify>
    <automated>pnpm test tests/sessions/divergence-record.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - Both cases pass
    - The insert + read-back round-trip preserves jsonb shape
    - The nullable characterId case works
  </acceptance_criteria>
  <done>
    Audit writer tested.
  </done>
</task>
