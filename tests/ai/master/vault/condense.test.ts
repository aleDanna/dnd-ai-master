/**
 * Phase 03-B plan 03-B-04 Task 2 — maybeCondense tests.
 *
 * Coverage map (mirrors the plan's acceptance_criteria + truths list):
 *
 *   estimateTokens (3 cases):
 *     - empty messages → 0
 *     - 4000-char message → ~1000 tokens (char/4 heuristic)
 *     - structured (array) content → JSON.stringify length / 4
 *
 *   maybeCondense — gating (5 cases):
 *     - below threshold → returns input unchanged + provider NOT called
 *     - MASTER_SUMMARIZATION=off → returns unchanged regardless of size
 *     - MASTER_SUMMARIZATION=false also disables (alias)
 *     - older slice empty (system + recent only) → returns unchanged
 *     - empty history → returns unchanged
 *
 *   maybeCondense — condensation path (5 cases):
 *     - above threshold → provider.completeMessage called once
 *     - condensed history shape = [system, summary-user, ...recent]
 *     - tokensAfter < tokensBefore (≥ 50% reduction)
 *     - Italian system prompt forwarded (REQ — CLAUDE.md)
 *     - model arg forwarded verbatim (REQ-034)
 *
 *   maybeCondense — env overrides (2 cases):
 *     - MASTER_SUMMARIZE_TRIGGER=1000 → fires at the lower threshold
 *     - MASTER_SUMMARIZE_KEEP_TURNS=1 → keeps only last 2 messages
 *
 *   Constants-as-functions (2 cases):
 *     - SUMMARIZE_TRIGGER_TOKENS() reflects env on each call (NIT 5)
 *     - SUMMARIZE_KEEP_TURNS() reflects env on each call (NIT 5)
 *
 *   maybeCondense — persistence (DB-gated, 2 cases):
 *     - writes summaryBlock { text, generatedAt, tokensBefore } to session_state
 *     - generatedAt is a valid ISO timestamp string
 *
 * No DATABASE_URL required for the unit suite: `@/db/client` is mocked
 * via `vi.mock` so the drizzle UPDATE inside `persistSummary` is a no-op
 * stub. The DB-gated section uses the real DB to validate persistence
 * end-to-end (skipped when DATABASE_URL is unset, matching the project
 * convention in `parity-check.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  ContentBlock,
  MasterProvider,
  Message,
  NormalizedUsage,
} from '@/ai/provider/types';

// ---------------------------------------------------------------------------
// Mock `@/db/client` for the unit suite. The DB-gated suite below opts back
// in by calling `vi.doUnmock` + re-importing.
// ---------------------------------------------------------------------------
//
// We hold a per-test mock for `db.update(...).set(...).where(...)` so each
// test can assert the persistSummary call shape without a real Postgres.
const dbUpdateMock = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/db/client', () => ({
  db: {
    update: dbUpdateMock,
  },
  pool: {},
  createListenClient: () => {
    throw new Error('not used in unit tests');
  },
}));

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Build a fresh mocked MasterProvider whose `completeMessage` returns a
 *  single text block with the provided string. The `vi.fn()` is exposed
 *  so callers can introspect call args. */
function mockProvider(summaryText: string = 'Riassunto: i pirati hanno preso il porto.'): MasterProvider {
  const completeMessage = vi.fn(async (_input: CompleteMessageInput): Promise<CompleteMessageOutput> => {
    const block: ContentBlock = { type: 'text', text: summaryText };
    return {
      contentBlocks: [block],
      stopReason: 'end_turn',
      usage: EMPTY_USAGE,
    };
  });
  return {
    name: 'local',
    completeMessage,
    async detectLanguage() { return null; },
    async proposeWizard() { return { toolInput: {}, usage: EMPTY_USAGE }; },
  } as unknown as MasterProvider;
}

/** A long-history fixture that easily exceeds the default 15K-token trigger.
 *  20 messages × 3500 chars ≈ 70K chars ≈ 17.5K tokens. */
function longHistory(): Message[] {
  return [
    { role: 'user', content: 'Inizio della campagna One Piece.' },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: 'x'.repeat(3500),
    })),
  ];
}

beforeEach(() => {
  dbUpdateMock.mockClear();
  vi.unstubAllEnvs();
  // Set defaults the kill switch + threshold need explicitly. The module
  // reads env on every invocation so per-test stubs take effect without
  // a `vi.resetModules()` dance.
  vi.stubEnv('MASTER_SUMMARIZATION', 'on');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------
describe('estimateTokens', () => {
  it('empty messages returns 0', async () => {
    const { estimateTokens } = await import('@/ai/master/vault/condense');
    expect(estimateTokens([])).toBe(0);
  });

  it('4000-char message approximates 1000 tokens (char/4 heuristic)', async () => {
    const { estimateTokens } = await import('@/ai/master/vault/condense');
    const msgs: Message[] = [{ role: 'user', content: 'x'.repeat(4000) }];
    expect(estimateTokens(msgs)).toBe(1000);
  });

  it('structured (array) content uses JSON.stringify length', async () => {
    const { estimateTokens } = await import('@/ai/master/vault/condense');
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tu_1', name: 'list_vault', input: { directory: '/handbook' } },
        ],
      },
    ];
    // JSON.stringify of the content array yields ~115 chars → ~29 tokens.
    const t = estimateTokens(msgs);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// maybeCondense — gating
// ---------------------------------------------------------------------------
describe('maybeCondense — gating', () => {
  it('returns unchanged when token count is below trigger', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const history: Message[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'reply' },
    ];
    const r = await maybeCondense(history, provider, 'qwen3:30b-a3b-instruct-2507', 'session-id');
    expect(r.condensed).toBe(false);
    expect(r.history).toBe(history); // same reference
    expect(r.tokensAfter).toBe(r.tokensBefore);
    expect(provider.completeMessage).not.toHaveBeenCalled();
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('returns unchanged when MASTER_SUMMARIZATION=off (kill switch)', async () => {
    vi.stubEnv('MASTER_SUMMARIZATION', 'off');
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const history = longHistory(); // would otherwise condense
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(false);
    expect(r.history).toBe(history);
    expect(provider.completeMessage).not.toHaveBeenCalled();
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('returns unchanged when MASTER_SUMMARIZATION=false (alias)', async () => {
    vi.stubEnv('MASTER_SUMMARIZATION', 'false');
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const history = longHistory();
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(false);
    expect(provider.completeMessage).not.toHaveBeenCalled();
  });

  it('returns unchanged when older slice is empty (system + recent only)', async () => {
    // 1 + 6 messages — keep count is 6 by default → older slice is empty.
    // Push the total well above 15K tokens (60K+ chars / 4 = 15K+ tokens).
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const history: Message[] = [
      { role: 'user', content: 'x'.repeat(30000) },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
        content: 'y'.repeat(6000),
      })),
    ];
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.tokensBefore).toBeGreaterThanOrEqual(15000);
    expect(r.condensed).toBe(false);
    expect(provider.completeMessage).not.toHaveBeenCalled();
  });

  it('returns unchanged when history is empty', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const r = await maybeCondense([], provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(false);
    expect(r.tokensBefore).toBe(0);
    expect(provider.completeMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maybeCondense — condensation path
// ---------------------------------------------------------------------------
describe('maybeCondense — condensation path', () => {
  it('calls provider.completeMessage exactly once when above threshold', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('Riassunto in italiano del passato turno.');
    const r = await maybeCondense(longHistory(), provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(true);
    expect(provider.completeMessage).toHaveBeenCalledTimes(1);
  });

  it('returns history shape [system, summary-as-user, ...recent]', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('Sintesi narrativa: i pirati salpano.');
    const history = longHistory();
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    // 1 system anchor + 1 summary user msg + 6 recent (keep=3 × 2)
    expect(r.history).toHaveLength(1 + 1 + 6);
    expect(r.history[0]).toBe(history[0]); // system anchor preserved by reference
    const summaryMsg = r.history[1];
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe('user');
    expect(typeof summaryMsg!.content).toBe('string');
    expect(summaryMsg!.content as string).toContain('[Riassunto dei turni precedenti]');
    expect(summaryMsg!.content as string).toContain('Sintesi narrativa');
    // Recent block is the LAST 6 from input history.
    const recentSlice = history.slice(-6);
    for (let i = 0; i < 6; i += 1) {
      expect(r.history[2 + i]).toBe(recentSlice[i]);
    }
  });

  it('produces a tokensAfter < tokensBefore (compression)', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    // Make the summary short on purpose so the compression is dramatic.
    const provider = mockProvider('Riassunto breve.');
    const r = await maybeCondense(longHistory(), provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(true);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    // The 6-message recent block (2k chars each) is ~12K chars / ~3K tokens.
    // The original was ~17.5K tokens. Roughly ≥ 50% reduction expected.
    const ratio = r.tokensAfter / r.tokensBefore;
    expect(ratio).toBeLessThan(0.5);
  });

  it('forwards the Italian system prompt to the provider (CLAUDE.md)', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    await maybeCondense(longHistory(), provider, 'qwen3', 'session-id');
    const calls = (provider.completeMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const input = calls[0]![0] as CompleteMessageInput;
    expect(Array.isArray(input.systemBlocks)).toBe(true);
    expect(input.systemBlocks.length).toBeGreaterThan(0);
    // At least one block must mention "italiano" (case-insensitive).
    const hasItalian = input.systemBlocks.some(
      (b) => typeof b.text === 'string' && /italiano/i.test(b.text),
    );
    expect(hasItalian).toBe(true);
    // And one must reference the 200-word cap (operator-visible contract).
    const hasCap = input.systemBlocks.some(
      (b) => typeof b.text === 'string' && /200 parole/i.test(b.text),
    );
    expect(hasCap).toBe(true);
  });

  it('forwards the SAME model arg to the provider (REQ-034)', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    await maybeCondense(longHistory(), provider, 'qwen3:30b-a3b-instruct-2507', 'session-id');
    const calls = (provider.completeMessage as ReturnType<typeof vi.fn>).mock.calls;
    const input = calls[0]![0] as CompleteMessageInput;
    expect(input.model).toBe('qwen3:30b-a3b-instruct-2507');
    // Also assert that NO other model was passed — only one call total.
    expect(provider.completeMessage).toHaveBeenCalledTimes(1);
  });

  it('forwards tools:[] and a sensible num_predict cap', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    await maybeCondense(longHistory(), provider, 'qwen3', 'session-id');
    const calls = (provider.completeMessage as ReturnType<typeof vi.fn>).mock.calls;
    const input = calls[0]![0] as CompleteMessageInput;
    expect(input.tools).toEqual([]);
    // ~200 words of Italian needs roughly 300-400 tokens of headroom.
    expect(input.maxTokens).toBeGreaterThanOrEqual(200);
    expect(input.maxTokens).toBeLessThanOrEqual(1024);
  });

  it('calls persistSummary (db.update) with the summary text', async () => {
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('La nave Going Merry salpa al tramonto.');
    await maybeCondense(longHistory(), provider, 'qwen3', 'session-id');
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// maybeCondense — env overrides (NIT 5)
// ---------------------------------------------------------------------------
describe('maybeCondense — env overrides', () => {
  it('respects MASTER_SUMMARIZE_TRIGGER=1000 (fires at lower threshold)', async () => {
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '1000');
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('mini-summary');
    // History totalling ~3K tokens — well above 1000 but below 15000.
    const history: Message[] = [
      { role: 'user', content: 'a'.repeat(3000) },
      { role: 'assistant', content: 'b'.repeat(2500) },
      { role: 'user', content: 'c'.repeat(2000) },
      { role: 'assistant', content: 'd'.repeat(1500) },
      { role: 'user', content: 'e'.repeat(1500) },
      { role: 'assistant', content: 'f'.repeat(1500) },
      { role: 'user', content: 'g'.repeat(800) },
      { role: 'assistant', content: 'h'.repeat(800) },
    ];
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(true);
    expect(provider.completeMessage).toHaveBeenCalledTimes(1);
  });

  it('respects MASTER_SUMMARIZE_KEEP_TURNS=1 (keeps only last 2 messages)', async () => {
    vi.stubEnv('MASTER_SUMMARIZE_KEEP_TURNS', '1');
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('summary text');
    const history = longHistory();
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    // 1 system + 1 summary + 2 recent (keep=1 × 2)
    expect(r.history).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Constants-as-functions (NIT 5 — read env on each invocation)
// ---------------------------------------------------------------------------
describe('SUMMARIZE_TRIGGER_TOKENS / SUMMARIZE_KEEP_TURNS', () => {
  it('SUMMARIZE_TRIGGER_TOKENS() reflects env on every call', async () => {
    const mod = await import('@/ai/master/vault/condense');
    // Default
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '');
    expect(mod.SUMMARIZE_TRIGGER_TOKENS()).toBe(15000);
    // Overridden
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '8000');
    expect(mod.SUMMARIZE_TRIGGER_TOKENS()).toBe(8000);
    // Re-overridden in the same module instance (NIT 5: NO module-load cache).
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '42');
    expect(mod.SUMMARIZE_TRIGGER_TOKENS()).toBe(42);
  });

  it('SUMMARIZE_KEEP_TURNS() reflects env on every call', async () => {
    const mod = await import('@/ai/master/vault/condense');
    vi.stubEnv('MASTER_SUMMARIZE_KEEP_TURNS', '');
    expect(mod.SUMMARIZE_KEEP_TURNS()).toBe(3);
    vi.stubEnv('MASTER_SUMMARIZE_KEEP_TURNS', '5');
    expect(mod.SUMMARIZE_KEEP_TURNS()).toBe(5);
    vi.stubEnv('MASTER_SUMMARIZE_KEEP_TURNS', '1');
    expect(mod.SUMMARIZE_KEEP_TURNS()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB-gated persistence — round-trip the summaryBlock through Postgres.
// ---------------------------------------------------------------------------
const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('maybeCondense — persistence (DB-gated)', () => {
  // We cannot import the real `@/db/client` while the unit mock is in
  // place above, so we use `vi.doUnmock` + `vi.resetModules()` inside
  // beforeAll. This keeps the unit suite hermetic AND lets the DB suite
  // exercise the real drizzle UPDATE.
  let db: typeof import('@/db/client').db;
  let pool: typeof import('@/db/client').pool;
  let schema: typeof import('@/db/schema');
  let maybeCondense: typeof import('@/ai/master/vault/condense').maybeCondense;
  // Stable suite-scoped IDs.
  const TEST_USER = 'user_condense_' + Date.now();
  const CAMPAIGN_UUID = '88888888-7777-6666-5555-444444444444';
  const CHAR_UUID = '99999999-8888-7777-6666-555555555555';
  let SESSION_ID = '';

  beforeAll(async () => {
    vi.doUnmock('@/db/client');
    vi.resetModules();
    const dbMod = await import('@/db/client');
    schema = await import('@/db/schema');
    const condenseMod = await import('@/ai/master/vault/condense');
    db = dbMod.db;
    pool = dbMod.pool;
    maybeCondense = condenseMod.maybeCondense;

    // Fixture chain: user → character → campaign → session → session_state.
    // Raw-SQL character insert bypasses the broken saveCharacter pipeline
    // (`src/characters/derive.ts` is in an unresolved merge state — same
    // workaround as `parity-check.test.ts`).
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
        ${CHAR_UUID}, ${TEST_USER}, 'CondenseChar', 1, 0,
        'human', 'fighter', 'soldier',
        ${JSON.stringify({ STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 })}::jsonb,
        2, 30, 10, 30,
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
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        id: CAMPAIGN_UUID,
        userId: TEST_USER,
        name: 'Condense test campaign',
        premise: 'fixture',
      })
      .returning();
    expect(campaign).toBeDefined();
    const [session] = await db
      .insert(schema.sessions)
      .values({
        userId: TEST_USER,
        characterId: CHAR_UUID,
        campaignId: CAMPAIGN_UUID,
        premise: 'fixture',
      })
      .returning();
    if (!session) throw new Error('session insert returned nothing');
    SESSION_ID = session.id;
    // Minimal session_state row — primary key is sessionId.
    await db.insert(schema.sessionState).values({
      sessionId: SESSION_ID,
      hpCurrent: 30,
      hitDiceRemaining: 1,
    });
  });

  afterAll(async () => {
    // Reverse-FK order cleanup.
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`).catch(() => undefined);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`).catch(() => undefined);
    await db.execute(sql`delete from campaigns where user_id = ${TEST_USER}`).catch(() => undefined);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`).catch(() => undefined);
    await db.execute(sql`delete from users where id = ${TEST_USER}`).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('writes summaryBlock { text, generatedAt, tokensBefore } to session_state', async () => {
    const provider = mockProvider('Riassunto persistente: la nave entra in porto.');
    const r = await maybeCondense(longHistory(), provider, 'qwen3', SESSION_ID);
    expect(r.condensed).toBe(true);

    const [row] = await db
      .select({ summaryBlock: schema.sessionState.summaryBlock })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    expect(row).toBeDefined();
    expect(row!.summaryBlock).toBeTruthy();
    const block = row!.summaryBlock!;
    expect(block.text).toContain('Riassunto persistente');
    expect(typeof block.tokensBefore).toBe('number');
    expect(block.tokensBefore).toBeGreaterThan(15000);
    expect(typeof block.generatedAt).toBe('string');
  });

  it('generatedAt is a valid ISO timestamp', async () => {
    const provider = mockProvider('Altro riassunto.');
    await maybeCondense(longHistory(), provider, 'qwen3', SESSION_ID);
    const [row] = await db
      .select({ summaryBlock: schema.sessionState.summaryBlock })
      .from(schema.sessionState)
      .where(eq(schema.sessionState.sessionId, SESSION_ID));
    const ts = row!.summaryBlock!.generatedAt;
    // Re-parsing the ISO string and re-serializing should round-trip.
    const parsed = new Date(ts);
    expect(parsed.toString()).not.toBe('Invalid Date');
    expect(parsed.toISOString()).toBe(ts);
  });
});
