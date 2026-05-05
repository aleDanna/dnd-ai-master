# Gemini Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gemini as a third master provider (alongside Anthropic and OpenAI) and a separate per-user `imageProvider` preference (OpenAI default / Gemini) with `imageModel` selector. Implementation mirrors the existing multi-provider pattern.

**Architecture:** New `GeminiProvider` implements the existing `MasterProvider` interface using `@google/genai` SDK. A new `gemini-adapter.ts` converts canonical Anthropic-shape messages/tools to/from Gemini's `Content[]` / `functionCall` shape. Image generation is refactored: `scene-image-job.ts` accepts `provider`+`model` and dispatches to `image-providers/openai.ts` (existing logic) or `image-providers/gemini.ts` (new). User preferences gain `imageProvider` and `imageModel`.

**Tech Stack:** TypeScript, Next.js 16 App Router, vitest, Drizzle ORM (JSONB prefs), `@google/genai` SDK (new dep), existing `@anthropic-ai/sdk` and `openai` SDKs.

**Spec:** [docs/superpowers/specs/2026-05-05-gemini-provider-design.md](../specs/2026-05-05-gemini-provider-design.md)

---

## File map

**New:**
- `src/ai/provider/gemini.ts` — `GeminiProvider` class
- `src/ai/provider/gemini-adapter.ts` — Anthropic↔Gemini conversions
- `src/sessions/image-providers/openai.ts` — extracted OpenAI image generation
- `src/sessions/image-providers/gemini.ts` — Gemini image generation
- `tests/ai/provider/gemini-adapter.test.ts`
- `tests/ai/provider/gemini.test.ts`
- `tests/sessions/image-providers-gemini.test.ts`

**Modified:**
- `src/ai/provider/types.ts` — `ProviderName` union extended
- `src/ai/provider/index.ts` — dispatcher handles `'gemini'`
- `src/lib/ai-models.ts` — Gemini master + image models, image-provider helpers
- `src/db/schema/users.ts` — `aiProvider` union, new `imageProvider`/`imageModel`
- `src/lib/preferences.ts` — defaults for Gemini + image provider
- `src/app/api/preferences/route.ts` — validation for `imageProvider`/`imageModel`
- `src/sessions/scene-image-job.ts` — dispatches to provider-specific impl
- `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts` — passes prefs through
- `src/app/(authed)/settings/settings-client.tsx` — Gemini radio + image provider UI
- `tests/ai/provider/dispatcher.test.ts` — `'gemini'` now valid
- `tests/sessions/scene-image-job.test.ts` — new signature
- `package.json` — add `@google/genai`

---

## Task 1: Add `@google/genai` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

Run: `pnpm add @google/genai`
Expected: dependency added to `package.json`, lockfile updated.

- [ ] **Step 2: Verify it imports**

Run: `node -e "console.log(Object.keys(require('@google/genai')).slice(0,10))"`
Expected: prints an array including `GoogleGenAI`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add @google/genai for Gemini provider"
```

---

## Task 2: Extend `ProviderName` to include `'gemini'`

**Files:**
- Modify: `src/ai/provider/types.ts:3`

- [ ] **Step 1: Update the union**

Replace:
```ts
export type ProviderName = 'anthropic' | 'openai';
```
with:
```ts
export type ProviderName = 'anthropic' | 'openai' | 'gemini';
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: errors at `src/ai/provider/index.ts:18` (dispatcher exhaustiveness) and `src/lib/ai-models.ts` (`isKnownProvider`, `modelsForProvider`). These are fixed by later tasks; for now confirm the failures match those locations only.

- [ ] **Step 3: Do NOT commit yet** — wait until the dispatcher and ai-models updates land in Tasks 3-5 to keep typecheck green per commit.

---

## Task 3: Add Gemini master + image model catalogs to `ai-models.ts`

**Files:**
- Modify: `src/lib/ai-models.ts`

- [ ] **Step 1: Replace the file with the full new contents**

Replace the entire contents of `src/lib/ai-models.ts` with:

```ts
/**
 * Browser-safe model catalogs for the settings UI. Both server and client can import
 * this file. The "slug" is the value shipped to the provider's API; the label is for
 * the dropdown. Picking a slug that the underlying account doesn't have access to
 * will surface as a provider 404/permission error at request time — a clear,
 * actionable failure.
 */

export type ProviderName = 'anthropic' | 'openai' | 'gemini';
export type ImageProviderName = 'openai' | 'gemini';

export interface ModelOption {
  slug: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

export const ANTHROPIC_MASTER_MODELS: ModelOption[] = [
  {
    slug: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    blurb: 'Most capable; slowest and most expensive.',
  },
  {
    slug: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    blurb: 'Balanced speed and quality.',
    recommended: true,
  },
  {
    slug: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    blurb: 'Fast, cheap, smaller context.',
  },
];

export const OPENAI_MASTER_MODELS: ModelOption[] = [
  { slug: 'gpt-5.5', label: 'GPT-5.5', blurb: 'Latest flagship.' },
  { slug: 'gpt-5.5-mini', label: 'GPT-5.5 mini', blurb: 'Smaller, faster 5.5.' },
  { slug: 'gpt-5', label: 'GPT-5', blurb: 'Stable flagship.', recommended: true },
  { slug: 'gpt-5-mini', label: 'GPT-5 mini', blurb: 'Smaller, faster 5.' },
  { slug: 'gpt-4.1', label: 'GPT-4.1', blurb: 'Previous-gen flagship; battle-tested with tools.' },
];

export const GEMINI_MASTER_MODELS: ModelOption[] = [
  {
    slug: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    blurb: 'Most capable; deep reasoning.',
    recommended: true,
  },
  {
    slug: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    blurb: 'Balanced speed and quality.',
  },
  {
    slug: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    blurb: 'Fastest, cheapest, smaller context.',
  },
];

export const OPENAI_IMAGE_MODELS: ModelOption[] = [
  { slug: 'gpt-image-1', label: 'GPT Image 1', blurb: 'Current default; high quality.', recommended: true },
];

export const GEMINI_IMAGE_MODELS: ModelOption[] = [
  {
    slug: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    blurb: 'Fast and cheap; good defaults.',
    recommended: true,
  },
  {
    slug: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    blurb: 'Higher quality; slower and pricier.',
  },
];

export function modelsForProvider(p: ProviderName): ModelOption[] {
  if (p === 'anthropic') return ANTHROPIC_MASTER_MODELS;
  if (p === 'openai') return OPENAI_MASTER_MODELS;
  return GEMINI_MASTER_MODELS;
}

export function defaultModelForProvider(p: ProviderName): string {
  const list = modelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function imageModelsForProvider(p: ImageProviderName): ModelOption[] {
  return p === 'openai' ? OPENAI_IMAGE_MODELS : GEMINI_IMAGE_MODELS;
}

export function defaultImageModelForProvider(p: ImageProviderName): string {
  const list = imageModelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

export function isKnownImageProvider(value: unknown): value is ImageProviderName {
  return value === 'openai' || value === 'gemini';
}

/** Validates that the slug is in the union of known master model slugs. */
export function isKnownMasterModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS, ...GEMINI_MASTER_MODELS].some(
    (m) => m.slug === value,
  );
}

/** Validates that the slug is in the union of known image model slugs. */
export function isKnownImageModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return [...OPENAI_IMAGE_MODELS, ...GEMINI_IMAGE_MODELS].some((m) => m.slug === value);
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: still failing at `src/ai/provider/index.ts:18` (handled in Task 4). No other errors from `ai-models.ts`.

---

## Task 4: Update provider dispatcher to handle `'gemini'`

**Files:**
- Modify: `src/ai/provider/index.ts`

- [ ] **Step 1: Replace dispatcher**

Replace the entire file with:

```ts
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import type { MasterProvider, ProviderName } from './types';

let _anthropic: AnthropicProvider | null = null;
let _openai: OpenAIProvider | null = null;
let _gemini: GeminiProvider | null = null;

/** Returns a cached MasterProvider instance for the named provider. Lazy. */
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
  throw new Error(`unknown provider: ${String(name)}`);
}

/**
 * Backward-compatible env-based dispatcher. Used by tests and any callsite that
 * doesn't have a per-user preference (e.g. internal scripts). Per-user routes should
 * call getProviderByName(prefs.aiProvider) directly.
 */
export function getMasterProvider(): MasterProvider {
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini') return getProviderByName(raw);
  throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
}

/** Test/dev-only helper: clear the cached singletons. */
export function _resetMasterProviderForTests(): void {
  _anthropic = null;
  _openai = null;
  _gemini = null;
}

export type { MasterProvider, ProviderName } from './types';
```

- [ ] **Step 2: Typecheck will fail**

Run: `pnpm typecheck`
Expected: fails because `./gemini` doesn't exist yet. This is expected — Task 7 creates it. Tasks 2-4 must be committed together with Task 7's stub to keep CI green.

---

## Task 5: Stub `gemini.ts` so dispatcher imports compile

**Files:**
- Create: `src/ai/provider/gemini.ts`

- [ ] **Step 1: Create a minimal stub**

```ts
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';

export class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(_input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    throw new Error('GeminiProvider.completeMessage not implemented yet');
  }

  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('GeminiProvider.detectLanguage not implemented yet');
  }

  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('GeminiProvider.proposeWizard not implemented yet');
  }
}
```

- [ ] **Step 2: Typecheck passes**

Run: `pnpm typecheck`
Expected: PASS. The stub compiles even though it throws at runtime.

- [ ] **Step 3: Commit Tasks 2-5 together**

```bash
git add src/ai/provider/types.ts src/ai/provider/index.ts src/ai/provider/gemini.ts src/lib/ai-models.ts
git commit -m "feat(provider): scaffold Gemini provider type + dispatcher

ProviderName union now includes 'gemini'; dispatcher routes through
GeminiProvider stub; ai-models gains GEMINI_MASTER_MODELS,
image-provider helpers, and image model catalogs. Stub throws on call —
real implementation in follow-up commits."
```

---

## Task 6: Update existing dispatcher test for `'gemini'` validity

**Files:**
- Modify: `tests/ai/provider/dispatcher.test.ts:31-34`

- [ ] **Step 1: Replace the "throws for gemini" case**

Replace:
```ts
  it('throws for an unknown MASTER_PROVIDER value', () => {
    process.env.MASTER_PROVIDER = 'gemini';
    expect(() => getMasterProvider()).toThrow(/unknown MASTER_PROVIDER: gemini/);
  });
```
with:
```ts
  it('returns gemini for MASTER_PROVIDER=gemini', () => {
    process.env.MASTER_PROVIDER = 'gemini';
    expect(getMasterProvider().name).toBe('gemini');
  });

  it('throws for an unknown MASTER_PROVIDER value', () => {
    process.env.MASTER_PROVIDER = 'cohere';
    expect(() => getMasterProvider()).toThrow(/unknown MASTER_PROVIDER: cohere/);
  });
```

- [ ] **Step 2: Run the test**

Run: `pnpm test tests/ai/provider/dispatcher.test.ts`
Expected: 4 tests PASS (was 4: the new `gemini` case + the renamed unknown case + 2 existing).

- [ ] **Step 3: Commit**

```bash
git add tests/ai/provider/dispatcher.test.ts
git commit -m "test(provider): dispatcher accepts MASTER_PROVIDER=gemini"
```

---

## Task 7: Create `gemini-adapter.ts` — system blocks + tool definitions

**Files:**
- Create: `src/ai/provider/gemini-adapter.ts`
- Test: `tests/ai/provider/gemini-adapter.test.ts`

- [ ] **Step 1: Write the failing test for system + tool conversions**

Create `tests/ai/provider/gemini-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ToolDef } from '@/ai/provider/types';
import {
  anthropicToolToGemini,
  flattenSystemBlocksForGemini,
} from '@/ai/provider/gemini-adapter';

describe('gemini-adapter — system + tools', () => {
  it('flattens system blocks to a single instruction string and drops cache_control', () => {
    const out = flattenSystemBlocksForGemini([
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'B' },
    ]);
    expect(out).toEqual({ parts: [{ text: 'A\n\nB' }] });
  });

  it('returns null when there are no system blocks', () => {
    expect(flattenSystemBlocksForGemini([])).toBeNull();
  });

  it('converts a tool definition: input_schema → parameters, additionalProperties stripped', () => {
    const tool: ToolDef = {
      name: 'roll_d20',
      description: 'roll a d20',
      input_schema: {
        type: 'object',
        required: ['mod'],
        properties: { mod: { type: 'number' } },
        additionalProperties: false,
      } as never,
    };
    const out = anthropicToolToGemini(tool);
    expect(out.name).toBe('roll_d20');
    expect(out.description).toBe('roll a d20');
    expect(out.parameters).toEqual({
      type: 'object',
      required: ['mod'],
      properties: { mod: { type: 'number' } },
    });
  });

  it('handles tool with missing description (defaults to empty string)', () => {
    const tool: ToolDef = {
      name: 'noop',
      input_schema: { type: 'object', properties: {} } as never,
    };
    const out = anthropicToolToGemini(tool);
    expect(out.description).toBe('');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: FAIL — module `@/ai/provider/gemini-adapter` not found.

- [ ] **Step 3: Create adapter with system + tool helpers**

Create `src/ai/provider/gemini-adapter.ts`:

```ts
import type { SystemBlock, ToolDef } from './types';

export interface GeminiSystemInstruction {
  parts: { text: string }[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Strip JSON-Schema fields Gemini rejects on some schema versions
 * (notably `additionalProperties`). Recursive shallow walk; only top-level
 * `properties.*.*` are descended — sufficient for our 18 engine tools.
 */
function stripUnsupportedSchemaFields(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _drop, ...rest } = schema;
  if (rest.properties && typeof rest.properties === 'object') {
    const props = rest.properties as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      cleaned[k] = v && typeof v === 'object'
        ? stripUnsupportedSchemaFields(v as Record<string, unknown>)
        : v;
    }
    rest.properties = cleaned;
  }
  return rest;
}

/** Anthropic system blocks → Gemini systemInstruction. Null when empty. */
export function flattenSystemBlocksForGemini(
  blocks: SystemBlock[],
): GeminiSystemInstruction | null {
  if (blocks.length === 0) return null;
  const text = blocks.map((b) => b.text).join('\n\n');
  return { parts: [{ text }] };
}

/** Anthropic tool def → Gemini functionDeclaration. */
export function anthropicToolToGemini(tool: ToolDef): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: stripUnsupportedSchemaFields(tool.input_schema as Record<string, unknown>),
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/gemini-adapter.ts tests/ai/provider/gemini-adapter.test.ts
git commit -m "feat(provider): gemini-adapter — system blocks + tool defs"
```

---

## Task 8: Extend `gemini-adapter.ts` — message history conversion

**Files:**
- Modify: `src/ai/provider/gemini-adapter.ts`
- Modify: `tests/ai/provider/gemini-adapter.test.ts`

- [ ] **Step 1: Add failing tests for message conversions**

Append to `tests/ai/provider/gemini-adapter.test.ts`:

```ts
import { anthropicMessagesToGemini } from '@/ai/provider/gemini-adapter';
import type { Message } from '@/ai/provider/types';

describe('gemini-adapter — messages', () => {
  it('passes user string message through as a parts:[{text}]', () => {
    const out = anthropicMessagesToGemini([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('collapses assistant text blocks into model role', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi ', citations: null } as never,
          { type: 'text', text: 'there.', citations: null } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([{ role: 'model', parts: [{ text: 'Hi there.' }] }]);
  });

  it('converts assistant text + tool_use → model parts with text + functionCall', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Rolling…', citations: null } as never,
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { mod: 3 } } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'Rolling…' },
          { functionCall: { name: 'roll_d20', args: { mod: 3 } } },
        ],
      },
    ]);
  });

  it('fans out N tool_results into a single user turn with N functionResponse parts', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: {} } as never,
          { type: 'tool_use', id: 'tu2', name: 'apply_damage', input: {} } as never,
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok-1', is_error: false } as never,
          { type: 'tool_result', tool_use_id: 'tu2', content: 'err', is_error: true } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    // 2 entries: model with 2 functionCalls, then user with 2 functionResponse parts
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'roll_d20', response: { content: 'ok-1' } } },
        { functionResponse: { name: 'apply_damage', response: { content: 'err', error: true } } },
      ],
    });
  });

  it('falls back to "unknown" function name when tool_result references an unseen tool_use_id', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'orphan', content: 'r', is_error: false } as never,
        ],
      },
    ];
    const out = anthropicMessagesToGemini(msgs);
    expect(out).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'unknown', response: { content: 'r' } } }],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: FAIL — `anthropicMessagesToGemini` not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/ai/provider/gemini-adapter.ts`:

```ts
import type { Anthropic } from '@anthropic-ai/sdk';
import type { Message } from './types';

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Anthropic message history → Gemini Content[]. Looks back at assistant tool_use
 * blocks to recover the function name for each tool_result (Gemini matches by name). */
export function anthropicMessagesToGemini(messages: Message[]): GeminiContent[] {
  // First pass: build tool_use_id → function name map from all assistant turns.
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') idToName.set(block.id, block.name);
    }
  }

  const out: GeminiContent[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      const text = msg.content
        .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) parts.push({ text });
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            },
          });
        }
      }
      if (parts.length === 0) continue;
      out.push({ role: 'model', parts });
      continue;
    }

    // role === 'user' with content blocks
    const toolResults = msg.content.filter(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === 'tool_result',
    );
    if (toolResults.length > 0) {
      const parts: GeminiPart[] = toolResults.map((tr) => {
        const name = idToName.get(tr.tool_use_id) ?? 'unknown';
        const content =
          typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
        const response: Record<string, unknown> = { content };
        if (tr.is_error) response.error = true;
        return { functionResponse: { name, response } };
      });
      out.push({ role: 'user', parts });
      continue;
    }

    // Plain user text blocks
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    out.push({ role: 'user', parts: [{ text }] });
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: 9 tests PASS (4 from Task 7 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/gemini-adapter.ts tests/ai/provider/gemini-adapter.test.ts
git commit -m "feat(provider): gemini-adapter — message history conversion"
```

---

## Task 9: Extend `gemini-adapter.ts` — response parsing + usage normalization

**Files:**
- Modify: `src/ai/provider/gemini-adapter.ts`
- Modify: `tests/ai/provider/gemini-adapter.test.ts`

- [ ] **Step 1: Add failing tests for response + usage**

Append to `tests/ai/provider/gemini-adapter.test.ts`:

```ts
import {
  geminiResponseToContentBlocks,
  geminiFinishReasonToStopReason,
  normalizeGeminiUsage,
} from '@/ai/provider/gemini-adapter';

describe('gemini-adapter — response + usage', () => {
  it('text-only response → text content block', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [{ content: { role: 'model', parts: [{ text: 'You see a dragon.' }] } }],
    });
    expect(blocks).toEqual([{ type: 'text', text: 'You see a dragon.' }]);
  });

  it('functionCall-only response → tool_use block with synthetic id', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'roll_d20', args: { mod: 5 } } }],
          },
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.type).toBe('tool_use');
    if (b.type === 'tool_use') {
      expect(b.name).toBe('roll_d20');
      expect(b.input).toEqual({ mod: 5 });
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
    }
  });

  it('mixed text + functionCall → mixed blocks', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Rolling…' },
              { functionCall: { name: 'roll_d20', args: {} } },
            ],
          },
        },
      ],
    });
    expect(blocks[0]).toEqual({ type: 'text', text: 'Rolling…' });
    expect(blocks[1]?.type).toBe('tool_use');
  });

  it('functionCall with string args → JSON.parse fallback to _raw', () => {
    const blocks = geminiResponseToContentBlocks({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'r', args: '{ not json' as unknown as Record<string, unknown> } }],
          },
        },
      ],
    });
    expect(blocks[0]?.type).toBe('tool_use');
    if (blocks[0]?.type === 'tool_use') expect(blocks[0].input).toEqual({ _raw: '{ not json' });
  });

  it('finishReason mapping covers STOP/MAX_TOKENS/SAFETY/RECITATION', () => {
    expect(geminiFinishReasonToStopReason('STOP', false)).toBe('end_turn');
    expect(geminiFinishReasonToStopReason('STOP', true)).toBe('tool_use');
    expect(geminiFinishReasonToStopReason('MAX_TOKENS', false)).toBe('max_tokens');
    expect(geminiFinishReasonToStopReason('SAFETY', false)).toBe('other');
    expect(geminiFinishReasonToStopReason('RECITATION', false)).toBe('other');
    expect(geminiFinishReasonToStopReason(undefined, false)).toBe('other');
  });

  it('usage normalization with all fields present', () => {
    const out = normalizeGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 25,
      cachedContentTokenCount: 80,
    });
    expect(out).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('usage normalization with missing fields returns zeros', () => {
    expect(normalizeGeminiUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(normalizeGeminiUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: FAIL — three new functions not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/ai/provider/gemini-adapter.ts`:

```ts
import type { ContentBlock, NormalizedUsage } from './types';

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: GeminiUsageMetadata;
}

export function geminiResponseToContentBlocks(response: GeminiResponse): ContentBlock[] {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if ('text' in part && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if ('functionCall' in part && part.functionCall) {
      const { name, args } = part.functionCall;
      let input: Record<string, unknown>;
      if (typeof args === 'string') {
        try {
          input = JSON.parse(args) as Record<string, unknown>;
        } catch {
          input = { _raw: args };
        }
      } else {
        input = (args ?? {}) as Record<string, unknown>;
      }
      blocks.push({ type: 'tool_use', id: crypto.randomUUID(), name, input });
    }
  }
  return blocks;
}

export function geminiFinishReasonToStopReason(
  reason: string | undefined,
  hasFunctionCall: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'other' {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'STOP') return hasFunctionCall ? 'tool_use' : 'end_turn';
  return 'other';
}

export function normalizeGeminiUsage(usage: GeminiUsageMetadata | undefined): NormalizedUsage {
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    cacheCreationTokens: 0,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini-adapter.test.ts`
Expected: 16 tests PASS (9 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/gemini-adapter.ts tests/ai/provider/gemini-adapter.test.ts
git commit -m "feat(provider): gemini-adapter — response parsing + usage"
```

---

## Task 10: Implement `GeminiProvider.completeMessage`

**Files:**
- Modify: `src/ai/provider/gemini.ts`
- Create: `tests/ai/provider/gemini.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/provider/gemini.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class FakeGenAI {
      models = { generateContent };
    },
  };
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MASTER_MODEL = 'gemini-2.5-pro';
process.env.GEMINI_LANGUAGE_MODEL = 'gemini-2.5-flash-lite';

const { GeminiProvider } = await import('@/ai/provider/gemini');

describe('GeminiProvider', () => {
  it('completeMessage routes systemBlocks → systemInstruction, sends tools, normalizes response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'roll_d20', args: { mod: 3 } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, cachedContentTokenCount: 80 },
    });

    const provider = new GeminiProvider();
    const out = await provider.completeMessage({
      systemBlocks: [{ type: 'text', text: 'be the master' }],
      messages: [{ role: 'user', content: 'roll please' }],
      tools: [
        {
          name: 'roll_d20',
          description: 'roll',
          input_schema: { type: 'object', properties: { mod: { type: 'number' } } } as never,
        },
      ],
    });

    expect(generateContent).toHaveBeenCalledOnce();
    const args = generateContent.mock.calls[0]![0] as {
      model: string;
      contents: unknown[];
      config: { systemInstruction: unknown; tools: unknown };
    };
    expect(args.model).toBe('gemini-2.5-pro');
    expect(args.config.systemInstruction).toEqual({ parts: [{ text: 'be the master' }] });
    expect(args.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'roll_d20',
            description: 'roll',
            parameters: { type: 'object', properties: { mod: { type: 'number' } } },
          },
        ],
      },
    ]);

    expect(out.stopReason).toBe('tool_use');
    expect(out.contentBlocks).toHaveLength(1);
    expect(out.contentBlocks[0]?.type).toBe('tool_use');
    if (out.contentBlocks[0]?.type === 'tool_use') {
      expect(out.contentBlocks[0].name).toBe('roll_d20');
      expect(out.contentBlocks[0].input).toEqual({ mod: 3 });
    }
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('completeMessage uses model override when provided', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    await provider.completeMessage({
      systemBlocks: [{ type: 'text', text: 's' }],
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      model: 'gemini-2.5-flash',
    });
    const args = generateContent.mock.calls.at(-1)![0] as { model: string };
    expect(args.model).toBe('gemini-2.5-flash');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: FAIL — `GeminiProvider.completeMessage not implemented yet`.

- [ ] **Step 3: Replace stub with completeMessage implementation**

Replace `src/ai/provider/gemini.ts` with:

```ts
import { GoogleGenAI } from '@google/genai';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicMessagesToGemini,
  anthropicToolToGemini,
  flattenSystemBlocksForGemini,
  geminiFinishReasonToStopReason,
  geminiResponseToContentBlocks,
  normalizeGeminiUsage,
  type GeminiResponse,
} from './gemini-adapter';

const MASTER_MODEL = process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
const LANGUAGE_MODEL = process.env.GEMINI_LANGUAGE_MODEL ?? 'gemini-2.5-flash-lite';

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const client = getClient();
    const systemInstruction = flattenSystemBlocksForGemini(input.systemBlocks);
    const contents = anthropicMessagesToGemini(input.messages);
    const functionDeclarations = input.tools.map(anthropicToolToGemini);

    const response = (await client.models.generateContent({
      model: input.model ?? MASTER_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
        maxOutputTokens: input.maxTokens ?? 4096,
      },
    })) as GeminiResponse;

    const contentBlocks = geminiResponseToContentBlocks(response);
    const hasFunctionCall = contentBlocks.some((b) => b.type === 'tool_use');
    return {
      contentBlocks,
      stopReason: geminiFinishReasonToStopReason(
        response.candidates?.[0]?.finishReason,
        hasFunctionCall,
      ),
      usage: normalizeGeminiUsage(response.usageMetadata),
    };
  }

  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('GeminiProvider.detectLanguage not implemented yet');
  }

  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('GeminiProvider.proposeWizard not implemented yet');
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/gemini.ts tests/ai/provider/gemini.test.ts
git commit -m "feat(provider): GeminiProvider.completeMessage"
```

---

## Task 11: Implement `GeminiProvider.detectLanguage`

**Files:**
- Modify: `src/ai/provider/gemini.ts`
- Modify: `tests/ai/provider/gemini.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/ai/provider/gemini.test.ts`:

```ts
describe('GeminiProvider.detectLanguage', () => {
  it('returns null for trivial text without calling the API', async () => {
    const provider = new GeminiProvider();
    const before = generateContent.mock.calls.length;
    const code = await provider.detectLanguage({ text: 'ok' });
    expect(code).toBeNull();
    expect(generateContent.mock.calls.length).toBe(before);
  });

  it('returns lowercase 2-letter code from Gemini response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'IT' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBe('it');
    const args = generateContent.mock.calls.at(-1)![0] as { model: string };
    expect(args.model).toBe('gemini-2.5-flash-lite');
  });

  it('returns null when response is not a 2-letter code', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'italian' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBeNull();
  });

  it('returns null when SDK throws', async () => {
    generateContent.mockRejectedValueOnce(new Error('boom'));
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: FAIL — `GeminiProvider.detectLanguage not implemented yet`.

- [ ] **Step 3: Replace `detectLanguage` stub**

In `src/ai/provider/gemini.ts`, add an import for `recordUsage`:

```ts
import { recordUsage } from '@/ai/master/usage';
```

Add a trivial-text helper near the top (after `LANGUAGE_MODEL`):

```ts
const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}
```

Replace the `detectLanguage` method with:

```ts
  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    const client = getClient();
    try {
      const response = (await client.models.generateContent({
        model: LANGUAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
        config: {
          systemInstruction: {
            parts: [{
              text:
                'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
            }],
          },
          maxOutputTokens: 8,
        },
      })) as GeminiResponse;
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: LANGUAGE_MODEL,
          usage: normalizeGeminiUsage(response.usageMetadata),
        });
      }
      const text = response.candidates?.[0]?.content?.parts
        ?.map((p) => ('text' in p && p.text) || '')
        .join('')
        .trim()
        .toLowerCase() ?? '';
      return /^[a-z]{2}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: 6 tests PASS (2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/gemini.ts tests/ai/provider/gemini.test.ts
git commit -m "feat(provider): GeminiProvider.detectLanguage"
```

---

## Task 12: Implement `GeminiProvider.proposeWizard`

**Files:**
- Modify: `src/ai/provider/gemini.ts`
- Modify: `tests/ai/provider/gemini.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/ai/provider/gemini.test.ts`:

```ts
describe('GeminiProvider.proposeWizard', () => {
  it('forces tool call via toolConfig and returns parsed input', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'propose_choice',
                  args: { step: 'race', value: 'half-elf', reasoning: 'versatile' },
                },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
    });

    const provider = new GeminiProvider();
    const out = await provider.proposeWizard({
      systemPrompt: 'You are a wizard helper.',
      toolDefinition: {
        name: 'propose_choice',
        description: 'propose a value',
        input_schema: {
          type: 'object',
          required: ['step', 'value', 'reasoning'],
          properties: {
            step: { type: 'string' },
            value: {},
            reasoning: { type: 'string' },
          },
        } as never,
      },
      userMessage: 'pick a race',
    });
    expect(out.toolInput).toEqual({ step: 'race', value: 'half-elf', reasoning: 'versatile' });

    const args = generateContent.mock.calls.at(-1)![0] as {
      config: { toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } } };
    };
    expect(args.config.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(args.config.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(['propose_choice']);
  });

  it('throws when no functionCall is returned', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'sorry' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    });
    const provider = new GeminiProvider();
    await expect(
      provider.proposeWizard({
        systemPrompt: 's',
        toolDefinition: { name: 'tool_x', input_schema: { type: 'object', properties: {} } as never },
        userMessage: 'm',
      }),
    ).rejects.toThrow(/AI did not call tool_x/);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: FAIL — `GeminiProvider.proposeWizard not implemented yet`.

- [ ] **Step 3: Replace `proposeWizard` stub**

In `src/ai/provider/gemini.ts`, replace the `proposeWizard` method with:

```ts
  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const client = getClient();
    const tool = anthropicToolToGemini(input.toolDefinition);
    const model = input.model ?? MASTER_MODEL;
    const response = (await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: input.userMessage }] }],
      config: {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        tools: [{ functionDeclarations: [tool] }],
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [input.toolDefinition.name],
          },
        },
        maxOutputTokens: 1024,
      },
    })) as GeminiResponse;

    const usage = normalizeGeminiUsage(response.usageMetadata);
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model,
        usage,
      });
    }

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if ('functionCall' in part && part.functionCall?.name === input.toolDefinition.name) {
        const args = part.functionCall.args;
        let toolInput: Record<string, unknown>;
        if (typeof args === 'string') {
          try {
            toolInput = JSON.parse(args) as Record<string, unknown>;
          } catch {
            toolInput = { _raw: args };
          }
        } else {
          toolInput = (args ?? {}) as Record<string, unknown>;
        }
        return { toolInput, usage };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/ai/provider/gemini.test.ts`
Expected: 8 tests PASS (6 + 2 new).

- [ ] **Step 5: Run full provider test suite to confirm nothing regressed**

Run: `pnpm test tests/ai/provider/`
Expected: all dispatcher, adapter, openai, gemini, gemini-adapter tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/provider/gemini.ts tests/ai/provider/gemini.test.ts
git commit -m "feat(provider): GeminiProvider.proposeWizard"
```

---

## Task 13: Extend `UserPreferences` schema with `imageProvider` and `imageModel`

**Files:**
- Modify: `src/db/schema/users.ts:17,40-45`

- [ ] **Step 1: Update the interface**

Replace lines 16-17:
```ts
  /** Provider for the AI master. When unset, falls back to MASTER_PROVIDER env. */
  aiProvider?: 'anthropic' | 'openai';
```
with:
```ts
  /** Provider for the AI master. When unset, falls back to MASTER_PROVIDER env. */
  aiProvider?: 'anthropic' | 'openai' | 'gemini';
```

After line 41 (`imageGenerationEnabled?: boolean;`), add:
```ts
  /** Provider for scene illustration. When unset, falls back to IMAGE_PROVIDER env (default 'openai'). */
  imageProvider?: 'openai' | 'gemini';
  /** Specific image model slug. When unset, falls back to provider env default. */
  imageModel?: string;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. The JSONB column accepts the wider union; no migration needed.

- [ ] **Step 3: Do not commit yet** — bundle with Tasks 14-15.

---

## Task 14: Update `preferences.ts` defaults for image provider/model + Gemini

**Files:**
- Modify: `src/lib/preferences.ts`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `src/lib/preferences.ts` with:

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type UserPreferences } from '@/db/schema';

export type { UserPreferences };
export { TTS_VOICES, type TtsVoice, isValidTtsVoice } from './tts-voices';

/**
 * Defaults are merged on top of stored prefs at read time. Provider/model defaults
 * cascade from env vars when user hasn't picked anything; if env is also unset,
 * fall back to anthropic + claude-sonnet-4-5 (the historical default).
 */
function envDefaultProvider(): 'anthropic' | 'openai' | 'gemini' {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  return 'anthropic';
}

function envDefaultMasterModel(provider: 'anthropic' | 'openai' | 'gemini'): string {
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  if (provider === 'gemini') return process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}

function envDefaultImageProvider(): 'openai' | 'gemini' {
  const raw = (process.env.IMAGE_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

function envDefaultImageModel(provider: 'openai' | 'gemini'): string {
  if (provider === 'gemini') return process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  return process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  ttsVoice: 'onyx',
  ttsAutoplay: false,
  manualRolls: false,
  // These are set lazily inside getResolvedPreferences so the env values are read
  // at request time, not at module-load time.
  aiProvider: 'anthropic',
  aiMasterModel: 'claude-sonnet-4-5',
  masterGuidanceLevel: 'balanced',
  showDifficultyNumbers: true,
  imageGenerationEnabled: false,
  imageStylePreset: 'pastel',
  imageStyleCustom: '',
  imageProvider: 'openai',
  imageModel: 'gpt-image-1',
};

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const [row] = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.preferences ?? {};
}

/** Returns prefs with defaults applied for any missing field. Env-driven defaults
 * for provider/model are resolved at call time so a redeploy with new env vars
 * affects existing users who haven't explicitly set a value. */
export async function getResolvedPreferences(userId: string): Promise<Required<UserPreferences>> {
  const prefs = await getUserPreferences(userId);
  const envProvider = envDefaultProvider();
  const provider = prefs.aiProvider ?? envProvider;
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = prefs.imageProvider ?? envDefaultImageProvider();
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  return {
    ttsVoice: prefs.ttsVoice ?? DEFAULT_PREFERENCES.ttsVoice,
    ttsAutoplay: prefs.ttsAutoplay ?? DEFAULT_PREFERENCES.ttsAutoplay,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
    showDifficultyNumbers: prefs.showDifficultyNumbers ?? DEFAULT_PREFERENCES.showDifficultyNumbers,
    imageGenerationEnabled,
    imageStylePreset,
    imageStyleCustom,
    imageProvider,
    imageModel,
  };
}

export async function updateUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const merged: UserPreferences = { ...current, ...patch };
  await db.update(users).set({ preferences: merged }).where(eq(users.id, userId));
  return merged;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

---

## Task 15: Add `imageProvider`/`imageModel` validation to preferences API

**Files:**
- Modify: `src/app/api/preferences/route.ts`

- [ ] **Step 1: Add the imports**

In `src/app/api/preferences/route.ts:10`, replace:
```ts
import { isKnownProvider, isKnownMasterModel } from '@/lib/ai-models';
```
with:
```ts
import {
  isKnownProvider,
  isKnownMasterModel,
  isKnownImageProvider,
  isKnownImageModel,
} from '@/lib/ai-models';
```

- [ ] **Step 2: Add validation blocks**

After the existing `imageStyleCustom` validation block (line ~98, just before `const updated = ...`), add:

```ts
  if ('imageProvider' in body) {
    if (!isKnownImageProvider(body.imageProvider)) {
      return NextResponse.json({ error: 'invalid-imageProvider' }, { status: 400 });
    }
    patch.imageProvider = body.imageProvider;
  }
  if ('imageModel' in body) {
    if (body.imageModel !== undefined && !isKnownImageModel(body.imageModel)) {
      return NextResponse.json({ error: 'invalid-imageModel' }, { status: 400 });
    }
    patch.imageModel = body.imageModel as string | undefined;
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests to confirm nothing regressed**

Run: `pnpm test`
Expected: all current tests PASS.

- [ ] **Step 5: Commit Tasks 13-15 together**

```bash
git add src/db/schema/users.ts src/lib/preferences.ts src/app/api/preferences/route.ts
git commit -m "feat(preferences): aiProvider widened to gemini; add imageProvider + imageModel"
```

---

## Task 16: Extract OpenAI image generation into `image-providers/openai.ts`

**Files:**
- Create: `src/sessions/image-providers/openai.ts`

- [ ] **Step 1: Create the file**

```ts
import OpenAI from 'openai';

let _client: OpenAI | null = null;
let _override: OpenAI | null = null;

function client(): OpenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

/** Test-only seam — let unit tests inject a mocked OpenAI instance. */
export function __setOpenAIClientForTest(mock: OpenAI | null): void {
  _override = mock;
}

const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';

export type ImageGenResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'empty_response' | 'api_error'; detail?: string };

export async function generateBytesOpenAI(prompt: string, model?: string): Promise<ImageGenResult> {
  const m = model ?? DEFAULT_MODEL;
  try {
    const res = await client().images.generate({ model: m, prompt, size: '1024x1024' });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(b64, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Do not commit yet** — bundle with Task 17.

---

## Task 17: Create `image-providers/gemini.ts` with TDD

**Files:**
- Create: `src/sessions/image-providers/gemini.ts`
- Create: `tests/sessions/image-providers-gemini.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sessions/image-providers-gemini.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

const generateContent = vi.fn();
const generateImages = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class FakeGenAI {
      models = { generateContent, generateImages };
    },
  };
});

process.env.GEMINI_API_KEY = 'test-key';
const { generateBytesGemini, __setGeminiClientForTest } = await import(
  '@/sessions/image-providers/gemini'
);

describe('generateBytesGemini', () => {
  afterEach(() => {
    __setGeminiClientForTest(null);
    generateContent.mockReset();
    generateImages.mockReset();
  });

  it('happy path with gemini-2.5-flash-image returns inlineData bytes', async () => {
    const fakeBytes = Buffer.from([0x89, 0x50]);
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: fakeBytes.toString('base64') } }],
          },
        },
      ],
    });
    const out = await generateBytesGemini('a tower', 'gemini-2.5-flash-image');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bytes.equals(fakeBytes)).toBe(true);
    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateImages).not.toHaveBeenCalled();
  });

  it('happy path with imagen-4.0-generate-001 uses generateImages', async () => {
    const fakeBytes = Buffer.from([0xff, 0xd8]);
    generateImages.mockResolvedValueOnce({
      generatedImages: [{ image: { imageBytes: fakeBytes.toString('base64') } }],
    });
    const out = await generateBytesGemini('a tower', 'imagen-4.0-generate-001');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bytes.equals(fakeBytes)).toBe(true);
    expect(generateImages).toHaveBeenCalledOnce();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('empty response → ok:false, reason:empty_response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'no image here' }] } }],
    });
    const out = await generateBytesGemini('x', 'gemini-2.5-flash-image');
    expect(out).toEqual({ ok: false, reason: 'empty_response' });
  });

  it('SDK throws → ok:false, reason:api_error with detail', async () => {
    generateContent.mockRejectedValueOnce(new Error('rate_limit'));
    const out = await generateBytesGemini('x', 'gemini-2.5-flash-image');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('api_error');
      expect(out.detail).toContain('rate_limit');
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm test tests/sessions/image-providers-gemini.test.ts`
Expected: FAIL — module `@/sessions/image-providers/gemini` not found.

- [ ] **Step 3: Create the implementation**

Create `src/sessions/image-providers/gemini.ts`:

```ts
import { GoogleGenAI } from '@google/genai';
import type { ImageGenResult } from './openai';

let _client: GoogleGenAI | null = null;
let _override: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

/** Test-only seam — let unit tests inject a mocked GoogleGenAI instance. */
export function __setGeminiClientForTest(mock: GoogleGenAI | null): void {
  _override = mock;
}

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';

interface InlineDataPart { inlineData?: { mimeType?: string; data?: string } }

export async function generateBytesGemini(prompt: string, model?: string): Promise<ImageGenResult> {
  const m = model ?? DEFAULT_MODEL;
  try {
    if (m.startsWith('imagen-')) {
      const res = (await client().models.generateImages({
        model: m,
        prompt,
        config: { numberOfImages: 1, aspectRatio: '1:1' },
      })) as { generatedImages?: { image?: { imageBytes?: string } }[] };
      const b64 = res.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) return { ok: false, reason: 'empty_response' };
      return { ok: true, bytes: Buffer.from(b64, 'base64') };
    }
    const res = (await client().models.generateContent({
      model: m,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })) as { candidates?: { content?: { parts?: InlineDataPart[] } }[] };
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(inline.data, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test tests/sessions/image-providers-gemini.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit Tasks 16-17 together**

```bash
git add src/sessions/image-providers/openai.ts src/sessions/image-providers/gemini.ts tests/sessions/image-providers-gemini.test.ts
git commit -m "feat(images): split OpenAI + Gemini image generation into per-provider modules"
```

---

## Task 18: Refactor `scene-image-job.ts` to dispatch on provider

**Files:**
- Modify: `src/sessions/scene-image-job.ts`
- Modify: `tests/sessions/scene-image-job.test.ts`

- [ ] **Step 1: Replace `scene-image-job.ts`**

Replace the entire contents of `src/sessions/scene-image-job.ts` with:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { buildImagePrompt } from '@/ai/master/image-style';
import { generateBytesOpenAI, __setOpenAIClientForTest } from './image-providers/openai';
import { generateBytesGemini, __setGeminiClientForTest } from './image-providers/gemini';

export { __setOpenAIClientForTest, __setGeminiClientForTest };

export type ImageProvider = 'openai' | 'gemini';

export type GenerateResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'empty_response' | 'race_lost' | 'api_error'; detail?: string };

/**
 * Generate an illustration from a visual prompt and persist the bytes onto
 * `session_state` if the row is still at `expectedVersion - 1` (race-safe
 * conditional UPDATE).
 *
 * Returns a structured result so callers (currently the manual-button
 * endpoint) can surface success/failure to the user. Errors are caught and
 * never thrown — the row stays untouched on failure.
 */
export async function generateAndPersist(
  sessionId: string,
  visualPrompt: string,
  styleText: string,
  expectedVersion: number,
  provider: ImageProvider = 'openai',
  model?: string,
): Promise<GenerateResult> {
  const fullPrompt = buildImagePrompt(visualPrompt, styleText);
  const result =
    provider === 'gemini'
      ? await generateBytesGemini(fullPrompt, model)
      : await generateBytesOpenAI(fullPrompt, model);

  if (!result.ok) {
    if (result.reason === 'api_error') {
      console.error('[scene-image] generation failed', { sessionId, provider, detail: result.detail });
      return { ok: false, reason: 'api_error', detail: result.detail };
    }
    console.warn('[scene-image] empty response from image API', { sessionId, provider });
    return { ok: false, reason: 'empty_response' };
  }

  const updated = await db.update(sessionState)
    .set({
      sceneImageData: result.bytes,
      sceneImagePrompt: visualPrompt,
      sceneImageVersion: expectedVersion,
    })
    .where(and(
      eq(sessionState.sessionId, sessionId),
      eq(sessionState.sceneImageVersion, expectedVersion - 1),
    ));

  if ((updated.rowCount ?? 0) === 0) {
    return { ok: false, reason: 'race_lost' };
  }
  return { ok: true, version: expectedVersion };
}
```

- [ ] **Step 2: Update existing test for the new signature (default provider)**

The existing tests in `tests/sessions/scene-image-job.test.ts` call `generateAndPersist(SESSION_ID, '...', '...', N)` with 4 args. The new signature defaults `provider` to `'openai'`, so those calls keep working. Run the suite to confirm:

Run: `pnpm test tests/sessions/scene-image-job.test.ts`
Expected: 4 tests PASS (no edits needed — defaults preserve behavior).

- [ ] **Step 3: Add a Gemini-dispatch test case**

Append to `tests/sessions/scene-image-job.test.ts` (before the closing `});` of the outer describe):

```ts
  it('dispatches to Gemini when provider="gemini"', async () => {
    // Reset the row to version 5 from earlier tests.
    await db.update(sessionState).set({ sceneImageVersion: 5, sceneImagePrompt: 'newer' }).where(eq(sessionState.sessionId, SESSION_ID));
    const fakeBytes = Buffer.from([0xab, 0xcd]);
    const fakeGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ inlineData: { mimeType: 'image/png', data: fakeBytes.toString('base64') } }],
              },
            },
          ],
        }),
        generateImages: vi.fn(),
      },
    };
    __setGeminiClientForTest(fakeGemini as never);
    try {
      const result = await generateAndPersist(SESSION_ID, 'a wizard', 'pastel', 6, 'gemini', 'gemini-2.5-flash-image');
      expect(result).toEqual({ ok: true, version: 6 });
      const [row] = await db.select().from(sessionState).where(eq(sessionState.sessionId, SESSION_ID)).limit(1);
      expect(row!.sceneImageVersion).toBe(6);
      expect(row!.sceneImageData?.equals(fakeBytes)).toBe(true);
      expect(fakeGemini.models.generateContent).toHaveBeenCalledOnce();
    } finally {
      __setGeminiClientForTest(null);
    }
  });
```

Also add an import at the top of the test file:
```ts
import { generateAndPersist, __setOpenAIClientForTest, __setGeminiClientForTest } from '@/sessions/scene-image-job';
```
(replacing the existing import that lacks `__setGeminiClientForTest`).

- [ ] **Step 4: Run the test**

Run: `pnpm test tests/sessions/scene-image-job.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/scene-image-job.ts tests/sessions/scene-image-job.test.ts
git commit -m "feat(images): scene-image-job dispatches to provider implementation"
```

---

## Task 19: Update scene-image route to pass provider + model from prefs

**Files:**
- Modify: `src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts`

- [ ] **Step 1: Switch to resolved preferences and pass new args**

Replace lines 6-7:
```ts
import { getUserPreferences } from '@/lib/preferences';
```
with:
```ts
import { getResolvedPreferences } from '@/lib/preferences';
```

Replace lines 56-63 (the prefs read + `generateAndPersist` call):

Old:
```ts
  const prefs = await getUserPreferences(userId);
  if (!prefs.imageGenerationEnabled) {
    return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
  }
  const styleText = resolveStyleText(prefs);
  const nextVersion = row.currentVersion + 1;

  const result = await generateAndPersist(sessionId, row.messageContent, styleText, nextVersion);
```

New:
```ts
  const prefs = await getResolvedPreferences(userId);
  if (!prefs.imageGenerationEnabled) {
    return NextResponse.json({ error: 'image-generation-disabled' }, { status: 403 });
  }
  const styleText = resolveStyleText(prefs);
  const nextVersion = row.currentVersion + 1;

  const result = await generateAndPersist(
    sessionId,
    row.messageContent,
    styleText,
    nextVersion,
    prefs.imageProvider,
    prefs.imageModel,
  );
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/messages/[messageId]/scene-image/route.ts
git commit -m "feat(images): scene-image route passes per-user provider + model"
```

---

## Task 20: Settings UI — third "Gemini" radio for master provider

**Files:**
- Modify: `src/app/(authed)/settings/settings-client.tsx`

- [ ] **Step 1: Update the provider radio array**

In `src/app/(authed)/settings/settings-client.tsx:145`, replace:
```tsx
            {(['anthropic', 'openai'] as ProviderName[]).map((p) => (
```
with:
```tsx
            {(['anthropic', 'openai', 'gemini'] as ProviderName[]).map((p) => (
```

In the same JSX block (line ~163), replace:
```tsx
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
```
with:
```tsx
                {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Gemini'}
```

- [ ] **Step 2: Run dev server and confirm UI manually**

Run: `pnpm dev` in another terminal, navigate to `/settings`, verify the third "Gemini" button appears and clicking it switches the model dropdown to Gemini models.

Expected: three buttons, Gemini selectable, model dropdown lists `gemini-2.5-pro` (recommended), `gemini-2.5-flash`, `gemini-2.5-flash-lite`.

- [ ] **Step 3: Stop the dev server**

Press Ctrl+C in the dev server terminal.

- [ ] **Step 4: Do not commit yet** — bundle with Task 21.

---

## Task 21: Settings UI — Image provider section

**Files:**
- Modify: `src/app/(authed)/settings/settings-client.tsx`

- [ ] **Step 1: Update imports**

In `src/app/(authed)/settings/settings-client.tsx:9-13`, replace:
```tsx
import {
  modelsForProvider,
  defaultModelForProvider,
  type ProviderName,
} from '@/lib/ai-models';
```
with:
```tsx
import {
  modelsForProvider,
  defaultModelForProvider,
  imageModelsForProvider,
  defaultImageModelForProvider,
  type ProviderName,
  type ImageProviderName,
} from '@/lib/ai-models';
```

- [ ] **Step 2: Add image-provider handlers**

After the existing `onImageStyleCustomBlur` handler (around line 99), insert:

```tsx
  const onImageProviderChange = (next: ImageProviderName): void => {
    if (next === prefs.imageProvider) return;
    const nextModel = defaultImageModelForProvider(next);
    setPrefs((p) => ({ ...p, imageProvider: next, imageModel: nextModel }));
    void save({ imageProvider: next, imageModel: nextModel });
  };

  const onImageModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setPrefs((p) => ({ ...p, imageModel: slug }));
    void save({ imageModel: slug });
  };
```

- [ ] **Step 3: Render the new UI inside the existing image card**

Find the block `{prefs.imageGenerationEnabled && (` (around line 424) and replace it with:

```tsx
        {prefs.imageGenerationEnabled && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>
                Provider
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['openai', 'gemini'] as ImageProviderName[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => onImageProviderChange(p)}
                    disabled={busy}
                    aria-pressed={prefs.imageProvider === p}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 999,
                      background: prefs.imageProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                      color: prefs.imageProvider === p ? 'var(--bone)' : 'var(--fg)',
                      border: '1px solid ' + (prefs.imageProvider === p ? 'var(--arcane)' : 'var(--border)'),
                      cursor: busy ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {p === 'openai' ? 'OpenAI' : 'Gemini'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="imageModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>
                Model
              </label>
              <select
                id="imageModel"
                value={prefs.imageModel}
                onChange={onImageModelChange}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 14,
                }}
              >
                {imageModelsForProvider(prefs.imageProvider).map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
                  </option>
                ))}
              </select>
            </div>

            <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Image style</label>
            <select
              value={prefs.imageStylePreset}
              onChange={onImageStylePresetChange}
              disabled={busy}
              style={{
                height: 36, padding: '0 10px', borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-card)', color: 'var(--fg)',
                fontFamily: 'var(--font-ui)', fontSize: 13,
              }}
            >
              <option value="pastel">Pastel drawing (default)</option>
              <option value="watercolor">Watercolor</option>
              <option value="oil">Oil painting</option>
              <option value="ink">Ink illustration</option>
              <option value="photo">Cinematic photo</option>
              <option value="custom">Custom…</option>
            </select>

            {prefs.imageStylePreset === 'custom' && (
              <textarea
                value={prefs.imageStyleCustom ?? ''}
                onChange={onImageStyleCustomChange}
                onBlur={onImageStyleCustomBlur}
                placeholder="e.g. retro pixel art, low-poly 3d render, pen-and-ink with watercolor washes…"
                rows={2}
                maxLength={500}
                style={{
                  padding: 10, borderRadius: 6,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-card)', color: 'var(--fg)',
                  fontFamily: 'var(--font-ui)', fontSize: 13, resize: 'vertical',
                }}
              />
            )}
          </div>
        )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Manual UI verification**

Run: `pnpm dev`, navigate to `/settings`, enable image generation:
- Confirm "Provider" row with OpenAI/Gemini buttons appears
- Click Gemini → model dropdown switches to Gemini models, recommended is `gemini-2.5-flash-image`
- Click OpenAI → model dropdown switches back, only `gpt-image-1` listed
- Image style dropdown still works as before

Stop the dev server with Ctrl+C.

- [ ] **Step 6: Commit Tasks 20-21 together**

```bash
git add src/app/\(authed\)/settings/settings-client.tsx
git commit -m "feat(settings): Gemini master radio + per-provider image model picker"
```

---

## Task 22: Final verification — full test suite + typecheck + lint

**Files:** none

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS (zero new warnings beyond what was there before this branch).

- [ ] **Step 3: Run full unit test suite**

Run: `pnpm test`
Expected: all tests PASS. New count: existing ~272 + 22 new (16 gemini-adapter + 8 gemini provider + 4 gemini image + 1 dispatcher + 1 scene-image dispatch) = ~294.

- [ ] **Step 4: Manual smoke test (optional, requires `GEMINI_API_KEY`)**

If you have a `GEMINI_API_KEY` available:
1. Set it in `.env.local`: `GEMINI_API_KEY=...`
2. Run: `pnpm dev`
3. Settings → switch master provider to Gemini, model to `gemini-2.5-flash` (cheap)
4. Start a session, send a message, confirm the master responds via Gemini
5. Settings → enable image generation, switch image provider to Gemini, model `gemini-2.5-flash-image`
6. In a session, click "Generate image" on a master message; confirm an image appears within 30s
7. Stop the dev server

If the smoke test fails: capture the error, decide whether it's a real bug (file an issue or fix here) or an env/billing issue (note in the PR description).

- [ ] **Step 5: Final commit (only if smoke test produced a fix)**

If you made any fixes during the smoke test, commit them now. Otherwise, this task has no commit.

---

## Self-review checklist (run before handing off)

Before declaring the plan executed, verify against the spec at `docs/superpowers/specs/2026-05-05-gemini-provider-design.md`:

- ✅ `ProviderName` extended to `'anthropic' | 'openai' | 'gemini'` (Task 2)
- ✅ `GEMINI_MASTER_MODELS` with the 3 documented slugs (Task 3)
- ✅ `GEMINI_IMAGE_MODELS` with the 2 documented slugs (Task 3)
- ✅ `OPENAI_IMAGE_MODELS` added for symmetry (Task 3)
- ✅ `imageModelsForProvider`, `defaultImageModelForProvider`, `isKnownImageProvider`, `isKnownImageModel` (Task 3)
- ✅ Dispatcher routes `'gemini'` (Task 4) + tested (Task 6)
- ✅ `gemini-adapter.ts`: system flatten, tool conversion, message conversion, response parsing, usage normalization (Tasks 7-9)
- ✅ `GeminiProvider`: `completeMessage` (Task 10), `detectLanguage` (Task 11), `proposeWizard` (Task 12)
- ✅ `aiProvider` widened, `imageProvider`/`imageModel` added to schema (Task 13)
- ✅ `getResolvedPreferences` resolves all new fields with env cascade (Task 14)
- ✅ Preferences API validates `imageProvider`/`imageModel` (Task 15)
- ✅ `image-providers/openai.ts` + `image-providers/gemini.ts` (Tasks 16-17)
- ✅ `scene-image-job.ts` dispatches on provider (Task 18)
- ✅ Scene-image route passes prefs through (Task 19)
- ✅ Settings UI: third Gemini radio + image provider section (Tasks 20-21)
- ✅ All tests + typecheck + lint pass (Task 22)
