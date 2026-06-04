# Spike 015 — Raw Measurements

Hardware: **Apple M5 Pro, 48GB** (dev machine — NOT the M4 prod target).
Model: `qwen3:30b-a3b-instruct-2507-q4_K_M` (project primary) via Ollama, warm.
graphify: `graphifyy==0.8.31`, backend `ollama` (OpenAI-compat `localhost:11434/v1`).

Decision-grade caveat (CONVENTIONS): wall-clock here is INFORMATIVE only. But the
gap to budget is ~100×, not ~2×, so the verdict is robust to M4-vs-M5 differences.
Spike 004 found M4 ≈ or faster than M5 Pro for this MoE-A3B model, so M5 numbers
are a pessimistic upper bound — M4 would not close a 100× gap.

| Operation | Input tok | Output tok | Wall-clock | Result |
|-----------|-----------|-----------|-----------|--------|
| `extract` full corpus (index.md + events.md, 12 turni), `--no-cluster`, default output cap | 1,798 | 2,981 | **425 s** | 19 nodes / 34 edges, **with duplicates** (Villaggio ×3, Cercatori ×2) — 2-file chunk truncated → split → each half re-created shared nodes |
| `query "..."` BFS on existing graph.json | — | — | **0.159 s** | 6 nodes, no LLM. Cheap read. |
| `extract` single `events.md` (13 turni), `--no-cluster`, `GRAPHIFY_MAX_OUTPUT_TOKENS=6000` | 1,454 | 14,930 | **355 s** | **0 nodes** — runaway invalid JSON, truncated at limit, single file can't bisect → total failure. Ollama ignored the output cap. |

## Turn budget reference (from prior spikes / blueprint)
- Validated warm turn on primary: **3.78 s** (spike 004).
- Phase-1 target: **< 10 s** warm typical turn.

## Ratio
- Per-turn graph re-extraction (355–425 s) is **~94–112× the 3.78 s turn** and **~35–42× the 10 s target**.
- And it is **unreliable**: one of two single-file runs produced 0 usable nodes.

## Gotchas captured
1. **`uv tool install graphifyy` does NOT include the `openai` dep** needed by the ollama backend. Must install `graphifyy[ollama]`. First run failed: `the 'openai' package is required`.
2. **Ollama ignores `max_completion_tokens` / `GRAPHIFY_MAX_OUTPUT_TOKENS`** on the OpenAI-compat path — the 30B model rambled to ~15k tokens. No easy server-side output cap via graphify env.
3. **No incremental write for narrative.** `update` is AST-only (code, no LLM). Narrative requires full semantic re-`extract`. There is no "append one node" API.
4. **Raw extraction duplicates nodes across chunk splits.** Dedup needs clustering (`label`/`cluster-only`) = additional LLM calls = even slower.
5. Extraction prompt is code/citation-oriented (`calls|references|cites|conceptually_related_to`), not narrative-state-oriented.
