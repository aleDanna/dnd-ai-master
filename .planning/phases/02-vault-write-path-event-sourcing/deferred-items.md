# Phase 02 Deferred Items

## Discovered during Plan 02-06 (tool-loop-cap-bump)

### Pre-existing typecheck error in `src/lib/preferences.ts:367`

**Status:** OUT-OF-SCOPE for Plan 02-06 (logged per executor scope-boundary rule).

**Error:**
```
src/lib/preferences.ts(367,3): error TS2741: Property 'vaultMutations' is missing in
type '{ ttsProvider: ... }' but required in type 'Required<CampaignSettings>'.
```

**Source:** Introduced by Plan 02-04 (`feat(phase-02): add vaultMutations field to CampaignSettings`, commit `bd890c4`) — the `CampaignSettings` interface gained `vaultMutations` but the default-preferences literal in `src/lib/preferences.ts` was not updated to include the new field.

**Verification it is pre-existing:** confirmed by `git stash && pnpm typecheck` on the bare HEAD before any Plan 02-06 edits — the error reproduces.

**Recommended owner:** a follow-up plan within Phase 02 (or a hotfix commit to Plan 02-04 if scope allows). The fix is one line in `src/lib/preferences.ts` to add `vaultMutations: false` to the defaults object.

**Why not auto-fixed here:** Plan 02-06's scope is `src/sessions/types.ts`, `src/ai/master/vault/loop.ts`, and `tests/sessions/turn-tool-call-cap.test.ts` (see `<contract>` in the executor prompt and `files_modified` in the plan frontmatter). The defaults-object error in `preferences.ts` is unrelated to the cap-bump and pre-dates Plan 02-06.
