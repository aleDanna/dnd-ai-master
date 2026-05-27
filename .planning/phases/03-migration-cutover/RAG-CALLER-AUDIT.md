# Phase 03-C — RAG Caller Audit

**Phase:** 03-migration-cutover
**Plan:** 03-C-01 (gating pre-task for 03-C-02 deletion)
**Date:** 2026-05-27
**Status:** Audit complete — `REQUIRES PRE-DELETION CLEANUP` for 4 production callers (1 more than expected) + 2 test files outside `tests/ai/master/rag/` + 1 `package.json` script + 1 schema barrel re-export + 1 `ai_usage.rag_chunk_count` column + 1 `useRagRetrieval` user/campaign preference family.

---

## Scope

Per Decision 7 (`03-RESEARCH.md`): before deleting `src/ai/master/rag/*`, enumerate every caller in the production codebase so that plan 03-C-02 can:

1. Remove imports + call-sites surgically (no leftover dangling references).
2. Confirm the vault path NEVER reaches RAG (decoupling invariant from Phase 01/02).
3. Surface any surprise caller that would break the build on naive `rm -rf`.

**Audit method:** exhaustive grep over `src/`, `scripts/`, and `tests/` for:

- The `@/ai/master/rag/...` import alias.
- The relative `./rag/...` import variant (within `src/ai/master/`).
- Internal symbol names (`retrieveRelevant`, `getRagStore`, `embed`, `pingEmbedder`,
  `isMechanicalIntent`, `rebuildIndex`, `formatRagBlock`, `createMemoryStore`,
  `chunkMarkdown`, `RetrievedChunk`, `EmbeddedChunk`, `Chunk`).
- DB schema couplings (`rag_chunks`, `ragChunks`, `@/db/schema/rag-chunks`,
  `rag_chunk_count`, `ragChunkCount`).
- User/campaign preference (`useRagRetrieval`, `resolveUseRagRetrieval`).

---

## Production callers under `src/` (BLOCKERS for 03-C-02)

| # | File | Lines | Imports | Code-path / reached via |
|---|------|-------|---------|--------------------------|
| 1 | `src/app/api/sessions/[id]/turn/route.ts` | 16–19 | `retrieveRelevant`, `getRagStore`, `embed`, `isMechanicalIntent` | **BAKED branch only.** Gated on `useRag = userPrefs.useRagRetrieval && baked && !mechanical` (line 623). Retrieval body at lines 624–649; chunks injected as `ragChunks` prop into `buildMasterSystemPrompt` (line 703) and recorded into `recordUsage({ ragChunkCount })` (line 775). |
| 2 | `src/app/api/rag/rebuild/route.ts` | 3–5 | `rebuildIndex`, `getRagStore`, `embed` | Admin POST endpoint `/api/rag/rebuild`. No consumer in the production UI per `grep -rn "/api/rag/rebuild" src/` (0 hits). Whole file deleted. |
| 3 | `src/lib/local-services.ts` | 2 | `pingEmbedder` | Settings/diagnostics screen — line 330 inside `Promise.all([buildAiStatus(), buildPiperStatus(), buildDrawThingsStatus(), pingEmbedder().catch(…)])`. Result surfaces as `embedder: { reachable }` in the local-services status payload (line 322 + 344). |
| 4 | **`src/ai/master/system-prompt.ts`** | **5–6** | **`RetrievedChunk` (type)**, **`formatRagBlock`** | **NOT in the plan's expected list of 3 callers** — uses the relative path `./rag/types` and `./rag/format` (not the `@/ai/master/rag/...` alias), so was invisible to the alias-only grep in the plan body. Caller-block: line 1393 (`ragChunks?: RetrievedChunk[]` in the `BuildMasterSystemPromptInput` shape) and lines 2128–2131 (the `if (input.staticBlocksAlreadyBaked && input.ragChunks && input.ragChunks.length > 0)` branch that injects the `RELEVANT CONTEXT` block via `formatRagBlock(input.ragChunks)`). |

### Surprise caller flag

Caller #4 is NOT a "vault touches RAG" surprise (the vault path is still RAG-free —
see invariant section below), but it IS a **larger surface than the plan anticipated**:
`buildMasterSystemPrompt` is itself a vault-and-baked shared builder, so its `ragChunks`
parameter must be dropped from the input shape, the `RELEVANT CONTEXT` injection branch
removed from the body, and any callers (in vault prompt-builder or elsewhere) that
forward `ragChunks` must be updated.

`grep -rn "ragChunks" src/ai/master/vault/` returns 0 hits, so the vault prompt-builder
already does not forward `ragChunks` — but plan 03-C-02 must still drop the field from
the shared shape and the RAG injection branch.

---

## Production callers under `scripts/` (SAFE — retired alongside)

| # | File | Lines | Imports | Action in 03-C-02 |
|---|------|-------|---------|---------------------|
| 5 | `scripts/build-rag-index.ts` | 17–19 | `rebuildIndex`, `getRagStore`, `embed`, `DEFAULT_EMBEDDER_CONFIG` | Whole file deleted. |
| 6 | `scripts/build-local-models.ts` | 200–201, 224 | (no import — only comments referencing the now-defunct "Plan E.2 RAG" strategy) | Comment cleanup; no functional change. Pure dead-reference (Rule 4 of audit classification: SAFE). |

---

## Test callers under `tests/` (SAFE — deleted alongside)

### Inside `tests/ai/master/rag/` (whole directory deleted)

| File | Imports |
|------|---------|
| `tests/ai/master/rag/chunker.test.ts` | `chunkMarkdown` from `@/ai/master/rag/chunker` |
| `tests/ai/master/rag/embedder.test.ts` | `embed`, `embedBatch`, `pingEmbedder` from `@/ai/master/rag/embedder` |
| `tests/ai/master/rag/format.test.ts` | `formatRagBlock` from `@/ai/master/rag/format` |
| `tests/ai/master/rag/indexer.test.ts` | `rebuildIndex`, `computeCorpusHash` from `@/ai/master/rag/indexer`; `createMemoryStore` from `@/ai/master/rag/store-memory` |
| `tests/ai/master/rag/intent.test.ts` | `isMechanicalIntent` from `@/ai/master/rag/intent` |
| `tests/ai/master/rag/retriever.test.ts` | `retrieveRelevant` from `@/ai/master/rag/retriever`; `RagStore`, `RetrievedChunk` types |
| `tests/ai/master/rag/store-memory.test.ts` | `createMemoryStore` from `@/ai/master/rag/store-memory` |

7 test files — `rm -rf tests/ai/master/rag/` in 03-C-02.

### Outside `tests/ai/master/rag/` — rag-coupled tests that ALSO must be touched

| # | File | Coupling | Action in 03-C-02 |
|---|------|----------|---------------------|
| T1 | **`tests/ai/master/system-prompt.mode.test.ts`** | Lines 98, 101, 111, 113, 121: two `it()` blocks exercising the `ragChunks` injection branch in `buildMasterSystemPrompt` (`'injects RELEVANT CONTEXT block when ragChunks is non-empty'` and `'does NOT inject RELEVANT CONTEXT block when ragChunks is undefined or empty'`). | Delete the two `it()` blocks (or the entire `describe` block, if it is dedicated to RAG). |
| T2 | **`tests/lib/preferences-rag.test.ts`** | Lines 6, 10, 14, 15: tests `resolveUseRagRetrieval` over all `(aiProvider, useRagRetrieval)` quadrants. | Delete the entire file (the function `resolveUseRagRetrieval` will be removed from `preferences.ts`). |

Both files were NOT in the plan's expected test list. They live OUTSIDE `tests/ai/master/rag/`
and would silently fail to compile after the deletion if untouched.

---

## DB schema + barrel exports (SAFE — handled by plans 03-C-02 / 03-C-03)

| # | File | Lines | What | Plan |
|---|------|-------|------|------|
| S1 | `src/ai/master/rag/store-pgvector.ts` | 3 | `import { ragChunks } from '@/db/schema/rag-chunks'` (the only schema importer) | Deleted with the module — 03-C-02. |
| S2 | `src/db/schema/index.ts` | 27 | `export * from './rag-chunks';` (barrel re-export) | Removed in 03-C-03 (mentioned for completeness). |
| S3 | `src/db/schema/rag-chunks.ts` | 23–40 | Table definition (`pgTable('rag_chunks', …)`) + `ragChunks`, `RagChunkRow`, `RagChunkInsert` exports | Deleted in 03-C-03 (pgvector drop). |
| S4 | `src/db/schema/ai-usage.ts` | 29–31 | Column `ragChunkCount: integer('rag_chunk_count')` | Drop in a separate plan (03-C-03 area). Backwards-compatible: pure metric column, no FK. |
| S5 | `src/ai/master/usage.ts` | 40, 53 | `ragChunkCount?: number \| null` in `RecordUsageArgs` + insert mapping | Update when S4 happens (drop the field). |

---

## User / campaign preference family (handled in 03-C-02 or a sibling)

`useRagRetrieval` is a per-user + per-campaign override. Removing the RAG path means
the preference loses meaning. Affected surfaces:

| # | File | Lines | What |
|---|------|-------|------|
| P1 | `src/lib/preferences.ts` | 272, 341, 363, 482, 502, 698–700, 775–782 | `useRagRetrieval` default, resolver `resolveUseRagRetrieval`, validation in PATCH body |
| P2 | `src/db/schema/users.ts` | 96 | `useRagRetrieval?: boolean` in `UserPreferences` |
| P3 | `src/db/schema/campaigns.ts` | 64 | `useRagRetrieval?: boolean` in `CampaignPreferences` |
| P4 | `src/app/api/campaigns/[id]/settings/route.ts` | 32 | `'useRagRetrieval'` in the allow-list of settable campaign keys |
| P5 | `tests/lib/preferences-rag.test.ts` | entire file | Tests for `resolveUseRagRetrieval` (see T2 above) |

Plan 03-C-02 should decide whether to:
- **Option A — Remove the preference outright** (`useRagRetrieval` deleted from the schema,
  the resolver, the PATCH allow-list, and the test file). Cleanest, but is a JSONB-shape
  change at rest (legacy rows just ignore the unknown key). Recommended.
- **Option B — Soft-deprecate** (keep the field as a no-op stub for one cycle). Heavier
  and pointless if no UI exposes it any longer.

**Recommendation: Option A.** The JSONB user/campaign prefs columns silently tolerate
the legacy key on read; no migration needed.

---

## Vault path RAG-free invariant (CONFIRMED)

```bash
grep -rn "rag" src/ai/master/vault/ --include='*.ts'
```

Returns 5 hits, ALL of which are false positives on the substring `rag` (not the RAG module):

| File | Line | Substring | Why false positive |
|------|------|-----------|---------------------|
| `src/ai/master/vault/campaign-paths.ts` | 83 | `Aragorn` / `aragorn` | Doc comment example for case-folding |
| `src/ai/master/vault/events-schema.ts` | 52 | `paragraphs` (in "have no Phase 02 event-type coverage") | Doc text |
| `src/ai/master/vault/events-schema.ts` | 73 | `rage` (in "resource_use … rage, surge") | Class-feature example |
| `src/ai/master/vault/projector.ts` | 117, 908 | `rage`, `rage` | Class-feature projector references |
| `src/ai/master/vault/tools.ts` | 134 | `storage` (in "per-campaign storage") | Doc text |

**No vault file imports from `@/ai/master/rag/...` or `./rag/...`.**
**No vault file references `ragChunks`, `RetrievedChunk`, `formatRagBlock`, etc.**

The Phase 01 / 02 decoupling invariant is INTACT: the vault path produces system prompts
that NEVER receive RAG chunks. Plan 03-C-02 can delete `src/ai/master/rag/` without
touching `src/ai/master/vault/`.

---

## Package.json script (SAFE — handled in 03-C-02)

| File | Line | Entry |
|------|------|-------|
| `package.json` | 30 | `"build-rag-index": "tsx scripts/build-rag-index.ts",` |

Remove the entry alongside the deletion of `scripts/build-rag-index.ts`.

---

## Per-File Edit Plan for Plan 03-C-02

The following is the authoritative edit list that 03-C-02 consumes verbatim:

### A. `src/app/api/sessions/[id]/turn/route.ts`
- **DELETE** imports at lines 16–19:
  ```ts
  import { retrieveRelevant } from '@/ai/master/rag/retriever';
  import { getRagStore } from '@/ai/master/rag/store';
  import { embed } from '@/ai/master/rag/embedder';
  import { isMechanicalIntent } from '@/ai/master/rag/intent';
  ```
- **DELETE** the retrieval block (lines ~600–649): the long doc comment, the
  `lastUserText` extraction, the `mechanical = isMechanicalIntent(...)` call,
  the `useRag = userPrefs.useRagRetrieval && baked && !mechanical` flag, the
  `ragChunks` declaration, the `if (useRag) { … retrieveRelevant(…) … }` body,
  and the two `else if` console-log branches.
- **DELETE** the `ragChunks,` line (703) from the `buildMasterSystemPrompt({...})` call.
- **DELETE** the `ragChunkCount: useRag ? ragChunks.length : null,` field (line 775)
  from the `recordUsage({ usage: { ... } })` call (replace with nothing — the
  field will be removed from the `RecordUsageArgs` shape in plan 03-C-03 / a sibling).
- **DELETE** the `ragChunkCount: null,` line near line 378 (the early-return path
  where RAG was not attempted) — same justification.
- **KEEP** the `injectRollTriggersSlim: baked && mechanical` line (722) — that
  flag still has value, but it now depends on `mechanical` which currently
  comes from `isMechanicalIntent`. Plan 03-C-02 must EITHER:
  - Inline a minimal `isMechanicalIntent` heuristic into `route.ts` (it is a
    pure regex/keyword check on `lastUserText` — see `src/ai/master/rag/intent.ts`),
    **OR**
  - Drop the `injectRollTriggersSlim` mechanical gate entirely (and let it inject
    on every baked turn, ~500 extra tokens but simpler), **OR**
  - Move `isMechanicalIntent` out of `rag/` into a more neutral location
    (`src/ai/master/intent.ts`) since it has no RAG-specific dependency.
  - **Recommendation: option 3.** Keep the heuristic, move it out of the RAG
    module. Cleanest and preserves the token-saving optimization.

### B. `src/app/api/rag/rebuild/route.ts`
- **DELETE** the entire file. No external consumer.

### C. `src/lib/local-services.ts`
- **DELETE** the import at line 2: `import { pingEmbedder } from '@/ai/master/rag/embedder';`
- **DELETE** the `pingEmbedder().catch(...)` entry from the `Promise.all([...])` (line 330).
- **DELETE** the `embedderReachable` destructured binding (line 326) and the
  `embedder: { reachable: embedderReachable }` field in the return (line 344).
- **DELETE** the corresponding `embedder` field from the `EngineStatus`-shaped
  `empty` return on the non-local-environment branch (line 322).
- **UPDATE** the `LocalServicesStatus` type definition (look it up in the same
  file or its export point) to drop the `embedder` field. If consumers of the
  status payload (settings UI components) read `status.embedder.reachable`,
  they must drop that field too — plan 03-C-06 (UI polish) tracks the badge
  removal.

### D. `src/ai/master/system-prompt.ts` (SURPRISE — not in plan body)
- **DELETE** imports at lines 5–6:
  ```ts
  import type { RetrievedChunk } from './rag/types';
  import { formatRagBlock } from './rag/format';
  ```
- **DELETE** the `ragChunks?: RetrievedChunk[];` field (line 1393) from the
  `BuildMasterSystemPromptInput` type.
- **DELETE** the injection branch (lines 2128–2131):
  ```ts
  if (input.staticBlocksAlreadyBaked && input.ragChunks && input.ragChunks.length > 0) {
    blocks.push({
      kind: 'rag',
      text: formatRagBlock(input.ragChunks),
    });
  }
  ```
- This is what couples 03-C-02 to `system-prompt.ts`. Without this edit, the
  next typecheck after deleting `src/ai/master/rag/` would fail with
  "module not found `./rag/types`" + "module not found `./rag/format`".

### E. `src/ai/master/rag/` (entire directory)
- **DELETE** the directory: `chunker.ts`, `embedder.ts`, `format.ts`, `indexer.ts`,
  `intent.ts`, `retriever.ts`, `store-memory.ts`, `store-pgvector.ts`, `store.ts`,
  `types.ts`. **10 files.**
- **PRE-DELETION:** if option 3 of edit (A) is chosen, move `intent.ts` to
  `src/ai/master/intent.ts` first.

### F. `tests/ai/master/rag/` (entire directory)
- **DELETE** the directory: `chunker.test.ts`, `embedder.test.ts`, `format.test.ts`,
  `indexer.test.ts`, `intent.test.ts`, `retriever.test.ts`, `store-memory.test.ts`.
  **7 files.**

### G. `tests/ai/master/system-prompt.mode.test.ts`
- **DELETE** the two RAG-coupled `it()` blocks (lines 98, 111). Keep the rest of
  the file (it covers other mode-aware injection behaviour).

### H. `tests/lib/preferences-rag.test.ts`
- **DELETE** the entire file. The `resolveUseRagRetrieval` function is removed
  in plan 03-C-02 (or a sibling) so the test has nothing left to assert.

### I. `package.json`
- **DELETE** the script entry at line 30:
  ```json
  "build-rag-index": "tsx scripts/build-rag-index.ts",
  ```

### J. `scripts/build-rag-index.ts`
- **DELETE** the entire file. No consumer except the `pnpm build-rag-index` script.

### K. `scripts/build-local-models.ts`
- **EDIT** lines 200–201, 224: replace the "RAG in Plan E.2" comments with neutral
  text reflecting the new design (RAG is gone — the handbook is no longer offloaded
  to RAG, so the comment must reflect either: "handbook is full in non-baked path",
  or "baked path uses ultra-slim, non-baked uses full"). Pure doc fix.

### L. `src/lib/preferences.ts` (decision required in 03-C-02)
- If `useRagRetrieval` is removed (recommended Option A):
  - DELETE the default at line 272.
  - DELETE the resolver call at lines 341 and 482.
  - DELETE the `useRagRetrieval,` field at lines 363 and 502.
  - DELETE the PATCH validation block at lines 698–700.
  - DELETE the `resolveUseRagRetrieval` function (lines 775–782 area).

### M. `src/db/schema/users.ts` / `src/db/schema/campaigns.ts`
- DELETE the `useRagRetrieval?: boolean` field from each preference type (lines 96 / 64).
- JSONB column shape — no DB migration needed; legacy rows ignore the unknown key.

### N. `src/app/api/campaigns/[id]/settings/route.ts`
- DELETE `'useRagRetrieval'` from the allow-list (line 32).

### Out-of-scope for 03-C-02 (handled by 03-C-03)

- `src/db/schema/rag-chunks.ts` — full delete.
- `src/db/schema/index.ts` — drop the `export * from './rag-chunks';` (line 27).
- `src/db/schema/ai-usage.ts` — drop the `ragChunkCount: integer('rag_chunk_count')`
  column (line 31).
- `src/ai/master/usage.ts` — drop the `ragChunkCount` field from `RecordUsageArgs` +
  the insert mapping (lines 40 + 53).
- The actual `DROP COLUMN rag_chunk_count` + `DROP TABLE rag_chunks` + `DROP EXTENSION
  IF EXISTS vector` migration.

---

## Discrepancy Notes vs. Plan Body

The plan body (in `03-C-01-grep-rag-callers.md`) anticipated **3 production callers**
(`src/app/api/sessions/[id]/turn/route.ts`, `src/app/api/rag/rebuild/route.ts`,
`src/lib/local-services.ts`).

This audit finds **4 production callers**: the surprise is
`src/ai/master/system-prompt.ts` (caller #4), which uses the relative `./rag/...`
path instead of the `@/ai/master/rag/...` alias and was therefore invisible to the
alias-only grep in the plan body. The plan's `must_haves.truths` will need a small
update (or the per-file edit plan can be consumed AS-IS by plan 03-C-02, which is the
intended consumption path — see `key_links` in the plan frontmatter).

Plan 03-C-02's `files_modified` array MUST add: `src/ai/master/system-prompt.ts`,
`tests/ai/master/system-prompt.mode.test.ts`, `tests/lib/preferences-rag.test.ts`,
`scripts/build-local-models.ts`, `src/lib/preferences.ts`, `src/db/schema/users.ts`,
`src/db/schema/campaigns.ts`, and `src/app/api/campaigns/[id]/settings/route.ts`.
(The vault-path RAG-free invariant is intact — no vault file edits needed.)

---

## Final Verdict

**REQUIRES PRE-DELETION CLEANUP.**

Plan 03-C-02 can proceed, but MUST consume the per-file edit plan above verbatim.
Specifically, the surprise caller (`src/ai/master/system-prompt.ts`) and the two
out-of-`tests/ai/master/rag/` test files (`system-prompt.mode.test.ts`,
`preferences-rag.test.ts`) MUST be on its `files_modified` list, or the deletion
will leave dangling imports + failing tests.

Vault path is RAG-free — invariant holds. No escalation needed.

---

## Audit Sign-Off

- **Audit author:** executor (plan 03-C-01)
- **Audit reviewed by:** (operator — pending)
- **Date:** 2026-05-27
- **All callers enumerated:** YES (4 production callers + 1 schema + 2 outside tests + 1 package.json + 9 preference-family surfaces)
- **Vault path RAG-free invariant:** CONFIRMED (5 grep hits, all false positives)
- **Plan 03-C-02 may proceed:** YES, with the expanded `files_modified` list above.
