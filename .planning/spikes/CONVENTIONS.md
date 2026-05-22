# Spike Conventions

Patterns and stack choices established across spike rounds 1 and 2 (spikes 001-008). New spikes follow these unless the question requires otherwise.

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
