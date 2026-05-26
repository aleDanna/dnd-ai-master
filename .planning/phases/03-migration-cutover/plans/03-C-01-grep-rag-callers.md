---
phase: 03
plan: C-01
type: execute
wave: 7
depends_on: []
files_modified:
  - .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md
autonomous: true
requirements: [REQ-033]
must_haves:
  truths:
    - "RAG-CALLER-AUDIT.md lists every production file (under src/) that imports from @/ai/master/rag/ — expected 3: src/app/api/sessions/[id]/turn/route.ts, src/app/api/rag/rebuild/route.ts, src/lib/local-services.ts"
    - "Each caller is annotated with: file path, line numbers of imports, what it imports (retrieveRelevant, getRagStore, embed, isMechanicalIntent, pingEmbedder, rebuildIndex), AND the broader context (which code-path uses it)"
    - "The audit confirms every RAG caller is REACHED only via the BAKED path — never via the vault path"
    - "The audit produces an EXECUTION PLAN for plan 03-C-02 deletion: per-file edit description for the import removals + the caller-block removals"
  artifacts:
    - path: ".planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md"
      provides: "Authoritative caller list — drives plan 03-C-02 deletion"
  key_links:
    - from: ".planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md"
      to: "plan 03-C-02 deletion"
      via: "Per-file edit description consumed verbatim"
      pattern: "RAG-CALLER-AUDIT"
---

# Plan 03-C-01: RAG Caller Audit (GATING)

**Phase:** 03-migration-cutover
**Wave:** 7 (gating pre-task for 03-C-02 deletion)
**Status:** Pending
**Estimated diff size:** ~150 LOC docs / 1 file

## Goal

Per Decision 7: before deleting `src/ai/master/rag/*`, audit every caller in the production codebase. Confirm:
1. RAG is reached only via the baked path (vault path NEVER calls RAG)
2. Every import + caller is enumerated for plan 03-C-02 to remove cleanly
3. No surprise caller exists (e.g., a hidden import in a Server Action or a Vercel middleware)

The grep finding is the authoritative input to plan 03-C-02. If anything surprising is found here, plan 03-C-02 is paused for re-planning.

## Requirements satisfied

- **REQ-033** — RAG decommission gating step. Without the audit, plan 03-C-02 risks breaking the build.

## Files touched

| File | Action | Why |
|---|---|---|
| `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md` | NEW | The audit |

## Tasks

<task type="auto">
  <name>Task 1: Grep + classify every RAG caller</name>
  <files>.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md</files>
  <read_first>
    - src/app/api/sessions/[id]/turn/route.ts (the main RAG caller — baked branch)
    - src/app/api/rag/rebuild/route.ts (the RAG index rebuild API)
    - src/lib/local-services.ts (pingEmbedder usage)
    - src/ai/master/rag/ (the modules being deleted — confirm they don't import each other in a way that breaks the deletion order)
    - tests/ai/master/rag/ (the tests that get deleted alongside)
  </read_first>
  <action>
Run greps to enumerate callers:

```bash
grep -rn "from '@/ai/master/rag" src/ 2>/dev/null
grep -rn "from '@/ai/master/rag" tests/ 2>/dev/null
grep -rn "rag_chunks\\|ragChunks" src/ 2>/dev/null
grep -rn "@/db/schema/rag" src/ 2>/dev/null
```

Then write `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md`:

```markdown
# Phase 03-C — RAG Caller Audit

**Phase:** 03-migration-cutover
**Plan:** 03-C-01 (gating pre-task for 03-C-02 deletion)
**Date:** 2026-05-26

## Source Files Importing from @/ai/master/rag/

| File | Lines | Imports | Reached via |
|---|---|---|---|
| `src/app/api/sessions/[id]/turn/route.ts` | 16-19 | `retrieveRelevant, getRagStore, embed, isMechanicalIntent` | BAKED branch only (gated on `useRag = userPrefs.useRagRetrieval && baked && !mechanical`) |
| `src/app/api/rag/rebuild/route.ts` | 3-5 | `rebuildIndex, getRagStore, embed` | Admin API — no consumer in production UI |
| `src/lib/local-services.ts` | 2 | `pingEmbedder` | Settings/diagnostics screen for "Embedder up?" badge |

## Test Files Importing from @/ai/master/rag/

| File | Lines | Imports |
|---|---|---|
| `tests/ai/master/rag/<name>.test.ts` | N | (each rag/<name>.ts test) |

## Source Files Importing from @/db/schema/rag-chunks (or referencing ragChunks)

| File | Line | What |
|---|---|---|
| `src/ai/master/rag/store-pgvector.ts` | 3 | The schema import (deleted alongside rag/) |
| `src/db/schema/index.ts` | ? | Barrel export (remove in plan 03-C-03) |

## Confirmation: Vault Path Does NOT Reach RAG

`grep -rn "rag" src/ai/master/vault/` returns 0 matches. The vault path is decoupled.

## Per-File Edit Plan for Plan 03-C-02

### `src/app/api/sessions/[id]/turn/route.ts`
- DELETE imports at lines 16-19
- DELETE the `useRag = userPrefs.useRagRetrieval && baked && !mechanical;` branch + its body (lines 607-635 approximately)
- DELETE any RAG-block injection into the baked system prompt (the `if (ragChunks.length > 0)` branch)
- KEEP all other Phase 02 + Phase 03 wiring intact

### `src/app/api/rag/rebuild/route.ts`
- DELETE the entire file (the API endpoint goes away)

### `src/lib/local-services.ts`
- DELETE the `pingEmbedder` import + caller
- The diagnostics screen that referenced the embedder badge gets a fallback (e.g., remove the badge, or replace with a generic "Vault ready" indicator); see plan 03-C-06 playbook for UI polish

### `src/db/schema/index.ts`
- DELETE the `export * from './rag-chunks';` line (plan 03-C-03 handles this; mentioned here for completeness)

### `tests/ai/master/rag/`
- DELETE the entire directory (plan 03-C-02)

### `package.json`
- DELETE the `"build-rag-index": "tsx scripts/build-rag-index.ts",` script entry

## Audit Sign-Off

Audit author: (executor)
Audit reviewed by: (operator)
Date: 2026-05-26

All callers enumerated. Plan 03-C-02 can proceed with the per-file edits above.
```

The actual grep output may surface MORE callers than the 3 expected — if so, list them all and update plan 03-C-02's file_modified list accordingly.

If the grep finds RAG callers in the VAULT path (unexpected per Phase 01/02 design), STOP — flag the surprise + escalate. The vault path is supposed to be RAG-free.
  </action>
  <verify>
    <automated>test -f .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md && grep -c "from '@/ai/master/rag" .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md</automated>
  </verify>
  <acceptance_criteria>
    - File exists
    - At least 3 RAG-caller rows (matches the expected source-file count)
    - Confirmation that vault/ does NOT reach RAG (`grep -rn "rag" src/ai/master/vault/` returns 0 in the audit)
    - Per-file edit plan section is present + maps to plan 03-C-02 edits
    - No surprise callers — if found, the audit explicitly flags them
  </acceptance_criteria>
  <done>
    Audit complete. Plan 03-C-02 proceeds with the deletion.
  </done>
</task>
