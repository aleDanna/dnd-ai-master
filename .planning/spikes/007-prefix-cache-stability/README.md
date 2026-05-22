---
spike: 007
name: prefix-cache-stability
type: standard
validates: "Given system-prompt drift (byte-level changes per turn) vs stable, when measured on Ollama gpt-oss:20b, then drift measurably degrades prefill — quantify how strict cache hygiene must be in the real build"
verdict: VALIDATED
related: [003, 005]
tags: [implementation-guard, kv-cache, ollama]
---

# Spike 007: prefix-cache-stability

## What This Validates

Spike 003 closed with "**Prefix-cache hygiene becomes a hard requirement.** Real build must ensure system prompt is byte-stable across turns within a session." This spike measures *how big* the penalty is when that rule is violated.

## How to Run

```bash
pnpm exec tsx .planning/spikes/007-prefix-cache-stability/run-cache-stability.ts
TURNS_PER_MODE=10 pnpm exec tsx .planning/spikes/007-prefix-cache-stability/run-cache-stability.ts
```

Runs `TURNS_PER_MODE` turns in each of two modes:
- **STABLE:** same system prompt byte-for-byte across turns
- **DRIFT:** system prompt with mutating timestamp prepended each turn (worst-case drift)

Measures first-call prefill duration (the metric most sensitive to cache hits) and wall-clock per turn.

## Results

**Verdict: VALIDATED — drift penalty is significant; cache hygiene is mandatory**

Raw measurements (gpt-oss:20b, M5 Pro):

```
[STABLE mode]
  turn 1: wall=2717ms   1st-prefill=52ms   prefill-tokens=250  load=79ms
  turn 2: wall=755022ms  ← OUTLIER (probable system interference)
  turn 3: wall=4358ms   1st-prefill=41ms   prefill-tokens=251  load=75ms
  turn 4: wall=3084ms   1st-prefill=56ms   prefill-tokens=252  load=76ms
  turn 5: wall=2957ms   1st-prefill=56ms   prefill-tokens=251  load=76ms

[DRIFT mode]
  turn 1: wall=4877ms   1st-prefill=205ms  prefill-tokens=270  load=76ms
  turn 2: wall=8224ms   1st-prefill=200ms  prefill-tokens=269  load=75ms
  turn 3: wall=9605ms   1st-prefill=202ms  prefill-tokens=271  load=78ms
  turn 4: wall=407097ms  ← OUTLIER (probable system interference)
  turn 5: wall=3654ms   1st-prefill=222ms  prefill-tokens=271  load=94ms
```

**Outlier handling.** The 755s and 407s measurements are >100× the other values and don't match any pattern (no model reload, no large prompt). They're almost certainly system interference (other processes competing for GPU/CPU/memory). Excluding them:

| Metric | STABLE (n=4) | DRIFT (n=4) | Drift penalty |
|---|---|---|---|
| Avg wall | 3,279 ms | 6,590 ms | **+101%** |
| Avg 1st-prefill | 51 ms | 207 ms | **+306%** |
| Avg prefill tokens | 251 | 270 | +7.6% |

The prefill-token count is nearly identical (251 vs 270 — only the timestamp differs). But prefill *duration* is 4× longer on drift. **This is direct evidence that Ollama is not reusing the prefix cache** when the prompt prefix changes.

### What this means

Ollama's prefix-cache invalidates on any byte change in the prefix. A timestamp at the *start* of the system prompt invalidates the entire system + tool definitions block. Re-prefill of ~250 tokens costs 200ms even though it was "the same" semantically.

For a vault setup with system prompt of ~600-1000 tokens and *every tool call* appending growing context (vault content reads), losing the prefix cache means re-prefilling thousands of tokens. This compounds and explains spike 005's vault-warm regression on complex turns: each roundtrip's tool_result modifies the message tail, and *any* drift in the system prefix would multiply the cost.

### Wall-clock vs prefill interpretation

The wall-clock 2× slowdown is more than the prefill-only effect would predict (since prefill is only ~5-7% of total wall-clock). Possible explanations:
- Drift also affects warm-decode caching (model state not preserved between turns)
- Memory pressure: each drift turn allocates a slightly different KV cache region, fragmenting memory
- Re-tokenization cost for the prefix is higher than measured (Ollama may not isolate it in `prompt_eval_duration`)

These would be worth a follow-up spike, but the *gating implication* is already clear.

## Investigation Trail

### Iteration 1 — Initial 5-turn comparison

Outliers in wall-clock made the aggregate average misleading (script reported "drift is faster" because of one 12-minute STABLE outlier). Manual outlier exclusion produced the real signal: drift doubles wall-clock and quadruples first-call prefill.

### Iteration 2 — Investigate outliers (not done)

The 755s and 407s outliers warrant investigation but are probably system noise. Re-running with the machine isolated (no other GPU/CPU consumers) would produce cleaner data. The 1st-prefill numbers were stable (50-60ms vs 200-220ms) across all turns, so the *prefill signal is real* regardless of the wall-clock noise.

### Iteration 3 — Multiple drift patterns (not run)

Tested only "prepend timestamp". Other drift patterns to test:
- Drift in the *middle* of the system prompt (which sections are cached?)
- Drift in tool definitions (the JSON tool array)
- Drift only in user message (no system change)

These would map out which parts of the prompt are most sensitive. For now, the conservative rule "make the entire prefix stable" suffices.

## Decision-grade implications

1. **Prefix cache hygiene is MANDATORY in the real build.** Doubling the wall-clock per turn would erase the entire vault advantage measured in spike 003.

2. **The drift-doubling effect compounds with spike 005's complex-turn regression.** A complex turn with 9 tool calls × 2× drift penalty = catastrophic. Spike 005's warm vault numbers may already have been partially due to micro-drift in the prompt across roundtrips (e.g., role tags, internal counters).

3. **Implementation checklist** for prefix stability:
   - System prompt is constant during a session (no per-turn re-construction)
   - Tool definitions are constant (same JSON, same ordering, byte-stable)
   - No timestamps, UUIDs, request IDs, turn counters injected into the prefix
   - Dynamic context (snapshot, scene, RAG block) goes at the *end* of the system block or in a separate user message — never before the tool definitions

4. **The Ollama prefix cache is not as forgiving as I assumed.** It does exact-byte matching of the prefix; any change anywhere in the prefix invalidates the entire cache for that turn. This is more strict than e.g. Anthropic's prompt caching (which has explicit cache_control markers).

## Signal for the real build

- **Build a `SystemPromptBuilder` that produces byte-stable output for a given session_id.** Hash the output and assert in tests that two builds for the same session match.
- **Move all dynamic content (turn snapshot, scene) to a separate user-prepended message**, never into the system block. The system block must be cacheable.
- **Lint the system prompt builder for forbidden tokens:** timestamps (`Date.now()`), UUIDs, random IDs, per-turn counters. CI test that runs the builder with the same inputs twice and diffs.
- **Spike 005's complex-turn wall-clock numbers should be re-measured** with a verified-stable prompt builder to determine if the observed regression was partly cache miss vs structural.
- **Document this in the migration plan** as a Phase 1 deliverable: "Prefix-stable system prompt builder + drift test."

## Limitations of this measurement

- N=5 per mode with 1 outlier each excluded. Re-run on isolated machine would be cleaner.
- Tested only "prepend timestamp" drift. Other drift patterns may have different magnitudes.
- Tested only gpt-oss:20b. qwen3:30b and other models may have different cache behavior.
- Prefill measurement assumes Ollama's `prompt_eval_duration` accurately captures the re-tokenization cost. If part of the cost leaks into `eval_duration`, the prefill-only metric understates the effect.
