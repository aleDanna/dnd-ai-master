# LLM Tool Surface

The vault is navigated by the LLM through a minimal tool set. Strict-protocol enforcement of "read `/tools/<name>.md` before invoking <name>" failed on every local model. The lenient protocol — read `/tools/index.md` once per session — passes 100% on the chosen model.

## Requirements

- **Tool surface is fixed at 4 tools:** `read_vault_multi`, `list_vault`, `apply_event`, `end_turn`.
- **NEVER expose a singular `read_vault(path)` tool.** Spike 009 measured: with sequential `read_vault`, complex turns take 24.5s + quality 2/5; with `read_vault_multi`, 9.9s + quality 5/5. Δ -59.7% wall-clock + quality improves. Singular `read_vault` is a footgun — don't ship it.
- **Lenient discovery protocol:** "If you don't know what tools exist, your FIRST action is `read_vault_multi({paths: ['/tools/index.md']})`. After that, use any listed tool directly."
- **Accept BOTH turn terminators:** `end_turn` tool call AND `no_tool_calls + content`. Spike 002 measured qwen3:30b base dropping `end_turn` 40% of the time; rejecting that path discards 40% of valid responses.
- **Do not ship the per-tool-doc strict protocol.** Spike 002 measured 0-50% strict compliance across all local models — pattern is too prescriptive.

## How to Build It

### `/tools/index.md` (compact, ~500 tok)

```markdown
# Available Tools

| Tool | Purpose |
|---|---|
| `read_vault_multi` | Read N markdown files from the vault in ONE call (pass array of paths). |
| `list_vault` | List immediate children of a vault directory. |
| `apply_event` | Append a mutation event to the campaign's events.md (HP change, condition add, ...). |
| `end_turn` | Conclude the turn with a narrative response (optional — you may also return content directly). |
```

That's the entire tool documentation that lives in the LLM's context at session start (~1 read_vault_multi call = ~500 tokens).

### Per-tool docs (optional, lookup-on-demand)

`/tools/read_vault_multi.md`, etc — full JSON schema + examples. The lenient protocol does not require these to be read, but they're there if the model asks. Models typically don't.

### Server-side tool definitions (Ollama `/api/chat`)

```ts
const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault_multi",
      description: "Read MANY markdown files in ONE call. Pass an array of paths. Prefer this over multiple read_vault calls.",
      parameters: {
        type: "object",
        properties: { paths: { type: "array", description: "Array of vault paths" } },
        required: ["paths"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_vault",
      description: "List children of a vault directory.",
      parameters: {
        type: "object",
        properties: { directory: { type: "string", description: "Vault directory path" } },
        required: ["directory"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "apply_event",
      description: "Append a game-state mutation event (HP change, condition add, slot use, ...).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Event type (hp_change, condition_add, ...)" },
          payload: { type: "object", description: "Event-specific data" },
        },
        required: ["type", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "end_turn",
      description: "Conclude turn with final narrative response.",
      parameters: {
        type: "object",
        properties: { response: { type: "string", description: "Narrative response" } },
        required: ["response"],
      },
    },
  },
];
```

Full working harness in `sources/009-read-vault-multi/run-multi.ts`.

### Turn loop (accept both terminators)

```ts
for (let i = 0; i < MAX_TOOL_CALLS; i++) {
  const res = await chat(messages);
  messages.push(res.message);

  const calls = res.message?.tool_calls ?? [];
  if (!calls.length) {
    // Valid termination: no tool calls, content holds the response
    finalResponse = res.message?.content ?? "";
    break;
  }

  let endHit = false;
  for (const call of calls) {
    if (call.function.name === "end_turn") {
      finalResponse = call.function.arguments.response ?? "";
      endHit = true;
      break;
    }
    if (call.function.name === "read_vault_multi") {
      const paths = call.function.arguments.paths ?? [];
      const content = paths.map(p => `### ${p}\n\n${readOne(p)}`).join("\n\n---\n\n");
      messages.push({ role: "tool", content, tool_name: call.function.name });
    }
    // ... handle other tools
  }
  if (endHit) break;
}
```

### Path safety

ALL vault reads MUST go through a path-sanitization function. Spike 001 implementation:

```ts
function safeVaultPath(input: string, vaultRoot: string): string | null {
  const stripped = input.replace(/^\/+/, "");
  const candidate = normalize(join(vaultRoot, stripped));
  return candidate.startsWith(vaultRoot) ? candidate : null;
}
```

Any tool call with a path outside the vault root must return `"ERROR: path outside vault root"`. The LLM can't be trusted not to ask for `/etc/passwd`.

## What to Avoid

### ✗ Strict per-tool-doc protocol (PARTIAL in spike 002)

The pattern "before invoking tool X, you MUST read `/tools/X.md` first" sounds reasonable but failed empirically:

- llama3.2:3b: 0% compliance, never invoked tools at all
- gpt-oss:20b: 50% strict
- qwen3:30b-a3b: 10% strict
- qwen3:30b-a3b-instruct-2507(-q4): 60% strict

Gate threshold was 90%. None passed. The model's natural behavior is "read the index, then use what I read about." Forcing per-tool lookups for every tool fights the model and produces no quality improvement.

### ✗ Singular `read_vault(path)` as a primitive (INVALIDATED side-effect by spike 009)

If you expose `read_vault` alongside `read_vault_multi`, the model will sometimes use the singular form (especially when uncertain), and complex turns degrade catastrophically. Sequential `read_vault` for 4-6 paths = 24.5s warm + quality 2/5 vs `read_vault_multi` = 9.9s warm + quality 5/5. **Hide the singular form entirely.** If you absolutely need single-path reads, expose only `read_vault_multi` and let it accept an array of size 1.

### ✗ Rejecting `no_tool_calls + content` as invalid termination

Spike 002 measured qwen3:30b-a3b BASE skipping `end_turn` in 40% of cases. The model returned plain content (a valid Italian DM response) and the server would have to either:
1. Accept the content path (correct)
2. Re-prompt the model to "please call end_turn" (wastes tokens, frustrates the model into worse output)

Always accept both terminators. The chosen primary `qwen3:30b-a3b-instruct-2507-q4_K_M` uses `end_turn` only 2/10 in the compliance test — most of the time it terminates with content.

### ✗ Trusting LLM-provided paths without sanitization

Models will occasionally ask for paths like `/home/user/.ssh/id_rsa` if pressed (jailbreak attempts) or accidentally (typos, hallucinations). `safeVaultPath()` is non-negotiable.

## Constraints

- **MAX_TOOL_CALLS per turn:** 12 (existing project value, validated by spike 001 to be sufficient for complex 6-tool turns).
- **`read_vault_multi` returns concatenated content** with `### {path}\n\n{content}\n\n---` separators. Validated readable by all instruct-tuned models.
- **Tool call JSON varies by model.** qwen3 instruct emits clean `tool_calls[].function.{name, arguments}`. llama 3.2 3b doesn't invoke tools at all on this surface. Test any new model with spike 002 harness before adding to candidate pool.

## Origin

Synthesized from spikes: 002 (compliance sweep), 009 (read_vault_multi vs sequential)

Source files available in:
- `sources/002-tool-discovery-compliance/` — compliance harness + 4 models tested
- `sources/009-read-vault-multi/` — batched-read harness
