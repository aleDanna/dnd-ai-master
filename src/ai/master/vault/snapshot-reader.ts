/**
 * Phase 03-B / plan 03-B-06 — snapshot reader.
 *
 * REQ-006 — Vault is source of truth for snapshot reads after cutover. The
 *           UI consumes `SessionStateRow` shape (the `session_state` Postgres
 *           row). When `sourceOfTruth === 'vault'`, `buildClientSnapshot`
 *           (plan 03-B-07) MUST materialize that shape from events.md replay
 *           instead of querying Postgres. This module is the translator that
 *           bridges the vault's `CharacterState` (projector output) into the
 *           Postgres-shaped `SessionState` row the UI expects.
 *
 * Determinism contract (REQ-022 purity):
 *   - No env reads at module load — `eventsPath` reads `VAULT_CAMPAIGNS_ROOT`
 *     via `campaign-paths → path.ts` at THAT module's load; this file imports
 *     the helper, not the env. (Same transitive pattern as `projector.ts`.)
 *   - No clock reads, no randomness, no module-level side effects.
 *   - Same events.md bytes ⇒ same translated `SessionState` (modulo
 *     non-persisted timestamps — see "byte-stability scope" below).
 *
 * Byte-stability scope (must_haves.truths #4):
 *   The translator produces deterministic output for `hpCurrent`, `tempHp`,
 *   `conditions`, `spellSlotsUsed`, `resourcesUsed`, `deathSaves`, `flags`,
 *   `exhaustionLevel`, `concentratingOn`, `hitDiceRemaining`. The UI-only /
 *   scene-state fields (`turnState`, `position`, `inCombat`, `combat`,
 *   `scene`, `inventoryDelta`, `statusFlag`, scene-image fields,
 *   `lastLongRestAt`, `travel`, `summaryBlock`) are NOT tracked by the vault
 *   and are returned as sane defaults — the UI must not break on empty/null
 *   values for these (verified by plan 03-B-07's audit step).
 *
 * Translation map (vault `CharacterState` → Postgres `SessionState`):
 *   vault.hp_current             → state.hpCurrent
 *   vault.temp_hp                → state.tempHp
 *   vault.hit_dice_remaining     → state.hitDiceRemaining
 *   vault.spell_slots            → state.spellSlotsUsed (only `used` counts)
 *   vault.conditions: string[]   → state.conditions: {slug, source, ...}[]
 *   vault.resources_used         → state.resourcesUsed
 *   vault.death_saves            → state.deathSaves
 *   vault.flags.{stable,dead}    → state.flags.{stable,dead}
 *                                  (vault.flags.inspiration is vault-only;
 *                                   Postgres' session_state.flags type omits
 *                                   `inspiration` — it lives on
 *                                   `characters.inspiration` in the legacy
 *                                   Postgres schema, not on session_state.
 *                                   The translator drops it here.)
 *   vault.exhaustion_level       → state.exhaustionLevel
 *   vault.concentrating_on       → state.concentratingOn (shape-identical)
 *
 * Returns `Partial<SessionState>` (not full): the caller (buildClientSnapshot
 * in plan 03-B-07) merges this with other reads. Fields the translator
 * cannot supply from vault state (turn/scene/image/travel) are set to
 * explicit empty/null defaults so consumers see a complete-looking row
 * without runtime undefineds.
 *
 * Null-return cases (must_haves.truths #2):
 *   - events.md doesn't exist (campaign never flipped to vault path)
 *   - events.md exists but is empty (flip seed not yet written)
 *   - target characterId not present in the replayed state map
 *     (character not in any seed event for this campaign)
 *
 * The caller MUST handle `null` by falling back to the Postgres path —
 * see plan 03-B-07's `resolveSourceOfTruth` switch logic.
 *
 * Performance target (must_haves.truths #5):
 *   <50ms for a 1000-event events.md. Linear in event count (projector's
 *   replay is O(N)). Single disk read for the whole file, then in-memory
 *   parse + replay + translate. No DB round-trips.
 */
import { existsSync } from 'node:fs';
import { parseEventsFile, replayEvents, type CharacterState } from './projector';
import { eventsPath } from './campaign-paths';
import type { SessionState } from '@/db/schema';

/**
 * Materialize a `SessionState`-shaped snapshot from the campaign's events.md
 * by replaying the event log and translating the target character's
 * projector state into Postgres column names.
 *
 * @param campaignId — UUID of the campaign. MUST match the UUID regex
 *                     enforced by `campaignDir` (the helper throws on
 *                     malformed input; callers should validate upstream).
 * @param characterId — UUID of the PC whose snapshot to materialize.
 *                      Looked up in the replayed state map by exact match.
 * @param sessionId — UUID of the session this snapshot is for. Echoed back
 *                    as `state.sessionId`. The vault is per-campaign (not
 *                    per-session); the session id is carried through to
 *                    keep the row shape compatible with consumers that key
 *                    by session.
 *
 * @returns A `Partial<SessionState>` populated from vault replay, OR `null`
 *          when events.md is missing/empty or the character is not seeded.
 */
export async function materializeFromVault(
  campaignId: string,
  characterId: string,
  sessionId: string,
): Promise<Partial<SessionState> | null> {
  const eventsFile = eventsPath(campaignId);
  // Fast-path bail: a campaign that never flipped to vault has no events.md.
  // existsSync is the cheapest pre-check — avoids opening a file descriptor
  // just to catch ENOENT in parseEventsFile.
  if (!existsSync(eventsFile)) return null;

  const envelopes = await parseEventsFile(eventsFile);
  // Empty file (flip wrote a directory but no seed yet) — same outcome as
  // missing file: caller falls back to Postgres.
  if (envelopes.length === 0) return null;

  const { chars: states } = replayEvents(envelopes);
  const charState = states.get(characterId);
  // Unseeded character (e.g., the campaign was flipped before this PC was
  // added, or the seed event names a different set of characters) — return
  // null so the caller falls back. NOT throwing here is deliberate: the
  // Postgres path is the safety net for the gap between vault flip and
  // character-add propagation.
  if (!charState) return null;

  return translateCharacterState(charState, sessionId);
}

/**
 * Pure translator from `CharacterState` (vault projector output) into the
 * `SessionState` Postgres row shape.
 *
 * Field-by-field mapping (cross-reference: src/db/schema/session-state.ts):
 *
 *   Vault-tracked fields (deterministic from events.md):
 *   - hpCurrent              ← state.hp_current
 *   - tempHp                 ← state.temp_hp
 *   - hitDiceRemaining       ← state.hit_dice_remaining
 *   - spellSlotsUsed         ← `extractSpellSlotsUsed(state.spell_slots)`
 *                              (only `used` counts; max lives on
 *                               `characters.spellcasting.slotsMax`)
 *   - conditions             ← `state.conditions.map(slug → {slug, source,
 *                              durationRounds, appliedRound})` — the vault
 *                              tracks ONLY the slug, so source defaults to
 *                              'vault-replay' and timing defaults to
 *                              {until_removed, 0}. Re-applying a condition
 *                              from Postgres metadata is the caller's job
 *                              if it needs the original source.
 *   - resourcesUsed          ← state.resources_used
 *   - deathSaves             ← state.death_saves
 *   - flags                  ← `{stable, dead}` only (vault tracks
 *                              `inspiration` too, but Postgres'
 *                              session_state.flags type doesn't carry it —
 *                              it lives on `characters.inspiration`)
 *   - exhaustionLevel        ← state.exhaustion_level
 *   - concentratingOn        ← state.concentrating_on (shape-identical)
 *
 *   UI-only / scene-state fields (vault does NOT track; set defaults):
 *   - sessionId              ← argument (echoed back)
 *   - turnState              ← null     (initiative tracker not in vault)
 *   - position               ← null     (grid coords not in vault)
 *   - inCombat               ← false    (combat state not in vault)
 *   - combat                 ← null     (round/turn-order not in vault)
 *   - scene                  ← ''       (DM narration not in vault)
 *   - inventoryDelta         ← []       (legacy Postgres delta queue, unused)
 *   - statusFlag             ← null     (UI status banner, transient)
 *   - sceneImageData         ← null     (image bytes — out of scope)
 *   - sceneImagePrompt       ← null
 *   - sceneImageVersion      ← 0
 *   - sceneImagePending      ← false
 *   - sceneImagePendingAt    ← null
 *   - sceneImageFailedReason ← null
 *   - lastLongRestAt         ← null     (Postgres-only PHB §5.2 cooldown)
 *   - travel                 ← null     (PHB §6 travel state not in vault)
 *   - summaryBlock           ← null     (Phase 03-B condensation not in vault
 *                                        replay path; handled separately)
 *
 * Why some UI-only fields use empty defaults instead of being omitted:
 *   The Postgres column NOT NULL constraints (e.g., `scene: text NOT NULL
 *   DEFAULT ''`, `inCombat: boolean NOT NULL DEFAULT false`) mean the row
 *   shape is incomplete without them. Even though this function returns
 *   `Partial<SessionState>` (not full), supplying the defaults inline keeps
 *   the consumer's merge logic simpler — no per-field "did vault provide
 *   this?" checks.
 */
function translateCharacterState(
  s: CharacterState,
  sessionId: string,
): Partial<SessionState> {
  return {
    sessionId,
    // -----------------------------------------------------------------------
    // Vault-tracked fields — deterministic from events.md replay.
    // -----------------------------------------------------------------------
    hpCurrent: s.hp_current,
    tempHp: s.temp_hp,
    hitDiceRemaining: s.hit_dice_remaining,
    spellSlotsUsed: extractSpellSlotsUsed(s.spell_slots),
    conditions: s.conditions.map((slug) => ({
      slug,
      source: 'vault-replay',
      durationRounds: 'until_removed' as const,
      appliedRound: 0,
    })),
    resourcesUsed: s.resources_used,
    deathSaves: s.death_saves,
    // Postgres' session_state.flags is `{stable?, dead?}` — `inspiration`
    // exists in vault.flags but NOT in this column type. Drop it here;
    // consumers that need inspiration read it from `characters.inspiration`.
    flags: {
      stable: s.flags.stable,
      dead: s.flags.dead,
    },
    exhaustionLevel: s.exhaustion_level,
    concentratingOn: s.concentrating_on,

    // -----------------------------------------------------------------------
    // UI-only / scene-state fields — vault doesn't track these; emit defaults
    // matching the Postgres NOT NULL / DEFAULT column constraints so the
    // consumer sees a complete-looking row.
    // -----------------------------------------------------------------------
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

/**
 * Vault's `spell_slots` shape is `{level: {max, used}}` — both halves of the
 * record because the projector tracks the cap alongside consumption (so
 * `spell_slot_use` can clamp at `max`). Postgres' `spellSlotsUsed` column
 * stores ONLY the `used` count — the `max` lives on
 * `characters.spellcasting.slotsMax` (a per-character spec, not session
 * state). This helper extracts just the `used` half.
 *
 * Determinism: iteration order is `Object.entries`, which on V8/Node 20+
 * is insertion order for string keys. The projector seeds spell_slots from
 * `INITIAL_CHARACTER_STATE` which copies from the seed event in the order
 * the flip script emitted (sorted alphanumerically by `vault-flip` to match
 * the Postgres jsonb key ordering). Same input ⇒ same output object.
 */
function extractSpellSlotsUsed(
  slots: Record<string, { max: number; used: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [level, slot] of Object.entries(slots)) {
    out[level] = slot.used;
  }
  return out;
}
