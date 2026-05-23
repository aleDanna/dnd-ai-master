import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventsWriter } from "./writer";

const TARGET_DIR = resolve(__dirname, "tmp");
const EVENTS_FILE = resolve(TARGET_DIR, "events.md");
const N = parseInt(process.env.STRESS_N ?? "100", 10);

type Event = { id: number; type: "hp_change"; delta: number };

async function setup() {
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await writeFile(EVENTS_FILE, "", "utf8");
}

async function runConcurrent() {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < N; i++) {
    const event: Event = { id: i, type: "hp_change", delta: 1 };
    promises.push(EventsWriter.applyEvent(EVENTS_FILE, event));
  }
  const results = await Promise.allSettled(promises);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.length - ok;
  return { ok, fail };
}

async function verify() {
  const raw = await readFile(EVENTS_FILE, "utf8");
  const lines = raw.trim().split("\n").filter((l) => l.length > 0);
  const events: Event[] = [];
  let parseFailures = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      parseFailures += 1;
    }
  }
  const ids = new Set(events.map((e) => e.id));
  const expectedIds = new Set(Array.from({ length: N }, (_, i) => i));
  const missing: number[] = [];
  for (const id of expectedIds) if (!ids.has(id)) missing.push(id);
  const duplicates = events.length - ids.size;
  return { lineCount: lines.length, eventCount: events.length, parseFailures, missing, duplicates };
}

async function main() {
  await setup();
  console.log(`▶ Launching ${N} concurrent applyEvent via EventsWriter mutex on ${EVENTS_FILE}`);
  const start = Date.now();
  const { ok, fail } = await runConcurrent();
  const wall = Date.now() - start;
  console.log(`  Completed in ${wall}ms — ok=${ok} fail=${fail}`);

  const v = await verify();
  console.log(`\n────────────────────────────────────────────────────`);
  console.log(` EVENTS-MD CONCURRENCY RESULT`);
  console.log(`────────────────────────────────────────────────────`);
  console.log(` Lines written: ${v.lineCount}`);
  console.log(` Events parsed: ${v.eventCount}`);
  console.log(` Parse failures (corruption): ${v.parseFailures}`);
  console.log(` Missing event ids: ${v.missing.length}${v.missing.length > 0 ? ` (e.g. ${v.missing.slice(0, 5).join(",")}...)` : ""}`);
  console.log(` Duplicate event ids: ${v.duplicates}`);
  console.log(`────────────────────────────────────────────────────`);

  const allOk = v.lineCount === N && v.eventCount === N && v.parseFailures === 0 && v.missing.length === 0 && v.duplicates === 0;
  if (allOk) {
    console.log(`✓ ALL ${N} EVENTS PERSISTED ATOMICALLY. Single-writer queue works under contention.`);
    process.exit(0);
  } else {
    console.log(`✗ Failure detected. Single-writer-queue invariant violated.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
