# Performance

The vault path achieves -85.5% warm wall-clock vs the baked baseline on M4 production hardware (3.78s vault warm vs 26s baked warm). Context growth is the next bottleneck once turns chain together. Prefix-cache stability matters more than expected.

## Requirements

- **G1 wall-clock target (production):** vault warm turn < 30s on M4 for the typical lookup turn. Validated at ~3.8s (well under). For complex multi-tool turns, validated at ~10s with `read_vault_multi`.
- **G1 quality preservation:** keyword correctness ≥ baked baseline. Validated 4/5 = 4/5 on warm; on cold the vault occasionally underperforms (3/5) due to roundtrip variance on fresh KV state.
- **Prefix-cache hygiene mandatory.** Spike 012 validated `SystemPromptBuilder` SHA256-stability across 1000 builds. Any drift (timestamps, UUIDs, random ordering) erases the warm advantage.
- **Per-turn summarization at 15K-token boundary.** Spike 011 showed turn 8 of a 10-turn session climbed to 22K prompt tokens and 31s wall-clock. Without summarization, long sessions degrade.

## How to Build It

### Reference wall-clock numbers (M4 production, spike 004 measured)

```
Primary model: qwen3:30b-a3b-instruct-2507-q4_K_M

WARM TURN (typical lookup):
  Baked baseline (dnd-master-plus):  26,052 ms
  Vault candidate:                    3,782 ms
  Δ wall-clock:                      -85.5%

COLD TURN (first turn of session):
  Baked baseline:                    34,856 ms
  Vault candidate:                   15,746 ms
  Δ wall-clock:                      -54.8%

QUALITY (5-keyword check):           vault 4/5 warm, 3/5 cold; baked 4/5 / 3/5
```

These are the numbers a Phase 1 implementation must reproduce within ±20%. If a benchmark shows vault warm > 10s on M4, something is broken.

### Why the migration is faster than predicted

Original prediction: M4 wall-clock = M5 Pro wall-clock × 2.5 (bandwidth penalty 307→120 GB/s). **Wrong for MoE models with active-params routing.** `qwen3:30b-a3b` activates only 3B parameters per token. Decode cost matches a 3-8B dense model, not 30B. M4 with this model beats M5 Pro with gpt-oss:20b (3.78s vs 4.5s).

Implication for future hardware/model decisions: bandwidth-bound prediction holds for dense models, fails for MoE. Measure, don't extrapolate.

### Prefix-cache stable system prompt builder (spike 012)

Pure function. Same inputs → byte-identical output → Ollama KV-cache hit on the static prefix → warm prefill ~40ms instead of ~1000ms.

```ts
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

Validated in spike 012: 1000 builds with same input → 1 unique SHA256.

### ESLint rule to enforce stability

Forbid the following in the prompt builder source file:
- `Date.now(`
- `new Date(`
- `Math.random(`
- `process.hrtime`
- `randomUUID(`
- `process.env.`
- `.hostname(`

CI test (in `sources/012-prompt-builder-stability/test.ts`) loads the builder source and runs a regex linter. Fail CI if any forbidden pattern appears.

### Per-turn summarization (Phase 1 deliverable, not yet built)

Trigger: cumulative prompt tokens > 15,000. Action:

```ts
async function maybeCondense(messages: Message[]): Promise<Message[]> {
  const totalTokens = estimateTokens(messages);  // char/4 heuristic
  if (totalTokens < 15_000) return messages;

  // Find the boundary: keep system + last 3 turns; condense the rest
  const system = messages[0];
  const recent = messages.slice(-6);  // ~3 user/assistant pairs
  const older = messages.slice(1, -6);

  const summary = await summarize(older);  // separate quick LLM call (or use the same model with a focused prompt)

  return [
    system,
    { role: "user", content: `[Summary of earlier turns]\n${summary}` },
    ...recent,
  ];
}
```

### Honest cold-start estimate

Cold-start is dominated by model load (~2.5-3s on M4 for the q4_K_M variant). The vault adds tool roundtrip (~1-2 calls for a typical lookup). Net cold: ~15s on M4, vs baked ~35s. Acceptable — cold is once per session.

## What to Avoid

### ✗ System prompt drift (cache-killer)

The cache miss penalty is dramatic. Spike 007's outlier showed one drift turn at 12 minutes wall-clock (anomalous but real). The "feel" of degradation is non-linear — small drifts cause large cache misses.

**Cache-killers seen in real codebases:**
- `Date.now()` in a "session started at" prefix
- Per-turn UUID in a "turn ID" prefix
- Sort order of an object's keys differing between runs (use `JSON.stringify` with sorted keys if you must include structured data)
- Mixed line endings (`\r\n` vs `\n`) sneaking in from a Windows source file

### ✗ Sequential `read_vault` for complex turns (resolved by spike 009)

Already covered in `tool-surface.md`. Mentioned here because the wall-clock impact is the *direct cause* of why this is a performance requirement, not just a tool-design opinion: 24.5s → 9.9s (-59.7%) is the difference between "acceptable" and "feels slow."

### ✗ Assuming bandwidth-ratio predicts M4 performance for MoE models

The conservative prediction ("M4 is 2.5× slower than M5 Pro") would have rejected qwen3-a3b as too slow. Empirical measurement on M4 showed it's actually 0.84× M5 Pro (faster) because active-3B routing decouples decode cost from total params. **Always measure on production hardware, don't extrapolate from dev.**

### ✗ Ignoring cold-start in sessions < 5 turns

If sessions are typically 1-3 turns, cold dominates UX. The current target is multi-turn campaigns (50+ turns per session), so cold is amortized.  If a future feature creates short-session UX (e.g. "quick rule lookup chat"), reconsider — cold +15s is rough for a 1-turn UX.

### ✗ Letting context grow unbounded

Spike 011 turn 8 hit 22K prompt tokens, 31s wall-clock. Without per-turn summarization, sessions slow down as they go. Build the condenser into Phase 1.

## Constraints

- **M4 32GB RAM:** primary model (~18GB Q4) + node + postgres + browser = tight. No headroom for a second loaded LLM model (e.g. embedder co-residence). Vault eliminates the embedder need — keeps memory pressure low.
- **M4 256GB SSD:** model + git vault + ai_usage telemetry + macOS = comfortable. Don't compound by keeping multiple baked variants (spike 004 implication).
- **Ollama `num_predict` cap:** project default is 2500-3000. Spike 011 turn 8 ate 22K *prompt* tokens; output stayed ~1.7K. Watch the prompt side, the output side has headroom.
- **`prompt_eval_duration_ms` is in ns in Ollama API.** Divide by 1e6 to get ms. Same for `eval_duration_ms` and `load_duration_ms`. Spike harnesses do this consistently.
- **Outliers (>10 min wall-clock) appeared in spikes 007 and 011** on M5 Pro dev. Suspected background process interference. Production M4 (dedicated to Node+Ollama) should not see these — if they appear there, investigate before launch.

## Origin

Synthesized from spikes: 003, 005, 007, 011

Source files available in:
- `sources/003-prefill-walltime-savings/` — first baked-vs-vault benchmark
- `sources/005-complex-turn-benchmark/` — multi-tool turn regression that motivated read_vault_multi
- `sources/007-prefix-cache-stability/` — drift penalty quantification
- `sources/011-full-session-simulation/` — 10-turn session, context-growth bottleneck identified
