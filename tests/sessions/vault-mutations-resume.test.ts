import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultSeedCharacter } from '@/ai/master/vault/events-schema';

/**
 * Phase 02 plan 02-08 Task 4 — resume invariant: a Next.js server restart
 * preserves state via events.md replay on the next session read.
 *
 * Phase gate row (02-VALIDATION.md):
 *   "Restart preserves state via events.md replay on session resume"
 *
 * Coverage:
 *   1. Empty replay (no events.md yet — brand-new campaign).
 *   2. Freshly-created campaign seed (no hp_current, no spell_slots) →
 *      INITIAL_CHARACTER_STATE defaults kick in (BLOCKER 1 ground truth).
 *   3. Played-session seed (hp_current + spell_slots present) → state
 *      matches seed verbatim (BLOCKER 1 ground truth).
 *   4. Mixed seed (one fresh + one played) → each character defaults
 *      independently (BLOCKER 1 ground truth).
 *   5. Seed + 5 mutations → state reflects aggregate post-replay.
 *   6. regenerateCharacterView is deterministic across simulated restart
 *      (vi.resetModules → re-import → byte-equal view).
 *   7. View-file corruption recovery (DR roundtrip — spike 013).
 *   8. No duplicate state across a simulated restart between two
 *      apply_event calls.
 *
 * No DATABASE_URL needed (pure projector + tools).
 * Pattern: vi.stubEnv('VAULT_CAMPAIGNS_ROOT') + vi.resetModules + re-import,
 * exactly like tests/ai/master/vault/apply-event-integration.test.ts.
 */

const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const FIGHTER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WIZARD_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SECOND_UUID = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';

type VaultModule = {
  dispatchVaultTool: typeof import('@/ai/master/vault/tools').dispatchVaultTool;
  eventsPath: typeof import('@/ai/master/vault/campaign-paths').eventsPath;
  characterViewPath: typeof import('@/ai/master/vault/campaign-paths').characterViewPath;
  regenerateCharacterView: typeof import('@/ai/master/vault/projector').regenerateCharacterView;
  replayEvents: typeof import('@/ai/master/vault/projector').replayEvents;
  parseEventsFile: typeof import('@/ai/master/vault/projector').parseEventsFile;
  parseView: typeof import('@/ai/master/vault/projector').parseView;
  serializeView: typeof import('@/ai/master/vault/projector').serializeView;
};

async function freshVaultModule(campaignsRoot: string): Promise<VaultModule> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', campaignsRoot);
  vi.resetModules();
  const tools = await import('@/ai/master/vault/tools');
  const paths = await import('@/ai/master/vault/campaign-paths');
  const projector = await import('@/ai/master/vault/projector');
  return {
    dispatchVaultTool: tools.dispatchVaultTool,
    eventsPath: paths.eventsPath,
    characterViewPath: paths.characterViewPath,
    regenerateCharacterView: projector.regenerateCharacterView,
    replayEvents: projector.replayEvents,
    parseEventsFile: projector.parseEventsFile,
    parseView: projector.parseView,
    serializeView: projector.serializeView,
  };
}

/**
 * Append a campaign_initialized seed event via the dispatch surface. The
 * test owns the optional shape (hp_current present/absent, spell_slots
 * present/absent) so we can exercise the BLOCKER 1 ground-truth fixtures.
 */
async function writeSeedEvent(
  mod: VaultModule,
  campaignId: string,
  characters: VaultSeedCharacter[],
): Promise<void> {
  const r = await mod.dispatchVaultTool(
    'apply_event',
    {
      type: 'campaign_initialized',
      payload: { characters },
    },
    { campaignId },
  );
  if (r.isError) throw new Error(`seed failed: ${r.content}`);
}

describe('vault-mutations resume — replay-on-read invariant', () => {
  let campaignsRoot: string;
  let mod: VaultModule;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-vault-resume-'));
    mod = await freshVaultModule(campaignsRoot);
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('a campaign with 0 events has empty replay state', async () => {
    // No events.md on disk — parseEventsFile returns [], replayEvents
    // returns an empty Map. This is the brand-new-campaign starting state
    // (before the flip script appends the seed).
    const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
    expect(envelopes).toEqual([]);
    const states = mod.replayEvents(envelopes);
    expect(states.size).toBe(0);
  });

  it('freshly-created campaign seed (no hp_current, no spell_slots) → state.hp_current === hp_max, state.spell_slots === {}', async () => {
    // BLOCKER 1 ground truth — most common case at flip time: a
    // never-played campaign with a fighter PC (no spellcasting). The flip
    // script omits both optional fields; the projector falls back to
    // hp_max and {} via INITIAL_CHARACTER_STATE.
    const seed: VaultSeedCharacter[] = [
      { id: FIGHTER_UUID, name: 'Rogan the Fighter', hp_max: 25 },
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
    const states = mod.replayEvents(envelopes);
    expect(states.size).toBe(1);

    const rogan = states.get(FIGHTER_UUID);
    expect(rogan).toBeDefined();
    expect(rogan!.hp_current).toBe(25); // fallback to hp_max
    expect(rogan!.hp_max).toBe(25);
    expect(rogan!.spell_slots).toEqual({}); // fallback to empty
    expect(rogan!.conditions).toEqual([]);
    expect(rogan!.inventory).toEqual([]);
  });

  it('played-session campaign seed (hp_current present, spell_slots present) → state matches seed verbatim', async () => {
    // BLOCKER 1 ground truth — operator played a session before flipping:
    // session_state.hpCurrent is 12 of 25 (took damage); the wizard PC
    // has spent some lvl-1 slots.
    const seed: VaultSeedCharacter[] = [
      {
        id: WIZARD_UUID,
        name: 'Elara the Wizard',
        hp_max: 25,
        hp_current: 12,
        spell_slots: { '1': { max: 4, used: 2 }, '2': { max: 2, used: 0 } },
      },
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
    const states = mod.replayEvents(envelopes);
    const elara = states.get(WIZARD_UUID);
    expect(elara).toBeDefined();
    expect(elara!.hp_current).toBe(12); // verbatim from seed (no fallback)
    expect(elara!.hp_max).toBe(25);
    expect(elara!.spell_slots).toEqual({ '1': { max: 4, used: 2 }, '2': { max: 2, used: 0 } });
  });

  it('mixed seed (one fresh, one played) → each character defaults independently', async () => {
    // BLOCKER 1 ground truth — the projector's per-character fallback is
    // applied PER CHARACTER. A campaign can have a fresh PC and a played
    // PC in the same seed; the fallback rules don't bleed across.
    const seed: VaultSeedCharacter[] = [
      { id: FIGHTER_UUID, name: 'A', hp_max: 20 },                              // fresh — no hp_current
      { id: SECOND_UUID,  name: 'B', hp_max: 30, hp_current: 15 },              // played — explicit hp_current
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
    const states = mod.replayEvents(envelopes);
    expect(states.size).toBe(2);
    expect(states.get(FIGHTER_UUID)!.hp_current).toBe(20); // fallback to hp_max
    expect(states.get(SECOND_UUID)!.hp_current).toBe(15);  // verbatim
  });

  it('a campaign with seed + 5 mutations has the post-mutation state', async () => {
    // Seed a played-session wizard at full HP, then dispatch 5 hp_change
    // events through the actual dispatch surface (the same path the
    // turn-route uses when vaultMutations:true).
    const seed: VaultSeedCharacter[] = [
      {
        id: WIZARD_UUID,
        name: 'Elara the Wizard',
        hp_max: 25,
        hp_current: 25,
        spell_slots: { '1': { max: 4, used: 0 } },
      },
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    // 5 hp_change events: -3 -2 +1 -4 -2 = -10 → 25 - 10 = 15
    const deltas = [-3, -2, +1, -4, -2];
    for (const delta of deltas) {
      const r = await mod.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: WIZARD_UUID, delta } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(r.isError).toBe(false);
    }

    const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
    expect(envelopes).toHaveLength(6); // seed + 5 mutations
    const states = mod.replayEvents(envelopes);
    expect(states.get(WIZARD_UUID)!.hp_current).toBe(15);
  });

  it('regenerateCharacterView produces the same view on first call and after simulated restart', async () => {
    // Use the freshly-created-campaign fixture so the defaults path runs
    // on BOTH the first regen AND the post-restart regen — proving the
    // INITIAL_CHARACTER_STATE fallback is byte-deterministic across
    // module-load boundaries (spike 008 + 013 invariant).
    const seed: VaultSeedCharacter[] = [
      { id: FIGHTER_UUID, name: 'Rogan the Fighter', hp_max: 25 }, // no hp_current, no spell_slots
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    const viewPath = mod.characterViewPath(CAMPAIGN_UUID, 'Rogan the Fighter', FIGHTER_UUID);
    const viewV1 = await readFile(viewPath, 'utf8');

    // Simulate Next.js restart: drop the module cache, re-import with the
    // SAME env, regenerate via the fresh projector instance.
    const fresh = await freshVaultModule(campaignsRoot);
    await fresh.regenerateCharacterView(CAMPAIGN_UUID, FIGHTER_UUID);
    const viewV2 = await readFile(viewPath, 'utf8');

    // Byte-for-byte equality: the projector's pure-replay + serialize path
    // is deterministic across module load boundaries.
    expect(viewV2).toBe(viewV1);
  });

  it('a view file corrupted post-restart can be restored via regenerate (DR roundtrip — spike 013)', async () => {
    // Use the played-session fixture so the view contains non-default
    // fields (hp_current ≠ hp_max, spell_slots non-empty) — exercises
    // the verbatim path AND the serializer's deterministic ordering.
    const seed: VaultSeedCharacter[] = [
      {
        id: WIZARD_UUID,
        name: 'Elara the Wizard',
        hp_max: 25,
        hp_current: 12,
        spell_slots: { '1': { max: 4, used: 2 } },
      },
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    const viewPath = mod.characterViewPath(CAMPAIGN_UUID, 'Elara the Wizard', WIZARD_UUID);
    const originalView = await readFile(viewPath, 'utf8');
    expect(originalView.length).toBeGreaterThan(0);

    // Corrupt the view file (operator hand-edit gone wrong / disk-corruption / etc.).
    await writeFile(viewPath, 'CORRUPTED', 'utf8');
    expect(await readFile(viewPath, 'utf8')).toBe('CORRUPTED');

    // Simulate restart + the rebuild-views recovery script (plan 02-10).
    const fresh = await freshVaultModule(campaignsRoot);
    await fresh.regenerateCharacterView(CAMPAIGN_UUID, WIZARD_UUID);
    const restoredView = await readFile(viewPath, 'utf8');

    // Byte-exact restore (spike 013 invariant — the events log is the
    // single source of truth, the view is a deterministic projection).
    expect(restoredView).toBe(originalView);
  });

  it('the dispatcher does not duplicate state across two apply_event calls separated by a simulated restart', async () => {
    // Played-session caster: full HP, lvl-1 slots untouched. After the
    // restart between the two apply_events, the second dispatcher must
    // REPLAY the first event (read state from disk) before applying its
    // own — NOT start from a fresh seed state.
    const seed: VaultSeedCharacter[] = [
      {
        id: WIZARD_UUID,
        name: 'Caster',
        hp_max: 20,
        hp_current: 20,
        spell_slots: { '1': { max: 3, used: 0 } },
      },
    ];
    await writeSeedEvent(mod, CAMPAIGN_UUID, seed);

    // Pre-restart: -5 HP → 20 - 5 = 15.
    const r1 = await mod.dispatchVaultTool(
      'apply_event',
      { type: 'hp_change', payload: { character: WIZARD_UUID, delta: -5 } },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(r1.isError).toBe(false);

    // Simulated restart: drop module cache, re-import projector + tools.
    const fresh = await freshVaultModule(campaignsRoot);

    // Post-restart: -3 HP via the FRESH dispatcher. The reducer must see
    // state.hp_current === 15 (from the pre-restart event's effect, not
    // the seed's 20), so the final state is 15 - 3 = 12 (NOT 20 - 3 = 17).
    const r2 = await fresh.dispatchVaultTool(
      'apply_event',
      { type: 'hp_change', payload: { character: WIZARD_UUID, delta: -3 } },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(r2.isError).toBe(false);

    // Final view: hp_current === 12 (cumulative across the restart).
    const viewPath = fresh.characterViewPath(CAMPAIGN_UUID, 'Caster', WIZARD_UUID);
    const finalView = fresh.parseView(await readFile(viewPath, 'utf8'));
    expect(finalView).not.toBeNull();
    expect(finalView!.hp_current).toBe(12);
  });
});
