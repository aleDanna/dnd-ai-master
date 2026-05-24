# Plan 09: Rollout, Docs, REQ Traceability

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** all (01-08)
**Estimated diff size:** ~120 LOC docs + ~30 LOC test / 3 files

## Goal

Ship the final wrap-up: a phase summary document, a REQ traceability matrix (which file/test satisfies which REQ for the next phase to pick up), and a brief operator README in the codebase explaining how to flip a campaign onto the vault backend. Plus a single small "phase smoke" test that asserts the whole vault stack is importable from a fresh node process (catches missing-barrel-export regressions that unit tests can miss when each module is imported directly).

This plan is intentionally light on code. Its job is to make Phase 02 startable without forensic archaeology.

## Requirements satisfied

- **Traceability** for REQ-001..REQ-014 + REQ-021/022/030/033 — phase summary catalogs which artifact closes each requirement.

## Files touched

| File | Action | Why |
|---|---|---|
| `.planning/phases/01-vault-read-path/SUMMARY.md` | NEW | Phase summary doc — what shipped, REQ matrix, known limits, follow-ups for Phase 02. |
| `docs/superpowers/operations/vault-backend.md` | NEW | Operator README: how to flip a campaign onto vault, how to roll back, how to run the bench. |
| `tests/ai/master/vault/phase-smoke.test.ts` | NEW | Trivial barrel-import test (catches missing-export regressions). |

## Tasks

1. **Create `.planning/phases/01-vault-read-path/SUMMARY.md`** with sections:

   - **What shipped.** Bulleted list of the 9 plan deliverables. Cross-link each plan file.
   - **REQ traceability matrix.** Table:
     | REQ | Statement | Implementation | Test |
     |---|---|---|---|
     | REQ-001 | Vault is filesystem-only markdown | `data/vault/` populated by `scripts/migrate-handbook-to-vault.ts` | `tests/scripts/migrate-handbook-to-vault.test.ts` |
     | REQ-002 | Static knowledge path-deterministic `/handbook/<category>/<id>.md` | Same migration script + scaffolded `{spells,monsters,...}/` dirs | Same |
     | REQ-010 | 3 of 4 vault tools (no apply_event) | `src/ai/master/vault/tools.ts` | `tests/ai/master/vault/tools.test.ts` |
     | REQ-011 | No singular `read_vault` | Tool defs file — grep gate | Same |
     | REQ-012 | Lenient discovery `/tools/index.md` | Migration script generates the file + prompt mentions it | Migration test + prompt-builder test |
     | REQ-013 | Both terminators (end_turn + no_tool_calls) | `src/ai/master/vault/loop.ts` | `tests/ai/master/vault/loop.test.ts` (cases 1+2) |
     | REQ-014 | `safeVaultPath` on every read | `src/ai/master/vault/path.ts` | `tests/ai/master/vault/path.test.ts` |
     | REQ-021 | Warm wall-clock < 10s on M4 | Whole stack — measured manually | `scripts/bench-vault-m4.ts` (not CI) |
     | REQ-022 | Pure-function prompt builder + lint | `src/ai/master/vault/prompt-builder.ts` + `__forbidden-patterns.ts` | `tests/ai/master/vault/prompt-builder.test.ts` |
     | REQ-030 | Primary model `qwen3:30b-a3b-instruct-2507-q4_K_M` base slug | Vault branch in `turn/route.ts` passes user's model through unchanged | `tests/sessions/turn-route-branch.test.ts` |
     | REQ-033 | Drop baked dependency for vault campaigns | Vault branch never calls `buildSrdContext`/handbook readers/RAG | Same |

   - **What this phase did NOT deliver (and why).** Mirror the "What this phase explicitly does NOT do" section in PLAN.md verbatim — useful for the Phase 02 planner.
   - **Known limits / follow-ups.**
     - Phase 02 must add `apply_event` to vault tool surface (REQ-010 4th tool).
     - Phase 02 may want to retune `MASTER_PROMPT_BUDGET` for the smaller vault prompt envelope (Decision 6, deferred).
     - Phase 03 retires the RAG stack + baked variants once vault parity is proven.
     - Phase 02 may add the campaign-settings UI toggle for `masterBackend` (Phase 01 ships backend-only flag).
     - **Vitest test-discovery scope:** vitest scans ONLY `tests/**/*.test.{ts,tsx}` (see `vitest.config.ts:31-40`). Colocated `src/**/*.test.ts` files are NOT picked up. All new tests in Phase 01 live under `tests/<area>/` accordingly. RESEARCH.md §6+§A7 incorrectly claimed colocated tests work — that claim was wrong and discovered during plan-check. Phase 02 planner: do NOT propose colocated tests.
     - **Phase 08 bench `--bypass-http` mode** (skipping the route, calling `runVaultToolLoop` directly): not implemented in Phase 01 because REQ-021 requires the integrated-route latency. Future polish for quick smoke iteration during Phase 02 development.
   - **Performance baseline (to be filled by the developer after running the M4 bench).** Pre-populate a placeholder table:
     ```
     | Metric | Baseline (baked, dnd-master-plus) | Phase 01 (vault, qwen3 a3b q4_K_M) |
     |---|---|---|
     | warm wall-clock (M4) | 26.05s (spike 004) | TBD by bench |
     | prompt_eval_count | ~8800 | TBD by bench |
     | rag_chunk_count | 0-3 | NULL (not attempted) |
     ```
     The developer fills the TBD column once `pnpm bench-vault-m4` has been run on the M4.

2. **Create `docs/superpowers/operations/vault-backend.md`** with sections:

   - **Flipping a campaign onto the vault backend.**
     ```
     # Find the campaign UUID
     psql ... -c "SELECT id, name FROM campaigns WHERE deleted_at IS NULL;"

     # Set the flag
     psql ... -c "UPDATE campaigns SET settings = jsonb_set(settings, '{masterBackend}', '\"vault\"') WHERE id = '<uuid>';"

     # ...or via the API
     curl -X PUT http://localhost:3000/api/campaigns/<uuid>/settings \
       -H 'content-type: application/json' \
       -H 'Cookie: __session=<jwt>' \
       -d '{"masterBackend":"vault"}'
     ```
   - **Rolling back to baked.** Same shape — `'baked'` instead of `'vault'`. The system prompt + tool surface flip on the next turn; no cache invalidation needed (the campaign was using a different model+system_prompt tuple anyway, so there's no shared KV cache to flush).
   - **Env override (ops).** `MASTER_BACKEND=vault` makes ALL campaigns without an explicit flag default to vault. Useful for dev/CI; do not set in prod.
   - **What works on the vault path.** Rules + lore lookups via the markdown vault. The 3-tool surface.
   - **What does NOT work yet on the vault path.** Game-state mutation (spells, damage, conditions, XP). Players on a vault-flagged campaign can ask questions but cannot have combat resolved through the engine. Phase 02 fixes this with `apply_event`.
   - **Running the bench.** Reference `scripts/bench-vault-m4.ts`'s top comment for prerequisites + invocation.
   - **Where the data lives.** `data/vault/` is committed to git; it IS the runtime source of truth. `data/master_*.md` are the authoring sources — re-run `pnpm migrate-handbook-to-vault` after edits.

3. **Create `tests/ai/master/vault/phase-smoke.test.ts`** — a minimal barrel-import test:
   ```
   import { describe, it, expect } from 'vitest';

   describe('vault phase smoke', () => {
     it('imports all public symbols from the barrel', async () => {
       const mod = await import('@/ai/master/vault');
       // Path
       expect(typeof mod.VAULT_ROOT).toBe('string');
       expect(typeof mod.safeVaultPath).toBe('function');
       expect(typeof mod.readVaultFile).toBe('function');
       expect(typeof mod.listVaultDir).toBe('function');
       // Prompt builder
       expect(typeof mod.buildVaultSystemPrompt).toBe('function');
       expect(typeof mod.hashVaultPrompt).toBe('function');
       // Tools
       expect(Array.isArray(mod.VAULT_TOOL_DEFINITIONS)).toBe(true);
       expect(mod.VAULT_TOOL_DEFINITIONS).toHaveLength(3);
       expect(typeof mod.VAULT_TOOL_COUNT).toBe('number');
       expect(typeof mod.dispatchVaultTool).toBe('function');
       // Loop
       expect(typeof mod.runVaultToolLoop).toBe('function');
     });

     it('VAULT_TOOL_COUNT matches the definitions length', async () => {
       const mod = await import('@/ai/master/vault');
       expect(mod.VAULT_TOOL_COUNT).toBe(mod.VAULT_TOOL_DEFINITIONS.length);
     });

     it('no tool named read_vault (REQ-011)', async () => {
       const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
       const names = VAULT_TOOL_DEFINITIONS.map(t => t.name);
       expect(names).not.toContain('read_vault');
     });

     it('no tool named apply_event (Phase 01 scope)', async () => {
       const { VAULT_TOOL_DEFINITIONS } = await import('@/ai/master/vault');
       const names = VAULT_TOOL_DEFINITIONS.map(t => t.name);
       expect(names).not.toContain('apply_event');
     });
   });
   ```
   This catches the class of failures where a single export gets dropped during refactor and individual unit tests still pass (because they import from the specific submodule, not the barrel).

4. **Optional polish — log a one-time "vault path engaged" line on first vault-flagged turn per process.** Skip if it adds plumbing; the existing `console.log('[turn]', sessionId, 'vault path: ...')` in plan 07 is sufficient observability.

## Verification

- Command: `pnpm test tests/ai/master/vault/phase-smoke.test.ts` → passes.
- Command: `pnpm typecheck` → clean.
- File check: `.planning/phases/01-vault-read-path/SUMMARY.md` exists, contains the REQ traceability matrix with all 11 REQs listed.
- File check: `docs/superpowers/operations/vault-backend.md` exists, contains the flip+rollback commands.
- Cross-reference: REQ matrix in SUMMARY.md has 11 rows matching the 11 REQs in ROADMAP.md Phase 01 `Requirements` line.
- Manual: developer runs `pnpm bench-vault-m4` on M4 and fills the TBD column in SUMMARY.md's performance baseline table.

## Open questions

None — this plan is rollup work.
