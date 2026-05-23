import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Single-writer queue per file path. Serializes concurrent appends.
 *
 * Note: this is in-process only — multi-process safety requires flock or a
 * separate writer daemon. For dnd-ai-master's single-Next.js-server scenario,
 * in-process mutex is sufficient.
 */
export class EventsWriter {
  private static queues = new Map<string, Promise<void>>();

  static async append(path: string, line: string): Promise<void> {
    const previous = EventsWriter.queues.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    EventsWriter.queues.set(path, next);
    try {
      await previous;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line.endsWith("\n") ? line : line + "\n", "utf8");
    } finally {
      release();
      // Cleanup map entry if we're still the head (no one chained after us)
      if (EventsWriter.queues.get(path) === next) {
        EventsWriter.queues.delete(path);
      }
    }
  }

  static async applyEvent(path: string, event: object): Promise<void> {
    await EventsWriter.append(path, JSON.stringify(event));
  }
}
