This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Local AI: building optimized master models

When using `aiProvider: 'local'` (Ollama-backed master), per-turn latency is dominated by the ~120 KB master system prompt (handbook, world lore, SRD reference, tool contract). Plan D moves all of this **into the model itself** via Ollama's Modelfile `SYSTEM` directive, shrinking the per-request prompt to ~5-15 KB and warm-turn latency from ~50-90 s to ~2-5 s on `qwen3:30b`.

### Run the build

```bash
pnpm build-local-models
```

This script:

1. Reads the current static prompt content (5 prompt constants + full master handbook + full world lore + full SRD context, ~105 KB total).
2. Computes a sha256 content hash + stamps it into the generated Modelfile.
3. Calls `ollama create dnd-master-<base> -f <path>` for **every chat-capable base model installed in Ollama** — excluding existing `dnd-master-*` variants and clearly-non-chat utilities (embeddings, rerankers).
4. Skips bases already up-to-date (hash matches). Use `--force` to rebuild anyway.

Each baked variant carries tuned defaults: `num_ctx 65536` (matches the runtime override; comfortably fits the baked ~28k SYSTEM + ~3k preamble + extensive session history) and per-base temperature overrides for the qwen3 thinking variants. `num_predict` is intentionally NOT baked — observed to interfere with tool-using turns on qwen3 chat templates when set as a Modelfile PARAMETER; the runtime sends a per-call value instead.

Flags: `--base <slug>`, `--force`, `--dry-run`, `--help`.

### Pick the baked variant in Settings

After a successful build, the campaign Settings page shows the new variants grouped under "**Optimized (built locally)**" in the model dropdown — e.g. `qwen3:30b (optimized)`. Pick one and save; subsequent turns use the baked prompt and the runtime request stays tiny.

### When to rebuild

- After editing `data/master_handbook.md`, `data/master_world_lore.md`, or any of the prompt constants in `src/ai/master/system-prompt.ts`.
- After bumping `MASTER_PROMPT_VERSION` in that same file.
- After pulling a new base model (`ollama pull qwen3:32b`) you want to bake.

The runtime auto-detects drift: when the baked variant's hash diverges from the live source, a `[baked-model] ... is stale` warning is logged once per process. Turns keep working, but narration uses the older baked guidance until you rebuild.

### Troubleshooting

- **"Ollama unreachable"** → start Ollama (`ollama serve`) and set `OLLAMA_BASE_URL` (typically `http://localhost:11434`).
- **"base model not found"** → `ollama pull <slug>` first (e.g. `ollama pull qwen3:30b`).
- **Variant works but quality regressed** → check the `[baked-model] stale` warning; rebuild with `pnpm build-local-models --force`.

### Plan E.1 — Mode-aware prompt (local provider)

The local provider can ship a smaller per-turn prompt by loading only
the mode block relevant to the current scene type:

- **combat**: tactical priming, opportunity attacks, concentration check delegation.
- **exploration**: travel pace, vision, marching order, forced march.
- **narrative**: scene framing, social DCs, combat-initiation sub-block.

Plus a conditional **spellcasting overlay** when the active PC is a caster.

Mode is derived deterministically from engine state:
- `state.combat !== null` → combat
- `state.travel?.pace` set → exploration
- else → narrative

Enable via **Settings → Local optimization → "Mode-aware prompt"** (default
ON for local, OFF for cloud). Combine with Plan C "Compact prompt" and
Plan D "Baked models" for ~9K context window (vs ~15K with B+C+D alone).
Full design at
[`docs/superpowers/specs/2026-05-16-mode-aware-rag-prompt-design.md`](docs/superpowers/specs/2026-05-16-mode-aware-rag-prompt-design.md).

After enabling, re-bake your installed models:
```bash
pnpm build-local-models --force
```

The bake uses the new slim manifest (drops world_lore + standalone
roll_triggers, ultra-slim handbook, slim base/tool_contract/rewards/
memory_tool_rule). `MASTER_PROMPT_VERSION` was bumped to 2 — existing
baked models will surface a stale warning until rebuilt.

To validate the optimization, check the telemetry for `prompt_eval_count`
per `(mode, model)` tuple in the `ai_usage` table (new `mode` and
`needs_spellcasting` columns landed in migration `0033_*.sql`).

### Plan E.2 — RAG retrieval (local provider)

In addition to the slim baked manifest and mode-aware prompt (Plan E.1),
the local provider can retrieve relevant chunks from the full handbook +
world lore on demand:

- Embedder: `nomic-embed-text` via Ollama (~80 MB, 768-dim).
- Store: Postgres + pgvector (with in-memory fallback if pgvector is
  unavailable on your host).
- Per-turn: embed the last 2 user messages + last master message, fetch
  top-3 chunks deduped by section_path, inject as a `RELEVANT CONTEXT`
  block between the mode block and the active character.

**One-time setup**:
```bash
ollama pull nomic-embed-text
pnpm db:migrate            # adds the rag_chunks table + pgvector extension
pnpm build-rag-index       # ~10-30s on a warm Ollama
```

If your local Postgres is the bundled docker-compose service, the
`pgvector/pgvector:pg17` image is already wired in and the extension is
pre-installed. Existing pgdata is preserved across the image swap.

**Critical for unified-memory Macs (M-series)**: Ollama defaults to
`OLLAMA_MAX_LOADED_MODELS=1`, so a 20B+ master model holds the only
slot and `nomic-embed-text` can't load → every retrieval call times
out and `rag_chunk_count` is silently 0. Set on the daemon and
restart Ollama:
```bash
launchctl setenv OLLAMA_MAX_LOADED_MODELS 2
launchctl setenv OLLAMA_NUM_PARALLEL 2
killall Ollama && open -a Ollama
```
After restart, the embedder + master coexist (~550 MB + master size).
The embedder is also pinned with `keep_alive=30m` so it doesn't churn
between turns.

**Enable**: Settings → Local optimization → "RAG retrieval on". Phase 2
ships with the toggle default OFF (opt-in); a future Phase 3 cutover
will flip it ON for local provider once recall is validated.

**Manual rebuild**: Settings → Local optimization → "Rebuild RAG index"
button, or via CLI:
```bash
pnpm build-rag-index --force
```

**Validation query** (to confirm RAG is actually returning chunks once
enabled):
```sql
SELECT count(*) FILTER (WHERE rag_chunk_count > 0) * 1.0 / count(*) AS hit_rate
FROM ai_usage WHERE rag_chunk_count IS NOT NULL;
```
Target: ≥0.8 (80% of turns retrieved ≥1 chunk). Below this threshold,
Phase 3 cutover (drop handbook from baked) should not be triggered.
