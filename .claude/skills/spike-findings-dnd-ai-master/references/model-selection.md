# Model Selection

The Mac Mini M4 candidate pool was swept across feasibility (G1 wall-clock + G2 tool compliance) and narrative quality (Italian D&D prose, NPC voicing, choice presentation). One primary, one quality-fallback, one offline-only tool. All other candidates eliminated.

## Requirements

- **Primary model = `qwen3:30b-a3b-instruct-2507-q4_K_M`.** Validated on both feasibility (spike 004) and narrative (spike 014). G1 -85.5% warm on M4, G2 100% lenient, narrative tied with non-q4 at 9 pts.
- **Quality-fallback (opt-in via Settings) = `qwen3:30b-a3b-instruct-2507`.** Within 2.4% wall-clock of primary, marginally stronger NPC voicing and moral-choice dramaturgy.
- **Offline content tool = `mistral-small3.2:24b`.** Failed G2 (80% < 90% gate) so NOT for live turns, but spike 014 confirmed it's the strongest local model for voice-strong non-standard prose (goblin pidgin, draconic, ritual writings). Useful for pre-generating in-game found-text.
- **Eliminated permanently:**
  - `qwen3:30b-a3b` BASE — thinking-native, leaks English chain-of-thought into content stream even with `think:false`.
  - `qwen3:30b-a3b-instruct-2507-q4_K_M` for narrative-only use vs non-q4 — they tie, but feasibility favors q4.
  - `mistral-small3.2:24b-instruct-2506-q4_K_M` — G1 +81.9% slower than baked (regression).
  - `llama3.2:3b` — 0% tool compliance (incapable of the protocol).
- **No tier-split router in Phase 1.** Δ between primary and quality-fallback too small to justify per-turn routing complexity. Re-evaluate post-launch with engagement data.

## How to Build It

### Ollama setup on M4

```bash
# Pull primary + fallback (~36 GB total)
ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
ollama pull qwen3:30b-a3b-instruct-2507

# Pull offline content tool (~14 GB)
ollama pull mistral-small3.2:24b
```

### Model resolution in code

```ts
// src/ai/master/models.ts (Phase 1)

export const PRIMARY_MODEL = "qwen3:30b-a3b-instruct-2507-q4_K_M";
export const QUALITY_FALLBACK_MODEL = "qwen3:30b-a3b-instruct-2507";
export const OFFLINE_CONTENT_MODEL = "mistral-small3.2:24b";

export function resolveModel(userSetting: "auto" | "quality" | "speed"): string {
  switch (userSetting) {
    case "quality": return QUALITY_FALLBACK_MODEL;  // non-q4 variant
    case "speed":   return PRIMARY_MODEL;            // q4_K_M
    case "auto":
    default:        return PRIMARY_MODEL;            // q4_K_M is the default
  }
}
```

### Ollama options for the primary

```ts
const OLLAMA_OPTIONS = {
  temperature: 0.7,
  top_p: 0.9,
  min_p: 0.05,
  repeat_penalty: 1.13,   // critical for qwen3-a3b: prevents verbatim re-narration loop
  num_predict: 2500,
  num_ctx: 16384,         // 7K baked + 3K dynamic + 5K history + cushion
  keep_alive: "30m",
};
```

These values are battle-tested in the existing `scripts/build-local-models.ts` (per-base param overrides) and `src/ai/provider/local.ts`. Bring them forward.

### Offline content tool usage pattern

Mistral runs OUT-OF-BAND, not in the turn loop. Use for content seeding:

```bash
# Generate a goblin diary as static vault content (manually run, then commit)
ollama run mistral-small3.2:24b "Write a goblin diary entry in broken Italian pidgin..."
# Save output to /vault/handbook/found-texts/goblin-diary-001.md
git commit -m "content: add goblin diary 001 (generated with mistral)"
```

The LLM master reads this as just another vault file. Players see "authentic" goblin writing without paying the live tool surface cost of mistral's lower G2 compliance.

## What to Avoid

### ✗ Using qwen3:30b-a3b BASE for ANY direct output (spike 014 iteration 2)

Even with `think: false` passed in the Ollama request body, the model emits English chain-of-thought as the response content:

> "Okay, let's tackle this D&D 5e DM request. The user wants a vivid, cinematic description in Italian..."

The model is thinking-native. The `think: false` flag in Ollama doesn't suppress the model's pre-training pattern; it just stops filtering thinking-tagged tokens out of the stream. Without a separate CoT-extraction pipeline (which is out of scope for dnd-ai-master), this model produces unusable output. Drop entirely from the pool.

### ✗ Mistral as a live-turn model

G2 measured at 80% lenient compliance (below 90% gate). One in five turns, mistral skips the `/tools/index.md` read protocol and either hallucinates tool arguments or skips the tool surface entirely. For *live* turns this is a quality bug. For *offline* content generation, the turn surface doesn't apply — mistral excels there. Keep the separation strict.

### ✗ Adding new candidate models without re-running the sweep

The candidate pool was validated against the actual M4 hardware. A new model (e.g. some future `qwen3:32b` release) MUST be re-tested by running:

```bash
# Compliance (G2)
SPIKE_MODELS=<new-model> pnpm exec tsx .planning/spikes/002-tool-discovery-compliance/run-compliance.ts

# Wall-clock (G1)
VAULT_MODEL=<new-model> pnpm exec tsx .planning/spikes/003-prefill-walltime-savings/run-walltime.ts

# Narrative quality (if it passes G1+G2)
NARRATIVE_MODELS=<new-model> pnpm exec tsx .planning/spikes/014-narrative-quality/run-narrative.ts
```

Don't promote a model into production based on benchmarks or reputation alone. The sweep is what validated the current primary against expectations.

### ✗ Adding `dnd-master-*` baked variants for new models

The migration eliminates baked variants entirely (spike 004 implication). Don't run `pnpm build-local-models` on production M4 for new models — just keep the base Ollama models and let the vault feed knowledge through the tool surface. Frees ~50GB SSD and ~30min of build time per model.

The only baked variant kept is `dnd-master-plus:latest` (= gpt-oss:20b) as the **baseline for regression benchmarking**. Re-running spike 003 against it after any prompt-builder change confirms wall-clock targets still hold.

## Constraints

- **M4 RAM (32GB):** primary q4_K_M model = ~18GB. With Node + Postgres + macOS = ~28GB used. **No headroom for co-loading quality-fallback alongside primary.** Switching between primary and quality-fallback at runtime triggers a model unload + load (~10-15s cold cost). Don't switch per-turn; switch per-session via user setting.
- **M4 SSD (256GB):** primary + fallback + mistral = ~50GB of model storage. macOS + apps + project = ~80GB. Comfortable but don't add more 30B models without freeing space.
- **Italian instruction-following:** `instruct-2507` revision adds reliable Italian compliance (validated by spike 014). Earlier qwen3 instruct revisions may not have the same quality — don't downgrade.
- **`q4_K_M` quantization:** K-means 4-bit. Smaller than default Q4_0, similar perplexity. Validated to NOT degrade narrative quality vs full non-q4 (spike 014 tie). For larger models (70B+), Q4_K_M may show more degradation — re-validate before adoption.

## Origin

Synthesized from spikes: 004 (M4 sweep, feasibility), 014 (M4 sweep, narrative quality)

Source files available in:
- `sources/004-m4-validation/` — feasibility sweep across 5 candidates
- `sources/014-narrative-quality/` — narrative quality sweep across 4 candidates

Companion design docs (read-only references):
- `docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md`
- `docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md`
