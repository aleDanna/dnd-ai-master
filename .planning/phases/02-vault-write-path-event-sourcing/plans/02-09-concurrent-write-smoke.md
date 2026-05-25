---
phase: 02
plan: 09
type: execute
wave: 3
depends_on: [02-03, 02-07]
files_modified:
  - tests/ai/master/vault/events-writer-stress.test.ts
autonomous: true
requirements: [REQ-005]
must_haves:
  truths:
    - "N=1000 parallel dispatchVaultTool('apply_event', ...) calls produce N+1 events.md lines (seed + 1000), 0 lost, 0 duplicated, 0 corrupted"
    - "N=100 with mixed event types (hp_change, condition_add, spell_slot_use) produces a deterministic final view state regardless of dispatch order"
    - "A truncated-tail events.md (simulating a process crash mid-append) is parsed up to the last valid line; the final invalid line throws fail-fast (spike 008)"
    - "Average per-event latency at N=100 is < 50ms on M5 Pro (spike 010 reference: 7ms total for 100 calls = 0.07ms avg via direct EventsWriter; through the dispatcher the overhead is the projector regen ~1-5ms per event)"
    - "STRESS_N env override enables N=1000+ runs without needing a separate test file"
  artifacts:
    - path: "tests/ai/master/vault/events-writer-stress.test.ts"
      provides: "High-N concurrency stress + truncated-tail recovery + dispatch-layer stress"
  key_links:
    - from: "tests/ai/master/vault/events-writer-stress.test.ts"
      to: "src/ai/master/vault/events-writer.ts (plan 02-03)"
      via: "Promise.all of N calls; verify line count + UUIDs"
      pattern: "Promise\\.all"
    - from: "tests/ai/master/vault/events-writer-stress.test.ts"
      to: "src/ai/master/vault/tools.ts (plan 02-07)"
      via: "stress via dispatchVaultTool('apply_event', ...) to verify dispatcher preserves the mutex guarantee"
      pattern: "dispatchVaultTool"
---

# Plan 02-09: Concurrent-Write Stress Test (CI Regression)

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 3 (depends on the writer from plan 02-03 + the dispatcher from plan 02-07)
**Status:** Pending
**Estimated diff size:** ~60 LOC source + ~100 LOC tests / 1 file

## Goal

Ship the canonical concurrent-write stress test that runs in CI. Phase 02-03's `events-writer.test.ts` covers basic N=100 concurrency. THIS plan ships the HIGHER-N stress + the dispatch-layer stress + the truncated-tail recovery test — all in one file so they share setup/teardown and run as a focused regression batch.

Three coverage axes:

1. **Higher-N stress on EventsWriter directly:** N=1000 parallel `EventsWriter.applyEvent` calls. Default N=1000 in CI; override via `STRESS_N=10000` for ad-hoc validation. Verifies that the mutex pattern scales beyond the spike-010 baseline (which only ran N=100).
2. **Dispatch-layer stress:** N=100 parallel `dispatchVaultTool('apply_event', ...)` calls. Proves the dispatcher's wrapping (validateEvent → randomUUID → EventsWriter.applyEvent → regenerateAffectedViews) preserves the mutex guarantee end-to-end. Also exercises the projector under load (each call triggers a synchronous view regeneration).
3. **Truncated-tail recovery:** Simulate a process crash mid-`appendFile` by writing N events then deliberately truncating the last line. Verify that `parseEventsFile` fails fast on the truncated line (spike 008 contract). Then verify that ROLLING BACK to the last valid line (manual recovery: `tail` of file minus 1 line) restores parseability — this is the documented recovery procedure.

Per phase Decision 6, this lives in a SINGLE Vitest file (no separate runner). N defaults to 1000; `STRESS_N=10000` env override enables larger runs without code changes. CI runs N=1000 in the default GitHub Actions workflow (or `pnpm test`); the developer runs N=10000+ locally when they suspect a regression.

## Requirements satisfied

- **REQ-005** Mutations go through EventsWriter — this plan provides the high-N regression test that catches concurrency regressions before they hit production.

## Files touched

| File | Action | Why |
|---|---|---|
| `tests/ai/master/vault/events-writer-stress.test.ts` | NEW | High-N stress + dispatch stress + truncated-tail recovery. |

## Tasks

<task type="auto">
  <name>Task 1: Write events-writer-stress.test.ts</name>
  <files>tests/ai/master/vault/events-writer-stress.test.ts</files>
  <read_first>
    - .planning/spikes/010-events-md-concurrency/stress.ts (THE reference harness — Promise.all N=100 with id-uniqueness check; mirror at higher N)
    - .planning/spikes/008-events-md-replay/README.md (Iteration 2 — corruption fail-fast pattern, lines 53-57)
    - tests/ai/master/vault/events-writer.test.ts (plan 02-03 — basic concurrency tests; the new stress test BUILDS ON these, not duplicates them)
    - src/ai/master/vault/events-writer.ts (plan 02-03 — the writer)
    - src/ai/master/vault/tools.ts (plan 02-07 — the dispatcher for axis 2)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Pitfall 3 — view regen blocking the turn; the dispatch stress test measures this)
  </read_first>
  <action>
Create `tests/ai/master/vault/events-writer-stress.test.ts`. The file is large but contained — ~100 LOC of focused stress.

Test structure — one top-level `describe('EventsWriter — high-N stress (CI regression)')`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_N = 1000;
const STRESS_N = parseInt(process.env.STRESS_N ?? String(DEFAULT_N), 10);
```

1. **`describe('Axis 1: N parallel EventsWriter.applyEvent calls (direct writer)')`:**
   - **`it('N=1000 default: 1000 distinct events persisted, 0 lost/duplicated/corrupted', { timeout: 30000 })`:**
     - Setup: tmpdir, no seed needed (direct writer test).
     - Build N events with ids 0..N-1.
     - `await Promise.all(events.map(e => EventsWriter.applyEvent(path, e)))`.
     - Read file, split lines, assert line count === N, parse each, assert all ids present exactly once.
     - Assert wall-clock < 5 seconds on the M5 Pro dev box (CI may differ; the spike-010 reference is 7ms for N=100, so N=1000 should be < 100ms even on slower hardware — the 5s cap is a generous safety margin for CI variance).
   - **`it('STRESS_N override scales to 10000+ when set', { timeout: 120000 })`:**
     - Only run if `process.env.STRESS_N !== undefined && STRESS_N > DEFAULT_N` — otherwise `.skip`.
     - Same assertions as above with STRESS_N.

2. **`describe('Axis 2: dispatch-layer stress (validation + write + projector regen)')`:**
   - Setup: stub VAULT_CAMPAIGNS_ROOT, seed campaign with a campaign_initialized event containing CHARS (5 characters), import dispatchVaultTool dynamically.
   - **`it('N=100 parallel dispatchVaultTool apply_event → 101 events.md lines, all views consistent')`:**
     - Build 100 hp_change events distributed across the 5 characters (20 per character).
     - `await Promise.all(events.map(e => dispatchVaultTool('apply_event', e, {campaignId})))`.
     - Assert events.md has 101 lines (1 seed + 100 mutations).
     - Assert all 100 results have `isError: false`.
     - Read all 5 view files. For each character, manually compute the expected hp_current via the deterministic projector. Assert the view file's frontmatter matches.
     - This is the strongest end-to-end guarantee: dispatcher + writer + projector under N=100 concurrent load produce consistent observable state.
   - **`it('average per-event latency through the dispatcher is < 50ms at N=100')`:**
     - Measure total wall-clock; divide by N. The spike-010 baseline is 0.07ms via direct writer; the dispatcher adds the projector regen (1-5ms typical per spike 008). The cap of 50ms/event leaves generous CI headroom; if it ever fails, Pitfall 3 has activated and the view regen has grown too expensive (Phase 03 trigger for snapshot+compact).

3. **`describe('Axis 3: truncated-tail recovery (spike 008 corruption fail-fast)')`:**
   - **`it('a truncated last line throws fail-fast with the line number')`:**
     - Build 10 events, write events.md sequentially.
     - Truncate the last line by overwriting events.md with `events.md.content.slice(0, -50)` (chops off the last ~50 chars; the final line is now malformed JSON).
     - Call `parseEventsFile(path)`. Assert it throws with message containing 'line 10' (or whichever line was truncated).
   - **`it('rolling back the truncated tail restores parseability')`:**
     - Same setup as above.
     - Recovery: read raw content, split by `\n`, drop the last partial line, rewrite. Example:
       ```ts
       const raw = await readFile(path, 'utf8');
       const lines = raw.split('\n');
       const lastFull = lines.findLast(l => l.length > 0 && (() => { try { JSON.parse(l); return true; } catch { return false; } })());
       const validPrefix = raw.slice(0, raw.indexOf(lastFull) + lastFull.length + 1);
       await writeFile(path, validPrefix, 'utf8');
       ```
     - After recovery, `parseEventsFile(path)` succeeds and returns 9 envelopes (the 10th was discarded).
     - This documents the operator-facing recovery procedure for the truncated-tail crash scenario.
   - **`it('a single fully-corrupt line in the middle of events.md aborts replay with that line number')`:**
     - Build 10 events.
     - Replace line 5's content with `'NOT JSON'`.
     - `parseEventsFile` throws with message containing 'line 5'.
     - This is the spike 008 fail-fast invariant — the projector refuses to silently skip a corrupt event.

4. **`describe('isolation: stress on multiple campaigns in parallel')`:**
   - **`it('N=100 events per campaign × 5 campaigns = 500 total, no cross-contamination')`:**
     - Seed 5 different campaigns (5 distinct UUIDs).
     - Build 100 events per campaign (500 total).
     - Fire all 500 in parallel via Promise.all.
     - Read each campaign's events.md; assert each has 101 lines (1 seed + 100).
     - Assert no event_id appears in two different campaigns' events.md files.
     - This proves the per-path mutex isolation extends to per-campaign isolation.

Setup/teardown:
- `beforeEach`: `testDir = mkdtempSync(...)`, `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', testDir)`, `vi.resetModules()`.
- `afterEach`: `rmSync(testDir, ...)`, `vi.unstubAllEnvs()`.

Total: 4 describe blocks, ~7 `it` cases. The CI run completes in < 60 seconds at default N=1000.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-writer-stress.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~7 cases pass at default N=1000
    - The "N=1000 default" test passes in under 30 seconds on M5 Pro
    - `STRESS_N=10000 pnpm test tests/ai/master/vault/events-writer-stress.test.ts` passes (manual ad-hoc run)
    - The "truncated last line throws fail-fast" test passes
    - The "isolation: 5 campaigns × 100 events" test passes with no cross-contamination
    - `grep -c "Promise.all" tests/ai/master/vault/events-writer-stress.test.ts` returns ≥ 4 (one per stress axis)
    - `grep -c "STRESS_N" tests/ai/master/vault/events-writer-stress.test.ts` returns ≥ 2 (env read + .skip check)
    - `unset DATABASE_URL; pnpm test tests/ai/master/vault/events-writer-stress.test.ts` exits 0
  </acceptance_criteria>
  <done>
    The Phase 02 concurrency regression test is in place. CI catches any future regression that re-introduces the spike 006 lost-update class of bug.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/events-writer-stress.test.ts` → all 7 cases pass at default N=1000
- Command: `STRESS_N=10000 pnpm test tests/ai/master/vault/events-writer-stress.test.ts` → still passes (~30-90s wall-clock depending on hardware)
- Command: `pnpm test` (full suite) → still green
- Grep gate: `grep -c "expect.*toBe.*0.*lost\\|0 duplicated\\|0 corrupted" tests/ai/master/vault/events-writer-stress.test.ts` returns ≥ 1 (the spike-010 invariant is explicit in the test text)

## Open questions

None — the stress harness is locked by spike 010's pattern + Phase 02 Decision 6 (same Vitest harness as Phase 01).
