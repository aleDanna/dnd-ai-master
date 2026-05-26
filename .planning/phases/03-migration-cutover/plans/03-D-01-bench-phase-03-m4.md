---
phase: 03
plan: D-01
type: execute
wave: 6
depends_on: [03-A-10, 03-B-07]
files_modified:
  - scripts/bench-phase-03-m4.ts
  - package.json
  - tests/scripts/bench-phase-03-m4.test.ts
autonomous: true
requirements: [REQ-020, REQ-031, REQ-032]
must_haves:
  truths:
    - "`pnpm bench-phase-03-m4` runs spike 004 (M4 G1 warm), spike 011 (long-session with MASTER_SUMMARIZATION=on), spike 014 (narrative quality) in sequence"
    - "Each stage's stdout is captured and parsed for the key metrics (warm wall-clock ms, prompt_eval_count, lenient G2 percent, narrative quality score)"
    - "Aggregated output JSON written to .planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json with stage results + pass/fail gates"
    - "Pass/fail gates per ROADMAP success criteria: G1 warm < 5s, G2 lenient 100%, narrative quality >= 4/5"
    - "On any stage failing (non-zero exit OR gate violation), the runner prints the offending stage and exits non-zero"
    - "On all stages passing, the runner prints a summary table + next-step instruction (run plan 03-D-02 to update Phase 01 SUMMARY.md)"
    - "The runner is OPERATOR-RUN on M4 production hardware (REQ-020); CI lints the script shape only (the actual bench requires M4)"
  artifacts:
    - path: "scripts/bench-phase-03-m4.ts"
      provides: "Unified runner orchestrating spike harnesses + result aggregation"
    - path: "package.json"
      provides: "bench-phase-03-m4 script entry"
      contains: "bench-phase-03-m4"
    - path: ".planning/phases/03-migration-cutover/bench-results/"
      provides: "Timestamped bench result JSON files"
    - path: "tests/scripts/bench-phase-03-m4.test.ts"
      provides: "Lightweight script-shape test (the real bench requires M4)"
  key_links:
    - from: "scripts/bench-phase-03-m4.ts"
      to: ".planning/spikes/004-m4-validation/run-on-m4.sh"
      via: "execSync Stage 1"
      pattern: "spikes/004"
    - from: "scripts/bench-phase-03-m4.ts"
      to: ".planning/spikes/011-full-session-simulation/run-session.ts"
      via: "execSync via tsx Stage 2"
      pattern: "spikes/011"
    - from: "scripts/bench-phase-03-m4.ts"
      to: ".planning/spikes/014-narrative-quality/run-on-m4.sh"
      via: "execSync Stage 3"
      pattern: "spikes/014"
---

# Plan 03-D-01: Unified M4 Bench Runner

**Phase:** 03-migration-cutover
**Wave:** 6 (MUST run BEFORE 03-C decommission per Pitfall 7)
**Status:** Pending
**Estimated diff size:** ~200 LOC source + ~150 LOC tests / 3 files

## Goal

Per Decision 9: ship `pnpm bench-phase-03-m4` as a thin orchestrator over the validated spike harnesses (004 + 011 + 014). The runner aggregates their results into a single JSON, applies pass/fail gates per the ROADMAP success criteria, and prints a summary table for the operator.

The actual bench runs ONLY on M4 production hardware (REQ-020 — anything else produces meaningless numbers). CI smoke-tests the script's shape (parseArgs + error handling), not the actual bench.

Per Pitfall 7: this plan must land BEFORE plan 03-C-04 (baked variant decommission), because the bench compares against the `dnd-master-plus` baseline that 03-C-04 retires.

## Requirements satisfied

- **REQ-020** — M4 production hardware validation (the bench IS this validation)
- **REQ-031** — confirms `qwen3:30b-a3b-instruct-2507` (non-q4 fallback) is available + functional
- **REQ-032** — confirms `mistral-small3.2:24b` is selectable (even if spike 014 already eliminated it for live turns — REQ-032 keeps it as offline content tool)

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/bench-phase-03-m4.ts` | NEW | The unified runner |
| `package.json` | EDIT | Add bench-phase-03-m4 entry |
| `tests/scripts/bench-phase-03-m4.test.ts` | NEW | Lightweight script-shape test (no real bench) |

## Tasks

<task type="auto">
  <name>Task 1: Write scripts/bench-phase-03-m4.ts</name>
  <files>scripts/bench-phase-03-m4.ts</files>
  <read_first>
    - .planning/spikes/004-m4-validation/run-on-m4.sh (the spike 004 harness — read for output format)
    - .planning/spikes/011-full-session-simulation/run-session.ts (spike 011 — output format)
    - .planning/spikes/014-narrative-quality/run-on-m4.sh (spike 014 — output format)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§"Bench-phase-03-m4 runner" code example — the canonical shape)
  </read_first>
  <action>
Create `scripts/bench-phase-03-m4.ts`. Use the RESEARCH §"Bench-phase-03-m4 runner" code example as the reference.

Key requirements:
1. `mkdirSync('.planning/phases/03-migration-cutover/bench-results', {recursive: true})` at the top
2. Stage 1 — execSync `bash .planning/spikes/004-m4-validation/run-on-m4.sh` capturing stdout
3. Stage 2 — execSync `pnpm exec tsx .planning/spikes/011-full-session-simulation/run-session.ts` with env `MASTER_SUMMARIZATION=on`
4. Stage 3 — execSync `bash .planning/spikes/014-narrative-quality/run-on-m4.sh`
5. After each stage, parse the stdout for key metrics (regex extraction — the exact regexes depend on each spike's output format; READ the spike harnesses to confirm)
6. Apply pass/fail gates:
   - G1: parsed `warm wall-clock` < 5000 ms
   - G2: parsed `lenient compliance` === 100% (or 1.0)
   - Narrative: parsed `5-keyword score` >= 4 (out of 5)
7. Write aggregated JSON to `bench-results/phase-03-m4-<ts>.json`
8. Print a summary table:
   ```
   Stage              Pass    Measured        Gate
   ─────────────────────────────────────────────────
   Stage 1 (G1 warm)  ✓       3.78s           < 5s
   Stage 2 (long-ses) ✓       avg=4.2s flat   no degradation
   Stage 3 (quality)  ✓       4/5             >= 4/5
   ─────────────────────────────────────────────────
   OVERALL: PASS
   ```
9. Exit 0 if all pass; 1 if any fail

Add error handling: if a spike harness exits non-zero or its output is unparseable, log the stage + raw stdout/stderr + exit 1.

The runner is an operator script — it must produce clear, actionable output (not just JSON).

```ts
#!/usr/bin/env tsx
/**
 * scripts/bench-phase-03-m4.ts — unified M4 bench runner (REQ-020).
 *
 * Orchestrates the validated spike harnesses (004 + 011 + 014) and
 * aggregates their results into a decision-grade JSON. Operator runs on
 * the Mac Mini M4 BEFORE Phase 03-C decommission (so dnd-master-plus is
 * still available as the A/B baseline for spike 014).
 *
 * Pass/fail gates per ROADMAP success criteria:
 *   - Stage 1: warm wall-clock < 5s
 *   - Stage 2: long-session avg turn flat (no degradation over 20 turns)
 *   - Stage 3: narrative quality >= 4/5
 *
 * Output: .planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json
 * Next step: operator runs plan 03-D-02 to update Phase 01 SUMMARY.md "M4 target
 * hardware" table with the measured numbers (closes REQ-021 deferral).
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface StageResult {
  stage: 'g1-warm' | 'long-session' | 'narrative';
  passed: boolean;
  measured: number | string;
  target: number | string;
  gate: 'pass' | 'fail' | 'error';
  rawOutput?: string;
  errorMessage?: string;
}

const RESULTS_DIR = '.planning/phases/03-migration-cutover/bench-results';
const TS = new Date().toISOString().replace(/[:.]/g, '-');

function runStage(name: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${cmd}`);
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env });
    return stdout;
  } catch (e: any) {
    console.error(`[bench-phase-03-m4] ${name} FAILED: exit ${e.status}`);
    throw e;
  }
}

function parseWarmWallClock(stdout: string): number | null {
  // Match formats like "warm wall-clock: 3782 ms" or "warm: 3.78s"
  // The exact format depends on the spike 004 harness output — adjust regex per actual output
  const ms = stdout.match(/warm wall-clock:?\s+(\d+)\s*ms/i);
  if (ms) return Number(ms[1]);
  const s = stdout.match(/warm:?\s+([\d.]+)\s*s/i);
  if (s) return Math.round(Number(s[1]) * 1000);
  return null;
}

function parseLenientCompliance(stdout: string): number | null {
  // Match "lenient compliance: 100%" or "G2: 1.0"
  const pct = stdout.match(/lenient compliance:?\s+(\d+)%/i);
  if (pct) return Number(pct[1]);
  return null;
}

function parseNarrativeScore(stdout: string): number | null {
  // Match "narrative quality: 4/5" or "5-keyword: 4"
  const match = stdout.match(/(?:narrative quality|5-keyword)[:\s]+(\d+)\s*\/?\s*\d*/i);
  if (match) return Number(match[1]);
  return null;
}

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const results: StageResult[] = [];
  let overallPass = true;

  // Stage 1 — Spike 004 G1 warm
  try {
    const stage1 = runStage('Stage 1 — spike 004 M4 G1 warm', 'bash .planning/spikes/004-m4-validation/run-on-m4.sh');
    const warm = parseWarmWallClock(stage1);
    const target = 5000;
    const passed = warm !== null && warm < target;
    results.push({ stage: 'g1-warm', passed, measured: warm ?? 'unparseable', target: `< ${target} ms`, gate: passed ? 'pass' : 'fail', rawOutput: stage1.slice(-2000) });
    if (!passed) overallPass = false;
  } catch (e) {
    results.push({ stage: 'g1-warm', passed: false, measured: 'error', target: '< 5000 ms', gate: 'error', errorMessage: e instanceof Error ? e.message : String(e) });
    overallPass = false;
  }

  // Stage 2 — Spike 011 long-session with summarizer ON
  try {
    const stage2 = runStage('Stage 2 — spike 011 long-session (MASTER_SUMMARIZATION=on)',
      'pnpm exec tsx .planning/spikes/011-full-session-simulation/run-session.ts',
      { ...process.env, MASTER_SUMMARIZATION: 'on' });
    // Spike 011 reports per-turn timings; the gate is "20-turn avg stays flat".
    // Parse the per-turn timings; if the last 5 turns' avg > first 5 turns' avg * 1.5, FAIL.
    const turns = [...stage2.matchAll(/turn (\d+).*?(\d+)\s*ms/g)].map((m) => Number(m[2]));
    if (turns.length >= 10) {
      const firstAvg = turns.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const lastAvg = turns.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const passed = lastAvg < firstAvg * 1.5;
      results.push({ stage: 'long-session', passed, measured: `first5=${firstAvg.toFixed(0)}ms last5=${lastAvg.toFixed(0)}ms`, target: 'last5 < first5*1.5', gate: passed ? 'pass' : 'fail', rawOutput: stage2.slice(-2000) });
      if (!passed) overallPass = false;
    } else {
      results.push({ stage: 'long-session', passed: false, measured: 'too few turns', target: '20-turn session', gate: 'error' });
      overallPass = false;
    }
  } catch (e) {
    results.push({ stage: 'long-session', passed: false, measured: 'error', target: 'flat avg', gate: 'error', errorMessage: e instanceof Error ? e.message : String(e) });
    overallPass = false;
  }

  // Stage 3 — Spike 014 narrative quality
  try {
    const stage3 = runStage('Stage 3 — spike 014 narrative quality', 'bash .planning/spikes/014-narrative-quality/run-on-m4.sh');
    const score = parseNarrativeScore(stage3);
    const target = 4;
    const passed = score !== null && score >= target;
    results.push({ stage: 'narrative', passed, measured: score !== null ? `${score}/5` : 'unparseable', target: `>= ${target}/5`, gate: passed ? 'pass' : 'fail', rawOutput: stage3.slice(-2000) });
    if (!passed) overallPass = false;
  } catch (e) {
    results.push({ stage: 'narrative', passed: false, measured: 'error', target: '>= 4/5', gate: 'error', errorMessage: e instanceof Error ? e.message : String(e) });
    overallPass = false;
  }

  // Aggregate output
  const outPath = join(RESULTS_DIR, `phase-03-m4-${TS}.json`);
  writeFileSync(outPath, JSON.stringify({ ts: TS, overallPass, results }, null, 2));
  console.log(`\n→ results: ${outPath}`);

  // Summary table
  console.log('\n┌──────────────────────────────────────────────────────────┐');
  console.log('│ Stage              Pass    Measured             Gate       │');
  console.log('├──────────────────────────────────────────────────────────┤');
  for (const r of results) {
    const symbol = r.gate === 'pass' ? '✓' : r.gate === 'fail' ? '✗' : '⚠';
    console.log(`│ ${r.stage.padEnd(18)} ${symbol}       ${String(r.measured).padEnd(20)} ${r.target}`);
  }
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│ OVERALL: ${overallPass ? 'PASS — proceed to plan 03-D-02' : 'FAIL — investigate before decommission'}`);
  console.log('└──────────────────────────────────────────────────────────┘');

  process.exit(overallPass ? 0 : 1);
}

main();
```

The regex parsers (`parseWarmWallClock`, etc.) MUST match the actual spike harness output. The executor:
1. Reads `.planning/spikes/004-m4-validation/results/` (look at past output files) to confirm the format
2. Adjusts the regex per the actual log lines

If the spike harnesses don't emit easily-parseable metrics, ADD a `--bench-output-format=json` flag to the spike scripts (a small follow-up edit) OR have this script extract metrics by re-running the spike's parsing code directly.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "execSync" scripts/bench-phase-03-m4.ts` returns >= 3 (one per spike harness call)
    - `grep -c "spikes/004\\|spikes/011\\|spikes/014" scripts/bench-phase-03-m4.ts` returns 3 (each spike referenced)
    - `grep -c "MASTER_SUMMARIZATION" scripts/bench-phase-03-m4.ts` returns 1 (Stage 2 env override)
    - The output JSON path matches the spec (`.planning/phases/03-migration-cutover/bench-results/`)
    - The exit code is 1 on any stage failing
  </acceptance_criteria>
  <done>
    Runner ships. Tasks 2-3 wire entry + smoke test.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add bench-phase-03-m4 to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (existing bench-vault-m4 entry from Phase 01 — analogous pattern)
  </read_first>
  <action>
Add `"bench-phase-03-m4": "tsx scripts/bench-phase-03-m4.ts",` to the scripts block, near `bench-vault-m4`.
  </action>
  <verify>
    <automated>grep -c "bench-phase-03-m4" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "bench-phase-03-m4" package.json` returns exactly 1
    - `pnpm bench-phase-03-m4 --help` (or similar) resolves to the script (not "command not found")
  </acceptance_criteria>
  <done>
    Script entry added.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write tests/scripts/bench-phase-03-m4.test.ts (lightweight)</name>
  <files>tests/scripts/bench-phase-03-m4.test.ts</files>
  <read_first>
    - scripts/bench-phase-03-m4.ts (Task 1)
  </read_first>
  <action>
Create `tests/scripts/bench-phase-03-m4.test.ts`. This is a script-shape smoke test — it MUST NOT actually run the spike harnesses (those require M4 + an Ollama daemon + minutes of wall-clock).

Use `vi.mock` to stub `child_process.execSync` so the test runs in CI without M4.

Cases:
1. Script loads without throwing (smoke)
2. parseWarmWallClock(stdout) extracts ms correctly from a representative spike 004 log fragment
3. parseLenientCompliance(stdout) extracts percent correctly
4. parseNarrativeScore(stdout) extracts the 5-keyword score correctly
5. When execSync is mocked to throw, the stage is marked as 'error' in the result JSON
6. The bench-results directory is created if missing
7. Pass/fail gate logic: a 4000ms warm result passes; a 5500ms warm result fails

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('bench-phase-03-m4 script', () => {
  let mockedExecSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('node:child_process');
    mockedExecSync = cp.execSync as unknown as ReturnType<typeof vi.fn>;
    mockedExecSync.mockReset();
  });

  it('extracts warm wall-clock from spike 004 log', async () => {
    // The script imports execSync at top level; we'd have to refactor it to
    // export parseWarmWallClock for direct testing. For now, smoke via stdout match.
    // ...
  });

  // ... more cases ...
});
```

If the parse functions are not exported, ADD lightweight named exports for testing:
```ts
export const _parsers = { parseWarmWallClock, parseLenientCompliance, parseNarrativeScore };
```

Then test via `await import('@/../scripts/bench-phase-03-m4')`. Total ~5 cases.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/bench-phase-03-m4.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All cases pass (no real bench runs)
    - The parser functions correctly extract metrics from representative spike log fragments
    - Test runtime < 5s
  </acceptance_criteria>
  <done>
    Bench runner ready. Operator runs `pnpm bench-phase-03-m4` on M4 + reviews the result JSON.
  </done>
</task>
