---
phase: 03
plan: B-01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/schema/campaigns.ts
  - src/lib/preferences.ts
  - tests/lib/preferences-source-of-truth.test.ts
  - tests/lib/preferences-dual-write.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "CampaignSettings has new fields: sourceOfTruth?: 'postgres' | 'vault'; dualWrite?: boolean; cutoverAt?: string (ISO timestamp)"
    - "src/lib/preferences.ts exports SourceOfTruth type, isSourceOfTruth type guard, resolveSourceOfTruth(stored) resolver, resolveDualWrite(settings) resolver"
    - "resolveSourceOfTruth returns 'postgres' by default; honors stored value; falls back to env MASTER_SOURCE_OF_TRUTH last"
    - "resolveDualWrite returns true ONLY when settings.dualWrite === true (no env override — operator-set per campaign only)"
    - "validateSettingsPatch validates sourceOfTruth (must be 'postgres' or 'vault') and dualWrite (must be boolean)"
    - "DEFAULT_PREFERENCES extended with sourceOfTruth: 'postgres' (default backward-compat) + dualWrite: false"
  artifacts:
    - path: "src/db/schema/campaigns.ts"
      provides: "CampaignSettings.sourceOfTruth + dualWrite + cutoverAt"
      contains: "sourceOfTruth"
    - path: "src/lib/preferences.ts"
      provides: "resolveSourceOfTruth + resolveDualWrite + validator arms + isSourceOfTruth"
      exports: ["SourceOfTruth", "isSourceOfTruth", "resolveSourceOfTruth", "resolveDualWrite"]
    - path: "tests/lib/preferences-source-of-truth.test.ts"
      provides: "Resolver + validator tests for sourceOfTruth"
    - path: "tests/lib/preferences-dual-write.test.ts"
      provides: "Resolver + validator tests for dualWrite"
  key_links:
    - from: "src/sessions/client-snapshot.ts (plan 03-B-07)"
      to: "src/lib/preferences.ts (resolveSourceOfTruth)"
      via: "Reads decide vault vs Postgres source"
      pattern: "resolveSourceOfTruth"
    - from: "src/app/api/sessions/[id]/turn/route.ts (plan 03-A-10)"
      to: "src/lib/preferences.ts (resolveDualWrite)"
      via: "Gate dual-write fan-out"
      pattern: "resolveDualWrite"
---

# Plan 03-B-01: sourceOfTruth + dualWrite Settings Fields

**Phase:** 03-migration-cutover
**Wave:** 1 (no deps)
**Status:** Pending
**Estimated diff size:** ~150 LOC source + ~200 LOC tests / 4 files

## Goal

Add two new `CampaignSettings` fields (`sourceOfTruth: 'postgres' | 'vault'` + `dualWrite: boolean`) plus an audit-only `cutoverAt: string` (ISO timestamp), wire them into `src/lib/preferences.ts` via the parallel-shape resolver pattern Phase 01 used for `masterBackend` and Phase 02 used for `vaultMutations`.

This is the FLAG that plan 03-A-10 (dual-write gate), plan 03-B-02 (cutover script), and plan 03-B-07 (snapshot read pivot) all consume.

**Design constraints:**
- `sourceOfTruth` defaults to `'postgres'` for backward compatibility (Phase 02 behavior).
- `sourceOfTruth: 'vault'` requires PRECONDITIONS: `masterBackend === 'vault'` AND `vaultMutations === true`. The resolver does NOT enforce this — the `vault:cutover` script (plan 03-B-02) does, with a clear operator error.
- `dualWrite` is an INDEPENDENT flag (orthogonal to sourceOfTruth). It can be true with sourceOfTruth='postgres' (during the migration window: writes go to both stores, reads stay on Postgres until cutover) OR true with sourceOfTruth='vault' (post-cutover rollback window: writes still go to both stores so Postgres can be a rollback target).
- The valid state machine:
  ```
  Phase 02 baseline       → masterBackend=baked or vault; vaultMutations=false or true; sourceOfTruth=postgres; dualWrite=false
  03-A migration done     → masterBackend=vault; vaultMutations=true; sourceOfTruth=postgres; dualWrite=true   (writes converge)
  03-B cutover done       → masterBackend=vault; vaultMutations=true; sourceOfTruth=vault;    dualWrite=true   (reads pivot, writes still converge)
  Post-rollback-window    → masterBackend=vault; vaultMutations=true; sourceOfTruth=vault;    dualWrite=false  (Phase 04)
  ```

## Requirements satisfied

- **REQ-006** — Cutover flag is the on/off switch for reads pivoting to vault. Required for the full DR procedure (vault = source).

## Files touched

| File | Action | Why |
|---|---|---|
| `src/db/schema/campaigns.ts` | EDIT | Add fields to CampaignSettings |
| `src/lib/preferences.ts` | EDIT | Resolvers + validators + defaults |
| `tests/lib/preferences-source-of-truth.test.ts` | NEW | Resolver tests |
| `tests/lib/preferences-dual-write.test.ts` | NEW | Resolver tests |

## Tasks

<task type="auto">
  <name>Task 1: Add sourceOfTruth + dualWrite + cutoverAt to CampaignSettings</name>
  <files>src/db/schema/campaigns.ts</files>
  <read_first>
    - src/db/schema/campaigns.ts (existing CampaignSettings — masterBackend Phase 01 + vaultMutations Phase 02 patterns to mirror)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Decision 4 + 5)
  </read_first>
  <action>
Edit `src/db/schema/campaigns.ts`. Add new fields at the END of the `CampaignSettings` interface (AFTER `vaultMutations`):

```ts
  /**
   * Phase 03-B vault-llm-wiki — cutover semantics (Decision 4). Selects
   * which store is the SOURCE OF TRUTH for snapshot reads.
   *  - 'postgres' (default) → buildClientSnapshot reads session_state + characters
   *  - 'vault'              → buildClientSnapshot materializes from events.md replay
   *
   * Preconditions (enforced by scripts/vault-cutover.ts, NOT the resolver):
   *   - masterBackend === 'vault'
   *   - vaultMutations === true
   *
   * State machine (Phase 03):
   *   Pre-migration:    sourceOfTruth=postgres, dualWrite=false
   *   03-A migration:   sourceOfTruth=postgres, dualWrite=true  (writes converge)
   *   03-B cutover:     sourceOfTruth=vault,    dualWrite=true  (reads pivot)
   *   Post-rollback:    sourceOfTruth=vault,    dualWrite=false (Phase 04)
   */
  sourceOfTruth?: 'postgres' | 'vault';

  /**
   * Phase 03-A vault-llm-wiki — dual-write coexistence (Decision 2). When
   * true, every apply_event tool call writes to BOTH events.md AND the
   * Postgres engine state, then runs a synchronous parity-check. Used
   * during the coexistence window to validate convergence before cutover.
   *
   * Orthogonal to sourceOfTruth — can be true with either value:
   *  - sourceOfTruth=postgres, dualWrite=true → writes converge, reads stay PG
   *  - sourceOfTruth=vault,    dualWrite=true → writes converge, reads from vault (rollback safety net)
   *
   * Defaults to false (Phase 02 single-write path).
   */
  dualWrite?: boolean;

  /**
   * Phase 03-B audit — ISO timestamp of the most recent sourceOfTruth flip
   * to 'vault'. Used by scripts/vault-cutover.ts to enforce the
   * CUTOVER_ROLLBACK_HOURS reversibility window. Read-only outside the
   * cutover script.
   */
  cutoverAt?: string;
```

The fields are all optional — backward-compatible.
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "sourceOfTruth\\|dualWrite\\|cutoverAt" src/db/schema/campaigns.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0 (no consumer of CampaignSettings broke)
    - `grep -c "sourceOfTruth\\|dualWrite\\|cutoverAt" src/db/schema/campaigns.ts` returns >= 3
    - Fields are positioned AFTER vaultMutations (Phase 02 field order preserved)
    - JSDoc cross-references plan 03-B-02 cutover script + plan 03-A-10 dispatch gate
  </acceptance_criteria>
  <done>
    Schema extended. Task 2 adds resolvers + validators.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add resolvers + validators + defaults to src/lib/preferences.ts</name>
  <files>src/lib/preferences.ts</files>
  <read_first>
    - src/lib/preferences.ts (existing — resolveMasterBackend + resolveVaultMutations as parallel-shape references; validateSettingsPatch arms for masterBackend + vaultMutations; DEFAULT_PREFERENCES)
    - src/db/schema/campaigns.ts (Task 1 — extended CampaignSettings)
  </read_first>
  <action>
Edit `src/lib/preferences.ts`. Five additive changes:

**Change 1 — Add SourceOfTruth type + guard.** After `MasterBackend`/`isMasterBackend` (around line 127):

```ts
export type SourceOfTruth = 'postgres' | 'vault';

export function isSourceOfTruth(v: unknown): v is SourceOfTruth {
  return v === 'postgres' || v === 'vault';
}

function envDefaultSourceOfTruth(): SourceOfTruth {
  const raw = (process.env.MASTER_SOURCE_OF_TRUTH ?? '').trim().toLowerCase();
  return raw === 'vault' ? 'vault' : 'postgres';
}

export function resolveSourceOfTruth(stored: SourceOfTruth | undefined): SourceOfTruth {
  if (stored === 'postgres' || stored === 'vault') return stored;
  return envDefaultSourceOfTruth();
}
```

**Change 2 — Add resolveDualWrite.** After resolveSourceOfTruth:

```ts
export function resolveDualWrite(settings: { dualWrite?: boolean } | undefined): boolean {
  if (!settings) return false;
  return settings.dualWrite === true;
}
```

(No env override — dual-write is operator-set per campaign only. Env override would risk accidental global enablement.)

**Change 3 — Extend DEFAULT_PREFERENCES.** After `vaultMutations: false`:

```ts
  sourceOfTruth: 'postgres',
  dualWrite: false,
```

**Change 4 — Add validator arms in validateSettingsPatch.** After the `vaultMutations` arm:

```ts
  if ('sourceOfTruth' in body) {
    if (body.sourceOfTruth === undefined || body.sourceOfTruth === null) {
      out.sourceOfTruth = undefined;
    } else if (!isSourceOfTruth(body.sourceOfTruth)) {
      return { ok: false, error: 'invalid-sourceOfTruth' };
    } else {
      out.sourceOfTruth = body.sourceOfTruth;
    }
  }
  if ('dualWrite' in body) {
    if (body.dualWrite === undefined || body.dualWrite === null) {
      out.dualWrite = undefined;
    } else if (typeof body.dualWrite !== 'boolean') {
      return { ok: false, error: 'invalid-dualWrite' };
    } else {
      out.dualWrite = body.dualWrite;
    }
  }
  if ('cutoverAt' in body) {
    if (body.cutoverAt === undefined || body.cutoverAt === null) {
      out.cutoverAt = undefined;
    } else if (typeof body.cutoverAt !== 'string' || isNaN(Date.parse(body.cutoverAt))) {
      return { ok: false, error: 'invalid-cutoverAt' };
    } else {
      out.cutoverAt = body.cutoverAt;
    }
  }
```

**Change 5 — Extend getCampaignSettings return shape.** Add the new fields to the Required<CampaignSettings> return after vaultMutations:

```ts
    sourceOfTruth: resolveSourceOfTruth(prefs.sourceOfTruth),
    dualWrite: resolveDualWrite(prefs),
    cutoverAt: prefs.cutoverAt,
```

Add corresponding parallel-shape on UserPreferences if such a mirror exists (mirror the Phase 02 vault-mutations precedent — check Phase 02 plan 02-05 Change 5 for the pattern).
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/lib/preferences-master-backend.test.ts tests/lib/preferences-vault-mutations.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "resolveSourceOfTruth\\|resolveDualWrite\\|SourceOfTruth\\|isSourceOfTruth" src/lib/preferences.ts` returns >= 4
    - Phase 01 + Phase 02 preferences tests still pass
    - The new resolvers match the parallel-shape exactly (style and signature)
  </acceptance_criteria>
  <done>
    Resolvers + validators ship. Tasks 3+4 add tests.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/lib/preferences-source-of-truth.test.ts</name>
  <files>tests/lib/preferences-source-of-truth.test.ts</files>
  <read_first>
    - tests/lib/preferences-master-backend.test.ts (Phase 01 — the parallel-shape resolver test pattern; env stubbing; validator pos+neg cases)
    - src/lib/preferences.ts (Task 2)
  </read_first>
  <action>
Create `tests/lib/preferences-source-of-truth.test.ts`. Mirror the Phase 01 `preferences-master-backend.test.ts` structure verbatim — same case layout, just for sourceOfTruth.

Required cases:
- isSourceOfTruth: returns true for 'postgres' + 'vault'; false for everything else
- resolveSourceOfTruth(undefined) returns 'postgres' (default) when env unset
- resolveSourceOfTruth(undefined) returns 'vault' when MASTER_SOURCE_OF_TRUTH=vault
- resolveSourceOfTruth('postgres'/'vault') returns the stored value (ignores env)
- validateSettingsPatch with `sourceOfTruth: 'postgres'` → ok:true
- validateSettingsPatch with `sourceOfTruth: 'vault'` → ok:true
- validateSettingsPatch with `sourceOfTruth: 'invalid'` → ok:false, error:'invalid-sourceOfTruth'
- validateSettingsPatch with `sourceOfTruth: null` → out.sourceOfTruth: undefined
- validateSettingsPatch with `sourceOfTruth: undefined` → out.sourceOfTruth: undefined
- validateSettingsPatch with `cutoverAt: 'invalid-date'` → ok:false, error:'invalid-cutoverAt'
- validateSettingsPatch with `cutoverAt: '2026-05-26T12:00:00Z'` → ok:true

Aim for ~12-15 cases.
  </action>
  <verify>
    <automated>pnpm test tests/lib/preferences-source-of-truth.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass
    - Test mirrors the Phase 01 preferences-master-backend.test.ts structure (`grep -c "describe\\|it(" tests/lib/preferences-source-of-truth.test.ts` >= 15)
    - The env-override case proves MASTER_SOURCE_OF_TRUTH works
  </acceptance_criteria>
  <done>
    Resolver tested.
  </done>
</task>

<task type="auto">
  <name>Task 4: Write tests/lib/preferences-dual-write.test.ts</name>
  <files>tests/lib/preferences-dual-write.test.ts</files>
  <read_first>
    - tests/lib/preferences-vault-mutations.test.ts (Phase 02 — the parallel-shape resolver test pattern)
    - src/lib/preferences.ts (Task 2)
  </read_first>
  <action>
Create `tests/lib/preferences-dual-write.test.ts`. Mirror the Phase 02 `preferences-vault-mutations.test.ts` structure.

Required cases:
- resolveDualWrite(undefined) returns false
- resolveDualWrite({}) returns false
- resolveDualWrite({ dualWrite: true }) returns true
- resolveDualWrite({ dualWrite: false }) returns false
- resolveDualWrite({ dualWrite: 'yes' as unknown as boolean }) returns false (defensive)
- validateSettingsPatch with `dualWrite: true` → ok:true
- validateSettingsPatch with `dualWrite: 'true' as unknown as boolean` → ok:false, error:'invalid-dualWrite'
- validateSettingsPatch with `dualWrite: null` → out.dualWrite: undefined
- validateSettingsPatch with `dualWrite: undefined` → out.dualWrite: undefined

(Note: dualWrite has NO env override — different from sourceOfTruth — so no env-stubbing cases needed.)
  </action>
  <verify>
    <automated>pnpm test tests/lib/preferences-dual-write.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass
    - The defensive cases (non-boolean dualWrite) pass without false-positives
    - `grep -c "describe\\|it(" tests/lib/preferences-dual-write.test.ts` >= 10
  </acceptance_criteria>
  <done>
    DualWrite resolver tested.
  </done>
</task>
