import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 02 — apply_event END-TO-END integration suite.
 *
 * Scope of this file:
 *   1. Happy path — N sequential apply_events → events.md grows by N + seed,
 *      view file reflects final state.
 *   2. REQ-007 isolation — writes land ONLY under VAULT_CAMPAIGNS_ROOT,
 *      NEVER under VAULT_ROOT.
 *   3. REQ-006 DR roundtrip — corrupt the view file, regenerate via
 *      replay, assert byte-exact recovery (spike 013 invariant).
 *   4. Round-trip property — generated event stream → replay produces a
 *      state map that matches the parseView output (spike 008 invariant).
 *   5. Concurrent dispatch — 50 parallel apply_event calls all land, all
 *      with unique event_ids (EventsWriter mutex preserved through the
 *      dispatcher).
 *   6. Restart simulation — vi.resetModules → fresh module → replayEvents
 *      reconstructs post-N-events state without side effects.
 *
 * No DATABASE_URL required — pure filesystem + vault module integration.
 *
 * Pattern: every test re-imports the vault modules AFTER `vi.stubEnv`
 * because VAULT_CAMPAIGNS_ROOT is read at module-load (via `./path`).
 */

const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHAR_UUID_2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

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

async function seedAragorn(mod: VaultModule, hpMax = 30, hpCurrent = 30): Promise<void> {
  const seed = await mod.dispatchVaultTool(
    'apply_event',
    {
      type: 'campaign_initialized',
      payload: {
        characters: [
          { id: CHAR_UUID, name: 'Aragorn', hp_max: hpMax, hp_current: hpCurrent },
        ],
      },
    },
    { campaignId: CAMPAIGN_UUID },
  );
  if (seed.isError) throw new Error('seed failed: ' + seed.content);
}

describe('apply_event end-to-end integration', () => {
  let campaignsRoot: string;
  let mod: VaultModule;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-apply-event-int-'));
    mod = await freshVaultModule(campaignsRoot);
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('happy path — dispatch → events.md → view file', () => {
    it('5 sequential hp_change events produce 6 events.md lines and a view at hp_current=13', async () => {
      await seedAragorn(mod, 30, 30);
      const deltas = [-3, -2, +5, -10, -7]; // sum: -17, clamped final: 13
      for (const delta of deltas) {
        const r = await mod.dispatchVaultTool(
          'apply_event',
          { type: 'hp_change', payload: { character: CHAR_UUID, delta } },
          { campaignId: CAMPAIGN_UUID },
        );
        expect(r.isError).toBe(false);
      }

      const lines = (await readFile(mod.eventsPath(CAMPAIGN_UUID), 'utf8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(6); // seed + 5 hp_change

      const view = await readFile(
        mod.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID),
        'utf8',
      );
      expect(view).toContain('hp_current: 13');
      expect(view).toContain('hp_max: 30');
    });

    it('view file path uses the slug-id8 convention (`aragorn-<id8>.md`)', async () => {
      await seedAragorn(mod);
      const expected = mod.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID);
      const id8 = CHAR_UUID.slice(0, 8);
      expect(expected).toContain(`characters/aragorn-${id8}.md`);
      expect(existsSync(expected)).toBe(true);
    });
  });

  describe('REQ-007 — writes ONLY under VAULT_CAMPAIGNS_ROOT', () => {
    it('dispatching apply_event creates events.md under VAULT_CAMPAIGNS_ROOT/<campaign>/ only', async () => {
      await seedAragorn(mod);
      await mod.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -1 } },
        { campaignId: CAMPAIGN_UUID },
      );
      const expectedEventsPath = mod.eventsPath(CAMPAIGN_UUID);
      expect(existsSync(expectedEventsPath)).toBe(true);
      // The events file must live under campaignsRoot — never elsewhere.
      expect(expectedEventsPath.startsWith(campaignsRoot)).toBe(true);
      // The static VAULT_ROOT (process.cwd()/data/vault) MUST NOT receive
      // any new file from this dispatch. We don't fully scan it (that
      // would be flaky on a developer checkout) but assert the canonical
      // events.md sentinel doesn't appear there.
      const staticVaultEventsSentinel = join(
        process.cwd(),
        'data',
        'vault',
        'campaigns',
        CAMPAIGN_UUID,
        'events.md',
      );
      expect(existsSync(staticVaultEventsSentinel)).toBe(false);
    });
  });

  describe('REQ-006 — DR roundtrip (spike 013 byte-exact restore)', () => {
    it('corrupting the view file and replaying restores byte-exact content', async () => {
      await seedAragorn(mod, 50, 50);
      // Dispatch a mixed event stream so the state is non-trivial.
      const sequence: Array<{ type: string; payload: Record<string, unknown> }> = [
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { type: 'condition_add', payload: { character: CHAR_UUID, condition: 'poisoned' } },
        { type: 'inventory_add', payload: { character: CHAR_UUID, item: 'potion', qty: 3 } },
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -8 } },
        { type: 'condition_remove', payload: { character: CHAR_UUID, condition: 'poisoned' } },
        { type: 'inventory_remove', payload: { character: CHAR_UUID, item: 'potion', qty: 1 } },
      ];
      for (const e of sequence) {
        const r = await mod.dispatchVaultTool('apply_event', e, { campaignId: CAMPAIGN_UUID });
        expect(r.isError).toBe(false);
      }

      const viewPath = mod.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID);
      const originalView = await readFile(viewPath, 'utf8');
      expect(originalView.length).toBeGreaterThan(0);

      // Simulate operator corruption.
      await writeFile(viewPath, 'CORRUPTED', 'utf8');
      const corrupted = await readFile(viewPath, 'utf8');
      expect(corrupted).toBe('CORRUPTED');

      // Restore via replay.
      await mod.regenerateCharacterView(CAMPAIGN_UUID, CHAR_UUID);
      const restoredView = await readFile(viewPath, 'utf8');

      // Byte-exact restore (spike 013 invariant).
      expect(restoredView).toBe(originalView);
    });
  });

  describe('round-trip property: serializeView ↔ parseView ↔ replay', () => {
    it('replayEvents(parseEventsFile(events.md)) yields a state matching parseView(view-file)', async () => {
      await seedAragorn(mod, 40, 40);
      const ops: Array<{ type: string; payload: Record<string, unknown> }> = [
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -3 } },
        { type: 'condition_add', payload: { character: CHAR_UUID, condition: 'blessed' } },
        { type: 'inventory_add', payload: { character: CHAR_UUID, item: 'rope', qty: 1 } },
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: +2 } },
      ];
      for (const e of ops) {
        await mod.dispatchVaultTool('apply_event', e, { campaignId: CAMPAIGN_UUID });
      }

      // Replay path A — events.md → parseEventsFile → replayEvents.
      const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
      const replayState = mod.replayEvents(envelopes).get(CHAR_UUID);
      expect(replayState).toBeDefined();

      // Replay path B — view-file → parseView (the LLM's read path).
      const viewContent = await readFile(
        mod.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID),
        'utf8',
      );
      const viewState = mod.parseView(viewContent);
      expect(viewState).not.toBeNull();

      // Compare modulo metadata fields the parseView seam doesn't recover
      // (last_event_id / last_updated round-trip is covered by the
      // projector unit tests; here we just want the gameplay state).
      expect(viewState!.id).toBe(replayState!.id);
      expect(viewState!.name).toBe(replayState!.name);
      expect(viewState!.hp_current).toBe(replayState!.hp_current);
      expect(viewState!.hp_max).toBe(replayState!.hp_max);
      expect(viewState!.conditions).toEqual(replayState!.conditions);
      expect(viewState!.spell_slots).toEqual(replayState!.spell_slots);
      expect(viewState!.inventory).toEqual(replayState!.inventory);
    });
  });

  describe('concurrent writes through the dispatch path', () => {
    it('50 parallel apply_event calls all land; events.md is well-formed with 51 lines and 50 unique event_ids', async () => {
      await seedAragorn(mod, 1000, 1000); // Give plenty of HP so clamps don't bottom out.
      const fires = Array.from({ length: 50 }, () =>
        mod.dispatchVaultTool(
          'apply_event',
          { type: 'hp_change', payload: { character: CHAR_UUID, delta: -1 } },
          { campaignId: CAMPAIGN_UUID },
        ),
      );
      const results = await Promise.all(fires);
      const okResults = results.filter((r) => !r.isError);
      expect(okResults).toHaveLength(50);

      const lines = (await readFile(mod.eventsPath(CAMPAIGN_UUID), 'utf8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(51); // seed + 50

      // Each line is well-formed JSON and the 50 mutation event ids are
      // distinct.
      const ids = new Set<string>();
      for (let i = 1; i < lines.length; i++) {
        const env = JSON.parse(lines[i]!) as { id: string; type: string };
        expect(env.type).toBe('hp_change');
        ids.add(env.id);
      }
      expect(ids.size).toBe(50);

      // Final state: hp_current = 1000 - 50 = 950.
      const viewState = mod.parseView(
        await readFile(
          mod.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID),
          'utf8',
        ),
      );
      expect(viewState!.hp_current).toBe(950);
    });
  });

  describe('restart simulation — state survives via replay (REQ-006 cousin)', () => {
    it('after vi.resetModules + fresh module load, replayEvents reconstructs post-event state', async () => {
      await seedAragorn(mod, 30, 30);
      const ops: Array<{ type: string; payload: Record<string, unknown> }> = [
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -3 } },
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -4 } },
        { type: 'condition_add', payload: { character: CHAR_UUID, condition: 'prone' } },
      ];
      for (const e of ops) {
        await mod.dispatchVaultTool('apply_event', e, { campaignId: CAMPAIGN_UUID });
      }

      // Snapshot the events.md path before resetModules invalidates the
      // first-import binding.
      const eventsFile = mod.eventsPath(CAMPAIGN_UUID);

      // "Restart" — drop the module cache and re-import with the SAME
      // env (this simulates a server restart that re-reads the env var).
      const fresh = await freshVaultModule(campaignsRoot);

      const envelopes = await fresh.parseEventsFile(eventsFile);
      expect(envelopes.length).toBe(4); // seed + 3
      const state = fresh.replayEvents(envelopes).get(CHAR_UUID);
      expect(state).toBeDefined();
      expect(state!.hp_current).toBe(23); // 30 - 3 - 4
      expect(state!.conditions).toEqual(['prone']);
    });
  });

  describe('multi-character isolation', () => {
    it('mutating one character does not bleed into another', async () => {
      // Re-seed with TWO characters (uses a fresh campaignsRoot scope).
      const seed = await mod.dispatchVaultTool(
        'apply_event',
        {
          type: 'campaign_initialized',
          payload: {
            characters: [
              { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
              { id: CHAR_UUID_2, name: 'Legolas', hp_max: 25, hp_current: 25 },
            ],
          },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(seed.isError).toBe(false);

      await mod.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { campaignId: CAMPAIGN_UUID },
      );

      // Replay yields TWO entries with the expected per-character state.
      const envelopes = await mod.parseEventsFile(mod.eventsPath(CAMPAIGN_UUID));
      const states = mod.replayEvents(envelopes);
      expect(states.size).toBe(2);
      expect(states.get(CHAR_UUID)!.hp_current).toBe(25); // 30 - 5
      expect(states.get(CHAR_UUID_2)!.hp_current).toBe(25); // untouched
    });
  });
});
