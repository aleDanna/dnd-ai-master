import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt, hashPrompt, lintBuilderSource } from "./builder";

const SAME_INPUT = { vaultRoot: "/vault", campaignId: "test", toolCount: 3 };
const DIFFERENT_INPUT = { vaultRoot: "/vault", campaignId: "different", toolCount: 3 };

interface Test {
  name: string;
  pass: boolean;
  detail: string;
}

const tests: Test[] = [];

// Test 1: same input twice produces identical output (byte-for-byte)
{
  const a = buildSystemPrompt(SAME_INPUT);
  const b = buildSystemPrompt(SAME_INPUT);
  const aHash = hashPrompt(a);
  const bHash = hashPrompt(b);
  tests.push({
    name: "stable: same input → identical SHA256",
    pass: aHash === bHash,
    detail: `aHash=${aHash.slice(0, 16)}…  bHash=${bHash.slice(0, 16)}…`,
  });
}

// Test 2: 1000 builds with same input → all identical
{
  const hashes = new Set<string>();
  for (let i = 0; i < 1000; i++) hashes.add(hashPrompt(buildSystemPrompt(SAME_INPUT)));
  tests.push({
    name: "stable: 1000 builds → 1 unique hash",
    pass: hashes.size === 1,
    detail: `unique=${hashes.size}/1000`,
  });
}

// Test 3: different campaign → different hash (sanity check; the builder still varies on real inputs)
{
  const a = buildSystemPrompt(SAME_INPUT);
  const b = buildSystemPrompt(DIFFERENT_INPUT);
  tests.push({
    name: "sensitivity: different input → different hash",
    pass: hashPrompt(a) !== hashPrompt(b),
    detail: `aHash=${hashPrompt(a).slice(0, 16)}…  bHash=${hashPrompt(b).slice(0, 16)}…`,
  });
}

// Test 4: lint catches forbidden patterns in builder source
{
  const builderSource = readFileSync(resolve(__dirname, "builder.ts"), "utf8");
  // Strip the FORBIDDEN_PATTERNS array itself (it contains the names as strings)
  // so the lint doesn't false-positive on its own definitions
  const stripped = builderSource.replace(/FORBIDDEN_PATTERNS[\s\S]*?\]\;/, "");
  const result = lintBuilderSource(stripped);
  tests.push({
    name: "lint: real builder.ts has no forbidden patterns",
    pass: result.ok,
    detail: result.ok ? "clean" : `violations: ${result.violations.join(", ")}`,
  });
}

// Test 5: lint DOES catch a deliberately bad sample
{
  const bad = `
    export function buildSystemPrompt() {
      return "Turn at " + Date.now() + " session=" + crypto.randomUUID();
    }
  `;
  const result = lintBuilderSource(bad);
  const expected = ["Date.now", "randomUUID"];
  const caughtAll = expected.every((p) => result.violations.includes(p));
  tests.push({
    name: "lint: catches Date.now + randomUUID in bad sample",
    pass: !result.ok && caughtAll,
    detail: `violations: ${result.violations.join(", ")}`,
  });
}

// Test 6: lint catches Math.random
{
  const bad = `const x = Math.random();`;
  const result = lintBuilderSource(bad);
  tests.push({
    name: "lint: catches Math.random",
    pass: !result.ok && result.violations.includes("Math.random"),
    detail: `violations: ${result.violations.join(", ")}`,
  });
}

// Test 7: lint catches process.env reads in prompt construction
{
  const bad = `const v = process.env.SOME_VAR;`;
  const result = lintBuilderSource(bad);
  tests.push({
    name: "lint: catches process.env reads",
    pass: !result.ok && result.violations.includes("process.env"),
    detail: `violations: ${result.violations.join(", ")}`,
  });
}

console.log("────────────────────────────────────────────────────");
console.log(" PROMPT BUILDER STABILITY TESTS");
console.log("────────────────────────────────────────────────────");
let passed = 0;
for (const t of tests) {
  const flag = t.pass ? "✓" : "✗";
  console.log(`${flag} ${t.name}`);
  console.log(`     ${t.detail}`);
  if (t.pass) passed += 1;
}
console.log("────────────────────────────────────────────────────");
console.log(` ${passed}/${tests.length} passed`);
console.log("────────────────────────────────────────────────────");
process.exit(passed === tests.length ? 0 : 1);
