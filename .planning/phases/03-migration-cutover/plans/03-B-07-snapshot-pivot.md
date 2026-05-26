---
phase: 03
plan: B-07
type: execute
wave: 5
depends_on: [03-B-01, 03-B-06]
files_modified:
  - src/sessions/client-snapshot.ts
  - tests/sessions/client-snapshot-pivot.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "buildClientSnapshot resolves campaign.settings.sourceOfTruth via resolveSourceOfTruth"
    - "When sourceOfTruth === 'vault' AND the viewer's character is set, buildClientSnapshot calls materializeFromVault(campaign.id, viewerCharacterId, sessionId) and uses the result as the `state` field of the returned snapshot"
    - "When materializeFromVault returns null (events.md missing OR character not in seed), buildClientSnapshot falls back to the Postgres read (same as sourceOfTruth='postgres')"
    - "When sourceOfTruth === 'postgres' (default), buildClientSnapshot reads from sessionState directly (Phase 02 behavior preserved)"
    - "The returned snapshot shape is unchanged — UI consumers see the same fields whether the source is Postgres or vault"
    - "Phase 01 + Phase 02 tests for buildClientSnapshot still pass (no regression)"
  artifacts:
    - path: "src/sessions/client-snapshot.ts"
      provides: "buildClientSnapshot with sourceOfTruth pivot branch"
      contains: "resolveSourceOfTruth"
    - path: "tests/sessions/client-snapshot-pivot.test.ts"
      provides: "Pivot behavior tests + fallback-on-missing test"
  key_links:
    - from: "src/sessions/client-snapshot.ts (buildClientSnapshot)"
      to: "src/ai/master/vault/snapshot-reader.ts (materializeFromVault)"
      via: "Conditional call when sourceOfTruth === 'vault'"
      pattern: "materializeFromVault"
    - from: "src/sessions/client-snapshot.ts (buildClientSnapshot)"
      to: "src/lib/preferences.ts (resolveSourceOfTruth)"
      via: "Decision point for branch selection"
      pattern: "resolveSourceOfTruth"
---

# Plan 03-B-07: buildClientSnapshot Pivot

**Phase:** 03-migration-cutover
**Wave:** 5 (depends on 03-B-01 flag + 03-B-06 reader)
**Status:** Pending
**Estimated diff size:** ~100 LOC source + ~250 LOC tests / 2 files

## Goal

Modify `buildClientSnapshot` (the function called by `/api/sessions/[id]/stream` SSE init + `/api/sessions/[id]` GET) so that when `campaign.settings.sourceOfTruth === 'vault'`, it materializes `state` from vault events.md instead of reading `session_state` from Postgres. UI consumers see no shape change.

Per RESEARCH §3.4: this is the read pivot — the cutover step's behavioral consequence. After plan 03-B-02 flips the flag, this branch fires on every snapshot read.

**Fallback safety:** if `materializeFromVault` returns null (events.md missing OR character not in seed — e.g., a campaign that hasn't been bulk-migrated yet but somehow has `sourceOfTruth=vault`), the function falls back to Postgres so the UI doesn't break. The vault-cutover script (plan 03-B-02) prevents this state, but defensive fallback is cheap insurance.

## Requirements satisfied

- **REQ-006** — Closes the snapshot-read half of the cutover. Vault is now the read source.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/sessions/client-snapshot.ts` | EDIT | Add the pivot branch |
| `tests/sessions/client-snapshot-pivot.test.ts` | NEW | Pivot behavior tests |

## Tasks

<task type="auto">
  <name>Task 1: Add sourceOfTruth pivot to buildClientSnapshot</name>
  <files>src/sessions/client-snapshot.ts</files>
  <read_first>
    - src/sessions/client-snapshot.ts (existing — buildClientSnapshot function; the state SELECT location; the campaign + viewerCharacter resolution)
    - src/lib/preferences.ts (plan 03-B-01 — resolveSourceOfTruth)
    - src/ai/master/vault/snapshot-reader.ts (plan 03-B-06 — materializeFromVault)
  </read_first>
  <action>
Edit `src/sessions/client-snapshot.ts`. Locate the Postgres state SELECT (currently `const [state] = await db.select().from(sessionState).where(...)`).

Add imports at the top:
```ts
import { resolveSourceOfTruth } from '@/lib/preferences';
import { materializeFromVault } from '@/ai/master/vault/snapshot-reader';
```

Replace the state-read block with the pivot:

```ts
// Phase 03-B (Decision 4) — sourceOfTruth pivot
let state: SessionStateRow | null = null;
const sourceOfTruth = resolveSourceOfTruth(campaign?.settings?.sourceOfTruth);
const viewerCharId = character?.id;

if (sourceOfTruth === 'vault' && campaign && viewerCharId) {
  try {
    const vaultState = await materializeFromVault(campaign.id, viewerCharId, sessionId);
    if (vaultState) {
      // The translator returns a Partial<SessionState>; ensure the shape
      // matches SessionStateRow (the row-typed projection used downstream).
      state = vaultState as SessionStateRow;
    }
  } catch (e) {
    console.warn('[client-snapshot] vault materialization failed, falling back to Postgres:', e instanceof Error ? e.message : e);
  }
}

if (!state) {
  // Default (sourceOfTruth='postgres') OR vault fallback
  [state] = await db
    .select()
    .from(sessionState)
    .where(eq(sessionState.sessionId, sessionId))
    .limit(1);
}
```

Critical: the rest of the function (the returned snapshot shape, the dice/messages reads, etc.) is UNCHANGED. The pivot only affects the `state` field.

If `SessionStateRow` is not the exact type name (it might be just `typeof sessionState.$inferSelect`), use the actual type. The translator returns Partial<SessionState> from plan 03-B-06; cast carefully or restructure to match.
  </action>
  <verify>
    <automated>pnpm typecheck && pnpm test tests/sessions/</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "resolveSourceOfTruth\\|materializeFromVault" src/sessions/client-snapshot.ts` returns >= 2
    - Existing Phase 01 + 02 tests in tests/sessions/ still pass
    - The fallback branch executes when materializeFromVault returns null
    - Snapshot shape unchanged (UI consumer types still resolve)
  </acceptance_criteria>
  <done>
    Pivot wired. Task 2 tests it.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write tests/sessions/client-snapshot-pivot.test.ts</name>
  <files>tests/sessions/client-snapshot-pivot.test.ts</files>
  <read_first>
    - src/sessions/client-snapshot.ts (Task 1)
    - tests/ai/master/vault/snapshot-reader.test.ts (plan 03-B-06 — vault seeding pattern)
    - tests/sessions/vault-mutations-gate.test.ts (Phase 02 — campaign fixture pattern)
  </read_first>
  <action>
Create `tests/sessions/client-snapshot-pivot.test.ts`. DB-gated (DATABASE_URL required).

Cases:
1. **sourceOfTruth='postgres' (default)** → state read from session_state (the existing Phase 02 path)
2. **sourceOfTruth='vault' + events.md exists + character in seed** → state from materializeFromVault
3. **sourceOfTruth='vault' but events.md MISSING** → fallback to Postgres (no error)
4. **sourceOfTruth='vault' but character NOT in seed** → fallback to Postgres
5. **sourceOfTruth='vault' + viewer has NO character** → fallback to Postgres
6. **After cutover, hp_current differs between Postgres (stale) and vault (current)** → snapshot returns the vault value (proves the pivot works end-to-end)
7. **Snapshot shape unchanged** — same fields whether path is vault or Postgres

```ts
(HAS_DB ? describe : describe.skip)('buildClientSnapshot — sourceOfTruth pivot', () => {
  let TEST_VAULT_ROOT: string;
  let TEST_CAMPAIGN_ID: string;
  let TEST_SESSION_ID: string;
  let TEST_CHAR_ID: string;
  let TEST_USER_ID: string;

  beforeAll(/* fixture setup */);
  afterAll(/* cleanup */);

  it('default sourceOfTruth=postgres reads from session_state', async () => {
    // Set hp_current in session_state = 25
    // Confirm campaign.settings has no sourceOfTruth field
    // Call buildClientSnapshot
    // Assert state.hpCurrent === 25 (Postgres value)
  });

  it('sourceOfTruth=vault uses vault materialization', async () => {
    // Set campaign.settings.sourceOfTruth = 'vault'
    // Seed vault with hp_current=20 (different from Postgres)
    // Call buildClientSnapshot
    // Assert state.hpCurrent === 20 (vault value)
  });

  it('sourceOfTruth=vault with no events.md falls back to Postgres', async () => {
    // Set sourceOfTruth=vault but DELETE events.md
    // ...
    // Assert state.hpCurrent matches Postgres
  });

  it('shape unchanged across paths', async () => {
    // Get snapshot via postgres path; get snapshot via vault path
    // Assert both have the same field set (Object.keys equality)
  });

  // ... more cases ...
});
```
  </action>
  <verify>
    <automated>pnpm test tests/sessions/client-snapshot-pivot.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass when DATABASE_URL set
    - The pivot case (test 2) proves vault value is returned
    - The fallback cases (3, 4, 5) prove defensive correctness
    - The shape-unchanged case proves UI compat
    - Test runtime < 20s
  </acceptance_criteria>
  <done>
    Snapshot pivot end-to-end. Sub-phase 03-B complete.
  </done>
</task>
