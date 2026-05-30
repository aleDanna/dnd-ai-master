# Phase 09 — Deferred Items

Out-of-scope discoveries logged during execution (not fixed — outside the touching plan's scope).

## Pre-existing test failures (discovered during 09-02 full-suite run, 2026-05-30)

These 4 tests fail on the full `npx vitest run` but are unrelated to v2 monster turns and were NOT introduced by Phase 09 work. The 09-02 commits (`b1c9fbc`, `b06b6c5`) add only `monster-turns.ts` + its test (verified: no deletions, no edits to any other file). Logged here per the executor scope-boundary rule; do NOT fix as part of Phase 09 combat plans.

| Test file | Failing case | Notes |
|-----------|--------------|-------|
| `tests/sessions/applicator.test.ts` | `applyMutations > add_inventory + remove_inventory + set_equipped` (gp-stack qty 60 vs 50) | Inventory, last touched by `7ad8533` (pre-Phase-08). Already logged in `08/deferred-items.md`. |
| `tests/api/scene-image-coalesce.test.ts` | `coalesces concurrent calls > only calls the image provider once` | Concurrency/provider-coalescing — environment-sensitive, not combat. |
| `tests/api/tts-coalesce.test.ts` | `coalesces concurrent calls > only calls the provider once` | Concurrency/provider-coalescing — environment-sensitive, not combat. |
| `tests/lib/preferences-local-validation.test.ts` | `local provider gating > rejects aiProvider=local when not local environment` | Env-gating test — depends on environment detection, not combat. |
