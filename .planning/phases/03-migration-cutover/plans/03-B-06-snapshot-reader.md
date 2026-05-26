---
phase: 03
plan: B-06
type: execute
wave: 5
depends_on: [03-A-02, 03-A-03]
files_modified:
  - src/ai/master/vault/snapshot-reader.ts
  - tests/ai/master/vault/snapshot-reader.test.ts
autonomous: true
requirements: [REQ-006]
must_haves:
  truths:
    - "materializeFromVault(campaignId, characterId) reads events.md, calls parseEventsFile + replayEvents, extracts the target character's CharacterState, and translates it into the SessionStateRow shape buildClientSnapshot expects"
    - "When events.md doesn't exist OR the character isn't in seed, materializeFromVault returns null (caller falls back to Postgres)"
    - "The translation maps EVERY persisted vault field to its Postgres-shaped equivalent: hp_current, temp_hp (→tempHp), conditions[].slug → [{slug, source, durationRounds, appliedRound}], etc."
    - "The output is byte-stable: same events.md → same SessionStateRow (modulo non-persisted timestamps)"
    - "Performance: <50ms for a 1000-event events.md (per spike 008 baseline + the projector's linear replay)"
  artifacts:
    - path: "src/ai/master/vault/snapshot-reader.ts"
      provides: "materializeFromVault translator function"
      exports: ["materializeFromVault"]
    - path: "tests/ai/master/vault/snapshot-reader.test.ts"
      provides: "Field-by-field translation tests + happy path + null-on-missing"
  key_links:
    - from: "src/sessions/client-snapshot.ts (plan 03-B-07)"
      to: "src/ai/master/vault/snapshot-reader.ts (this plan)"
      via: "Called when resolveSourceOfTruth === 'vault'"
      pattern: "materializeFromVault"
---

# Plan 03-B-06: Snapshot Reader (Vault → SessionStateRow Shape)

**Phase:** 03-migration-cutover
**Wave:** 5 (depends on event types + projector)
**Status:** Pending
**Estimated diff size:** ~180 LOC source + ~250 LOC tests / 2 files

## Goal

The UI consumes `SessionStateRow` shape (the `sessionState` Postgres row). When `sourceOfTruth === 'vault'`, `buildClientSnapshot` (plan 03-B-07) needs to MATERIALIZE this shape from events.md replay. This plan ships the translator.

The mapping is largely 1:1 — the projector's CharacterState already matches the SessionStateRow column names. The translator:
1. Calls `parseEventsFile + replayEvents` to get `Map<characterId, CharacterState>`
2. Picks the target character's state
3. Translates field names (e.g., vault's `temp_hp` → SessionStateRow's `tempHp`)
4. Translates value shapes (e.g., vault's `conditions: string[]` of slugs → SessionStateRow's `conditions: {slug, source, durationRounds, appliedRound}[]`)

## Requirements satisfied

- **REQ-006** — Vault is source of truth for snapshot reads after cutover. Materialization is the read primitive.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/snapshot-reader.ts` | NEW | The translator |
| `tests/ai/master/vault/snapshot-reader.test.ts` | NEW | Round-trip + edge-case tests |

## Tasks

<task type="auto">
  <name>Task 1: Implement materializeFromVault</name>
  <files>src/ai/master/vault/snapshot-reader.ts</files>
  <read_first>
    - src/ai/master/vault/projector.ts (plan 03-A-03 — CharacterState shape, parseEventsFile, replayEvents)
    - src/ai/master/vault/campaign-paths.ts (eventsPath)
    - src/db/schema/session-state.ts (the SessionStateRow shape — column names + types this function must produce)
    - existsSync from node:fs
  </read_first>
  <action>
Create `src/ai/master/vault/snapshot-reader.ts`:

```ts
// src/ai/master/vault/snapshot-reader.ts
// Phase 03-B — translate vault replay state into SessionStateRow shape
// for buildClientSnapshot (plan 03-B-07). Used after cutover when
// sourceOfTruth === 'vault'.
//
// The CharacterState shape (projector.ts) is close to SessionStateRow but
// not identical:
//   - vault: temp_hp           PG: tempHp
//   - vault: conditions: string[] (slugs)  PG: {slug, source, durationRounds, appliedRound}[]
//   - vault: hit_dice_remaining PG: hitDiceRemaining
//   - vault: resources_used    PG: resourcesUsed
//   - vault: death_saves       PG: deathSaves
//   - vault: concentrating_on  PG: concentratingOn
//   - vault: flags.{stable,dead,inspiration}  PG: flags.{stable,dead}  (inspiration is vault-only Phase 03)
//   - vault: spell_slots: {level: {max, used}}  PG: spellSlotsUsed (just the used counts; max lives on characters.spellcasting.slotsMax)
//   - vault: inventory: {item, qty}[]  PG: inventoryDelta — needs derivation OR direct mapping
//   - vault: attunements      PG: (TBD — likely characters.attunements or omitted)
import { existsSync } from 'node:fs';
import { parseEventsFile, replayEvents, type CharacterState } from './projector';
import { eventsPath } from './campaign-paths';
import type { SessionState } from '@/db/schema';

export async function materializeFromVault(
  campaignId: string,
  characterId: string,
  sessionId: string,
): Promise<Partial<SessionState> | null> {
  const eventsFile = eventsPath(campaignId);
  if (!existsSync(eventsFile)) return null;
  const envelopes = await parseEventsFile(eventsFile);
  if (envelopes.length === 0) return null;
  const states = replayEvents(envelopes);
  const charState = states.get(characterId);
  if (!charState) return null;

  return translateCharacterState(charState, sessionId);
}

function translateCharacterState(s: CharacterState, sessionId: string): Partial<SessionState> {
  return {
    sessionId,
    hpCurrent: s.hp_current,
    tempHp: s.temp_hp ?? 0,
    hitDiceRemaining: s.hit_dice_remaining ?? 0,
    spellSlotsUsed: extractSpellSlotsUsed(s.spell_slots ?? {}),
    conditions: s.conditions.map((slug) => ({
      slug,
      source: 'vault-replay',
      durationRounds: 'until_removed' as const,
      appliedRound: 0,
    })),
    resourcesUsed: s.resources_used ?? {},
    deathSaves: s.death_saves ?? { successes: 0, failures: 0 },
    flags: {
      stable: s.flags?.stable ?? false,
      dead: s.flags?.dead ?? false,
    },
    exhaustionLevel: s.exhaustion_level ?? 0,
    concentratingOn: s.concentrating_on ?? null,
    // Fields that don't exist on vault but ARE on SessionStateRow — defaults:
    turnState: null,
    position: null,
    inCombat: false,
    combat: null,
    scene: '',
    inventoryDelta: [],
    statusFlag: null,
    sceneImageData: null,
    sceneImagePrompt: null,
    sceneImageVersion: 0,
    sceneImagePending: false,
    sceneImagePendingAt: null,
    sceneImageFailedReason: null,
    lastLongRestAt: null,
    travel: null,
    summaryBlock: null,
  };
}

function extractSpellSlotsUsed(slots: Record<string, { max: number; used: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [level, { used }] of Object.entries(slots)) {
    out[level] = used;
  }
  return out;
}
```

CRITICAL: The fields listed as "defaults" (`turnState: null`, `inCombat: false`, etc.) are SCENE/UI state that vault doesn't track. The translator returns sane defaults; the UI must not break when these are empty/null.

The `Partial<SessionState>` return shape (instead of full SessionState) is intentional — callers (plan 03-B-07's buildClientSnapshot) merge this with their other reads. If the actual SessionState type requires non-null fields the translator can't supply (e.g., scene must be ''), use empty defaults explicitly as above.

After running typecheck, IF the actual SessionState type strict shape requires fields not listed here, ADD them with appropriate defaults — the audit step at the bottom of plan 03-B-07 surfaces any gap.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "^export " src/ai/master/vault/snapshot-reader.ts` returns >= 1
    - The 4 null/skip cases all return `null` (not throw)
    - Every SessionStateRow column has a translation OR a sane default
    - The function performs ONE parseEventsFile + ONE replayEvents (no extra disk reads)
  </acceptance_criteria>
  <done>
    Translator ships. Task 2 tests it.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write tests/ai/master/vault/snapshot-reader.test.ts</name>
  <files>tests/ai/master/vault/snapshot-reader.test.ts</files>
  <read_first>
    - src/ai/master/vault/snapshot-reader.ts (Task 1)
    - tests/ai/master/vault/projector.test.ts (plan 03-A-03 — replay setup pattern)
    - tests/ai/master/vault/apply-event-integration.test.ts (Phase 02 — seed + apply pattern + tmpdir)
  </read_first>
  <action>
Create `tests/ai/master/vault/snapshot-reader.test.ts`. Pure FS test (no DATABASE_URL needed).

Cases:
1. Returns null when events.md doesn't exist
2. Returns null when events.md exists but is empty
3. Returns null when character not in seed
4. Translates hp_current + hp_max correctly
5. Translates conditions (string[] → {slug, source, ...}[])
6. Translates spell_slots ({level: {max, used}} → {level: used})
7. Translates temp_hp, exhaustion_level, hit_dice_remaining, resources_used
8. Translates death_saves shape correctly
9. Translates flags (omits Phase 03 inspiration if Postgres SessionState doesn't have it)
10. UI-only fields (scene, inCombat, sceneImageData) have correct defaults

```ts
describe('materializeFromVault', () => {
  let tmpVaultRoot: string;
  const CAMPAIGN_UUID = '11111111-1111-1111-1111-111111111111';
  const CHAR_UUID = '22222222-2222-2222-2222-222222222222';
  const SESSION_UUID = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    tmpVaultRoot = mkdtempSync(join(tmpdir(), 'snapshot-reader-'));
    process.env.VAULT_CAMPAIGNS_ROOT = tmpVaultRoot;
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpVaultRoot, { recursive: true, force: true });
  });

  it('returns null when events.md missing', async () => {
    const { materializeFromVault } = await import('@/ai/master/vault/snapshot-reader');
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r).toBeNull();
  });

  it('returns null for unseeded character', async () => {
    // Write events.md with a seed for DIFFERENT char_id
    // ... then call materializeFromVault for CHAR_UUID
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r).toBeNull();
  });

  it('translates hp_current after damage events', async () => {
    // Seed CHAR_UUID with hp_max=30, hp_current=30
    // Apply hp_change delta=-5
    // ...
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r!.hpCurrent).toBe(25);
  });

  it('translates conditions slug array to PG condition shape', async () => {
    // Seed + condition_add events: blinded, prone
    // ...
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r!.conditions).toHaveLength(2);
    expect(r!.conditions![0]).toMatchObject({ slug: 'blinded', source: 'vault-replay' });
  });

  it('extracts spell_slots used counts', async () => {
    // Seed with spell_slots: {1: {max:3, used:0}, 2: {max:1, used:0}}
    // Apply spell_slot_use level:1 twice
    // ...
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r!.spellSlotsUsed).toEqual({ '1': 2, '2': 0 });
  });

  it('translates death_saves correctly', async () => {
    // ... apply death_save_fail x2
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r!.deathSaves).toEqual({ successes: 0, failures: 2 });
  });

  it('UI-only fields have empty defaults', async () => {
    // ... seed + minimal events
    const r = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r!.inCombat).toBe(false);
    expect(r!.scene).toBe('');
    expect(r!.combat).toBeNull();
  });

  it('byte-stable: replaying the same events twice produces the same translated shape', async () => {
    // ... apply 10 mixed events
    const r1 = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    const r2 = await materializeFromVault(CAMPAIGN_UUID, CHAR_UUID, SESSION_UUID);
    expect(r1).toEqual(r2);
  });
});
```

Use the EventsWriter + projector directly in beforeEach to seed the vault files (skip dispatchVaultTool since the test focuses on the reader, not the writer).
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/snapshot-reader.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass
    - The byte-stable case proves determinism
    - Every Phase 02 + Phase 03 event type is exercised at least once
    - Test runtime < 5s (pure FS — no LLM, no DB)
  </acceptance_criteria>
  <done>
    Reader tested. Plan 03-B-07 wires it into buildClientSnapshot.
  </done>
</task>
