/**
 * Phase 03-A plan 03-A-09 task 3 — dualWriteApplyEvent integration tests.
 *
 * Coverage matrix:
 *   1. Happy path — vault + Postgres in sync, divergence=false, no audit row.
 *   2. Divergence detected — vault state ahead, divergence=true, audit row inserted.
 *   3. Vault write failure re-throws (no audit row).
 *   4. Postgres callback failure re-throws (no audit row).
 *   5. Parallel-timing — Promise.all confirmed via mocked delays.
 *   6. recordDivergence failure does NOT throw to caller (fire-and-forget).
 *   7. characterId === null skips parity-check + no audit row.
 *   8. 100 synced sequential writes produce 0 divergences (Phase gate baseline).
 *
 * Skips at runtime if DATABASE_URL absent. Uses the same raw-SQL +
 * tmpdir + vi.stubEnv fixture pattern as tests/ai/master/vault/parity-check.test.ts
 * (the broken saveCharacter pipeline is bypassed via raw SQL — see the
 * sibling test for the same workaround).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import type { VaultEventEnvelope } from '@/ai/master/vault/events-schema';

const HAS_DB = !!process.env.DATABASE_URL;

// Stub VAULT_CAMPAIGNS_ROOT BEFORE any module load. The campaign-paths
// module resolves the constant at top-level via `./path`, so the value
// must be set before the dynamic imports inside `beforeAll` execute.
const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'dual-writer-test-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

// Stable UUIDs for the suite — easier to grep + reproduce divergences.
const CAMPAIGN_UUID = '34343434-5656-7878-9a9a-bcbcbcbcbcbc';
const CHAR_UUID = 'cdcdcdcd-2222-3333-4444-555555555555';

(HAS_DB ? describe : describe.skip)('dualWriteApplyEvent', () => {
  const TEST_USER = 'user_dw_' + Date.now();
  let SESSION_ID = '';
  // Bindings resolved after the env stub took effect.
  let db: typeof import('@/db/client').db;
  let pool: typeof import('@/db/client').pool;
  let schema: typeof import('@/db/schema');
  let dualWriteApplyEvent: typeof import('@/sessions/dual-writer').dualWriteApplyEvent;
  let EventsWriter: typeof import('@/ai/master/vault/events-writer').EventsWriter;
  let campaignDirPath: string;
  let eventsFilePath: string;

  beforeAll(async () => {
    vi.resetModules();
    const dbMod = await import('@/db/client');
    schema = await import('@/db/schema');
    const dualWriterMod = await import('@/sessions/dual-writer');
    const writerMod = await import('@/ai/master/vault/events-writer');
    const pathsMod = await import('@/ai/master/vault/campaign-paths');
    db = dbMod.db;
    pool = dbMod.pool;
    dualWriteApplyEvent = dualWriterMod.dualWriteApplyEvent;
    EventsWriter = writerMod.EventsWriter;
    eventsFilePath = pathsMod.eventsPath(CAMPAIGN_UUID);
    campaignDirPath = join(TEST_VAULT_ROOT, CAMPAIGN_UUID);

    // === Postgres fixture ===
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Character — raw SQL bypasses the broken saveCharacter pipeline
    // (see deferred-items.md for the merge-conflict tracker).
    await db.execute(sql`
      insert into characters (
        id, user_id, name, level, xp,
        race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size,
        spellcasting, spell_slots_used, resources_used,
        inventory, attuned_items, inspiration
      ) values (
        ${CHAR_UUID}, ${TEST_USER}, 'Bilbo', 1, 0,
        'halfling', 'rogue', 'criminal',
        ${JSON.stringify({ STR: 10, DEX: 16, CON: 12, INT: 12, WIS: 12, CHA: 12 })}::jsonb,
        2, 30, 13, 25,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 8,
        ${JSON.stringify(null)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify([])}::jsonb,
        ${JSON.stringify([])}::jsonb,
        false
      )
    `);

    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        id: CAMPAIGN_UUID,
        userId: TEST_USER,
        name: 'DualWrite test campaign',
        premise: 'fixture',
      })
      .returning();
    if (!campaign) throw new Error('campaign insert failed');

    const [s] = await db
      .insert(schema.sessions)
      .values({
        userId: TEST_USER,
        characterId: CHAR_UUID,
        campaignId: CAMPAIGN_UUID,
        premise: 'fixture',
      })
      .returning();
    if (!s) throw new Error('session insert failed');
    SESSION_ID = s.id;

    await db.insert(schema.sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 30,
      hitDiceRemaining: 0,
    });
  });

  afterAll(async () => {
    // Reverse-FK order cleanup. dual_write_divergences first so the
    // sessions cascade doesn't race the explicit delete.
    await db.execute(
      sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`,
    );
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (existsSync(TEST_VAULT_ROOT)) {
      rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    await pool.end();
  });

  /**
   * Reset the vault state to "no events.md" + Postgres to baseline + clear
   * any audit rows from a prior test so each case is independent.
   *
   * Baseline:
   *   - vault: no events.md
   *   - postgres: hpCurrent=30, hp_max=30, no conditions/inventory/attunes,
   *               inspiration=false, spellcasting=null
   *   - audit: no rows for this session
   */
  beforeEach(async () => {
    if (existsSync(campaignDirPath)) {
      rmSync(campaignDirPath, { recursive: true, force: true });
    }
    await db
      .update(schema.sessionState)
      .set({
        hpCurrent: 30,
        tempHp: 0,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        flags: {},
        exhaustionLevel: 0,
        concentratingOn: null,
        hitDiceRemaining: 0,
        resourcesUsed: {},
      })
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    await db
      .update(schema.characters)
      .set({
        hpMax: 30,
        inventory: [],
        attunedItems: [],
        inspiration: false,
        spellcasting: null,
        spellSlotsUsed: {},
        resourcesUsed: {},
        xp: 0,
        level: 1,
      })
      .where(eq(schema.characters.id, CHAR_UUID));
    await db.execute(
      sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`,
    );
  });

  /**
   * Seed events.md via a direct EventsWriter call so the parityCheck has
   * vault state to compare. Each test that needs Postgres+vault parity
   * calls this with hp_max=30, hp_current=30 (matches Postgres baseline).
   */
  async function seedVault(): Promise<void> {
    mkdirSync(campaignDirPath, { recursive: true });
    const seedEnvelope: VaultEventEnvelope = {
      id: '00000000-aaaa-bbbb-cccc-000000000001',
      version: 1,
      type: 'campaign_initialized',
      payload: {
        characters: [
          {
            id: CHAR_UUID,
            name: 'Bilbo',
            hp_max: 30,
            hp_current: 30,
          },
        ],
      },
      timestamp: '2026-05-26T00:00:00.000Z',
    };
    await EventsWriter.applyEvent(eventsFilePath, seedEnvelope);
  }

  /**
   * Build an hp_change envelope for the test character. `delta` is the
   * HP change (negative for damage, positive for heal). The id varies per
   * call so events.md retains distinct lines.
   */
  function hpChangeEnvelope(delta: number, idSuffix = '0002'): VaultEventEnvelope {
    return {
      id: `00000000-aaaa-bbbb-cccc-00000000${idSuffix}`,
      version: 1,
      type: 'hp_change',
      payload: { character: CHAR_UUID, delta },
      timestamp: '2026-05-26T00:00:01.000Z',
    };
  }

  // ============================================================
  // 1. Happy path — vault + Postgres in sync
  // ============================================================

  it('happy path — vault + Postgres in sync, no divergence', async () => {
    await seedVault(); // Vault: hp_current=30
    // hp_change delta=-5: Vault projects to 25; Postgres also goes to 25.
    const envelope = hpChangeEnvelope(-5, '0010');
    const result = await dualWriteApplyEvent(
      envelope,
      async () => {
        await db
          .update(schema.sessionState)
          .set({ hpCurrent: 25 })
          .where(eq(schema.sessionState.sessionId, SESSION_ID));
      },
      { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
    );
    expect(result.divergence).toBe(false);
    expect(result.reason).toBeUndefined();
    // Allow any fire-and-forget catch to flush (defensive — there should
    // be no recordDivergence call on a happy path).
    await new Promise((r) => setTimeout(r, 50));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 2. Divergence detected — vault ahead of Postgres
  // ============================================================

  it('divergence detected — vault hp=25, postgres hp=30 (no-op pg mutation)', async () => {
    await seedVault();
    // Vault appends hp_change(-5) → projects to 25.
    // Postgres callback is a no-op → hpCurrent stays at 30.
    const result = await dualWriteApplyEvent(
      hpChangeEnvelope(-5, '0011'),
      async () => {
        /* no-op — simulates a Postgres mutation that didn't happen */
      },
      { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
    );
    expect(result.divergence).toBe(true);
    expect(result.reason).toMatch(/hp_current/);
    // Audit insert is fire-and-forget — wait briefly for the promise to
    // settle (the .catch chain queues on the microtask queue + DB latency).
    await new Promise((r) => setTimeout(r, 200));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const last = audit[audit.length - 1]!;
    expect(last.eventType).toBe('hp_change');
    expect(last.characterId).toBe(CHAR_UUID);
    expect(last.summary).toMatch(/hp_current/);
    expect((last.vaultState as { hp_current?: number }).hp_current).toBe(25);
    expect((last.postgresState as { hp_current?: number }).hp_current).toBe(30);
  });

  // ============================================================
  // 3. Vault write failure re-throws (no audit row)
  // ============================================================

  it('vault write failure re-throws (no audit row, no parity-check)', async () => {
    await seedVault();
    // Stub EventsWriter.applyEvent to reject — the parallel write fails.
    const spy = vi
      .spyOn(EventsWriter, 'applyEvent')
      .mockRejectedValueOnce(new Error('fs full'));
    let pgCalled = false;
    await expect(
      dualWriteApplyEvent(
        hpChangeEnvelope(-1, '0012'),
        async () => {
          pgCalled = true;
        },
        { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
      ),
    ).rejects.toThrow(/fs full/);
    spy.mockRestore();
    // The PG callback may have started (Promise.all runs in parallel) —
    // we don't assert pgCalled value, only that no audit row exists.
    void pgCalled;
    await new Promise((r) => setTimeout(r, 50));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 4. Postgres callback failure re-throws (no audit row)
  // ============================================================

  it('Postgres callback failure re-throws', async () => {
    await seedVault();
    await expect(
      dualWriteApplyEvent(
        hpChangeEnvelope(-1, '0013'),
        async () => {
          throw new Error('pg disconnect');
        },
        { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
      ),
    ).rejects.toThrow(/pg disconnect/);
    await new Promise((r) => setTimeout(r, 50));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 5. Parallel-timing — Promise.all confirmed via mocked delays
  // ============================================================

  it('parallel writes — Promise.all timing (elapsed ≈ max, not sum)', async () => {
    await seedVault();
    // Both legs sleep 300ms via explicit stubs. If the writes were
    // sequential, total ≥ 600 ms + downstream sync (parityCheck +
    // view regen ≈ 100-200 ms with Supabase round-trip). If parallel,
    // total ≈ 300 ms + downstream sync.
    //
    // Use stubs so the timing is INDEPENDENT of the real Postgres
    // latency: we measure the parallelism of the dispatcher, not the
    // DB round-trip variance. The downstream parityCheck + view-regen
    // run sequentially AFTER the parallel writes regardless.
    // Use 500 ms per leg so the parallel vs sequential delta dominates
    // the downstream parityCheck + view-regen latency over Supabase
    // (~200-400 ms typical). Sequential would be 1000 ms + downstream;
    // parallel ≈ 500 ms + downstream. A 900 ms threshold separates the
    // two regimes with comfortable margin on either side.
    const LEG_DELAY_MS = 500;
    const SEQ_FLOOR_MS = LEG_DELAY_MS * 2; // 1000 ms — sequential lower bound
    const vaultSpy = vi.spyOn(EventsWriter, 'applyEvent').mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, LEG_DELAY_MS));
      },
    );

    const start = Date.now();
    await dualWriteApplyEvent(
      hpChangeEnvelope(0, '0014'),
      async () => {
        await new Promise((r) => setTimeout(r, LEG_DELAY_MS));
      },
      { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
    );
    const elapsed = Date.now() - start;
    vaultSpy.mockRestore();

    // Assert strictly BELOW the sequential floor — proves Promise.all
    // dispatched both legs concurrently rather than awaiting them in
    // sequence. The downstream parityCheck + view-regen still add their
    // own latency on top of the parallel max, so we expect ~600-900 ms
    // observed on Supabase; any value < 1000 ms is impossible under
    // sequential dispatch.
    expect(elapsed).toBeLessThan(SEQ_FLOOR_MS);
  });

  // ============================================================
  // 6. recordDivergence failure does NOT throw to caller
  // ============================================================

  it('recordDivergence failure is non-fatal (fire-and-forget)', async () => {
    await seedVault();
    // Spy on the divergence-record module — its `recordDivergence` is
    // called from inside dualWriteApplyEvent's `void recordDivergence(...)`
    // site. Make it reject; the caller MUST NOT see the error.
    const divModule = await import('@/sessions/divergence-record');
    const spy = vi
      .spyOn(divModule, 'recordDivergence')
      .mockRejectedValueOnce(new Error('audit table down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Provoke a divergence: vault projects to 27, postgres stays at 30.
    const result = await dualWriteApplyEvent(
      hpChangeEnvelope(-3, '0015'),
      async () => {
        /* no-op pg mutation forces divergence */
      },
      { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
    );
    expect(result.divergence).toBe(true);
    // Wait for the detached `.catch` to handle the rejection.
    await new Promise((r) => setTimeout(r, 100));
    expect(errSpy).toHaveBeenCalledWith(
      '[dual-writer] recordDivergence failed:',
      'audit table down',
    );
    spy.mockRestore();
    errSpy.mockRestore();
  });

  // ============================================================
  // 7. characterId === null skips parity-check
  // ============================================================

  it('characterId === null skips parity-check (no audit row, divergence=false)', async () => {
    await seedVault();
    const result = await dualWriteApplyEvent(
      hpChangeEnvelope(-100, '0016'), // big delta — would normally diverge
      async () => {
        /* no-op pg mutation */
      },
      { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: null },
    );
    expect(result.divergence).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 8. 100 synced sequential writes produce 0 divergences (Phase gate)
  // ============================================================

  it('100 synced writes produce 0 divergences (Phase gate baseline)', async () => {
    await seedVault();
    // hpCurrent starts at 30 (postgres) + 30 (vault).
    // Each iteration emits a 0-delta hp_change — vault projects to 30,
    // postgres stays at 30. No divergence ever.
    //
    // Runtime budget: each iteration is ~200-300 ms over Supabase
    // (parityCheck round-trip dominates). 100 iterations × 300 ms =
    // ~30 s. Allow 90 s for CI variability + view-regen overhead.
    const ITERATIONS = 100;
    for (let i = 0; i < ITERATIONS; i++) {
      const sfx = (i + 1).toString(16).padStart(4, '0');
      await dualWriteApplyEvent(
        hpChangeEnvelope(0, sfx), // 0-delta no-op event
        async () => {
          /* no-op — Postgres stays at 30, which also matches vault */
        },
        { campaignId: CAMPAIGN_UUID, sessionId: SESSION_ID, characterId: CHAR_UUID },
      );
    }
    // Wait for any pending fire-and-forget audit writes (there should be none).
    await new Promise((r) => setTimeout(r, 500));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  }, 90_000);
});
