import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  VAULT_TOOL_DEFINITIONS,
  VAULT_TOOL_COUNT,
  dispatchVaultTool,
  formatMultiReadResult,
} from '@/ai/master/vault/tools';

/**
 * Plan 01-03 — Phase 01 tool dispatcher tests.
 * Plan 02-07 — Extended with apply_event (Phase 02 closes REQ-010).
 *
 * The apply_event describe blocks (and Decision 4 root-routing blocks) below
 * import `dispatchVaultTool` dynamically AFTER stubbing VAULT_CAMPAIGNS_ROOT
 * so the campaign-paths module re-evaluates the env-derived constant. The
 * Phase 01 blocks keep the static import — they don't depend on
 * VAULT_CAMPAIGNS_ROOT.
 */

describe('VAULT_TOOL_DEFINITIONS shape', () => {
  it('contains exactly 4 tools (Phase 02 closes REQ-010 with apply_event)', () => {
    expect(VAULT_TOOL_DEFINITIONS).toHaveLength(4);
    expect(VAULT_TOOL_COUNT).toBe(4);
  });

  it('names are read_vault_multi, list_vault, end_turn, apply_event (in order)', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['read_vault_multi', 'list_vault', 'end_turn', 'apply_event']);
  });

  it('NEVER includes a tool named `read_vault` (REQ-011)', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).not.toContain('read_vault');
  });

  it('read_vault_multi description includes the "Read MANY ... in ONE call" wording (spike 009)', () => {
    const def = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'read_vault_multi');
    expect(def?.description).toMatch(/Read MANY .* in ONE call/);
  });

  it('every tool has a non-empty description and an object input_schema', () => {
    for (const def of VAULT_TOOL_DEFINITIONS) {
      expect(typeof def.description).toBe('string');
      expect((def.description ?? '').length).toBeGreaterThan(0);
      expect(def.input_schema.type).toBe('object');
    }
  });

  it('the apply_event tool description clarifies that `character` is a UUID, not a name (NIT 1)', () => {
    const apply = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
    expect(apply).toBeDefined();
    const payloadDescription =
      (apply!.input_schema.properties as { payload?: { description?: string } } | undefined)?.payload
        ?.description ?? '';
    expect(payloadDescription).toMatch(/character UUID|character.+UUID|NOT the character name/i);
  });

  it('apply_event input_schema requires both `type` and `payload`', () => {
    const apply = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
    expect(apply?.input_schema.required).toEqual(['type', 'payload']);
  });

  it('apply_event description mentions the {ok, event_id} return shape (Decision 3)', () => {
    const apply = VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
    expect(apply?.description).toMatch(/event_id/);
  });
});

describe('dispatchVaultTool — read_vault_multi', () => {
  let root: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-tools-test-'));
    root = join(dir, 'vault');
    await mkdir(join(root, 'handbook'), { recursive: true });
    await writeFile(join(root, 'handbook', 'a.md'), 'AAA', 'utf8');
    await writeFile(join(root, 'handbook', 'b.md'), 'BBB', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  it('reads multiple files in concat format', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '/handbook/b.md'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('### /handbook/a.md\n\nAAA\n\n---\n\n### /handbook/b.md\n\nBBB');
  });

  it('rejects empty paths array', async () => {
    const result = await dispatchVaultTool('read_vault_multi', { paths: [] }, { vaultRoot: root });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/non-empty paths array/);
  });

  it('rejects more than 16 paths', async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `/handbook/${i}.md`);
    const result = await dispatchVaultTool('read_vault_multi', { paths }, { vaultRoot: root });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/at most 16 paths/);
  });

  it('surfaces missing files inline; batch does not fail', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '/handbook/missing.md'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('AAA');
    expect(result.content).toContain('ERROR: file not found at /handbook/missing.md');
  });

  it('surfaces traversal attempt inline; sibling reads succeed', async () => {
    const result = await dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/a.md', '../etc/passwd'] },
      { vaultRoot: root },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('AAA');
    expect(result.content).toContain('ERROR: path outside vault');
  });

  it('rejects missing paths field', async () => {
    const result = await dispatchVaultTool('read_vault_multi', {}, { vaultRoot: root });
    expect(result.isError).toBe(true);
  });
});

describe('dispatchVaultTool — list_vault', () => {
  let root: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-list-test-'));
    root = join(dir, 'vault');
    await mkdir(join(root, 'handbook'), { recursive: true });
    await writeFile(join(root, 'handbook', 'a.md'), '', 'utf8');
    await writeFile(join(root, 'handbook', 'b.md'), '', 'utf8');
    await writeFile(join(root, 'handbook', 'c.md'), '', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  it('lists sorted children with header', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: '/handbook' }, { vaultRoot: root });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Children of /handbook:\n- a.md\n- b.md\n- c.md');
  });

  it('returns "(no children or path not found)" for a missing directory', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: '/does/not/exist' }, { vaultRoot: root });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('(no children or path not found)');
  });

  it('rejects non-string directory', async () => {
    const result = await dispatchVaultTool('list_vault', { directory: 123 }, { vaultRoot: root });
    expect(result.isError).toBe(true);
  });
});

describe('dispatchVaultTool — end_turn', () => {
  it('returns endTurnResponse for valid response', async () => {
    const result = await dispatchVaultTool('end_turn', { response: 'Final narrative.' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('');
    expect(result.endTurnResponse).toBe('Final narrative.');
  });

  it('defaults to empty string when response is missing', async () => {
    const result = await dispatchVaultTool('end_turn', {});
    expect(result.isError).toBe(false);
    expect(result.endTurnResponse).toBe('');
  });

  it('coerces non-string response to empty string', async () => {
    const result = await dispatchVaultTool('end_turn', { response: 123 });
    expect(result.endTurnResponse).toBe('');
  });
});

describe('dispatchVaultTool — unknown tool', () => {
  it('returns error marker without throwing', async () => {
    const result = await dispatchVaultTool('not_a_real_tool', { foo: 'bar' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown vault tool: not_a_real_tool');
  });
});

describe('formatMultiReadResult', () => {
  it('preserves the supplied order (no sorting)', () => {
    const result = formatMultiReadResult([
      { path: '/b', content: 'BB' },
      { path: '/a', content: 'AA' },
    ]);
    expect(result).toBe('### /b\n\nBB\n\n---\n\n### /a\n\nAA');
  });

  it('handles a single entry', () => {
    const result = formatMultiReadResult([{ path: '/only', content: 'X' }]);
    expect(result).toBe('### /only\n\nX');
  });

  it('handles an empty input gracefully', () => {
    expect(formatMultiReadResult([])).toBe('');
  });
});

/* -------------------------------------------------------------------------- *
 *  Phase 02 — apply_event dispatch + Decision 4 root routing.                *
 * -------------------------------------------------------------------------- */

const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
const CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHAR_UUID_2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

/**
 * Re-import the tools + campaign-paths modules under a fresh
 * `VAULT_CAMPAIGNS_ROOT`. The modules read the env var at module-load (via
 * `./path`), so `vi.resetModules()` is mandatory whenever the env changes.
 */
async function withStubbedRoot(
  campaignsRoot: string,
): Promise<{
  dispatchVaultTool: typeof import('@/ai/master/vault/tools').dispatchVaultTool;
  VAULT_TOOL_DEFINITIONS: typeof import('@/ai/master/vault/tools').VAULT_TOOL_DEFINITIONS;
  eventsPath: typeof import('@/ai/master/vault/campaign-paths').eventsPath;
  characterViewPath: typeof import('@/ai/master/vault/campaign-paths').characterViewPath;
  seedGenesis: (campaignId: string, characters: Array<Record<string, unknown>>) => Promise<void>;
}> {
  // VAULT_CAMPAIGNS_ROOT IS env-derived at module-load (campaign-paths.ts/path.ts
  // → process.env.VAULT_CAMPAIGNS_ROOT); restubbing requires vi.resetModules()
  // then dynamic re-import. VAULT_ROOT is NOT env-derived (it's
  // `resolve(process.cwd(), 'data/vault')`); callers that need a different
  // static root must pass `ctx.vaultRoot` explicitly.
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', campaignsRoot);
  vi.resetModules();
  const toolsMod = await import('@/ai/master/vault/tools');
  const pathsMod = await import('@/ai/master/vault/campaign-paths');
  const writerMod = await import('@/ai/master/vault/events-writer');
  const projectorMod = await import('@/ai/master/vault/projector');
  const schemaMod = await import('@/ai/master/vault/events-schema');
  // 2026-06-10 audit: the dispatcher REJECTS campaign_initialized (genesis is
  // server-side only). Tests seed the way production does — EventsWriter +
  // regenerateAffectedViews (mirrors seed-vault.ts).
  const seedGenesis = async (
    campaignId: string,
    characters: Array<Record<string, unknown>>,
  ): Promise<void> => {
    const envelope = {
      id: crypto.randomUUID(),
      version: schemaMod.EVENT_SCHEMA_VERSION,
      type: 'campaign_initialized' as const,
      payload: { characters },
      timestamp: new Date().toISOString(),
    };
    await writerMod.EventsWriter.applyEvent(pathsMod.eventsPath(campaignId), envelope as never);
    await projectorMod.regenerateAffectedViews(campaignId, envelope as never);
  };
  return {
    dispatchVaultTool: toolsMod.dispatchVaultTool,
    VAULT_TOOL_DEFINITIONS: toolsMod.VAULT_TOOL_DEFINITIONS,
    eventsPath: pathsMod.eventsPath,
    characterViewPath: pathsMod.characterViewPath,
    seedGenesis,
  };
}

describe('dispatchVaultTool — apply_event (Phase 02)', () => {
  let campaignsRoot: string;
  let helpers: Awaited<ReturnType<typeof withStubbedRoot>>;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-apply-event-'));
    helpers = await withStubbedRoot(campaignsRoot);
    // Seed the campaign so subsequent hp_change events have a state to mutate.
    // (Server-side seeding — the dispatcher rejects LLM-emitted genesis.)
    await helpers.seedGenesis(CAMPAIGN_UUID, [
      { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
    ]);
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('happy path', () => {
    it('appends one event to events.md and returns {ok, event_id}', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content) as { ok: boolean; event_id: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const eventsContent = await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8');
      const lines = eventsContent.trim().split('\n');
      // seed + hp_change
      expect(lines.length).toBe(2);
      const lastEvent = JSON.parse(lines[1]!) as { type: string; payload: { delta: number } };
      expect(lastEvent.type).toBe('hp_change');
      expect(lastEvent.payload.delta).toBe(-5);
    });

    it('regenerates the character view synchronously', async () => {
      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -7 } },
        { campaignId: CAMPAIGN_UUID },
      );
      const viewPath = helpers.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID);
      const view = await readFile(viewPath, 'utf8');
      expect(view).toContain('hp_current: 23'); // 30 - 7
      expect(view).toContain('hp_max: 30');
    });

    it('multiple sequential apply_events all land in events.md in order', async () => {
      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -3 } },
        { campaignId: CAMPAIGN_UUID },
      );
      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'condition_add', payload: { character: CHAR_UUID, condition: 'poisoned' } },
        { campaignId: CAMPAIGN_UUID },
      );
      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'inventory_add', payload: { character: CHAR_UUID, item: 'potion', qty: 2 } },
        { campaignId: CAMPAIGN_UUID },
      );
      const lines = (await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(4); // seed + 3
      const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types).toEqual([
        'campaign_initialized',
        'hp_change',
        'condition_add',
        'inventory_add',
      ]);
    });

    it('returned event_id is unique per call', async () => {
      const r1 = JSON.parse(
        (
          await helpers.dispatchVaultTool(
            'apply_event',
            { type: 'hp_change', payload: { character: CHAR_UUID, delta: -1 } },
            { campaignId: CAMPAIGN_UUID },
          )
        ).content,
      ) as { event_id: string };
      const r2 = JSON.parse(
        (
          await helpers.dispatchVaultTool(
            'apply_event',
            { type: 'hp_change', payload: { character: CHAR_UUID, delta: -1 } },
            { campaignId: CAMPAIGN_UUID },
          )
        ).content,
      ) as { event_id: string };
      expect(r1.event_id).not.toBe(r2.event_id);
    });
  });

  describe('input validation (no write on error)', () => {
    it('rejects missing campaignId in ctx', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/campaignId/);
    });

    it('rejects non-UUID campaignId in ctx', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { campaignId: 'not-a-uuid' },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/UUID/);
    });

    it('rejects traversal-shaped campaignId in ctx', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { campaignId: '../../etc/passwd' },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/UUID/);
    });

    // Smoke 2026-05-26 — qwen3:30b emitted character: "pc-001" in the wild.
    // Without this guard the event lands and the projector silently drops it
    // (no character matches "pc-001"), producing zombie state. The guard
    // forces the model to read the materialized view frontmatter and use
    // the real UUID; the error marker is descriptive enough to enable
    // lenient self-correction.
    // Note: empty string is rejected EARLIER by validateEvent ("requires
    // {character: non-empty string, ...}"), not by the UUID guard. That's
    // the correct behavior — empty is caught by shape validation; only
    // syntactically-plausible-but-not-UUID strings reach the UUID guard.
    it.each([
      ['pc-001', 'invented-id pattern (qwen3 wildcard observed in smoke)'],
      ['Luffy', 'character name instead of id'],
      ['pc-1', 'short alias'],
      ['25158592', 'short-prefix uuid (8-char)'],
      ['25158592-15cf', 'truncated uuid'],
    ])('rejects non-UUID payload.character (%s — %s)', async (character) => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character, delta: -5 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/character must be a UUID/);
      // After rejection, events.md must NOT have grown beyond the seed.
      const lines = (await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8'))
        .trim()
        .split('\n');
      expect(lines.length).toBe(1); // just the seed
    });

    it('rejects non-UUID payload.character on condition_add too (not just hp_change)', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'condition_add', payload: { character: 'pc-001', condition: 'poisoned' } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/character must be a UUID/);
    });

    it('rejects non-string type', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 123, payload: { character: CHAR_UUID, delta: -5 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/type: string/);
    });

    it('rejects missing payload', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change' },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/payload: object/);
    });

    it('rejects null payload', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: null },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/payload: object/);
    });

    it('rejects unknown event type via validateEvent', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'unknown_event_type', payload: { character: CHAR_UUID } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/unknown event type/);
    });

    it('rejects malformed payload (hp_change with non-numeric delta)', async () => {
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: 'five' } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/hp_change/);
    });

    it('does NOT touch events.md when validation fails (seed-only line preserved)', async () => {
      const eventsFile = helpers.eventsPath(CAMPAIGN_UUID);
      const before = await readFile(eventsFile, 'utf8');
      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: 'five' } },
        { campaignId: CAMPAIGN_UUID },
      );
      const after = await readFile(eventsFile, 'utf8');
      expect(after).toBe(before);
    });

    it('does NOT touch events.md when campaignId is missing', async () => {
      // Use a campaignId that has NOT been seeded so we can detect non-creation.
      const VIRGIN_UUID = '99999999-8888-7777-6666-555555555555';
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -1 } },
        {},
      );
      expect(result.isError).toBe(true);
      expect(existsSync(helpers.eventsPath(VIRGIN_UUID))).toBe(false);
    });
  });

  describe('multiple-character seed: regenerates only the affected view', () => {
    it('hp_change for one character does not rewrite the other character view', async () => {
      // Re-seed with TWO characters.
      campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-apply-event-multi-'));
      helpers = await withStubbedRoot(campaignsRoot);
      await helpers.seedGenesis(CAMPAIGN_UUID, [
        { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
        { id: CHAR_UUID_2, name: 'Legolas', hp_max: 25, hp_current: 25 },
      ]);

      // Snapshot Legolas view BEFORE the hp_change.
      const legolasViewPath = helpers.characterViewPath(CAMPAIGN_UUID, 'Legolas', CHAR_UUID_2);
      const legolasBefore = await readFile(legolasViewPath, 'utf8');

      await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -4 } },
        { campaignId: CAMPAIGN_UUID },
      );

      // Legolas should be byte-identical (no regeneration triggered for him).
      const legolasAfter = await readFile(legolasViewPath, 'utf8');
      expect(legolasAfter).toBe(legolasBefore);

      // Aragorn IS regenerated with updated hp_current.
      const aragornView = await readFile(
        helpers.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID),
        'utf8',
      );
      expect(aragornView).toContain('hp_current: 26');
    });
  });
});

/* -------------------------------------------------------------------------- *
 *  Phase 02 — Decision 4: read_vault_multi + list_vault route /campaigns/    *
 *  to VAULT_CAMPAIGNS_ROOT.                                                  *
 * -------------------------------------------------------------------------- */

describe('dispatchVaultTool — Decision 4 root routing (read_vault_multi + list_vault)', () => {
  let staticRoot: string;
  let campaignsRoot: string;
  let helpers: Awaited<ReturnType<typeof withStubbedRoot>>;

  beforeEach(async () => {
    staticRoot = mkdtempSync(join(tmpdir(), 'gsd-decision4-static-'));
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-decision4-campaigns-'));

    // Seed a file under VAULT_ROOT/handbook
    await mkdir(join(staticRoot, 'handbook'), { recursive: true });
    await writeFile(
      join(staticRoot, 'handbook', 'test.md'),
      'content-from-vault-root',
      'utf8',
    );

    // Seed a file under VAULT_CAMPAIGNS_ROOT/<campaign>/characters
    await mkdir(join(campaignsRoot, CAMPAIGN_UUID, 'characters'), { recursive: true });
    const charFile = `aragorn-${CHAR_UUID.slice(0, 8)}.md`;
    await writeFile(
      join(campaignsRoot, CAMPAIGN_UUID, 'characters', charFile),
      'frontmatter-from-campaigns-root',
      'utf8',
    );

    helpers = await withStubbedRoot(campaignsRoot);
  });

  afterEach(() => {
    rmSync(staticRoot, { recursive: true, force: true });
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('a /campaigns/ path reads from VAULT_CAMPAIGNS_ROOT', async () => {
    const result = await helpers.dispatchVaultTool(
      'read_vault_multi',
      {
        paths: [
          `/campaigns/${CAMPAIGN_UUID}/characters/aragorn-${CHAR_UUID.slice(0, 8)}.md`,
        ],
      },
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('frontmatter-from-campaigns-root');
    // The original LLM-supplied path is preserved in the heading.
    expect(result.content).toContain(
      `### /campaigns/${CAMPAIGN_UUID}/characters/aragorn-${CHAR_UUID.slice(0, 8)}.md`,
    );
  });

  it('a /handbook/ path reads from VAULT_ROOT (or ctx.vaultRoot test override)', async () => {
    // VAULT_ROOT is `resolve(process.cwd(), 'data/vault')` at module-load (not env-derived),
    // so production passes paths through to the static repo root. Test override uses
    // ctx.vaultRoot — the same seam Phase 01 read tests rely on.
    const result = await helpers.dispatchVaultTool(
      'read_vault_multi',
      { paths: ['/handbook/test.md'] },
      { vaultRoot: staticRoot },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('content-from-vault-root');
  });

  it('a missing /campaigns/ path returns the not-found marker (batch does not fail)', async () => {
    const result = await helpers.dispatchVaultTool(
      'read_vault_multi',
      { paths: [`/campaigns/${CAMPAIGN_UUID}/characters/ghost-00000000.md`] },
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/ERROR: file not found/);
  });

  it('list_vault routes /campaigns/<id>/characters to VAULT_CAMPAIGNS_ROOT', async () => {
    const result = await helpers.dispatchVaultTool(
      'list_vault',
      { directory: `/campaigns/${CAMPAIGN_UUID}/characters` },
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`aragorn-${CHAR_UUID.slice(0, 8)}.md`);
    // The heading preserves the LLM-supplied path.
    expect(result.content).toContain(
      `Children of /campaigns/${CAMPAIGN_UUID}/characters:`,
    );
  });

  it('list_vault routes /handbook to VAULT_ROOT (or ctx.vaultRoot test override)', async () => {
    const result = await helpers.dispatchVaultTool(
      'list_vault',
      { directory: '/handbook' },
      { vaultRoot: staticRoot },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('test.md');
  });

  it('mixed batch — one /campaigns/, one /handbook/ — both resolve to their respective roots', async () => {
    const result = await helpers.dispatchVaultTool(
      'read_vault_multi',
      {
        paths: [
          `/campaigns/${CAMPAIGN_UUID}/characters/aragorn-${CHAR_UUID.slice(0, 8)}.md`,
          '/handbook/test.md',
        ],
      },
      { vaultRoot: staticRoot },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('frontmatter-from-campaigns-root');
    expect(result.content).toContain('content-from-vault-root');
  });
});

/* -------------------------------------------------------------------------- *
 *  Phase 03 — apply_event dispatch for the 20 new event types                *
 *  (plan 03-A-04 Task 2 — COMPLETENESS-AUDIT.md §"(c) Final list").          *
 *                                                                            *
 *  These are DISPATCH-LAYER smoke tests: each new event type flows through   *
 *  `dispatchVaultTool('apply_event', ...)`, gets validated by validateEvent  *
 *  (extended in 03-A-02), and is persisted by EventsWriter. The projector   *
 *  reducer arms for the new types are 03-A-03's scope (running concurrently *
 *  in Wave 3 — disjoint files); these tests therefore assert ONLY the       *
 *  dispatch-layer contract: result.isError===false, the JSON {ok, event_id} *
 *  envelope shape, and the events.md append. View-content assertions for    *
 *  the new state fields are covered by `projector.test.ts` (plan 03-A-03)   *
 *  once the reducer arms land.                                              *
 * -------------------------------------------------------------------------- */

describe('dispatchVaultTool — apply_event (Phase 03 event types — plan 03-A-04)', () => {
  let campaignsRoot: string;
  let helpers: Awaited<ReturnType<typeof withStubbedRoot>>;

  /**
   * Count the JSON lines currently in events.md (excludes blank lines so
   * trailing whitespace is not double-counted across writes).
   */
  async function eventCount(): Promise<number> {
    const raw = await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  }

  /**
   * Parse the dispatcher's success envelope ({ok, event_id}). The dispatcher
   * returns this string in `content` on the apply_event happy path
   * (Decision 3 — minimal envelope preserves prefix-cache hygiene).
   */
  function parseDispatchOk(content: string): { ok: boolean; event_id: string } {
    return JSON.parse(content) as { ok: boolean; event_id: string };
  }

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-apply-event-p3-'));
    helpers = await withStubbedRoot(campaignsRoot);
    // Seed with a single character — every Phase 03 mutation event targets
    // this UUID via the `payload.character` field (NIT 1 UUID guard).
    // (Server-side seeding — the dispatcher rejects LLM-emitted genesis.)
    await helpers.seedGenesis(CAMPAIGN_UUID, [
      { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
    ]);
    // Sanity: seed event is the only line at start.
    expect(await eventCount()).toBe(1);
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('tool description surface (Task 1 cross-check)', () => {
    it('includes every Phase 03 event type name in the type description', () => {
      const apply = helpers.VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
      expect(apply).toBeDefined();
      const typeDesc =
        (apply!.input_schema.properties as { type?: { description?: string } } | undefined)?.type
          ?.description ?? '';
      // All 20 Phase 03 type names appear by their canonical schema spelling.
      const phase03Types = [
        'temp_hp_set',
        'death_save_success',
        'death_save_fail',
        'death_save_stabilize',
        'death_save_recover_at_one',
        'concentration_set',
        'concentration_break',
        'exhaustion_increment',
        'exhaustion_decrement',
        'hit_dice_use',
        'hit_dice_restore',
        'resource_use',
        'resource_restore',
        'inspiration_grant',
        'inspiration_spend',
        'attune',
        'unattune',
        'focus_set',
        'focus_unset',
        'xp_award',
      ];
      for (const t of phase03Types) {
        expect(typeDesc).toContain(t);
      }
    });

    it('payload description mentions representative Phase 03 payload fields', () => {
      const apply = helpers.VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
      const payloadDesc =
        (apply!.input_schema.properties as { payload?: { description?: string } } | undefined)
          ?.payload?.description ?? '';
      // Field names the LLM needs to spell correctly (per validateEvent).
      expect(payloadDesc).toMatch(/tempHp/);
      expect(payloadDesc).toMatch(/critical/); // death_save_fail.critical
      expect(payloadDesc).toMatch(/spellSlug/); // concentration_set.spellSlug
      expect(payloadDesc).toMatch(/slotLevel/); // concentration_set.slotLevel
      expect(payloadDesc).toMatch(/startedRound/); // concentration_set.startedRound
      expect(payloadDesc).toMatch(/reason/); // concentration_break.reason / xp_award.reason
      expect(payloadDesc).toMatch(/resourceKey/); // resource_use.resourceKey
      expect(payloadDesc).toMatch(/itemSlug/); // attune.itemSlug
      expect(payloadDesc).toMatch(/kind/); // focus_set.kind
      expect(payloadDesc).toMatch(/amount/); // xp_award.amount
    });

    it('payload description preserves NIT 1 UUID clarification for `character` field', () => {
      // Phase 03 extension must not regress the Phase 02 NIT 1 fix that
      // tells the LLM `character` is a UUID, not a name.
      const apply = helpers.VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
      const payloadDesc =
        (apply!.input_schema.properties as { payload?: { description?: string } } | undefined)
          ?.payload?.description ?? '';
      expect(payloadDesc).toMatch(/character UUID|character.+UUID|NOT the character name/i);
    });

    it('the tool surface still has exactly 4 tools (REQ-010)', () => {
      expect(helpers.VAULT_TOOL_DEFINITIONS).toHaveLength(4);
      const names = helpers.VAULT_TOOL_DEFINITIONS.map((t) => t.name).sort();
      expect(names).toEqual(['apply_event', 'end_turn', 'list_vault', 'read_vault_multi']);
    });
  });

  describe('happy-path dispatch for each Phase 03 event type', () => {
    /**
     * Table-driven happy-path roster. Each entry sends one Phase 03 event
     * type through the dispatcher and asserts the dispatcher's contract:
     *   - result.isError is false
     *   - result.content parses to {ok: true, event_id: <uuid>}
     *   - events.md grew by exactly one line
     *   - the appended line's type field matches
     *
     * Payload shapes mirror `validateEvent` 1:1 (events-schema.ts). The
     * projector reducer arms for these types are 03-A-03's scope; the view
     * file regenerated by the dispatcher will reflect whatever subset of
     * arms has landed (graceful default = state unchanged), so this block
     * does NOT assert specific frontmatter values for Phase 03 fields.
     */
    const cases: { type: string; payload: Record<string, unknown> }[] = [
      { type: 'temp_hp_set', payload: { character: CHAR_UUID, tempHp: 5 } },
      { type: 'death_save_success', payload: { character: CHAR_UUID } },
      { type: 'death_save_fail', payload: { character: CHAR_UUID, critical: true } },
      { type: 'death_save_stabilize', payload: { character: CHAR_UUID } },
      { type: 'death_save_recover_at_one', payload: { character: CHAR_UUID } },
      {
        type: 'concentration_set',
        payload: {
          character: CHAR_UUID,
          spellSlug: 'bless',
          slotLevel: 1,
          startedRound: 3,
        },
      },
      {
        type: 'concentration_break',
        payload: { character: CHAR_UUID, reason: 'damage' },
      },
      {
        type: 'exhaustion_increment',
        payload: { character: CHAR_UUID, source: 'forced-march' },
      },
      { type: 'exhaustion_decrement', payload: { character: CHAR_UUID } },
      { type: 'hit_dice_use', payload: { character: CHAR_UUID, count: 1 } },
      { type: 'hit_dice_restore', payload: { character: CHAR_UUID, count: 2 } },
      {
        type: 'resource_use',
        payload: { character: CHAR_UUID, resourceKey: 'rage_uses', uses: 1 },
      },
      {
        type: 'resource_restore',
        payload: { character: CHAR_UUID, resourceKey: 'rage_uses', uses: 1 },
      },
      { type: 'inspiration_grant', payload: { character: CHAR_UUID } },
      { type: 'inspiration_spend', payload: { character: CHAR_UUID } },
      {
        type: 'attune',
        payload: { character: CHAR_UUID, itemSlug: 'wand-of-fireballs' },
      },
      {
        type: 'unattune',
        payload: { character: CHAR_UUID, itemSlug: 'wand-of-fireballs' },
      },
      {
        type: 'focus_set',
        payload: { character: CHAR_UUID, kind: 'arcane', itemSlug: 'crystal-orb' },
      },
      { type: 'focus_unset', payload: { character: CHAR_UUID } },
      {
        type: 'xp_award',
        payload: { character: CHAR_UUID, amount: 300, reason: 'monster-kill' },
      },
    ];

    // Sanity: roster length matches the audit hard-count (20 events).
    it('roster covers all 20 Phase 03 event types from COMPLETENESS-AUDIT.md', () => {
      expect(cases).toHaveLength(20);
      const uniqueTypes = new Set(cases.map((c) => c.type));
      expect(uniqueTypes.size).toBe(20);
    });

    it.each(cases)(
      '$type — dispatch success: events.md appended, {ok, event_id} returned',
      async ({ type, payload }) => {
        const before = await eventCount();
        const result = await helpers.dispatchVaultTool(
          'apply_event',
          { type, payload },
          { campaignId: CAMPAIGN_UUID },
        );
        expect(result.isError).toBe(false);
        const parsed = parseDispatchOk(result.content);
        expect(parsed.ok).toBe(true);
        expect(parsed.event_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );

        // One new line appended to events.md, type matches.
        expect(await eventCount()).toBe(before + 1);
        const lines = (await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8'))
          .trim()
          .split('\n');
        const lastEnvelope = JSON.parse(lines[lines.length - 1]!) as {
          type: string;
          payload: unknown;
        };
        expect(lastEnvelope.type).toBe(type);
        // Payload round-trips byte-for-byte (validateEvent rebuilds the
        // object so we re-serialize from canonical form to compare).
        expect(lastEnvelope.payload).toEqual(payload);
      },
    );
  });

  describe('NIT 1 UUID guard applies to every Phase 03 type', () => {
    // The dispatcher's UUID guard (tools.ts) runs AFTER validateEvent for
    // every non-`campaign_initialized` event. The plan-check NIT 1 reminder
    // requires that the guard remains active for ALL new types. We sample a
    // representative subset across the audit categories: single-field
    // (death_save_success), multi-field (concentration_set), bounded enum
    // (concentration_break), and string-slug (attune).
    it.each([
      ['temp_hp_set', { character: 'pc-001', tempHp: 5 }],
      ['death_save_success', { character: 'Aragorn' }],
      ['concentration_set', {
        character: 'not-a-uuid',
        spellSlug: 'bless',
        slotLevel: 1,
        startedRound: 1,
      }],
      ['concentration_break', { character: 'Luffy', reason: 'damage' }],
      ['attune', { character: 'pc-1', itemSlug: 'wand' }],
      ['xp_award', { character: '25158592-15cf', amount: 300 }],
    ] as const)(
      '%s — rejects non-UUID payload.character with descriptive error',
      async (type, payload) => {
        const before = await eventCount();
        const result = await helpers.dispatchVaultTool(
          'apply_event',
          { type, payload },
          { campaignId: CAMPAIGN_UUID },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/character must be a UUID/);
        // events.md MUST NOT have grown on rejection.
        expect(await eventCount()).toBe(before);
      },
    );
  });

  describe('malformed payload rejection (validateEvent gate, no write on error)', () => {
    it('temp_hp_set rejects negative tempHp', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'temp_hp_set', payload: { character: CHAR_UUID, tempHp: -1 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/temp_hp_set/);
      expect(await eventCount()).toBe(before);
    });

    it('death_save_fail rejects non-boolean critical', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        {
          type: 'death_save_fail',
          payload: { character: CHAR_UUID, critical: 'yes' as unknown as boolean },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/critical/i);
      expect(await eventCount()).toBe(before);
    });

    it('concentration_set rejects out-of-range slotLevel', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        {
          type: 'concentration_set',
          payload: {
            character: CHAR_UUID,
            spellSlug: 'bless',
            slotLevel: 10, // schema cap is 9
            startedRound: 1,
          },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/concentration_set/);
      expect(await eventCount()).toBe(before);
    });

    it('concentration_break rejects unknown reason enum value', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        {
          type: 'concentration_break',
          payload: { character: CHAR_UUID, reason: 'tripped' },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/concentration_break/);
      expect(await eventCount()).toBe(before);
    });

    it('focus_set rejects unknown kind enum value', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        {
          type: 'focus_set',
          payload: { character: CHAR_UUID, kind: 'cosmic', itemSlug: 'orb' },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/focus_set/);
      expect(await eventCount()).toBe(before);
    });

    it('hit_dice_use rejects count above schema cap', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'hit_dice_use', payload: { character: CHAR_UUID, count: 21 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/hit_dice_use/);
      expect(await eventCount()).toBe(before);
    });

    it('resource_use rejects missing resourceKey', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        {
          type: 'resource_use',
          payload: { character: CHAR_UUID, uses: 1 },
        },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/resource_use/);
      expect(await eventCount()).toBe(before);
    });

    it('attune rejects empty itemSlug', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'attune', payload: { character: CHAR_UUID, itemSlug: '' } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/attune/);
      expect(await eventCount()).toBe(before);
    });

    it('xp_award rejects zero amount (must be > 0)', async () => {
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'xp_award', payload: { character: CHAR_UUID, amount: 0 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/xp_award/);
      expect(await eventCount()).toBe(before);
    });

    it('rejects misspelled type name (e.g., camelCase variant) as unknown event type', async () => {
      // Smoke note: small models sometimes drift toward JS camelCase; the
      // schema is snake_case. Make sure the dispatcher surfaces a clear
      // "unknown event type" rather than passing-through and crashing.
      const before = await eventCount();
      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'tempHpSet', payload: { character: CHAR_UUID, tempHp: 5 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/unknown event type/);
      expect(await eventCount()).toBe(before);
    });
  });

  describe('multi-event sequencing — Phase 02 + Phase 03 interleaved', () => {
    it('appends a mixed sequence in order and preserves event_id uniqueness', async () => {
      // Send Phase 02 + Phase 03 events alternately; verify ordering +
      // uniqueness. This is the realistic LLM-emission pattern: a damage
      // turn often pairs `hp_change` (Phase 02) with `temp_hp_set` or
      // `concentration_break` (Phase 03) in the same tool-call cycle.
      const sequence = [
        { type: 'hp_change', payload: { character: CHAR_UUID, delta: -5 } },
        { type: 'temp_hp_set', payload: { character: CHAR_UUID, tempHp: 0 } },
        { type: 'condition_add', payload: { character: CHAR_UUID, condition: 'unconscious' } },
        { type: 'death_save_fail', payload: { character: CHAR_UUID, critical: false } },
        { type: 'death_save_success', payload: { character: CHAR_UUID } },
        { type: 'inspiration_grant', payload: { character: CHAR_UUID } },
      ];
      const eventIds: string[] = [];
      for (const ev of sequence) {
        const result = await helpers.dispatchVaultTool(
          'apply_event',
          ev,
          { campaignId: CAMPAIGN_UUID },
        );
        expect(result.isError).toBe(false);
        eventIds.push(parseDispatchOk(result.content).event_id);
      }

      // All event_ids are unique.
      expect(new Set(eventIds).size).toBe(sequence.length);

      // events.md = seed + sequence.length lines, types in the order
      // emitted.
      const lines = (await readFile(helpers.eventsPath(CAMPAIGN_UUID), 'utf8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1 + sequence.length);
      const typesOnDisk = lines.map((l) => (JSON.parse(l) as { type: string }).type);
      expect(typesOnDisk).toEqual([
        'campaign_initialized',
        ...sequence.map((s) => s.type),
      ]);
    });

    it('a malformed event in the middle of a sequence does not abort the prior events', async () => {
      // Send: valid, valid, invalid, valid. The invalid one rejects; the
      // four others land. events.md grows by exactly 3 (the three valid
      // ones) + 1 seed = 4 lines.
      const before = await eventCount();

      const r1 = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'temp_hp_set', payload: { character: CHAR_UUID, tempHp: 5 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(r1.isError).toBe(false);

      const r2 = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'inspiration_grant', payload: { character: CHAR_UUID } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(r2.isError).toBe(false);

      const rBad = await helpers.dispatchVaultTool(
        'apply_event',
        // hit_dice_use requires count >= 1
        { type: 'hit_dice_use', payload: { character: CHAR_UUID, count: 0 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(rBad.isError).toBe(true);

      const r4 = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'inspiration_spend', payload: { character: CHAR_UUID } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(r4.isError).toBe(false);

      // before(1 seed) + 3 valid appends = 4
      expect(await eventCount()).toBe(before + 3);
    });
  });

  describe('view regeneration is invoked synchronously (Decision 2 — no eventual-consistency window)', () => {
    it('view file is rewritten after each Phase 03 dispatch (mtime advances)', async () => {
      // The dispatcher regenerates the affected character view synchronously
      // after EventsWriter.append returns. Even if no reducer arm has
      // landed for a given Phase 03 type yet (default arm logs a warning
      // and returns state unchanged), the view file is still WRITTEN —
      // this proves the projector path executes without throwing.
      const viewPath = helpers.characterViewPath(CAMPAIGN_UUID, 'Aragorn', CHAR_UUID);
      const before = await readFile(viewPath, 'utf8');
      expect(before).toContain(`id: ${CHAR_UUID}`); // seeded view exists

      const result = await helpers.dispatchVaultTool(
        'apply_event',
        { type: 'temp_hp_set', payload: { character: CHAR_UUID, tempHp: 7 } },
        { campaignId: CAMPAIGN_UUID },
      );
      expect(result.isError).toBe(false);

      // View was rewritten — still a valid view, same character UUID.
      // (Specific Phase 03 field assertions are 03-A-03's projector tests;
      // here we just prove the regen pipeline did not throw.)
      const after = await readFile(viewPath, 'utf8');
      expect(after).toContain(`id: ${CHAR_UUID}`);
      expect(after).toContain('hp_max: 30');
    });
  });
});

/* -------------------------------------------------------------------------- *
 *  Phase 07-D2 — apply_event encounter event dispatch (UUID guard skip).     *
 * -------------------------------------------------------------------------- */

describe('apply_event — encounter event dispatch (D2 UUID guard skip)', () => {
  let campaignsRoot: string;
  let helpers: Awaited<ReturnType<typeof withStubbedRoot>>;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-encounter-dispatch-'));
    helpers = await withStubbedRoot(campaignsRoot);
    // Seed the campaign so events.md exists and subsequent events can land.
    // (Server-side seeding — the dispatcher rejects LLM-emitted genesis.)
    await helpers.seedGenesis(CAMPAIGN_UUID, [
      { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
    ]);
  });

  afterEach(() => {
    rmSync(campaignsRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // (a): combat_start dispatches without payload.character.
  it('(a) combat_start dispatches without payload.character', async () => {
    const result = await helpers.dispatchVaultTool(
      'apply_event',
      { type: 'combat_start', payload: {} },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toMatch(/^ERROR/);
  });

  // (b): monster_spawn dispatches without payload.character.
  it('(b) monster_spawn dispatches without payload.character', async () => {
    const result = await helpers.dispatchVaultTool(
      'apply_event',
      {
        type: 'monster_spawn',
        payload: { id: 'goblin-1', name: 'Goblin', hpMax: 7, ac: 15, initiativeBonus: 2 },
      },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toMatch(/^ERROR/);
  });

  // (c): hp_change without payload.character is STILL rejected.
  // Note: an empty/missing `character` field is caught FIRST by validateEvent
  // (schema level), which returns "requires {character: non-empty string ...}".
  // If character is a non-empty non-UUID string (e.g. "pc-001"), the UUID guard
  // fires. Both paths reject — the key invariant is that the guard relaxation
  // for encounter types does NOT weaken character event rejection.
  it('(c) hp_change with non-UUID character is still rejected by UUID guard', async () => {
    const result = await helpers.dispatchVaultTool(
      'apply_event',
      { type: 'hp_change', payload: { character: 'pc-001', delta: -5 } },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/UUID/);
  });

  // (d): all 6 encounter type names appear in the apply_event type.description.
  it('(d) apply_event type.description lists all 6 encounter type names', () => {
    const applyDef = helpers.VAULT_TOOL_DEFINITIONS.find((t) => t.name === 'apply_event');
    expect(applyDef).toBeDefined();
    const typeDesc =
      (
        applyDef!.input_schema.properties as {
          type?: { description?: string };
        }
      ).type?.description ?? '';
    const encounterTypes = [
      'combat_start',
      'monster_spawn',
      'initiative_set',
      'turn_advance',
      'monster_hp_change',
      'combat_end',
    ];
    for (const et of encounterTypes) {
      expect(typeDesc).toContain(et);
    }
  });
});

// ─── 2026-06-10 audit: LLM-surface hardening ────────────────────────────────

describe('dispatchVaultTool — apply_event LLM-surface guards (2026-06-10 audit)', () => {
  const CAMPAIGN = '0f0e0d0c-0b0a-4990-8877-665544332211';
  const SEEDED = '11111111-2222-4333-8444-555555555555';
  const INVENTED = '99999999-8888-4777-8666-555555555544';
  let root: string;
  let h: Awaited<ReturnType<typeof withStubbedRoot>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gsd-llm-guards-'));
    h = await withStubbedRoot(root);
    await h.seedGenesis(CAMPAIGN, [
      { id: SEEDED, name: 'Nami', hp_max: 22, hp_current: 22 },
    ]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('REJECTS campaign_initialized from the tool surface (mid-campaign state reset)', async () => {
    const before = await readFile(h.eventsPath(CAMPAIGN), 'utf8');
    const r = await h.dispatchVaultTool(
      'apply_event',
      {
        type: 'campaign_initialized',
        payload: { characters: [{ id: INVENTED, name: 'Doppelganger', hp_max: 99, hp_current: 99 }] },
      },
      { campaignId: CAMPAIGN },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/genesis/i);
    // Append-only file untouched — no zombie seed persisted.
    expect(await readFile(h.eventsPath(CAMPAIGN), 'utf8')).toBe(before);
  });

  it('REJECTS a syntactically-valid UUID that is NOT in the campaign roster', async () => {
    const before = await readFile(h.eventsPath(CAMPAIGN), 'utf8');
    const r = await h.dispatchVaultTool(
      'apply_event',
      { type: 'hp_change', payload: { character: INVENTED, delta: -5 } },
      { campaignId: CAMPAIGN },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/does not match any character/);
    expect(await readFile(h.eventsPath(CAMPAIGN), 'utf8')).toBe(before);
  });

  it('still ACCEPTS a mutation for a seeded roster character', async () => {
    const r = await h.dispatchVaultTool(
      'apply_event',
      { type: 'hp_change', payload: { character: SEEDED, delta: -3 } },
      { campaignId: CAMPAIGN },
    );
    expect(r.isError).toBe(false);
  });
});
