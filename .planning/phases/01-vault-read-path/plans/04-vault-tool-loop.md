# Plan 04: Vault Tool Loop (Parallel to runToolLoop)

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** 03-vault-tool-definitions
**Estimated diff size:** ~250 LOC source + ~150 LOC tests / 2 files

## Goal

Ship `runVaultToolLoop` — the vault-path equivalent of `runToolLoop` (`src/ai/master/tool-loop.ts`). It calls the existing `MasterProvider` interface (so Ollama / cloud streaming, KV-cache hygiene, and the `onDelta`/`onThinking` plumbing are reused for free), dispatches vault tools via `dispatchVaultTool` (plan 03), and accepts both terminators per REQ-013: an `end_turn` tool call OR `no_tool_calls + content`.

This is a parallel implementation, NOT a refactor of `runToolLoop`. The existing loop is tightly coupled to the engine (imports `TOOL_HANDLERS`, `TOOL_HANDLERS_DB`, `dispatchMetaCall`, `applyMutations`) — forcing the vault path through it would require either gutless nullable injections or invasive branching that risks the baked path. The new loop is ~250 LOC vs the existing ~330 because it drops:

- meta-tool dispatch (`dispatchMetaCall`)
- `requiredToolsBeforeEnd` + tentative buffering
- DB persistence (`applyMutations`) — vault path is read-only in Phase 01
- `state_changed` events
- engine `TOOL_HANDLERS` lookup

It KEEPS:

- streaming via `provider.completeMessage({ onDelta, onThinking })` — vault path still gets TTFT ~1s on local provider
- usage telemetry callback (`recordUsage`) — `ai_usage` row continues to land
- `TURN_TOOL_CALL_CAP` (12) and `TURN_TIMEOUT_MS` budgeting
- dual terminator handling (REQ-013)
- the `TurnEvent` type shape so existing SSE subscribers (`notifySession`) work without changes

## Requirements satisfied

- **REQ-010** Loop dispatches the 3 Phase-01 vault tools via plan 03's `dispatchVaultTool`.
- **REQ-013** Loop accepts both terminators: `end_turn` tool call AND `no_tool_calls + content`.
- **REQ-021** Loop preserves streaming + KV-cache reuse from the existing provider, contributing to the M4 warm wall-clock target.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/loop.ts` | NEW | `runVaultToolLoop` implementation. |
| `tests/ai/master/vault/loop.test.ts` | NEW | Integration test using a mock provider that scripts tool-call sequences; covers both terminators, cap, timeout, error path. |
| `src/ai/master/vault/index.ts` | EDIT | Append `export * from './loop';`. |

## Tasks

1. **Create `src/ai/master/vault/loop.ts`.** Define:
   ```
   export interface VaultLoopInput {
     provider: MasterProvider;
     model?: string;
     systemBlocks: SystemBlock[];
     history: Message[];
     vaultRoot?: string;             // overrides VAULT_ROOT for tests; production omits
     recordUsage?: (u: NormalizedUsage) => Promise<void>;
     onEvent?: (e: TurnEvent) => void;
     sessionId?: string;
     campaignLanguage?: string;
   }
   export interface VaultLoopResult {
     events: TurnEvent[];
     finalText: string;
     toolCallCount: number;
     truncated: boolean;
     timedOut: boolean;
   }
   export async function runVaultToolLoop(input: VaultLoopInput): Promise<VaultLoopResult>;
   ```
   The interface intentionally mirrors `ToolLoopInput`/`ToolLoopResult` field shapes used elsewhere (only the engine/applyMutations fields are dropped) so callers (plan 07) can swap the function with minimal change.

2. **Loop body.** Mirror the existing loop's iteration structure with the vault-specific dispatch:

   - Initialize `events: TurnEvent[] = []`, `finalText = ''`, `toolCallCount = 0`, `truncated = false`, `timedOut = false`, `start = Date.now()`, `messages = [...history]`.
   - `const emit = (ev) => { events.push(ev); onEvent?.(ev); };`
   - For `iter` in `[0, TURN_TOOL_CALL_CAP + 1)`:
     - Timeout check: `Date.now() - start > TURN_TIMEOUT_MS` → set `timedOut`, emit `{ type: 'turn_error', reason: 'timeout', recoverable: true }`, break.
     - Streaming flag: `let streamedAny = false;`
     - Call `provider.completeMessage({ model, systemBlocks, messages, tools: VAULT_TOOL_DEFINITIONS, sessionId, campaignLanguage, onDelta: (t) => { streamedAny = true; emit({ type:'narrative_delta', text: t }); }, onThinking: (s) => emit({ type:'thinking', state: s }) })`.
     - `if (recordUsage) await recordUsage(response.usage);`
     - Collect content blocks into `toolUses[]` (entries with `type === 'tool_use'`). For `text` blocks, apply `stripReasoningPreamble` (reuse the existing `src/ai/master/reasoning-strip.ts`); if non-empty, append to `finalText`; re-emit only if `!streamedAny` (per the existing loop's dedup rule).
     - **Terminator 1 — no_tool_calls + content:** `if (toolUses.length === 0) break;` — REQ-013's "content-only" terminator. `finalText` is already populated from the text blocks above.
     - **Terminator 2 — end_turn tool call:** scan `toolUses` for `name === 'end_turn'`. If present:
       - Call `dispatchVaultTool('end_turn', tu.input, { vaultRoot })`. Capture `endTurnResponse`.
       - `finalText = endTurnResponse ?? finalText;` — the explicit `end_turn` response replaces any concurrent text content (mirrors the existing loop behaviour where `end_turn` is authoritative).
       - emit `{ type:'tool_use_start', toolUseId: tu.id, name: 'end_turn', input: tu.input }` and `{ type:'tool_use_end', toolUseId: tu.id, ok: true, error: undefined, rolls: [], mutationCount: 0 }` — keeps the event stream symmetric for SSE subscribers.
       - break.
     - Tool-cap check: `if (toolCallCount + toolUses.length > TURN_TOOL_CALL_CAP) { truncated = true; emit({type:'turn_error', reason:'tool_call_cap', recoverable:true}); break; }`
     - Push the assistant turn back into `messages` (Anthropic shape, same as `runToolLoop` lines 220-230: filter empty text blocks, map tool_use blocks).
     - For each `tu` in `toolUses` (excluding `end_turn` which was handled above):
       - `toolCallCount += 1;`
       - emit `{ type:'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input }`.
       - `const result = await dispatchVaultTool(tu.name, tu.input, { vaultRoot });`
       - emit `{ type:'tool_use_end', toolUseId: tu.id, ok: !result.isError, error: result.isError ? result.content : undefined, rolls: [], mutationCount: 0 }`.
       - Append a tool-result message: `messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: result.content, is_error: result.isError }] as never })`. (Use of `as never` matches the existing loop's cast at line 324.)
     - Continue to next iteration.

3. **Imports + reuse.** The new file imports:
   - `import type { MasterProvider, Message, NormalizedUsage, SystemBlock } from '@/ai/provider/types';`
   - `import { TURN_TOOL_CALL_CAP, TURN_TIMEOUT_MS, type TurnEvent } from '@/sessions/types';`
   - `import { stripReasoningPreamble } from '@/ai/master/reasoning-strip';`
   - `import { VAULT_TOOL_DEFINITIONS, dispatchVaultTool } from './tools';`
   - NO imports from `src/engine/*`, NO imports from `@/sessions/applicator`, NO imports from `@/ai/master/tool-loop` — this keeps the modules cleanly separated.

4. **Create `tests/ai/master/vault/loop.test.ts`** with cases (using a mock `MasterProvider` that returns scripted `CompleteMessageOutput` per call):
   - **Terminator 1 (end_turn tool call):** Mock returns one `tool_use` `read_vault_multi` then a second response containing `tool_use` `end_turn` with `{response:'Final.'}`. Assert `finalText === 'Final.'`, `toolCallCount === 2`, `truncated === false`, `timedOut === false`, events include exactly one `narrative_delta` (or none, depending on the mock's text content), two `tool_use_start`, two `tool_use_end`.
   - **Terminator 2 (no_tool_calls + content):** Mock returns one `tool_use` `list_vault`, then a second response with `text` block `'Here is the answer.'` and NO tool calls. Assert `finalText === 'Here is the answer.'`, `toolCallCount === 1`, terminator path was content-only (no `end_turn` event in the event stream).
   - **Cap breach:** Mock returns 13 `read_vault_multi` calls back-to-back. Assert `truncated === true`, a `turn_error` event with `reason: 'tool_call_cap'`, `toolCallCount` capped at `TURN_TOOL_CALL_CAP`.
   - **Timeout:** Set `TURN_TIMEOUT_MS` via env or by mocking time; mock provider sleeps 200ms per call; configure timeout to 100ms. Assert `timedOut === true`, `turn_error` event with `reason: 'timeout'`.
   - **Unknown tool from model:** Mock returns `tool_use` with name `cast_spell` (an engine tool not in the vault surface). Assert the loop emits `tool_use_end` with `ok: false, error: 'ERROR: unknown vault tool: cast_spell'`, and the subsequent tool_result content reaches the next iteration's `messages` — the model gets a corrective signal and can continue. Cap on this is the normal `TURN_TOOL_CALL_CAP` (the test mock then returns `end_turn` on iteration 2).
   - **Traversal attempt surfaces inline:** Mock returns `read_vault_multi({paths:['../etc/passwd']})` then `end_turn`. Assert the tool_result for that call contains `ERROR: path outside vault` in its content; `isError` reported as `false` (per plan 03 — per-path errors don't fail the batch). The model proceeds normally.
   - **Streaming dedup:** Mock invokes `onDelta('hello ')` then `onDelta('world')`, then returns final response with NO text block. Assert `finalText === 'hello world'`, exactly two `narrative_delta` events emitted (one per delta — no re-emission from the final `text` block scan, because there was none).
   - **Streaming + text block dedup:** Mock invokes `onDelta('streamed ')` AND returns a final text block `'streamed '`. Assert exactly one `narrative_delta` event (the stream version) — the text-block scan SKIPS re-emission because `streamedAny === true`.
   - **No `applyMutations`-related event in the stream.** Specifically, scan for `state_changed`: 0 occurrences. (Sanity check that the loop didn't accidentally import engine plumbing.)

5. **Update `src/ai/master/vault/index.ts`** to add `export * from './loop';`.

## Verification

- Command: `pnpm test tests/ai/master/vault/loop.test.ts` → all cases pass (9 cases).
- Command: `pnpm typecheck` → clean.
- Grep gate: `grep -E '@/engine|applyMutations|TOOL_HANDLERS|dispatchMetaCall' src/ai/master/vault/loop.ts | grep -v '^//'` → no matches (cleanly decoupled from engine).
- Behaviour (manual smoke once plan 07 lands): a vault-flagged campaign turn produces a chat-stream message; `ai_usage` row is written; `tool_use_start`/`tool_use_end` events visible in dev SSE log.

## Open questions

None. The dual-terminator rule is locked by REQ-013. The decoupling-from-engine rule is the result of an explicit research decision (RESEARCH.md §4) confirmed in PLAN.md.
