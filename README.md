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
3. Calls `ollama create dnd-master-<base> -f <path>` for each installed base in the curated list (`qwen3:14b`, `qwen3:30b`, `qwen3:30b-a3b`, `gpt-oss:20b`).
4. Skips bases already up-to-date (hash matches). Use `--force` to rebuild anyway.

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
