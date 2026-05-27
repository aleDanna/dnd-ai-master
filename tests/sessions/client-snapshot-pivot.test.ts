/**
 * Phase 03-B plan 03-B-07 task 2 — buildClientSnapshot sourceOfTruth pivot.
 *
 * Coverage matrix (per the plan's must_haves.truths):
 *   1. sourceOfTruth='postgres' (default)
 *      → state read from session_state (Phase 02 behavior preserved).
 *   2. sourceOfTruth='vault' + events.md exists + character in seed
 *      → state materialized from events.md replay (hp_current proves it).
 *   3. sourceOfTruth='vault' but events.md MISSING
 *      → fallback to Postgres (no error, no UI break).
 *   4. sourceOfTruth='vault' but character NOT in seed
 *      → fallback to Postgres (defensive correctness).
 *   5. sourceOfTruth='vault' + viewer has NO campaign-instance character
 *      → fallback to Postgres (legacy single-character sessions stay
 *        on Postgres until the campaign migration adds the viewer).
 *   6. After cutover, hp_current differs between Postgres (stale) and vault
 *      (current) → snapshot returns the vault value
 *      (proves the pivot is end-to-end and not just "reads Postgres twice").
 *   7. Snapshot shape unchanged across paths — same Object.keys regardless
 *      of which branch fires.
 *
 * Skips at runtime if DATABASE_URL is absent. Mirrors the raw-SQL +
 * tmpdir + vi.stubEnv fixture pattern from
 * tests/sessions/dual-writer.test.ts (the broken saveCharacter pipeline is
 * bypassed via raw SQL — see the sibling test for the same workaround).
 *
 * Why we stub VAULT_CAMPAIGNS_ROOT before any import: `campaign-paths.ts`
 * resolves the constant from `./path.ts` at top-level module load. Setting
 * the env var AFTER the import is too late — the value is captured at the
 * first require. The pattern (vi.stubEnv + vi.resetModules + dynamic
 * import inside beforeAll) is the same one used by dual-writer.test.ts
 * and tests/ai/master/vault/snapshot-reader.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

// Stub VAULT_CAMPAIGNS_ROOT BEFORE any module load. The campaign-paths
// module resolves the constant at top-level via `./path`, so the value
// MUST be set before the dynamic imports inside `beforeAll` execute.
const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'client-snapshot-pivot-test-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

// Stable UUIDs for grep + reproducibility. Distinct from sibling tests so
// a parallel run can't cross-pollute even if VAULT_CAMPAIGNS_ROOT collides
// (mkdtempSync produces unique dirs per call, but distinct UUIDs make the
// intent obvious in failure output).
const CAMPAIGN_UUID = '70707070-1717-2828-3939-cafecafecafe';
const CHAR_UUID = 'ab777777-1234-5678-9abc-def012345678';
const OTHER_CHAR_UUID = 'cc888888-1234-5678-9abc-def012345678';

(HAS_DB ? describe : describe.skip)('buildClientSnapshot — sourceOfTruth pivot', () => {
  const TEST_USER = 'user_csp_' + Date.now();
  let SESSION_ID = '';
  // Bindings resolved AFTER the env stub has taken effect.
  let db: typeof import('@/db/client').db;
  let pool: typeof import('@/db/client').pool;
  let schema: typeof import('@/db/schema');
  let buildClientSnapshot: typeof import('@/sessions/client-snapshot').buildClientSnapshot;
  let campaignDirPath: string;
  let eventsFilePath: string;

  beforeAll(async () => {
    vi.resetModules();
    const dbMod = await import('@/db/client');
    schema = await import('@/db/schema');
    const builderMod = await import('@/sessions/client-snapshot');
    const pathsMod = await import('@/ai/master/vault/campaign-paths');
    db = dbMod.db;
    pool = dbMod.pool;
    buildClientSnapshot = builderMod.buildClientSnapshot;
    campaignDirPath = pathsMod.campaignDir(CAMPAIGN_UUID);
    eventsFilePath = pathsMod.eventsPath(CAMPAIGN_UUID);

    // === Postgres fixture ===
    // FK order matters: users → campaigns → characters (campaign_id FK)
    //                 → sessions → session_state.
    //
    // User row (the snapshot builder's `userId` argument matches this id).
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    // Campaign row FIRST — characters.campaign_id has an FK to campaigns.id.
    // Settings default to {} so sourceOfTruth resolves to 'postgres' until
    // each test mutates it.
    await db
      .insert(schema.campaigns)
      .values({
        id: CAMPAIGN_UUID,
        userId: TEST_USER,
        name: 'Pivot test campaign',
        premise: 'fixture',
      })
      .returning();

    // Two characters (template + campaign-instance) for the viewer. The
    // builder picks the campaign-instance via the templateId-IS-NOT-NULL
    // + userId match. Raw SQL bypasses the broken saveCharacter pipeline
    // (see deferred-items.md — same workaround dual-writer.test.ts uses).
    const TEMPLATE_UUID = 'aa111111-1234-5678-9abc-def012345678';
    await db.execute(sql`
      insert into characters (
        id, user_id, name, level, xp,
        race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size,
        spellcasting, spell_slots_used, resources_used,
        inventory, attuned_items, inspiration
      ) values (
        ${TEMPLATE_UUID}, ${TEST_USER}, 'Aragorn Template', 1, 0,
        'half-elf', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 })}::jsonb,
        2, 30, 14, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 10,
        ${JSON.stringify(null)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify([])}::jsonb,
        ${JSON.stringify([])}::jsonb,
        false
      )
    `);

    // Campaign-instance character (the viewer's PG): templateId points
    // at the template, campaignId set to CAMPAIGN_UUID.
    await db.execute(sql`
      insert into characters (
        id, user_id, name, level, xp,
        race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size,
        spellcasting, spell_slots_used, resources_used,
        inventory, attuned_items, inspiration,
        template_id, campaign_id
      ) values (
        ${CHAR_UUID}, ${TEST_USER}, 'Aragorn', 1, 0,
        'half-elf', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 })}::jsonb,
        2, 30, 14, 30,
        ${JSON.stringify({ saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] })}::jsonb,
        ${JSON.stringify({ alignment: 'neutral' })}::jsonb,
        1, 10,
        ${JSON.stringify(null)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${JSON.stringify([])}::jsonb,
        ${JSON.stringify([])}::jsonb,
        false,
        ${TEMPLATE_UUID}, ${CAMPAIGN_UUID}
      )
    `);

    // Session row tied to the campaign + template character. The builder
    // resolves the viewer's CHAR_UUID via the campaign-instance query.
    const [s] = await db
      .insert(schema.sessions)
      .values({
        userId: TEST_USER,
        characterId: TEMPLATE_UUID,
        campaignId: CAMPAIGN_UUID,
        premise: 'fixture',
      })
      .returning();
    if (!s) throw new Error('session insert failed');
    SESSION_ID = s.id;

    // session_state row — the "Postgres" path returns from here. Baseline
    // hp_current=25 so tests can prove vault vs Postgres values differ.
    await db.insert(schema.sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 25,
      hitDiceRemaining: 1,
    });
  });

  afterAll(async () => {
    // Reverse-FK order: session_state, then sessions, then characters, then
    // campaigns, then the user. Vault dir cleanup last (fs ops are
    // independent of DB).
    if (SESSION_ID) {
      await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    }
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    if (existsSync(TEST_VAULT_ROOT)) {
      rmSync(TEST_VAULT_ROOT, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    await pool.end();
  });

  /**
   * Reset to baseline before every test:
   *  - Vault: no events.md (rmdir if it exists from a prior test).
   *  - Campaign settings: empty (sourceOfTruth defaults to 'postgres').
   *  - session_state: hp_current = 25 (Postgres baseline).
   *
   * Each test then mutates whatever it needs (campaign settings, vault
   * seed) and asserts the resulting snapshot value.
   */
  beforeEach(async () => {
    if (existsSync(campaignDirPath)) {
      rmSync(campaignDirPath, { recursive: true, force: true });
    }
    await db
      .update(schema.campaigns)
      .set({ settings: {} })
      .where(eq(schema.campaigns.id, CAMPAIGN_UUID));
    await db
      .update(schema.sessionState)
      .set({ hpCurrent: 25 })
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
  });

  /**
   * Write a campaign_initialized seed directly to events.md. We avoid
   * dispatchVaultTool here because this test exercises the READER
   * (buildClientSnapshot → materializeFromVault), not the writer. Direct
   * JSONL writes are byte-equivalent to what the writer would produce and
   * keep the test database-free for the vault half.
   */
  function seedEventsFile(opts: {
    hpCurrent?: number;
    characterIds?: string[];
    extraEvents?: Array<{ type: string; payload: Record<string, unknown>; idSuffix: string }>;
  } = {}): void {
    mkdirSync(campaignDirPath, { recursive: true });
    const charIds = opts.characterIds ?? [CHAR_UUID];
    const seedEnvelope = {
      id: '11111111-aaaa-bbbb-cccc-111111111111',
      version: 1,
      type: 'campaign_initialized',
      payload: {
        characters: charIds.map((id) => ({
          id,
          name: id === CHAR_UUID ? 'Aragorn' : 'Other',
          hp_max: 30,
          ...(opts.hpCurrent !== undefined && id === CHAR_UUID
            ? { hp_current: opts.hpCurrent }
            : {}),
        })),
      },
      timestamp: '2026-05-27T10:00:00.000Z',
    };
    const lines = [JSON.stringify(seedEnvelope)];
    for (const extra of opts.extraEvents ?? []) {
      lines.push(
        JSON.stringify({
          id: `22222222-aaaa-bbbb-cccc-${extra.idSuffix}`,
          version: 1,
          type: extra.type,
          payload: extra.payload,
          timestamp: '2026-05-27T10:01:00.000Z',
        }),
      );
    }
    writeFileSync(eventsFilePath, lines.join('\n') + '\n', 'utf8');
  }

  /**
   * Helper to set the campaign's sourceOfTruth setting in Postgres so
   * resolveSourceOfTruth(campaign.settings.sourceOfTruth) returns the
   * intended value at the next snapshot read.
   */
  async function setSourceOfTruth(value: 'postgres' | 'vault' | undefined): Promise<void> {
    const settings = value === undefined ? {} : { sourceOfTruth: value };
    await db
      .update(schema.campaigns)
      .set({ settings })
      .where(eq(schema.campaigns.id, CAMPAIGN_UUID));
  }

  // =========================================================================
  // Case 1 — sourceOfTruth='postgres' (default)
  // =========================================================================

  describe('sourceOfTruth=postgres (default)', () => {
    it('reads state from session_state when settings is empty', async () => {
      // No setSourceOfTruth call — settings = {} ⇒ resolveSourceOfTruth → 'postgres'.
      // Confirm by reading the campaign back.
      const [c] = await db
        .select({ settings: schema.campaigns.settings })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, CAMPAIGN_UUID))
        .limit(1);
      expect(c?.settings?.sourceOfTruth).toBeUndefined();

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      // Postgres value — set by the test fixture / beforeEach.
      expect(snap.state).not.toBeNull();
      expect(snap.state!.hpCurrent).toBe(25);
    });

    it('reads state from session_state when sourceOfTruth is explicitly "postgres"', async () => {
      await setSourceOfTruth('postgres');
      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state).not.toBeNull();
      expect(snap.state!.hpCurrent).toBe(25);
    });

    it('does NOT touch events.md when sourceOfTruth is postgres', async () => {
      // Seed events.md with a DIFFERENT hp_current (20) — if the pivot
      // misfires, the snapshot would return 20 instead of 25.
      seedEventsFile({ hpCurrent: 20 });
      await setSourceOfTruth('postgres');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      // Postgres baseline wins — the vault is ignored on this path.
      expect(snap.state!.hpCurrent).toBe(25);
    });
  });

  // =========================================================================
  // Case 2 — sourceOfTruth='vault' + events.md + character in seed
  // =========================================================================

  describe('sourceOfTruth=vault — vault materialization fires', () => {
    it('reads state from events.md when sourceOfTruth=vault', async () => {
      // Seed vault hp_current=20; Postgres remains at 25 from beforeEach.
      // The snapshot MUST return 20 to prove the pivot fired end-to-end.
      seedEventsFile({ hpCurrent: 20 });
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state).not.toBeNull();
      expect(snap.state!.hpCurrent).toBe(20);
    });

    it('vault hp_change events are reflected in the snapshot', async () => {
      // Seed at 30, then deal 7 damage in vault. Final vault state = 23.
      // Postgres stays at 25 (stale). Snapshot must show 23.
      seedEventsFile({
        hpCurrent: 30,
        extraEvents: [
          {
            type: 'hp_change',
            payload: { character: CHAR_UUID, delta: -7 },
            idSuffix: '000000000010',
          },
        ],
      });
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state!.hpCurrent).toBe(23);
    });

    it('returned snapshot has sessionId = the argument (echoed by translator)', async () => {
      seedEventsFile({ hpCurrent: 20 });
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state!.sessionId).toBe(SESSION_ID);
    });
  });

  // =========================================================================
  // Case 3 — sourceOfTruth=vault but events.md MISSING
  // =========================================================================

  describe('sourceOfTruth=vault fallback — events.md missing', () => {
    it('falls back to Postgres when events.md does not exist', async () => {
      // beforeEach removed the campaign dir, so events.md is missing.
      await setSourceOfTruth('vault');
      // Postgres value (25) is the only source — no error should bubble.
      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state).not.toBeNull();
      expect(snap.state!.hpCurrent).toBe(25);
    });
  });

  // =========================================================================
  // Case 4 — sourceOfTruth=vault but character NOT in seed
  // =========================================================================

  describe('sourceOfTruth=vault fallback — character not in seed', () => {
    it('falls back to Postgres when the viewer character is not seeded', async () => {
      // Seed events.md with a DIFFERENT character (OTHER_CHAR_UUID).
      // materializeFromVault for CHAR_UUID returns null → Postgres fallback.
      seedEventsFile({ hpCurrent: 20, characterIds: [OTHER_CHAR_UUID] });
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      // Postgres value wins — vault didn't know about CHAR_UUID.
      expect(snap.state!.hpCurrent).toBe(25);
    });

    it('falls back to Postgres when events.md is empty', async () => {
      // Create the campaign dir + empty events.md (the flip wrote a dir
      // but no seed yet — unlikely but cheap to cover).
      mkdirSync(campaignDirPath, { recursive: true });
      writeFileSync(eventsFilePath, '', 'utf8');
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      expect(snap.state!.hpCurrent).toBe(25);
    });
  });

  // =========================================================================
  // Case 5 — sourceOfTruth=vault + viewer has NO campaign-instance character
  // =========================================================================

  describe('sourceOfTruth=vault fallback — viewer has no character', () => {
    it('falls back to Postgres when the viewer is not part of the campaign party', async () => {
      // Spectator user: no character in this campaign at all. The builder's
      // campaign-instance query returns nothing → viewerChar is undefined
      // → the vault pivot does NOT fire (it requires the viewer's
      // own character to look up in the seed).
      const SPECTATOR_USER = 'spectator_csp_' + Date.now();
      await db.execute(sql`
        insert into users (id) values (${SPECTATOR_USER})
        on conflict (id) do nothing
      `);

      try {
        seedEventsFile({ hpCurrent: 20 });
        await setSourceOfTruth('vault');

        // Note: the snapshot still resolves a `character` field via the
        // legacy fallback (session.characterId → template character). The
        // STATE path, though, is the one that matters here — it must come
        // from Postgres because the viewer has no campaign-instance.
        const snap = await buildClientSnapshot(SESSION_ID, SPECTATOR_USER);
        expect(snap.state!.hpCurrent).toBe(25);
        // Sanity: viewerCharacterId is null (spectator).
        expect(snap.viewerCharacterId).toBeNull();
      } finally {
        await db.execute(sql`delete from users where id = ${SPECTATOR_USER}`);
      }
    });
  });

  // =========================================================================
  // Case 6 — Pivot proven end-to-end (stale Postgres vs current vault)
  // =========================================================================

  describe('end-to-end pivot — vault wins when sourceOfTruth=vault', () => {
    it('snapshot returns vault hp_current even when Postgres has a different (stale) value', async () => {
      // Postgres baseline = 25 (from beforeEach).
      // Vault current = 12 (seed + 18 damage).
      seedEventsFile({
        hpCurrent: 30,
        extraEvents: [
          {
            type: 'hp_change',
            payload: { character: CHAR_UUID, delta: -18 },
            idSuffix: '000000000099',
          },
        ],
      });
      await setSourceOfTruth('vault');

      const snap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      // 30 - 18 = 12. NOT 25 (Postgres) — proves the pivot is end-to-end.
      expect(snap.state!.hpCurrent).toBe(12);
    });
  });

  // =========================================================================
  // Case 7 — Snapshot shape unchanged across paths
  // =========================================================================

  describe('snapshot shape unchanged across paths', () => {
    it('top-level keys match between postgres and vault paths', async () => {
      // Postgres snapshot — no vault setup.
      await setSourceOfTruth('postgres');
      const pgSnap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      const pgTopKeys = Object.keys(pgSnap).sort();

      // Vault snapshot — same fixtures, vault seed in place.
      seedEventsFile({ hpCurrent: 20 });
      await setSourceOfTruth('vault');
      const vaultSnap = await buildClientSnapshot(SESSION_ID, TEST_USER);
      const vaultTopKeys = Object.keys(vaultSnap).sort();

      // The snapshot envelope (session, campaign, state, character, actors,
      // party, currentPlayerCharacterId, viewerCharacterId) is identical
      // across paths. UI consumers don't need branch-specific code.
      expect(vaultTopKeys).toEqual(pgTopKeys);
    });

    it('state field has the SessionState column set on both paths', async () => {
      // Same column names whether the state comes from a Postgres SELECT
      // or the vault translator. The shape gate is what lets the UI's
      // SessionStateRow consumer keep working unchanged.
      await setSourceOfTruth('postgres');
      const pgSnap = await buildClientSnapshot(SESSION_ID, TEST_USER);

      seedEventsFile({ hpCurrent: 20 });
      await setSourceOfTruth('vault');
      const vaultSnap = await buildClientSnapshot(SESSION_ID, TEST_USER);

      expect(pgSnap.state).not.toBeNull();
      expect(vaultSnap.state).not.toBeNull();

      // Key set comparison — both paths produce the same SessionState columns.
      const pgKeys = Object.keys(pgSnap.state!).sort();
      const vaultKeys = Object.keys(vaultSnap.state!).sort();
      // Every Postgres column should appear on the vault path (the
      // translator emits explicit defaults for every UI/scene field).
      for (const k of pgKeys) {
        expect(vaultKeys).toContain(k);
      }
    });
  });
});
