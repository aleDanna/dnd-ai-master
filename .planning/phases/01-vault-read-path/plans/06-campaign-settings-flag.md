# Plan 06: Campaign Settings `masterBackend` Flag

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** none (pure data-layer addition)
**Estimated diff size:** ~85 LOC source + ~60 LOC tests / 5 files (added users.ts edit for parallel-shape)

## Goal

Add `masterBackend: 'vault' | 'baked'` to the `CampaignSettings` interface (no DB migration — `campaigns.settings` is JSONB, additive fields are safe). Wire it through `preferences.ts` resolution order so a campaign can opt in to the vault path. Plumb it through `validateSettingsPatch` so the existing `PUT /api/campaigns/[id]/settings` route accepts it. Plumb it through the API allow-list in `src/app/api/campaigns/[id]/settings/route.ts`. The flag is consumed by plan 07 (the route branch).

The default is `'baked'` — every existing campaign keeps its current behaviour byte-for-byte. Env-level fallback `MASTER_BACKEND` is the ops/CI override for testing the vault path without touching DB rows.

This plan does NOT add a UI toggle. The flag is settable via the existing `PUT /api/campaigns/[id]/settings` route (sufficient for dev + Phase 02 to layer a UI later) and by direct DB update on the dev box for live smoke testing. Surface-in-UI is explicitly deferred (PLAN.md "What this phase does NOT do").

## Requirements satisfied

- **Feature-flag delivery vehicle** for the vault path. No specific REQ number maps to "ship the flag" — but the flag is the gate that lets REQ-001..REQ-014 + REQ-021 + REQ-022 + REQ-030 light up on a campaign without disrupting the baked path that satisfies the same REQs today.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/db/schema/campaigns.ts` | EDIT | Add `masterBackend?: MasterBackend` field to `CampaignSettings`. Export `MasterBackend` type + `isMasterBackend` guard. |
| `src/db/schema/users.ts` | EDIT | Add `masterBackend?: MasterBackend` to `UserPreferences` (parallel-shape pattern, mirrors `compactPrompt`/`useRagRetrieval`). Resolution stays campaign-only — this field is shape parity, not behavioural. |
| `src/lib/preferences.ts` | EDIT | Add `masterBackend` to `getCampaignSettings` resolved output; add resolver `resolveMasterBackend()` (campaign → env → default). Add validator branch to `validateSettingsPatch`. Update `DEFAULT_PREFERENCES` to include `masterBackend: 'baked'`. |
| `src/app/api/campaigns/[id]/settings/route.ts` | EDIT | Add `'masterBackend'` to `ALLOWED_KEYS`. |
| `tests/lib/preferences-master-backend.test.ts` | NEW | Validator + resolution-order tests. |

## Tasks

1. **Edit `src/db/schema/campaigns.ts`.** Above the existing `CampaignSettings` interface, define:
   ```
   export type MasterBackend = 'vault' | 'baked';
   export function isMasterBackend(v: unknown): v is MasterBackend {
     return v === 'vault' || v === 'baked';
   }
   ```
   Append to `CampaignSettings`:
   ```
     /**
      * Phase 01 feature flag (vault-llm-wiki migration). Selects which
      * knowledge backend the master uses for this campaign.
      *  - 'baked' (default) → existing baked variant + RAG path (system_prompt.ts → tool-loop.ts → engine tools)
      *  - 'vault'           → markdown-vault path (vault/prompt-builder.ts → vault/loop.ts → vault tools, NO engine tools)
      * When 'vault', game-state mutation is unavailable (Phase 02 adds apply_event).
      */
     masterBackend?: MasterBackend;
   ```
   No DB migration needed — the column is `jsonb` and `default '{}'::jsonb`; additive optional fields are read as `undefined`.

2. **Edit `src/lib/preferences.ts`.**
   - Re-export `MasterBackend` and `isMasterBackend` for downstream callers (turn route in plan 07).
   - Add a top-of-file helper:
     ```
     function envDefaultMasterBackend(): MasterBackend {
       const raw = (process.env.MASTER_BACKEND ?? '').trim().toLowerCase();
       return raw === 'vault' ? 'vault' : 'baked';
     }
     export function resolveMasterBackend(stored: MasterBackend | undefined): MasterBackend {
       if (stored === 'vault' || stored === 'baked') return stored;
       return envDefaultMasterBackend();
     }
     ```
     The resolution order is exactly: campaign value (when explicitly stored) → env `MASTER_BACKEND` → `'baked'`. There is no user-preference layer (Decision 2 in PLAN.md — campaign-only).
   - In `getCampaignSettings`, after the existing `useRagRetrieval` resolution, add:
     ```
     const masterBackend = resolveMasterBackend(prefs.masterBackend);
     ```
     Add `masterBackend` to the returned object. Update the function's return type — `Required<CampaignSettings>` already requires the field once it's added to the interface; if TypeScript complains, the fix is to set `masterBackend` from the resolver (it always returns a defined value).
   - In `validateSettingsPatch`, add an arm:
     ```
     if ('masterBackend' in body) {
       if (body.masterBackend === undefined || body.masterBackend === null) {
         out.masterBackend = undefined;
       } else if (!isMasterBackend(body.masterBackend)) {
         return { ok: false, error: 'invalid-masterBackend' };
       } else {
         out.masterBackend = body.masterBackend;
       }
     }
     ```
     Placement: just after the `useRagRetrieval` arm (preserves alphabetical-by-concept ordering in the existing function).
   - `getSessionMasterPreferences` returns `{ ...camp, ttsAutoplay: false }` typed as `Required<UserPreferences>` (`preferences.ts:257-268`). Since `camp` is `Required<CampaignSettings>` and includes `masterBackend: MasterBackend` after task 1, the spread will require `UserPreferences` to have the field too (TypeScript will reject the spread otherwise — `Required<UserPreferences>` cannot tolerate an extra concrete-typed field). Task 1a (new, below) fixes this.

   **1a. Edit `src/db/schema/users.ts`.** Add `masterBackend?: MasterBackend` to `UserPreferences`. Re-import `MasterBackend` from `./campaigns` at the top of the file. Mirrors the existing parallel-shape pattern where `compactPrompt` and `useRagRetrieval` appear on both interfaces. Resolution semantics remain campaign-only — the field on `UserPreferences` exists for shape parity only, never read directly by code (Decision 2 in PLAN.md).

   **1b. Update `DEFAULT_PREFERENCES` in `preferences.ts:130-163`.** Add `masterBackend: 'baked' as MasterBackend` to keep the default-prefs surface complete. This is the user-side default; the campaign-side default is in `getCampaignSettings`.

   **Why NOT `masterBackend?: never`:** declaring a field as `never` says "this field must NEVER be present with any value." The spread `{ ...camp, ttsAutoplay: false }` would assign a concrete `MasterBackend` value to a field declared `never` → TypeScript compile error. The defensive hint is wrong. Parallel-shape (task 1a) is the validated pattern.

3. **Edit `src/app/api/campaigns/[id]/settings/route.ts`.** Append `'masterBackend'` to `ALLOWED_KEYS` (line 32-area). This is the one-line wiring that lets the existing `PUT` accept the new field.

4. **Create `tests/lib/preferences-master-backend.test.ts`.** Cases (using vitest, mirroring `tests/sessions/*.test.ts` style):
   - **Default:** `resolveMasterBackend(undefined)` (with no env set) → `'baked'`.
   - **Env override:** mock `process.env.MASTER_BACKEND = 'vault'` (use `vi.stubEnv`); `resolveMasterBackend(undefined)` → `'vault'`. Restore env after.
   - **Stored wins over env:** with env `MASTER_BACKEND=vault`, `resolveMasterBackend('baked')` → `'baked'`.
   - **Invalid env value falls back:** `vi.stubEnv('MASTER_BACKEND', 'turbo')` → resolver returns `'baked'`.
   - **`isMasterBackend` guard:** true for `'vault'`, `'baked'`; false for `'vauLT'`, `null`, `undefined`, `123`.
   - **`validateSettingsPatch` accepts `'vault'`:** call with `{ masterBackend: 'vault' }` → `{ ok: true, patch: { masterBackend: 'vault' } }`.
   - **`validateSettingsPatch` accepts `'baked'`:** same.
   - **`validateSettingsPatch` rejects invalid:** `{ masterBackend: 'turbo' }` → `{ ok: false, error: 'invalid-masterBackend' }`.
   - **`validateSettingsPatch` accepts undefined-clear:** `{ masterBackend: undefined }` → `{ ok: true, patch: { masterBackend: undefined } }` (lets the user clear the field back to default).
   - **`getCampaignSettings` returns `'baked'` for a fresh campaign** — integration-style test using the existing test-db helpers (if not available, mock the `db.select` chain). Optional if test-db setup is heavy; the validator + resolver tests above are the load-bearing coverage.

5. **No imports of `masterBackend` into the turn route in this plan.** Plan 07 wires the consumer side. This plan is data-layer only — it can land independently and the existing baked path is unaffected (the new field exists but is never read until plan 07).

## Verification

- Command: `pnpm test tests/lib/preferences-master-backend.test.ts` → all cases pass.
- Command: `pnpm typecheck` → clean (the new field threads through `CampaignSettings` and `validateSettingsPatch`).
- Behaviour (manual): `curl -X PUT http://localhost:3000/api/campaigns/<id>/settings -H 'content-type: application/json' -d '{"masterBackend":"vault"}'` → 200 OK (with appropriate auth). Then `GET /api/campaigns/<id>/settings` → response body contains `masterBackend: 'vault'`.
- Grep gate: `grep -n "masterBackend" src/lib/preferences.ts | wc -l` → at least 5 occurrences (export, helper, resolver call, validator branch, return field).
- Existing tests: full `pnpm test` suite still passes — no regression in `tests/sessions/`, `tests/ai/`, etc.

## Open questions

None. The campaign-only flag location is Decision 2 in PLAN.md. The env-fallback semantics mirror the existing `compactPrompt`/`useRagRetrieval` pattern (no precedent for user-prefs-only flags in this codebase; every "shared decision" is campaign-scoped per `getSessionMasterPreferences`'s contract).
