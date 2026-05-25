---
phase: 02
plan: 03
type: execute
wave: 2
depends_on: [02-02]
files_modified:
  - src/ai/master/vault/events-writer.ts
  - tests/ai/master/vault/events-writer.test.ts
autonomous: true
requirements: [REQ-005]
must_haves:
  truths:
    - "EventsWriter.append serializes writes to the same absolute path via an in-process Map<string, Promise<void>> mutex (spike 010 pattern verbatim)"
    - "100 concurrent EventsWriter.applyEvent calls on the same path → 100 lines on disk, 0 lost, 0 duplicated"
    - "10 concurrent applyEvent calls split across 2 paths → 10 lines total (5 per path), each path's mutex is independent"
    - "The mutex key is the resolved ABSOLUTE path returned by node:path.resolve() — so /tmp/foo/events.md and /tmp/foo/../foo/events.md resolve to the SAME mutex entry"
    - "applyEvent writes each event as one JSONL line (JSON.stringify + '\\n')"
    - "On filesystem error (EACCES, ENOSPC), applyEvent rejects and the mutex correctly releases (next caller proceeds; no deadlock)"
  artifacts:
    - path: "src/ai/master/vault/events-writer.ts"
      provides: "EventsWriter class — single-writer mutex per absolute path"
      exports: ["EventsWriter"]
  key_links:
    - from: "src/ai/master/vault/tools.ts (plan 02-07)"
      to: "src/ai/master/vault/events-writer.ts"
      via: "EventsWriter.applyEvent(eventsPath(campaignId), envelope) — the only mutation primitive"
      pattern: "EventsWriter\\.applyEvent"
    - from: "src/ai/master/vault/events-writer.ts"
      to: "node:fs/promises"
      via: "appendFile + mkdir with recursive:true"
      pattern: "appendFile|mkdir"
---

# Plan 02-03: EventsWriter — Single-Writer Mutex per Path

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 2 (depends on plan 02-02 for `eventsPath` and `UUID_REGEX` — though this module doesn't import campaign-paths, plans that consume EventsWriter pass paths produced by `eventsPath`)
**Status:** Pending
**Estimated diff size:** ~80 LOC source + ~100 LOC tests / 2 files

## Goal

Ship `src/ai/master/vault/events-writer.ts` — the canonical `EventsWriter` class. This is a near-verbatim lift of the spike 010 validated implementation (`.planning/spikes/010-events-md-concurrency/writer.ts`), promoted to a permanent module with proper TypeScript types and module-level JSDoc citing the validating spike + REQ-005.

Implementation contract (from RESEARCH §4 Pattern 1 + spike 010 README):
- `static queues = new Map<string, Promise<void>>()` — keyed on the absolute resolved path
- `static async append(path: string, line: string): Promise<void>` — serializes one append per path
- `static async applyEvent(path: string, event: object): Promise<void>` — convenience wrapper around `append(path, JSON.stringify(event))`

The mutex key is the path passed in (callers MUST pass `eventsPath(campaignId)` from plan 02-02, which calls `resolve()` internally — so the key is guaranteed to be the absolute canonical form). Spike 010 recommended keying on `campaign_id` directly — Phase 02 takes the path-keying route because (a) `eventsPath` always produces canonical absolute paths, (b) the test seam is the path, not the campaign_id, (c) future Phase 03 features that write to multiple files per campaign (e.g., archived `events-archive-<n>.md`) get separate mutex slots correctly.

The class is NOT instantiable (all members static). The mutex Map lives in module-scope; multi-process safety is OUT OF SCOPE (NON-REQ-001 — single Next.js server invariant). The Map auto-cleans entries once they're no longer in the chain head (see implementation note in spike 010 writer.ts).

## Requirements satisfied

- **REQ-005** Mutations go through EventsWriter — this plan IS the mutex. Plan 02-07 wires the dispatch branch; this plan provides the writer.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/events-writer.ts` | NEW | EventsWriter class — direct lift from spike 010. |
| `tests/ai/master/vault/events-writer.test.ts` | NEW | Vitest: concurrency, isolation per path, error propagation, mutex release. |

## Tasks

<task type="auto">
  <name>Task 1: Create events-writer.ts (lift from spike 010 verbatim)</name>
  <files>src/ai/master/vault/events-writer.ts</files>
  <read_first>
    - .planning/spikes/010-events-md-concurrency/writer.ts (THE source-of-truth implementation — copy near-verbatim)
    - .planning/spikes/010-events-md-concurrency/README.md (lines 49-72 — explanation of the pattern; lines 98-103 — "Signal for the real build" with implementation guidelines)
    - .claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md (lines 43-77 — canonical EventsWriter implementation as the locked contract)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§4 Pattern 1 — the EXACT lift target)
    - src/ai/master/vault/path.ts (style reference — file header JSDoc with REQ citations)
  </read_first>
  <action>
Create `src/ai/master/vault/events-writer.ts`. Copy the spike 010 implementation NEAR-VERBATIM (preserve the algorithm exactly — it's locked by 100 concurrent writes with 0 loss); add proper TypeScript types, ESM imports, and module-level JSDoc.

The implementation:

```ts
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * REQ-005 — Mutations go through EventsWriter single-writer mutex (NEVER
 * naive read-modify-write). Validated by spike 010:
 *   100 concurrent applyEvent calls → 100 events persisted in 7ms,
 *   0 lost / 0 corrupted / 0 duplicated.
 *
 * The mutex is an in-process Map<absolutePath, Promise<void>> chain. Each
 * call links to the previous one's tail and awaits it before performing
 * its own appendFile. fs.promises.appendFile is open(O_APPEND) → write →
 * close; for small writes (<4KB on POSIX) the write itself is atomic
 * across processes, so this implementation is doubly safe for the
 * single-Next.js-server scope (NON-REQ-001).
 *
 * Multi-process safety: OUT OF SCOPE. Two Node processes writing the
 * same events.md hold separate Maps; they corrupt each other. Operational
 * runbook (docs/operators/vault-backup.md, plan 02-10): any bulk-mutation
 * script (Phase 03 import, recovery tool) MUST run with the Next.js
 * server stopped.
 *
 * The Map auto-cleans: when a chain's tail releases AND no newer caller
 * has linked to it, the path's entry is deleted (line 'if (queues.get(path) === next)' below).
 *
 * Source-of-truth: .planning/spikes/010-events-md-concurrency/writer.ts
 */
export class EventsWriter {
  private static queues = new Map<string, Promise<void>>();

  /**
   * Append one line (with a trailing newline) to the file at the given
   * absolute path. The path is also the mutex key — callers MUST pass
   * the canonical absolute path (e.g., from `eventsPath(campaignId)`
   * which calls `path.resolve()` internally) so different spellings of
   * the same file map to the same mutex slot.
   *
   * Creates the parent directory recursively if missing.
   *
   * Returns a promise that resolves once the append is on disk (or
   * rejects on filesystem error, in which case the mutex still releases
   * correctly — next caller proceeds without deadlock).
   */
  static async append(path: string, line: string): Promise<void> {
    const previous = EventsWriter.queues.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    EventsWriter.queues.set(path, next);
    try {
      await previous;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line.endsWith('\n') ? line : line + '\n', 'utf8');
    } finally {
      release();
      if (EventsWriter.queues.get(path) === next) {
        EventsWriter.queues.delete(path);
      }
    }
  }

  /**
   * Convenience wrapper: JSON-serialize the event and append as one line.
   * Used by the apply_event dispatch branch (plan 02-07) for every
   * VaultEventEnvelope. Spike 008 §"Event schema with versioning"
   * recommends one JSON object per line (JSONL); this is the format
   * the projector (plan 02-04) consumes.
   */
  static async applyEvent(path: string, event: object): Promise<void> {
    await EventsWriter.append(path, JSON.stringify(event));
  }
}
```

That's it — minimal and direct. The implementation is locked by spike 010; the only changes from the spike source are: (a) added module-level JSDoc citing spike + REQ, (b) JSDoc on the two methods explaining the mutex-key contract, (c) absolute-path requirement noted (so callers know `eventsPath` is mandatory — callers MUST NOT pass relative paths).

Do NOT add: instance fields, configuration options, "init" / "destroy" lifecycle methods, max-queue-length checks, or a logging layer. Spike 010's 7ms-for-100-writes throughput is the budget; any added complexity is regression risk.

Do NOT introduce: a runtime check that `path` is absolute. The convention is documented in JSDoc; the test in Task 2 covers the path-canonicalization scenario. A runtime check adds branches with no behavioral guarantee (callers passing relative paths still get serialization, just with a potentially-wrong mutex key — the right defense is documentation + plan 02-02's `eventsPath` which always returns absolute).
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-writer.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File `src/ai/master/vault/events-writer.ts` exists and exports the `EventsWriter` class
    - `grep -c "static queues = new Map" src/ai/master/vault/events-writer.ts` returns 1
    - `grep -c "appendFile" src/ai/master/vault/events-writer.ts` returns ≥ 1
    - `grep -c "mkdir" src/ai/master/vault/events-writer.ts` returns ≥ 1
    - `grep -c "queues.delete" src/ai/master/vault/events-writer.ts` returns 1 (auto-clean)
    - `pnpm typecheck` exits 0
    - The class has NO instance methods (everything static); `grep -c "private static\\|public static\\|static " src/ai/master/vault/events-writer.ts` returns ≥ 3
    - The implementation matches spike 010's writer.ts byte-for-byte in the critical loop (queues.get → set → try/await/finally release/delete)
  </acceptance_criteria>
  <done>
    EventsWriter shipped. Plans 02-07 (dispatcher uses applyEvent), 02-09 (stress test) consume the class.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write events-writer.test.ts (concurrency + isolation + error path)</name>
  <files>tests/ai/master/vault/events-writer.test.ts</files>
  <read_first>
    - src/ai/master/vault/events-writer.ts (the module under test — just created)
    - .planning/spikes/010-events-md-concurrency/stress.ts (THE reference harness — N=100 concurrent applyEvent, verify line count + parsed events + missing/duplicate IDs)
    - .planning/spikes/010-events-md-concurrency/README.md (lines 32-46 — expected output shape; lines 99-104 — operational guarantees this test exercises)
    - tests/ai/master/vault/path.test.ts (style reference — tmpdir setup, mkdtempSync/rmSync pattern)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§6 Code Example "Concurrent-write smoke test")
  </read_first>
  <action>
Create `tests/ai/master/vault/events-writer.test.ts`. This is the unit-test sibling of plan 02-09's stress test — Task 2 here covers basic concurrency (N=100), per-path isolation, and the error-path mutex-release invariant. Plan 02-09 ships the high-N stress harness (N=1000+ via env override).

Test structure — one top-level `describe('EventsWriter')` with these nested describes:

1. **`describe('basic appends')`:**
   - `it('appends one event as one JSONL line with trailing newline')` → `EventsWriter.applyEvent(path, {id:1, type:'hp_change'})` → `readFile(path)` returns `'{"id":1,"type":"hp_change"}\n'`
   - `it('append() adds newline if missing')` → call `EventsWriter.append(path, 'foo')` → file contains `'foo\n'`
   - `it('append() does NOT double-newline if already present')` → call `EventsWriter.append(path, 'foo\n')` → file contains `'foo\n'` (one newline)
   - `it('creates parent directory if missing')` → use a deeply-nested path like `${tmp}/a/b/c/events.md` → assert call succeeds and file exists at the nested location

2. **`describe('concurrency on the same path (spike 010 regression test)')`:**
   - `it('100 parallel applyEvent → 100 distinct events, 0 lost, 0 duplicated')` — this is the canonical regression test, mirroring `.planning/spikes/010-events-md-concurrency/stress.ts`:
     ```ts
     const N = 100;
     const path = join(testDir, 'events.md');
     await Promise.all(Array.from({length: N}, (_, i) => EventsWriter.applyEvent(path, {id: i, type: 'hp_change', payload: {character: 'aragorn', delta: 1}})));
     const raw = await readFile(path, 'utf8');
     const lines = raw.trim().split('\n');
     expect(lines.length).toBe(N);
     const parsed = lines.map(l => JSON.parse(l));
     const ids = new Set(parsed.map(e => e.id));
     expect(ids.size).toBe(N);  // 0 duplicates
     for (let i = 0; i < N; i++) expect(ids.has(i)).toBe(true);  // 0 missing
     ```
   - `it('1000 parallel applyEvent via STRESS_N env (when set)')` — same test but reads `process.env.STRESS_N` and uses it instead of 100. When the env is unset, this test is `.skip()`. (The high-N stress with explicit timing assertions belongs to plan 02-09; this is just the env-overridable convenience.)

3. **`describe('isolation per path')`:**
   - `it('appends to different paths use independent mutexes')` → fire 10 parallel applyEvent calls split 5/5 across two paths; assert each file has 5 lines. The mutex Map's per-path slots prove the chains are independent.
   - `it('the same absolute path canonicalizes to the same mutex slot')` → use `resolve(testDir, 'events.md')` twice with different relative segments leading to the same canonical path; the test asserts that the resulting file has the expected count even when callers pass the path via different intermediate constructions. (Plan 02-02 ensures callers use `eventsPath()` which already canonicalizes; this test documents the contract.)

4. **`describe('mutex release on error')`:**
   - `it('a filesystem error releases the mutex (next caller proceeds, no deadlock)')`:
     ```ts
     const badPath = '/proc/1/events.md';  // unwritable on linux; on macOS use a path under a chmod 000 dir created in setup
     // First call: expect rejection
     await expect(EventsWriter.applyEvent(badPath, {id: 1})).rejects.toThrow();
     // Subsequent call to a DIFFERENT (writable) path must proceed without delay
     const goodPath = join(testDir, 'events.md');
     await EventsWriter.applyEvent(goodPath, {id: 2});
     expect(existsSync(goodPath)).toBe(true);
     ```
     Cross-platform note: on macOS, create a `chmod 000` directory in `beforeEach` to construct the unwritable path. On linux CI, `/proc/1` works. Use a try/catch to detect platform and adjust.
   - `it('a rejected promise removes its entry from the queue Map')` — after a failing applyEvent, call a SUCCESSFUL applyEvent to the same path; assert it succeeds. (Tests that the auto-clean `queues.delete` logic fires even on error.)

5. **`describe('ordering preservation')`:**
   - `it('serialized calls preserve emit order')` — call `applyEvent` 10 times sequentially (await each); assert lines are in the order `0, 1, 2, ..., 9`. This documents the sequential ordering guarantee.
   - `it('concurrent calls may interleave but each completes atomically')` — fire 5 parallel; assert each line is a complete valid JSON (no torn lines). This is the spike 010 invariant — JSON.parse must succeed on every line regardless of interleaving.

Setup/teardown:
- `beforeEach`: `testDir = mkdtempSync(join(tmpdir(), 'gsd-events-writer-'))`
- `afterEach`: `rmSync(testDir, { recursive: true, force: true })`

Total: 5 describe blocks, ~13 `it` cases.

**No DATABASE_URL required.** The test imports only from `@/ai/master/vault/events-writer`; verify by running `unset DATABASE_URL; pnpm test tests/ai/master/vault/events-writer.test.ts` exits 0.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/events-writer.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~13 test cases pass
    - The "100 parallel applyEvent → 100 distinct events, 0 lost, 0 duplicated" test exists and passes
    - The "filesystem error releases the mutex" test exists and passes
    - The "rejected promise removes its entry from the queue Map" test exists and passes
    - `grep -c "Promise.all" tests/ai/master/vault/events-writer.test.ts` returns ≥ 2 (concurrency + isolation tests)
    - `unset DATABASE_URL; pnpm test tests/ai/master/vault/events-writer.test.ts` exits 0
    - Test runtime < 5 seconds on M5 Pro (spike 010 reference: 7ms for 100 parallel)
  </acceptance_criteria>
  <done>
    Concurrency invariants regression-tested. Plan 02-09 layers a higher-N stress test on top.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/events-writer.test.ts` → all cases pass
- Command: `pnpm typecheck` → clean
- Command: `STRESS_N=1000 pnpm test tests/ai/master/vault/events-writer.test.ts -t "1000 parallel"` → 1000 events landed, 0 lost (the env-driven optional case)
- Grep gate: `grep -c "queues.delete\\|queues.set\\|queues.get" src/ai/master/vault/events-writer.ts` returns ≥ 3 (auto-clean invariant + mutex chain link + chain-tail read)

## Open questions

None — spike 010 locked the implementation. The path-keyed mutex (vs campaign_id-keyed) is a deliberate choice documented in plan-level Goal section.

## Execution Summary

**Status:** ✅ Complete
**Executed:** 2026-05-25 (Wave 2, parallel execution alongside plan 02-04 projector)
**Duration:** ~5 minutes
**Commits:** 2 (one per task, atomic, conventional `(phase-02)` scope)

### Commits

| Task | Commit    | Type | Description                                                                |
| ---- | --------- | ---- | -------------------------------------------------------------------------- |
| 1    | `4c96930` | feat | EventsWriter single-writer mutex per absolute path                         |
| 2    | `87d6a82` | test | EventsWriter concurrency + isolation + error-path coverage                 |

### Artifacts shipped

- **`src/ai/master/vault/events-writer.ts`** (89 LOC) — near-verbatim lift from `.planning/spikes/010-events-md-concurrency/writer.ts`. Single class with 2 static methods + 1 private static field:
  - `EventsWriter.queues: Map<absolutePath, Promise<void>>` — in-process mutex chain
  - `EventsWriter.append(path, line)` — serialized appendFile with mkdir recursive parent + auto-newline + queue auto-clean on chain tail
  - `EventsWriter.applyEvent(path, event)` — `JSON.stringify(event)` convenience wrapper
  - Module-level JSDoc cites REQ-005, spike 010 validation, NON-REQ-001 single-process scope, and the mutex-key absolute-path contract.
- **`tests/ai/master/vault/events-writer.test.ts`** (310 LOC) — 12 vitest cases (11 active + 1 skipped) across 5 describe blocks. Runs cleanly with `DATABASE_URL` unset.

### Acceptance criteria — all green

**Task 1:**

- File exists and exports `EventsWriter` class ✓
- `grep -c "static queues = new Map" src/ai/master/vault/events-writer.ts` = 1 ✓
- `grep -c "appendFile" src/ai/master/vault/events-writer.ts` = 3 (≥ 1) ✓
- `grep -c "mkdir" src/ai/master/vault/events-writer.ts` = 2 (≥ 1) ✓
- `grep -c "queues.delete" src/ai/master/vault/events-writer.ts` = 1 ✓
- `pnpm typecheck` exit 0 ✓
- `grep -c "private static\|public static\|static " src/ai/master/vault/events-writer.ts` = 3 (≥ 3) ✓
- Critical loop matches spike 010 byte-for-byte (`queues.get → set → try/await/finally release/delete`) ✓ verified by diff of inner method body against `.planning/spikes/010-events-md-concurrency/writer.ts`

**Task 2:**

- 11/11 active test cases pass + 1 skipped (env-overridable STRESS_N) ✓
- "100 parallel applyEvent → 100 distinct events, 0 lost, 0 duplicated" exists and passes (8ms wall-clock) ✓
- "filesystem error releases the mutex" exists and passes ✓
- "rejected promise removes its entry from the queue Map" exists and passes ✓
- `grep -c "Promise.all" tests/ai/master/vault/events-writer.test.ts` = 5 (≥ 2) ✓
- `unset DATABASE_URL; pnpm test …` exits 0 ✓ (verified via `env -u DATABASE_URL pnpm test …`)
- Test runtime: 113ms total (well under 5s budget; spike 010 baseline 7ms for 100 concurrent is here observed as 8ms in vitest) ✓

**Plan-level:**

- `pnpm test tests/ai/master/vault/events-writer.test.ts` → 11/11 green + 1 skip in 113ms ✓
- `pnpm typecheck` → clean ✓
- `STRESS_N=1000 pnpm test tests/ai/master/vault/events-writer.test.ts -t "1000 parallel"` → 1000 events landed, 0 lost, 65ms wall-clock ✓
- `grep -c "queues.delete\|queues.set\|queues.get" src/ai/master/vault/events-writer.ts` = 5 (≥ 3) ✓

### Implementation notes

**Verbatim lift — algorithm preservation.** The inner mutex loop (`const previous = …queues.get(path) ?? Promise.resolve(); …queues.set(path, next); try { await previous; await mkdir(…); await appendFile(…) } finally { release(); if (queues.get(path) === next) queues.delete(path); }`) was copied character-for-character from `.planning/spikes/010-events-md-concurrency/writer.ts`. The only adornments are: (a) module-level JSDoc citing REQ-005 + spike 010 + multi-process scope notes, (b) per-method JSDoc explaining the mutex-key contract for `append` and the JSONL format choice for `applyEvent`. No behavioral changes from the spike.

**No runtime path-canonicalization check.** The plan was explicit that runtime `isAbsolute()` checks are not introduced — the contract is "callers MUST pass `eventsPath()` canonical paths" and that's the design. The dedicated test case "the same absolute path canonicalizes to the same mutex slot" documents the contract via behavior, not via runtime enforcement.

**Mutex-release-on-error invariant — observable assertion.** The `next` promise inside the chain only carries a resolve callback (no reject); when an `appendFile` throws, the outer `async` function rejects but the `finally` still calls `release()` on the inner mutex-chain promise. The test "a rejected promise removes its entry from the queue Map" exercises this: after a chmod-000 EACCES rejection, restoring permissions and re-invoking on the same path completes within 1s (asserted bound is generous; observed <2ms in practice). The Map cleanup line `queues.delete(path)` is therefore reached on both success and error paths.

**chmod-based unwritable-dir setup — macOS APFS verified.** Pre-flight tested via inline `node -e` script that `chmod 000` on an existing directory produces `EACCES` on attempted child file creation on darwin (current platform). The test's afterEach walks the tmpdir tree and chmod-555-restores any encountered dir so `rmSync(recursive: true)` can succeed even when a test leaves a 000 dir behind (defensive — current tests always restore in-line, but the cleanup walk is belt-and-suspenders against future test additions).

**STRESS_N env-overridable test.** The plan asked for a runtime-conditional `it.skip()` when `STRESS_N` is unset. Implemented as `it.skip / it` selection via `process.env.STRESS_N` parse at module load. When set (e.g., `STRESS_N=1000`), the test name in the verbose reporter reflects the actual N (`1000 parallel applyEvent via STRESS_N env`); when unset, the placeholder `<env-overridable>` appears and the case is skipped. Plan 02-09 owns the high-N stress with explicit per-call timing assertions.

**TS strict-mode interaction with `readdirSync`.** First pass of the afterEach cleanup walk used `ReturnType<typeof readdirSync>` which TS resolved to a union including the `NonSharedBuffer[]` overload (when `withFileTypes` is not narrowed). Fixed by importing `Dirent` as a type and typing the local `entries: Dirent[]` explicitly + passing `encoding: 'utf8'` to `readdirSync` to lock the string-name overload.

### Out-of-scope observations (no action taken)

During execution, Wave 2's other plan (02-04 projector) committed `src/ai/master/vault/projector.ts` — surfaced as an untracked file in `git status` during my Task 2 commit. Per the parallel execution contract, this plan staged ONLY its own two files (one per commit). The projector file was left untouched in the working tree and is not part of either commit produced by this plan.

### Downstream consumers

- **Plan 02-07** (`apply-event-tool`) — dispatcher branch calls `EventsWriter.applyEvent(eventsPath(campaignId), envelope)` as the mutation primitive.
- **Plan 02-09** (`stress-test`) — layers a higher-N (env-driven) stress harness with explicit per-call timing assertions on top of the same `EventsWriter` API.
- **Plan 02-04** (`projector` — Wave 2 sibling) — does NOT depend on EventsWriter directly; it only consumes the events.md file format (one JSONL line per event) that `applyEvent` produces.

### Threat-model traceability

- **T-02-09** (in-process mutex insufficient under multi-process writes) — mitigated at the operational layer (NON-REQ-001 single-Next.js-server invariant + runbook in plan 02-10). EventsWriter itself documents the boundary in the module-level JSDoc ("Multi-process safety: OUT OF SCOPE").
- **T-02-10** (event loss under contention) — primary mitigation. Validated by the "100 parallel applyEvent → 0 lost, 0 duplicated" test (and by STRESS_N=1000 on demand).
- **T-02-11** (mutex deadlock on filesystem error) — mitigated via the `release()` call in the `finally` block. Validated by the "filesystem error releases the mutex" + "rejected promise removes its entry from the queue Map" tests.

### Self-check

- File `src/ai/master/vault/events-writer.ts` exists ✓
- File `tests/ai/master/vault/events-writer.test.ts` exists ✓
- Commit `4c96930` exists in git log ✓
- Commit `87d6a82` exists in git log ✓
- All acceptance criteria green ✓
- No deletions in either commit ✓ (verified via `git diff --diff-filter=D --name-only HEAD~N HEAD~N+1`)

**Self-Check: PASSED**


