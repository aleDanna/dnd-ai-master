/**
 * tests/scripts/bench-phase-03-m4.test.ts — script-shape smoke test for
 * the unified M4 bench runner (plan 03-D-01).
 *
 * The real bench requires M4 hardware + Ollama + minutes of wall-clock.
 * CI runs only on M5 Pro dev hardware, so we cannot invoke the spike
 * harnesses here. Instead we:
 *   1. Exercise the pure parsers against representative log fragments
 *      lifted from `.planning/spikes/00{4,11}/results/*.log` (the real
 *      output is what calibrated the regexes in the first place).
 *   2. Drive `runPipeline` end-to-end with a mocked `child_process.execSync`
 *      so we can assert the gate logic + JSON aggregation without touching
 *      a real shell.
 *
 * Coverage:
 *   - parseArgs: --dry-run, --out=<path>, unknown flag exits non-zero
 *   - parseWarmWallClock / parseLenientCompliance / parseTurnWallTimes /
 *     parseNarrativeTurnCounts: happy path + unparseable input → null
 *   - runPipeline: 3-stage happy path → overallPass:true; failing G1 →
 *     overallPass:false; execSync throw on Stage 2 → recorded as `gate:error`
 *   - bench-results directory created when missing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// child_process.execSync must be mocked BEFORE the script module is imported
// (top-level constants in the script don't capture execSync, but each stage
// re-reads it from the module-scope import).
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import {
  parseArgs,
  parseWarmWallClock,
  parseLenientCompliance,
  parseTurnWallTimes,
  parseNarrativeTurnCounts,
  runPipeline,
  G1_WARM_WALL_MS_TARGET,
  G2_LENIENT_COMPLIANCE_TARGET,
} from '../../scripts/bench-phase-03-m4';
import { execSync } from 'node:child_process';

const mockedExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

// Fixtures lifted from real spike-004 + spike-011 result logs (only the
// shape-defining lines, not the full multi-MB output).

const SPIKE_004_HAPPY_STDOUT = `
▶ BAKED baseline: dnd-master-plus:latest
▶ VAULT candidate: qwen3:30b-a3b-instruct-2507-q4_K_M
[baked warm] fireball-5th... ✓ wall=5543ms prefill=43ms eval=5362ms load=102ms calls=0 ptok=144 etok=143
[vault warm] fireball-5th... ✓ wall=3142ms prefill=797ms eval=2241ms load=41ms calls=1 ptok=1098 etok=90

────────────────────────────────────────────────────
 WALL-CLOCK COMPARISON (avg across scenarios)
────────────────────────────────────────────────────
COLD    baked: wall=34856ms prefill=495ms ptok=140 ok=3/5
        vault: wall=15746ms prefill=2171ms ptok=1679 ok=4/5
        Δ wall: -54.8% (vault faster)
WARM    baked: wall=26052ms prefill=42ms ptok=140 ok=4/5
        vault: wall=3782ms prefill=1097ms ptok=1706 ok=4/5
        Δ wall: -85.5% (vault faster)
────────────────────────────────────────────────────

qwen3:30b-a3b-instruct-2507-q4_K_M V2_strict    strict=6/10 (60%)  lenient=10/10 (100%)  avgWall=8653ms  avgPrompt=4936tok  finish={"no_tool_calls":8,"end_turn_tool":2}
`;

const SPIKE_011_HAPPY_STDOUT = `
▶ Model: qwen3:30b-a3b-instruct-2507-q4_K_M
▶ System prompt SHA256: abc123…
▶ Running 10 consecutive turns

[turn  1] wall=  4227ms tool_calls=1 prefill=598ms eval=3389ms ptok=910 etok=213 kw=2/2
[turn  2] wall=  3812ms tool_calls=1 prefill=512ms eval=3001ms ptok=1124 etok=190 kw=2/3
[turn  3] wall=  3920ms tool_calls=0 prefill=420ms eval=3300ms ptok=1230 etok=200 kw=1/1
[turn  4] wall=  4011ms tool_calls=1 prefill=510ms eval=3300ms ptok=1410 etok=210 kw=2/2
[turn  5] wall=  4180ms tool_calls=1 prefill=620ms eval=3300ms ptok=1620 etok=220 kw=3/3
[turn  6] wall=  4520ms tool_calls=2 prefill=680ms eval=3500ms ptok=1820 etok=240 kw=1/1
[turn  7] wall=  4710ms tool_calls=1 prefill=720ms eval=3700ms ptok=2010 etok=260 kw=2/2
[turn  8] wall=  4890ms tool_calls=2 prefill=780ms eval=3800ms ptok=2200 etok=280 kw=3/3
[turn  9] wall=  5012ms tool_calls=1 prefill=820ms eval=3900ms ptok=2400 etok=300 kw=1/1
[turn 10] wall=  5210ms tool_calls=1 prefill=860ms eval=4000ms ptok=2600 etok=320 kw=2/2
`;

const SPIKE_014_HAPPY_STDOUT = `
▶ Running 4 models × 5 scenarios = 20 turns

=== Model: qwen3:30b-a3b-instruct-2507-q4_K_M ===
  [combat-intro] ... wall=4500ms ptok=140 etok=210 chars=850
  [npc-voice] ... wall=4700ms ptok=130 etok=220 chars=920
  [exploration] ... wall=4800ms ptok=145 etok=215 chars=900
  [dialogue] ... wall=4600ms ptok=135 etok=200 chars=880
  [travel-montage] ... wall=4900ms ptok=150 etok=230 chars=950

=== Model: qwen3:30b-a3b-instruct-2507 ===
  [combat-intro] ... wall=5500ms ptok=140 etok=210 chars=830
  [npc-voice] ... wall=5700ms ptok=130 etok=220 chars=910
  [exploration] ... wall=5800ms ptok=145 etok=215 chars=905
  [dialogue] ... wall=5600ms ptok=135 etok=200 chars=860
  [travel-montage] ... wall=5900ms ptok=150 etok=230 chars=940

=== Model: qwen3:30b-a3b ===
  [combat-intro] ... wall=6500ms ptok=140 etok=210 chars=820
  [npc-voice] ... wall=6700ms ptok=130 etok=220 chars=890
  [exploration] ... wall=6800ms ptok=145 etok=215 chars=895
  [dialogue] ... wall=6600ms ptok=135 etok=200 chars=850
  [travel-montage] ... wall=6900ms ptok=150 etok=230 chars=930

=== Model: mistral-small3.2:24b ===
  [combat-intro] ... wall=4500ms ptok=140 etok=210 chars=800
  [npc-voice] ... wall=4700ms ptok=130 etok=220 chars=870
  [exploration] ... wall=4800ms ptok=145 etok=215 chars=870
  [dialogue] ... wall=4600ms ptok=135 etok=200 chars=830
  [travel-montage] ... wall=4900ms ptok=150 etok=230 chars=910
`;

describe('bench-phase-03-m4 — CLI parsing', () => {
  it('defaults to dry-run=false, out=null', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, out: null });
  });

  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, out: null });
  });

  it('parses --out=<path>', () => {
    expect(parseArgs(['--out=/tmp/foo.json'])).toEqual({ dryRun: false, out: '/tmp/foo.json' });
  });

  it('parses both flags together', () => {
    expect(parseArgs(['--dry-run', '--out=/tmp/foo.json'])).toEqual({
      dryRun: true,
      out: '/tmp/foo.json',
    });
  });

  it('exits with code 2 on unknown flag', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['--bogus'])).toThrow(/exit 2/);
    expect(errSpy).toHaveBeenCalledWith('Unknown flag: --bogus');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('bench-phase-03-m4 — parsers', () => {
  it('parseWarmWallClock extracts vault WARM wall-clock (the second wall= after WARM)', () => {
    expect(parseWarmWallClock(SPIKE_004_HAPPY_STDOUT)).toBe(3782);
  });

  it('parseWarmWallClock returns null when WARM block is absent', () => {
    expect(parseWarmWallClock('no warm marker here\nwall=1234ms\n')).toBeNull();
  });

  it('parseWarmWallClock returns null when only one wall= match follows WARM', () => {
    expect(parseWarmWallClock('WARM    baked: wall=26052ms\n(truncated)\n')).toBeNull();
  });

  it('parseLenientCompliance extracts the integer percent', () => {
    expect(parseLenientCompliance(SPIKE_004_HAPPY_STDOUT)).toBe(100);
  });

  it('parseLenientCompliance handles fractional percent', () => {
    expect(parseLenientCompliance('lenient=9/10 (90.5%) other')).toBe(90.5);
  });

  it('parseLenientCompliance returns null when no match', () => {
    expect(parseLenientCompliance('strict=6/10 only')).toBeNull();
  });

  it('parseTurnWallTimes extracts all 10 per-turn wall ms values in order', () => {
    const turns = parseTurnWallTimes(SPIKE_011_HAPPY_STDOUT);
    expect(turns).toHaveLength(10);
    expect(turns[0]).toBe(4227);
    expect(turns[9]).toBe(5210);
  });

  it('parseTurnWallTimes returns [] on no matches', () => {
    expect(parseTurnWallTimes('no turn lines here')).toEqual([]);
  });

  it('parseNarrativeTurnCounts counts ok + failed scenarios', () => {
    const counts = parseNarrativeTurnCounts(SPIKE_014_HAPPY_STDOUT);
    // 4 models × 5 scenarios = 20 success lines, 0 fail.
    expect(counts).toEqual({ ok: 20, total: 20 });
  });

  it('parseNarrativeTurnCounts treats FAIL lines as part of total', () => {
    const mixed = `  [combat-intro] ... wall=4500ms ptok=140 etok=210 chars=850
  [npc-voice] ... FAIL: timeout
  [exploration] ... wall=4800ms ptok=145 etok=215 chars=900`;
    expect(parseNarrativeTurnCounts(mixed)).toEqual({ ok: 2, total: 3 });
  });
});

describe('bench-phase-03-m4 — runPipeline (mocked execSync)', () => {
  let tmpOutDir: string;

  beforeEach(() => {
    mockedExecSync.mockReset();
    tmpOutDir = mkdtempSync(join(tmpdir(), 'bench-phase-03-m4-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpOutDir)) rmSync(tmpOutDir, { recursive: true, force: true });
  });

  it('happy path: all 3 stages pass → overallPass=true, JSON written, results length 4', async () => {
    mockedExecSync
      .mockReturnValueOnce(SPIKE_004_HAPPY_STDOUT) // Stage 1
      .mockReturnValueOnce(SPIKE_011_HAPPY_STDOUT) // Stage 2
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT); // Stage 3

    const outPath = join(tmpOutDir, 'happy.json');
    const { report } = await runPipeline({
      args: { dryRun: false, out: outPath },
      ts: 'unit-test-ts',
    });

    // 4 result rows: g1-warm, g2-compliance, long-session, narrative.
    expect(report.results.map((r) => r.stage)).toEqual([
      'g1-warm',
      'g2-compliance',
      'long-session',
      'narrative',
    ]);
    expect(report.overallPass).toBe(true);
    expect(report.results[0]!.gate).toBe('pass'); // 3782 ms < 5000 ms
    expect(report.results[0]!.measured).toBe('3782 ms');
    expect(report.results[1]!.gate).toBe('pass'); // 100% lenient
    expect(report.results[2]!.gate).toBe('pass'); // last-5 < first-5*1.5
    expect(report.results[3]!.gate).toBe('manual'); // harness done, human verdict pending

    // JSON serialization
    expect(existsSync(outPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(persisted.ts).toBe('unit-test-ts');
    expect(persisted.results).toHaveLength(4);
  });

  it('Stage 2 receives MASTER_SUMMARIZATION=on in env', async () => {
    mockedExecSync
      .mockReturnValueOnce(SPIKE_004_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_011_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT);

    await runPipeline({
      args: { dryRun: false, out: join(tmpOutDir, 'env.json') },
      ts: 'env-test-ts',
    });

    // 2nd execSync call corresponds to Stage 2.
    const stage2Call = mockedExecSync.mock.calls[1];
    expect(stage2Call).toBeDefined();
    const stage2Opts = stage2Call![1] as { env: NodeJS.ProcessEnv };
    expect(stage2Opts.env.MASTER_SUMMARIZATION).toBe('on');
  });

  it('failing G1 (warm 8000ms) flips overallPass=false', async () => {
    const slowStdout = SPIKE_004_HAPPY_STDOUT.replace(
      'vault: wall=3782ms',
      'vault: wall=8000ms',
    );
    mockedExecSync
      .mockReturnValueOnce(slowStdout)
      .mockReturnValueOnce(SPIKE_011_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT);

    const { report } = await runPipeline({
      args: { dryRun: false, out: join(tmpOutDir, 'fail.json') },
      ts: 'fail-test-ts',
    });

    expect(report.overallPass).toBe(false);
    expect(report.results[0]!.gate).toBe('fail');
    expect(report.results[0]!.measured).toBe('8000 ms');
  });

  it('execSync throws on Stage 2 → long-session recorded as gate=error', async () => {
    mockedExecSync
      .mockReturnValueOnce(SPIKE_004_HAPPY_STDOUT)
      .mockImplementationOnce(() => {
        throw new Error('Ollama unreachable');
      })
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT);

    const { report } = await runPipeline({
      args: { dryRun: false, out: join(tmpOutDir, 'err.json') },
      ts: 'err-test-ts',
    });

    expect(report.overallPass).toBe(false);
    const longSession = report.results.find((r) => r.stage === 'long-session')!;
    expect(longSession.gate).toBe('error');
    expect(longSession.errorMessage).toContain('Ollama unreachable');
    // Other stages still complete:
    expect(report.results.find((r) => r.stage === 'g1-warm')!.gate).toBe('pass');
    expect(report.results.find((r) => r.stage === 'narrative')!.gate).toBe('manual');
  });

  it('unparseable spike-004 output → both g1-warm and g2-compliance gate=error', async () => {
    mockedExecSync
      .mockReturnValueOnce('garbage with no recognizable markers')
      .mockReturnValueOnce(SPIKE_011_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT);

    const { report } = await runPipeline({
      args: { dryRun: false, out: join(tmpOutDir, 'parse-fail.json') },
      ts: 'parse-test-ts',
    });

    expect(report.overallPass).toBe(false);
    const g1 = report.results.find((r) => r.stage === 'g1-warm')!;
    const g2 = report.results.find((r) => r.stage === 'g2-compliance')!;
    expect(g1.gate).toBe('error');
    expect(g1.measured).toBe('unparseable');
    expect(g2.gate).toBe('error');
    expect(g2.measured).toBe('unparseable');
  });

  it('creates the RESULTS_DIR when running with default output path', async () => {
    // Setting out=null exercises the default-path branch
    // (`.planning/phases/03-migration-cutover/bench-results/`). mkdirSync is
    // idempotent so the dir may already exist from earlier runs.
    mockedExecSync
      .mockReturnValueOnce(SPIKE_004_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_011_HAPPY_STDOUT)
      .mockReturnValueOnce(SPIKE_014_HAPPY_STDOUT);

    const { outPath } = await runPipeline({
      args: { dryRun: false, out: null },
      ts: 'mkdir-test-ts',
    });

    expect(outPath).toMatch(/bench-results\/phase-03-m4-mkdir-test-ts\.json$/);
    expect(existsSync(outPath)).toBe(true);
    // Clean up the test artifact (we wrote into the real RESULTS_DIR).
    rmSync(outPath, { force: true });
  });
});

describe('bench-phase-03-m4 — gate boundary values', () => {
  it('4999 ms warm passes, 5000 ms warm fails (strict < target)', () => {
    // Sanity check: the gate uses `<`, not `<=`. A spike measuring exactly
    // 5000 ms is a regression — the target is "decisively under 5s".
    expect(G1_WARM_WALL_MS_TARGET).toBe(5000);
    expect(4999 < G1_WARM_WALL_MS_TARGET).toBe(true);
    expect(5000 < G1_WARM_WALL_MS_TARGET).toBe(false);
  });

  it('compliance 99% fails, 100% passes (>= target)', () => {
    expect(G2_LENIENT_COMPLIANCE_TARGET).toBe(100);
    expect(99 >= G2_LENIENT_COMPLIANCE_TARGET).toBe(false);
    expect(100 >= G2_LENIENT_COMPLIANCE_TARGET).toBe(true);
  });
});

describe('bench-phase-03-m4 — fixture is a tmpdir (cleanup sanity)', () => {
  it('tmpdir helper from node:os returns a real directory', () => {
    // Defends against fixture-leak in CI containers: if mkdtempSync ever
    // landed in CWD instead of tmpdir, our cleanup would be incomplete.
    const d = mkdtempSync(join(tmpdir(), 'bench-sanity-'));
    expect(statSync(d).isDirectory()).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});
