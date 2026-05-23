import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { patchFrontmatter, parseMarkdown } from "./patch";

const TARGET_DIR = resolve(__dirname, "tmp");
const TARGET_FILE = resolve(TARGET_DIR, "character.md");
const N = parseInt(process.env.STRESS_N ?? "100", 10);

const SEED_CONTENT = `---
name: Aragorn
hp_current: 44
hp_max: 44
ac: 16
counter: 0
---

# Aragorn

Body content that should be preserved.

Multiple lines.

More text.
`;

async function setup() {
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });
  await writeFile(TARGET_FILE, SEED_CONTENT, "utf8");
}

async function runConcurrent() {
  // Launch N concurrent patches, each incrementing `counter` by 1
  const promises: Promise<void>[] = [];
  for (let i = 0; i < N; i++) {
    promises.push(
      patchFrontmatter(TARGET_FILE, (cur) => {
        const current = (cur.counter as number) ?? 0;
        return { ...cur, counter: current + 1 };
      }),
    );
  }
  const results = await Promise.allSettled(promises);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.length - ok;
  return { ok, fail };
}

async function verify() {
  const raw = await readFile(TARGET_FILE, "utf8");
  const parsed = parseMarkdown(raw);
  const counter = parsed.frontmatter.counter as number;
  const yamlValid =
    typeof parsed.frontmatter.name === "string" &&
    typeof parsed.frontmatter.hp_current === "number" &&
    typeof parsed.frontmatter.ac === "number";
  const bodyPreserved = parsed.body.includes("Aragorn") && parsed.body.includes("Multiple lines");
  return { counter, yamlValid, bodyPreserved, raw };
}

async function main() {
  await setup();
  console.log(`▶ Launching ${N} concurrent patchFrontmatter calls on ${TARGET_FILE}`);
  const start = Date.now();
  const { ok, fail } = await runConcurrent();
  const wall = Date.now() - start;
  console.log(`  Completed in ${wall}ms — ok=${ok} fail=${fail}`);

  const v = await verify();
  console.log(`\n────────────────────────────────────────────────────`);
  console.log(` ATOMICITY RESULT`);
  console.log(`────────────────────────────────────────────────────`);
  console.log(` counter final value: ${v.counter} (expected: ${N})`);
  console.log(` lost updates: ${N - v.counter}`);
  console.log(` YAML still valid: ${v.yamlValid ? "✓ YES" : "✗ NO"}`);
  console.log(` body preserved: ${v.bodyPreserved ? "✓ YES" : "✗ NO"}`);
  console.log(`────────────────────────────────────────────────────`);

  if (v.counter === N) {
    console.log(`✓ NO LOST UPDATES — atomic rename(2) preserved every increment.`);
  } else {
    const lostRate = (((N - v.counter) / N) * 100).toFixed(1);
    console.log(`✗ ${N - v.counter} LOST UPDATES (${lostRate}%) — naive read-modify-write is NOT safe under contention.`);
    console.log(`  Mitigation needed: file-level lock (flock) or single-writer queue.`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
