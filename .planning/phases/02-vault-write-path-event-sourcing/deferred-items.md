# Phase 02 Deferred Items

## Discovered during Plan 02-06 (tool-loop-cap-bump)

### Pre-existing test failures in `tests/ai/master/system-prompt.mode.test.ts`

**Status:** OUT-OF-SCOPE for Plan 02-06 (logged per executor scope-boundary rule).

**Failures:**
- `RAG block is injected when CampaignSettings.ragChunks is populated` — `expect(text).toMatch(/RELEVANT CONTEXT/)` fails
- `RAG block appears between mode block and active character (cache stability)` — `expect(modeIdx).toBeLessThan(ragIdx)` fails (ragIdx = -1)

**Source:** Pre-existing on `main` at Plan 02-06 commit `a24d2d0`. Verified by stashing the Task 3 file (the only new file from this plan) and re-running — failures reproduce. Not introduced by the `TURN_TOOL_CALL_CAP` → `VAULT_TURN_TOOL_CALL_CAP` rename.

**Verification of unrelated:** `tests/ai/master/system-prompt.mode.test.ts` contains zero references to `TURN_TOOL_CALL_CAP` / `VAULT_TURN_TOOL_CALL_CAP` (verified by `grep -c`). Plan 02-06's `files_modified` list (`src/sessions/types.ts`, `src/ai/master/vault/loop.ts`, `tests/ai/master/vault/loop.test.ts`, `tests/sessions/turn-tool-call-cap.test.ts`) excludes the system-prompt module entirely.

**Recommended owner:** the plan or hotfix that owns the RAG-block injection in the system prompt assembler. Likely an unfinished partial-commit on `main` (the RAG block is referenced in the test but not emitted by the assembler).

### Pre-existing typecheck error in `src/lib/preferences.ts:367` — RESOLVED by Plan 02-05

**Status:** RESOLVED. Plan 02-05 Task 2 (commit on `main` after `bd890c4`) extended `getCampaignSettings` to populate `vaultMutations: resolveVaultMutations(prefs)` in the `Required<CampaignSettings>` return, plus added `vaultMutations: false` to `DEFAULT_PREFERENCES`. `pnpm typecheck` is clean for `src/lib/preferences.ts`.

**Original error (left here for traceability):**
```
src/lib/preferences.ts(367,3): error TS2741: Property 'vaultMutations' is missing in
type '{ ttsProvider: ... }' but required in type 'Required<CampaignSettings>'.
```

**Source:** Introduced by Plan 02-05 Task 1 (`feat(phase-02): add vaultMutations field to CampaignSettings`, commit `bd890c4`). The note above mis-attributed this to "Plan 02-04" — the actual provenance is Plan 02-05 Task 1, immediately followed by Plan 02-05 Task 2 which closes the type hole.

## Discovered during Plan 02-05 (vault-mutations-flag)

### Pre-existing typecheck errors in `tests/ai/master/vault/events-schema.test.ts` — RESOLVED

**Status:** RESOLVED before Plan 02-05's final commit. The sibling Wave 1 plan that owns `tests/ai/master/vault/events-schema.test.ts` (plan 02-04 events-schema) added the `campaign_initialized` narrowing (`if (r.ok && r.value.type === 'campaign_initialized')`) in commit `945f6c5`, and `pnpm typecheck` is now clean across the whole tree.

**Original errors (left for traceability):**
```
tests/ai/master/vault/events-schema.test.ts(221,32): error TS2339: Property 'characters' does not exist on type ...
tests/ai/master/vault/events-schema.test.ts(235,32): error TS2339: Property 'characters' does not exist on type ...
```

**Cross-plan note:** Plan 02-05 Task 2 commit `233b65f` accidentally included the then-untracked `tests/ai/master/vault/events-schema.test.ts` file in its diff. The file was not part of Plan 02-05's `files_modified` scope; root cause is unclear (possibly a Claude Code worktree sync race during parallel Wave 1 execution). The downstream effect is benign — the file landed in the tree one commit earlier than the owning plan would have committed it, and the owning plan's subsequent commit (`945f6c5`) ships the test file that is internally consistent with the source. Documented here for the worktree-rejoin audit; no remediation needed.
