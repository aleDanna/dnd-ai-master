---
phase: 02
plan: 05
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/schema/campaigns.ts
  - src/lib/preferences.ts
  - tests/lib/preferences-vault-mutations.test.ts
autonomous: true
requirements: [REQ-004, REQ-007]
must_haves:
  truths:
    - "CampaignSettings exposes a typed boolean vaultMutations field"
    - "PUT /api/campaigns/[id]/settings with body {vaultMutations: true} validates successfully on a vault-flagged campaign"
    - "PUT /api/campaigns/[id]/settings with body {vaultMutations: 'truthy'} returns 400 with error 'invalid-vaultMutations'"
    - "resolveVaultMutations({masterBackend: 'baked', vaultMutations: true}) returns false (Pitfall 5: orthogonal flags, resolver-level enforcement)"
    - "resolveVaultMutations({masterBackend: 'vault', vaultMutations: true}) returns true"
    - "resolveVaultMutations({masterBackend: 'vault', vaultMutations: undefined}) returns false (opt-in default)"
  artifacts:
    - path: "src/db/schema/campaigns.ts"
      provides: "CampaignSettings.vaultMutations field declaration"
      contains: "vaultMutations"
    - path: "src/lib/preferences.ts"
      provides: "validateSettingsPatch arm + resolveVaultMutations resolver"
      exports: ["resolveVaultMutations"]
    - path: "tests/lib/preferences-vault-mutations.test.ts"
      provides: "Validator + resolver tests"
  key_links:
    - from: "src/lib/preferences.ts"
      to: "src/db/schema/campaigns.ts"
      via: "CampaignSettings type import — adds vaultMutations field"
      pattern: "vaultMutations"
    - from: "src/app/api/sessions/[id]/turn/route.ts (plan 02-08)"
      to: "src/lib/preferences.ts"
      via: "imports resolveVaultMutations to gate apply_event exposure"
      pattern: "resolveVaultMutations"
---

# Plan 02-05: Vault Mutations Opt-In Flag

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 1 (no dependencies — pure data layer)
**Status:** Pending
**Estimated diff size:** ~90 LOC source + ~80 LOC tests / 3 files

## Goal

Extend `CampaignSettings` with a new optional boolean field `vaultMutations?: boolean` (orthogonal to `masterBackend`, per phase Decision 5), wire it through the existing `validateSettingsPatch` validator (same pattern as `masterBackend` from Phase 01 plan 06), and ship a `resolveVaultMutations(settings)` resolver that enforces the Pitfall-5 invariant: `vaultMutations` has no effect when `masterBackend !== 'vault'` (resolver-level — no API breakage; clear semantic).

This is the OPT-IN gate. Phase 02's `apply_event` tool is exposed only when `resolveVaultMutations` returns `true`. Campaigns without the flag continue using the existing Postgres write path (Phase 01 coexistence behavior unchanged).

Mirrors the parallel-shape pattern Phase 01 used for `masterBackend`: the field lives on `CampaignSettings`, NOT on `UserPreferences` (vault mutations are a per-campaign choice, not a global user preference).

## Requirements satisfied

- **REQ-004** Events.md is source of truth — this plan ships the per-campaign opt-in mechanism that turns the event-sourced write path ON. Without this gate, Phase 02 has no way to scope writes to opted-in campaigns.
- **REQ-007** Campaign data outside the repo — the gate ensures only opted-in campaigns write to `VAULT_CAMPAIGNS_ROOT`; non-opted-in campaigns never touch the per-campaign directory tree.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/db/schema/campaigns.ts` | EDIT | Add `vaultMutations?: boolean` field to `CampaignSettings` interface. |
| `src/lib/preferences.ts` | EDIT | Add validator arm + `resolveVaultMutations()` resolver. Extend `getCampaignSettings` Required return shape. |
| `tests/lib/preferences-vault-mutations.test.ts` | NEW | Validator + resolver tests (depends on DATABASE_URL per pre-existing project convention; see Phase 01 SUMMARY line 53). |

## Tasks

<task type="auto">
  <name>Task 1: Add vaultMutations field to CampaignSettings</name>
  <files>src/db/schema/campaigns.ts</files>
  <read_first>
    - src/db/schema/campaigns.ts (lines 28-73 — CampaignSettings interface; lines 65-72 — masterBackend field as the parallel-shape reference)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Decision 5 — orthogonal vaultMutations field; Pitfall 5 — resolver-level enforcement)
    - .planning/phases/01-vault-read-path/plans/06-campaign-settings-flag.md (the masterBackend precedent — mirror exactly)
  </read_first>
  <action>
Edit `src/db/schema/campaigns.ts` (the file already exists; preserve everything else verbatim).

Locate the `CampaignSettings` interface (lines 28-73). Inside the interface, AFTER the `masterBackend?: MasterBackend;` field (the last field), add:

```ts
  /**
   * Phase 02 vault-llm-wiki — per-campaign opt-in for event-sourced
   * mutations. Orthogonal to `masterBackend` (Decision 5): `masterBackend`
   * picks the LLM tool surface (vault vs baked); `vaultMutations` picks
   * whether the vault path is read-only or read-write.
   *
   * Resolution semantics (per Pitfall 5): `vaultMutations` has no effect
   * unless `masterBackend === 'vault'`. The resolver
   * (`resolveVaultMutations` in `src/lib/preferences.ts`) returns `false`
   * for baked campaigns regardless of the stored value, so flipping this
   * on a baked campaign is a no-op until the campaign is also flipped to
   * `masterBackend: 'vault'`.
   *
   *  - undefined (default) → vault is READ-ONLY for game state (Phase 01
   *    behavior preserved)
   *  - false              → same as undefined
   *  - true               → vault path exposes `apply_event` tool;
   *                         mutations land in events.md per spike 010
   *
   * Locked by REQ-004 (events.md source of truth) + REQ-007 (per-campaign
   * dir under VAULT_CAMPAIGNS_ROOT).
   */
  vaultMutations?: boolean;
```

Do NOT change anything else in this file. The change is purely additive — backward-compatible (existing rows have `undefined` which resolves to `false`).
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "vaultMutations" src/db/schema/campaigns.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "vaultMutations" src/db/schema/campaigns.ts` returns ≥ 2 (interface field + JSDoc reference)
    - `pnpm typecheck` exits 0 — confirms no other consumer of `CampaignSettings` broke
    - The field is positioned AFTER `masterBackend` in the interface (maintains lexical proximity to its parent flag)
    - `git diff src/db/schema/campaigns.ts | grep -c '^+'` shows only additive changes (no deletions)
  </acceptance_criteria>
  <done>
    Field added. Plan 02-08 (turn route gate) and plan 02-07 (dispatcher) consume the type via `getCampaignSettings`.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add validator arm + resolveVaultMutations resolver in preferences.ts</name>
  <files>src/lib/preferences.ts</files>
  <read_first>
    - src/lib/preferences.ts (lines 116-130 — resolveMasterBackend reference; lines 563-571 — validateSettingsPatch masterBackend arm; lines 331-387 — getCampaignSettings to extend; lines 263-264 — getResolvedPreferences masterBackend resolution)
    - src/db/schema/campaigns.ts (the updated interface from Task 1)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Pitfall 5 — resolver-level enforcement that vaultMutations has no effect when masterBackend !== 'vault')
  </read_first>
  <action>
Edit `src/lib/preferences.ts` (preserve all existing logic verbatim). Three additive changes:

**Change 1 — Add `resolveVaultMutations` export.** Locate the existing `resolveMasterBackend` function (around line 127). Immediately AFTER its closing brace, add:

```ts
/**
 * Resolves the campaign's vault-mutations opt-in flag.
 *
 * Returns `true` ONLY when both conditions hold:
 *  - `masterBackend === 'vault'` (vault path active for this campaign)
 *  - `vaultMutations === true` (mutations explicitly enabled)
 *
 * Returns `false` in all other cases — including when `masterBackend ===
 * 'baked'` but `vaultMutations: true` is stored (Pitfall 5: orthogonal
 * flags, resolver-level enforcement so the stored value has no effect on
 * a baked campaign). The vault-flip script warns when flipping
 * `vaultMutations: true` on a baked campaign.
 *
 * Phase 02 — locked by Decision 5.
 */
export function resolveVaultMutations(
  settings: { masterBackend?: MasterBackend; vaultMutations?: boolean } | undefined,
): boolean {
  if (!settings) return false;
  const backend = resolveMasterBackend(settings.masterBackend);
  if (backend !== 'vault') return false;
  return settings.vaultMutations === true;
}
```

**Change 2 — Extend `getCampaignSettings` return shape.** Locate the `Required<CampaignSettings>` return at lines 367-386. Inside the returned object literal, AFTER `masterBackend,`, add:

```ts
    vaultMutations: resolveVaultMutations(prefs),
```

This populates the `Required<CampaignSettings>` field consistently with the masterBackend pattern. Callers of `getCampaignSettings(campaignId)` now receive a typed boolean (not `undefined`).

**Change 3 — Add validator arm in `validateSettingsPatch`.** Locate the existing `if ('masterBackend' in body)` block at lines 563-571. Immediately AFTER its closing brace, add:

```ts
  if ('vaultMutations' in body) {
    if (body.vaultMutations === undefined || body.vaultMutations === null) {
      out.vaultMutations = undefined;
    } else if (typeof body.vaultMutations !== 'boolean') {
      return { ok: false, error: 'invalid-vaultMutations' };
    } else {
      out.vaultMutations = body.vaultMutations;
    }
  }
```

**Change 4 — Extend DEFAULT_PREFERENCES.** Locate the `DEFAULT_PREFERENCES` const at lines 154-192. Inside the object, AFTER `masterBackend: 'baked',`, add:

```ts
  // Phase 02 vault-llm-wiki — per-campaign opt-in for event-sourced
  // mutations. Default false (off); orthogonal to masterBackend.
  vaultMutations: false,
```

**Change 5 — Extend getResolvedPreferences.** Locate the `getResolvedPreferences` function's return shape (lines 243-263). After the existing `masterBackend,` line in the return object, add `vaultMutations: prefs.vaultMutations ?? DEFAULT_PREFERENCES.vaultMutations,` — parallel-shape parity with the existing UserPreferences fields. (Note: this is the user-side mirror, not authoritative; campaign-side resolution is in `getCampaignSettings` per Change 2.)

Make sure the type imports near the top include `MasterBackend` (already present at line 8) — no new imports needed.

The UserPreferences interface (declared elsewhere) ALSO needs the field for parallel-shape parity. Locate the `UserPreferences` interface (search the file for `export interface UserPreferences` or look in the schema/users module). If it's defined IN the preferences.ts file (or in a closely-imported schema file), add `vaultMutations?: boolean;` to it — mirroring the masterBackend pattern. If it lives in `src/db/schema/users.ts`, edit that file to add the field. The acceptance check below uses `grep` to confirm.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/lib/preferences-vault-mutations.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "resolveVaultMutations" src/lib/preferences.ts` returns ≥ 4 (declaration + export + usage in getCampaignSettings + JSDoc reference)
    - `grep -c "vaultMutations" src/lib/preferences.ts` returns ≥ 6 (resolver + getCampaignSettings field + validator arm + DEFAULT_PREFERENCES + getResolvedPreferences + invalid-vaultMutations literal)
    - `grep -c "vaultMutations" src/db/schema/users.ts` OR `grep -c "vaultMutations" src/lib/preferences.ts` (UserPreferences arm) returns ≥ 1 (parallel-shape)
    - `pnpm typecheck` exits 0
    - `resolveVaultMutations({masterBackend: 'vault', vaultMutations: true})` returns `true`
    - `resolveVaultMutations({masterBackend: 'baked', vaultMutations: true})` returns `false` (Pitfall 5)
    - `resolveVaultMutations({masterBackend: 'vault', vaultMutations: undefined})` returns `false` (opt-in default)
    - `resolveVaultMutations(undefined)` returns `false`
    - validateSettingsPatch({vaultMutations: 'truthy'}) returns `{ok: false, error: 'invalid-vaultMutations'}`
    - validateSettingsPatch({vaultMutations: true}) returns `{ok: true, patch: {vaultMutations: true}}`
  </acceptance_criteria>
  <done>
    Resolver + validator + default + getCampaignSettings field all wired. Phase 01's masterBackend tests still pass (no regression). Plans 02-07 and 02-08 import `resolveVaultMutations`.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/lib/preferences-vault-mutations.test.ts</name>
  <files>tests/lib/preferences-vault-mutations.test.ts</files>
  <read_first>
    - src/lib/preferences.ts (lines 116-130 — resolveMasterBackend pattern; new resolveVaultMutations from Task 2)
    - tests/lib/preferences-master-backend.test.ts (style reference — DB mock, validator coverage pattern; this is the MOST important model — the new test file mirrors its shape exactly)
    - .planning/phases/01-vault-read-path/SUMMARY.md (line 53 — DATABASE_URL required for this test because it imports from @/lib/preferences)
  </read_first>
  <action>
Create `tests/lib/preferences-vault-mutations.test.ts` (Vitest, mirrors `tests/lib/preferences-master-backend.test.ts` structure).

This test DOES require `DATABASE_URL` to be set (the module imports `db` from `@/db/client`). The Phase 01 convention is to run integration tests with the local Postgres setup. Mock the `db.select()` chain via `vi.mock('@/db/client', ...)` if true DB-free unit tests are preferred — but the simpler path is to follow `preferences-master-backend.test.ts` verbatim (which Phase 01 has working in CI).

Test structure — one top-level `describe('vault-mutations flag')` with these nested describes:

1. **`describe('validateSettingsPatch — vaultMutations arm')`:**
   - `it('accepts true')` → `validateSettingsPatch({vaultMutations: true})` returns `{ok: true, patch: {vaultMutations: true}}`
   - `it('accepts false')` → `validateSettingsPatch({vaultMutations: false})` returns `{ok: true, patch: {vaultMutations: false}}`
   - `it('accepts undefined (clear)')` → `validateSettingsPatch({vaultMutations: undefined})` returns `{ok: true, patch: {vaultMutations: undefined}}`
   - `it('rejects string')` → `validateSettingsPatch({vaultMutations: 'true'})` returns `{ok: false, error: 'invalid-vaultMutations'}`
   - `it('rejects number')` → `validateSettingsPatch({vaultMutations: 1})` returns `{ok: false, error: 'invalid-vaultMutations'}`
   - `it('rejects object')` → `validateSettingsPatch({vaultMutations: {value: true}})` returns `{ok: false, error: 'invalid-vaultMutations'}`
   - `it('does not affect masterBackend arm')` → `validateSettingsPatch({masterBackend: 'vault', vaultMutations: true})` returns `{ok: true, patch: {masterBackend: 'vault', vaultMutations: true}}`

2. **`describe('resolveVaultMutations — Pitfall 5 invariants')`:**
   - `it('returns true when both flags align (vault + true)')` → `expect(resolveVaultMutations({masterBackend: 'vault', vaultMutations: true})).toBe(true)`
   - `it('returns false when baked + vaultMutations:true (Pitfall 5)')` → `expect(resolveVaultMutations({masterBackend: 'baked', vaultMutations: true})).toBe(false)` — THIS IS THE KEY ASSERTION
   - `it('returns false when vault + vaultMutations:false')` → `expect(resolveVaultMutations({masterBackend: 'vault', vaultMutations: false})).toBe(false)`
   - `it('returns false when vault + vaultMutations:undefined (opt-in default)')` → `expect(resolveVaultMutations({masterBackend: 'vault', vaultMutations: undefined})).toBe(false)`
   - `it('returns false when settings undefined')` → `expect(resolveVaultMutations(undefined)).toBe(false)`
   - `it('returns false when settings empty')` → `expect(resolveVaultMutations({})).toBe(false)`
   - `it('respects env MASTER_BACKEND=vault when no stored value')` → use `vi.stubEnv('MASTER_BACKEND', 'vault')` and call `resolveVaultMutations({vaultMutations: true})`. Expected: `true` (env override produces backend='vault'; vaultMutations:true → result true). Restore with `vi.unstubAllEnvs()`.

3. **`describe('getCampaignSettings — vaultMutations resolution')`:**
   - Mock `db.select` chain to return a campaign row with `{settings: {masterBackend: 'vault', vaultMutations: true}}`. Call `getCampaignSettings(uuid)`. Assert `.vaultMutations === true`.
   - Mock `db.select` chain to return `{settings: {masterBackend: 'baked', vaultMutations: true}}`. Assert returned `.vaultMutations === false` (Pitfall 5).
   - Mock `db.select` chain to return `{settings: {}}`. Assert returned `.vaultMutations === false` (default).

Total: 3 describe blocks, ~16 `it` cases.
  </action>
  <verify>
    <automated>pnpm test tests/lib/preferences-vault-mutations.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~16 cases pass
    - `grep -c "resolveVaultMutations" tests/lib/preferences-vault-mutations.test.ts` returns ≥ 7 (six invariant cases + one env override)
    - `grep -c "Pitfall 5" tests/lib/preferences-vault-mutations.test.ts` returns ≥ 1 (test name or comment documents the invariant)
    - The KEY test "returns false when baked + vaultMutations:true" exists and passes (this is THE invariant)
    - `pnpm test` (full suite) still green — no regression in `tests/lib/preferences-master-backend.test.ts` from Phase 01
  </acceptance_criteria>
  <done>
    Tests cover the validator + resolver + getCampaignSettings integration. Plans 02-07 + 02-08 inherit these guarantees.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/lib/preferences-vault-mutations.test.ts` → all cases pass
- Command: `pnpm test tests/lib/preferences-master-backend.test.ts` → still passes (Phase 01 regression check)
- Command: `pnpm typecheck` → clean (CampaignSettings extension does not break any consumer)
- Grep gate: `grep -c "resolveVaultMutations\\|vaultMutations" src/lib/preferences.ts` returns ≥ 6 (all five changes from Task 2)

## Open questions

None — the field shape + resolver semantics are locked by Decision 5 and Pitfall 5.
