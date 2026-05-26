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
  return {
    dispatchVaultTool: toolsMod.dispatchVaultTool,
    VAULT_TOOL_DEFINITIONS: toolsMod.VAULT_TOOL_DEFINITIONS,
    eventsPath: pathsMod.eventsPath,
    characterViewPath: pathsMod.characterViewPath,
  };
}

describe('dispatchVaultTool — apply_event (Phase 02)', () => {
  let campaignsRoot: string;
  let helpers: Awaited<ReturnType<typeof withStubbedRoot>>;

  beforeEach(async () => {
    campaignsRoot = mkdtempSync(join(tmpdir(), 'gsd-apply-event-'));
    helpers = await withStubbedRoot(campaignsRoot);
    // Seed the campaign so subsequent hp_change events have a state to mutate.
    const seedResult = await helpers.dispatchVaultTool(
      'apply_event',
      {
        type: 'campaign_initialized',
        payload: {
          characters: [
            { id: CHAR_UUID, name: 'Aragorn', hp_max: 30, hp_current: 30 },
          ],
        },
      },
      { campaignId: CAMPAIGN_UUID },
    );
    expect(seedResult.isError).toBe(false);
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
      await helpers.dispatchVaultTool(
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
