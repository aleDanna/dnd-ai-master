/**
 * Phase 02 — `EventsWriter`: single-writer mutex per absolute path.
 *
 * REQ-005 — Mutations go through `EventsWriter`'s single-writer mutex
 *           (NEVER naive read-modify-write — spike 006 measured 99/100 lost
 *           updates under contention; spike 010 closed the gap with this
 *           pattern). Validated by spike 010:
 *
 *             100 concurrent `applyEvent` calls → 100 events persisted in 7ms
 *             0 lost / 0 corrupted / 0 duplicated
 *
 * The mutex is an in-process `Map<absolutePath, Promise<void>>` chain. Each
 * call links to the previous one's tail and awaits it before performing its
 * own `appendFile`. `fs.promises.appendFile` is open(`O_APPEND`) → write →
 * close; for small writes (<4KB on POSIX) the `write` itself is atomic
 * across processes, so this implementation is doubly safe for the
 * single-Next.js-server scope (NON-REQ-001).
 *
 * Multi-process safety: OUT OF SCOPE. Two Node processes writing the
 * same `events.md` hold separate `Map`s; they corrupt each other.
 * Operational runbook (docs/operators/vault-backup.md, plan 02-10): any
 * bulk-mutation script (Phase 03 import, recovery tool) MUST run with
 * the Next.js server stopped.
 *
 * The `Map` auto-cleans: when a chain's tail releases AND no newer caller
 * has linked to it, the path's entry is deleted (line
 * `if (EventsWriter.queues.get(path) === next)` in `append`). Avoids
 * unbounded growth across long-running processes.
 *
 * Mutex-key contract: the resolved ABSOLUTE path passed in. Callers MUST
 * pass canonical paths (e.g., from `eventsPath(campaignId)` which calls
 * `path.resolve()` internally) so different spellings of the same file
 * (`/tmp/foo/events.md` vs `/tmp/foo/../foo/events.md`) collapse onto the
 * same mutex slot. No runtime check — see plan 02-03 §"Do NOT introduce"
 * for the rationale.
 *
 * Source-of-truth: `.planning/spikes/010-events-md-concurrency/writer.ts`
 *                  (this module is a near-verbatim lift; the algorithm is
 *                  locked by spike 010 stress validation).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
      // Cleanup map entry if we're still the chain tail (no one chained
      // after us). Bounds memory across the lifetime of the process.
      if (EventsWriter.queues.get(path) === next) {
        EventsWriter.queues.delete(path);
      }
    }
  }

  /**
   * Convenience wrapper: JSON-serialize the event and append as one line.
   * Used by the `apply_event` dispatch branch (plan 02-07) for every
   * `VaultEventEnvelope`. Spike 008 §"Event schema with versioning"
   * recommends one JSON object per line (JSONL); this is the format the
   * projector (plan 02-04) consumes.
   */
  static async applyEvent(path: string, event: object): Promise<void> {
    await EventsWriter.append(path, JSON.stringify(event));
  }
}
