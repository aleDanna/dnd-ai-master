---
phase: 03-migration-cutover
plan: C-01
subsystem: audit
tags: [rag, decommission, audit, grep, phase-03, decision-7]

requires:
  - phase: 03-migration-cutover
    provides: "Decision 7 (RAG decommission ordering: audit → delete code → drop pgvector → free SSD)"
provides:
  - "Authoritative RAG-caller enumeration driving plan 03-C-02 (4 production callers — 1 more than anticipated)"
  - "Confirmation that the vault path is RAG-free (decoupling invariant intact)"
  - "Per-file verbatim edit plan for 03-C-02 deletion (covers src/, scripts/, tests/, schema/, package.json, preferences family)"
  - "Discrepancy note: 03-C-02 must add 5 additional files to its files_modified list (system-prompt.ts, 2 tests, build-local-models.ts, 4 preference-family files)"
affects: [03-C-02-delete-rag-code, 03-C-03-drop-pgvector, 03-C-06-ui-polish, preferences-cleanup]

tech-stack:
  added: []
  patterns: ["audit-driven-deletion: enumerate-then-delete instead of grep-then-pray"]

key-files:
  created:
    - .planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md
  modified: []

key-decisions:
  - "AUDIT-only scope honored: zero source code changes — every finding flows downstream to 03-C-02"
  - "Surprise caller flagged (not escalated): src/ai/master/system-prompt.ts uses relative './rag/...' path — invisible to alias-only grep in plan body. Verdict: requires pre-deletion cleanup, NOT a re-planning event"
  - "Vault-path RAG-free invariant CONFIRMED via grep — 5 hits are all false positives on the substring 'rag' (aragorn, rage, storage, paragraphs). Phase 01/02 decoupling intact"
  - "Recommend Option A for useRagRetrieval preference: remove outright. JSONB tolerates legacy keys, no migration needed"
  - "Recommend moving isMechanicalIntent out of src/ai/master/rag/intent.ts into src/ai/master/intent.ts (it has no RAG-specific dependency and still gates injectRollTriggersSlim)"

patterns-established:
  - "Audit pattern: when a deletion has bounded scope, run THREE grep variants (alias path, relative path, internal symbol names) — alias-only grep would have missed system-prompt.ts caller"

requirements-completed: [REQ-033]

duration: 11min
completed: 2026-05-27
---

# Phase 03 Plan C-01: RAG Caller Audit Summary

**Enumerated every importer of `src/ai/master/rag/*` across src/, scripts/, and tests/ — found 4 production callers (1 more than the plan anticipated), 7 directly-coupled test files, 2 outside-directory test files, 5 schema/usage couplings, 9 preference-family surfaces, and 1 package.json script. Verdict: REQUIRES PRE-DELETION CLEANUP — plan 03-C-02 must expand its `files_modified` list to include the surprise caller (`src/ai/master/system-prompt.ts`) and the two outside-directory test files; without that, the deletion would leave dangling imports and failing tests. Vault path RAG-free invariant CONFIRMED.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-05-27T21:44:00Z (approx)
- **Completed:** 2026-05-27T21:55:34Z
- **Tasks:** 1/1
- **Files created:** 1

## Accomplishments

- Produced `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md` — the authoritative input for plan 03-C-02 deletion.
- Identified a **surprise 4th production caller** (`src/ai/master/system-prompt.ts`, relative import path) that the plan body's alias-only grep would have missed.
- Confirmed the vault-path RAG-free invariant by exhaustive grep over `src/ai/master/vault/` (5 substring false-positives, 0 module imports).
- Mapped the full RAG-decommission surface: 4 src files, 1 scripts file (delete), 1 scripts file (comment-only edit), 7 test files (delete-with-directory), 2 test files (outside directory — must be edited), 1 schema barrel, 1 schema table, 1 schema column, 5 preference-family files, 1 package.json script entry.
- Produced verbatim per-file edit plan for 03-C-02 with three open decisions (preference removal strategy, `isMechanicalIntent` relocation, `LocalServicesStatus` shape).

## Task Commits

1. **Task 1: Grep + classify every RAG caller** — `bd64925` (docs)

## Files Created/Modified

- `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md` — created. Authoritative caller list (342 lines): production callers under `src/`, scripts callers, test-side couplings inside + outside `tests/ai/master/rag/`, DB schema couplings, user/campaign preference family, vault-path RAG-free invariant verification, per-file edit plan for 03-C-02, discrepancy notes vs. plan body, final verdict.

## Decisions Made

1. **AUDIT-only scope honored.** Despite finding 4 callers (not 3) + 2 outside-directory test files, no source code was changed. Every finding is documented for plan 03-C-02 to act on. Rationale: the plan's `<contract>` is explicit ("Your scope is AUDIT-only. NO source code changes"), and the discrepancy is structural (more files than expected, not a wrong direction) — does not trigger Rule 4 (architectural escalation).

2. **No escalation needed.** The surprise caller is `src/ai/master/system-prompt.ts`, which is on the baked branch (already in scope for plan 03-C-02's RAG removal) — it just was not enumerated in the plan body because the plan used the alias-only grep. The deletion plan's intent (remove RAG from the baked path) is unchanged; only its `files_modified` list needs to grow.

3. **Vault path RAG-free invariant CONFIRMED.** All 5 grep hits inside `src/ai/master/vault/` are substring false-positives (`aragorn`, `rage`, `storage`, `paragraphs`) — none are module imports. The Phase 01/02 decoupling invariant is intact, which was the second main reason to run this audit.

4. **Recommended decisions for plan 03-C-02 (documented for the next executor):**
   - **`useRagRetrieval` preference:** Option A — remove outright. JSONB columns tolerate unknown keys on read, no DB migration. Clean.
   - **`isMechanicalIntent` heuristic:** Option 3 — move it from `src/ai/master/rag/intent.ts` to `src/ai/master/intent.ts`. Preserves the `injectRollTriggersSlim` token-saving optimization without retaining the RAG module.
   - **`LocalServicesStatus.embedder` field:** drop along with the badge in plan 03-C-06 UI polish.

## Deviations from Plan

None — plan executed within scope. The audit found more callers than the plan anticipated, but enumerating that discrepancy IS the audit's job (per `<contract>` "Final verdict: SAFE TO DELETE / REQUIRES PRE-DELETION CLEANUP"). The verdict `REQUIRES PRE-DELETION CLEANUP` is documented in the audit and surfaced to 03-C-02.

## Risks / Caveats Flagged for 03-C-02

1. **Three open decisions** in the per-file edit plan (preference removal strategy, `isMechanicalIntent` relocation, `LocalServicesStatus` shape). Plan 03-C-02 must resolve them before editing or risks committing a half-decision.

2. **`tests/ai/master/system-prompt.mode.test.ts`** has the two RAG `it()` blocks tightly coupled to `formatRagBlock` — must be edited surgically (not blanket-delete the whole file) since the rest of the file covers other mode-aware behaviour.

3. **`src/ai/master/usage.ts` and `src/db/schema/ai-usage.ts`** carry the `ragChunkCount` field. The audit flags these as 03-C-03-area, but they MUST be edited together with `src/app/api/sessions/[id]/turn/route.ts` or the typecheck will fail (route writes `ragChunkCount: null` even on the no-RAG-attempted path). Either:
   - keep the field in the DB + types and pass `null` constants until 03-C-03 lands, OR
   - drop them together as a single Wave 7/8 unit.
   Recommend the latter — keeping a "metric column that always writes null" is dead-weight.

4. **No vault path edits required** — invariant confirmed. 03-C-02 must NOT touch `src/ai/master/vault/`.

## Acceptance Criteria

- [x] `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md` exists
- [x] At least 3 RAG-caller rows (found 4 production + 2 scripts + 7 in-dir tests + 2 out-of-dir tests = 15+ rows)
- [x] Confirmation that `vault/` does NOT reach RAG (`grep -rn "rag" src/ai/master/vault/` → 5 false positives, documented)
- [x] Per-file edit plan section present + maps to plan 03-C-02 edits
- [x] No surprise callers slipped through — 1 surprise (`system-prompt.ts`) explicitly flagged in `## Discrepancy Notes vs. Plan Body`
- [x] Commit committed atomically with `(phase-03)` scope

## Self-Check: PASSED

- Created file `.planning/phases/03-migration-cutover/RAG-CALLER-AUDIT.md` — exists.
- Commit `bd64925` — present on main.
- Plan automated verify (`test -f … && grep -c "from '@/ai/master/rag" …`) → returns 5 (≥1, passes).
