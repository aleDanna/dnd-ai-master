---
phase: 03
plan: B-05
type: execute
wave: 5
depends_on: [03-B-04]
files_modified:
  - src/ai/master/vault/loop.ts
  - tests/ai/master/vault/loop.test.ts
autonomous: true
requirements: [REQ-023]
must_haves:
  truths:
    - "runVaultToolLoop reads session_state.summaryBlock on entry — if present, the loop seeds history with the persisted summary so the summarizer doesn't re-fire from scratch (Pitfall 4)"
    - "Before each provider.completeMessage call, the loop invokes maybeCondense(history, provider, model, sessionId); the returned history replaces the loop's working history variable"
    - "When maybeCondense.condensed === true, an onEvent('summarized', {tokensBefore, tokensAfter}) event fires for observability"
    - "VaultLoopInput accepts an optional sessionId parameter (already present from plan 03-A-10) — required for summarizer persistence; when missing, the summarizer is skipped"
    - "Phase 02 loop behavior is preserved when MASTER_SUMMARIZATION=off OR token count is below threshold (no functional regression)"
  artifacts:
    - path: "src/ai/master/vault/loop.ts"
      provides: "maybeCondense + summaryBlock restore wired into runVaultToolLoop"
      contains: "maybeCondense"
    - path: "tests/ai/master/vault/loop.test.ts"
      provides: "Extended cases for trigger firing + restart-restore"
  key_links:
    - from: "src/ai/master/vault/loop.ts (runVaultToolLoop)"
      to: "src/ai/master/vault/condense.ts (maybeCondense)"
      via: "Synchronous call before provider.completeMessage"
      pattern: "maybeCondense"
    - from: "src/ai/master/vault/loop.ts (loop entry)"
      to: "src/db/schema/session-state.ts (summaryBlock)"
      via: "Read on entry; used to seed history if non-null"
      pattern: "summaryBlock"
---

# Plan 03-B-05: Wire maybeCondense Into runVaultToolLoop

**Phase:** 03-migration-cutover
**Wave:** 5 (depends on 03-B-04)
**Status:** Pending
**Estimated diff size:** ~120 LOC source (loop modifications) + ~200 LOC tests / 2 files

## Goal

Plan 03-B-04 ships `maybeCondense` as a standalone function. This plan wires it into the actual `runVaultToolLoop`:
1. **On entry** — read `session_state.summaryBlock`; if present, prepend it to history as a `[Riassunto dei turni precedenti]` user message (Pitfall 4 restart-restore — avoids re-summarization on every cold start)
2. **Before each LLM round-trip** — call `maybeCondense(history, provider, model, sessionId)`; replace history with the returned value
3. **Emit observability** — when condensed, fire `onEvent('summarized', {tokensBefore, tokensAfter})` so callers can log

The loop is the single integration point. No other consumer of vault-loop code changes.

## Requirements satisfied

- **REQ-023** — Closes the per-turn summarization loop: trigger fires, persist, restore on restart.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/loop.ts` | EDIT | Wire maybeCondense + summaryBlock restore |
| `tests/ai/master/vault/loop.test.ts` | EDIT | Trigger + restore cases |

## Tasks

<task type="auto">
  <name>Task 1: Add summaryBlock restore + maybeCondense calls to runVaultToolLoop</name>
  <files>src/ai/master/vault/loop.ts</files>
  <read_first>
    - src/ai/master/vault/loop.ts (existing — runVaultToolLoop signature, history variable management, the location of each provider.completeMessage call)
    - src/ai/master/vault/condense.ts (plan 03-B-04 — maybeCondense, signature)
    - src/db/schema/session-state.ts (plan 03-B-03 — summaryBlock)
  </read_first>
  <action>
Edit `src/ai/master/vault/loop.ts`. Three additive changes.

**Change 1 — Add imports at the top:**
```ts
import { maybeCondense } from './condense';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { eq } from 'drizzle-orm';
```

**Change 2 — On loop entry, restore summaryBlock if present.** After the destructuring of `input` and BEFORE the main while loop, add:

```ts
// Phase 03-B (REQ-023) — restore persisted summary on restart (Pitfall 4)
if (sessionId) {
  try {
    const [stateRow] = await db
      .select({ summaryBlock: sessionState.summaryBlock })
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .limit(1);
    if (stateRow?.summaryBlock?.text) {
      // Insert the restored summary RIGHT AFTER the system message in
      // history. This avoids re-summarization on cold-start of an
      // already-condensed session.
      const sys = history[0];
      const rest = history.slice(1);
      history = [
        sys,
        { role: 'user', content: `[Riassunto dei turni precedenti]\n${stateRow.summaryBlock.text}` },
        ...rest,
      ];
    }
  } catch (e) {
    // Non-fatal — log and proceed without restore
    console.warn('[vault-loop] summaryBlock restore failed:', e instanceof Error ? e.message : e);
  }
}
```

NOTE: `history` MUST be declared with `let` (not `const`) since we reassign it.

**Change 3 — Call maybeCondense before each provider.completeMessage.** Locate the main loop's iteration (the part that issues a round-trip to the LLM). BEFORE each `provider.completeMessage` call, add:

```ts
// Phase 03-B (REQ-023) — per-turn summarization at threshold
if (sessionId) {
  const condense = await maybeCondense(history, provider, model, sessionId);
  history = condense.history;
  if (condense.condensed && onEvent) {
    onEvent({
      type: 'summarized',
      data: { tokensBefore: condense.tokensBefore, tokensAfter: condense.tokensAfter },
    });
  }
}

// (existing) const completion = await provider.completeMessage({ ... });
```

Inspect the loop's existing event emit shape (`onEvent`) — the field name might be `event` or similar; match the existing pattern.

If the loop has MULTIPLE `provider.completeMessage` call sites (e.g., one for tool-loop iterations and one for the finalize), add maybeCondense before EACH of them.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/ai/master/vault/loop.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "maybeCondense" src/ai/master/vault/loop.ts` returns >= 2 (import + at least one call)
    - `grep -c "summaryBlock" src/ai/master/vault/loop.ts` returns >= 1 (the restore read)
    - Phase 01 + Phase 02 loop tests still pass (regression)
    - The history variable is `let` (reassignable)
    - When sessionId is undefined, the summarizer is skipped (no DB read, no maybeCondense call)
  </acceptance_criteria>
  <done>
    Loop wired. Task 2 adds the new test cases.
  </done>
</task>

<task type="auto">
  <name>Task 2: Extend tests/ai/master/vault/loop.test.ts with summarization cases</name>
  <files>tests/ai/master/vault/loop.test.ts</files>
  <read_first>
    - tests/ai/master/vault/loop.test.ts (existing — mock provider pattern; tool-use round-trip cases)
    - src/ai/master/vault/loop.ts (Task 1 — new restore + condense call sites)
    - src/ai/master/vault/condense.ts (the function being invoked)
  </read_first>
  <action>
Append a new `describe('runVaultToolLoop — REQ-023 per-turn summarization')` block.

Cases:
1. **No summaryBlock + tokens below threshold** → loop proceeds normally; no summarizer call
2. **No summaryBlock + tokens above threshold** → maybeCondense fires; history shortened; onEvent('summarized') emitted; persist via DB
3. **Existing summaryBlock on entry** → history is augmented with the persisted summary before any round-trip
4. **MASTER_SUMMARIZATION=off** → no summarizer call regardless
5. **sessionId undefined** → no DB reads; no summarizer call
6. **Multiple turns above threshold** → summarizer fires multiple times if cumulative growth crosses the trigger again

The DB-gated cases require fixtures. Mock the LLM provider to return a deterministic summary text + assert the history shape after each round-trip.

```ts
describe('runVaultToolLoop — REQ-023 per-turn summarization', () => {
  it('no-op below threshold', async () => {
    // ... mock provider with end_turn first call; history below 15K tokens
    // ... assert events.md unchanged + no maybeCondense effect
  });

  it('fires above threshold; emits summarized event', async () => {
    // Use MASTER_SUMMARIZE_TRIGGER=1000 to lower the bar
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '1000');
    vi.resetModules();
    const provider = mockProviderThatSummarizes('mini-summary');
    const events: any[] = [];
    await runVaultToolLoop({
      provider, model: 'qwen3', sessionId: 'test-session',
      systemBlocks: ['sys'],
      history: largeHistoryAboveThreshold(),
      vaultRoot: tmpdir,
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === 'summarized')).toBe(true);
  });

  it('restores existing summaryBlock on entry', async () => {
    // Pre-populate session_state.summaryBlock = {text: 'previous summary', ...}
    // Mock provider to immediately end_turn
    // Assert the provider received a history with [system, '[Riassunto]', ...] BEFORE its first call
    // (inspect mock.calls[0])
  });

  // ... more cases ...
});
```
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/loop.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All Phase 01 + Phase 02 cases still pass
    - All new Phase 03 cases pass (6+ new it() blocks)
    - The "restores existing summaryBlock" case proves Pitfall 4 (restart-restore) is closed
    - Test runtime < 15s
  </acceptance_criteria>
  <done>
    Summarizer end-to-end. The 20-turn long-session test (plan 03-D-01 bench) will validate the prompt-flat invariant.
  </done>
</task>
