/**
 * Phase 02 plan 02-09 — Concurrent-Write Stress Test (CI regression).
 *
 * The Phase 02 high-N regression suite. Four orthogonal stress axes:
 *
 *   Axis 1 — Direct writer parallel scale (N=1000 default, STRESS_N override)
 *   Axis 2 — Dispatch-layer stress (N=100 parallel dispatchVaultTool('apply_event'))
 *   Axis 3 — Truncated-tail recovery + mid-line corruption fail-fast (spike 008)
 *   Axis 4 — Multi-campaign isolation (5 campaigns × 100 events parallel)
 *
 * Lineage:
 *   - `.planning/spikes/010-events-md-concurrency/stress.ts` — the reference
 *     harness for Axis 1 (100 events in 7ms baseline). This file mirrors that
 *     pattern at N=1000 and adds the dispatcher-layer axis spike 010 did NOT
 *     exercise (the dispatcher's projector-regen step layered atop the writer).
 *   - `.planning/spikes/008-events-md-replay/README.md` — Iteration 2
 *     "corruption fail-fast" pattern reused for Axis 3.
 *   - `tests/ai/master/vault/events-writer.test.ts` (plan 02-03) — basic N=100
 *     concurrency tests. THIS file BUILDS ON them with explicit timing
 *     assertions, N=1000 default, and dispatcher coverage; it does not
 *     duplicate them.
 *
 * Wall-clock assertion (NIT 4 — explicit in plan):
 *   `wall_ms = Date.now() - start` measured AROUND a single `await
 *   Promise.all(...)`. The wall-clock-divided-by-N form is the only correct
 *   interpretation under mutex serialization. DO NOT sum per-event timings —
 *   they would be ~N× wall-clock and meaningless. Spike 010 baseline:
 *   0.07ms/event via direct writer; through the dispatcher add 1-5ms for
 *   projector regen. The 50ms/event cap is generous CI headroom.
 *
 * Runtime budget: default N=1000 completes in <30s on M5 Pro / Mac Mini M4;
 * the suite-level timeout is 30000 ms per Axis-1 case. Ad-hoc validation via
 * `STRESS_N=10000 pnpm test tests/ai/master/vault/events-writer-stress.test.ts`
 * runs in <120s.
 *
 * No DATABASE_URL required — pure filesystem + vault modules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventsWriter } from '@/ai/master/vault/events-writer';

/**
 * Default direct-writer N. The plan caps default at 1000; CI runs the
 * default suite, developers override via env for ad-hoc validation.
 */
const DEFAULT_N = 1000;

/**
 * Resolve STRESS_N at module load. Falls back to DEFAULT_N. The
 * STRESS_N-only case (the higher-N override) skips when the env is unset
 * OR equals the default — that way the case is informational on dev runs
 * and only fires on explicit operator request.
 */
const STRESS_N = parseInt(process.env.STRESS_N ?? String(DEFAULT_N), 10);
const STRESS_N_OVERRIDDEN = process.env.STRESS_N !== undefined && STRESS_N > DEFAULT_N;

/**
 * Dispatch-layer dynamic-import seam. The vault tools module reads
 * `VAULT_CAMPAIGNS_ROOT` from `./path` at module load, so callers MUST
 * `vi.stubEnv` BEFORE the first import. The `vi.resetModules()` invalidates
 * the cached binding so a fresh import re-reads the env.
 */
type VaultDispatchModule = {
  dispatchVaultTool: typeof import('@/ai/master/vault/tools').dispatchVaultTool;
  eventsPath: typeof import('@/ai/master/vault/campaign-paths').eventsPath;
  characterViewPath: typeof import('@/ai/master/vault/campaign-paths').characterViewPath;
  parseEventsFile: typeof import('@/ai/master/vault/projector').parseEventsFile;
  parseView: typeof import('@/ai/master/vault/projector').parseView;
};

async function freshVaultModule(campaignsRoot: string): Promise<VaultDispatchModule> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', campaignsRoot);
  vi.resetModules();
  const tools = await import('@/ai/master/vault/tools');
  const paths = await import('@/ai/master/vault/campaign-paths');
  const projector = await import('@/ai/master/vault/projector');
  return {
    dispatchVaultTool: tools.dispatchVaultTool,
    eventsPath: paths.eventsPath,
    characterViewPath: paths.characterViewPath,
    parseEventsFile: projector.parseEventsFile,
    parseView: projector.parseView,
  };
}

// 2026-06-10 audit: the dispatcher rejects LLM-emitted campaign_initialized.
// Seed server-side (mirrors seed-vault.ts). Dynamic imports honor the
// VAULT_CAMPAIGNS_ROOT stub of the calling block.
async function seedDirect(
  eventsFilePath: string,
  campaignId: string,
  characters: Array<Record<string, unknown>>,
): Promise<void> {
  const { EventsWriter } = await import('@/ai/master/vault/events-writer');
  const { EVENT_SCHEMA_VERSION } = await import('@/ai/master/vault/events-schema');
  const { regenerateAffectedViews } = await import('@/ai/master/vault/projector');
  const envelope = {
    id: crypto.randomUUID(),
    version: EVENT_SCHEMA_VERSION,
    type: 'campaign_initialized' as const,
    payload: { characters },
    timestamp: new Date().toISOString(),
  };
  await EventsWriter.applyEvent(eventsFilePath, envelope as never);
  await regenerateAffectedViews(campaignId, envelope as never);
}

describe('EventsWriter — high-N stress (CI regression)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gsd-events-stress-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ---------------------------------------------------------------------
  // Axis 1 — Direct writer parallel scale
  // ---------------------------------------------------------------------

  describe('Axis 1: N parallel EventsWriter.applyEvent calls (direct writer)', () => {
    it(
      `N=${DEFAULT_N} default: ${DEFAULT_N} distinct events persisted, 0 lost / 0 duplicated / 0 corrupted`,
      { timeout: 30000 },
      async () => {
        const N = DEFAULT_N;
        const path = join(testDir, 'events.md');

        const start = Date.now();
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            EventsWriter.applyEvent(path, {
              id: i,
              type: 'hp_change',
              payload: { character: 'aragorn', delta: 1 },
            }),
          ),
        );
        const wall = Date.now() - start;

        // Generous CI safety margin: spike 010 baseline is 7ms for N=100
        // (direct writer). Even on the slowest CI runner we benchmark
        // (~10x slower than M5 Pro), N=1000 should complete in <100ms;
        // the 5s cap insulates against truly pathological CI variance.
        expect(wall).toBeLessThan(5000);

        const raw = await readFile(path, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines.length).toBe(N);

        // Parse every line, build the id set, assert 0 missing AND 0
        // duplicated. The set's size invariant catches duplicates; the
        // per-id `has` check catches missing ones. Together they assert
        // "0 lost / 0 duplicated / 0 corrupted" (corruption would have
        // thrown inside JSON.parse).
        const parsed = lines.map((l) => JSON.parse(l));
        const ids = new Set(parsed.map((e) => e.id));
        expect(ids.size).toBe(N); // 0 duplicated
        for (let i = 0; i < N; i++) {
          expect(ids.has(i)).toBe(true); // 0 lost
        }
      },
    );

    // The STRESS_N case only runs when explicitly overridden (operator
    // sets `STRESS_N=10000 pnpm test ...`). Skipping on default keeps
    // the CI run fast while preserving the escape hatch for ad-hoc
    // validation. The wider timeout (120s) accommodates N=10000+ on
    // slower hardware.
    const itOrSkip = STRESS_N_OVERRIDDEN ? it : it.skip;
    itOrSkip(
      `STRESS_N=${STRESS_N} override scales beyond default: ${STRESS_N} distinct events, 0 lost / 0 duplicated`,
      { timeout: 120000 },
      async () => {
        const N = STRESS_N;
        const path = join(testDir, 'events.md');

        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            EventsWriter.applyEvent(path, {
              id: i,
              type: 'hp_change',
              payload: { character: 'aragorn', delta: 1 },
            }),
          ),
        );

        const raw = await readFile(path, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines.length).toBe(N);

        const parsed = lines.map((l) => JSON.parse(l));
        const ids = new Set(parsed.map((e) => e.id));
        expect(ids.size).toBe(N);
        for (let i = 0; i < N; i++) {
          expect(ids.has(i)).toBe(true);
        }
      },
    );
  });

  // ---------------------------------------------------------------------
  // Axis 2 — Dispatch-layer stress (validate + write + projector regen)
  // ---------------------------------------------------------------------

  describe('Axis 2: dispatch-layer stress (validation + write + projector regen)', () => {
    /**
     * Five-character seed for the dispatch-layer stress cases. Each
     * character has the same hp_max (large enough that 20 successive
     * `-1` deltas do not bottom the clamp out — the test asserts the
     * final hp_current matches the deterministic projector output).
     */
    const CAMPAIGN_UUID = '11111111-2222-3333-4444-555555555555';
    const CHAR_UUIDS = [
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444',
      'cccccccc-1111-2222-3333-444444444444',
      'dddddddd-1111-2222-3333-444444444444',
      'eeeeeeee-1111-2222-3333-444444444444',
    ];
    const CHAR_NAMES = ['Aragorn', 'Boromir', 'Cleric', 'Druid', 'Eldrin'];

    async function seedFiveCharacters(mod: VaultDispatchModule): Promise<void> {
      await seedDirect(
        mod.eventsPath(CAMPAIGN_UUID),
        CAMPAIGN_UUID,
        CHAR_UUIDS.map((id, idx) => ({
          id,
          name: CHAR_NAMES[idx]!,
          hp_max: 1000,
          hp_current: 1000,
        })),
      );
    }

    it(
      'N=100 parallel dispatchVaultTool apply_event → 101 events.md lines, all 5 views consistent',
      { timeout: 30000 },
      async () => {
        const mod = await freshVaultModule(testDir);
        await seedFiveCharacters(mod);

        // 100 hp_change events distributed across 5 characters (20 each).
        // Delta = -1 on each call; the seeded hp_max=1000 leaves plenty
        // of room so no clamp activates. Final expected per-character
        // hp_current = 1000 - 20 = 980.
        const N = 100;
        const events = Array.from({ length: N }, (_, i) => ({
          type: 'hp_change' as const,
          payload: { character: CHAR_UUIDS[i % CHAR_UUIDS.length]!, delta: -1 },
        }));

        const results = await Promise.all(
          events.map((e) =>
            mod.dispatchVaultTool('apply_event', e, { campaignId: CAMPAIGN_UUID }),
          ),
        );

        // All 100 dispatches succeeded — the mutex guarantee holds end-
        // to-end through the dispatcher's validate→write→regen pipeline.
        for (const r of results) {
          expect(r.isError).toBe(false);
        }
        expect(results.filter((r) => !r.isError).length).toBe(N);

        // events.md line count: 1 seed + 100 mutations = 101.
        const raw = await readFile(mod.eventsPath(CAMPAIGN_UUID), 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines.length).toBe(N + 1);

        // Each line parses to a well-formed envelope. The mutation
        // envelopes carry distinct UUIDs.
        const ids = new Set<string>();
        for (let i = 1; i < lines.length; i++) {
          const env = JSON.parse(lines[i]!) as { id: string; type: string };
          expect(env.type).toBe('hp_change');
          ids.add(env.id);
        }
        expect(ids.size).toBe(N);

        // For each character, the projector ran 20 times under
        // concurrent load. The view file MUST reflect the deterministic
        // final state (hp_max - 20 = 980), regardless of dispatch order.
        for (let idx = 0; idx < CHAR_UUIDS.length; idx++) {
          const viewPath = mod.characterViewPath(
            CAMPAIGN_UUID,
            CHAR_NAMES[idx]!,
            CHAR_UUIDS[idx]!,
          );
          const view = await readFile(viewPath, 'utf8');
          const parsed = mod.parseView(view);
          expect(parsed).not.toBeNull();
          expect(parsed!.hp_current).toBe(980);
          expect(parsed!.hp_max).toBe(1000);
        }
      },
    );

    it(
      'wall-clock total for N=100 parallel dispatches divided by N is < 50ms (NIT 4)',
      { timeout: 30000 },
      async () => {
        const mod = await freshVaultModule(testDir);
        await seedFiveCharacters(mod);

        const N = 100;
        const events = Array.from({ length: N }, (_, i) => ({
          type: 'hp_change' as const,
          payload: { character: CHAR_UUIDS[i % CHAR_UUIDS.length]!, delta: -1 },
        }));

        // NIT 4 — wall-clock is measured AROUND a SINGLE await
        // Promise.all(...). The per-event metric is wall_ms / N. Summing
        // per-event timings would be ~N× wall-clock under mutex
        // serialization and is explicitly forbidden by the plan.
        const start = Date.now();
        const results = await Promise.all(
          events.map((e) =>
            mod.dispatchVaultTool('apply_event', e, { campaignId: CAMPAIGN_UUID }),
          ),
        );
        const wall_ms = Date.now() - start;

        // Sanity: the run actually completed successfully — otherwise
        // the timing assertion below would be vacuous.
        for (const r of results) {
          expect(r.isError).toBe(false);
        }

        const per_event_ms = wall_ms / N;
        // 50ms cap is generous CI headroom. Spike 010 reference (direct
        // writer) is 0.07ms/event; the dispatcher adds projector regen
        // (~1-5ms typical per spike 008). If this ever fails, RESEARCH
        // Pitfall 3 has activated (view regen has grown too expensive)
        // and Phase 03 snapshot+compact becomes the trigger.
        expect(per_event_ms).toBeLessThan(50);
      },
    );
  });

  // ---------------------------------------------------------------------
  // Axis 3 — Truncated-tail recovery + mid-line corruption fail-fast
  // ---------------------------------------------------------------------

  describe('Axis 3: truncated-tail recovery (spike 008 corruption fail-fast)', () => {
    /**
     * Helper — append N well-formed mutation envelopes to a fresh
     * events.md and return the absolute path. Uses EventsWriter so the
     * file shape matches production. Sequential await loop (not
     * Promise.all) so the ids appear in deterministic order; the
     * truncation tests rely on knowing which line is "last".
     */
    async function buildEventsFile(path: string, N: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const id = randomUUID();
        ids.push(id);
        await EventsWriter.applyEvent(path, {
          id,
          version: 1,
          type: 'hp_change',
          payload: { character: 'aragorn', delta: 1 },
          timestamp: new Date().toISOString(),
        });
      }
      return ids;
    }

    it('a truncated last line throws fail-fast with the line number', async () => {
      const path = join(testDir, 'events.md');
      const N = 10;
      await buildEventsFile(path, N);

      // Simulate a process crash mid-`appendFile` by slicing off the
      // tail bytes. The chop-50 amount is enough to disrupt the final
      // line's JSON closer (the envelope is ~150 bytes long; chopping
      // 50 leaves the last line malformed but the prior 9 intact).
      const raw = await readFile(path, 'utf8');
      const truncated = raw.slice(0, -50);
      await writeFile(path, truncated, 'utf8');

      // Re-import the projector under VAULT_CAMPAIGNS_ROOT=testDir for
      // consistency (the parseEventsFile function reads from the
      // arbitrary path argument and does NOT depend on env, but we
      // keep the seam to mirror the other axes).
      const { parseEventsFile } = await import('@/ai/master/vault/projector');

      // The fail-fast contract: throw `[projector] corrupt event at
      // line N: <message>`. Line N here is whichever line the truncation
      // affected. With 10 lines and the chop removing only the last
      // line's closing chars, the partial-line is line 10.
      await expect(parseEventsFile(path)).rejects.toThrow(/line 10/);
    });

    it('rolling back the truncated tail to the last valid line restores parseability', async () => {
      const path = join(testDir, 'events.md');
      const N = 10;
      const ids = await buildEventsFile(path, N);

      // Truncate the same way as the previous test.
      const raw = await readFile(path, 'utf8');
      await writeFile(path, raw.slice(0, -50), 'utf8');

      const { parseEventsFile } = await import('@/ai/master/vault/projector');

      // Operator-facing recovery procedure: read raw, drop the last
      // partial line, rewrite. The recovery code below mirrors what
      // the runbook documents — split, walk back to the last fully-
      // parseable line, write that prefix.
      const corrupted = await readFile(path, 'utf8');
      const corruptedLines = corrupted.split('\n');
      let lastValidIdx = -1;
      for (let i = corruptedLines.length - 1; i >= 0; i--) {
        const line = corruptedLines[i]!;
        if (line.trim().length === 0) continue;
        try {
          JSON.parse(line);
          lastValidIdx = i;
          break;
        } catch {
          // try next-earlier line
        }
      }
      expect(lastValidIdx).toBeGreaterThanOrEqual(0);
      const validPrefix = corruptedLines.slice(0, lastValidIdx + 1).join('\n') + '\n';
      await writeFile(path, validPrefix, 'utf8');

      // After recovery the projector parses N-1 envelopes (the
      // truncated tail was discarded) and replay can resume.
      const envelopes = await parseEventsFile(path);
      expect(envelopes.length).toBe(N - 1);
      // The first N-1 ids match (operator recovery preserves history
      // before the corruption point).
      for (let i = 0; i < N - 1; i++) {
        expect(envelopes[i]!.id).toBe(ids[i]!);
      }
    });

    it('a single fully-corrupt line in the middle of events.md aborts replay with that line number', async () => {
      const path = join(testDir, 'events.md');
      const N = 10;
      await buildEventsFile(path, N);

      // Replace line 5 (1-based) with garbage. The reason for "fully
      // corrupt" rather than truncate is to verify the fail-fast
      // contract surfaces the EXACT line number — not just "last" —
      // which is the spike 008 invariant.
      const raw = await readFile(path, 'utf8');
      const lines = raw.split('\n');
      lines[4] = 'NOT JSON'; // 0-based index 4 = 1-based line 5
      await writeFile(path, lines.join('\n'), 'utf8');

      const { parseEventsFile } = await import('@/ai/master/vault/projector');

      // spike 008 fail-fast invariant: surfaces the exact corruption
      // line number so an operator can locate the offending entry
      // immediately. The projector refuses to silently skip corrupt
      // events (would produce wrong derived state).
      await expect(parseEventsFile(path)).rejects.toThrow(/line 5/);
    });
  });

  // ---------------------------------------------------------------------
  // Axis 4 — Multi-campaign isolation
  // ---------------------------------------------------------------------

  describe('isolation: stress on multiple campaigns in parallel', () => {
    it(
      'N=100 events per campaign × 5 campaigns = 500 total, no cross-contamination',
      { timeout: 30000 },
      async () => {
        const mod = await freshVaultModule(testDir);

        // Five distinct campaign UUIDs + one character per campaign
        // (keeps the seed minimal — the test focuses on per-campaign
        // path isolation, not per-character routing within a campaign).
        const CAMPAIGNS = [
          '11111111-aaaa-bbbb-cccc-000000000001',
          '22222222-aaaa-bbbb-cccc-000000000002',
          '33333333-aaaa-bbbb-cccc-000000000003',
          '44444444-aaaa-bbbb-cccc-000000000004',
          '55555555-aaaa-bbbb-cccc-000000000005',
        ];
        const CHARS = [
          'aaaa1111-1111-2222-3333-444444444444',
          'bbbb2222-1111-2222-3333-444444444444',
          'cccc3333-1111-2222-3333-444444444444',
          'dddd4444-1111-2222-3333-444444444444',
          'eeee5555-1111-2222-3333-444444444444',
        ];

        // Seed every campaign sequentially. Seeding in parallel works
        // (per-path mutex isolates them) but sequential makes the test
        // setup easier to reason about and the actual stress is the
        // mutation Promise.all below.
        for (let c = 0; c < CAMPAIGNS.length; c++) {
          await seedDirect(mod.eventsPath(CAMPAIGNS[c]!), CAMPAIGNS[c]!, [
            {
              id: CHARS[c]!,
              name: 'Hero' + c,
              hp_max: 1000,
              hp_current: 1000,
            },
          ]);
        }

        // Build 500 mutation events: 100 per campaign, all `-1` hp
        // deltas to the campaign's single character. Total stress =
        // 500 parallel dispatches across 5 different events.md files;
        // the per-path mutex isolates each file's writer chain.
        const N_PER_CAMPAIGN = 100;
        const allDispatches: Promise<{ isError: boolean; content: string }>[] = [];
        for (let c = 0; c < CAMPAIGNS.length; c++) {
          for (let i = 0; i < N_PER_CAMPAIGN; i++) {
            allDispatches.push(
              mod.dispatchVaultTool(
                'apply_event',
                {
                  type: 'hp_change',
                  payload: { character: CHARS[c]!, delta: -1 },
                },
                { campaignId: CAMPAIGNS[c]! },
              ),
            );
          }
        }
        const results = await Promise.all(allDispatches);

        // All 500 succeeded.
        const okCount = results.filter((r) => !r.isError).length;
        expect(okCount).toBe(CAMPAIGNS.length * N_PER_CAMPAIGN);

        // Per-campaign assertions: each events.md has 1 seed + 100
        // mutations = 101 lines, all mutations carry distinct ids, and
        // (critically) NO id from one campaign appears in another.
        const idsByCampaign = new Map<string, Set<string>>();
        for (const cId of CAMPAIGNS) {
          const raw = await readFile(mod.eventsPath(cId), 'utf8');
          const lines = raw.trim().split('\n');
          expect(lines.length).toBe(N_PER_CAMPAIGN + 1);

          const ids = new Set<string>();
          for (let i = 1; i < lines.length; i++) {
            const env = JSON.parse(lines[i]!) as { id: string };
            ids.add(env.id);
          }
          expect(ids.size).toBe(N_PER_CAMPAIGN);
          idsByCampaign.set(cId, ids);
        }

        // Cross-contamination check: pairwise intersection of every
        // campaign's id set MUST be empty. With 5 campaigns this is
        // 10 pairwise checks (5 choose 2). If any id appears in two
        // campaigns' events.md, the per-path mutex pattern leaked
        // across campaigns and the test fails loudly.
        for (let i = 0; i < CAMPAIGNS.length; i++) {
          for (let j = i + 1; j < CAMPAIGNS.length; j++) {
            const a = idsByCampaign.get(CAMPAIGNS[i]!)!;
            const b = idsByCampaign.get(CAMPAIGNS[j]!)!;
            for (const id of a) {
              expect(b.has(id)).toBe(false);
            }
          }
        }
      },
    );
  });
});
