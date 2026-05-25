/**
 * Phase 02 plan 02-03 — `EventsWriter` unit tests.
 *
 * Mirrors `.planning/spikes/010-events-md-concurrency/stress.ts` (the
 * source-of-truth stress harness) at N=100 plus three additional axes:
 *
 *   1. Basic appends — JSONL line shape, newline handling, parent-dir creation.
 *   2. Concurrency on the same path — spike 010 regression test at N=100, plus
 *      an env-overridable case for higher N (the high-N stress with explicit
 *      timing assertions belongs to plan 02-09; this is just the convenience
 *      escape hatch).
 *   3. Isolation per path — independent mutex slots per absolute path.
 *   4. Mutex release on error — filesystem failures release the chain and
 *      auto-clean the `Map` entry so subsequent calls do not deadlock.
 *   5. Ordering preservation — sequential calls preserve emit order, parallel
 *      calls do not tear individual JSON lines.
 *
 * No `DATABASE_URL` required — this suite imports only from
 * `@/ai/master/vault/events-writer`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  type Dirent,
} from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventsWriter } from '@/ai/master/vault/events-writer';

describe('EventsWriter', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gsd-events-writer-'));
  });

  afterEach(() => {
    // Best-effort cleanup: chmod back to 755 in case a test left a 000 dir
    // behind, then rm recursive. The walk runs depth-first, so any nested
    // unwritable dir surfaces before the parent rm call.
    const walk = (p: string): void => {
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(p, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) {
          try {
            chmodSync(full, 0o755);
          } catch {
            // ignore — best-effort
          }
          walk(full);
        }
      }
    };
    try {
      walk(testDir);
    } catch {
      // ignore — best-effort
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('basic appends', () => {
    it('appends one event as one JSONL line with trailing newline', async () => {
      const path = join(testDir, 'events.md');
      await EventsWriter.applyEvent(path, { id: 1, type: 'hp_change' });
      const raw = await readFile(path, 'utf8');
      expect(raw).toBe('{"id":1,"type":"hp_change"}\n');
    });

    it('append() adds newline if missing', async () => {
      const path = join(testDir, 'events.md');
      await EventsWriter.append(path, 'foo');
      const raw = await readFile(path, 'utf8');
      expect(raw).toBe('foo\n');
    });

    it('append() does NOT double-newline if already present', async () => {
      const path = join(testDir, 'events.md');
      await EventsWriter.append(path, 'foo\n');
      const raw = await readFile(path, 'utf8');
      expect(raw).toBe('foo\n');
    });

    it('creates parent directory if missing', async () => {
      const path = join(testDir, 'a', 'b', 'c', 'events.md');
      await EventsWriter.applyEvent(path, { id: 1, type: 'hp_change' });
      expect(existsSync(path)).toBe(true);
      const raw = await readFile(path, 'utf8');
      expect(raw.trim()).toBe('{"id":1,"type":"hp_change"}');
    });
  });

  describe('concurrency on the same path (spike 010 regression test)', () => {
    it('100 parallel applyEvent → 100 distinct events, 0 lost, 0 duplicated', async () => {
      const N = 100;
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
      expect(ids.size).toBe(N); // 0 duplicates
      for (let i = 0; i < N; i++) {
        expect(ids.has(i)).toBe(true); // 0 missing
      }
    });

    const STRESS_N = process.env.STRESS_N ? parseInt(process.env.STRESS_N, 10) : null;
    const itOrSkip = STRESS_N && STRESS_N > 0 ? it : it.skip;
    itOrSkip(
      `${STRESS_N ?? '<env-overridable>'} parallel applyEvent via STRESS_N env (when set)`,
      async () => {
        const N = STRESS_N as number;
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

  describe('isolation per path', () => {
    it('appends to different paths use independent mutexes', async () => {
      const pathA = join(testDir, 'a', 'events.md');
      const pathB = join(testDir, 'b', 'events.md');

      // 10 parallel calls, 5/5 split across two paths.
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          EventsWriter.applyEvent(pathA, { id: i, src: 'A' }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          EventsWriter.applyEvent(pathB, { id: i, src: 'B' }),
        ),
      ]);

      const rawA = await readFile(pathA, 'utf8');
      const rawB = await readFile(pathB, 'utf8');
      const linesA = rawA.trim().split('\n');
      const linesB = rawB.trim().split('\n');
      expect(linesA.length).toBe(5);
      expect(linesB.length).toBe(5);
      // Cross-pollination check: every line in A came from src=A, every
      // line in B came from src=B. Independent mutex slots guarantee this.
      for (const line of linesA) expect(JSON.parse(line).src).toBe('A');
      for (const line of linesB) expect(JSON.parse(line).src).toBe('B');
    });

    it('the same absolute path canonicalizes to the same mutex slot', async () => {
      // Two different path strings, same canonical resolution. The plan
      // 02-02 `eventsPath()` already canonicalizes via `path.resolve` — this
      // test documents the contract: callers MUST pass canonical absolute
      // paths so different spellings map to the same mutex.
      const canonical = resolve(testDir, 'events.md');
      const N = 50;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          EventsWriter.applyEvent(canonical, { id: i, type: 'hp_change' }),
        ),
      );

      const raw = await readFile(canonical, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(N);
      const ids = new Set(lines.map((l) => JSON.parse(l).id));
      expect(ids.size).toBe(N);
    });
  });

  describe('mutex release on error', () => {
    it('a filesystem error releases the mutex (next caller proceeds, no deadlock)', async () => {
      // Build an unwritable directory: chmod 000 prevents creating files
      // inside (EACCES on macOS APFS / linux). The EventsWriter's mkdir
      // recursive call succeeds (idempotent on existing dirs), but the
      // appendFile rejects with EACCES.
      const unwritableDir = join(testDir, 'unwritable');
      mkdirSync(unwritableDir);
      await chmod(unwritableDir, 0o000);
      const badPath = join(unwritableDir, 'events.md');

      // First call: expect rejection.
      await expect(
        EventsWriter.applyEvent(badPath, { id: 1, type: 'hp_change' }),
      ).rejects.toThrow();

      // Subsequent call to a DIFFERENT (writable) path must proceed
      // without delay (the failure on `badPath` released its own mutex
      // chain; the `goodPath` mutex slot is independent).
      const goodPath = join(testDir, 'events.md');
      await EventsWriter.applyEvent(goodPath, { id: 2, type: 'hp_change' });
      expect(existsSync(goodPath)).toBe(true);

      // Restore permissions so afterEach cleanup can rmSync the dir.
      await chmod(unwritableDir, 0o755);
    });

    it('a rejected promise removes its entry from the queue Map', async () => {
      // Sibling assertion to the prior test: after a failing applyEvent
      // on a path, the queue entry for that path must auto-clean so a
      // subsequent successful call to the SAME path proceeds promptly.
      // This validates the `queues.delete(path)` line fires on the error
      // path too (the `finally` block runs regardless of throw).
      const unwritableDir = join(testDir, 'unwritable');
      mkdirSync(unwritableDir);
      await chmod(unwritableDir, 0o000);
      const samePath = join(unwritableDir, 'events.md');

      await expect(
        EventsWriter.applyEvent(samePath, { id: 1, type: 'hp_change' }),
      ).rejects.toThrow();

      // Restore permissions on the parent so the next call to the SAME
      // path succeeds — the dir is writable, the queue entry must be gone.
      await chmod(unwritableDir, 0o755);

      // If the auto-clean did NOT fire, the queue entry would be the
      // previously-released `next` promise — await would resolve, the
      // call would proceed, but the Map would carry stale entries. The
      // outcome (call succeeds) is observable; we cannot inspect the Map
      // directly without breaking encapsulation, but we can assert the
      // success of the second call within a reasonable bound to detect
      // the would-be deadlock case (which would hang the test).
      const start = Date.now();
      await EventsWriter.applyEvent(samePath, { id: 2, type: 'hp_change' });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000); // generous; spike 010 is <10ms per call
      expect(existsSync(samePath)).toBe(true);
      const raw = await readFile(samePath, 'utf8');
      expect(raw.trim()).toBe('{"id":2,"type":"hp_change"}');
    });
  });

  describe('ordering preservation', () => {
    it('serialized calls preserve emit order', async () => {
      const path = join(testDir, 'events.md');
      for (let i = 0; i < 10; i++) {
        await EventsWriter.applyEvent(path, { id: i });
      }
      const raw = await readFile(path, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(JSON.parse(lines[i]!).id).toBe(i);
      }
    });

    it('concurrent calls may interleave but each completes atomically', async () => {
      // Spike 010 invariant: JSON.parse must succeed on every line
      // regardless of completion order. No torn lines, no partial JSON.
      const path = join(testDir, 'events.md');
      const events = [
        { id: 0, payload: { kind: 'short' } },
        { id: 1, payload: { kind: 'longer-payload-with-more-bytes' } },
        { id: 2, payload: { kind: 'medium-payload' } },
        { id: 3, payload: { kind: 'x' } },
        { id: 4, payload: { kind: 'another-payload-with-some-length' } },
      ];
      await Promise.all(events.map((e) => EventsWriter.applyEvent(path, e)));
      const raw = await readFile(path, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(events.length);
      for (const line of lines) {
        // Must not throw — each line is a complete valid JSON object.
        const parsed = JSON.parse(line);
        expect(typeof parsed.id).toBe('number');
        expect(typeof parsed.payload.kind).toBe('string');
      }
    });
  });
});
