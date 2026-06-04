# Spike Conventions

Patterns and stack choices established across all 14 spikes (rounds 1-3 + narrative iteration, 2026-05-22 through 2026-05-24). New spikes follow these unless the question requires otherwise. Spike phase closed; this file is the rosetta stone for future spike sessions.

## Stack

- **Runtime:** TypeScript via `tsx` (already in `package.json`). No Babel, no build step. `pnpm exec tsx <path>`.
- **HTTP client:** Native `fetch` for Ollama API. No SDK.
- **Filesystem:** Node `node:fs` and `node:fs/promises`. Direct, no abstraction layer.
- **LLM provider:** Ollama local HTTP API at `http://localhost:11434/api/chat` and `/api/generate`.
- **Vault format:** Markdown files with YAML-ish frontmatter (between `---` lines).

## Structure

```
.planning/spikes/
  MANIFEST.md                   ← index, requirements, decision gates
  CONVENTIONS.md                ← this file
  001-vault-harness-bootstrap/
    vault/                      ← shared sample vault — symlink/relative-import from later spikes
      tools/<name>.md
      handbook/<category>/<id>.md
      campaigns/<id>/{index,campaign}.md
      campaigns/<id>/characters/<name>.md
    log.ts                      ← ForensicLog (re-used by later spikes via relative import)
    run.ts
    README.md
  002-tool-discovery-compliance/
    run-compliance.ts
    results/                    ← per-turn NDJSON + aggregate JSON
    README.md
  ... (every spike follows this layout)
```

Numbering is sequential: `NNN-descriptive-kebab-name`. Comparison spikes get letter suffixes (`002a`, `002b`).

## Patterns

### Forensic logging

Every LLM-touching spike uses `ForensicLog` (defined in `001-vault-harness-bootstrap/log.ts`). Append-only NDJSON. One event per line. Event types: `turn_start`, `ollama_request`, `ollama_response`, `tool_call`, `tool_result`, `end_turn`, `error`, `summary`.

Each `ollama_response` event captures: `prompt_eval_duration_ms`, `eval_duration_ms`, `prompt_eval_count`, `eval_count`, `load_duration_ms`, `total_duration_ms`. These map to Ollama API nanosecond fields divided by 1e6.

`log.summary()` aggregates totals across multi-step turns. Use it at the end of every spike harness.

### Head-to-head comparison

Spikes that compare two setups (baked vs vault, stable vs drift, etc.) follow this shape:

1. Define both setups as functions with matching signatures (`runBaked`, `runVault`, etc.)
2. Loop over `(setup × state × scenario × repetitions)`
3. Live progress per turn with key metrics inline
4. Aggregate at end: averaged table + delta % computed as `(baseline - candidate) / baseline × 100`

### Vault sharing across spikes

The sample vault lives in `.planning/spikes/001-vault-harness-bootstrap/vault/`. Later spikes import it via relative path resolution (`resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault")`). This avoids drift across spikes and lets you extend the vault (add monsters, items) in spike 001 and have all later spikes benefit.

### Tool-call loop pattern

```ts
for (let i = 0; i < MAX_TOOL_CALLS; i++) {
  const res = await chat(model, messages, tools, log);
  messages.push(res.message);
  const calls = res.message?.tool_calls ?? [];
  if (!calls.length) {
    // Treat as turn termination — model returned content without calling end_turn
    finalResponse = res.message?.content ?? "";
    break;
  }
  let endHit = false;
  for (const call of calls) {
    // ... handle end_turn, read_vault, list_vault, etc.
    if (call.function.name === "end_turn") { endHit = true; break; }
    messages.push({ role: "tool", content: result, tool_name: call.function.name });
  }
  if (endHit) break;
}
```

Two valid turn terminators: `end_turn` tool call OR `no_tool_calls + content`. Both must be handled (spike 002 finding).

### Path safety in vault tools

```ts
function safeVaultPath(input: string): string | null {
  const stripped = input.replace(/^\/+/, "");
  const candidate = normalize(join(VAULT_ROOT, stripped));
  return candidate.startsWith(VAULT_ROOT) ? candidate : null;
}
```

Always normalize and verify the absolute path is under the vault root. Prevents `../../etc/passwd` style escapes. Use in every spike that exposes `read_vault` to the LLM.

### Result artifacts per spike

Every spike writes its raw outputs to `<spike>/results/` (gitignored or committed depending on size):
- `forensic-<timestamp>.ndjson` — per-event log
- `results-<timestamp>.json` — aggregated structured results

Plus a `README.md` with frontmatter + Investigation Trail + Results sections.

## Tools & Libraries

### Used
- `tsx` — TS runner. From project's existing devDependency. Zero new install required.
- Node built-ins only: `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`.

### Considered but rejected
- `proper-lockfile` — for spike 006 mitigation. Deferred (spike 008 showed events.md is the right answer).
- `@anthropic-ai/sdk` — already in stack but not needed for local-Ollama spikes.
- `js-yaml` — for frontmatter parsing in spike 006. Hand-rolled minimal parser was sufficient.

## Default Ollama settings

- `keep_alive: "30m"` — keeps the model loaded between turns within a session
- `stream: false` — easier to measure timing without SSE overhead
- `options: { temperature: 0.7, num_predict: 2500 }` for narrative spikes
- `options: { temperature: 0.3, num_predict: 800 }` for compliance/benchmark spikes (more deterministic)

## Cold-start protocol

To measure cold-start fairly:
```ts
async function unload(model: string): Promise<void> {
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}
```

The empty generate + `keep_alive: 0` evicts the model from memory. The 1.5s pause lets Ollama settle. Next call shows real `load_duration_ms`.

## Decision-grade rule

> **Performance numbers measured on M5 Pro dev are informative only.**
> **Decision-grade G1 must be measured on Mac Mini M4 hardware (see spike 004).**
> Compliance and quality metrics ARE HW-agnostic and can decide on M5 Pro.

This is enforced in every spike README's "Limitations" section.

## Patterns added in Round 3 + narrative iteration (spikes 009-014)

### Batched tool reads (spike 009)
- **Never expose singular `read_vault(path)`** — always `read_vault_multi({paths: []})`. Sequential reads degrade -59.7% wall-clock + quality 5/5 → 2/5 on complex turns. Pattern in `sources/009-read-vault-multi/run-multi.ts`.

### Single-writer mutex (spike 010)
- **`EventsWriter.append(path, line)`** uses an in-process Map<path, Promise<void>> queue. Stress-tested at 100 concurrent appends: 0 lost / 0 corrupted / 0 duplicated in 7ms. Pattern in `sources/010-events-md-concurrency/writer.ts`.
- For multi-process scenarios (future scale), swap for `flock(2)` or a separate writer daemon.

### Pure-function prompt builder + ESLint rule (spike 012)
- **`buildSystemPrompt(input): string`** is pure. Validated 1000 builds with same input → 1 unique SHA256.
- **Lint forbids in builder source:** `Date.now`, `new Date(`, `Math.random`, `process.hrtime`, `randomUUID`, `process.env.`, `.hostname(`.
- **Caveat:** the lint scanning approach has a false positive on its own FORBIDDEN_PATTERNS array. Real production should use AST-based ESLint rule, not regex source scan.

### Session-level integration test (spike 011)
- Run 10 consecutive turns sharing one message history. Track per-turn wall-clock, prompt-token growth, SHA256 stability of the system message.
- Discovered: context growth (accumulated tool_results) is the new bottleneck after ~7-8 turns. Mitigation: per-turn summarization at 15K-token boundary (Phase 1 deliverable).

### Backup/DR via git + replay (spike 013)
- Vault is a git repo. `git commit` after every event (or batched). Restore = `git clone` + run replay projector. Validated byte-exact restore.
- No `pg_dump`, no migration tooling, no Postgres dependency in DR.

### Human-eval scenarios (spike 014)
- For dimensions that only human judgment can evaluate (narrative voice, NPC quality, choice presentation), the spike runner writes a side-by-side markdown report with empty verdict tables. The user fills them in. The spike README documents the final ranks and reasoning.
- Pattern in `sources/014-narrative-quality/run-narrative.ts` + `scenarios.ts`.

### `think: false` does NOT help with thinking-native models (spike 014 iter 2)
- For qwen3:30b-a3b BASE: even passing `body.think = false` in the Ollama request, the model emits English chain-of-thought as the content. The flag stops filtering, doesn't suppress generation.
- Implication: instruct-tuned variants are required for direct narrative output. Thinking-native models need a CoT-extraction pipeline (out of scope).

## Final candidate pool (decision-locked)

After spike 004 (M4 feasibility sweep) + spike 014 (narrative quality):

| Role | Model | Why |
|---|---|---|
| **Primary** | `qwen3:30b-a3b-instruct-2507-q4_K_M` | G1 -85.5% warm M4, G2 100%, narrative 9 pts (tied for 1st) |
| **Quality-fallback (opt-in)** | `qwen3:30b-a3b-instruct-2507` | within 2.4% wall-clock, marginally better NPC voicing |
| **Offline content tool** | `mistral-small3.2:24b` | G2 80% (live-turn fail) but only model with authentic non-standard voice (goblin pidgin) |
| Baked baseline (regression test) | `dnd-master-plus:latest` (gpt-oss:20b baked) | comparison anchor; do not deploy |
| ✗ Eliminated | `qwen3:30b-a3b` BASE | thinking-native CoT leak even with `think:false` |
| ✗ Eliminated | `mistral-small3.2:24b-instruct-2506-q4_K_M` | G1 +81.9% (slower than baked) |
| ✗ Eliminated | `llama3.2:3b` | 0% tool compliance |

## Graphify evaluation (spikes 015–018)

Tooling + gotchas for any future graphify work. (Tool **evaluated and NOT adopted** — see MANIFEST phase verdict. Vault stack stays.)

- **Install with the backend extra:** `uv tool install "graphifyy[ollama]"` — plain `graphifyy` omits the `openai` dep the ollama/openai-compat backends need.
- **Build = `graphify extract <dir>`** (AST + semantic LLM) → `<dir>/graphify-out/graph.json`. `update` is code-only (AST, no LLM); narrative needs full `extract`. graph.json uses `links` (not `edges`) for the edge array (trips up naive inspection + breaks `affected`).
- **Backends:** local `ollama` (`OLLAMA_API_KEY=ollama`, `OLLAMA_BASE_URL=http://localhost:11434/v1`, `--model <m>`, `--max-concurrency 1`); cloud `gemini|openai|deepseek|kimi|claude`; or `claude-cli` (routes through the local Claude Code CLI, no API key, `GRAPHIFY_CLAUDE_CLI_MODEL=sonnet`).
- **Local extraction is slow + unreliable** on M-series: qwen3:30b ~6-7 min/run, occasional 0-node runaway JSON (Ollama ignores the output cap; #798-style hollow 200s). gemma4:12b worse (1 node). Use cloud/claude-cli for anything real.
- **Stock extraction prompt yields generic relations** (`references`/`conceptually_related_to`) on capable models — useless for "who did what to whom". Rich domain edges need a custom extraction prompt.
- **Queries are local + cheap** (BFS, ~0.07–0.16 s, no LLM): `query`/`explain`/`path`. But `query` over-retrieves (depth-2 ≈ half the graph), `affected` errors on the `links` schema, node matching is language-coupled to the corpus, and results are pointers (not content).
- Reusable fixtures: `015-*/corpus/` (IT campaign + built graph), `016-*/fixtures/` (qwen vs Sonnet graphs), `018-*/fixtures/` (craft graph + report).

## Wrap-up artifacts

- Implementation blueprint skill: `./.claude/skills/spike-findings-dnd-ai-master/`
- Project history summary: `./.planning/spikes/WRAP-UP-SUMMARY.md`
- Companion design docs: `docs/superpowers/specs/2026-05-22-vault-llm-wiki-{design,risks}.md`
- This file: rules for any future spike work on the same project.
