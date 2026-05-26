---
phase: 03
plan: A-10
type: execute
wave: 4
depends_on: [03-A-09, 03-B-01]
files_modified:
  - src/app/api/sessions/[id]/turn/route.ts
  - src/ai/master/vault/tools.ts
  - tests/sessions/turn-route-dual-write.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "The apply_event dispatcher branch checks resolveDualWrite(campaign.settings) — when true, it invokes dualWriteApplyEvent; when false, it preserves Phase 02 vault-only behavior"
    - "The dispatch context carries enough info to construct an applyEngineMutation callback (sessionId, characterId, original engine state, the corresponding engine-handler call)"
    - "When a Phase 03 event type has NO Postgres counterpart (e.g., attune), dualWriteApplyEvent is called with an empty callback (the vault leg writes; Postgres leg is a no-op; parity-check still runs but won't fire on fields neither side tracks)"
    - "The turn-route does NOT gate dual-write on the per-event basis itself — that's the dispatcher's responsibility; the turn-route just resolves campaign settings and forwards them via VaultDispatchContext (or equivalent)"
    - "Phase 02's vault-only behavior is preserved for campaigns with dualWrite !== true (the existing 02-08 coexistence semantics still hold)"
  artifacts:
    - path: "src/app/api/sessions/[id]/turn/route.ts"
      provides: "Vault branch passes resolved dualWrite flag into the dispatch context"
    - path: "src/ai/master/vault/tools.ts"
      provides: "apply_event dispatch branch now checks ctx.dualWrite and routes to dualWriteApplyEvent when true"
    - path: "tests/sessions/turn-route-dual-write.test.ts"
      provides: "End-to-end test exercising the gated dual-write path through the turn route"
  key_links:
    - from: "src/app/api/sessions/[id]/turn/route.ts (vault branch)"
      to: "src/lib/preferences.ts (resolveDualWrite — plan 03-B-01)"
      via: "Gates the dispatch behavior"
      pattern: "resolveDualWrite"
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/sessions/dual-writer.ts (dualWriteApplyEvent)"
      via: "Conditional call when ctx.dualWrite === true"
      pattern: "dualWriteApplyEvent"
---

# Plan 03-A-10: Wire DualWriter Into the Turn Route

**Phase:** 03-migration-cutover
**Wave:** 4 (depends on 03-A-09 DualWriter + 03-B-01 dualWrite flag)
**Status:** Pending
**Estimated diff size:** ~180 LOC source + ~250 LOC tests / 3 files

## Goal

Plan 03-A-09 ships `dualWriteApplyEvent` as a standalone function. This plan wires it into the actual turn-route → apply_event dispatch path, gated on the new `dualWrite` campaign setting (plan 03-B-01).

The wiring point: `src/ai/master/vault/tools.ts` `dispatchVaultTool` apply_event branch. When `ctx.dualWrite === true`, the branch calls `dualWriteApplyEvent`. When false, the existing Phase 02 path (`EventsWriter.applyEvent` + `regenerateAffectedViews`) is preserved verbatim.

The turn-route (`src/app/api/sessions/[id]/turn/route.ts`) resolves the campaign's `dualWrite` flag and forwards it via the `VaultDispatchContext` (extended to include the flag).

## Requirements satisfied

- **REQ-006** — Closes the dual-write coexistence loop. After this plan lands, opted-in campaigns dual-write on every apply_event.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/app/api/sessions/[id]/turn/route.ts` | EDIT | Resolve dualWrite + forward via dispatch context |
| `src/ai/master/vault/tools.ts` | EDIT | Add ctx.dualWrite branching in apply_event dispatch |
| `tests/sessions/turn-route-dual-write.test.ts` | NEW | End-to-end gated path test |

## Tasks

<task type="auto">
  <name>Task 1: Extend VaultDispatchContext with dualWrite + applyEngineMutation callback</name>
  <files>src/ai/master/vault/tools.ts</files>
  <read_first>
    - src/ai/master/vault/tools.ts (existing VaultDispatchContext interface — currently `{vaultRoot?, campaignId?}`; the apply_event dispatch branch from Phase 02 plan 02-07 + Phase 03 plan 03-A-04)
    - src/sessions/dual-writer.ts (plan 03-A-09 — dualWriteApplyEvent signature)
    - src/lib/preferences.ts (plan 03-B-01 — resolveDualWrite resolver)
  </read_first>
  <action>
Edit `src/ai/master/vault/tools.ts`. Two changes.

**Change 1 — Extend VaultDispatchContext.** The interface currently has `vaultRoot?: string; campaignId?: string;`. Add two new optional fields:

```ts
export interface VaultDispatchContext {
  vaultRoot?: string;
  campaignId?: string;
  /**
   * Phase 03-A — when true, apply_event dispatches via dualWriteApplyEvent
   * (parallel write to vault + Postgres + parity-check). When false (default),
   * Phase 02 behavior is preserved (vault-only single-write).
   *
   * Resolved server-side from campaign.settings.dualWrite (plan 03-B-01's
   * resolveDualWrite). NEVER LLM-supplied.
   */
  dualWrite?: boolean;
  /**
   * Phase 03-A — sessionId for the parity-check + audit context. Required when
   * dualWrite === true. Server-side from the validated Clerk session row.
   */
  sessionId?: string;
  /**
   * Phase 03-A — character UUID for the parity-check target. Resolved from
   * the event payload at dispatch time (the LLM sends character UUID in
   * event.payload.character).
   *
   * For session-level events (campaign_initialized) or vault-only events that
   * don't target a character, the dispatch loop sets this to null and the
   * parity-check is skipped.
   */
  characterId?: string | null;
}
```

**Change 2 — Extend apply_event dispatch branch.** Currently the branch (from plan 02-07) calls:
```ts
await EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope);
await regenerateAffectedViews(ctx.campaignId, envelope);
```

Replace with conditional dispatch:

```ts
    // After validateEvent succeeds — envelope is fully typed
    if (ctx.dualWrite === true && ctx.sessionId) {
      // Phase 03-A — dual-write gated
      const { dualWriteApplyEvent } = await import('@/sessions/dual-writer');
      // Build the Postgres engine-mutation callback. This MUST mirror what
      // the baked path does for the same engine handler. For now, the
      // simplest correct shape is: re-invoke the corresponding engine
      // handler from src/engine/tools/handlers.ts, then persist the
      // resulting state via the existing applicator pathway.
      //
      // For most event types, the mapping is:
      //   hp_change → apply_damage / heal handler
      //   condition_add/remove → apply_condition / remove_condition
      //   spell_slot_use/restore → use_resource (spell slot variant)
      //   ...
      // The dispatcher must compute the engine-handler invocation from
      // the envelope. See COMPLETENESS-AUDIT.md (a) mapping for the
      // event → handler reverse-lookup.
      const applyEngineMutation = async (): Promise<void> => {
        await invokeEnginePathwayFromEvent(envelope, ctx.sessionId!, ctx.characterId ?? null);
      };
      try {
        const result = await dualWriteApplyEvent(
          envelope,
          applyEngineMutation,
          { campaignId: ctx.campaignId!, sessionId: ctx.sessionId, characterId: ctx.characterId ?? null },
        );
        return {
          content: JSON.stringify({
            ok: true,
            event_id: envelope.id,
            divergence: result.divergence ? result.reason : undefined,
          }),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `ERROR: apply_event dual-write failed: ${message}`, isError: true };
      }
    }

    // Phase 02 single-write path — preserved for non-dual-write campaigns
    try {
      await EventsWriter.applyEvent(eventsPath(ctx.campaignId), envelope);
      await regenerateAffectedViews(ctx.campaignId, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: apply_event failed during persist: ${message}`, isError: true };
    }
    return { content: JSON.stringify({ ok: true, event_id: envelope.id }), isError: false };
```

**Critical:** the `invokeEnginePathwayFromEvent` function does NOT yet exist. This plan ALSO ships it as part of the same edit. It lives in `src/sessions/event-to-engine-mutation.ts` (NEW file, owned by THIS plan). The function reads the (a) mapping table from COMPLETENESS-AUDIT.md and dispatches to the right engine handler.

Add a Task 1.5 for the `event-to-engine-mutation.ts` file (the file_modified list above should include it).

The reverse lookup (event → engine handler invocation) is the largest cost in this plan. Simplest impl:

```ts
// src/sessions/event-to-engine-mutation.ts
// Reverse lookup: VaultEvent → engine handler invocation.
// (a) mapping from .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md
//
// For each known event type, this function performs the EQUIVALENT
// Postgres mutation that the baked path would have performed when the
// LLM called the corresponding engine tool.
import { db } from '@/db/client';
import { sessionState, characters } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { VaultEvent, VaultEventEnvelope } from '@/ai/master/vault/events-schema';

export async function invokeEnginePathwayFromEvent(
  envelope: VaultEventEnvelope,
  sessionId: string,
  characterId: string | null,
): Promise<void> {
  const event = envelope as VaultEvent;
  switch (event.type) {
    case 'hp_change': {
      // Read current hp, apply delta, write back, clamped to [0, hp_max]
      const [char] = await db.select({ hpMax: characters.hpMax }).from(characters).where(eq(characters.id, event.payload.character)).limit(1);
      const [state] = await db.select({ hpCurrent: sessionState.hpCurrent }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!char || !state) return;
      const next = Math.max(0, Math.min(char.hpMax, state.hpCurrent + event.payload.delta));
      await db.update(sessionState).set({ hpCurrent: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'temp_hp_set': {
      await db.update(sessionState).set({ tempHp: Math.max(0, event.payload.tempHp) }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'condition_add': {
      // Append to conditions array (idempotent)
      const [state] = await db.select({ conditions: sessionState.conditions }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const existing = state.conditions ?? [];
      if (existing.some((c) => c.slug === event.payload.condition)) return;
      const next = [...existing, { slug: event.payload.condition, source: 'vault-tool', durationRounds: 'until_removed' as const, appliedRound: 0 }];
      await db.update(sessionState).set({ conditions: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'condition_remove': {
      const [state] = await db.select({ conditions: sessionState.conditions }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const next = (state.conditions ?? []).filter((c) => c.slug !== event.payload.condition);
      await db.update(sessionState).set({ conditions: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'spell_slot_use':
    case 'spell_slot_restore': {
      const [char] = await db.select({ spellSlotsUsed: characters.spellSlotsUsed }).from(characters).where(eq(characters.id, event.payload.character)).limit(1);
      if (!char) return;
      const used = { ...(char.spellSlotsUsed ?? {}) };
      const level = String(event.payload.level);
      const cur = used[level] ?? 0;
      const next = event.type === 'spell_slot_use' ? cur + 1 : Math.max(0, cur - 1);
      used[level] = next;
      await db.update(characters).set({ spellSlotsUsed: used }).where(eq(characters.id, event.payload.character));
      return;
    }
    case 'death_save_success':
    case 'death_save_fail':
    case 'death_save_stabilize': {
      const [state] = await db.select({ deathSaves: sessionState.deathSaves, flags: sessionState.flags }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const ds = state.deathSaves ?? { successes: 0, failures: 0 };
      const flags = state.flags ?? {};
      // Replicate projector reducer semantics
      if (event.type === 'death_save_success') {
        const successes = ds.successes + 1;
        if (successes >= 3) {
          await db.update(sessionState).set({ deathSaves: { successes: 0, failures: 0 }, flags: { ...flags, stable: true } }).where(eq(sessionState.sessionId, sessionId));
        } else {
          await db.update(sessionState).set({ deathSaves: { successes, failures: ds.failures } }).where(eq(sessionState.sessionId, sessionId));
        }
      } else if (event.type === 'death_save_fail') {
        const incrementBy = event.payload.critical ? 2 : 1;
        const failures = ds.failures + incrementBy;
        if (failures >= 3) {
          await db.update(sessionState).set({ deathSaves: { successes: 0, failures: 0 }, flags: { ...flags, dead: true } }).where(eq(sessionState.sessionId, sessionId));
        } else {
          await db.update(sessionState).set({ deathSaves: { successes: ds.successes, failures } }).where(eq(sessionState.sessionId, sessionId));
        }
      } else {
        // death_save_stabilize
        await db.update(sessionState).set({ deathSaves: { successes: 0, failures: 0 }, flags: { ...flags, stable: true } }).where(eq(sessionState.sessionId, sessionId));
      }
      return;
    }
    case 'concentration_set': {
      await db.update(sessionState).set({
        concentratingOn: {
          spellSlug: event.payload.spellSlug,
          slotLevel: event.payload.slotLevel,
          startedRound: event.payload.startedRound,
        },
      }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'concentration_break': {
      await db.update(sessionState).set({ concentratingOn: null }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'exhaustion_set': {
      await db.update(sessionState).set({ exhaustionLevel: Math.max(0, Math.min(10, event.payload.level)) }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'hit_dice_use':
    case 'hit_dice_restore': {
      const [state] = await db.select({ hitDiceRemaining: sessionState.hitDiceRemaining }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const next = event.type === 'hit_dice_use'
        ? Math.max(0, state.hitDiceRemaining - event.payload.count)
        : state.hitDiceRemaining + event.payload.count;
      await db.update(sessionState).set({ hitDiceRemaining: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'resource_use': {
      const [state] = await db.select({ resourcesUsed: sessionState.resourcesUsed }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const used = { ...(state.resourcesUsed ?? {}) };
      const cur = used[event.payload.resourceKey] ?? 0;
      used[event.payload.resourceKey] = Math.max(0, cur + event.payload.delta);
      await db.update(sessionState).set({ resourcesUsed: used }).where(eq(sessionState.sessionId, sessionId));
      return;
    }
    case 'attune':
    case 'unattune':
    case 'inspiration_grant':
    case 'inspiration_spend':
    case 'xp_award':
    case 'level_up':
    case 'inventory_add':
    case 'inventory_remove':
    case 'campaign_initialized': {
      // These either: (a) have no clean Postgres mapping yet (audit may flag
      // attunements as a TODO), (b) are session-level (campaign_initialized),
      // or (c) require multi-row updates (xp/level on characters table).
      // For Phase 03 v1, NO-OP on the Postgres leg. parity-check will surface
      // any divergence; operator remediates via vault:rebuild-views.
      return;
    }
    default: {
      // tsc exhaustiveness — adding a new event type without an arm here is a build error
      const _exhaustive: never = event;
      return;
    }
  }
}
```

Refine each arm based on the actual schema. The above is the v1 mapping derived from the audit; the executor adjusts per the actual columns.

Update the `tools.ts` apply_event branch to call this function in the callback.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - VaultDispatchContext now has dualWrite, sessionId, characterId fields (all optional)
    - `grep -c "dualWriteApplyEvent" src/ai/master/vault/tools.ts` returns >= 1
    - The Phase 02 single-write path is reachable when `ctx.dualWrite !== true` (existing behavior preserved)
    - `src/sessions/event-to-engine-mutation.ts` exists with the reverse-lookup function
    - The exhaustiveness `default:` arm with `never` type is present
  </acceptance_criteria>
  <done>
    Dispatcher gates on dualWrite. Task 2 wires the turn-route to resolve the flag.
  </done>
</task>

<task type="auto">
  <name>Task 2: Update turn-route to resolve dualWrite + forward context</name>
  <files>src/app/api/sessions/[id]/turn/route.ts</files>
  <read_first>
    - src/app/api/sessions/[id]/turn/route.ts (existing vault branch; campaign + settings resolution from Phase 01/02)
    - src/lib/preferences.ts (plan 03-B-01 — resolveDualWrite)
    - src/ai/master/vault/loop.ts (VaultLoopInput — already has campaignId from Phase 02)
    - src/ai/master/vault/tools.ts (Task 1 — extended VaultDispatchContext)
  </read_first>
  <action>
Edit `src/app/api/sessions/[id]/turn/route.ts`. Locate the vault branch where `runVaultToolLoop` is invoked.

Add `import { resolveDualWrite } from '@/lib/preferences';` at the top.

In the vault branch (after campaign+session loaded), compute `const dualWrite = resolveDualWrite(campaign.settings);` and pass `dualWrite` + `sessionId` into the `runVaultToolLoop` call.

Then edit `src/ai/master/vault/loop.ts`:
1. Extend `VaultLoopInput` with `dualWrite?: boolean; sessionId?: string;`
2. Destructure them in the function body alongside `campaignId`
3. When assembling the dispatch context for each tool call, include `dualWrite`, `sessionId`, and (where the tool is `apply_event`) extract `characterId` from `input.payload.character`

The `extractCharacterIdFromToolInput(name, input)` helper inspects the LLM tool_use: for `apply_event` with `payload.character`, returns that UUID; otherwise null.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/sessions/turn-route-branch.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "resolveDualWrite" src/app/api/sessions/\[id\]/turn/route.ts` returns >= 1
    - Phase 01 + Phase 02 turn-route tests still pass (no regression)
    - VaultLoopInput now has dualWrite + sessionId optional fields
    - For apply_event tool calls, characterId is extracted from input.payload.character and forwarded
  </acceptance_criteria>
  <done>
    Turn-route wired. Task 3 tests the end-to-end gated dual-write path.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/sessions/turn-route-dual-write.test.ts</name>
  <files>tests/sessions/turn-route-dual-write.test.ts</files>
  <read_first>
    - tests/sessions/vault-mutations-gate.test.ts (Phase 02 — gate-quadrant test pattern)
    - tests/sessions/dual-writer.test.ts (plan 03-A-09 — fixture + invokeEnginePathwayFromEvent edge cases)
  </read_first>
  <action>
Create `tests/sessions/turn-route-dual-write.test.ts`. Skip if DATABASE_URL unset.

Cases:
1. dualWrite=false uses Phase 02 single-write — Postgres session_state unchanged after apply_event
2. dualWrite=true with synchronized starting state — both stores update, NO audit row
3. dualWrite=true with pre-existing mismatch — divergence record inserted
4. dualWrite=true with applyEngineMutation throwing (forced via mock) — apply_event returns isError
5. dualWrite=true without sessionId in ctx — falls back to Phase 02 path defensively

Use the gate-test pattern from `tests/sessions/vault-mutations-gate.test.ts`: stub provider to emit apply_event then end_turn; assert post-conditions on Postgres + events.md + dual_write_divergences.
  </action>
  <verify>
    <automated>pnpm test tests/sessions/turn-route-dual-write.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL set (skipped otherwise)
    - The dual-write end-to-end case proves both writes succeed
    - The divergence-record case proves the audit insert
    - Phase 02 single-write path still works (regression test)
    - Test runtime < 30s
  </acceptance_criteria>
  <done>
    DualWriter end-to-end. Sub-phase 03-A complete.
  </done>
</task>
