#!/usr/bin/env tsx
/**
 * scripts/bench-phase-03-m4.ts — unified M4 bench runner (REQ-020).
 *
 * Orchestrates the validated spike harnesses (004 + 011 + 014) and aggregates
 * their results into a decision-grade JSON. Operator runs this on the Mac Mini
 * M4 BEFORE Phase 03-C decommission (so `dnd-master-plus` is still available
 * as the A/B baseline for spike 014).
 *
 * The three spike harnesses are external scripts whose stdout formats are
 * snapshot-tested via the parsers below. Refer to the result samples under
 * `.planning/spikes/00{4,11,14}/results/` for the exact line shapes.
 *
 * Pass/fail gates per the ROADMAP success criteria:
 *   - Stage 1 (spike 004): vault WARM wall-clock < 5000 ms             [G1]
 *   - Stage 1 (spike 004): lenient compliance == 100%                  [G2]
 *   - Stage 2 (spike 011): last-5-turn avg < first-5-turn avg * 1.5     (no prompt-growth drift)
 *   - Stage 3 (spike 014): NOT machine-scored (humans rank 1-4 per scenario);
 *     the runner reports turn count + avg wall-clock and a deferred-grade flag.
 *     The operator fills the rank tables in `comparison-*.md`, then declares
 *     PASS only if Qwen3 30B variants beat Mistral 24B in narrative dimensions.
 *
 * Output: .planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json
 *
 * CLI:
 *   pnpm bench-phase-03-m4                                  # run all stages
 *   pnpm bench-phase-03-m4 --dry-run                        # print plan, no spikes invoked
 *   pnpm bench-phase-03-m4 --out=./custom-path.json         # override output path
 *
 * Next step on PASS: operator runs plan 03-D-02 to paste the measured numbers
 * into Phase 01 SUMMARY.md "M4 target hardware" table (closes REQ-021).
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────

export const RESULTS_DIR = '.planning/phases/03-migration-cutover/bench-results';

export const G1_WARM_WALL_MS_TARGET = 5_000; // vault WARM wall-clock target
export const G2_LENIENT_COMPLIANCE_TARGET = 100; // percent (must be 100%)
export const STAGE2_GROWTH_FACTOR = 1.5; // last-5-avg < first-5-avg * 1.5

// Each spike harness lives under .planning/spikes/<id>/.
export const SPIKE_004_CMD = 'bash .planning/spikes/004-m4-validation/run-on-m4.sh';
export const SPIKE_011_CMD = 'pnpm exec tsx .planning/spikes/011-full-session-simulation/run-session.ts';
export const SPIKE_014_CMD = 'bash .planning/spikes/014-narrative-quality/run-on-m4.sh';

// ─── Types ────────────────────────────────────────────────────────────────

export type StageId = 'g1-warm' | 'g2-compliance' | 'long-session' | 'narrative';
export type GateOutcome = 'pass' | 'fail' | 'error' | 'manual';

export interface StageResult {
  stage: StageId;
  passed: boolean;
  measured: number | string;
  target: number | string;
  gate: GateOutcome;
  rawOutputTail?: string;
  errorMessage?: string;
}

export interface AggregatedReport {
  ts: string;
  overallPass: boolean;
  results: StageResult[];
}

export interface CliArgs {
  dryRun: boolean;
  out: string | null; // null → auto path under RESULTS_DIR
}

// ─── CLI parsing ──────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let out: string | null = null;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm bench-phase-03-m4 [--dry-run] [--out=<path>]');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, out };
}

// ─── Parsers ──────────────────────────────────────────────────────────────
//
// The regexes below are calibrated against the existing M4 result samples
// (`.planning/spikes/004-m4-validation/results/walltime-m4-*.log` and friends).
// Each parser returns null when the metric is absent — the caller treats that
// as an `error` gate, not a fail (parser drift is its own bug).

/**
 * Extract the vault WARM wall-clock (ms) from a spike 004 walltime log.
 *
 * Looks for the comparison summary block:
 *   WARM    baked: wall=NNNNNms ...
 *           vault: wall=NNNNms ...
 * Returns the vault number (the second `wall=Nms` after the WARM token).
 */
export function parseWarmWallClock(stdout: string): number | null {
  const idx = stdout.search(/^WARM\b/m);
  if (idx < 0) return null;
  // Take the slice after "WARM" — the vault line is the second wall= match.
  const tail = stdout.slice(idx);
  const matches = [...tail.matchAll(/wall=(\d+)ms/g)];
  if (matches.length < 2) return null;
  return Number(matches[1]![1]);
}

/**
 * Extract the lenient compliance percent from a spike 004 compliance log.
 *
 * Looks for: `lenient=N/M (PCT%)`.
 */
export function parseLenientCompliance(stdout: string): number | null {
  const m = stdout.match(/lenient=\d+\/\d+\s*\((\d+(?:\.\d+)?)%\)/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Extract per-turn wall_ms values from a spike 011 session log.
 *
 * Matches lines like: `[turn  N] wall=NNNNms tool_calls=...`.
 */
export function parseTurnWallTimes(stdout: string): number[] {
  return [...stdout.matchAll(/\[turn\s+\d+\]\s+wall=(\d+)ms/g)].map((m) => Number(m[1]));
}

/**
 * Extract the narrative-quality count of completed (non-error) scenarios.
 *
 * Spike 014 has NO automated score — humans rank 1-4 per scenario after
 * reading the markdown report. The best we can do here is confirm the
 * harness produced N model × M scenarios = K successful turns. Returns
 * `{ ok, total }` so the gate can warn rather than fail on humanwork.
 */
export function parseNarrativeTurnCounts(stdout: string): { ok: number; total: number } {
  // The harness logs `wall=Nms ptok=N etok=N chars=N` on success and
  // `FAIL: <err>` on error. Each scenario line begins with `  [<id>] ... `.
  const ok = [...stdout.matchAll(/^\s*\[[^\]]+\]\s+\.\.\.\s+wall=\d+ms/gm)].length;
  const failed = [...stdout.matchAll(/^\s*\[[^\]]+\]\s+\.\.\.\s+FAIL:/gm)].length;
  return { ok, total: ok + failed };
}

// ─── Stage runner ─────────────────────────────────────────────────────────

/**
 * Invoke a spike harness, capturing stdout. Stderr is inherited (streams to
 * the operator's terminal so they see progress). Throws when the subprocess
 * exits non-zero — the caller wraps in try/catch and records as `gate: error`.
 */
export function runStage(name: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env });
}

// ─── Main ─────────────────────────────────────────────────────────────────

interface MainCtx {
  args: CliArgs;
  ts: string;
}

/**
 * The full pipeline as a single function so tests can drive it with mocked
 * execSync. Returns the aggregated report and the path written to.
 */
export async function runPipeline(ctx: MainCtx): Promise<{ report: AggregatedReport; outPath: string }> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const results: StageResult[] = [];
  let overallPass = true;

  // ─── Stage 1 — Spike 004 (G1 + G2) ────────────────────────────────────
  // Spike 004 has two internal phases: compliance sweep (5 models × V2_strict)
  // then walltime sweep (5 vault candidates × baked baseline). The full stdout
  // contains both, so we run it ONCE and parse both metrics.
  try {
    const stage1 = runStage('Stage 1 — spike 004 M4 sweep (G1 + G2)', SPIKE_004_CMD);
    const warm = parseWarmWallClock(stage1);
    const compliance = parseLenientCompliance(stage1);

    // G1: warm wall-clock
    if (warm === null) {
      results.push({
        stage: 'g1-warm',
        passed: false,
        measured: 'unparseable',
        target: `< ${G1_WARM_WALL_MS_TARGET} ms`,
        gate: 'error',
        rawOutputTail: stage1.slice(-2000),
      });
      overallPass = false;
    } else {
      const passed = warm < G1_WARM_WALL_MS_TARGET;
      results.push({
        stage: 'g1-warm',
        passed,
        measured: `${warm} ms`,
        target: `< ${G1_WARM_WALL_MS_TARGET} ms`,
        gate: passed ? 'pass' : 'fail',
        rawOutputTail: stage1.slice(-2000),
      });
      if (!passed) overallPass = false;
    }

    // G2: lenient compliance
    if (compliance === null) {
      results.push({
        stage: 'g2-compliance',
        passed: false,
        measured: 'unparseable',
        target: `${G2_LENIENT_COMPLIANCE_TARGET}%`,
        gate: 'error',
      });
      overallPass = false;
    } else {
      const passed = compliance >= G2_LENIENT_COMPLIANCE_TARGET;
      results.push({
        stage: 'g2-compliance',
        passed,
        measured: `${compliance}%`,
        target: `${G2_LENIENT_COMPLIANCE_TARGET}%`,
        gate: passed ? 'pass' : 'fail',
      });
      if (!passed) overallPass = false;
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    results.push({
      stage: 'g1-warm',
      passed: false,
      measured: 'error',
      target: `< ${G1_WARM_WALL_MS_TARGET} ms`,
      gate: 'error',
      errorMessage,
    });
    results.push({
      stage: 'g2-compliance',
      passed: false,
      measured: 'error',
      target: `${G2_LENIENT_COMPLIANCE_TARGET}%`,
      gate: 'error',
      errorMessage,
    });
    overallPass = false;
  }

  // ─── Stage 2 — Spike 011 long-session (summarizer ON) ─────────────────
  try {
    const stage2 = runStage(
      'Stage 2 — spike 011 long-session (MASTER_SUMMARIZATION=on)',
      SPIKE_011_CMD,
      { ...process.env, MASTER_SUMMARIZATION: 'on' },
    );
    const turns = parseTurnWallTimes(stage2);
    if (turns.length >= 10) {
      const firstAvg = turns.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const lastAvg = turns.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const passed = lastAvg < firstAvg * STAGE2_GROWTH_FACTOR;
      results.push({
        stage: 'long-session',
        passed,
        measured: `first5_avg=${firstAvg.toFixed(0)}ms last5_avg=${lastAvg.toFixed(0)}ms`,
        target: `last5_avg < first5_avg × ${STAGE2_GROWTH_FACTOR}`,
        gate: passed ? 'pass' : 'fail',
        rawOutputTail: stage2.slice(-2000),
      });
      if (!passed) overallPass = false;
    } else {
      results.push({
        stage: 'long-session',
        passed: false,
        measured: `only ${turns.length} turns parsed`,
        target: '>= 10 turns',
        gate: 'error',
        rawOutputTail: stage2.slice(-2000),
      });
      overallPass = false;
    }
  } catch (e) {
    results.push({
      stage: 'long-session',
      passed: false,
      measured: 'error',
      target: `last5_avg < first5_avg × ${STAGE2_GROWTH_FACTOR}`,
      gate: 'error',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    overallPass = false;
  }

  // ─── Stage 3 — Spike 014 narrative quality ────────────────────────────
  // Spike 014 produces a markdown report meant for HUMAN evaluation; there
  // is no automated quality score. We assert the harness completed (all
  // model × scenario turns produced output) and surface a `manual` gate so
  // the operator knows the bench is incomplete until they fill the rank
  // tables in `comparison-*.md`.
  try {
    const stage3 = runStage('Stage 3 — spike 014 narrative quality', SPIKE_014_CMD);
    const counts = parseNarrativeTurnCounts(stage3);
    const harnessOk = counts.total > 0 && counts.ok === counts.total;
    results.push({
      stage: 'narrative',
      passed: harnessOk, // gate is "harness completed"; quality verdict is manual
      measured: `${counts.ok}/${counts.total} scenarios completed`,
      target: 'all scenarios complete + human verdict in comparison-*.md',
      gate: harnessOk ? 'manual' : 'error',
      rawOutputTail: stage3.slice(-2000),
    });
    if (!harnessOk) overallPass = false;
  } catch (e) {
    results.push({
      stage: 'narrative',
      passed: false,
      measured: 'error',
      target: 'all scenarios complete + human verdict',
      gate: 'error',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    overallPass = false;
  }

  const report: AggregatedReport = { ts: ctx.ts, overallPass, results };
  const outPath = ctx.args.out ? resolve(ctx.args.out) : join(RESULTS_DIR, `phase-03-m4-${ctx.ts}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  return { report, outPath };
}

/**
 * Print the human-friendly summary table to stdout.
 */
export function printSummaryTable(report: AggregatedReport, outPath: string): void {
  console.log(`\n→ results: ${outPath}`);
  console.log('\n┌──────────────────────────────────────────────────────────────────────┐');
  console.log('│ Stage           Gate       Measured                       Target       │');
  console.log('├──────────────────────────────────────────────────────────────────────┤');
  for (const r of report.results) {
    const symbol = r.gate === 'pass'
      ? 'PASS'
      : r.gate === 'fail'
        ? 'FAIL'
        : r.gate === 'manual'
          ? 'MANUAL'
          : 'ERROR';
    const stagePadded = r.stage.padEnd(15);
    const symbolPadded = symbol.padEnd(10);
    const measuredPadded = String(r.measured).padEnd(28);
    console.log(`│ ${stagePadded} ${symbolPadded} ${measuredPadded} ${r.target}`);
  }
  console.log('├──────────────────────────────────────────────────────────────────────┤');
  if (report.overallPass) {
    console.log('│ OVERALL: PASS — next: run plan 03-D-02 to update Phase 01 SUMMARY.md │');
  } else {
    console.log('│ OVERALL: FAIL — investigate the failing stage(s) BEFORE decommission │');
  }
  console.log('└──────────────────────────────────────────────────────────────────────┘');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  if (args.dryRun) {
    console.log('--- DRY RUN — no spike harnesses will be invoked ---');
    console.log(`Stage 1: ${SPIKE_004_CMD}`);
    console.log(`Stage 2: ${SPIKE_011_CMD}    (env: MASTER_SUMMARIZATION=on)`);
    console.log(`Stage 3: ${SPIKE_014_CMD}`);
    const autoPath = join(RESULTS_DIR, `phase-03-m4-${ts}.json`);
    console.log(`Output:  ${args.out ?? autoPath}`);
    console.log('\nGates:');
    console.log(`  G1 vault warm wall-clock < ${G1_WARM_WALL_MS_TARGET} ms`);
    console.log(`  G2 lenient compliance == ${G2_LENIENT_COMPLIANCE_TARGET}%`);
    console.log(`  Stage 2 last-5-avg < first-5-avg × ${STAGE2_GROWTH_FACTOR}`);
    console.log('  Stage 3 manual narrative verdict (operator fills comparison-*.md)');
    return;
  }

  const { report, outPath } = await runPipeline({ args, ts });
  printSummaryTable(report, outPath);
  process.exit(report.overallPass ? 0 : 1);
}

// Skip auto-run when imported as a module (tests). `require.main === module`
// is the standard tsx/CommonJS guard — vitest dynamic-imports the file under
// a different `module` and thus skips this branch.
if (require.main === module) {
  main().catch((e) => {
    console.error('bench-phase-03-m4 fatal:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
