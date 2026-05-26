/**
 * Phase 03-A plan 03-A-10 task 3 — end-to-end gated dual-write test.
 *
 * Covers the wire-up that closes REQ-006: turn-route resolves the
 * `dualWrite` campaign flag, forwards it through `runVaultToolLoop`,
 * `dispatchVaultTool`'s `apply_event` branch consults it and routes
 * through `dualWriteApplyEvent` (parallel vault + Postgres write +
 * synchronous parity-check + fire-and-forget divergence record).
 *
 * Why this file does NOT invoke the actual POST handler
 * --------------------------------------------------------------------------
 * The POST handler in `src/app/api/sessions/[id]/turn/route.ts` requires
 * Clerk `auth()`, a live SSE notify channel, and an LLM provider stub
 * with the right tool_use sequence. The existing Phase 02 gate test
 * (`tests/sessions/vault-mutations-gate.test.ts`) follows the same pattern
 * of unit-testing the decision logic + the inputs the vault branch passes
 * to the loop. This file extends that pattern: it stubs the
 * `MasterProvider.completeMessage` response, runs `runVaultToolLoop`, and
 * verifies the observable side-effects (events.md content, Postgres
 * column state, dual_write_divergences row presence).
 *
 * Coverage matrix:
 *   1. dualWrite=false → Phase 02 single-write — events.md grows but
 *      Postgres session_state hp_current UNCHANGED.
 *   2. dualWrite=true synchronized — both stores update; NO audit row.
 *   3. dualWrite=true pre-existing mismatch → divergence audit insert.
 *   4. dualWrite=true defensive fallback — when route forgets sessionId,
 *      the dispatcher falls through to Phase 02 path (vault-only).
 *
 * Skip-all-cases when DATABASE_URL is absent (mirrors dual-writer.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import type { MasterProvider, CompleteMessageInput, CompleteMessageOutput } from '@/ai/provider/types';

const HAS_DB = !!process.env.DATABASE_URL;

// Stub VAULT_CAMPAIGNS_ROOT BEFORE module load — campaign-paths reads it
// at module-load via the constant export from `./path`. Same pattern as
// `dual-writer.test.ts`.
const TEST_VAULT_ROOT = HAS_DB
  ? mkdtempSync(join(tmpdir(), 'turn-route-dual-write-test-'))
  : '';
if (HAS_DB) {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', TEST_VAULT_ROOT);
}

// Stable UUIDs for the suite — easier to grep + reproduce.
const CAMPAIGN_UUID = '78787878-9090-1212-3434-565656565656';
const CHAR_UUID = '23232323-4545-6767-8989-0a0a0a0a0a0a';

/**
 * Minimal stub MasterProvider that emits exactly one `apply_event` tool
 * call followed by `end_turn`. The test then verifies side-effects on
 * vault + Postgres rather than the loop output itself.
 *
 * The factory closes over `applyEventInput` so each test can craft the
 * exact payload it wants. `iter` tracks the call count so the second
 * iteration emits the terminator (mirrors how a real provider would
 * stop calling tools after seeing the apply_event result).
 */
function stubProvider(applyEventInput: { type: string; payload: Record<string, unknown> }): MasterProvider {
  let iter = 0;
  return {
    name: 'anthropic',
    detectLanguage: async () => null,
    proposeWizard: async () => ({ toolInput: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    completeMessage: async (_input: CompleteMessageInput): Promise<CompleteMessageOutput> => {
      iter += 1;
      if (iter === 1) {
        // First call: emit apply_event tool_use.
        return {
          contentBlocks: [
            {
              type: 'tool_use',
              id: `tu-apply-${iter}`,
              name: 'apply_event',
              input: applyEventInput,
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      }
      // Subsequent calls: terminate via end_turn so the loop exits cleanly.
      return {
        contentBlocks: [
          {
            type: 'tool_use',
            id: `tu-end-${iter}`,
            name: 'end_turn',
            input: { response: 'fixture turn done' },
          },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    },
  };
}

(HAS_DB ? describe : describe.skip)('turn-route dual-write — runVaultToolLoop gating', () => {
  const TEST_USER = 'user_dwroute_' + Date.now();
  let SESSION_ID = '';
  let db: typeof import('@/db/client').db;
  let pool: typeof import('@/db/client').pool;
  let schema: typeof import('@/db/schema');
  let runVaultToolLoop: typeof import('@/ai/master/vault/loop').runVaultToolLoop;
  let EventsWriter: typeof import('@/ai/master/vault/events-writer').EventsWriter;
  let eventsFilePath: string;
  let campaignDirPath: string;

  beforeAll(async () => {
    vi.resetModules();
    const dbMod = await import('@/db/client');
    schema = await import('@/db/schema');
    const loopMod = await import('@/ai/master/vault/loop');
    const writerMod = await import('@/ai/master/vault/events-writer');
    const pathsMod = await import('@/ai/master/vault/campaign-paths');
    db = dbMod.db;
    pool = dbMod.pool;
    runVaultToolLoop = loopMod.runVaultToolLoop;
    EventsWriter = writerMod.EventsWriter;
    eventsFilePath = pathsMod.eventsPath(CAMPAIGN_UUID);
    campaignDirPath = join(TEST_VAULT_ROOT, CAMPAIGN_UUID);

    // === Postgres fixture (raw SQL bypasses the broken saveCharacter
    // pipeline; same workaround as dual-writer.test.ts). ===
    await db.execute(sql`
      insert into users (id) values (${TEST_USER})
      on conflict (id) do nothing
    `);

    await db.execute(sql`
      insert into characters (
        id, user_id, name, level, xp,
        race_slug, class_slug, background_slug,
        abilities, proficiency_bonus, hp_max, ac, speed,
        proficiencies, identity, hit_dice_max, hit_die_size,
        spellcasting, spell_slots_used, resources_used,
        inventory, attuned_items, inspiration
      ) values (
        ${CHAR_UUID}, ${TEST_USER}, 'Frodo', 1, 0,
        'halfling', 'rogue', 'criminal',
        ${JSON.stringify({ STR: 10, DEX: 14, CON: 12, INT: 12, WIS: 12, CHA: 12 })}::jsonb,
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
        name: 'TurnRoute DualWrite fixture',
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
    await db.execute(sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`);
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
   * Reset between cases: wipe events.md + reset Postgres state to baseline
   * (hp_current=30) + clear audit rows. Seeds vault with a
   * campaign_initialized event so `parityCheck` has a vault state to read
   * (without it, parityCheck returns null and dual-write never sees a
   * "divergence" even when Postgres + vault disagree).
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
      })
      .where(eq(schema.characters.id, CHAR_UUID));
    await db.execute(sql`delete from dual_write_divergences where session_id = ${SESSION_ID}`);
  });

  /**
   * Pre-seed events.md with a campaign_initialized event so parityCheck
   * has a vault state to compare. Mirrors the fixture in
   * dual-writer.test.ts seedVault().
   */
  async function seedVault(): Promise<void> {
    await EventsWriter.applyEvent(eventsFilePath, {
      id: '00000000-aaaa-bbbb-cccc-000000000001',
      version: 1,
      type: 'campaign_initialized',
      payload: {
        characters: [
          {
            id: CHAR_UUID,
            name: 'Frodo',
            hp_max: 30,
            hp_current: 30,
          },
        ],
      },
      timestamp: '2026-05-27T00:00:00.000Z',
    });
  }

  // ============================================================
  // 1. dualWrite=false (Phase 02 single-write) — Postgres untouched
  // ============================================================

  it('dualWrite=false → Phase 02 single-write (events.md grows, Postgres untouched)', async () => {
    await seedVault();
    // The applicator's pre-call hpCurrent = 30. After this loop the LLM
    // emits hp_change(-5). In Phase 02 single-write mode the vault
    // appends the event (regen + projector takes hp_current → 25) but
    // Postgres session_state stays at 30.
    const result = await runVaultToolLoop({
      provider: stubProvider({
        type: 'hp_change',
        payload: { character: CHAR_UUID, delta: -5 },
      }),
      systemBlocks: [{ type: 'text', text: 'fixture system' }],
      history: [{ role: 'user', content: 'Apply 5 damage' }],
      campaignId: CAMPAIGN_UUID,
      // dualWrite NOT forwarded → defaults to undefined (Phase 02 path).
      sessionId: SESSION_ID,
    });

    expect(result.finalText).toBe('fixture turn done');
    expect(result.timedOut).toBe(false);

    // Vault side: events.md should have the seed + the new hp_change.
    expect(existsSync(eventsFilePath)).toBe(true);
    const eventsContent = readFileSync(eventsFilePath, 'utf-8');
    expect(eventsContent).toMatch(/hp_change/);

    // Postgres side: hp_current MUST STILL BE 30 — Phase 02 doesn't
    // touch session_state on apply_event.
    const [pgState] = await db
      .select({ hpCurrent: schema.sessionState.hpCurrent })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    expect(pgState?.hpCurrent).toBe(30);

    // And NO audit row — parity-check never runs without dual-write.
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 2. dualWrite=true synchronized — both stores update, no audit row
  // ============================================================

  it('dualWrite=true synchronized → both stores update, no audit row', async () => {
    await seedVault();
    // Vault baseline: hp_current = 30 (from seed). The LLM emits
    // hp_change(-5). Dual-write fans the call out:
    //   - vault appends + projects → hp_current = 25
    //   - Postgres callback (event-to-engine-mutation hp_change arm) →
    //     session_state.hp_current = 25 (clamped to [0, hp_max=30])
    // parity-check sees both sides at 25 → no divergence, no audit row.
    const result = await runVaultToolLoop({
      provider: stubProvider({
        type: 'hp_change',
        payload: { character: CHAR_UUID, delta: -5 },
      }),
      systemBlocks: [{ type: 'text', text: 'fixture system' }],
      history: [{ role: 'user', content: 'Apply 5 damage' }],
      campaignId: CAMPAIGN_UUID,
      dualWrite: true,
      sessionId: SESSION_ID,
    });

    expect(result.finalText).toBe('fixture turn done');

    // Vault: hp_change present.
    const eventsContent = readFileSync(eventsFilePath, 'utf-8');
    expect(eventsContent).toMatch(/hp_change/);

    // Postgres: hp_current updated to 25 via invokeEnginePathwayFromEvent.
    const [pgState] = await db
      .select({ hpCurrent: schema.sessionState.hpCurrent })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    expect(pgState?.hpCurrent).toBe(25);

    // Wait briefly for any fire-and-forget audit to settle (there should be none).
    await new Promise((r) => setTimeout(r, 100));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });

  // ============================================================
  // 3. dualWrite=true pre-existing mismatch → divergence audit row
  // ============================================================

  it('dualWrite=true with pre-existing mismatch → divergence audit row inserted', async () => {
    await seedVault();
    // Pre-existing mismatch: directly bump Postgres hp_current to 99
    // (a value vault never sees) BEFORE the loop runs. Now when the
    // LLM emits hp_change(0) (a no-op delta), the dual-write fans:
    //   - vault appends, projects to 30 (seed) + 0 → 30
    //   - Postgres callback (hp_change delta=0) → hp_current = clamp(99 + 0) = 30
    //     (the engine pathway READS pg hp + applies delta; with delta=0
    //     starting from 99 the next value is 30, because the clamp uses
    //     hp_max=30 as the upper bound — Math.min(30, 99+0)=30.)
    //
    // So this case actually demonstrates that hp_change DOES bring
    // Postgres back into sync (the projector + clamp converge). The
    // divergence we want to provoke is NOT through the dual-write event
    // path itself — it's a divergence that exists BEFORE the event lands.
    //
    // Better approach: skip seedVault() so the vault has NO events.md
    // (parityCheck Skip 2: campaign not on vault yet → returns null →
    // no audit row, even though Postgres is out of sync). That actually
    // proves the OTHER half of the contract: parity-check is robust to
    // skip cases.
    //
    // To force a real divergence: emit an event where event-to-engine-
    // mutation is a NO-OP (e.g., focus_set targets equipped_focus on
    // characters; but parityCheck doesn't yet diff equipped_focus, so it
    // won't see the divergence either). The cleanest forced-divergence is
    // condition_add: vault's projector adds 'prone' to conditions; the
    // Postgres callback also adds it (same slug). To force divergence we
    // PRE-WRITE a different condition into Postgres so the arrays diverge
    // after the event.
    //
    // Easiest provocation: seed vault, then before the loop runs, write
    // hp_current = 1 directly to Postgres. The LLM emits hp_change(-5):
    //   vault: 30 (seed) - 5 → 25
    //   pg callback reads hp=1 + delta=-5 → clamp(0, max(0, 1-5)) = 0
    //   → parity diff: vault hp_current=25, pg hp_current=0 → divergence.
    await db
      .update(schema.sessionState)
      .set({ hpCurrent: 1 })
      .where(eq(schema.sessionState.sessionId, SESSION_ID));

    const result = await runVaultToolLoop({
      provider: stubProvider({
        type: 'hp_change',
        payload: { character: CHAR_UUID, delta: -5 },
      }),
      systemBlocks: [{ type: 'text', text: 'fixture system' }],
      history: [{ role: 'user', content: 'Apply 5 damage' }],
      campaignId: CAMPAIGN_UUID,
      dualWrite: true,
      sessionId: SESSION_ID,
    });

    expect(result.finalText).toBe('fixture turn done');

    // Vault: hp_current projects to 25 after the event.
    // Postgres: hp_current clamped to 0 (cur=1, delta=-5 → max(0, -4) = 0).
    const [pgState] = await db
      .select({ hpCurrent: schema.sessionState.hpCurrent })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    expect(pgState?.hpCurrent).toBe(0);

    // Wait for the fire-and-forget audit insert.
    await new Promise((r) => setTimeout(r, 250));
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const row = audit[audit.length - 1]!;
    expect(row.eventType).toBe('hp_change');
    expect(row.characterId).toBe(CHAR_UUID);
    expect(row.summary).toMatch(/hp_current/);
  });

  // ============================================================
  // 4. dualWrite=true defensive fallback — sessionId absent → Phase 02 path
  // ============================================================

  it('dualWrite=true without sessionId → falls back to Phase 02 path (vault-only)', async () => {
    await seedVault();
    // Construct the loop input WITHOUT sessionId. The dispatcher's gate
    // is `ctx.dualWrite === true && typeof ctx.sessionId === 'string'`;
    // when sessionId is missing, the dual-write branch is skipped and
    // the Phase 02 single-write path runs.
    //
    // We can't actually pass `dualWrite: true` without sessionId at the
    // loop level because the loop ALSO forwards sessionId from input.
    // The defensive fallthrough lives inside the dispatcher — to exercise
    // it we'd have to call dispatchVaultTool directly with a malformed
    // ctx. So we instead pass `sessionId: undefined` explicitly. The loop
    // forwards undefined; the dispatcher's `typeof ctx.sessionId !== 'string'`
    // check catches it and falls through.
    await db
      .update(schema.sessionState)
      .set({ hpCurrent: 30 })
      .where(eq(schema.sessionState.sessionId, SESSION_ID));

    // We need to manually invoke `dispatchVaultTool` with a malformed
    // context so the defensive fallthrough is exercised explicitly. The
    // loop sanitizes `sessionId` via input.sessionId, so a loop-level
    // omission and an explicit undefined have the same dispatcher
    // behavior (Phase 02 single-write).
    const { dispatchVaultTool } = await import('@/ai/master/vault/tools');
    const result = await dispatchVaultTool(
      'apply_event',
      {
        type: 'hp_change',
        payload: { character: CHAR_UUID, delta: -5 },
      },
      {
        campaignId: CAMPAIGN_UUID,
        dualWrite: true,
        // sessionId intentionally absent — defensive fallthrough.
        characterId: CHAR_UUID,
      },
    );

    expect(result.isError).toBe(false);
    // Vault appended via the Phase 02 path.
    const eventsContent = readFileSync(eventsFilePath, 'utf-8');
    expect(eventsContent).toMatch(/hp_change/);

    // Postgres untouched — fallthrough means no event-to-engine-mutation call.
    const [pgState] = await db
      .select({ hpCurrent: schema.sessionState.hpCurrent })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    expect(pgState?.hpCurrent).toBe(30);

    // And NO audit row — no parity-check ran.
    const audit = await db
      .select()
      .from(schema.dualWriteDivergences)
      .where(eq(schema.dualWriteDivergences.sessionId, SESSION_ID));
    expect(audit).toHaveLength(0);
  });
});
