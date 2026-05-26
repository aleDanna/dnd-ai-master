---
phase: 03
plan: C-02
type: execute
wave: 7
depends_on: [03-C-01]
files_modified:
  - src/ai/master/rag/
  - tests/ai/master/rag/
  - scripts/build-rag-index.ts
  - src/app/api/rag/rebuild/route.ts
  - src/lib/local-services.ts
  - src/app/api/sessions/[id]/turn/route.ts
  - package.json
autonomous: true
requirements: [REQ-033]
must_haves:
  truths:
    - "src/ai/master/rag/ directory is DELETED (all 10 .ts files: chunker, embedder, format, indexer, intent, retriever, store, store-memory, store-pgvector, types)"
    - "tests/ai/master/rag/ directory is DELETED"
    - "scripts/build-rag-index.ts is DELETED"
    - "src/app/api/rag/rebuild/route.ts is DELETED"
    - "src/lib/local-services.ts no longer imports pingEmbedder; the embedder badge UI affordance is replaced with a no-op or removed"
    - "src/app/api/sessions/[id]/turn/route.ts no longer imports retrieveRelevant/getRagStore/embed/isMechanicalIntent; the useRag branch is removed; the baked-path system prompt no longer receives RAG block injection"
    - "package.json has the build-rag-index script entry removed"
    - "`pnpm build` succeeds AFTER all deletions"
    - "`pnpm test` runs without the deleted RAG tests AND without import errors"
  artifacts:
    - path: "src/ai/master/rag/"
      provides: "DELETED"
    - path: "tests/ai/master/rag/"
      provides: "DELETED"
    - path: "scripts/build-rag-index.ts"
      provides: "DELETED"
    - path: "src/app/api/rag/rebuild/route.ts"
      provides: "DELETED"
    - path: "package.json"
      provides: "build-rag-index entry removed"
  key_links:
    - from: "src/app/api/sessions/[id]/turn/route.ts"
      to: "(removed) src/ai/master/rag/*"
      via: "Imports + caller block deleted per RAG-CALLER-AUDIT.md edit plan"
      pattern: "rag"
---

# Plan 03-C-02: Delete RAG Code

**Phase:** 03-migration-cutover
**Wave:** 7 (depends on 03-C-01 audit)
**Status:** Pending
**Estimated diff size:** ~-3500 LOC source (mostly deletions) / 6+ files

## Goal

Per Decision 7 step 1-3: delete the RAG source modules + tests + build script + admin API route + library entry-points. The DB drop (step 4) comes in plan 03-C-03; the operator `ollama rm nomic-embed-text` (step 5) goes in plan 03-C-06 playbook.

This plan is per-step commits per Decision 7 — each file deletion is reviewable. Commit messages: `chore(phase-03): delete <file>` for each.

## Requirements satisfied

- **REQ-033** — RAG decommission (the primary deletion).

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/rag/` (10 files) | DELETE | Phase 02 ROADMAP item — RAG fully off vault path |
| `tests/ai/master/rag/` | DELETE | Tests for deleted modules |
| `scripts/build-rag-index.ts` | DELETE | RAG indexer script |
| `src/app/api/rag/rebuild/route.ts` | DELETE | RAG admin API |
| `src/lib/local-services.ts` | EDIT | Remove pingEmbedder import + caller |
| `src/app/api/sessions/[id]/turn/route.ts` | EDIT | Remove RAG branch from baked path |
| `package.json` | EDIT | Remove build-rag-index script |

## Tasks

<task type="auto">
  <name>Task 1: Delete src/ai/master/rag/ and tests/ai/master/rag/</name>
  <files>src/ai/master/rag/</files>
  <read_first>
    - .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md (plan 03-C-01 — confirms it's safe)
  </read_first>
  <action>
Per the audit, remove the entire RAG module tree:
```
rm -rf src/ai/master/rag/
rm -rf tests/ai/master/rag/
```

Commit:
```
chore(phase-03-c): delete src/ai/master/rag/ + tests
```

The deletion is BLOCKED until plan 03-C-01 confirms NO surprise callers. Re-grep BEFORE rm:
```
grep -rn "from '@/ai/master/rag" src/ tests/ 2>/dev/null
```
If anything outside the audit's enumerated callers is found, STOP — re-audit. Otherwise proceed.
  </action>
  <verify>
    <automated>! ls src/ai/master/rag 2>/dev/null && ! ls tests/ai/master/rag 2>/dev/null</automated>
  </verify>
  <acceptance_criteria>
    - `ls src/ai/master/rag` fails (directory does not exist)
    - `ls tests/ai/master/rag` fails
    - `git status` shows the deletions staged
    - The grep BEFORE rm did NOT find unaudited callers
  </acceptance_criteria>
  <done>
    Source + tests deleted. Build will fail until Task 2-4 remove remaining callers.
  </done>
</task>

<task type="auto">
  <name>Task 2: Delete scripts/build-rag-index.ts + src/app/api/rag/rebuild/route.ts</name>
  <files>scripts/build-rag-index.ts</files>
  <read_first>
    - .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md
  </read_first>
  <action>
Delete two files:
```
rm scripts/build-rag-index.ts
rm src/app/api/rag/rebuild/route.ts
rmdir src/app/api/rag/rebuild 2>/dev/null || true
rmdir src/app/api/rag 2>/dev/null || true
```

(Remove empty parent directories if Next.js's app router lifts the route declaration.)

Commit:
```
chore(phase-03-c): delete RAG build script + admin route
```
  </action>
  <verify>
    <automated>! test -f scripts/build-rag-index.ts && ! test -f src/app/api/rag/rebuild/route.ts</automated>
  </verify>
  <acceptance_criteria>
    - Files do not exist
    - No empty directory left under src/app/api/rag/
  </acceptance_criteria>
  <done>
    Build + admin route deleted.
  </done>
</task>

<task type="auto">
  <name>Task 3: Strip RAG imports + caller-block from turn/route.ts</name>
  <files>src/app/api/sessions/[id]/turn/route.ts</files>
  <read_first>
    - src/app/api/sessions/[id]/turn/route.ts (existing — lines 16-19 imports; lines 600-650 caller block)
    - .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md (the per-file edit plan)
  </read_first>
  <action>
Apply the per-file edit plan from the audit:
1. Delete imports at lines 16-19:
   ```ts
   // DELETE these lines:
   // import { retrieveRelevant } from '@/ai/master/rag/retriever';
   // import { getRagStore } from '@/ai/master/rag/store';
   // import { embed } from '@/ai/master/rag/embedder';
   // import { isMechanicalIntent } from '@/ai/master/rag/intent';
   ```
2. Delete the `useRag` branch (around lines 600-650). Look for:
   ```ts
   const useRag = userPrefs.useRagRetrieval && baked && !mechanical;
   let ragChunks: Awaited<ReturnType<typeof retrieveRelevant>> = [];
   if (useRag) { ... }
   else if (userPrefs.useRagRetrieval && !baked) { ... }
   else if (userPrefs.useRagRetrieval && mechanical) { ... }
   ```
   DELETE the entire block.
3. If `ragChunks` is referenced later in the file (e.g., a baked system-prompt assembly that injects `ragChunks` into the prompt), REMOVE those references too. Replace with empty array OR remove the entire branch.
4. Update the JSDoc at the top of route.ts to remove mentions of RAG.

Confirm:
```
grep -c "rag\\|RAG" src/app/api/sessions/\[id\]/turn/route.ts
```
Should return 0 (or only references in comments that the deletion missed; clean those).

Commit:
```
chore(phase-03-c): strip RAG imports + caller from turn/route.ts
```
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "from '@/ai/master/rag" src/app/api/sessions/\[id\]/turn/route.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "from '@/ai/master/rag" src/app/api/sessions/\[id\]/turn/route.ts` returns 0
    - `pnpm typecheck` exits 0
    - The useRag branch is GONE — no `useRagRetrieval`, no `retrieveRelevant`, no `ragChunks`
    - Phase 01 + Phase 02 + Phase 03 turn-route tests still pass
  </acceptance_criteria>
  <done>
    Turn route RAG-free.
  </done>
</task>

<task type="auto">
  <name>Task 4: Remove pingEmbedder from src/lib/local-services.ts</name>
  <files>src/lib/local-services.ts</files>
  <read_first>
    - src/lib/local-services.ts (existing — pingEmbedder import + caller; the function exported that uses it)
  </read_first>
  <action>
Delete the pingEmbedder import + caller in `src/lib/local-services.ts`. If pingEmbedder was used in a diagnostics function (e.g., `checkAllLocalServices()`), remove the embedder check from that function and update the return shape:

```ts
// BEFORE:
const embedderUp = await pingEmbedder();
return { ollamaUp, embedderUp, ... };

// AFTER:
return { ollamaUp, ... };
```

If a UI consumer (e.g., a Settings screen) reads `embedderUp`, find that consumer and remove the reference. Plan 03-C-06 (operator playbook) can also document a screenshot showing the diagnostics-screen change.

Commit:
```
chore(phase-03-c): remove pingEmbedder from local-services
```
  </action>
  <verify>
    <automated>pnpm typecheck && ! grep "pingEmbedder" src/lib/local-services.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep "pingEmbedder" src/lib/local-services.ts` returns 0
    - `pnpm typecheck` exits 0
    - Diagnostics function still returns a valid (smaller) shape
  </acceptance_criteria>
  <done>
    Local services cleaned.
  </done>
</task>

<task type="auto">
  <name>Task 5: Remove build-rag-index from package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (the scripts block — `build-rag-index` entry)
  </read_first>
  <action>
Delete the line `"build-rag-index": "tsx scripts/build-rag-index.ts",` from the scripts block.
  </action>
  <verify>
    <automated>! grep -q "build-rag-index" package.json && echo "ok"</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "build-rag-index" package.json` returns 0
    - package.json is valid JSON
  </acceptance_criteria>
  <done>
    Script entry removed.
  </done>
</task>

<task type="auto">
  <name>Task 6: Smoke — pnpm build succeeds + pnpm test passes</name>
  <files>(no files modified — verification only)</files>
  <read_first>
    - (none — this is a verification task)
  </read_first>
  <action>
After all Tasks 1-5 commits land, run:
```
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

All four MUST exit 0. If `pnpm build` fails, it means a hidden caller wasn't caught by the audit — STOP, re-grep, find the call site, and fix.

This task is the GATE for plan 03-C-03 (drop migration). Without `pnpm build` green, the production code has stale RAG types referenced — the migration would land but the deployment would fail.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm build && pnpm test</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `pnpm build` exits 0 (the build succeeds without RAG)
    - `pnpm test` exits 0 (existing tests still pass; deleted RAG tests are absent)
    - No `rag` or `RAG` substring in any active code path (acceptable: docs + comments mentioning the historic decommission)
  </acceptance_criteria>
  <done>
    Code-side RAG decommission complete. Plan 03-C-03 drops the DB.
  </done>
</task>
