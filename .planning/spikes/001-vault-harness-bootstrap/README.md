---
spike: 001
name: vault-harness-bootstrap
type: standard
validates: "Given a Node script with Ollama client + 3 stub tools (read_vault, list_vault, end_turn) + minimal vault layout, when invoked with a simple D&D query, then 1 happy-path turn completes"
verdict: VALIDATED
related: [002, 003]
tags: [foundation, ollama, harness]
---

# Spike 001: vault-harness-bootstrap

## What This Validates

Given a Node script with Ollama client + 3 stub tools (`read_vault`, `list_vault`, `end_turn`) + a minimal vault layout (3 spells + 1 character + `/tools/` documentation), when invoked with a simple D&D query, then 1 happy-path turn completes producing a coherent answer.

## Research

Approach comparison evaluated upstream:

| Approach | Tool | Pros | Cons | Status |
|---|---|---|---|---|
| Ollama `/api/chat` native tools | `fetch` + JSON | Already in stack. Preserves `prompt_eval_duration_ms` / `eval_duration_ms` granular timing | Tool-call JSON format varies between models | **Chosen** |
| Ollama via OpenAI-compat `/v1/chat/completions` | `openai` SDK pointing at Ollama | Familiar | Loses granular timing fields needed for spike 003 | Rejected |

**Chosen:** Native `/api/chat` — same path used in `src/ai/provider/local.ts`.

Verified during build:
- qwen3:30b-a3b returns well-formed `tool_calls[].function.{name, arguments}` JSON
- `keep_alive: "30m"` sufficient for sequential turns (model stays loaded)
- `tool` role response messages with `tool_name` field accepted

## How to Run

```bash
pnpm exec tsx .planning/spikes/001-vault-harness-bootstrap/run.ts
# or with custom question:
pnpm exec tsx .planning/spikes/001-vault-harness-bootstrap/run.ts "How does magic missile scale at higher levels?"
# environment knobs:
SPIKE_MODEL=llama3.2:3b LAZY_TOOLS=false pnpm exec tsx .planning/spikes/001-vault-harness-bootstrap/run.ts
```

## What to Expect

- Stdout summary with model, user message, master response, tool-call count, wall-clock, prefill + decode timing
- A new `forensic-<timestamp>.ndjson` file with one JSON line per event (turn_start, ollama_request, ollama_response, tool_call, tool_result, end_turn, summary)
- The forensic log is the substrate for spike 002's compliance counting and spike 003's wall-clock measurement

## Observability

`ForensicLog` (`log.ts`) writes append-only NDJSON. Each `ollama_response` event captures:
- `prompt_eval_duration_ms` (prefill time)
- `eval_duration_ms` (decode time)
- `prompt_eval_count` (input tokens)
- `eval_count` (output tokens)
- `load_duration_ms` (model loading, > 0 only on cold start)
- `total_duration_ms`

`log.summary()` aggregates totals across multi-step turns.

## Investigation Trail

### Iteration 1 — Initial happy-path run (qwen3:30b-a3b, LAZY_TOOLS=true)

Query: *"How much damage does a Fireball do when cast with a 5th-level spell slot?"*

**Result:** Correct answer (10d6) in 17.4s wall-clock, 1 tool call (`read_vault`), 1713 prompt tokens, 826 eval tokens.

**Surprise (critical):** Despite the lazy-tools system prompt explicitly stating "**Before invoking any tool by name, you MUST first call `read_vault` to read `/tools/<tool-name>.md`**", the model:
1. Did NOT read `/tools/index.md`
2. Did NOT read `/tools/read_vault.md` before invoking `read_vault`
3. Did NOT call `end_turn` at all — instead returned the answer in the `content` field of a no-tool-calls response

The model went straight to `read_vault("/handbook/spells/fireball.md")` and then answered in plain content. This is a 0% compliance run on the strictest reading of the protocol.

This was the *best-case* local model (qwen3:30b-a3b). The implication for spike 002 is significant: tool-discovery compliance may be lower than the 90% gate threshold even on the strongest available local model.

**Forensic log:** `forensic-1779404424481.ndjson`

### Iteration 2 — Not run yet

Deferred. Spike 002 will systematically measure compliance across 20 turns × 3 models, building on this finding.

## Results

**Verdict: VALIDATED** — the foundation harness works as intended:
- Ollama tool calling integration: ✓
- Vault filesystem reads (with path-traversal protection): ✓
- Forensic logging captures granular timing: ✓
- Tool result feedback loop terminates: ✓
- Coherent end-to-end response: ✓

### Key numbers (single run, qwen3:30b-a3b, M5 Pro dev, cold-start)

| Metric | Value |
|---|---|
| Wall-clock total | 17.4 s |
| Load duration (cold) | 5.4 s |
| Total prompt_eval | 1.67 s (1713 tokens) |
| Total eval | 10.1 s (826 tokens) |
| Decode rate | ~82 tok/s |
| Tool calls | 1 |
| Loop iterations | 2 |

### Surprises that inform downstream spikes

1. **Tool discovery non-compliance** (relevant to spike 002, gate G2)
   The model bypassed the `/tools/<name>.md` lookup protocol entirely on this single run. Spike 002 must measure this rate systematically and consider:
   - Whether stronger prompt phrasing improves compliance
   - Whether explicit examples in the system prompt help
   - Whether smaller models (llama3.2:3b) fail in *different* ways (hallucinated arguments, wrong tool name, malformed JSON)

2. **Skipped `end_turn`** (relevant to all downstream spikes)
   The model returned content directly instead of calling `end_turn`. This is actually fine from a UX perspective (we can accept either path), but it means the **tool-protocol as designed has weaker enforcement than expected**. Real implementation will need to handle both control-flow paths.

3. **Decode rate ~82 tok/s on M5 Pro is much higher than the 22.9 tok/s figure in the original ai_usage telemetry.** That number was for thinking-ON mode on qwen3:30b-a3b with reasoning tokens. This spike used thinking-OFF (no `/think` directive), so the comparison is not apples-to-apples. **Spike 003 must control thinking mode explicitly** and measure the production-realistic config.

4. **1713 prompt tokens for 2 turns** is well within the floor estimate (~3K static + dynamic = ~3K-5K total per turn). The lazy-tools system prompt clocked at ~536 tokens for the first call, confirming the section-4 theoretical floor of ~3K is realistic.

## Signal for the real build

- The `read_vault` / `list_vault` / `end_turn` tool surface is sufficient for static knowledge lookup. Confirmed.
- Forensic logging via NDJSON is the right format for benchmarking. Continue this pattern in 002 and 003.
- **`end_turn` as a required tool is not enforced by current local models.** Either accept "no tool calls + content" as a valid turn termination, or build server-side enforcement (reject non-tool-call responses and re-prompt).
- **Lazy-tools protocol is fragile.** Spike 002 must measure how fragile, but plan B (TOOL_CONTRACT_SLIM inline) needs to be ready.
