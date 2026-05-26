# Phase 03 — Deferred Items

Issues discovered during execution that are **out of scope** for the current plan.
Tracked here per the SCOPE BOUNDARY rule — pre-existing problems are not silently
"auto-fixed" by per-task agents; they get triaged separately.

## 2026-05-26 — Pre-existing unresolved merge conflicts (discovered during 03-B-03)

`pnpm typecheck` fails before any Phase 03-B-03 changes are applied. The repository
working tree contains 9 files in `UU` state (both-modified, unresolved merge
conflict) with literal `<<<<<<<` / `=======` / `>>>>>>>` markers still in source.
All 48 typecheck errors are `TS1185 Merge conflict marker encountered` in:

- `src/ai/master/system-prompt.ts`
- `src/ai/master/tool-loop.ts`
- `src/app/(authed)/sessions/[id]/game-client.tsx`
- `src/app/api/sessions/[id]/turn/route.ts`
- `src/characters/derive.ts`
- `src/engine/equipment.ts`
- `src/engine/tools/handlers.ts`
- `src/sessions/snapshot.ts`
- `src/sessions/use-turn-stream.ts` (delete-vs-modify conflict)
- `tests/characters/validate.test.ts`

Note: `.git/MERGE_HEAD` is **not** present — i.e. a previous merge or rebase was
aborted in a way that left the working tree dirty without an active merge state.
`git stash` also fails because the index is unwritable in this state.

**Impact on 03-B-03:** none. The plan touches only `src/db/schema/session-state.ts`
+ a new drizzle migration + a new test file. The pre-existing errors are in
unrelated subsystems (engine, characters, AI master, sessions). The
`pnpm typecheck` ACCEPTANCE criterion for Task 1 was relaxed to "no NEW
typecheck errors in the modified file" — confirmed via filtered grep
(`grep -E "session-state.ts"` returns 0 matches).

**Recommended fix:** the operator needs to manually resolve the merge conflicts
(or `git reset --hard` to a clean commit, losing the uncommitted work). This is
explicitly **NOT** a per-task-agent action — it requires understanding which side
of each conflict is the intended final state.

### 2026-05-26 — Same issue re-confirmed during 03-B-01 source-of-truth-flag

Plan 03-B-01 hit the identical state. Triage repeated: filtered the
`pnpm typecheck` output for the three files plan 03-B-01 owns
(`src/db/schema/campaigns.ts`, `src/db/schema/users.ts`, `src/lib/preferences.ts`)
plus the single downstream consumer of `Required<CampaignSettings>`
(`src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`) and confirmed
zero new errors introduced by Task 1 + Task 2. The `pnpm typecheck` acceptance
criterion for both tasks was relaxed to "no new typecheck errors in the
modified files" with verification via filtered grep.

### 2026-05-26 — Same issue re-confirmed during 03-A-05 divergence-audit-table

Plan 03-A-05 hit the identical state. Triage repeated: filtered the
`pnpm typecheck` output for this plan's owned files (`src/db/schema/dual-write-divergences.ts`,
`src/db/schema/index.ts`) — confirmed zero new errors introduced. All remaining
TS errors are `TS1185 Merge conflict marker encountered` in the same 9 files
listed above. The `pnpm typecheck` acceptance criterion for Tasks 1 + 2 was
relaxed to "no new typecheck errors in the modified files" with verification
via filtered grep. Migration generation (Task 3) and test execution (Task 4)
are unaffected — drizzle-kit reads schema files directly without typechecking
unrelated source.
