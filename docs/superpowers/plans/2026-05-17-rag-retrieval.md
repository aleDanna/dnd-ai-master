# Plan E.2 — RAG Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pgvector-backed RAG layer that retrieves top-K chunks from `master_handbook.md` and `master_world_lore.md` per turn, and drop `MASTER_WORLD_LORE` from the baked Modelfile manifest once RAG recall is validated. Floor target: ~7-8K context window per turn (vs ~9K with mode-aware alone).

**Architecture:** Index handbook + lore as markdown-aware chunks (H2/H3 split, max 300 tok, overlap 50). Embed via Ollama `nomic-embed-text` (~80 MB, 768-dim). Store in Postgres `rag_chunks` table with `vector(768)` column + ivfflat index. On each turn, embed the concat of last 2 user msgs + last master msg, query top-K=3 with dedupe by `section_path`, inject as a `[RELEVANT CONTEXT]` block into the system prompt (between mode block and active character). Fallback to in-memory `Float32Array` store if pgvector unavailable; fallback to "no RAG" if embedder offline. Phase 3 cutover removes `MASTER_WORLD_LORE` from the baked manifest after telemetry confirms ≥80% turns retrieve ≥1 relevant chunk.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, Postgres + pgvector extension, Ollama (nomic-embed-text), Next.js App Router.

**Base branch:** This plan assumes the worktree is on `feat/local-mode-aware-prompt` (has Plan E.1 + all the fixes from the runtime audit). Do NOT execute against `main` or against `feat/local-meta-tools` directly — both lack Plan E.1 wiring that this plan integrates with.

**Spec:** [docs/superpowers/specs/2026-05-16-mode-aware-rag-prompt-design.md](../specs/2026-05-16-mode-aware-rag-prompt-design.md) (Plan E.2 section in Phasing).

**Pre-requisites (one-time, before Task 1):**
- Install pgvector on the dev Postgres instance: `CREATE EXTENSION IF NOT EXISTS vector;` (if your DB is a managed Postgres without superuser, see Task 1 for fallback path).
- Pull the embedding model: `ollama pull nomic-embed-text` (~80 MB).

---

## File Structure

### Create
- `src/ai/master/rag/types.ts` — shared types: `Chunk`, `RetrievedChunk`, `EmbedderConfig`
- `src/ai/master/rag/embedder.ts` — Ollama `/api/embeddings` wrapper + health check
- `src/ai/master/rag/chunker.ts` — markdown-aware chunking (H2/H3 split, max 300 tok, overlap 50)
- `src/ai/master/rag/store-pgvector.ts` — Postgres-backed vector store (insert + query)
- `src/ai/master/rag/store-memory.ts` — in-memory fallback (`Float32Array` + cosine similarity)
- `src/ai/master/rag/store.ts` — store interface + factory (pgvector with memory fallback)
- `src/ai/master/rag/indexer.ts` — build/refresh index, hash-based invalidation
- `src/ai/master/rag/retriever.ts` — query top-K=3, dedupe by section_path
- `src/ai/master/rag/format.ts` — format retrieved chunks into the `[RELEVANT CONTEXT]` block
- `src/db/schema/rag-chunks.ts` — drizzle table definition
- `drizzle/<next-N>_rag_vector.sql` — auto-generated migration
- `scripts/build-rag-index.ts` — CLI for manual rebuild
- `tests/ai/master/rag/embedder.test.ts`
- `tests/ai/master/rag/chunker.test.ts`
- `tests/ai/master/rag/store-memory.test.ts`
- `tests/ai/master/rag/retriever.test.ts`
- `tests/ai/master/rag/format.test.ts`
- `tests/ai/master/rag/indexer.test.ts`
- `tests/lib/preferences-rag.test.ts`

### Modify
- `src/lib/local-services.ts` — add `embedder` health check (nomic-embed-text reachability)
- `src/db/schema/users.ts` + `src/db/schema/campaigns.ts` — add `useRagRetrieval?: boolean` field
- `src/lib/preferences.ts` — add `resolveUseRagRetrieval` + wire into resolved preferences
- `src/ai/master/system-prompt.ts` — accept optional `ragChunks` input, inject between mode block and active character
- `src/app/api/sessions/[id]/turn/route.ts` — fetch RAG chunks when enabled, pass to builder
- `src/ai/master/usage.ts` — extend telemetry with `ragChunkCount` + `ragChunkBytes`
- `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` — toggle "Use RAG retrieval" + status panel + "Rebuild RAG index" button
- `src/app/api/campaigns/[id]/settings/route.ts` — add `useRagRetrieval` to `ALLOWED_KEYS`
- `scripts/build-local-models.ts` (Task 14, Phase 3 cutover) — drop `MASTER_HANDBOOK_ULTRA_SLIM` + add comment that handbook/lore now live in RAG; bump `MASTER_PROMPT_VERSION`
- `src/ai/master/runtime-prompt-hash.ts` (Task 14) — mirror the new manifest
- `README.md` — add Plan E.2 section

---

## Task 1: pgvector migration + drizzle schema

**Files:**
- Create: `src/db/schema/rag-chunks.ts`
- Create: `drizzle/<next-N>_rag_vector.sql` (auto-generated)
- Modify: `src/db/schema/index.ts` (export new table)
- Test: none for this task — covered indirectly by Task 4 (store-pgvector)

**Pre-flight:** confirm the dev DB has pgvector available:
```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"
```
If this fails with a permission error or "extension not found", you're on a managed Postgres without the extension. Skip the SQL `CREATE EXTENSION` step below and rely purely on the in-memory fallback store (Task 5); pgvector parts of the migration become a no-op. Note this in the commit message.

- [ ] **Step 1: Define the drizzle schema**

Create `src/db/schema/rag-chunks.ts`:

```ts
import { sql } from 'drizzle-orm';
import { pgTable, serial, text, timestamp, customType, index } from 'drizzle-orm/pg-core';

/**
 * Plan E.2 — RAG chunk store backed by pgvector. One row per chunk produced
 * by the markdown chunker (handbook + lore). `embedding` is a 768-dim
 * `vector` produced by Ollama `nomic-embed-text`. `source_hash` is the
 * SHA-256 of the source file at index time so the indexer can detect
 * staleness without re-reading every chunk.
 */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value) {
    if (typeof value !== 'string') return [];
    return value.slice(1, -1).split(',').map(Number);
  },
});

export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),           // 'handbook' | 'lore'
    sectionPath: text('section_path').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 768 }).notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceHashIdx: index('rag_chunks_source_hash_idx').on(t.sourceHash),
  }),
);

export type RagChunkRow = typeof ragChunks.$inferSelect;
export type RagChunkInsert = typeof ragChunks.$inferInsert;
```

(The ivfflat index needs raw SQL because drizzle-kit can't represent vector indexes — we'll add it in the migration SQL by hand in Step 3.)

- [ ] **Step 2: Re-export from the schema barrel**

In `src/db/schema/index.ts`, find the existing exports and add at the bottom:

```ts
export * from './rag-chunks';
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`

This auto-creates `drizzle/<NNNN>_<random-name>.sql` (the number depends on the current state of the drizzle folder). Inspect the generated file. Drizzle-kit will emit `CREATE TABLE rag_chunks (...)` with the `vector(768)` column type because of our customType.

The generated file will NOT include:
1. `CREATE EXTENSION IF NOT EXISTS vector;` (the customType emits the column but not the extension prerequisite)
2. The ivfflat index (drizzle-kit doesn't know about vector indexes)

Manually prepend the extension creation and append the index. Open the generated migration and edit it so it reads:

```sql
-- Plan E.2: RAG vector store. The extension might already exist (idempotent).
-- If your host blocks CREATE EXTENSION, this will fail; in that case the
-- in-memory fallback store is the only path. Remove this line if needed.
CREATE EXTENSION IF NOT EXISTS vector;

-- <whatever drizzle-kit generated — the CREATE TABLE rag_chunks + indexes>

-- ivfflat index for cosine similarity queries. lists=100 is fine for <100k
-- chunks; tune up if the corpus grows.
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

- [ ] **Step 4: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: migration applies cleanly. If `CREATE EXTENSION` fails, note it as DONE_WITH_CONCERNS — the runtime will fall back to in-memory once Task 5 lands.

Verify the table exists:
```bash
psql "$DATABASE_URL" -c "\d rag_chunks"
```

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep -E "rag-chunks|schema/index" || echo "no errors"`

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/rag-chunks.ts src/db/schema/index.ts drizzle/*.sql drizzle/meta/_journal.json drizzle/meta/*.json
git commit -m "feat(rag): pgvector schema + migration for rag_chunks table"
```

---

## Task 2: Shared RAG types

**Files:**
- Create: `src/ai/master/rag/types.ts`

This is a pure types file. No tests needed — it's consumed by every other RAG file.

- [ ] **Step 1: Define the types**

Create `src/ai/master/rag/types.ts`:

```ts
/** Source corpus a chunk originated from. Extend if we ever RAG more files. */
export type ChunkSource = 'handbook' | 'lore';

/** A pre-embedding chunk produced by the chunker. */
export interface Chunk {
  source: ChunkSource;
  /** Heading breadcrumb, e.g. 'Pacing > Combat tempo'. */
  sectionPath: string;
  content: string;
}

/** A chunk plus its embedding vector, ready for the store. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** A chunk returned by a similarity query. */
export interface RetrievedChunk extends Chunk {
  /** Cosine distance, lower = more relevant. */
  distance: number;
}

/** Embedder runtime config. */
export interface EmbedderConfig {
  baseUrl: string;       // e.g. 'http://localhost:11434'
  model: string;         // default 'nomic-embed-text'
  timeoutMs: number;     // default 5000
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep rag/types || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
git add src/ai/master/rag/types.ts
git commit -m "feat(rag): shared types (Chunk, EmbeddedChunk, RetrievedChunk)"
```

---

## Task 3: Embedder (Ollama nomic-embed-text wrapper)

**Files:**
- Create: `src/ai/master/rag/embedder.ts`
- Test: `tests/ai/master/rag/embedder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/embedder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embed, embedBatch, pingEmbedder } from '@/ai/master/rag/embedder';

const config = { baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 5000 };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('embedder', () => {
  it('embed() POSTs to /api/embeddings and returns the vector', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: new Array(768).fill(0.5) }),
    });
    const v = await embed('hello world', config);
    expect(v).toHaveLength(768);
    expect(v[0]).toBe(0.5);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://localhost:11434/api/embeddings');
    const body = JSON.parse(call[1]!.body as string);
    expect(body).toEqual({ model: 'nomic-embed-text', prompt: 'hello world' });
  });

  it('embedBatch() embeds inputs sequentially and returns vectors in order', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [1, 0, 0] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0, 1, 0] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0, 0, 1] }) });
    const vs = await embedBatch(['a', 'b', 'c'], config);
    expect(vs).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('embed() throws on non-OK HTTP response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(embed('x', config)).rejects.toThrow(/embedder.*500.*boom/i);
  });

  it('pingEmbedder() returns true when /api/embeddings responds successfully', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0] }) });
    expect(await pingEmbedder(config)).toBe(true);
  });

  it('pingEmbedder() returns false on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await pingEmbedder(config)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/embedder.test.ts`
Expected: FAIL ("Cannot find module '@/ai/master/rag/embedder'")

- [ ] **Step 3: Implement the embedder**

Create `src/ai/master/rag/embedder.ts`:

```ts
import type { EmbedderConfig } from './types';

export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  model: process.env.OLLAMA_EMBEDDER_MODEL ?? 'nomic-embed-text',
  timeoutMs: Number(process.env.OLLAMA_EMBEDDER_TIMEOUT_MS ?? '5000'),
};

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Embed a single text via Ollama. Throws on HTTP error or network failure
 * — callers decide whether to retry, fall back, or surface to the user.
 */
export async function embed(text: string, config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<number[]> {
  const res = await fetch(`${config.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: text }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedder HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as OllamaEmbeddingResponse;
  return json.embedding;
}

/**
 * Embed a batch sequentially. We do NOT parallelise because Ollama
 * serialises model calls anyway and concurrent requests just queue up
 * with worse latency. Sequential keeps the contract predictable.
 */
export async function embedBatch(texts: string[], config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {
    out.push(await embed(t, config));
  }
  return out;
}

/**
 * Health check — returns true if the embedder is reachable and produces
 * a non-empty vector. Used by the local-services status panel to surface
 * "Embedder: ✓/✗" in Settings.
 */
export async function pingEmbedder(config: EmbedderConfig = DEFAULT_EMBEDDER_CONFIG): Promise<boolean> {
  try {
    const v = await embed('ping', config);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/embedder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/embedder.ts tests/ai/master/rag/embedder.test.ts
git commit -m "feat(rag): Ollama nomic-embed-text embedder + ping"
```

---

## Task 4: Markdown chunker

**Files:**
- Create: `src/ai/master/rag/chunker.ts`
- Test: `tests/ai/master/rag/chunker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/chunker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '@/ai/master/rag/chunker';

describe('chunkMarkdown', () => {
  it('splits on H2 headings and preserves the heading in the chunk', () => {
    const md = '# Title\n\n## Section A\n\nLorem ipsum.\n\n## Section B\n\nDolor sit.';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionPath).toBe('Section A');
    expect(chunks[0]!.content).toContain('Lorem ipsum.');
    expect(chunks[1]!.sectionPath).toBe('Section B');
    expect(chunks[1]!.content).toContain('Dolor sit.');
  });

  it('splits on H3 within an H2 and concatenates the path', () => {
    const md = '## Section A\n\n### Sub 1\n\none\n\n### Sub 2\n\ntwo';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sectionPath).toBe('Section A > Sub 1');
    expect(chunks[1]!.sectionPath).toBe('Section A > Sub 2');
  });

  it('splits oversize sections into multiple chunks honoring maxTokens (chars/4)', () => {
    const big = 'word '.repeat(2000); // ~10000 chars ~ 2500 tokens
    const md = `## Big\n\n${big}`;
    const chunks = chunkMarkdown('handbook', md, { maxTokens: 300, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1300); // 300 tokens * 4 chars + slack
      expect(c.sectionPath).toBe('Big');
      expect(c.source).toBe('handbook');
    }
  });

  it('applies token overlap between consecutive splits within the same section', () => {
    const text = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z';
    const md = `## S\n\n${text}`;
    const chunks = chunkMarkdown('lore', md, { maxTokens: 5, overlapTokens: 2 });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]!.content.split(/\s+/);
    const second = chunks[1]!.content.split(/\s+/);
    // last 2 words of chunk 0 must appear at the start of chunk 1
    const overlap = first.slice(-2);
    expect(second.slice(0, 2)).toEqual(overlap);
  });

  it('skips empty sections', () => {
    const md = '## A\n\n\n\n## B\n\nreal content';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toBe('B');
  });

  it('handles documents with no headings as a single chunk', () => {
    const md = 'Just some prose without any heading.';
    const chunks = chunkMarkdown('lore', md, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toBe('(root)');
    expect(chunks[0]!.content).toContain('Just some prose');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/chunker.test.ts`
Expected: FAIL ("Cannot find module '@/ai/master/rag/chunker'")

- [ ] **Step 3: Implement the chunker**

Create `src/ai/master/rag/chunker.ts`:

```ts
import type { Chunk, ChunkSource } from './types';

export interface ChunkerOptions {
  /** Max tokens per chunk (chars/4 heuristic). */
  maxTokens: number;
  /** Tokens of overlap when a section exceeds maxTokens and must split. */
  overlapTokens: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  maxTokens: 300,
  overlapTokens: 50,
};

interface Section {
  path: string;
  body: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split markdown into sections at H2 and H3 boundaries. Headings deeper
 * than H3 stay inline in the body — chunking only at top-level structure
 * keeps the path readable and the chunks self-contained.
 */
function splitIntoSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let h2: string | null = null;
  let h3: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (!body) {
      buffer = [];
      return;
    }
    const path = h2 && h3 ? `${h2} > ${h3}` : h2 ?? '(root)';
    sections.push({ path, body });
    buffer = [];
  };

  for (const line of lines) {
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    const h3Match = /^###\s+(.+?)\s*$/.exec(line);
    if (h2Match) {
      flush();
      h2 = h2Match[1]!;
      h3 = null;
      continue;
    }
    if (h3Match) {
      flush();
      h3 = h3Match[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * Split a single section's body into sub-chunks if it exceeds maxTokens.
 * We split on whitespace boundaries to avoid mid-word cuts; overlap is
 * applied by carrying the last `overlapTokens` tokens forward.
 */
function splitOversize(body: string, opts: ChunkerOptions): string[] {
  if (approxTokens(body) <= opts.maxTokens) return [body];
  const words = body.split(/\s+/);
  const wordsPerChunk = opts.maxTokens; // ~1 word ≈ 1 token for English/Italian mix
  const overlap = Math.min(opts.overlapTokens, wordsPerChunk - 1);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk - overlap) {
    const slice = words.slice(i, i + wordsPerChunk).join(' ');
    if (slice.trim()) out.push(slice);
    if (i + wordsPerChunk >= words.length) break;
  }
  return out;
}

/**
 * Public entry. Produces a flat list of chunks ready for embedding.
 */
export function chunkMarkdown(
  source: ChunkSource,
  markdown: string,
  opts: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS,
): Chunk[] {
  const sections = splitIntoSections(markdown);
  const out: Chunk[] = [];
  for (const s of sections) {
    const parts = splitOversize(s.body, opts);
    for (const p of parts) {
      out.push({ source, sectionPath: s.path, content: p });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/chunker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/chunker.ts tests/ai/master/rag/chunker.test.ts
git commit -m "feat(rag): markdown-aware chunker (H2/H3 split, oversize handling, overlap)"
```

---

## Task 5: In-memory fallback store

**Files:**
- Create: `src/ai/master/rag/store-memory.ts`
- Test: `tests/ai/master/rag/store-memory.test.ts`

This is the fallback store used when pgvector is unavailable. It also serves as a reference impl for the store interface.

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/store-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '@/ai/master/rag/store-memory';

const chunkA = { source: 'lore' as const, sectionPath: 'A', content: 'apple banana', embedding: [1, 0, 0] };
const chunkB = { source: 'lore' as const, sectionPath: 'B', content: 'carrot dragonfruit', embedding: [0, 1, 0] };
const chunkC = { source: 'lore' as const, sectionPath: 'C', content: 'eggplant fig', embedding: [0, 0, 1] };

describe('memory store', () => {
  it('returns nearest by cosine distance', async () => {
    const s = createMemoryStore();
    await s.replaceAll('hash-1', [chunkA, chunkB, chunkC]);
    const r = await s.query([1, 0.1, 0], 2);
    expect(r).toHaveLength(2);
    expect(r[0]!.sectionPath).toBe('A');
  });

  it('empty store returns empty array', async () => {
    const s = createMemoryStore();
    const r = await s.query([1, 0, 0], 3);
    expect(r).toEqual([]);
  });

  it('replaceAll() wipes previous content', async () => {
    const s = createMemoryStore();
    await s.replaceAll('h1', [chunkA, chunkB]);
    await s.replaceAll('h2', [chunkC]);
    const r = await s.query([0, 0, 1], 3);
    expect(r).toHaveLength(1);
    expect(r[0]!.sectionPath).toBe('C');
  });

  it('currentHash() returns the hash set by replaceAll', async () => {
    const s = createMemoryStore();
    expect(await s.currentHash()).toBeNull();
    await s.replaceAll('abc123', [chunkA]);
    expect(await s.currentHash()).toBe('abc123');
  });

  it('attaches distance to results (lower = more relevant)', async () => {
    const s = createMemoryStore();
    await s.replaceAll('h', [chunkA, chunkB]);
    const r = await s.query([1, 0, 0], 2);
    expect(r[0]!.distance).toBeLessThan(r[1]!.distance);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/store-memory.test.ts`
Expected: FAIL ("Cannot find module '@/ai/master/rag/store-memory'")

- [ ] **Step 3: Implement the memory store**

Create `src/ai/master/rag/store-memory.ts`:

```ts
import type { Chunk, EmbeddedChunk, RetrievedChunk } from './types';

/**
 * Common interface every store must implement. pgvector and memory
 * both honor this so the retriever doesn't care which is active.
 */
export interface RagStore {
  /** Replace the entire store contents with a new index. Atomic per call. */
  replaceAll(sourceHash: string, chunks: EmbeddedChunk[]): Promise<void>;
  /** Top-K nearest chunks by cosine distance. */
  query(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]>;
  /** The hash of the index currently held, or null if empty. */
  currentHash(): Promise<string | null>;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s);
}

/** Cosine DISTANCE: 1 - cosine similarity. Range [0, 2], lower = closer. */
function cosineDistance(a: number[], b: number[]): number {
  const denom = norm(a) * norm(b);
  if (denom === 0) return 1;
  return 1 - dot(a, b) / denom;
}

/**
 * Lazy in-process store. Loses data on restart, which is fine: the
 * indexer rebuilds at boot when no pgvector is available. Cost is
 * ~10-30s for ~250 chunks on a warm Ollama instance.
 */
export function createMemoryStore(): RagStore {
  let chunks: EmbeddedChunk[] = [];
  let hash: string | null = null;
  return {
    async replaceAll(sourceHash, next) {
      chunks = next.slice();
      hash = sourceHash;
    },
    async query(q, k) {
      if (chunks.length === 0) return [];
      const scored = chunks.map<RetrievedChunk>((c) => ({
        source: c.source,
        sectionPath: c.sectionPath,
        content: c.content,
        distance: cosineDistance(q, c.embedding),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, k);
    },
    async currentHash() {
      return hash;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/store-memory.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/store-memory.ts tests/ai/master/rag/store-memory.test.ts
git commit -m "feat(rag): in-memory fallback store (cosine distance, replaceAll, currentHash)"
```

---

## Task 6: pgvector-backed store

**Files:**
- Create: `src/ai/master/rag/store-pgvector.ts`

This integrates with the real DB; a unit test would need mocks for every Drizzle method. We skip a dedicated test file and rely on the integration test in Task 13. The interface is identical to the memory store so the retriever uses them interchangeably.

- [ ] **Step 1: Implement the pgvector store**

Create `src/ai/master/rag/store-pgvector.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ragChunks } from '@/db/schema/rag-chunks';
import type { EmbeddedChunk, RetrievedChunk } from './types';
import type { RagStore } from './store-memory';

/**
 * Postgres-backed store. The single-row replacement strategy (DELETE+INSERT
 * in a transaction) is fine for our corpus size (~250-500 chunks); a more
 * granular upsert would be premature optimisation.
 */
export function createPgvectorStore(): RagStore {
  return {
    async replaceAll(sourceHash, next) {
      await db.transaction(async (tx) => {
        await tx.delete(ragChunks);
        if (next.length === 0) return;
        // Insert in batches of 100 to keep the parameter count under
        // Postgres' default 65535 limit (each row uses ~6 params).
        const BATCH = 100;
        for (let i = 0; i < next.length; i += BATCH) {
          const slice = next.slice(i, i + BATCH).map((c) => ({
            source: c.source,
            sectionPath: c.sectionPath,
            content: c.content,
            embedding: c.embedding,
            sourceHash,
          }));
          await tx.insert(ragChunks).values(slice);
        }
      });
    },
    async query(queryEmbedding, k) {
      // pgvector's `<=>` operator returns cosine distance when the column
      // uses vector_cosine_ops. We pass the array as a literal and bind k.
      const vec = `[${queryEmbedding.join(',')}]`;
      const rows = await db.execute<{
        source: string;
        section_path: string;
        content: string;
        distance: number;
      }>(sql`
        SELECT source, section_path, content,
               embedding <=> ${vec}::vector AS distance
        FROM rag_chunks
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${k}
      `);
      return rows.rows.map<RetrievedChunk>((r) => ({
        source: r.source as 'handbook' | 'lore',
        sectionPath: r.section_path,
        content: r.content,
        distance: Number(r.distance),
      }));
    },
    async currentHash() {
      const rows = await db.execute<{ source_hash: string }>(sql`
        SELECT source_hash FROM rag_chunks LIMIT 1
      `);
      return rows.rows[0]?.source_hash ?? null;
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep store-pgvector || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
git add src/ai/master/rag/store-pgvector.ts
git commit -m "feat(rag): pgvector-backed store (DELETE+INSERT in tx, cosine query)"
```

---

## Task 7: Store factory with fallback selection

**Files:**
- Create: `src/ai/master/rag/store.ts`

The factory probes pgvector once on startup and caches the choice. If pgvector is unavailable, the memory store is returned and a warning logs.

- [ ] **Step 1: Implement the factory**

Create `src/ai/master/rag/store.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { createMemoryStore, type RagStore } from './store-memory';
import { createPgvectorStore } from './store-pgvector';

let cached: { store: RagStore; backend: 'pgvector' | 'memory' } | null = null;

/**
 * Probe pgvector availability. Cached per-process — the first call
 * runs a tiny query, subsequent calls return the cached store.
 *
 * If pgvector is missing OR the rag_chunks table is missing (i.e. the
 * migration never ran on this DB), fall back to in-memory. The caller
 * will see the same RagStore interface either way.
 */
export async function getRagStore(): Promise<{ store: RagStore; backend: 'pgvector' | 'memory' }> {
  if (cached) return cached;
  try {
    await db.execute(sql`SELECT 1 FROM rag_chunks LIMIT 0`);
    cached = { store: createPgvectorStore(), backend: 'pgvector' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn('[rag] pgvector unavailable, falling back to in-memory store:', msg);
    cached = { store: createMemoryStore(), backend: 'memory' };
  }
  return cached;
}

/** Reset cache — only useful in tests. */
export function _resetRagStoreForTests(): void {
  cached = null;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep rag/store || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
git add src/ai/master/rag/store.ts
git commit -m "feat(rag): store factory with pgvector probe + memory fallback"
```

---

## Task 8: Retriever (top-K query + dedupe)

**Files:**
- Create: `src/ai/master/rag/retriever.ts`
- Test: `tests/ai/master/rag/retriever.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/retriever.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { retrieveRelevant } from '@/ai/master/rag/retriever';
import type { RagStore } from '@/ai/master/rag/store-memory';
import type { RetrievedChunk } from '@/ai/master/rag/types';

function mockStore(chunks: RetrievedChunk[]): RagStore {
  return {
    replaceAll: vi.fn(),
    currentHash: vi.fn().mockResolvedValue('h'),
    query: vi.fn().mockResolvedValue(chunks),
  };
}

const embedderOk = vi.fn().mockResolvedValue([1, 0, 0]);
const embedderDown = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

describe('retrieveRelevant', () => {
  it('returns top-K chunks from the store, deduped by sectionPath', async () => {
    const store = mockStore([
      { source: 'lore', sectionPath: 'A', content: 'a1', distance: 0.1 },
      { source: 'lore', sectionPath: 'A', content: 'a2', distance: 0.2 },
      { source: 'lore', sectionPath: 'B', content: 'b',  distance: 0.3 },
      { source: 'lore', sectionPath: 'C', content: 'c',  distance: 0.4 },
    ]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderOk, k: 3 });
    expect(r.map((c) => c.sectionPath)).toEqual(['A', 'B', 'C']);
  });

  it('returns empty list (gracefully) when embedder throws', async () => {
    const store = mockStore([]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderDown, k: 3 });
    expect(r).toEqual([]);
  });

  it('returns empty list when store has no chunks', async () => {
    const store = mockStore([]);
    const r = await retrieveRelevant({ query: 'q', store, embedFn: embedderOk, k: 3 });
    expect(r).toEqual([]);
  });

  it('returns empty list when query string is empty', async () => {
    const store = mockStore([{ source: 'lore', sectionPath: 'A', content: 'a', distance: 0 }]);
    const r = await retrieveRelevant({ query: '', store, embedFn: embedderOk, k: 3 });
    expect(r).toEqual([]);
    expect(embedderOk).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/retriever.test.ts`
Expected: FAIL ("Cannot find module '@/ai/master/rag/retriever'")

- [ ] **Step 3: Implement the retriever**

Create `src/ai/master/rag/retriever.ts`:

```ts
import type { RetrievedChunk } from './types';
import type { RagStore } from './store-memory';

export interface RetrieveOptions {
  query: string;
  store: RagStore;
  embedFn: (text: string) => Promise<number[]>;
  /** How many chunks to return after dedupe. */
  k: number;
}

/**
 * Embed the query, fetch a slightly-larger nearest neighbour set than
 * needed (k*2), then dedupe by sectionPath so the final K chunks come
 * from K different sections — avoids returning three slices of the
 * same H2 when the source is densely related.
 *
 * Failures (embedder down, empty query, empty store) return [] so the
 * caller can fall through to "no RAG block" without ceremony.
 */
export async function retrieveRelevant(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const q = opts.query.trim();
  if (!q) return [];
  let queryVec: number[];
  try {
    queryVec = await opts.embedFn(q);
  } catch {
    return [];
  }
  const raw = await opts.store.query(queryVec, opts.k * 2);
  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const c of raw) {
    if (seen.has(c.sectionPath)) continue;
    seen.add(c.sectionPath);
    out.push(c);
    if (out.length >= opts.k) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/retriever.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/retriever.ts tests/ai/master/rag/retriever.test.ts
git commit -m "feat(rag): retriever (embed query, top-K with section dedupe, graceful failures)"
```

---

## Task 9: Format retrieved chunks into a prompt block

**Files:**
- Create: `src/ai/master/rag/format.ts`
- Test: `tests/ai/master/rag/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatRagBlock } from '@/ai/master/rag/format';

describe('formatRagBlock', () => {
  it('produces a labelled block with each chunk grouped by source/path', () => {
    const block = formatRagBlock([
      { source: 'handbook', sectionPath: 'Pacing > Combat tempo', content: 'tempo content', distance: 0.1 },
      { source: 'lore', sectionPath: 'Magic Systems > Divine magic', content: 'divine content', distance: 0.2 },
    ]);
    expect(block).toMatch(/RELEVANT CONTEXT/);
    expect(block).toMatch(/handbook > Pacing > Combat tempo/);
    expect(block).toMatch(/tempo content/);
    expect(block).toMatch(/lore > Magic Systems > Divine magic/);
    expect(block).toMatch(/divine content/);
  });

  it('returns empty string when given no chunks', () => {
    expect(formatRagBlock([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/format.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the formatter**

Create `src/ai/master/rag/format.ts`:

```ts
import type { RetrievedChunk } from './types';

/**
 * Render retrieved chunks as a single system-prompt block. The header is
 * deliberately verbose ("relevant", "use as reference") so the model
 * understands these aren't gospel — they're best-effort retrievals that
 * may or may not be on-topic.
 */
export function formatRagBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const body = chunks
    .map((c) => `### ${c.source} > ${c.sectionPath}\n${c.content}`)
    .join('\n\n');
  return `## RELEVANT CONTEXT (handbook + lore excerpts, use as reference if applicable)\n\n${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/format.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/format.ts tests/ai/master/rag/format.test.ts
git commit -m "feat(rag): format retrieved chunks into RELEVANT CONTEXT block"
```

---

## Task 10: Indexer (build + hash-based refresh)

**Files:**
- Create: `src/ai/master/rag/indexer.ts`
- Test: `tests/ai/master/rag/indexer.test.ts`

The indexer reads `master_handbook.md` + `master_world_lore.md`, chunks them, embeds them, and writes them to the store. It computes a SHA over the source content + chunker options so re-runs are cheap when nothing changed.

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/rag/indexer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { rebuildIndex, computeCorpusHash } from '@/ai/master/rag/indexer';
import { createMemoryStore } from '@/ai/master/rag/store-memory';

const handbookMd = '## A\n\napple banana cherry';
const loreMd = '## B\n\ndragon elf fairy';

describe('indexer', () => {
  it('computeCorpusHash() is stable and changes when input changes', () => {
    const h1 = computeCorpusHash(handbookMd, loreMd);
    const h2 = computeCorpusHash(handbookMd, loreMd);
    expect(h1).toBe(h2);
    const h3 = computeCorpusHash(handbookMd + ' changed', loreMd);
    expect(h3).not.toBe(h1);
  });

  it('rebuildIndex() loads handbook + lore, chunks, embeds, writes to store', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn(async (text: string) => Array.from({ length: 3 }, (_, i) => text.charCodeAt(i) || 0));
    await rebuildIndex({
      handbookMd,
      loreMd,
      store,
      embedFn,
    });
    expect(embedFn).toHaveBeenCalled();
    expect(await store.currentHash()).toBe(computeCorpusHash(handbookMd, loreMd));
    const r = await store.query([1, 0, 0], 10);
    expect(r.length).toBeGreaterThan(0);
  });

  it('rebuildIndex() is a no-op when hash matches the store', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);
    // Pre-seed the hash
    await store.replaceAll(computeCorpusHash(handbookMd, loreMd), [
      { source: 'lore', sectionPath: 'X', content: 'x', embedding: [1, 0, 0] },
    ]);
    embedFn.mockClear();
    const result = await rebuildIndex({ handbookMd, loreMd, store, embedFn });
    expect(result.skipped).toBe(true);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('rebuildIndex() force=true re-indexes even when hash matches', async () => {
    const store = createMemoryStore();
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);
    await store.replaceAll(computeCorpusHash(handbookMd, loreMd), []);
    await rebuildIndex({ handbookMd, loreMd, store, embedFn, force: true });
    expect(embedFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/rag/indexer.test.ts`
Expected: FAIL ("Cannot find module '@/ai/master/rag/indexer'")

- [ ] **Step 3: Implement the indexer**

Create `src/ai/master/rag/indexer.ts`:

```ts
import { createHash } from 'node:crypto';
import { chunkMarkdown, DEFAULT_CHUNKER_OPTIONS } from './chunker';
import type { Chunk, EmbeddedChunk } from './types';
import type { RagStore } from './store-memory';

const HASH_VERSION = 'v1'; // bump if chunker options change to invalidate caches

export function computeCorpusHash(handbookMd: string, loreMd: string): string {
  const h = createHash('sha256');
  h.update(HASH_VERSION);
  h.update(' handbook ');
  h.update(handbookMd);
  h.update(' lore ');
  h.update(loreMd);
  h.update(' opts ');
  h.update(JSON.stringify(DEFAULT_CHUNKER_OPTIONS));
  return h.digest('hex');
}

export interface RebuildInput {
  handbookMd: string;
  loreMd: string;
  store: RagStore;
  embedFn: (text: string) => Promise<number[]>;
  /** When true, re-embed even if the hash matches the store. */
  force?: boolean;
}

export interface RebuildResult {
  chunkCount: number;
  hash: string;
  skipped: boolean;
}

export async function rebuildIndex(input: RebuildInput): Promise<RebuildResult> {
  const hash = computeCorpusHash(input.handbookMd, input.loreMd);
  const existing = await input.store.currentHash();
  if (!input.force && existing === hash) {
    return { chunkCount: 0, hash, skipped: true };
  }
  const handbookChunks = chunkMarkdown('handbook', input.handbookMd);
  const loreChunks = chunkMarkdown('lore', input.loreMd);
  const allChunks: Chunk[] = [...handbookChunks, ...loreChunks];
  const embedded: EmbeddedChunk[] = [];
  for (const c of allChunks) {
    const embedding = await input.embedFn(`${c.sectionPath}\n\n${c.content}`);
    embedded.push({ ...c, embedding });
  }
  await input.store.replaceAll(hash, embedded);
  return { chunkCount: embedded.length, hash, skipped: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/rag/indexer.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/rag/indexer.ts tests/ai/master/rag/indexer.test.ts
git commit -m "feat(rag): indexer with hash-based skip + force rebuild"
```

---

## Task 11: Build script CLI (manual rebuild)

**Files:**
- Create: `scripts/build-rag-index.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Implement the CLI script**

Create `scripts/build-rag-index.ts`:

```ts
/**
 * Plan E.2 — Rebuild the RAG index from the on-disk handbook + lore.
 *
 * Usage:
 *   pnpm build-rag-index               # idempotent (skips if hash matches)
 *   pnpm build-rag-index --force       # rebuild even if up-to-date
 *
 * Requires:
 *   - Ollama running with `nomic-embed-text` pulled.
 *   - Postgres with pgvector (or accepts the in-memory fallback warning).
 */

import { loadDbEnv } from '../src/db/connection-url';
loadDbEnv();

import { getMasterHandbook, getMasterWorldLore } from '../src/ai/master/handbook';
import { rebuildIndex } from '../src/ai/master/rag/indexer';
import { getRagStore } from '../src/ai/master/rag/store';
import { embed, DEFAULT_EMBEDDER_CONFIG } from '../src/ai/master/rag/embedder';

interface Args { force: boolean; help: boolean; }

function parseArgs(argv: string[]): Args {
  const out: Args = { force: false, help: false };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`pnpm build-rag-index

Rebuild the RAG index from master_handbook.md + master_world_lore.md.

Options:
  --force         Re-embed even if the corpus hash matches.
  --help, -h      Print this help and exit.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('[rag-index] reading handbook + lore...');
  // getMasterHandbook/getMasterWorldLore default to FULL (non-compact) which
  // is what we want for RAG — we index the long-form so retrieved chunks
  // carry the most context.
  const handbookMd = getMasterHandbook();
  const loreMd = getMasterWorldLore();

  console.log('[rag-index] resolving store...');
  const { store, backend } = await getRagStore();
  console.log(`[rag-index] backend = ${backend}`);

  console.log(`[rag-index] embedder = ${DEFAULT_EMBEDDER_CONFIG.model} @ ${DEFAULT_EMBEDDER_CONFIG.baseUrl}`);

  const result = await rebuildIndex({
    handbookMd,
    loreMd,
    store,
    embedFn: (t) => embed(t),
    force: args.force,
  });

  if (result.skipped) {
    console.log(`[rag-index] up-to-date (hash=${result.hash.slice(0, 12)}). No work to do.`);
  } else {
    console.log(`[rag-index] indexed ${result.chunkCount} chunks (hash=${result.hash.slice(0, 12)}).`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[rag-index] fatal:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm script**

In `package.json`, find the `"scripts"` block and add (after `"build-local-models"` if present):

```json
"build-rag-index": "tsx scripts/build-rag-index.ts",
```

(Use `tsx` if other scripts use it; if they use `ts-node` or something else, mirror that.)

- [ ] **Step 3: Dry-run the CLI to validate it loads**

Run: `pnpm build-rag-index --help`
Expected: prints the help text and exits 0.

If your dev env has Ollama running with `nomic-embed-text` pulled AND the migration applied, also try:
```
pnpm build-rag-index
```
Expected (first run): `[rag-index] indexed <N> chunks (hash=...)`.
Expected (second run): `[rag-index] up-to-date (hash=...)`.

If Ollama or pgvector are unavailable, the script either errors out clearly or logs the fallback warning. Note the outcome but don't block on this — it's an operational concern.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-rag-index.ts package.json
git commit -m "feat(rag): build-rag-index CLI for manual + first-boot indexing"
```

---

## Task 12: Embedder health check in local-services

**Files:**
- Modify: `src/lib/local-services.ts`

- [ ] **Step 1: Add the health check**

Read `src/lib/local-services.ts` to locate the existing health-check section. Typical pattern: there's a `fetchLocalServicesStatus()` function that pings each backing service in parallel and returns a status object.

Find that function and add the embedder ping alongside the existing Ollama/Piper/etc. pings. The new piece looks like:

```ts
import { pingEmbedder } from '@/ai/master/rag/embedder';

// ... inside fetchLocalServicesStatus, alongside other Promise.all entries:
const embedderReachable = await pingEmbedder().catch(() => false);

// ... add to the returned object:
embedder: { reachable: embedderReachable },
```

If the status type is `LocalServicesStatus` (defined in the same file), extend it:

```ts
export interface LocalServicesStatus {
  // ... existing fields ...
  embedder: { reachable: boolean };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep local-services || echo "no errors"`

- [ ] **Step 3: Commit**

```bash
git add src/lib/local-services.ts
git commit -m "feat(rag): embedder ping in local-services status panel"
```

---

## Task 13: `useRagRetrieval` preference field

**Files:**
- Modify: `src/db/schema/users.ts` (mirror `compactPrompt` / `useModeAwarePrompt`)
- Modify: `src/db/schema/campaigns.ts` (mirror same)
- Modify: `src/lib/preferences.ts`
- Test: `tests/lib/preferences-rag.test.ts`

Same JSONB pattern as Plan E.1 Task 8 — no SQL migration needed.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/preferences-rag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveUseRagRetrieval } from '@/lib/preferences';

describe('resolveUseRagRetrieval', () => {
  it('returns true when explicitly true', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: true })).toBe(true);
  });

  it('returns false when explicitly false', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: false })).toBe(false);
  });

  it('defaults to false when undefined (Phase 2 — opt-in until Phase 3 flips it)', () => {
    expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: undefined })).toBe(false);
    expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: undefined })).toBe(false);
  });
});
```

Note: the default is FALSE in Phase 2. Task 16 (Phase 3 cutover) flips it to default-ON for local once retrieval is validated.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/preferences-rag.test.ts`
Expected: FAIL ("resolveUseRagRetrieval is not exported")

- [ ] **Step 3: Add the field + resolver**

In `src/lib/preferences.ts`:

Find the `UserPreferences` type (or interface) and add the field next to `useModeAwarePrompt`:
```ts
useRagRetrieval?: boolean;
```

If there's a `CampaignSettings` type in the same file (or imported), add the field there too.

Append the resolver:
```ts
/**
 * Plan E.2 — opt-in RAG retrieval. Default OFF in Phase 2 until telemetry
 * confirms recall is acceptable; Phase 3 flips the default to ON for local.
 */
export function resolveUseRagRetrieval(prefs: {
  aiProvider: string;
  useRagRetrieval?: boolean;
}): boolean {
  if (typeof prefs.useRagRetrieval === 'boolean') return prefs.useRagRetrieval;
  return false;
}
```

If `getResolvedPreferences` / `getCampaignSettings` apply the resolver before returning (as they do for `useModeAwarePrompt`), wire the new resolver in the same way.

- [ ] **Step 4: Add to both schemas**

In `src/db/schema/users.ts`, find the JSONB preferences field (or whatever holds `compactPrompt`) and update the inline `UserPreferences` type to include `useRagRetrieval?: boolean`.

Same for `src/db/schema/campaigns.ts`.

(No SQL migration needed — these are JSONB fields.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/preferences-rag.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/preferences.ts src/db/schema/users.ts src/db/schema/campaigns.ts tests/lib/preferences-rag.test.ts
git commit -m "feat(rag): useRagRetrieval preference field + resolver (default OFF in Phase 2)"
```

---

## Task 14: Wire RAG chunks into the system prompt

**Files:**
- Modify: `src/ai/master/system-prompt.ts`
- Test: extend `tests/ai/master/system-prompt.mode.test.ts`

- [ ] **Step 1: Extend the failing test**

Append to `tests/ai/master/system-prompt.mode.test.ts`:

```ts
describe('buildMasterSystemPrompt — RAG chunks', () => {
  it('injects RELEVANT CONTEXT block when ragChunks is non-empty', () => {
    const { system } = buildMasterSystemPrompt(baseInput({
      mode: 'narrative',
      ragChunks: [
        { source: 'handbook' as const, sectionPath: 'Pacing', content: 'pace tight', distance: 0.1 },
      ],
    }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/RELEVANT CONTEXT/);
    expect(text).toMatch(/handbook > Pacing/);
    expect(text).toMatch(/pace tight/);
  });

  it('does NOT inject RELEVANT CONTEXT block when ragChunks is undefined or empty', () => {
    const noField = buildMasterSystemPrompt(baseInput({ mode: 'narrative' }));
    const empty = buildMasterSystemPrompt(baseInput({ mode: 'narrative', ragChunks: [] }));
    expect(noField.system.map((b) => b.text).join('\n')).not.toMatch(/RELEVANT CONTEXT/);
    expect(empty.system.map((b) => b.text).join('\n')).not.toMatch(/RELEVANT CONTEXT/);
  });

  it('RAG block appears between mode block and active character (cache stability)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({
      mode: 'combat',
      ragChunks: [{ source: 'lore' as const, sectionPath: 'S', content: 'x', distance: 0.1 }],
    }));
    const texts = system.map((b) => b.text);
    const modeIdx = texts.findIndex((t) => t.includes('MODE: COMBAT'));
    const ragIdx = texts.findIndex((t) => t.includes('RELEVANT CONTEXT'));
    const charIdx = texts.findIndex((t) => t.includes('ACTIVE PLAYER CHARACTER'));
    expect(modeIdx).toBeLessThan(ragIdx);
    expect(ragIdx).toBeLessThan(charIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/system-prompt.mode.test.ts`
Expected: FAIL (ragChunks not accepted in input type)

- [ ] **Step 3: Extend MasterPromptInput**

In `src/ai/master/system-prompt.ts`, locate the `MasterPromptInput` interface (where `mode?: MasterMode` was added in Plan E.1). Add a new field:

```ts
import type { RetrievedChunk } from './rag/types';
// ...
export interface MasterPromptInput {
  // ... existing fields ...
  /** Plan E.2: retrieved RAG chunks to inject as a RELEVANT CONTEXT block. */
  ragChunks?: RetrievedChunk[];
}
```

- [ ] **Step 4: Inject the block**

Still in `src/ai/master/system-prompt.ts`, locate the Plan E.1 injection block (section "2.5") that pushes `MODE_BLOCKS[input.mode]` + `SPELLCASTING_OVERLAY_BLOCK`. Right after that block, BEFORE the section "3" comment, add:

```ts
// ── (2.6) PLAN E.2 RAG RETRIEVED CONTEXT ──
// Goes after the mode block (mode-stable) but BEFORE the active character
// block (per-turn dynamic). The RAG block changes per turn (new query
// embedding) so it sits in the dynamic region — cache invalidates here.
if (input.ragChunks && input.ragChunks.length > 0) {
  const { formatRagBlock } = await import('./rag/format');
  // synchronous import not possible without restructuring — promote it
  // to a static import at the top.
}
```

Then promote the import (this is just like Plan E.1's static-import pattern):

```ts
// at the top of the file, with the other imports:
import { formatRagBlock } from './rag/format';
```

And rewrite the injection block to use the static import:

```ts
// ── (2.6) PLAN E.2 RAG RETRIEVED CONTEXT ──
if (input.ragChunks && input.ragChunks.length > 0) {
  blocks.push({
    type: 'text',
    text: formatRagBlock(input.ragChunks),
    cache_control: { type: 'ephemeral' },
  });
}
```

(Drop the dynamic-import draft; the static import is the actual implementation.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/system-prompt.mode.test.ts`
Expected: PASS, all tests (including the 3 new ones).

- [ ] **Step 6: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep system-prompt || echo "no errors"`

- [ ] **Step 7: Commit**

```bash
git add src/ai/master/system-prompt.ts tests/ai/master/system-prompt.mode.test.ts
git commit -m "feat(rag): inject RELEVANT CONTEXT block between mode block and active character"
```

---

## Task 15: Wire turn route to fetch + pass chunks

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Add imports**

In `src/app/api/sessions/[id]/turn/route.ts`, near the existing `deriveMode` import:

```ts
import { retrieveRelevant } from '@/ai/master/rag/retriever';
import { getRagStore } from '@/ai/master/rag/store';
import { embed } from '@/ai/master/rag/embedder';
```

- [ ] **Step 2: Fetch chunks before building the prompt**

Find the line where `useModeAware` is computed (Plan E.1, around line where `mode = useModeAware ? deriveMode(snap.state) : undefined`). Below it, add:

```ts
// Plan E.2: RAG retrieval. Off by default; opt-in per campaign in Phase 2.
// When enabled, we embed the last 2 user messages + last master message
// and retrieve top-3 chunks. Failure (embedder down, store empty) returns
// [] so the prompt builder skips the block entirely.
const useRag = userPrefs.useRagRetrieval;
let ragChunks: Awaited<ReturnType<typeof retrieveRelevant>> = [];
if (useRag) {
  const recentForQuery = [
    ...history.filter((m) => m.role === 'user').slice(-2).map((m) =>
      typeof m.content === 'string' ? m.content : ''
    ),
    ...history.filter((m) => m.role === 'assistant').slice(-1).map((m) =>
      typeof m.content === 'string' ? m.content : ''
    ),
  ].filter(Boolean).join('\n');
  if (recentForQuery) {
    const { store } = await getRagStore();
    ragChunks = await retrieveRelevant({
      query: recentForQuery,
      store,
      embedFn: (t) => embed(t),
      k: 3,
    });
  }
}
```

(The `history` variable already exists from the existing turn-route logic that loads recent messages — confirm by reading the surrounding code.)

- [ ] **Step 3: Pass to the prompt builder**

Find the `buildMasterSystemPrompt({...})` call and add the new field to the input:

```ts
const sys = buildMasterSystemPrompt({
  // ... all existing fields untouched ...
  mode,
  needsSpellcasting,
  // Plan E.2:
  ragChunks,
});
```

- [ ] **Step 4: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep -E "turn/route|rag" || echo "no errors"`

- [ ] **Step 5: Run the master test suite**

Run: `pnpm vitest run tests/ai/master/ tests/lib/`
Expected: all green (no regression).

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/sessions/[id]/turn/route.ts'
git commit -m "feat(rag): wire turn route to fetch + pass retrieved chunks"
```

---

## Task 16: Settings UI toggle + status + rebuild button

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`
- Modify: `src/app/api/campaigns/[id]/settings/route.ts` (add `useRagRetrieval` to `ALLOWED_KEYS`)
- Create: `src/app/api/rag/rebuild/route.ts` (POST endpoint for manual rebuild)

- [ ] **Step 1: Add the API endpoint for manual rebuild**

Create `src/app/api/rag/rebuild/route.ts`:

```ts
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { rebuildIndex } from '@/ai/master/rag/indexer';
import { getRagStore } from '@/ai/master/rag/store';
import { embed } from '@/ai/master/rag/embedder';
import { getMasterHandbook, getMasterWorldLore } from '@/ai/master/handbook';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rag/rebuild — triggers a fresh index build. Requires auth.
 * Optional body: { force?: boolean }.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { force?: boolean };
  const handbookMd = getMasterHandbook();
  const loreMd = getMasterWorldLore();
  const { store, backend } = await getRagStore();
  const result = await rebuildIndex({
    handbookMd,
    loreMd,
    store,
    embedFn: (t) => embed(t),
    force: !!body.force,
  });
  return NextResponse.json({ ...result, backend });
}
```

- [ ] **Step 2: Add `useRagRetrieval` to ALLOWED_KEYS**

In `src/app/api/campaigns/[id]/settings/route.ts`, find the `ALLOWED_KEYS` array (Plan E.1 added `useModeAwarePrompt` there). Add `'useRagRetrieval'` to the array.

- [ ] **Step 3: Add the toggle + status + rebuild button to the Settings UI**

In `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`, find the "Local optimization" Card (where the `compactPrompt` and `useModeAwarePrompt` toggles live). Add a new toggle for `useRagRetrieval` and a rebuild button.

After the existing `onModeAwarePromptToggle` handler, add:

```tsx
const onRagToggle = () => {
  const next = !settings.useRagRetrieval;
  setSettings((s) => ({ ...s, useRagRetrieval: next }));
  void save({ useRagRetrieval: next });
};

const [rebuildingRag, setRebuildingRag] = React.useState(false);
const [rebuildMsg, setRebuildMsg] = React.useState<string | null>(null);
const onRebuildRag = async () => {
  setRebuildingRag(true);
  setRebuildMsg(null);
  try {
    const res = await fetch('/api/rag/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setRebuildMsg(`Indexed ${data.chunkCount} chunks (backend: ${data.backend}).`);
  } catch (e) {
    setRebuildMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setRebuildingRag(false);
  }
};
```

Then in the JSX, add the toggle button next to the mode-aware toggle (mirror the existing pattern), and a "Rebuild RAG index" button + status line beneath the toggles:

```tsx
<button
  onClick={onRagToggle}
  disabled={disabled}
  aria-pressed={settings.useRagRetrieval}
  style={{
    background: settings.useRagRetrieval ? 'var(--arcane)' : 'transparent',
    border: '1px solid ' + (settings.useRagRetrieval ? 'var(--arcane)' : 'var(--border-strong)'),
    borderRadius: 999,
    color: settings.useRagRetrieval ? 'var(--bone)' : 'var(--fg-muted)',
    padding: '6px 12px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
    marginLeft: 8,
  }}
>
  {settings.useRagRetrieval ? 'RAG retrieval on' : 'RAG retrieval off'}
</button>
```

And the rebuild row (placed below the toggle row):

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
  <button
    type="button"
    onClick={onRebuildRag}
    disabled={disabled || rebuildingRag}
    style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-strong)',
      borderRadius: 8,
      color: 'var(--fg)',
      padding: '6px 12px',
      fontSize: 13,
      cursor: rebuildingRag ? 'wait' : 'pointer',
    }}
  >
    {rebuildingRag ? 'Rebuilding...' : 'Rebuild RAG index'}
  </button>
  {rebuildMsg && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{rebuildMsg}</span>}
</div>
```

Also wire `useRagRetrieval` into the local `settings` state type if it's defined inline; if it's imported from `CampaignSettings`, Task 13 already added it.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep -E "settings-client|rag/rebuild" || echo "no errors"`

Manual smoke (optional, in browser):
1. Open Settings → Local optimization
2. Flip "RAG retrieval on" — toggle persists across reload.
3. Click "Rebuild RAG index" — see "Indexed N chunks" message (or an error message if Ollama/pgvector aren't set up).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(authed)/campaigns/[id]/settings/settings-client.tsx' 'src/app/api/campaigns/[id]/settings/route.ts' 'src/app/api/rag/rebuild/route.ts'
git commit -m "feat(rag): Settings toggle + Rebuild RAG index button + API endpoint"
```

---

## Task 17: Telemetry — log ragChunkCount

**Files:**
- Modify: `src/ai/master/usage.ts`
- Modify: `src/app/api/sessions/[id]/turn/route.ts`
- Modify: `src/db/schema/ai-usage.ts` (add `rag_chunk_count` column)
- New: `drizzle/<next>_rag_telemetry.sql` (auto-generated)

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema/ai-usage.ts`, find the existing `mode` and `needs_spellcasting` columns (added in Plan E.1 Task 11). Add a sibling column:

```ts
ragChunkCount: integer('rag_chunk_count'),
```

(Make sure `integer` is in the drizzle imports — if not, add it.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/<NNNN>_*.sql` file with `ALTER TABLE "ai_usage" ADD COLUMN "rag_chunk_count" integer;`.

Apply locally: `pnpm db:migrate`.

- [ ] **Step 3: Add to `RecordUsageInput`**

In `src/ai/master/usage.ts`, find the input type. Add:

```ts
/** Plan E.2: how many RAG chunks were retrieved for this turn (0 if RAG off). */
ragChunkCount?: number;
```

In the function body, persist the new field alongside `mode` and `needsSpellcasting` (whatever pattern is in use — DB column insert or JSONB metadata).

- [ ] **Step 4: Pass from turn route**

In `src/app/api/sessions/[id]/turn/route.ts`, find the `recordUsage(` call and add:

```ts
ragChunkCount: ragChunks.length,
```

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | grep -E "usage|ai-usage|turn/route" || echo "no errors"`

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/ai-usage.ts src/ai/master/usage.ts 'src/app/api/sessions/[id]/turn/route.ts' drizzle/*.sql drizzle/meta/*.json
git commit -m "feat(rag): log ragChunkCount per turn in ai_usage telemetry"
```

---

## Task 18 (Phase 3 cutover): Drop world_lore from baked, flip RAG default ON

**Files:**
- Modify: `scripts/build-local-models.ts` (drop `MASTER_HANDBOOK_ULTRA_SLIM` from baked — handbook now in RAG)
- Modify: `src/ai/master/runtime-prompt-hash.ts` (mirror)
- Modify: `src/lib/preferences.ts` (`resolveUseRagRetrieval` default flips to `aiProvider === 'local'`)
- Modify: `src/ai/master/system-prompt.ts` (bump `MASTER_PROMPT_VERSION`)
- Modify: `tests/lib/preferences-rag.test.ts` (update default test)
- Modify: `tests/scripts/build-local-models.slim.test.ts` (update manifest tests)

**Pre-cutover validation (manual checklist — do NOT skip):**
- The dev environment has been running with `useRagRetrieval = true` for at least 1 representative session.
- Telemetry shows ≥80% of turns retrieved ≥1 chunk (`SELECT count(*) FILTER (WHERE rag_chunk_count > 0) * 1.0 / count(*) FROM ai_usage WHERE rag_chunk_count IS NOT NULL`).
- No qualitative regression reported on a smoke session (master still uses lore/handbook info appropriately).

If any of the above fail, STOP — don't run Task 18. Investigate the gap first.

- [ ] **Step 1: Update `buildStaticSystemContent` to drop the ultra-slim handbook**

In `scripts/build-local-models.ts`, find `buildStaticSystemContent`. The current 7 blocks are:
```
MASTER_SYSTEM_PROMPT_BASE_SLIM,
MASTER_TOOL_CONTRACT_SLIM,
MASTER_META_TOOLS_INSTRUCTION,
MASTER_REWARDS_MANDATE_SLIM,
MASTER_MEMORY_TOOL_RULE_SLIM,
MASTER_HANDBOOK_ULTRA_SLIM,
srdContext,
```

Drop `MASTER_HANDBOOK_ULTRA_SLIM` (full handbook now lives in RAG):
```ts
const blocks: string[] = [
  MASTER_SYSTEM_PROMPT_BASE_SLIM,
  MASTER_TOOL_CONTRACT_SLIM,
  MASTER_META_TOOLS_INSTRUCTION,
  MASTER_REWARDS_MANDATE_SLIM,
  MASTER_MEMORY_TOOL_RULE_SLIM,
  srdContext,
  // Plan E.2 Phase 3: handbook (full) is now retrieved via RAG per turn.
  // World lore was already dropped in Plan E.1; this drops the last
  // handbook remnant from the baked SYSTEM directive.
];
```

Also remove the import of `MASTER_HANDBOOK_ULTRA_SLIM` from the top of the file.

- [ ] **Step 2: Mirror in `runtime-prompt-hash.ts`**

In `src/ai/master/runtime-prompt-hash.ts`, do the exact same drop (remove the `MASTER_HANDBOOK_ULTRA_SLIM` line and its import). Both files MUST produce identical content for the staleness check to work.

- [ ] **Step 3: Flip the default in `resolveUseRagRetrieval`**

In `src/lib/preferences.ts`, change the resolver:
```ts
export function resolveUseRagRetrieval(prefs: {
  aiProvider: string;
  useRagRetrieval?: boolean;
}): boolean {
  if (typeof prefs.useRagRetrieval === 'boolean') return prefs.useRagRetrieval;
  // Plan E.2 Phase 3: default ON for local. Cloud stays OFF (no
  // benefit — cloud is not context-window constrained).
  return prefs.aiProvider === 'local';
}
```

- [ ] **Step 4: Bump `MASTER_PROMPT_VERSION`**

In `src/ai/master/system-prompt.ts`, find `MASTER_PROMPT_VERSION` and bump it:
```ts
export const MASTER_PROMPT_VERSION = '3'; // Plan E.2: dropped handbook from baked (now in RAG)
```

(Replace `'3'` with the actual next value — was `'2'` after Plan E.1 Task 7.)

- [ ] **Step 5: Update tests**

In `tests/lib/preferences-rag.test.ts`, update the "defaults" test:
```ts
it('defaults to true when undefined and provider=local (Phase 3)', () => {
  expect(resolveUseRagRetrieval({ aiProvider: 'local', useRagRetrieval: undefined })).toBe(true);
});

it('defaults to false when undefined and provider=cloud', () => {
  expect(resolveUseRagRetrieval({ aiProvider: 'cloud', useRagRetrieval: undefined })).toBe(false);
});
```

In `tests/scripts/build-local-models.slim.test.ts`, the test "includes slim BASE, slim TOOL_CONTRACT, ultra-slim HANDBOOK" must be split: remove the HANDBOOK assertion since it's no longer in the baked manifest. Add a new assertion that `# DM CRAFT - CORE PRINCIPLES` is NOT present:
```ts
it('includes slim BASE, slim TOOL_CONTRACT (handbook moved to RAG in Phase 3)', async () => {
  const content = await buildStaticSystemContent();
  expect(content).toMatch(/# ROLE\b/);
  expect(content).toMatch(/# TOOL USAGE RULES\b/);
  expect(content).not.toMatch(/# DM CRAFT - CORE PRINCIPLES/);
});
```

The total-baked-tokens ceiling test should still pass — content has shrunk further.

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run tests/ai/master/ tests/scripts/ tests/lib/`
Expected: all green.

- [ ] **Step 7: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json 2>&1 | tail -20`

- [ ] **Step 8: Commit**

```bash
git add scripts/build-local-models.ts src/ai/master/runtime-prompt-hash.ts src/lib/preferences.ts src/ai/master/system-prompt.ts tests/lib/preferences-rag.test.ts tests/scripts/build-local-models.slim.test.ts
git commit -m "feat(rag): Phase 3 cutover — drop handbook from baked + default RAG ON for local

Once validated:
- Drop MASTER_HANDBOOK_ULTRA_SLIM from buildStaticSystemContent (handbook
  now retrieved per turn via RAG; world_lore was already dropped in E.1).
- runtime-prompt-hash.ts mirrors the change so staleness check stays sync.
- resolveUseRagRetrieval default flips from false to (aiProvider=='local').
- MASTER_PROMPT_VERSION bumped — existing baked models will surface stale
  warning until rebuilt with 'pnpm build-local-models --force'.

Baked content after Phase 3: ~3.7K tok (down from ~4.1K after Plan E.1).
Total context per turn: ~7-8K (down from ~9K), comfortably within 8K
native context window of mid-tier local models."
```

---

## Task 19: Re-bake all installed models (operational)

**Files:** none (operational step).

After Task 18 lands, the `MASTER_PROMPT_VERSION` bump means existing baked models are stale. Run:

```bash
pnpm build-local-models --force
```

(Same as Plan E.1 Task 12 — re-applies the new slim manifest to every installed base.)

Verify with `ollama show <baked-name> --modelfile` that the SYSTEM block no longer contains `# DM CRAFT - CORE PRINCIPLES`.

No commit — this is a local operation.

---

## Task 20: Documentation

**Files:**
- Modify: `README.md` (or `docs/local-ai/README.md` if it exists)

- [ ] **Step 1: Append the Plan E.2 section**

Add under the existing Plan E.1 section:

```markdown
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
\`\`\`bash
ollama pull nomic-embed-text
pnpm db:migrate            # adds the rag_chunks table + pgvector extension
pnpm build-rag-index       # ~10-30s on a warm Ollama
\`\`\`

**Enable**: Settings → Local optimization → "RAG retrieval on". After
Phase 3 cutover this is ON by default for the local provider.

**Phase 3 cutover** dropped the handbook from the baked Modelfile and
made RAG the canonical source. After updating, re-bake your installed
models:
\`\`\`bash
pnpm build-local-models --force
\`\`\`

**Validation query** (to confirm RAG is actually returning chunks):
\`\`\`sql
SELECT count(*) FILTER (WHERE rag_chunk_count > 0) * 1.0 / count(*) AS hit_rate
FROM ai_usage WHERE rag_chunk_count IS NOT NULL;
\`\`\`
Target: ≥0.8 (80% of turns retrieved ≥1 chunk).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(rag): document Plan E.2 setup, enable, validate"
```

---

## Self-review checklist

After all 20 tasks are complete:

- [ ] **Spec coverage**: every section of the design doc's Plan E.2 scope is implemented (embedder, chunker, store, retriever, indexer, Settings toggle, telemetry, Phase 3 cutover).
- [ ] **No regression on Plan E.1**: token budget tests still green; mode-aware tests still green.
- [ ] **All tests green**: `pnpm vitest run`.
- [ ] **Typecheck clean**: `pnpm tsc --noEmit`.
- [ ] **Hash sync verified**: `runtime-prompt-hash.ts` and `buildStaticSystemContent` produce the same SHA on the same input (manually inspect after Task 18).
- [ ] **Retrieval smoke**: `pnpm build-rag-index` succeeds locally; a test turn returns a non-empty `rag_chunk_count`.

---

## Acceptance criteria

- ≥80% of turns retrieve at least 1 relevant chunk (telemetry-verified after a day of dev usage).
- No qualitative degradation in master narrative quality vs the pre-RAG behavior (validated on a smoke campaign).
- Total context per turn (local provider, after Phase 3) is within 7-8K target.
- Settings toggle works and persists; Rebuild button completes within 60s on a warm Ollama.
- All tests green.

When all the above hold, Plan E.2 is ready to merge.
