# Prompt Builder

The system prompt is a pure function of its inputs. Stability across turns (byte-identical output for byte-identical inputs) is mandatory — drift erases the prefix-cache hit and degrades warm wall-clock from ~4s to ~12s+ on M4.

## Requirements

- **`buildSystemPrompt(input)` MUST be a pure function.** No `Date.now()`, no `Math.random()`, no `process.env` reads, no `crypto.randomUUID()`, no `process.hrtime`, no hostnames.
- **Inputs deterministic-ordered.** If you pass an object as input, sort its keys before serializing.
- **CI lint enforces this.** ESLint rule or stand-alone test in CI fails on any forbidden pattern in the builder source file.
- **Validated stability:** 1000 builds with same input → 1 unique SHA256 (spike 012).

## How to Build It

### The builder (pure function)

```ts
// src/ai/master/prompt-builder.ts

import { createHash } from "node:crypto";

export interface PromptInput {
  vaultRoot: string;
  campaignId: string;
  toolCount: number;
}

export function buildSystemPrompt(input: PromptInput): string {
  return [
    `You are an experienced D&D 5e Dungeon Master.`,
    ``,
    `## Knowledge layout`,
    ``,
    `Your knowledge lives in a markdown vault at root '${input.vaultRoot}'.`,
    `- Static knowledge: /handbook/<category>/<id>.md`,
    `- Active campaign: /campaigns/${input.campaignId}/`,
    ``,
    `## Tool usage protocol`,
    ``,
    `If you don't know what tools exist, your FIRST action is to read /tools/index.md.`,
    `After that, use any of the ${input.toolCount} listed tools directly.`,
    ``,
    `Keep responses concise.`,
  ].join("\n");
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
```

Why `.join("\n")` and not template literals? Because template literals are at the mercy of source-file line endings (`\r\n` vs `\n` from a Windows checkout would silently break stability). Explicit `\n` join is one of the few places where being paranoid pays off.

### The lint check

```ts
// src/ai/master/prompt-builder.lint.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN = [
  { name: "Date.now", re: /Date\.now\(/ },
  { name: "new Date(", re: /new\s+Date\(/ },
  { name: "Math.random", re: /Math\.random\(/ },
  { name: "process.hrtime", re: /process\.hrtime/ },
  { name: "randomUUID", re: /randomUUID\(/ },
  { name: "process.env", re: /process\.env\./ },
  { name: "hostname", re: /\.hostname\(/ },
];

test("prompt builder source has no forbidden patterns", () => {
  const source = readFileSync(resolve(__dirname, "prompt-builder.ts"), "utf8");
  const violations = FORBIDDEN.filter(({ re }) => re.test(source)).map(({ name }) => name);
  expect(violations).toEqual([]);
});

test("1000 builds with same input produce 1 unique hash", () => {
  const input = { vaultRoot: "/vault", campaignId: "test", toolCount: 4 };
  const hashes = new Set<string>();
  for (let i = 0; i < 1000; i++) hashes.add(hashPrompt(buildSystemPrompt(input)));
  expect(hashes.size).toBe(1);
});

test("different inputs produce different hashes", () => {
  const a = buildSystemPrompt({ vaultRoot: "/vault", campaignId: "test", toolCount: 4 });
  const b = buildSystemPrompt({ vaultRoot: "/vault", campaignId: "different", toolCount: 4 });
  expect(hashPrompt(a)).not.toBe(hashPrompt(b));
});
```

Run in CI on every PR. Full pattern in `sources/012-prompt-builder-stability/test.ts`.

### Lint check FALSE POSITIVE caveat

Spike 012 ran 6/7 tests — the 7th was a false positive. The lint scans the builder source for forbidden patterns, but it ALSO matches the strings inside the `FORBIDDEN` array definition itself (where each forbidden pattern is named as a string). Workarounds:

1. **Move `FORBIDDEN` to a separate file** that isn't scanned, OR
2. **Use an AST-based lint (ESLint custom rule)** instead of regex source scanning, OR
3. **Strip the FORBIDDEN array** from the source before scanning (script-level workaround).

Option 2 is cleanest for production. Option 1 is fastest. The spike used option 3 (didn't fully work).

## What to Avoid

### ✗ Embedding "session ID" or "timestamp" in the system prompt

Tempting because debuggers love them. They KILL the KV cache:

```ts
// ❌ NEVER DO THIS
return `Session ${sessionId} started at ${new Date().toISOString()}.\n\nYou are a DM...`;
```

Put session ID and timestamps in the *first user message* or in the response metadata, NEVER in the system prompt.

### ✗ Reading config from env vars inside the builder

Even reading `process.env.NODE_ENV` makes the builder impure if env can vary (different containers, different dev machines). If you need env-driven config, pass it as an EXPLICIT input to the builder:

```ts
// ❌ Bad
export function buildSystemPrompt(input: PromptInput): string {
  const env = process.env.NODE_ENV;
  return `You are a DM (env=${env}). ...`;
}

// ✓ Good
export interface PromptInput {
  // ... existing fields
  env: "dev" | "prod";  // pass it in
}
```

Now you can write a test that verifies the same `env` value produces the same hash.

### ✗ Concatenating with `+` from string parts in different orders

```ts
// ❌ Subtle: the spread order can be non-deterministic if you generate parts dynamically
const parts = [knowledgeBlock(input), protocolBlock(input), behaviorBlock(input)];
return parts.join("\n\n");
```

This is OK if `parts` is built in a consistent order, but a future refactor that does:

```ts
const parts = Object.values({ knowledge: ..., protocol: ..., behavior: ... });
```

is now at the mercy of `Object.values()` insertion order (which is stable in V8 but better not to rely on). Always use explicit ordered arrays.

### ✗ Including non-deterministic data structures (Sets, Maps with non-sorted iteration)

```ts
// ❌ Set iteration order is insertion order in V8, but you don't want to depend on insertion order across runs
return `Available tools: ${[...new Set(toolNames)].join(", ")}`;
```

Sort first:

```ts
return `Available tools: ${[...new Set(toolNames)].sort().join(", ")}`;
```

## Constraints

- **Ollama prefix cache** is what makes warm turns fast. Validated empirically (spike 003 warm = 4.5s vs cold = 7.5s, the delta is mostly prefix-cache effect).
- **Cache invalidation is byte-level.** Even a single whitespace change in the system prompt invalidates the entire cached prefix.
- **Cache TTL is governed by `keep_alive`.** With `keep_alive: "30m"`, the cached prefix survives across turns within a session. Drop to 0 and you pay cold every turn.
- **Cache is per (model, system_prompt) tuple.** Switching models mid-session invalidates the cache for both. Don't do per-turn model switching.
- **Test stability via SHA256, not string equality.** Same idea, but hashes are O(1) to compare and easier to log.

## Origin

Synthesized from spike: 012 (prompt-builder-stability, validated)

Source files available in:
- `sources/012-prompt-builder-stability/builder.ts` — the canonical pure-function pattern
- `sources/012-prompt-builder-stability/test.ts` — lint + stability tests

Related (depends on this for warm wall-clock target):
- `performance.md` — wall-clock numbers contingent on cache hit
- `tool-surface.md` — tool descriptions are part of the cacheable system prefix
