---
spike: 005
name: complex-turn-benchmark
type: standard
validates: "Given a 5-tool-call multi-action D&D turn (read PC sheet + read monster + apply rules), when run on gpt-oss:20b vault setup vs baked baseline, then compliance ≥90% AND wall-clock < 30s warm AND quality preserved"
verdict: PARTIAL
related: [002, 003]
tags: [g1, g2, complex, ollama, hard-finding]
---

# Spike 005: complex-turn-benchmark

## What This Validates

Real D&D turns chain 3-6 actions per player turn (move, attack, react, lookup conditions, narrate). Spikes 002 and 003 used short turns (1-2 tool calls). This spike validates that the gpt-oss:20b + vault setup retains its compliance and wall-clock advantages on a realistic complex turn.

## How to Run

```bash
pnpm exec tsx .planning/spikes/005-complex-turn-benchmark/run-complex.ts
```

The single scenario: a fighter (Aragorn) attacking a Goblin, requiring lookups of both character sheet AND monster stats AND applying combat rules in a coherent narrative.

## Results

**Verdict: PARTIAL — quality preserved, wall-clock advantage collapses**

| Setup | State | Wall (ms) | Tool calls | Prefill (ms) | Eval (ms) | Prompt tok | Eval tok | Keywords |
|---|---|---|---|---|---|---|---|---|
| baked | cold | 30,670 | 0 | 378 | 27,006 | 269 | 1,664 | 5/5 |
| baked | warm | **32,788** | 0 | 17 | 32,354 | 269 | 1,985 | 5/5 |
| vault | cold | **17,591** ★ | 3 | 1,255 | 13,212 | 2,269 | 814 | 5/5 |
| vault | warm | **32,437** | 9 | 1,468 | 29,648 | 13,022 | 1,814 | 5/5 |

**Δ wall (warm): -1.1%** (effectively tie — vault's warm advantage from spike 003 vanishes)
**Δ wall (cold): -42.7%** (vault wins cold, opposite of 003's tie result)

### Three big findings

#### Finding 1: The simple-turn warm advantage doesn't generalize

Spike 003 measured -63.1% warm advantage on simple 1-tool turns. On a complex multi-tool turn, the advantage drops to -1.1%. **The big M5 Pro warm win is a simple-turn artifact, not a general property.**

Why: the vault setup re-prefills the growing message history on every roundtrip. Warm turn used **9 tool calls = 13,022 prefill tokens** (vs 269 for baked, which doesn't roundtrip). The 12× larger prefill volume on warm offsets the decode savings.

#### Finding 2: Vault cold is surprisingly the fastest path

17.6s vault cold vs 30.7s baked cold = **-42.7% improvement**, even with model load_duration cost. Vault cold used only 3 tool calls (efficient lookup), output 814 tokens (concise data-grounded answer). Baked cold output 1,664 tokens of narration without external data.

This is the inverse of 003's result. Hypothesis: cold-start vault has no message history bloat, so the prefill stays small, and the decode benefit (concise grounded answer) shows clearly. Warm vault gets contaminated by message-history accumulation.

#### Finding 3: Quality is preserved (5/5 on every variant)

All four configurations produced answers containing the expected keywords (Aragorn, Goblin, AC 15, Nimble Escape). The quality story from spike 003 (vault grounds correctly, baked sometimes hallucinates) doesn't fail on complex turns either. **Quality is robust across the matrix.**

### M4 projection (×2-2.5 bandwidth penalty)

| Setup | State | M5 Pro warm (ms) | Estimated M4 warm (ms) |
|---|---|---|---|
| baked | warm | 32,788 | **~70,000-80,000** (1-1.3 min) |
| vault | warm | 32,437 | **~70,000-80,000** (1-1.3 min) |
| vault | cold | 17,591 | **~38,000-45,000** (40-50 s) |

**All warm complex turns on M4 are > 1 minute.** This is the actual user experience for a multi-action combat round on the production target. Both setups are equally bad. The vault migration does not solve this case.

## Investigation Trail

### Iteration 1 — Initial measurement (1 cold + 1 warm per setup)

Surprising result: vault warm is no faster than baked warm. The simple-turn -63% advantage doesn't transfer.

### Iteration 2 — Why does vault warm have 9 tool calls? (not investigated deeply)

The model loaded the index, the character sheet, the monster sheet — 3-4 reads — but kept reading additional vault paths (probably listing/exploring further). This is the model "wandering" because the warm turn has KV-cache history that biases it toward continuing tool calls rather than committing to a response.

Worth a follow-up spike: does providing explicit "complete the answer after N reads" guidance in the system prompt reduce the warm tool-call count? If we can keep complex-turn vault to 4-5 tool calls instead of 9, the warm number should drop significantly.

### Iteration 3 — Could not run more samples in this round

N=1 per cell means variance isn't characterized. The pattern is clear enough (warm advantage gone) to draw conclusions, but a real production switchover should re-measure with N>=5.

## Decision-grade implications

1. **G1 partial.** Warm simple turns: green (-63%). Warm complex turns: neutral. Production is a mix; expected average net improvement is ~-25% to -35%, **borderline vs the ≥40% gate**. Decision-grade requires M4 measurement AND complex-turn-included scenarios.

2. **Vault cold is a hidden win.** -42.7% cold-improvement, contrary to spike 003. The two findings together suggest cold/warm is not the right axis — *tool-call count* is. Few-tool turns favor vault; many-tool turns are a tie.

3. **The narrative around "vault saves time" must be revised.** It's not a uniform speedup; it's a *quality* improvement (grounded responses) plus a *simple-turn* speedup. Complex turns are neutral on speed.

4. **Tool-call count is the key metric to control.** A vault build should design the tool surface and system prompt to minimize roundtrips per turn. Possible mitigations:
   - **Batch read tool**: `read_vault_multi({paths: [...]})` returns N files in one roundtrip
   - **Smart prefetch**: an `index.md` strategy that brings frequently-needed combat data into the system prompt at session start
   - **Tighter completion bias**: system prompt instruction "after 3 reads, commit to a response unless data is missing"

## Signal for the real build

- **G1 is borderline on complex turns.** Cannot ship the migration on the assumption of uniform -60% wall-clock improvement.
- **Add `read_vault_multi` to the tool surface.** Strongly. Cuts roundtrips from N to 1 for multi-fact lookups.
- **System prompt should explicitly cap "exploratory" reads.** "Look up the specific facts needed for the question; do not browse."
- **Re-measure complex turns on M4** with the new tools before any plan-phase commitment.
- **Quality story is still strong.** Vault preserves accuracy in 5/5 across the matrix. The migration's narrative may need to shift from "faster" to "correct + flexible" for selling internally.

## Limitations of this measurement

- N=1 per cell. The 9-tool-calls warm result could be an outlier; need to re-run.
- One scenario. Different turn shapes (pure-narrative, lookup-heavy, combat-only) may behave differently.
- M5 Pro measurements. M4 numbers will be ~2.5× higher, putting *both* setups beyond the 30s usability threshold on complex turns.
- Did not test with `read_vault_multi` (proposed mitigation). That's the most promising lever and should be a follow-up spike.
