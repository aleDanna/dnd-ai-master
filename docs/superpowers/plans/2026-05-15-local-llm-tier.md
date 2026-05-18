# Local LLM Tier (Ollama + Shared Infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as a fourth master-LLM provider, plus the shared `isLocalModeEnabled()` + `probeLocalServices()` infrastructure that subsequent local-tier plans (TTS, image) will extend.

**Architecture:** New `OllamaProvider` implements the existing `MasterProvider` interface and talks to Ollama's native `/api/chat` via raw `fetch` (no SDK). A new `ollama-adapter.ts` converts the canonical Anthropic-flavoured message/tool shape to/from Ollama's flat shape. A new server-only `local-services.ts` module exposes `isLocalModeEnabled()` (dev-mode predicate) and `probeLocalServices()` (per-tier health probe with 1.5s timeout); for this plan only the Ollama probe is implemented (TTS/image probes added in their own plans). Settings UI conditionally renders the "Ollama (locale)" radio per tier when its service is reachable.

**Tech Stack:** TypeScript, Next.js 16 (App Router, Server Components), Vitest, Drizzle ORM (JSONB columns, no migration needed — union widening is TS-only). No new npm dependencies — Ollama's REST API is small enough for `fetch`.

**Spec reference:** [docs/superpowers/specs/2026-05-15-local-ai-providers-design.md](../specs/2026-05-15-local-ai-providers-design.md)

**Scope note vs. spec:** The spec mentions `src/app/(authed)/settings/page.tsx`. That file no longer exists — the project recently moved to per-campaign settings (commits `ce57feb`, `bd839c1`). The Settings UI to modify is `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` and the corresponding server page. API validation lives in both `src/app/api/preferences/route.ts` (user-scoped legacy) and `src/app/api/campaigns/[id]/settings/route.ts` (canonical campaign-scoped path).

---

## Task 1: Widen TypeScript unions for `'ollama'`

**Files:**
- Modify: `src/ai/provider/types.ts:3`
- Modify: `src/lib/ai-models.ts:9` (and helpers)
- Modify: `src/db/schema/users.ts:26`
- Modify: `src/db/schema/campaigns.ts:15`

No tests for this task — TS compile is the test. Behavior unchanged; just opens the type door for subsequent tasks.

- [ ] **Step 1: Widen `ProviderName` in provider types**

Edit `src/ai/provider/types.ts:3`:

```ts
// Before:
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

// After:
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';
```

- [ ] **Step 2: Widen `ProviderName` in browser-safe models module**

Edit `src/lib/ai-models.ts:9`:

```ts
// Before:
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

// After:
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';
```

Update `isKnownProvider` at the same time (`src/lib/ai-models.ts:103`):

```ts
export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'ollama';
}
```

Update `modelsForProvider` to handle the new slug (`src/lib/ai-models.ts:83`):

```ts
export function modelsForProvider(p: ProviderName): ModelOption[] {
  if (p === 'anthropic') return ANTHROPIC_MASTER_MODELS;
  if (p === 'openai') return OPENAI_MASTER_MODELS;
  if (p === 'gemini') return GEMINI_MASTER_MODELS;
  // Ollama's list is supplied at runtime from /api/tags, not enumerated here.
  return [];
}
```

Update `defaultModelForProvider`:

```ts
export function defaultModelForProvider(p: ProviderName): string {
  const list = modelsForProvider(p);
  // Ollama has no enumerated list — the caller must supply the runtime list.
  // Returning '' here lets the caller detect "no static default" and pick from the live probe.
  if (list.length === 0) return '';
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}
```

Update `isKnownMasterModel` to accept Ollama slugs (non-enumerable) when paired with `'ollama'`:

```ts
/** Validates that the slug is in the union of known master model slugs.
 *  For Ollama, slugs are dynamic — accept any non-empty string ≤200 chars. */
export function isKnownMasterModel(value: unknown, provider?: ProviderName): boolean {
  if (typeof value !== 'string') return false;
  if (provider === 'ollama') return value.length > 0 && value.length <= 200;
  return [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS, ...GEMINI_MASTER_MODELS].some(
    (m) => m.slug === value,
  );
}
```

- [ ] **Step 3: Widen `aiProvider` in user schema**

Edit `src/db/schema/users.ts:26`:

```ts
// Before:
aiProvider?: 'anthropic' | 'openai' | 'gemini';

// After:
aiProvider?: 'anthropic' | 'openai' | 'gemini' | 'ollama';
```

- [ ] **Step 4: Widen `aiProvider` in campaign schema**

Edit `src/db/schema/campaigns.ts:15`:

```ts
// Before:
aiProvider?: 'anthropic' | 'openai' | 'gemini';

// After:
aiProvider?: 'anthropic' | 'openai' | 'gemini' | 'ollama';
```

- [ ] **Step 5: Type-check the repo**

Run: `pnpm tsc --noEmit`
Expected: PASS (no new errors; `isKnownMasterModel` callers may need adjustment if they pass two args now — check by running)

If there are callers of `isKnownMasterModel(value)` that fail to compile because they don't pass `provider`, leave them as-is (the second arg is optional). If callers fail because the `aiProvider` union widening surfaces unhandled cases in switch statements, follow the compiler's guidance.

- [ ] **Step 6: Commit**

```bash
git add src/ai/provider/types.ts src/lib/ai-models.ts src/db/schema/users.ts src/db/schema/campaigns.ts
git commit -m "feat(types): widen ProviderName to include 'ollama'

TypeScript-only change opening the union for the upcoming OllamaProvider.
No behavior change; aiProvider is a JSONB key so no Drizzle migration is
needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `isLocalModeEnabled()` predicate

**Files:**
- Create: `src/lib/local-services.ts`
- Create: `tests/lib/local-services.test.ts`

A server-only module exposing the dev-mode predicate. No imports from heavy modules — keep it cheap to import.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/local-services.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('isLocalModeEnabled', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it('returns true in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL;
    const { isLocalModeEnabled } = await import('@/lib/local-services');
    expect(isLocalModeEnabled()).toBe(true);
  });

  it('returns false when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL;
    const { isLocalModeEnabled } = await import('@/lib/local-services');
    expect(isLocalModeEnabled()).toBe(false);
  });

  it('returns false on Vercel even in dev', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VERCEL = '1';
    const { isLocalModeEnabled } = await import('@/lib/local-services');
    expect(isLocalModeEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/local-services.test.ts`
Expected: FAIL with module-not-found error for `@/lib/local-services`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/local-services.ts`:

```ts
import 'server-only';

/**
 * True when the app is running in a development context where local AI
 * services (Ollama, Kokoro, ComfyUI) should be probed and exposed in
 * Settings. Production (Vercel or NODE_ENV=production) returns false.
 */
export function isLocalModeEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/local-services.test.ts`
Expected: 3 tests pass.

The `'server-only'` import will be stripped by the test bundler — vitest doesn't enforce it. It's there as a documentation contract for actual builds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services.test.ts
git commit -m "feat(local-services): add isLocalModeEnabled predicate

Server-only gate that turns on local AI provider probing in dev. Hides
local providers in production and on Vercel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `probeLocalServices()` with Ollama probe

**Files:**
- Modify: `src/lib/local-services.ts`
- Modify: `tests/lib/local-services.test.ts`

Adds the per-tier probe orchestrator. For this plan only the Ollama probe is implemented; TTS and image probes are stubs returning `reachable: false` and will be filled in by subsequent plans.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/local-services.test.ts`:

```ts
import { vi } from 'vitest';

describe('probeLocalServices', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns all-unreachable when local mode disabled', async () => {
    process.env.NODE_ENV = 'production';
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.ollama.reachable).toBe(false);
    expect(status.kokoro.reachable).toBe(false);
    expect(status.comfy.reachable).toBe(false);
  });

  it('marks ollama reachable when /api/tags returns 200 with models', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'qwen3:30b-a3b', details: { family: 'qwen3', parameter_size: '30B' } },
              { name: 'gpt-oss:20b', details: { family: 'gpt-oss', parameter_size: '20B' } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.ollama.reachable).toBe(true);
    expect(status.ollama.models).toHaveLength(2);
    expect(status.ollama.models[0]).toMatchObject({ slug: 'qwen3:30b-a3b', label: 'qwen3:30b-a3b' });
    expect(status.ollama.error).toBeNull();
  });

  it('marks ollama unreachable on fetch rejection', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.ollama.reachable).toBe(false);
    expect(status.ollama.models).toEqual([]);
    expect(status.ollama.error).toContain('ECONNREFUSED');
  });

  it('marks ollama unreachable on non-200', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.ollama.reachable).toBe(false);
    expect(status.ollama.error).toContain('500');
  });

  it('still marks ollama reachable when model list is empty', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as typeof fetch;
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.ollama.reachable).toBe(true);
    expect(status.ollama.models).toEqual([]);
  });

  it('kokoro and comfy probes return unreachable (stubs for later plans)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as typeof fetch;
    const { probeLocalServices } = await import('@/lib/local-services');
    const status = await probeLocalServices();
    expect(status.kokoro.reachable).toBe(false);
    expect(status.comfy.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/lib/local-services.test.ts`
Expected: FAIL — `probeLocalServices` not exported.

- [ ] **Step 3: Write the implementation**

Replace `src/lib/local-services.ts` with:

```ts
import 'server-only';
import type { ModelOption } from './ai-models';

const PROBE_TIMEOUT_MS = 1500;

export interface VoiceOption {
  slug: string;
  label: string;
  /** ISO 639-1 locale code if derivable from voice name. */
  locale?: string;
}

export interface LocalServiceStatus {
  ollama: { reachable: boolean; models: ModelOption[]; error: string | null };
  kokoro: { reachable: boolean; voices: VoiceOption[]; error: string | null };
  comfy:  { reachable: boolean; error: string | null };
}

/**
 * True when the app is running in a development context where local AI
 * services (Ollama, Kokoro, ComfyUI) should be probed and exposed in
 * Settings. Production (Vercel or NODE_ENV=production) returns false.
 */
export function isLocalModeEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
}

const UNREACHABLE_STATUS: LocalServiceStatus = {
  ollama: { reachable: false, models: [], error: null },
  kokoro: { reachable: false, voices: [], error: null },
  comfy:  { reachable: false, error: null },
};

/**
 * Server-side probe of all local AI services. Each probe has a 1.5s timeout.
 * Returns all-unreachable when local mode is disabled. Called once per
 * Settings page render; not cached.
 */
export async function probeLocalServices(): Promise<LocalServiceStatus> {
  if (!isLocalModeEnabled()) return UNREACHABLE_STATUS;
  const [ollama] = await Promise.all([probeOllama()]);
  return {
    ollama,
    // TTS and image probes added in their respective plans.
    kokoro: { reachable: false, voices: [], error: null },
    comfy:  { reachable: false, error: null },
  };
}

async function probeOllama(): Promise<LocalServiceStatus['ollama']> {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  try {
    const resp = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) return { reachable: false, models: [], error: `ollama ${resp.status}` };
    const json = (await resp.json()) as {
      models?: { name: string; details?: { family?: string; parameter_size?: string } }[];
    };
    const models: ModelOption[] = (json.models ?? []).map((m) => ({
      slug: m.name,
      label: m.name,
      blurb: [m.details?.family, m.details?.parameter_size].filter(Boolean).join(' · ') || 'local',
    }));
    return { reachable: true, models, error: null };
  } catch (e) {
    return {
      reachable: false,
      models: [],
      error: e instanceof Error ? e.message : 'unreachable',
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/lib/local-services.test.ts`
Expected: All 9 tests pass (3 from Task 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services.test.ts
git commit -m "feat(local-services): probe Ollama at /api/tags

Returns dynamic model list when reachable, structured error otherwise.
TTS/image probes are stubs returning unreachable; filled in by their
respective tier plans.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Ollama adapter — outbound conversions

**Files:**
- Create: `src/ai/provider/ollama-adapter.ts`
- Create: `tests/ai/provider/ollama-adapter.test.ts`

The adapter is two-directional. This task covers Anthropic → Ollama (system blocks, tool defs, message history). The inbound side (response → ContentBlocks) is Task 5.

Look at `src/ai/provider/tool-adapter.ts` for the OpenAI equivalent if you need a reference shape. Ollama's `/api/chat` is mostly OpenAI-shaped but with a `system` field on the first message rather than a top-level system param.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai/provider/ollama-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  flattenSystemBlocksToOllama,
  anthropicMessagesToOllama,
  anthropicToolToOllama,
} from '@/ai/provider/ollama-adapter';
import type { ToolDef, Message, SystemBlock } from '@/ai/provider/types';

describe('flattenSystemBlocksToOllama', () => {
  it('merges multiple system blocks into a single string', () => {
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(flattenSystemBlocksToOllama(blocks)).toBe('first\n\nsecond');
  });

  it('drops cache_control field silently', () => {
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
    ];
    expect(flattenSystemBlocksToOllama(blocks)).toBe('cached');
  });

  it('handles empty array', () => {
    expect(flattenSystemBlocksToOllama([])).toBe('');
  });
});

describe('anthropicToolToOllama', () => {
  it('converts an Anthropic tool definition to OpenAI-shape function tool', () => {
    const tool: ToolDef = {
      name: 'roll_d20',
      description: 'Roll a d20 with optional modifier',
      input_schema: {
        type: 'object',
        properties: { mod: { type: 'number' } },
        required: ['mod'],
      } as never,
    };
    expect(anthropicToolToOllama(tool)).toEqual({
      type: 'function',
      function: {
        name: 'roll_d20',
        description: 'Roll a d20 with optional modifier',
        parameters: {
          type: 'object',
          properties: { mod: { type: 'number' } },
          required: ['mod'],
        },
      },
    });
  });
});

describe('anthropicMessagesToOllama', () => {
  it('converts a plain user message', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    expect(anthropicMessagesToOllama('sys prompt', messages)).toEqual([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('omits the system message when system text is empty', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    expect(anthropicMessagesToOllama('', messages)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts an assistant message with text + tool_use into tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I roll for you.' },
          { type: 'tool_use', id: 'tu_1', name: 'roll_d20', input: { mod: 3 } },
        ],
      },
    ];
    const out = anthropicMessagesToOllama('', messages);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'I roll for you.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'roll_d20', arguments: JSON.stringify({ mod: 3 }) },
          },
        ],
      },
    ]);
  });

  it('fans out user message with multiple tool_results into separate role:tool messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'rolled 14' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: '8 damage' },
        ],
      },
    ];
    const out = anthropicMessagesToOllama('', messages);
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: 'rolled 14' },
      { role: 'tool', tool_call_id: 'tu_2', content: '8 damage' },
    ]);
  });

  it('handles a tool_result with array content by joining text blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'rolled 14' }],
          },
        ],
      },
    ];
    const out = anthropicMessagesToOllama('', messages);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'tu_1', content: 'rolled 14' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/ai/provider/ollama-adapter.ts`:

```ts
import type { Message, SystemBlock, ToolDef } from './types';

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

/** Joins multiple Anthropic system blocks into a single string for Ollama's
 *  `system` field. Drops `cache_control` since Ollama has no prompt cache. */
export function flattenSystemBlocksToOllama(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/** Translates an Anthropic tool definition to Ollama's OpenAI-shape function
 *  tool. `input_schema` → `parameters`. */
export function anthropicToolToOllama(tool: ToolDef): OllamaToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

/**
 * Translates Anthropic-shape message history to Ollama's flat array.
 *  - A leading system message is prepended if `systemContent` is non-empty.
 *  - Assistant messages with `tool_use` blocks become assistant messages
 *    carrying `tool_calls`; the text portion stays in `content`.
 *  - User messages whose content is an array of `tool_result` blocks are
 *    fanned out into one `role: 'tool'` message per result.
 */
export function anthropicMessagesToOllama(
  systemContent: string,
  messages: Message[],
): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (systemContent.length > 0) out.push({ role: 'system', content: systemContent });

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      // Array of blocks: may contain tool_result fan-out, or plain text.
      const textParts: string[] = [];
      let pushedTool = false;
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          const content = normalizeToolResultContent(block.content);
          out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
          pushedTool = true;
        } else if (block.type === 'text') {
          textParts.push(block.text);
        }
      }
      if (!pushedTool && textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n\n') });
      }
      continue;
    }

    // assistant
    if (typeof m.content === 'string') {
      out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    for (const block of m.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
    const msg: OllamaMessage = { role: 'assistant', content: textParts.join('\n\n') };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    out.push(msg);
  }

  return out;
}

function normalizeToolResultContent(
  content: string | Array<{ type: 'text'; text: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama-adapter.ts tests/ai/provider/ollama-adapter.test.ts
git commit -m "feat(ollama-adapter): outbound Anthropic to Ollama conversions

System block merging, tool definition translation, message history
flattening with tool_use/tool_result fan-out.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Ollama adapter — response normalization

**Files:**
- Modify: `src/ai/provider/ollama-adapter.ts`
- Modify: `tests/ai/provider/ollama-adapter.test.ts`

Inbound side: Ollama response → canonical `ContentBlock[] + stopReason + NormalizedUsage`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ai/provider/ollama-adapter.test.ts`:

```ts
import {
  ollamaMessageToContentBlocks,
  ollamaDoneReasonToStopReason,
  normalizeOllamaUsage,
} from '@/ai/provider/ollama-adapter';

describe('ollamaMessageToContentBlocks', () => {
  it('converts a text-only response', () => {
    expect(ollamaMessageToContentBlocks({ role: 'assistant', content: 'hello' })).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('converts a tool-call-only response with synthetic id', () => {
    const blocks = ollamaMessageToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'roll_d20', arguments: { mod: 3 } } },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tool_use', name: 'roll_d20', input: { mod: 3 } });
    expect((blocks[0] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('parses arguments when supplied as a JSON string (compat layer)', () => {
    const blocks = ollamaMessageToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 't', arguments: '{"x":1}' } }],
    });
    expect(blocks[0]).toMatchObject({ type: 'tool_use', name: 't', input: { x: 1 } });
  });

  it('falls back to { _raw } when arguments are a non-JSON string', () => {
    const blocks = ollamaMessageToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 't', arguments: 'not json' } }],
    });
    expect(blocks[0]).toMatchObject({ type: 'tool_use', input: { _raw: 'not json' } });
  });

  it('combines text and tool calls in order', () => {
    const blocks = ollamaMessageToContentBlocks({
      role: 'assistant',
      content: 'rolling now',
      tool_calls: [{ function: { name: 'roll_d20', arguments: { mod: 0 } } }],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'rolling now' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'roll_d20' });
  });

  it('drops empty text and returns only tool_use', () => {
    const blocks = ollamaMessageToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'a', arguments: {} } }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tool_use' });
  });
});

describe('ollamaDoneReasonToStopReason', () => {
  it("maps 'stop' without tool_calls to end_turn", () => {
    expect(ollamaDoneReasonToStopReason('stop', false)).toBe('end_turn');
  });
  it("maps 'stop' with tool_calls to tool_use", () => {
    expect(ollamaDoneReasonToStopReason('stop', true)).toBe('tool_use');
  });
  it("maps 'length' to max_tokens", () => {
    expect(ollamaDoneReasonToStopReason('length', false)).toBe('max_tokens');
  });
  it('maps unknown reasons to other', () => {
    expect(ollamaDoneReasonToStopReason('unknown', false)).toBe('other');
  });
  it('maps undefined to other', () => {
    expect(ollamaDoneReasonToStopReason(undefined, false)).toBe('other');
  });
});

describe('normalizeOllamaUsage', () => {
  it('extracts prompt_eval_count and eval_count', () => {
    expect(normalizeOllamaUsage({ prompt_eval_count: 100, eval_count: 25 })).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('defaults missing fields to zero', () => {
    expect(normalizeOllamaUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: FAIL on the new test groups — exports not present.

- [ ] **Step 3: Append the implementation**

Append to `src/ai/provider/ollama-adapter.ts`:

```ts
import type { ContentBlock, NormalizedUsage, CompleteMessageOutput } from './types';

export interface OllamaResponseMessage {
  role: 'assistant';
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
}

/**
 * Converts an Ollama `/api/chat` assistant message into canonical
 * `ContentBlock[]`. Ollama's tool_calls have no id on the native API, so we
 * synthesize a UUID — the loop only uses the id locally to match
 * tool_results back to tool_uses within a single turn.
 */
export function ollamaMessageToContentBlocks(msg: OllamaResponseMessage): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (msg.content && msg.content.length > 0) {
    out.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    out.push({
      type: 'tool_use',
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function.name,
      input: coerceToolArguments(tc.function.arguments),
    });
  }
  return out;
}

function coerceToolArguments(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: args };
    } catch {
      return { _raw: args };
    }
  }
  return args;
}

export function ollamaDoneReasonToStopReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): CompleteMessageOutput['stopReason'] {
  if (reason === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  if (reason === 'length') return 'max_tokens';
  return 'other';
}

export function normalizeOllamaUsage(json: {
  prompt_eval_count?: number;
  eval_count?: number;
}): NormalizedUsage {
  return {
    inputTokens: json.prompt_eval_count ?? 0,
    outputTokens: json.eval_count ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: All tests pass (outbound + inbound).

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama-adapter.ts tests/ai/provider/ollama-adapter.test.ts
git commit -m "feat(ollama-adapter): inbound Ollama to ContentBlocks

Response message normalization with synthetic tool-call ids,
done_reason mapping, usage normalization with zero cache fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Thinking-mode injection in adapter

**Files:**
- Modify: `src/ai/provider/ollama-adapter.ts`
- Modify: `tests/ai/provider/ollama-adapter.test.ts`

Default OFF for speed. Injects `/no_think` for qwen3 models, adds `options.reasoning_effort: 'low'` for gpt-oss. Override via env var `OLLAMA_THINKING_MODE=on`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ai/provider/ollama-adapter.test.ts`:

```ts
import { applyThinkingMode } from '@/ai/provider/ollama-adapter';

describe('applyThinkingMode', () => {
  const originalEnv = process.env.OLLAMA_THINKING_MODE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OLLAMA_THINKING_MODE;
    else process.env.OLLAMA_THINKING_MODE = originalEnv;
  });

  it('qwen3 + thinking off → appends /no_think to system content', () => {
    delete process.env.OLLAMA_THINKING_MODE;
    const result = applyThinkingMode({
      model: 'qwen3:30b-a3b',
      systemContent: 'You are the master.',
      options: {},
    });
    expect(result.systemContent).toBe('You are the master.\n\n/no_think');
    expect(result.options).toEqual({});
  });

  it('qwen3 + thinking on → appends /think', () => {
    process.env.OLLAMA_THINKING_MODE = 'on';
    const result = applyThinkingMode({
      model: 'qwen3:30b-a3b',
      systemContent: 'sys',
      options: {},
    });
    expect(result.systemContent).toBe('sys\n\n/think');
  });

  it('gpt-oss + thinking off → reasoning_effort low', () => {
    delete process.env.OLLAMA_THINKING_MODE;
    const result = applyThinkingMode({
      model: 'gpt-oss:20b',
      systemContent: 'sys',
      options: {},
    });
    expect(result.systemContent).toBe('sys');
    expect(result.options).toEqual({ reasoning_effort: 'low' });
  });

  it('gpt-oss + thinking on → reasoning_effort high', () => {
    process.env.OLLAMA_THINKING_MODE = 'on';
    const result = applyThinkingMode({
      model: 'gpt-oss:20b',
      systemContent: 'sys',
      options: {},
    });
    expect(result.options).toEqual({ reasoning_effort: 'high' });
  });

  it('unknown model family is left untouched', () => {
    delete process.env.OLLAMA_THINKING_MODE;
    const result = applyThinkingMode({
      model: 'llama3.2:8b',
      systemContent: 'sys',
      options: { foo: 'bar' },
    });
    expect(result.systemContent).toBe('sys');
    expect(result.options).toEqual({ foo: 'bar' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: FAIL — `applyThinkingMode` not exported.

- [ ] **Step 3: Append the implementation**

Append to `src/ai/provider/ollama-adapter.ts`:

```ts
export interface ThinkingModeInput {
  model: string;
  systemContent: string;
  options: Record<string, unknown>;
}

export interface ThinkingModeOutput {
  systemContent: string;
  options: Record<string, unknown>;
}

/**
 * Injects per-model-family thinking controls. Default OFF (fast narration).
 *  - qwen3:* → append /no_think or /think to system content
 *  - gpt-oss:* → set options.reasoning_effort to 'low' or 'high'
 *  - other → unchanged
 *
 * Override via env: OLLAMA_THINKING_MODE=on.
 */
export function applyThinkingMode(input: ThinkingModeInput): ThinkingModeOutput {
  const thinkingOn = (process.env.OLLAMA_THINKING_MODE ?? 'off').toLowerCase() === 'on';
  if (input.model.startsWith('qwen3:')) {
    const directive = thinkingOn ? '/think' : '/no_think';
    const sep = input.systemContent.length > 0 ? '\n\n' : '';
    return {
      systemContent: input.systemContent + sep + directive,
      options: input.options,
    };
  }
  if (input.model.startsWith('gpt-oss:')) {
    return {
      systemContent: input.systemContent,
      options: { ...input.options, reasoning_effort: thinkingOn ? 'high' : 'low' },
    };
  }
  return input;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama-adapter.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama-adapter.ts tests/ai/provider/ollama-adapter.test.ts
git commit -m "feat(ollama-adapter): per-model thinking-mode injection

Default OFF for speed. qwen3 gets /no_think directive, gpt-oss gets
reasoning_effort=low. OLLAMA_THINKING_MODE=on flips both to enabled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `OllamaProvider.completeMessage`

**Files:**
- Create: `src/ai/provider/ollama.ts`
- Create: `tests/ai/provider/ollama.test.ts`

The class implements `MasterProvider`. Mocks `fetch` directly — no SDK to mock.

Test style mirrors `tests/ai/provider/openai.test.ts`: set env vars and mock `fetch` before importing the provider module.

- [ ] **Step 1: Write the failing test**

Create `tests/ai/provider/ollama.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

// Set env BEFORE importing the provider.
process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
process.env.OLLAMA_MASTER_MODEL = 'qwen3:30b-a3b';

describe('OllamaProvider.completeMessage', () => {
  it('posts to /api/chat with merged system + adapter shape', async () => {
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: 'You step in.',
            tool_calls: [{ function: { name: 'roll_d20', arguments: { mod: 2 } } }],
          },
          done_reason: 'stop',
          prompt_eval_count: 120,
          eval_count: 32,
        }),
        { status: 200 },
      ),
    );

    const provider = new OllamaProvider();
    const out = await provider.completeMessage({
      systemBlocks: [{ type: 'text', text: 'be the master' }],
      messages: [{ role: 'user', content: 'enter the tavern' }],
      tools: [
        {
          name: 'roll_d20',
          description: 'roll',
          input_schema: { type: 'object', properties: { mod: { type: 'number' } } } as never,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://test-ollama:11434/api/chat');
    const body = JSON.parse((init as RequestInit).body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools: unknown[];
      stream: boolean;
    };
    expect(body.model).toBe('qwen3:30b-a3b');
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[0]!.content).toContain('be the master');
    expect(body.messages[0]!.content).toContain('/no_think'); // qwen3 default
    expect(body.tools).toHaveLength(1);

    expect(out.stopReason).toBe('tool_use');
    expect(out.contentBlocks).toHaveLength(2);
    expect(out.usage).toEqual({
      inputTokens: 120,
      outputTokens: 32,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('throws on non-200 response with body in message', async () => {
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    fetchMock.mockResolvedValueOnce(
      new Response('model not found', { status: 404 }),
    );
    const provider = new OllamaProvider();
    await expect(
      provider.completeMessage({
        systemBlocks: [],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        model: 'nonexistent:1b',
      }),
    ).rejects.toThrow(/404.*model not found/);
  });

  it('uses input.model override when supplied', async () => {
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 2,
        }),
        { status: 200 },
      ),
    );
    const provider = new OllamaProvider();
    await provider.completeMessage({
      systemBlocks: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'gpt-oss:20b',
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { model: string; options: Record<string, unknown> };
    expect(body.model).toBe('gpt-oss:20b');
    expect(body.options).toMatchObject({ reasoning_effort: 'low' });
  });

  it('includes keep_alive from env', async () => {
    process.env.OLLAMA_KEEP_ALIVE = '10m';
    vi.resetModules();
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200 },
      ),
    );
    const provider = new OllamaProvider();
    await provider.completeMessage({
      systemBlocks: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { keep_alive: string };
    expect(body.keep_alive).toBe('10m');
    delete process.env.OLLAMA_KEEP_ALIVE;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/ai/provider/ollama.ts`:

```ts
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicMessagesToOllama,
  anthropicToolToOllama,
  applyThinkingMode,
  flattenSystemBlocksToOllama,
  normalizeOllamaUsage,
  ollamaDoneReasonToStopReason,
  ollamaMessageToContentBlocks,
  type OllamaResponseMessage,
} from './ollama-adapter';

const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MASTER_MODEL = process.env.OLLAMA_MASTER_MODEL ?? '';
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';

interface OllamaChatResponse {
  message: OllamaResponseMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements MasterProvider {
  readonly name = 'ollama' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const model = input.model ?? MASTER_MODEL;
    if (!model) throw new Error('OllamaProvider: no model specified and OLLAMA_MASTER_MODEL is unset');

    const flatSystem = flattenSystemBlocksToOllama(input.systemBlocks);
    const tuned = applyThinkingMode({ model, systemContent: flatSystem, options: {} });
    const messages = anthropicMessagesToOllama(tuned.systemContent, input.messages);

    const body = {
      model,
      messages,
      tools: input.tools.map(anthropicToolToOllama),
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { ...tuned.options, num_predict: input.maxTokens ?? 4096 },
    };

    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`ollama chat ${resp.status}: ${detail}`);
    }
    const json = (await resp.json()) as OllamaChatResponse;
    const hasToolCalls = (json.message.tool_calls ?? []).length > 0;
    return {
      contentBlocks: ollamaMessageToContentBlocks(json.message),
      stopReason: ollamaDoneReasonToStopReason(json.done_reason, hasToolCalls),
      usage: normalizeOllamaUsage(json),
    };
  }

  // detectLanguage and proposeWizard added in subsequent tasks.
  detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('not implemented');
  }
  proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: All `completeMessage` tests pass. The `detectLanguage`/`proposeWizard` stubs will throw if exercised, but no test exercises them yet.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama.ts tests/ai/provider/ollama.test.ts
git commit -m "feat(ollama): OllamaProvider.completeMessage via native API

Talks /api/chat directly with fetch, applies thinking-mode injection
based on model family, normalizes response into ContentBlocks.
detectLanguage and proposeWizard left as stubs for the next tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `OllamaProvider.detectLanguage`

**Files:**
- Modify: `src/ai/provider/ollama.ts`
- Modify: `tests/ai/provider/ollama.test.ts`

Same shape as the OpenAI provider's `detectLanguage`: a tiny prompt asking for ISO 639-1, short-circuit on trivial text. Records usage when `userId` is set.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ai/provider/ollama.test.ts`:

```ts
import { recordUsage } from '@/ai/master/usage';
vi.mock('@/ai/master/usage', () => ({
  recordUsage: vi.fn(),
}));

describe('OllamaProvider.detectLanguage', () => {
  beforeEach(() => {
    vi.mocked(recordUsage).mockClear();
  });

  it('returns null on trivial text without calling the API', async () => {
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    expect(await provider.detectLanguage({ text: 'ok' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns lowercase 2-letter code on substantive text', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'it' },
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 1,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    const code = await provider.detectLanguage({
      text: 'Ciao, sono qui per giocare a dungeons and dragons',
    });
    expect(code).toBe('it');
  });

  it('returns null when response is not a valid code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'unsure' },
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 1,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    expect(
      await provider.detectLanguage({
        text: 'Ciao, sono qui per giocare a dungeons and dragons',
      }),
    ).toBeNull();
  });

  it('returns null on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    expect(
      await provider.detectLanguage({
        text: 'Ciao, sono qui per giocare a dungeons and dragons',
      }),
    ).toBeNull();
  });

  it('records usage when userId is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'it' },
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 1,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    await provider.detectLanguage({
      text: 'Ciao, sono qui per giocare a dungeons and dragons',
      userId: 'user_123',
      sessionId: 'sess_456',
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_123',
        sessionId: 'sess_456',
        endpoint: 'language',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: FAIL on `detectLanguage` tests — current implementation throws.

- [ ] **Step 3: Replace the `detectLanguage` stub**

Edit `src/ai/provider/ollama.ts`. Add at the top of the class (next to `completeMessage`):

```ts
const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

const LANGUAGE_MODEL = process.env.OLLAMA_LANGUAGE_MODEL ?? MASTER_MODEL;
```

Place the `TRIVIAL_TOKENS`/`isTrivial`/`LANGUAGE_MODEL` declarations at module scope (above the class), then replace the method body:

```ts
import { recordUsage } from '@/ai/master/usage';

// inside class OllamaProvider:
async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
  if (isTrivial(input.text)) return null;
  const model = LANGUAGE_MODEL;
  if (!model) return null;
  try {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        messages: [
          {
            role: 'system',
            content:
              'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
          },
          { role: 'user', content: input.text },
        ],
        options: { num_predict: 8 },
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as OllamaChatResponse;
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'language',
        model,
        usage: normalizeOllamaUsage(json),
      });
    }
    const text = (json.message.content ?? '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: All `detectLanguage` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama.ts tests/ai/provider/ollama.test.ts
git commit -m "feat(ollama): detectLanguage via small-prompt /api/chat call

Returns ISO 639-1 code or null. Short-circuits on trivial input,
records usage when userId is set. Mirrors the OpenAI provider's shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `OllamaProvider.proposeWizard`

**Files:**
- Modify: `src/ai/provider/ollama.ts`
- Modify: `tests/ai/provider/ollama.test.ts`

Forces a single-tool call via `tool_choice` (Ollama supports the OpenAI-shape value). Throws when no tool_call comes back.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ai/provider/ollama.test.ts`:

```ts
describe('OllamaProvider.proposeWizard', () => {
  beforeEach(() => {
    vi.mocked(recordUsage).mockClear();
  });

  it('returns toolInput from the matching tool_call', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'propose_character', arguments: { race: 'dwarf', class: 'fighter' } } },
            ],
          },
          done_reason: 'stop',
          prompt_eval_count: 20,
          eval_count: 5,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    const out = await provider.proposeWizard({
      systemPrompt: 'be a wizard helper',
      toolDefinition: {
        name: 'propose_character',
        description: 'propose',
        input_schema: { type: 'object', properties: {} } as never,
      },
      userMessage: 'I want a dwarf fighter',
    });
    expect(out.toolInput).toEqual({ race: 'dwarf', class: 'fighter' });
    expect(out.usage.inputTokens).toBe(20);
  });

  it('throws when the response has no tool_call for the requested tool', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'no thanks' },
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 2,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    await expect(
      provider.proposeWizard({
        systemPrompt: 'sys',
        toolDefinition: {
          name: 'propose_character',
          description: 'propose',
          input_schema: { type: 'object' } as never,
        },
        userMessage: 'I want a dwarf fighter',
      }),
    ).rejects.toThrow(/propose_character/);
  });

  it('records usage when userId is set', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 't', arguments: { x: 1 } } }],
          },
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 3,
        }),
        { status: 200 },
      ),
    );
    const { OllamaProvider } = await import('@/ai/provider/ollama');
    const provider = new OllamaProvider();
    await provider.proposeWizard({
      systemPrompt: 'sys',
      toolDefinition: { name: 't', description: 't', input_schema: { type: 'object' } as never },
      userMessage: 'msg',
      userId: 'user_1',
      sessionId: 'sess_1',
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'wizard', userId: 'user_1' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: FAIL — stub throws.

- [ ] **Step 3: Replace the `proposeWizard` stub**

Replace the stub in `src/ai/provider/ollama.ts`:

```ts
async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
  const model = input.model ?? MASTER_MODEL;
  if (!model) throw new Error('OllamaProvider: no model specified');
  const tool = anthropicToolToOllama(input.toolDefinition);

  const resp = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: KEEP_ALIVE,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: input.toolDefinition.name } },
      options: { num_predict: 1024 },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`ollama wizard ${resp.status}: ${detail}`);
  }
  const json = (await resp.json()) as OllamaChatResponse;
  const usage = normalizeOllamaUsage(json);
  if (input.userId) {
    await recordUsage({
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      endpoint: 'wizard',
      model,
      usage,
    });
  }
  for (const tc of json.message.tool_calls ?? []) {
    if (tc.function.name === input.toolDefinition.name) {
      const args = tc.function.arguments;
      let toolInput: Record<string, unknown> = {};
      if (typeof args === 'string') {
        try {
          toolInput = JSON.parse(args) as Record<string, unknown>;
        } catch {
          toolInput = { _raw: args };
        }
      } else {
        toolInput = args;
      }
      return { toolInput, usage };
    }
  }
  throw new Error(`AI did not call ${input.toolDefinition.name}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ai/provider/ollama.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama.ts tests/ai/provider/ollama.test.ts
git commit -m "feat(ollama): proposeWizard with forced tool_choice

Single-tool call with tool_choice enforcement. Throws if the model
declines to call the tool. Records wizard usage when userId is set.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire `OllamaProvider` into `getProviderByName`

**Files:**
- Modify: `src/ai/provider/index.ts`
- Modify: `tests/ai/provider/dispatcher.test.ts`

The dispatcher currently switches on three providers. Adds the fourth case and extends `_resetMasterProviderForTests`.

- [ ] **Step 1: Inspect the existing dispatcher test**

Run: `pnpm vitest run tests/ai/provider/dispatcher.test.ts`
Expected: PASS (existing tests untouched).

Open the file and note the pattern. Skip if confident.

- [ ] **Step 2: Add a failing test**

Append to `tests/ai/provider/dispatcher.test.ts`:

```ts
import { _resetMasterProviderForTests, getProviderByName } from '@/ai/provider';

describe('getProviderByName for ollama', () => {
  beforeEach(() => {
    _resetMasterProviderForTests();
  });

  it('returns an OllamaProvider instance', () => {
    const provider = getProviderByName('ollama');
    expect(provider.name).toBe('ollama');
  });

  it('returns the same cached instance on repeated calls', () => {
    const a = getProviderByName('ollama');
    const b = getProviderByName('ollama');
    expect(a).toBe(b);
  });

  it('returns a fresh instance after reset', () => {
    const a = getProviderByName('ollama');
    _resetMasterProviderForTests();
    const b = getProviderByName('ollama');
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/provider/dispatcher.test.ts`
Expected: FAIL — `getProviderByName('ollama')` throws "unknown provider".

- [ ] **Step 4: Modify the dispatcher**

Edit `src/ai/provider/index.ts`:

```ts
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import type { MasterProvider, ProviderName } from './types';

let _anthropic: AnthropicProvider | null = null;
let _openai: OpenAIProvider | null = null;
let _gemini: GeminiProvider | null = null;
let _ollama: OllamaProvider | null = null;

export function getProviderByName(name: ProviderName): MasterProvider {
  if (name === 'anthropic') {
    if (!_anthropic) _anthropic = new AnthropicProvider();
    return _anthropic;
  }
  if (name === 'openai') {
    if (!_openai) _openai = new OpenAIProvider();
    return _openai;
  }
  if (name === 'gemini') {
    if (!_gemini) _gemini = new GeminiProvider();
    return _gemini;
  }
  if (name === 'ollama') {
    if (!_ollama) _ollama = new OllamaProvider();
    return _ollama;
  }
  throw new Error(`unknown provider: ${String(name)}`);
}

export function getMasterProvider(): MasterProvider {
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini' || raw === 'ollama') {
    return getProviderByName(raw);
  }
  throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
}

export function _resetMasterProviderForTests(): void {
  _anthropic = null;
  _openai = null;
  _gemini = null;
  _ollama = null;
}

export type { MasterProvider, ProviderName } from './types';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/provider/dispatcher.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/ai/provider/index.ts tests/ai/provider/dispatcher.test.ts
git commit -m "feat(provider): register Ollama in getProviderByName

Cached singleton like the other three. getMasterProvider env-fallback
accepts 'ollama' as a valid value too.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Preferences integration — env defaults and validation

**Files:**
- Modify: `src/lib/preferences.ts:31` (`envDefaultProvider`)
- Modify: `src/lib/preferences.ts:38` (`envDefaultMasterModel`)
- Modify: `src/lib/preferences.ts:320` (`validateSettingsPatch`, `aiMasterModel` branch)
- Modify: `tests/lib/preferences.test.ts` (or create if missing — check first)

`envDefaultProvider` returns the env-driven default. We add Ollama as a valid value when `MASTER_PROVIDER=ollama`. Important: do **NOT** auto-downgrade when the saved provider is `'ollama'`. The user's stored value is respected even when the service is unreachable — the unreachable case surfaces as an error at turn time, per the spec's "no silent fallback" decision.

- [ ] **Step 1: Check whether `tests/lib/preferences.test.ts` exists**

Run: `ls tests/lib/preferences.test.ts 2>/dev/null || echo missing`
Expected: either the file path or "missing".

If missing, create it with a vitest skeleton:

```ts
import { describe, it, expect } from 'vitest';
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/lib/preferences.test.ts`:

```ts
import { validateSettingsPatch } from '@/lib/preferences';

describe('validateSettingsPatch for ollama', () => {
  it('accepts aiProvider=ollama', () => {
    const result = validateSettingsPatch({ aiProvider: 'ollama' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.aiProvider).toBe('ollama');
  });

  it('accepts any non-empty string as aiMasterModel when paired with ollama', () => {
    const result = validateSettingsPatch({
      aiProvider: 'ollama',
      aiMasterModel: 'qwen3:30b-a3b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.aiMasterModel).toBe('qwen3:30b-a3b');
  });

  it('rejects empty-string aiMasterModel for ollama', () => {
    const result = validateSettingsPatch({
      aiProvider: 'ollama',
      aiMasterModel: '',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects overly long aiMasterModel for ollama', () => {
    const result = validateSettingsPatch({
      aiProvider: 'ollama',
      aiMasterModel: 'x'.repeat(201),
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/preferences.test.ts`
Expected: FAIL — `isKnownProvider` already accepts 'ollama' after Task 1, but `isKnownMasterModel` rejects dynamic Ollama slugs because the existing `validateSettingsPatch` doesn't pass `provider` to it.

- [ ] **Step 4: Patch `validateSettingsPatch` to pass provider context**

Edit `src/lib/preferences.ts:320` (the `aiMasterModel` branch). The current code:

```ts
if ('aiMasterModel' in body) {
  if (body.aiMasterModel !== undefined && !isKnownMasterModel(body.aiMasterModel)) {
    return { ok: false, error: 'invalid-aiMasterModel' };
  }
  out.aiMasterModel = body.aiMasterModel as string | undefined;
}
```

Replace with:

```ts
if ('aiMasterModel' in body) {
  // Provider context for Ollama: pass whatever provider we know (in the same patch
  // or stored as a sibling). For now, we read it off the incoming patch — callers
  // that change both fields in one PATCH get full validation; callers that change
  // only the model must already have the provider stored, and validation against
  // the dynamic slug is relaxed.
  const provider = (body as { aiProvider?: ProviderName }).aiProvider;
  if (body.aiMasterModel !== undefined && !isKnownMasterModel(body.aiMasterModel, provider)) {
    return { ok: false, error: 'invalid-aiMasterModel' };
  }
  out.aiMasterModel = body.aiMasterModel as string | undefined;
}
```

Add the import at the top of `preferences.ts`:

```ts
import { isKnownProvider, isKnownMasterModel, isKnownImageProvider, isKnownImageModel, type ProviderName } from '@/lib/ai-models';
```

- [ ] **Step 5: Extend `envDefaultProvider` and `envDefaultMasterModel`**

Edit `src/lib/preferences.ts:31`:

```ts
function envDefaultProvider(): ProviderName {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  if (raw === 'ollama') return 'ollama';
  return 'anthropic';
}

function envDefaultMasterModel(provider: ProviderName): string {
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  if (provider === 'gemini') return process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
  if (provider === 'ollama') return process.env.OLLAMA_MASTER_MODEL ?? '';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}
```

Note: the empty string fallback for Ollama is intentional — the caller (turn route) will throw a clear error if no model is set, rather than picking an arbitrary one. The UI side, when Ollama is reachable and `aiMasterModel` is empty, picks the first installed model from the dynamic list.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/lib/preferences.test.ts`
Expected: All 4 new tests pass.

Run: `pnpm vitest run`
Expected: full suite still green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/preferences.ts tests/lib/preferences.test.ts
git commit -m "feat(preferences): accept ollama in settings validation

Pass the incoming provider through to isKnownMasterModel so dynamic
Ollama model slugs are accepted (≤200 chars, non-empty). Env default
provider/model resolution learns about ollama. No auto-downgrade when
the service is unreachable — explicit error at turn time per the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Settings API route — reject unreachable provider

**Files:**
- Modify: `src/app/api/campaigns/[id]/settings/route.ts`
- Modify: `src/app/api/preferences/route.ts`
- Create: `tests/app/api/campaigns/settings/route.test.ts` (new) — verify by integration with mocked probe

A PATCH that sets `aiProvider: 'ollama'` while the Ollama probe says unreachable returns HTTP 400. This prevents the user from saving a state that would immediately fail at turn time.

Inspect both routes first; the campaign-scoped one is canonical, the user-scoped one is legacy but still wired.

- [ ] **Step 1: Read both routes for the patch surface**

```bash
sed -n '60,100p' src/app/api/campaigns/[id]/settings/route.ts
sed -n '1,80p' src/app/api/preferences/route.ts
```

Note the structure — likely each calls `validateSettingsPatch(body)`, then writes to the DB.

- [ ] **Step 2: Add a probe-aware guard in the campaign route**

Locate the section in `src/app/api/campaigns/[id]/settings/route.ts` that calls `validateSettingsPatch`. After the validation passes, but before writing to the DB, add:

```ts
import { probeLocalServices } from '@/lib/local-services';

// inside the handler, after validateSettingsPatch succeeds:
if (result.patch.aiProvider === 'ollama') {
  const probe = await probeLocalServices();
  if (!probe.ollama.reachable) {
    return NextResponse.json(
      { error: 'ollama-unreachable', detail: probe.ollama.error ?? 'unknown' },
      { status: 400 },
    );
  }
}
```

Apply the same guard in `src/app/api/preferences/route.ts` if it accepts `aiProvider` patches. Skip if it doesn't.

- [ ] **Step 3: Write a unit test that exercises the guard**

Create `tests/app/api/campaigns/settings/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/local-services', () => ({
  probeLocalServices: vi.fn(),
  isLocalModeEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/preferences', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateCampaignSettings: vi.fn(async () => ({})),
    getCampaignSettings: vi.fn(async () => ({})),
  };
});

vi.mock('@/db/client', () => ({ db: {} }));

// Auth/identity helpers vary; mock minimally to let the handler run.
vi.mock('@/lib/auth', () => ({
  requireUserId: vi.fn(async () => 'user_1'),
}));

import { probeLocalServices } from '@/lib/local-services';
import { PATCH } from '@/app/api/campaigns/[id]/settings/route';

const mockedProbe = probeLocalServices as unknown as ReturnType<typeof vi.fn>;

describe('PATCH /api/campaigns/:id/settings — ollama guard', () => {
  beforeEach(() => {
    mockedProbe.mockReset();
  });

  it('returns 400 when aiProvider=ollama and Ollama is unreachable', async () => {
    mockedProbe.mockResolvedValue({
      ollama: { reachable: false, models: [], error: 'ECONNREFUSED' },
      kokoro: { reachable: false, voices: [], error: null },
      comfy: { reachable: false, error: null },
    });
    const req = new Request('http://x/api/campaigns/abc/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiProvider: 'ollama' }),
    });
    const resp = await PATCH(req, { params: Promise.resolve({ id: 'abc' }) });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('ollama-unreachable');
  });

  it('passes through when aiProvider=ollama and Ollama is reachable', async () => {
    mockedProbe.mockResolvedValue({
      ollama: { reachable: true, models: [{ slug: 'qwen3:30b-a3b', label: 'qwen3:30b-a3b', blurb: 'qwen3' }], error: null },
      kokoro: { reachable: false, voices: [], error: null },
      comfy: { reachable: false, error: null },
    });
    const req = new Request('http://x/api/campaigns/abc/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aiProvider: 'ollama', aiMasterModel: 'qwen3:30b-a3b' }),
    });
    const resp = await PATCH(req, { params: Promise.resolve({ id: 'abc' }) });
    expect([200, 204]).toContain(resp.status);
  });
});
```

The mocks above are best-effort — the actual route may have additional dependencies. If a mock is missing, the test will tell you with a clear import error; add a `vi.mock` for it.

- [ ] **Step 4: Run tests and adjust mocks as needed**

Run: `pnpm vitest run tests/app/api/campaigns/settings/route.test.ts`
Expected: PASS after any mock additions.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/[id]/settings/route.ts src/app/api/preferences/route.ts tests/app/api/campaigns/settings/route.test.ts
git commit -m "feat(api): reject aiProvider=ollama when service is unreachable

Probes Ollama in the PATCH path; returns 400 ollama-unreachable so the
user can't save a state that would immediately fail at turn time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Settings page — wire `probeLocalServices` into render

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/page.tsx`

Server component. Calls `probeLocalServices()` once at render and passes the result to the client component.

- [ ] **Step 1: Read the current page to see the existing prop wiring**

Run: `sed -n '1,80p' src/app/(authed)/campaigns/[id]/settings/page.tsx`
Identify the data already passed to `SettingsClient`.

- [ ] **Step 2: Add the probe call and pass props**

In `page.tsx`, near the existing data fetching:

```tsx
import { probeLocalServices } from '@/lib/local-services';

export default async function CampaignSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // ... existing data loading ...
  const localStatus = await probeLocalServices();

  return (
    <SettingsClient
      // ... existing props ...
      localStatus={localStatus}
    />
  );
}
```

If the props are passed through other helpers, weave `localStatus` through them the same way `ttsModel` or similar props go through today.

- [ ] **Step 3: Manual smoke (build & inspect)**

Run: `pnpm tsc --noEmit`
Expected: PASS — types align because `SettingsClient`'s prop signature will be updated in the next task. Until then, this step is expected to FAIL with a missing-prop error on `<SettingsClient localStatus={...} />`. That failure is the cue to proceed to Task 14.

- [ ] **Step 4: Commit (with a `WIP` note since types will break until Task 14)**

```bash
git add src/app/(authed)/campaigns/[id]/settings/page.tsx
git commit -m "feat(settings-page): probe local services at render

Server-component call to probeLocalServices(); result is threaded to
the client component. The matching client-side prop type is added in
the next task — typecheck will fail between these two commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Settings client — conditional Ollama radio

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`

The client component adds a fourth radio "Ollama (locale)" when `localStatus.ollama.reachable === true`. The model dropdown is sourced from `localStatus.ollama.models` instead of the static `modelsForProvider('ollama')` (which now returns `[]`).

- [ ] **Step 1: Read the existing provider-radio block**

Run: `grep -n "anthropic\|openai\|gemini\|aiProvider" src/app/(authed)/campaigns/[id]/settings/settings-client.tsx | head -30`
Locate the section that renders provider radios.

- [ ] **Step 2: Extend the props type and the provider list**

Near the top of `settings-client.tsx`:

```tsx
import type { LocalServiceStatus } from '@/lib/local-services';

interface SettingsClientProps {
  // ... existing props ...
  localStatus: LocalServiceStatus;
}
```

In the component body, replace the hardcoded provider list (or the radio loop) with:

```tsx
const masterProviders: ProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
  ...(props.localStatus.ollama.reachable ? (['ollama'] as const) : []),
];
```

For the radio labels, use a small lookup:

```tsx
const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama (locale)',
};
```

- [ ] **Step 3: Source the model dropdown from the dynamic list when Ollama is picked**

Where the model dropdown reads `modelsForProvider(prefs.aiProvider)`, branch:

```tsx
const availableModels: ModelOption[] =
  prefs.aiProvider === 'ollama'
    ? props.localStatus.ollama.models
    : modelsForProvider(prefs.aiProvider);
```

When `prefs.aiProvider === 'ollama'` and `availableModels.length === 0`, render a single disabled option:

```tsx
{availableModels.length === 0 && prefs.aiProvider === 'ollama' ? (
  <option disabled value="">
    Nessun modello scaricato. Esegui: ollama pull qwen3:30b-a3b
  </option>
) : (
  availableModels.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)
)}
```

- [ ] **Step 4: Handle the "saved-but-unreachable" UI state**

If `prefs.aiProvider === 'ollama'` but `props.localStatus.ollama.reachable === false`:
- Render the Ollama radio as **selected and disabled** with a small badge "non raggiungibile, ripristina `ollama serve`"
- Disable the Save button while this condition holds
- Show the badge text inline next to the radio

Sketch:

```tsx
const ollamaUnreachableSelected =
  prefs.aiProvider === 'ollama' && !props.localStatus.ollama.reachable;

// inside the provider radios:
{masterProviders.includes('ollama') || prefs.aiProvider === 'ollama' ? (
  <label className={ollamaUnreachableSelected ? 'opacity-50' : ''}>
    <input
      type="radio"
      name="aiProvider"
      value="ollama"
      checked={prefs.aiProvider === 'ollama'}
      onChange={(e) => onProviderChange(e.target.value as ProviderName)}
      disabled={ollamaUnreachableSelected}
    />
    {PROVIDER_LABEL.ollama}
    {ollamaUnreachableSelected && (
      <span className="ml-2 text-xs text-red-600">
        non raggiungibile — ripristina <code>ollama serve</code>
      </span>
    )}
  </label>
) : null}

// for the Save button:
<button disabled={saving || ollamaUnreachableSelected} onClick={save}>
  Salva
</button>
```

(Adapt to the actual class names / button structure in the existing file.)

- [ ] **Step 5: Type-check the repo**

Run: `pnpm tsc --noEmit`
Expected: PASS — the prop type added in Task 13 now matches.

- [ ] **Step 6: Run the relevant tests**

Run: `pnpm vitest run`
Expected: full suite green. If there is a component test for `settings-client.tsx` that hardcodes the provider list (looking at `tests/components/`), update it to include `localStatus` in its props.

- [ ] **Step 7: Commit**

```bash
git add src/app/(authed)/campaigns/[id]/settings/settings-client.tsx tests/components 2>/dev/null
git commit -m "feat(settings-ui): conditional Ollama radio + dynamic model list

Renders Ollama (locale) as a fourth provider option when the local
probe says it is reachable. Model dropdown is sourced from the dynamic
probe list. Selected-but-unreachable state is shown as disabled with a
recovery hint; Save is blocked while in that state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Turn-route guard for stale Ollama selection

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

Per the spec, if a session's resolved settings say `aiProvider: 'ollama'` but the service is unreachable at turn time, the route should fail fast with an explicit error rather than letting `OllamaProvider.completeMessage` crash with an unstructured fetch error.

- [ ] **Step 1: Locate the existing provider dispatch in the turn route**

Run: `grep -n "getProviderByName\|aiProvider" src/app/api/sessions/[id]/turn/route.ts`
Find the line that picks the provider.

- [ ] **Step 2: Add the probe guard**

Before the `getProviderByName(userPrefs.aiProvider)` call:

```ts
import { probeLocalServices } from '@/lib/local-services';

if (userPrefs.aiProvider === 'ollama') {
  const probe = await probeLocalServices();
  if (!probe.ollama.reachable) {
    return new Response(
      JSON.stringify({ error: 'ollama-unreachable', detail: probe.ollama.error ?? 'unknown' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
}
```

The 503 propagates as a `turn_error` event in the SSE stream the same way the existing recoverable failures do.

- [ ] **Step 3: Write a unit test**

Create or extend `tests/app/api/sessions/turn-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/local-services', () => ({
  probeLocalServices: vi.fn(),
  isLocalModeEnabled: vi.fn(() => true),
}));

// Mock the resolved-prefs helper so we can force aiProvider:'ollama'.
vi.mock('@/lib/preferences', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSessionMasterPreferences: vi.fn(async () => ({
      aiProvider: 'ollama',
      aiMasterModel: 'qwen3:30b-a3b',
      // other required fields filled in as the real return type dictates
    })),
  };
});

import { probeLocalServices } from '@/lib/local-services';
import { POST } from '@/app/api/sessions/[id]/turn/route';

describe('turn route — ollama guard', () => {
  beforeEach(() => {
    vi.mocked(probeLocalServices).mockReset();
  });

  it('returns 503 when ollama is selected but unreachable', async () => {
    vi.mocked(probeLocalServices).mockResolvedValue({
      ollama: { reachable: false, models: [], error: 'ECONNREFUSED' },
      kokoro: { reachable: false, voices: [], error: null },
      comfy: { reachable: false, error: null },
    });
    const req = new Request('http://x/api/sessions/abc/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    const resp = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('ollama-unreachable');
  });
});
```

If the route requires additional mocks (auth, DB), copy them from any neighbouring turn-route test in `tests/app/api/sessions/`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/app/api/sessions/turn-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sessions/[id]/turn/route.ts tests/app/api/sessions/turn-route.test.ts
git commit -m "feat(turn-route): fail fast when ollama is selected but unreachable

503 with ollama-unreachable error so the SSE stream surfaces a clear
turn_error instead of an opaque fetch failure deep in the provider.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Manual smoke test

**Files:** none (documentation in the plan only).

End-to-end validation on a developer machine with all of Ollama's prereqs:

- [ ] **Step 1: Boot Ollama and pull a model**

In a separate terminal:
```bash
ollama serve   # if not already running
ollama pull qwen3:30b-a3b   # or whatever was already downloaded for the benchmark
```

- [ ] **Step 2: Run the dev server**

```bash
pnpm dev
```

Open http://localhost:3000

- [ ] **Step 3: Open campaign Settings and verify the Ollama radio appears**

Navigate to a campaign → Settings. Expected:
- Four radios for "AI Provider": Anthropic, OpenAI, Gemini, **Ollama (locale)**
- Picking Ollama populates the model dropdown with the installed Ollama models

- [ ] **Step 4: Save and run a turn**

Switch to Ollama, pick the model, click Save. Enter a player message in the session. Expected:
- The master responds in narrative prose (Italian, matching the player's language)
- No `<think>` blocks leaked into the visible reply
- Tool calls (roll_d20, etc.) execute and reflect in the response prose

- [ ] **Step 5: Verify the unreachable-state UI**

In the Ollama terminal: `Ctrl-C` to stop `ollama serve`. Refresh the Settings page in the browser. Expected:
- "Ollama (locale)" radio is selected but disabled
- Badge text: "non raggiungibile — ripristina `ollama serve`"
- Save button is disabled

Restart `ollama serve`, refresh: UI returns to normal.

- [ ] **Step 6: Verify production-like behavior**

In another terminal:
```bash
NODE_ENV=production pnpm build && NODE_ENV=production pnpm start
```

(or set `VERCEL=1 pnpm dev` for a faster check)

Open Settings. Expected: only 3 radios — Anthropic, OpenAI, Gemini. No Ollama option even if `ollama serve` is running.

- [ ] **Step 7: Document any quirks**

If anything is off (e.g., empty model list when models are pulled, badge text doesn't render), note it in a comment block at the bottom of this plan file and address before declaring done.

There is no commit for this task — it's a verification gate.

---

## Self-review checklist

After completing all tasks, verify:

1. **Spec coverage** — every section of `2026-05-15-local-ai-providers-design.md` related to the LLM tier and shared infrastructure is implemented. TTS/image are explicitly out of scope for this plan.
2. **No silent fallback** — both the API route (Task 12) and the turn route (Task 15) reject `aiProvider: 'ollama'` when unreachable, surfacing explicit errors.
3. **Thinking mode default-off** — verified by the test suite in Task 6.
4. **Production-safe** — Task 16 step 6 verifies the Ollama option disappears in production-like environments.
5. **All tests green** — run `pnpm vitest run` after the last commit and confirm a clean suite.
6. **`pnpm tsc --noEmit` clean** — no leftover type errors from union widening.
