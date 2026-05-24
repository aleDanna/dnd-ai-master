# Plan 07: Turn-Route Branch (Vault Path Integration)

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** 02-vault-prompt-builder, 04-vault-tool-loop, 06-campaign-settings-flag
**Estimated diff size:** ~120 LOC source + ~80 LOC tests / 2 files

## Goal

Wire the vault path into `src/app/api/sessions/[id]/turn/route.ts` behind the `masterBackend === 'vault'` flag from plan 06. When the flag is set, the route runs a parallel, much simpler flow: snapshot is still built (it provides `userId` for `recordUsage` + the per-turn language fallback), but the dynamic-prefix machinery (SRD context, handbook, world lore, mode-aware overlay, RAG retrieval, slim/full builder, meta-tools instruction, scene card, codex index, chapter digests, ROLL_TRIGGERS, REWARDS_MANDATE, MANUAL_ROLLS_RULE, set_tonal_frame mandate) is SKIPPED. The vault prompt is built via `buildVaultSystemPrompt`; the loop is `runVaultToolLoop` with the 3-tool surface.

The baked path is untouched — its branch starts at the existing line ~243 and runs all the way through the end of the `waitUntil` body. The vault branch is added BEFORE that, with an early `return` from the IIFE so the baked path never runs on a vault-flagged campaign.

**Critical scope cut documented inline in the source comment**: vault-flagged campaigns in Phase 01 do NOT receive engine tools (`cast_spell`, `set_current_player`, `apply_damage`, etc.). The campaign can ask rules questions but cannot mutate game state. This is intentional — Phase 02 adds `apply_event` to the vault tool surface and re-introduces state mutation through the events.md pattern. The flag's purpose in Phase 01 is the read-only knowledge layer.

## Requirements satisfied

- **REQ-021** Warm wall-clock < 10s on M4 — the vault path's small prompt + 3-tool surface is the load-bearing change that delivers this target.
- **REQ-030** Primary local model used as BASE slug (`qwen3:30b-a3b-instruct-2507-q4_K_M`), NOT a `dnd-master-*` baked variant — the vault branch passes `userPrefs.aiMasterModel` straight through; the existing `isBakedModel()` check is no longer applied here (it would mis-route a user who has Max 2 baked installed but flipped the campaign to `vault`).
- **REQ-033** Drop baked-variant dependency for vault-flagged campaigns — the vault branch never calls `buildSrdContext`, `getMasterHandbook`, `getMasterWorldLore`, never invokes `runtime-prompt-hash`/`warnIfBakedModelStale`. The baked variants still work for baked-flagged campaigns (Phase 01 coexistence).

## Files touched

| File | Action | Why |
|---|---|---|
| `src/app/api/sessions/[id]/turn/route.ts` | EDIT (insert ~80 LOC) | Add vault-path branch after `getSessionMasterPreferences` resolves. |
| `tests/sessions/turn-route-branch.test.ts` | NEW | Branch-selection unit test (mocks the provider + DB; asserts which loop is invoked). |

## Tasks

1. **Edit `src/app/api/sessions/[id]/turn/route.ts`.** Imports (top of file):
   - Add `import { runVaultToolLoop } from '@/ai/master/vault/loop';`
   - Add `import { buildVaultSystemPrompt } from '@/ai/master/vault/prompt-builder';`
   - Add `import { VAULT_TOOL_COUNT, VAULT_TOOL_DEFINITIONS } from '@/ai/master/vault/tools';`
   - Add `import { VAULT_ROOT } from '@/ai/master/vault/path';`
   - Add `import { resolveMasterBackend, type MasterBackend } from '@/lib/preferences';` (already exported by plan 06).

2. **Insert the vault branch.** Find the existing line `const baked = isBakedModel(userPrefs.aiMasterModel);` (currently line 243 in route.ts; locate by exact-string match, NOT line number — the file edits frequently). Just BEFORE this line, insert:

   ```ts
   // ── Vault path (Phase 01 feature flag) ────────────────────────────────
   //
   // When the campaign opted into `masterBackend: 'vault'` (or env override
   // MASTER_BACKEND=vault is set and campaign has no explicit value), bypass
   // the baked/SRD/handbook/RAG/meta-tools stack entirely. The vault path is
   // a parallel implementation that:
   //   - reads static knowledge from data/vault/handbook/**.md via tool calls
   //     (read_vault_multi / list_vault), instead of injecting full handbook
   //     into the system prompt;
   //   - exposes ONLY 3 tools (read_vault_multi, list_vault, end_turn) — NO
   //     engine tools (cast_spell, set_current_player, etc.). Vault-flagged
   //     campaigns in Phase 01 are READ-ONLY for game state. Phase 02 will
   //     add apply_event and re-introduce mutation through events.md.
   //   - passes the user's chosen model BASE slug straight through (the
   //     baked-variant detection is intentionally skipped — vault path never
   //     wants dnd-master-* models).
   //
   // See .planning/phases/01-vault-read-path/PLAN.md.
   // After plan 06's parallel-shape fix, `userPrefs.masterBackend` is directly typed (no cast needed).
   const masterBackend: MasterBackend = resolveMasterBackend(userPrefs.masterBackend);
   if (masterBackend === 'vault') {
     // Build minimal system prompt. No SRD, no handbook, no world lore,
     // no scene card, no codex, no ROLL_TRIGGERS, no REWARDS_MANDATE,
     // no meta-tools instructions.
     const vaultSys = buildVaultSystemPrompt({
       vaultRoot: VAULT_ROOT,
       campaignId: campaign.id,
       toolCount: VAULT_TOOL_COUNT,                                  // 3 in Phase 01
       language: campaign.language ?? snap.language ?? undefined,
     });
     // Build history with the same budget-aware truncation the baked path
     // uses — for Phase 01 the existing constants are reused unchanged
     // (Decision 6 in PLAN.md; retune is a Phase 02 follow-up).
     // ...history construction identical to the baked branch — extract
     // into a shared local helper buildBudgetedHistory() to avoid copy-paste
     // drift. See Task 3 below.
     const vaultHistory = await buildBudgetedHistory({
       sessionId,
       isBegin,
       campaign,
       snap,
       beginUserMessage: isBegin
         ? buildBeginUserMessage(campaign.premise, campaign.language)
         : null,
     });
     // Provider resolution is identical — the local provider's Ollama adapter
     // doesn't care which tool surface it's wrapping. The base slug
     // (e.g. qwen3:30b-a3b-instruct-2507-q4_K_M) is what's stored in
     // userPrefs.aiMasterModel for vault campaigns.
     const provider = getProviderByName(userPrefs.aiProvider);
     const masterModel = userPrefs.aiMasterModel;
     console.log('[turn]', sessionId, 'vault path: model=', masterModel, 'tools=', VAULT_TOOL_DEFINITIONS.length);
     const result = await runVaultToolLoop({
       provider,
       model: masterModel,
       systemBlocks: [{ type: 'text', text: vaultSys }],
       history: vaultHistory,
       sessionId,
       campaignLanguage: campaign.language ?? snap.language ?? undefined,
       recordUsage: async (usage) => {
         await recordUsage({
           userId,
           sessionId,
           endpoint: 'master',
           model: masterModel,
           usage,
           // Vault path: no mode, no spellcasting overlay, no RAG.
           // mode/needsSpellcasting are undefined → null in DB.
           // ragChunkCount is null (retrieval not attempted) — distinct
           // from 0 (attempted, no chunks), so the hit-rate metric stays
           // honest.
           mode: undefined,
           needsSpellcasting: undefined,
           ragChunkCount: null,
         });
       },
       onEvent: (ev) => {
         if (ev.type === 'narrative_delta') {
           notifySession(sessionId, { type: 'message-chunk', messageId: '', text: ev.text }).catch(
             (e) => console.warn('notifySession(message-chunk) failed:', e instanceof Error ? e.message : String(e)),
           );
         } else if (ev.type === 'thinking') {
           notifySession(sessionId, { type: 'thinking', state: ev.state }).catch(
             (e) => console.warn('notifySession(thinking) failed:', e instanceof Error ? e.message : String(e)),
           );
         }
       },
     });
     // Post-loop steps from the baked path that ALSO apply to vault:
     //  - turn-advance (computeTurnAdvance) — based on DB state, not tool
     //    calls; vault path doesn't call set_current_player but turn-advance
     //    still works via the round-robin fallback when no advance happened.
     //  - persist master message + memory extraction — both still run.
     //  - bump turnSeq, touchCampaign, releaseTurnLock — handled in the
     //    existing finally block at the end of the IIFE.
     //
     // We REUSE the same post-loop block by setting `result` into a shape
     // compatible with the baked path's downstream usage (only `finalText`
     // is read by lines ~599-677). The vault loop returns the same shape
     // intentionally.
     //
     // Structure: extract the post-loop steps (steps 6 + 7 of the baked
     // flow) into a local async helper `finalizeTurn(result)` so both
     // branches call it. See Task 4 below.
     await finalizeTurn({
       result,
       isBegin,
       sessionId,
       userId,
       authorCharacterId,
       campaign,
       userPrefs,
       snap,
     });
     return;  // Early-return from the IIFE — baked path below is skipped.
   }
   // ── End vault path; baked path follows ───────────────────────────────
   ```

3. **Extract `buildBudgetedHistory` helper.** The history-construction logic at lines ~280-380 of the existing route is identical for both paths (history is provider-agnostic). Move it into a top-level helper IN THE SAME FILE (to keep the PR scope tight and avoid inter-file churn):

   ```ts
   async function buildBudgetedHistory(args: {
     sessionId: string;
     isBegin: boolean;
     campaign: typeof campaigns.$inferSelect;
     snap: Awaited<ReturnType<typeof buildSnapshot>>;
     beginUserMessage: string | null;
   }): Promise<Anthropic.Messages.MessageParam[]> { ... }
   ```

   Behavior: lift lines ~280-380 verbatim. The baked branch keeps calling it. The vault branch also calls it. NO logic change — just relocated. The function reads `MASTER_HISTORY_LIMIT` + `MASTER_PROMPT_BUDGET` env vars exactly as before (these are NOT inside the prompt builder, so REQ-022's purity rule isn't broken).

   The vault branch passes the same `isBegin`/`campaign`/`snap` so on the first turn the synthetic begin message + the budget-aware history both flow through identically.

4. **Extract `finalizeTurn` helper.** Lines ~584-677 (the post-loop block: turn-advance + persist master message + memory extraction) become a top-level helper:

   ```ts
   async function finalizeTurn(args: {
     result: { finalText: string };
     isBegin: boolean;
     sessionId: string;
     userId: string;
     authorCharacterId: string | null;
     userPrefs: Awaited<ReturnType<typeof getSessionMasterPreferences>>;
     // Reserved for Phase 02 (`apply_event` payload construction may need these):
     campaign?: typeof campaigns.$inferSelect;
     snap?: Awaited<ReturnType<typeof buildSnapshot>>;
   }): Promise<void> { ... }
   ```

   Same lift-and-relocate. The post-loop block (lines 599-677) does NOT reference `campaign` or `snap` — they're trimmed to optional `?:` here so callers may omit them. Phase 02 will likely need them for `apply_event` payload construction; keeping them as optional placeholders avoids a signature churn at that point. The baked branch ALSO calls `finalizeTurn(...)` instead of inlining steps 6+7. This deduplication is the only "shared infra" change in this PR; it makes the vault branch a clean delta rather than a parallel-but-divergent copy.

5. **`thinking` flag passthrough.** The vault branch DOES NOT set or read `thinkingFlagFor`. Rationale: the primary vault model is `qwen3:30b-a3b-instruct-2507-q4_K_M`, where `thinkingFlagFor` returns `undefined` — the local provider sees no `think` field, which is the desired behaviour. If a user picks `qwen3:30b-a3b` (Max 3 — thinking-native), the local provider's existing logic at `src/ai/provider/local.ts` will still call `thinkingFlagFor` internally and set `think: true` — the vault branch doesn't need to override this because the provider is the single source of truth. The vault prompt builder does not accept a `thinkingEnabled` input (REQ-022 + Research Q5 — confirmed in PLAN.md Decision context).

6. **No staleness check.** The baked path's `warnIfBakedModelStale` fire-and-forget block is skipped on the vault branch (the model is a base slug, no Modelfile to compare). Just don't include the block — the early `return` handles this.

7. **Create `tests/sessions/turn-route-branch.test.ts`.** Cases (using vitest + mocked DB + a mocked `MasterProvider`):
   - **Baked default:** mock `getSessionMasterPreferences` to return `{ masterBackend: 'baked', ... }` (or omit the field — resolver returns `'baked'`). Mock `runToolLoop` and `runVaultToolLoop` as spies. POST the turn endpoint via a thin invocation (or call the IIFE body via export-for-test). Assert `runToolLoop` called once, `runVaultToolLoop` called zero times.
   - **Vault flag set:** mock prefs to return `masterBackend: 'vault'`. Assert `runVaultToolLoop` called once with `{ tools: VAULT_TOOL_DEFINITIONS, systemBlocks: [<vault prompt>] }`, `runToolLoop` called zero times.
   - **Env override:** stub `MASTER_BACKEND=vault`, prefs return no field. Assert `runVaultToolLoop` called.
   - **Explicit baked wins over env:** stub `MASTER_BACKEND=vault`, prefs return `masterBackend: 'baked'`. Assert `runToolLoop` called.
   - **`recordUsage` is invoked on vault path:** mock recordUsage as a spy; vault flag set; assert spy called once with `mode: undefined`, `ragChunkCount: null`.
   - **Vault prompt contains vault root + campaignId:** capture the `systemBlocks[0].text` passed to `runVaultToolLoop`; assert it contains `'data/vault'` and the campaign UUID.
   - **Vault path does NOT call `buildSrdContext`, `getMasterHandbook`, `getMasterWorldLore`, `retrieveRelevant`:** spy each; assert zero calls on the vault branch.
   - **Vault path passes the user's model BASE slug** (e.g. set prefs `aiMasterModel: 'qwen3:30b-a3b-instruct-2507-q4_K_M'`); assert `runVaultToolLoop` received `model: 'qwen3:30b-a3b-instruct-2507-q4_K_M'` — verifies REQ-030 vehicle.
   - **`finalizeTurn` is called on both branches** — spy; assert exactly one call per turn regardless of branch.

   The test invokes the route's POST handler via `vi.mock` for the dependencies it doesn't want to spin up (Clerk auth, DB, lock acquisition). Reuse the mock patterns from `tests/sessions/snapshot.test.ts` and `tests/ai/tool-loop-db.test.ts`.

## Verification

- Command: `pnpm test tests/sessions/turn-route-branch.test.ts` → all cases pass.
- Command: `pnpm typecheck` → clean (new imports + helper signatures compile).
- Command: `pnpm test` → full suite still green (no regression in baked tests).
- Behaviour (manual smoke):
  1. `pnpm dev` with a test campaign opted into `vault` (`UPDATE campaigns SET settings = jsonb_set(settings, '{masterBackend}', '"vault"') WHERE id = '<id>'`).
  2. Send the question "Quanto danno fa Fireball al livello 5?" via the chat UI.
  3. Confirm the response cites Fireball mechanics (8d6 base + 1d6/slot above 3rd = 10d6 at L5 = ~35 avg damage).
  4. Query `ai_usage`: most recent row for this session shows `prompt_eval_count` ~3-5K (vs baked ~8.8K), `rag_chunk_count` NULL.
  5. Flip the flag back to `baked`; rerun the same question; confirm baked-path behaviour unchanged.
- Grep gate: `grep -c 'runVaultToolLoop\|buildVaultSystemPrompt\|VAULT_TOOL' src/app/api/sessions/\[id\]/turn/route.ts` → ≥ 4 (imports + 3 call sites).

## Open questions

None. The early-return pattern in the IIFE keeps the diff localised. The two helper extractions (`buildBudgetedHistory`, `finalizeTurn`) are the only "shared infrastructure" — both are pure lift-and-relocate (verifiable by diff). The vault branch is otherwise a self-contained ~80-line block.
