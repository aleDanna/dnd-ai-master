/**
 * Phase 10 Plan 03 — Task 2: Headless wiring test for the server-authoritative
 * encounter opener (REQ-045).
 *
 * This test proves the FULL wiring from bestiary read → opener events → vault
 * dispatch without any live Postgres NOTIFY. It is the BLOCKER-1 acceptance
 * criterion: a "goblin" combat-intent turn spawns the goblin at hpMax === 7
 * (the REAL SRD value from data/vault/handbook/monsters/goblin.md, not a
 * CR-default).
 *
 * Headless strategy (WARNING-4 / tools.ts:200):
 *   - Drives dispatchVaultTool with { campaignId } ONLY (no sessionId).
 *   - emitStateRefresh is a no-op when sessionId is absent (tools.ts:200).
 *   - Therefore no Postgres NOTIFY is attempted.
 *   - PRODUCTION passes sessionId (route.ts wiring confirmed by grep in Task 1
 *     and documented in the assertion at the bottom of this test).
 *
 * Test isolation (fs-seed harness — mirrors projector.test.ts):
 *   - mkdtempSync + vi.stubEnv('VAULT_CAMPAIGNS_ROOT', dir) + vi.resetModules
 *   - Seeds events.md with a campaign_initialized event (no encounter events).
 *   - Cleans up with rmSync + vi.unstubAllEnvs + vi.resetModules in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixed UUIDs — real UUIDs required by dispatchVaultTool's UUID guard
// (tools.ts:288 rejects non-UUIDs in campaignId).
// ---------------------------------------------------------------------------
const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const PC_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Damage-event types (REQ-047): none of these must appear in opener output.
// ---------------------------------------------------------------------------
const DAMAGE_EVENT_TYPES = new Set(['monster_hp_change', 'hp_change']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamic import helper — stubs VAULT_CAMPAIGNS_ROOT then re-imports all
 * relevant modules so path-at-load-time constants pick up the temp dir.
 */
async function importWithRoot(root: string) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  const [openerMod, bestiaryMod, toolsMod, projectorMod, pathsMod] = await Promise.all([
    import('@/app/api/sessions/[id]/turn/encounter-opener'),
    import('@/app/api/sessions/[id]/turn/monster-bestiary'),
    import('@/ai/master/vault/tools'),
    import('@/ai/master/vault/projector'),
    import('@/ai/master/vault/campaign-paths'),
  ]);
  return { openerMod, bestiaryMod, toolsMod, projectorMod, pathsMod };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('encounter opener wiring — REQ-045 / BLOCKER-1 acceptance', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gsd-opener-wiring-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * Seed a campaign dir with an events.md that contains ONLY a
   * campaign_initialized event — no encounter events. This mirrors the
   * pre-opener state (no active encounter) that the opener gate checks.
   */
  function seedCampaign(campaignDir: string, eventsPath: string): void {
    mkdirSync(campaignDir, { recursive: true });
    const seedEnvelope = {
      id: 'seed-event-001',
      version: 1,
      type: 'campaign_initialized',
      payload: {
        characters: [
          { id: PC_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
        ],
      },
      timestamp: '2026-05-31T20:00:00.000Z',
    };
    writeFileSync(eventsPath, JSON.stringify(seedEnvelope) + '\n', 'utf8');
  }

  // -------------------------------------------------------------------------
  // 1. WIRING — goblin spawns at real SRD hpMax (BLOCKER-1 acceptance test)
  // -------------------------------------------------------------------------

  it('goblin intent → monster_spawn.hpMax === 7 (REAL SRD value, not CR-default)', async () => {
    const { openerMod, bestiaryMod } = await importWithRoot(testRoot);
    const { runEncounterOpener } = openerMod;
    const { getBestiaryStatblock } = bestiaryMod;

    // Build a snapshot with one PC (party must be non-empty).
    const snap = { party: [{ id: PC_UUID, name: 'Aragorn' }] };

    // Compose exactly as route.ts does: pre-await the async statblock, then
    // inject a synchronous closure so the pure opener reads the REAL SRD values.
    const stats = await getBestiaryStatblock('goblin');
    // Sanity: the bestiary reader must have found the goblin file.
    expect(stats).not.toBeNull();
    expect(stats?.hpMax).toBe(7); // SRD goblin frontmatter: hpMax: 7

    const events = runEncounterOpener(snap, 'goblin', () => stats);

    // Should produce exactly [monster_spawn, initiative_set].
    expect(events).toHaveLength(2);

    const spawnEvent = events.find((e) => e.type === 'monster_spawn');
    expect(spawnEvent).toBeDefined();

    // BLOCKER-1 acceptance: hpMax MUST be the REAL bestiary value (7), not a
    // CR-default. If this is 11 it means the CR fallback fired (bestiary path
    // not wired); if 7 it proves the SRD path is live.
    expect(spawnEvent?.payload['hpMax']).toBe(7);
    // Forward ac from SRD frontmatter (ac: 15 for goblin).
    expect(spawnEvent?.payload['ac']).toBe(15);
    // Monster name preserved verbatim.
    expect(spawnEvent?.payload['name']).toBe('goblin');
  });

  // -------------------------------------------------------------------------
  // 2. INITIATIVE membership — PC UUID + monster id; length = party + 1
  // -------------------------------------------------------------------------

  it('initiative_set.order contains the PC UUID and the spawned monster id', async () => {
    const { openerMod, bestiaryMod } = await importWithRoot(testRoot);
    const { runEncounterOpener } = openerMod;
    const { getBestiaryStatblock } = bestiaryMod;

    const snap = { party: [{ id: PC_UUID, name: 'Aragorn' }] };
    const stats = await getBestiaryStatblock('goblin');
    const events = runEncounterOpener(snap, 'goblin', () => stats);

    const spawnEvent = events.find((e) => e.type === 'monster_spawn');
    const initiativeEvent = events.find((e) => e.type === 'initiative_set');

    expect(initiativeEvent).toBeDefined();

    const order = initiativeEvent?.payload['order'] as Array<{ actorId: string; initiative: number }>;
    expect(order).toBeDefined();

    // PC UUID must be in the initiative order.
    const actorIds = order.map((e) => e.actorId);
    expect(actorIds).toContain(PC_UUID);

    // The spawned monster's id (from monster_spawn) must also be in the order.
    const monsterId = spawnEvent?.payload['id'] as string;
    expect(monsterId).toBeDefined();
    expect(actorIds).toContain(monsterId);

    // Total order length = party size (1) + monster count (1).
    expect(order).toHaveLength(snap.party.length + 1);
  });

  // -------------------------------------------------------------------------
  // 3. REQ-047 — NO damage event on the opener turn
  // -------------------------------------------------------------------------

  it('opener emits NO damage events (REQ-047 invariant)', async () => {
    const { openerMod, bestiaryMod } = await importWithRoot(testRoot);
    const { runEncounterOpener } = openerMod;
    const { getBestiaryStatblock } = bestiaryMod;

    const snap = { party: [{ id: PC_UUID, name: 'Aragorn' }] };
    const stats = await getBestiaryStatblock('goblin');
    const events = runEncounterOpener(snap, 'goblin', () => stats);

    const damageEvents = events.filter((e) => DAMAGE_EVENT_TYPES.has(e.type));
    expect(damageEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. DISPATCH leg — headless path (no sessionId → no Postgres NOTIFY)
  // -------------------------------------------------------------------------

  it('headless dispatch: events land in events.md, encounter becomes active, no NOTIFY', async () => {
    const { openerMod, bestiaryMod, toolsMod, projectorMod, pathsMod } = await importWithRoot(testRoot);
    const { runEncounterOpener } = openerMod;
    const { getBestiaryStatblock } = bestiaryMod;
    const { dispatchVaultTool } = toolsMod;
    const { parseEventsFile, replayEvents } = projectorMod;
    const { eventsPath, campaignDir: getCampaignDir } = pathsMod;

    // Seed the campaign dir with campaign_initialized (no encounter).
    const campaignDirPath = getCampaignDir(CAMPAIGN_UUID);
    const evPath = eventsPath(CAMPAIGN_UUID);
    seedCampaign(campaignDirPath, evPath);

    // Verify pre-condition: no active encounter before opener.
    const preEnvelopes = await parseEventsFile(evPath);
    const { encounter: preEncounter } = replayEvents(preEnvelopes);
    expect(preEncounter.active).toBe(false);

    // Compose the opener exactly as route.ts does.
    const snap = { party: [{ id: PC_UUID, name: 'Aragorn' }] };
    const stats = await getBestiaryStatblock('goblin');
    const openerEvents = runEncounterOpener(snap, 'goblin', () => stats);
    expect(openerEvents.length).toBeGreaterThan(0);

    // Dispatch WITHOUT sessionId — emitStateRefresh is a no-op (tools.ts:200)
    // so no Postgres NOTIFY is attempted. This is the headless proof.
    // PRODUCTION passes sessionId (see route.ts ~398: { campaignId: campaign.id, sessionId }).
    for (const ev of openerEvents) {
      const result = await dispatchVaultTool(
        'apply_event',
        ev,
        { campaignId: CAMPAIGN_UUID }, // NO sessionId — headless
      );
      // Each dispatch must succeed (not isError).
      expect(result.isError).toBe(false);
    }

    // Re-read events.md and replay to assert the encounter is now active.
    const postEnvelopes = await parseEventsFile(evPath);
    const { encounter: postEncounter } = replayEvents(postEnvelopes);

    expect(postEncounter.active).toBe(true);

    // The initiative turnOrder must include the PC UUID and the monster id.
    const turnActorIds = postEncounter.turnOrder.map((e) => e.actorId);
    expect(turnActorIds).toContain(PC_UUID);
    // The monster id is the non-PC entry in the turnOrder.
    const monsterEntry = postEncounter.turnOrder.find((e) => e.actorId !== PC_UUID);
    expect(monsterEntry).toBeDefined();
    expect(postEncounter.monsters.some((m) => m.id === monsterEntry?.actorId)).toBe(true);

    // The goblin must be present with hpMax 7 (REAL SRD — BLOCKER-1 end-to-end proof).
    const goblin = postEncounter.monsters[0];
    expect(goblin).toBeDefined();
    expect(goblin?.hpMax).toBe(7);
    expect(goblin?.hpCurrent).toBe(7);
  });

  // -------------------------------------------------------------------------
  // 5. PRODUCTION sessionId assertion (documentation + hard assertion)
  // -------------------------------------------------------------------------

  it('PRODUCTION route passes sessionId to dispatchVaultTool (emitStateRefresh fires)', async () => {
    // This test asserts the production wiring by verifying the route.ts source
    // contains { campaignId: campaign.id, sessionId } at the opener dispatch
    // site. The headless test above intentionally omits sessionId; production
    // MUST include it so emitStateRefresh fires and the combat tracker updates.
    const { readFileSync } = await import('node:fs');
    const routeSrc = readFileSync(
      join(process.cwd(), 'src/app/api/sessions/[id]/turn/route.ts'),
      'utf8',
    );
    // The opener dispatch in route.ts must include sessionId alongside campaignId.
    // This assertion would fail if someone accidentally removes sessionId from
    // the opener dispatch (regressing emitStateRefresh on the vault path).
    expect(routeSrc).toMatch(/dispatchVaultTool\('apply_event',\s*ev,\s*\{\s*campaignId:\s*campaign\.id,\s*sessionId\s*\}/);
  });
});
