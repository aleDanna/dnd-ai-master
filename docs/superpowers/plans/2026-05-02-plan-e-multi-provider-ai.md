# Plan E — Multi-Provider AI (Anthropic + OpenAI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI as an alternative AI provider behind an env var. When `MASTER_PROVIDER=openai`, all three callsites (master tool loop, language detection, wizard proposal) route to OpenAI; default `anthropic` keeps current behavior.

**Architecture:** Thin abstraction layer at `src/ai/provider/` with two implementations (`AnthropicProvider` wraps existing logic, `OpenAIProvider` is new). A cached singleton dispatcher reads `MASTER_PROVIDER` lazily at first request. The iterative tool-call loop stays in `tool-loop.ts`; providers handle one round-trip each. In-passing fix: wizard's hardcoded model becomes env-overridable.

**Tech Stack:** existing `@anthropic-ai/sdk@^0.92.0` + new `openai@^5` package. No SDK migration, no UI, no schema change.

---

## File map

### New files

```
src/ai/provider/
├── types.ts                       NEW — MasterProvider interface + shared types
├── index.ts                       NEW — getMasterProvider() dispatcher
├── tool-adapter.ts                NEW — Anthropic↔OpenAI conversions
├── anthropic.ts                   NEW — AnthropicProvider implementation
├── openai.ts                      NEW — OpenAIProvider implementation

tests/ai/provider/
├── dispatcher.test.ts             NEW — env var dispatcher cases
├── tool-adapter.test.ts           NEW — 10 conversion tests
├── openai.test.ts                 NEW — OpenAIProvider with mocked SDK
└── openai-live-smoke.test.ts      NEW — gated by OPENAI_API_KEY
```

### Modified files

```
src/ai/master/tool-loop.ts         MODIFY — accept provider param instead of client
src/ai/master/language.ts          MODIFY — use getMasterProvider()
src/ai/wizard/loop.ts              MODIFY — use getMasterProvider() + drop hardcoded model
src/app/api/sessions/[id]/turn/route.ts  MODIFY — pass provider into runToolLoop
tests/ai/master/tool-loop.test.ts  MODIFY — adapt mocks from client to fake provider
package.json                        MODIFY — add openai dependency
```

---

## Phase 1 — Foundation

### Task 1: Branch, install `openai`, scaffold `types.ts`

**Files:**
- Modify: `package.json` (via `pnpm add openai`)
- Create: `src/ai/provider/types.ts`

- [ ] **Step 1: Verify state**

```bash
pwd && git branch --show-current && git log --oneline -3
```
Expected: working dir `/Users/alessiodanna/projects/dnd-ai-master`, branch `main`, last commit `f3105d3 docs: spec for multi-provider AI ...`.

- [ ] **Step 2: Create branch**

```bash
git checkout -b feat/plan-e-multi-provider
```

- [ ] **Step 3: Install OpenAI SDK**

```bash
pnpm add openai
pnpm list openai 2>&1 | tail -3
```
Expected: `openai` shows up (version 5.x or newer).

- [ ] **Step 4: Create `src/ai/provider/types.ts`**

```bash
mkdir -p src/ai/provider
```

```ts
import type { Anthropic } from '@anthropic-ai/sdk';

export type ProviderName = 'anthropic' | 'openai';

/** The Anthropic-shaped tool definition is the canonical form across the codebase. */
export type ToolDef = Anthropic.Messages.Tool;

/** The Anthropic-shaped message param is the canonical history format. */
export type Message = Anthropic.Messages.MessageParam;

/** The Anthropic-shaped system block (text + optional cache breakpoint). */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CompleteMessageInput {
  systemBlocks: SystemBlock[];
  messages: Message[];
  tools: ToolDef[];
  /** Optional model override; provider falls back to its env-configured default. */
  model?: string;
  /** Defaults to 4096 tokens. */
  maxTokens?: number;
  /** Optional, used as OpenAI prompt_cache_key for cache affinity. */
  sessionId?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface CompleteMessageOutput {
  contentBlocks: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage: NormalizedUsage;
}

export interface DetectLanguageInput {
  text: string;
  userId?: string;
  sessionId?: string;
}

export interface ProposeWizardInput {
  systemPrompt: string;
  toolDefinition: ToolDef;          // single tool — provider forces tool_choice
  userMessage: string;
  userId?: string;
  sessionId?: string;
}

export interface ProposeWizardOutput {
  toolInput: Record<string, unknown>;
  usage: NormalizedUsage;
}

export interface MasterProvider {
  readonly name: ProviderName;
  completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput>;
  detectLanguage(input: DetectLanguageInput): Promise<string | null>;
  proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput>;
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add package.json pnpm-lock.yaml src/ai/provider/types.ts
git commit -m "feat(provider): scaffold types + install openai SDK"
```

---

### Task 2: Tool/message/usage adapter

This is the largest task. The adapter translates Anthropic-shape inputs to OpenAI Chat Completions and back, plus normalizes usage shapes from both providers.

**Files:**
- Create: `src/ai/provider/tool-adapter.ts`
- Create: `tests/ai/provider/tool-adapter.test.ts`

- [ ] **Step 1: Implement `src/ai/provider/tool-adapter.ts`**

```ts
import type OpenAI from 'openai';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ContentBlock, Message, NormalizedUsage, SystemBlock, ToolDef } from './types';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function anthropicToolToOpenAI(tool: ToolDef): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

/** Flatten Anthropic system blocks to a single string. cache_control is dropped — OpenAI auto-caches prompts ≥1024 tokens. */
export function flattenSystemBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

// ─── Messages: Anthropic → OpenAI ────────────────────────────────────────────

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function anthropicMessagesToOpenAI(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = msg.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      const tool_calls = toolUses.length
        ? toolUses.map((tu) => ({
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          }))
        : undefined;
      out.push({ role: 'assistant', content: text || null, ...(tool_calls ? { tool_calls } : {}) });
      continue;
    }

    // role === 'user' with content blocks
    const toolResults = msg.content.filter(
      (b): b is Anthropic.Messages.ToolResultBlockParam => b.type === 'tool_result',
    );
    if (toolResults.length > 0) {
      // Fan-out: one OpenAI tool message per result.
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          tool_call_id: tr.tool_use_id,
        });
      }
      // OpenAI does not allow text + tool_result in the same user message; drop the text part if any.
      continue;
    }

    // Plain user with text blocks
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

// ─── Response: OpenAI → internal (Anthropic-shape) ───────────────────────────

export function openAIResponseToContentBlocks(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type !== 'function') continue;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      } catch {
        parsed = { _raw: tc.function.arguments };
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsed });
    }
  }
  return blocks;
}

export function openAIFinishReasonToStopReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'],
): 'end_turn' | 'tool_use' | 'max_tokens' | 'other' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

// ─── Usage normalization ──────────────────────────────────────────────────────

export function normalizeAnthropicUsage(usage: Anthropic.Messages.Usage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function normalizeOpenAIUsage(usage: OpenAI.Completions.CompletionUsage | undefined): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
  };
}
```

- [ ] **Step 2: Create `tests/ai/provider/tool-adapter.test.ts`**

```bash
mkdir -p tests/ai/provider
```

```ts
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { Message, ToolDef } from '@/ai/provider/types';
import {
  anthropicToolToOpenAI,
  flattenSystemBlocks,
  anthropicMessagesToOpenAI,
  openAIResponseToContentBlocks,
  openAIFinishReasonToStopReason,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
} from '@/ai/provider/tool-adapter';

describe('tool-adapter', () => {
  it('converts Anthropic tool def → OpenAI function', () => {
    const tool: ToolDef = {
      name: 'roll_d20',
      description: 'roll a d20',
      input_schema: {
        type: 'object',
        required: ['mod'],
        properties: { mod: { type: 'number' } },
      } as never,
    };
    const out = anthropicToolToOpenAI(tool);
    expect(out.type).toBe('function');
    expect(out.function.name).toBe('roll_d20');
    expect(out.function.description).toBe('roll a d20');
    expect(out.function.parameters).toEqual(tool.input_schema);
  });

  it('flattens system blocks and drops cache_control', () => {
    const flat = flattenSystemBlocks([
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'B' },
    ]);
    expect(flat).toBe('A\n\nB');
    expect(flat).not.toMatch(/cache_control/);
  });

  it('passes user string message through', () => {
    const out = anthropicMessagesToOpenAI([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('collapses assistant text blocks into a single string', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi ', citations: null } as never,
          { type: 'text', text: 'there.', citations: null } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out).toEqual([{ role: 'assistant', content: 'Hi there.' }]);
  });

  it('converts assistant text + tool_use → assistant + tool_calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Rolling…', citations: null } as never,
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { mod: 3 } } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out.length).toBe(1);
    const a = out[0] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(a.role).toBe('assistant');
    expect(a.content).toBe('Rolling…');
    expect(a.tool_calls).toEqual([
      { id: 'tu1', type: 'function', function: { name: 'roll_d20', arguments: '{"mod":3}' } },
    ]);
  });

  it('fans out N tool_result blocks into N OpenAI tool messages', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok-1', is_error: false } as never,
          { type: 'tool_result', tool_use_id: 'tu2', content: 'err', is_error: true } as never,
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ role: 'tool', content: 'ok-1', tool_call_id: 'tu1' });
    expect(out[1]).toEqual({ role: 'tool', content: 'err', tool_call_id: 'tu2' });
  });

  it('OpenAI text-only response → text content block', () => {
    const msg = {
      role: 'assistant',
      content: 'You see a dragon.',
      refusal: null,
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out).toEqual([{ type: 'text', text: 'You see a dragon.' }]);
  });

  it('OpenAI tool_calls-only response → tool_use blocks (with JSON.parse)', () => {
    const msg = {
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'roll_d20', arguments: '{"mod":5}' },
        },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'roll_d20', input: { mod: 5 } },
    ]);
  });

  it('OpenAI mixed text + tool_calls → mixed blocks', () => {
    const msg = {
      role: 'assistant',
      content: 'Rolling…',
      refusal: null,
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'roll_d20', arguments: '{}' },
        },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionMessage;
    const out = openAIResponseToContentBlocks(msg);
    expect(out[0]).toEqual({ type: 'text', text: 'Rolling…' });
    expect(out[1]).toEqual({ type: 'tool_use', id: 'call_a', name: 'roll_d20', input: {} });
  });

  it('finish_reason maps + usage normalizes for both providers', () => {
    expect(openAIFinishReasonToStopReason('stop')).toBe('end_turn');
    expect(openAIFinishReasonToStopReason('tool_calls')).toBe('tool_use');
    expect(openAIFinishReasonToStopReason('length')).toBe('max_tokens');
    expect(openAIFinishReasonToStopReason('content_filter')).toBe('other');

    const aUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    } as Anthropic.Messages.Usage;
    expect(normalizeAnthropicUsage(aUsage)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
    });

    const oUsage = {
      prompt_tokens: 200,
      completion_tokens: 75,
      total_tokens: 275,
      prompt_tokens_details: { cached_tokens: 150 },
    } as OpenAI.Completions.CompletionUsage;
    expect(normalizeOpenAIUsage(oUsage)).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 150,
      cacheCreationTokens: 0,
    });

    // undefined OpenAI usage (rare but possible) returns zeros
    expect(normalizeOpenAIUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test tests/ai/provider/tool-adapter.test.ts 2>&1 | tail -10
```
Expected: 10 tests pass.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/provider/tool-adapter.ts tests/ai/provider/tool-adapter.test.ts
git commit -m "feat(provider): tool/message/usage adapter Anthropic↔OpenAI"
```

---

### Task 3: AnthropicProvider

Wraps the existing `getAnthropicClient()` and the existing model-env-var pattern. Maps the SDK responses to the normalized shape.

**Files:**
- Create: `src/ai/provider/anthropic.ts`

- [ ] **Step 1: Implement `src/ai/provider/anthropic.ts`**

```ts
import { getAnthropicClient, MASTER_MODEL, LANGUAGE_MODEL } from '@/ai/master/anthropic-client';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import { normalizeAnthropicUsage } from './tool-adapter';
import { recordUsage } from '@/ai/master/usage';

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

export class AnthropicProvider implements MasterProvider {
  readonly name = 'anthropic' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: input.model ?? MASTER_MODEL,
      max_tokens: input.maxTokens ?? 4096,
      system: input.systemBlocks,
      tools: input.tools,
      messages: input.messages,
    });

    const contentBlocks: CompleteMessageOutput['contentBlocks'] = [];
    for (const block of response.content) {
      if (block.type === 'text') contentBlocks.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use')
        contentBlocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
    }

    const stopReason: CompleteMessageOutput['stopReason'] =
      response.stop_reason === 'end_turn'
        ? 'end_turn'
        : response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'other';

    return { contentBlocks, stopReason, usage: normalizeAnthropicUsage(response.usage) };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    const client = getAnthropicClient();
    try {
      const resp = await client.messages.create({
        model: LANGUAGE_MODEL,
        max_tokens: 8,
        system: [
          {
            type: 'text',
            text: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: input.text }],
      });
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: LANGUAGE_MODEL,
          usage: normalizeAnthropicUsage(resp.usage),
        });
      }
      const block = resp.content[0];
      if (!block || block.type !== 'text') return null;
      const code = block.text.trim().toLowerCase();
      return /^[a-z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }

  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: MASTER_MODEL,
      max_tokens: 1024,
      system: input.systemPrompt,
      tools: [input.toolDefinition],
      tool_choice: { type: 'tool', name: input.toolDefinition.name },
      messages: [{ role: 'user', content: input.userMessage }],
    });
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model: MASTER_MODEL,
        usage: normalizeAnthropicUsage(resp.usage),
      });
    }
    for (const block of resp.content) {
      if (block.type === 'tool_use' && block.name === input.toolDefinition.name) {
        return {
          toolInput: block.input as Record<string, unknown>,
          usage: normalizeAnthropicUsage(resp.usage),
        };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/provider/anthropic.ts
git commit -m "feat(provider): AnthropicProvider implementing MasterProvider"
```

---

### Task 4: Dispatcher

Cached singleton that picks the implementation based on `MASTER_PROVIDER`. Lazy-validates the API key (matches existing `getAnthropicClient()` pattern).

**Files:**
- Create: `src/ai/provider/index.ts`
- Create: `tests/ai/provider/dispatcher.test.ts`

- [ ] **Step 1: Implement `src/ai/provider/index.ts`**

```ts
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import type { MasterProvider, ProviderName } from './types';

let _provider: MasterProvider | null = null;
let _selected: ProviderName | null = null;

/** Returns a cached MasterProvider instance based on MASTER_PROVIDER env. Lazy. */
export function getMasterProvider(): MasterProvider {
  if (_provider) return _provider;
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic') {
    _provider = new AnthropicProvider();
  } else if (raw === 'openai') {
    _provider = new OpenAIProvider();
  } else {
    throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
  }
  _selected = _provider.name;
  return _provider;
}

/** Test/dev-only helper: clear the cached singleton (used to re-read env across tests). */
export function _resetMasterProviderForTests(): void {
  _provider = null;
  _selected = null;
}

export function getCurrentProviderName(): ProviderName | null {
  return _selected;
}

export type { MasterProvider, ProviderName } from './types';
```

- [ ] **Step 2: Implement `tests/ai/provider/dispatcher.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMasterProvider, _resetMasterProviderForTests } from '@/ai/provider';

const ORIGINAL = process.env.MASTER_PROVIDER;

describe('getMasterProvider', () => {
  beforeEach(() => {
    _resetMasterProviderForTests();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MASTER_PROVIDER;
    else process.env.MASTER_PROVIDER = ORIGINAL;
    _resetMasterProviderForTests();
  });

  it('defaults to anthropic when MASTER_PROVIDER is unset', () => {
    delete process.env.MASTER_PROVIDER;
    expect(getMasterProvider().name).toBe('anthropic');
  });

  it('returns anthropic for MASTER_PROVIDER=anthropic', () => {
    process.env.MASTER_PROVIDER = 'anthropic';
    expect(getMasterProvider().name).toBe('anthropic');
  });

  it('returns openai for MASTER_PROVIDER=openai', () => {
    process.env.MASTER_PROVIDER = 'openai';
    expect(getMasterProvider().name).toBe('openai');
  });

  it('throws for an unknown MASTER_PROVIDER value', () => {
    process.env.MASTER_PROVIDER = 'gemini';
    expect(() => getMasterProvider()).toThrow(/unknown MASTER_PROVIDER: gemini/);
  });
});
```

- [ ] **Step 3: Note — `OpenAIProvider` not yet implemented**

The dispatcher imports `OpenAIProvider` which we'll create in Task 5. To run the typecheck/test now, create a stub:

Create `src/ai/provider/openai.ts` with a stub that satisfies the type but throws on use:

```ts
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';

export class OpenAIProvider implements MasterProvider {
  readonly name = 'openai' as const;
  async completeMessage(_input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    throw new Error('OpenAIProvider.completeMessage not yet implemented (Task 5)');
  }
  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('OpenAIProvider.detectLanguage not yet implemented (Task 6)');
  }
  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('OpenAIProvider.proposeWizard not yet implemented (Task 6)');
  }
}
```

- [ ] **Step 4: Run dispatcher tests**

```bash
pnpm test tests/ai/provider/dispatcher.test.ts 2>&1 | tail -8
```
Expected: 4 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/provider/index.ts src/ai/provider/openai.ts tests/ai/provider/dispatcher.test.ts
git commit -m "feat(provider): dispatcher (getMasterProvider) + OpenAI stub"
```

---

## Phase 2 — OpenAI implementation

### Task 5: `OpenAIProvider.completeMessage`

Replaces the Task 4 stub with a real implementation using the `openai` SDK + adapter.

**Files:**
- Modify: `src/ai/provider/openai.ts`

- [ ] **Step 1: Replace `src/ai/provider/openai.ts` content**

Replace the entire file with:

```ts
import OpenAI from 'openai';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicMessagesToOpenAI,
  anthropicToolToOpenAI,
  flattenSystemBlocks,
  normalizeOpenAIUsage,
  openAIFinishReasonToStopReason,
  openAIResponseToContentBlocks,
} from './tool-adapter';
import { recordUsage } from '@/ai/master/usage';

const MASTER_MODEL = process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
const LANGUAGE_MODEL = process.env.OPENAI_LANGUAGE_MODEL ?? 'gpt-5-mini';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

export class OpenAIProvider implements MasterProvider {
  readonly name = 'openai' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const client = getClient();
    const systemContent = flattenSystemBlocks(input.systemBlocks);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      ...anthropicMessagesToOpenAI(input.messages),
    ];

    const response = await client.chat.completions.create({
      model: input.model ?? MASTER_MODEL,
      max_completion_tokens: input.maxTokens ?? 4096,
      messages,
      tools: input.tools.map(anthropicToolToOpenAI),
      ...(input.sessionId ? { prompt_cache_key: input.sessionId } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
      return {
        contentBlocks: [],
        stopReason: 'other',
        usage: normalizeOpenAIUsage(response.usage),
      };
    }

    return {
      contentBlocks: openAIResponseToContentBlocks(choice.message),
      stopReason: openAIFinishReasonToStopReason(choice.finish_reason),
      usage: normalizeOpenAIUsage(response.usage),
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    const client = getClient();
    try {
      const resp = await client.chat.completions.create({
        model: LANGUAGE_MODEL,
        max_completion_tokens: 8,
        messages: [
          {
            role: 'system',
            content:
              'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
          },
          { role: 'user', content: input.text },
        ],
      });
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: LANGUAGE_MODEL,
          usage: normalizeOpenAIUsage(resp.usage),
        });
      }
      const text = resp.choices[0]?.message.content?.trim().toLowerCase() ?? '';
      return /^[a-z]{2}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const client = getClient();
    const tool = anthropicToolToOpenAI(input.toolDefinition);
    const resp = await client.chat.completions.create({
      model: MASTER_MODEL,
      max_completion_tokens: 1024,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: input.toolDefinition.name } },
    });
    const usage = normalizeOpenAIUsage(resp.usage);
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model: MASTER_MODEL,
        usage,
      });
    }
    const tcs = resp.choices[0]?.message.tool_calls ?? [];
    for (const tc of tcs) {
      if (tc.type === 'function' && tc.function.name === input.toolDefinition.name) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          parsed = { _raw: tc.function.arguments };
        }
        return { toolInput: parsed, usage };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}
```

- [ ] **Step 2: Create `tests/ai/provider/openai.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';

// Mock the OpenAI module BEFORE importing the provider.
const create = vi.fn();
vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = { completions: { create } };
    },
  };
});

// Set env vars BEFORE the provider module loads (it reads them at module top-level).
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MASTER_MODEL = 'gpt-5';
process.env.OPENAI_LANGUAGE_MODEL = 'gpt-5-mini';

const { OpenAIProvider } = await import('@/ai/provider/openai');

describe('OpenAIProvider', () => {
  it('completeMessage flattens system, sends tools, normalizes response', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'roll_d20', arguments: '{"mod":3}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    });

    const provider = new OpenAIProvider();
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

    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]![0] as { messages: unknown[]; tools: unknown[]; model: string };
    expect(args.model).toBe('gpt-5');
    expect((args.messages[0] as { role: string }).role).toBe('system');
    expect(args.tools).toHaveLength(1);

    expect(out.stopReason).toBe('tool_use');
    expect(out.contentBlocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'roll_d20', input: { mod: 3 } },
    ]);
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('detectLanguage returns lowercase 2-letter code', async () => {
    create.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'IT' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBe('it');
  });

  it('proposeWizard returns the parsed tool input', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: {
                  name: 'propose_choice',
                  arguments: '{"step":"race","value":"half-elf","reasoning":"versatile"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const provider = new OpenAIProvider();
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
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test tests/ai/provider/openai.test.ts 2>&1 | tail -8
```
Expected: 3 tests pass.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/provider/openai.ts tests/ai/provider/openai.test.ts
git commit -m "feat(provider): OpenAIProvider full implementation + mocked SDK tests"
```

---

### Task 6: OpenAI live smoke test

Real round-trip against `gpt-5` and `gpt-5-mini`, gated by `OPENAI_API_KEY`. Mirrors `tests/ai/master/live-smoke.test.ts`.

**Files:**
- Create: `tests/ai/provider/openai-live-smoke.test.ts`

- [ ] **Step 1: Implement**

```ts
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true });

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '@/ai/provider/openai';

const HAS_KEY = !!process.env.OPENAI_API_KEY;

describe.skipIf(!HAS_KEY)('OpenAI live smoke', () => {
  it('detects Italian on a real call', async () => {
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole nel pavimento.',
    });
    expect(code).toBe('it');
  }, 30_000);

  it('detects English', async () => {
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'I cautiously explore the room and search the floor for traps.',
    });
    expect(code).toBe('en');
  }, 30_000);
});
```

- [ ] **Step 2: Run**

```bash
pnpm test tests/ai/provider/openai-live-smoke.test.ts 2>&1 | tail -10
```
Expected: 2 tests pass (assuming `OPENAI_API_KEY` is in `.env.local`).

- [ ] **Step 3: Commit**

```bash
git add tests/ai/provider/openai-live-smoke.test.ts
git commit -m "test(provider): live smoke test for OpenAI (gated by OPENAI_API_KEY)"
```

---

## Phase 3 — Wire callsites

### Task 7: Refactor `tool-loop.ts` to accept a `MasterProvider`

The tool loop currently takes `client: Pick<Anthropic, 'messages'>`. Replace with `provider: MasterProvider`. The internal loop logic (cap, timeout, applyMutations, recordUsage, onEvent) stays unchanged.

**Files:**
- Modify: `src/ai/master/tool-loop.ts`
- Modify: `tests/ai/master/tool-loop.test.ts`

- [ ] **Step 1: Replace `src/ai/master/tool-loop.ts` with this content**

```ts
import type { ActionResult, EngineState, Mutation, DiceRoll } from '@/engine/types';
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from '@/engine';
import { TURN_TOOL_CALL_CAP, TURN_TIMEOUT_MS, type TurnEvent } from '@/sessions/types';
import type {
  MasterProvider,
  Message,
  NormalizedUsage,
  SystemBlock,
} from '@/ai/provider/types';

export interface ToolLoopInput {
  provider: MasterProvider;
  /** Optional override; provider falls back to its env-configured master model. */
  model?: string;
  systemBlocks: SystemBlock[];
  history: Message[];
  state: EngineState;
  /** Optional applicator: called after each tool result with the mutations. */
  applyMutations?: (mutations: Mutation[], rolls: DiceRoll[]) => Promise<void>;
  /** Optional usage sink (called once per round-trip). */
  recordUsage?: (usage: NormalizedUsage) => Promise<void>;
  /** Called once per emitted event, in order. Use to flush events to an SSE stream as they happen. */
  onEvent?: (event: TurnEvent) => void;
  /** Used as OpenAI prompt_cache_key for cache affinity (Anthropic ignores). */
  sessionId?: string;
}

export interface ToolLoopResult {
  events: TurnEvent[];
  finalText: string;
  toolCallCount: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const {
    provider,
    model,
    systemBlocks,
    history,
    state,
    applyMutations,
    recordUsage,
    onEvent,
    sessionId,
  } = input;
  const events: TurnEvent[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let truncated = false;
  let timedOut = false;
  const start = Date.now();
  const messages: Message[] = [...history];

  const emit = (ev: TurnEvent): void => {
    events.push(ev);
    onEvent?.(ev);
  };

  for (let iter = 0; iter < TURN_TOOL_CALL_CAP + 1; iter++) {
    if (Date.now() - start > TURN_TIMEOUT_MS) {
      timedOut = true;
      emit({ type: 'turn_error', reason: 'timeout', recoverable: true });
      break;
    }

    const response = await provider.completeMessage({
      model,
      systemBlocks,
      messages,
      tools: TOOL_DEFINITIONS,
      sessionId,
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const block of response.contentBlocks) {
      if (block.type === 'text') {
        finalText += block.text;
        emit({ type: 'narrative_delta', text: block.text });
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    if (toolUses.length === 0 || response.stopReason === 'end_turn') break;

    if (toolCallCount + toolUses.length > TURN_TOOL_CALL_CAP) {
      truncated = true;
      emit({ type: 'turn_error', reason: 'tool_call_cap', recoverable: true });
      break;
    }

    // Push the assistant turn back into history (Anthropic-shape).
    messages.push({
      role: 'assistant',
      content: response.contentBlocks.map((b) =>
        b.type === 'text'
          ? ({ type: 'text', text: b.text } as never)
          : ({ type: 'tool_use', id: b.id, name: b.name, input: b.input } as never),
      ),
    });

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }[] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input });

      const handler = TOOL_HANDLERS[tu.name];
      let result: ActionResult;
      if (!handler) {
        result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
      } else {
        try {
          result = handler(state, tu.input);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
        }
      }

      emit({
        type: 'tool_use_end',
        toolUseId: tu.id,
        ok: result.ok,
        error: result.error,
        rolls: result.rolls,
        mutationCount: result.mutations.length,
      });

      if (result.mutations.length > 0 || result.rolls.length > 0) {
        if (applyMutations) await applyMutations(result.mutations, result.rolls);
        emit({ type: 'state_changed', mutations: result.mutations });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ ok: result.ok, data: result.data, error: result.error, rolls: result.rolls }),
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'user', content: toolResults as never });
  }

  return { events, finalText, toolCallCount, truncated, timedOut };
}
```

- [ ] **Step 2: Update `tests/ai/master/tool-loop.test.ts`**

The existing tests build a fake Anthropic `client` with `messages.create`. They need to build a fake `MasterProvider` instead. Open the file, replace the existing tests with this content:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/ai/master/tool-loop';
import type { EngineState } from '@/engine/types';
import type { CompleteMessageOutput, MasterProvider } from '@/ai/provider/types';

const baseState: EngineState = {
  characters: [
    {
      id: 'pc1', name: 'Tharion', level: 1,
      classSlug: 'fighter', raceSlug: 'half-elf', backgroundSlug: 'soldier',
      abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 12, ac: 16, speed: 30,
      proficiencies: { saves: ['STR', 'CON'], skills: ['Athletics'], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Heavy', 'Shield'], tools: [], languages: ['Common'] },
      spellcasting: null, features: [], inventory: [], hitDiceMax: 1, hitDieSize: 10,
    },
  ],
  combatActors: [],
  runtime: { pc1: { actorId: 'pc1', hpCurrent: 12, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [] } },
  combat: null,
  scene: 'forest clearing',
};

function fakeOutput(blocks: CompleteMessageOutput['contentBlocks'], stopReason: CompleteMessageOutput['stopReason'] = 'end_turn'): CompleteMessageOutput {
  return {
    contentBlocks: blocks,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

function fakeProvider(impl: ReturnType<typeof vi.fn>): MasterProvider {
  return {
    name: 'anthropic',
    completeMessage: impl,
    detectLanguage: vi.fn().mockResolvedValue(null),
    proposeWizard: vi.fn().mockRejectedValue(new Error('not used')),
  };
}

describe('runToolLoop', () => {
  it('emits a narrative delta and stops when no tool_use', async () => {
    const complete = vi.fn().mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'You see a dragon.' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'look around' }],
      state: baseState,
    });
    expect(result.finalText).toBe('You see a dragon.');
    expect(result.events.find((e) => e.type === 'narrative_delta')).toBeDefined();
    expect(result.toolCallCount).toBe(0);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('runs a tool, feeds tool_result back, then completes', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput(
        [
          { type: 'text', text: 'Rolling…' },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } },
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'You hit!' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'attack' }],
      state: baseState,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toContain('You hit!');
    expect(result.events.find((e) => e.type === 'tool_use_start')).toBeDefined();
    expect(result.events.find((e) => e.type === 'tool_use_end')).toBeDefined();
  });

  it('stops with truncated=true when cap is exceeded', async () => {
    const looping = fakeOutput([{ type: 'tool_use', id: 'tu', name: 'roll_d20', input: {} }], 'tool_use');
    const complete = vi.fn().mockResolvedValue(looping);
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'spam' }],
      state: baseState,
    });
    expect(result.truncated).toBe(true);
    expect(result.events.some((e) => e.type === 'turn_error' && e.reason === 'tool_call_cap')).toBe(true);
  });

  it('captures unknown_tool cleanly without throwing', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput([{ type: 'tool_use', id: 'tu1', name: 'fly_to_moon', input: {} }], 'tool_use'))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Adapting…' }]));
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'go' }],
      state: baseState,
    });
    const end = result.events.find((e) => e.type === 'tool_use_end');
    expect(end?.type).toBe('tool_use_end');
    if (end?.type === 'tool_use_end') {
      expect(end.ok).toBe(false);
      expect(end.error).toMatch(/unknown_tool/);
    }
  });

  it('calls onEvent in order as each event is emitted', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(fakeOutput(
        [
          { type: 'text', text: 'Rolling…' },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } },
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeOutput([{ type: 'text', text: 'Done.' }]));
    const seen: string[] = [];
    const result = await runToolLoop({
      provider: fakeProvider(complete),
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'go' }],
      state: baseState,
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen.length).toBe(result.events.length);
    expect(seen).toEqual(result.events.map((e) => e.type));
    expect(seen[0]).toBe('narrative_delta');
    expect(seen.includes('tool_use_start')).toBe(true);
    expect(seen.includes('tool_use_end')).toBe(true);
    expect(seen.at(-1)).toBe('narrative_delta');
  });
});
```

- [ ] **Step 3: Run all tool-loop tests**

```bash
pnpm test tests/ai/master/tool-loop.test.ts 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/master/tool-loop.ts tests/ai/master/tool-loop.test.ts
git commit -m "refactor(master): tool-loop accepts MasterProvider instead of Anthropic client"
```

---

### Task 8: Refactor `language.ts` to use the dispatcher

**Files:**
- Modify: `src/ai/master/language.ts`

- [ ] **Step 1: Replace `src/ai/master/language.ts` content**

```ts
import { getMasterProvider } from '@/ai/provider';

export interface DetectInput {
  text: string;
  /** Test override: a stub with `detect(text)` returning a 2-letter code. */
  stub?: { detect: (text: string) => Promise<string> };
  userId?: string;
  sessionId?: string;
}

export async function detectLanguage(input: DetectInput): Promise<string | null> {
  if (input.stub) {
    try {
      const code = (await input.stub.detect(input.text)).trim().toLowerCase();
      return /^[a-z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }
  return getMasterProvider().detectLanguage({
    text: input.text,
    userId: input.userId,
    sessionId: input.sessionId,
  });
}
```

- [ ] **Step 2: Run language tests**

```bash
pnpm test tests/ai/master/language.test.ts 2>&1 | tail -10
```
Expected: existing tests still pass (the stub path is preserved).

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/master/language.ts
git commit -m "refactor(master): language detection routes through provider dispatcher"
```

---

### Task 9: Refactor `wizard/loop.ts` (in-passing hardcode fix)

**Files:**
- Modify: `src/ai/wizard/loop.ts`

- [ ] **Step 1: Replace `src/ai/wizard/loop.ts` content**

```ts
import { WIZARD_SYSTEM_PROMPT } from './system-prompt';
import { PROPOSE_CHOICE_TOOL } from './tools';
import { getMasterProvider } from '@/ai/provider';

export interface ProposeInput {
  step: 'race' | 'class' | 'background' | 'abilities' | 'skills' | 'equipment' | 'identity';
  userPrompt: string;
  srdContext: string;             // pre-built reference text injected into the prompt
  currentChoices: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
}

export interface Proposal {
  step: string;
  value: unknown;
  reasoning: string;
}

export async function proposeOne(input: ProposeInput): Promise<Proposal> {
  const userMessage = [
    `# SRD reference for step: ${input.step}`,
    input.srdContext,
    '',
    '# Current wizard state',
    JSON.stringify(input.currentChoices, null, 2),
    '',
    '# User description',
    input.userPrompt,
  ].join('\n');

  const out = await getMasterProvider().proposeWizard({
    systemPrompt: WIZARD_SYSTEM_PROMPT,
    toolDefinition: PROPOSE_CHOICE_TOOL,
    userMessage,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return out.toolInput as Proposal;
}
```

- [ ] **Step 2: Run wizard tests**

```bash
pnpm test src/ai/wizard tests/ai/wizard 2>&1 | tail -10
```
Expected: existing wizard tests pass (or report which test file paths exist; if none, skip).

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add src/ai/wizard/loop.ts
git commit -m "refactor(wizard): route through provider + drop hardcoded model (Plan C debt)"
```

---

### Task 10: Update turn route to pass the provider

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Replace the import line and the `runToolLoop` call**

Open `src/app/api/sessions/[id]/turn/route.ts`. Find:

```ts
import { runToolLoop } from '@/ai/master/tool-loop';
import { getAnthropicClient, MASTER_MODEL } from '@/ai/master/anthropic-client';
import { recordUsage } from '@/ai/master/usage';
```

Replace with:

```ts
import { runToolLoop } from '@/ai/master/tool-loop';
import { getMasterProvider } from '@/ai/provider';
import { recordUsage } from '@/ai/master/usage';
```

(`MASTER_MODEL` is no longer needed at this layer — provider picks the model.)

Then find the `runToolLoop({ ... })` call and replace its `client` and `model` fields with `provider`. Also the `recordUsage` callback now receives the normalized usage shape directly (not Anthropic's). The full block becomes:

```ts
        // 5. Run the tool loop — events flush as they happen via onEvent
        const result = await runToolLoop({
          provider: getMasterProvider(),
          systemBlocks: sys.system,
          history,
          state: snap.state,
          sessionId,
          applyMutations: (muts, rolls) => applyMutations(sessionId, muts, rolls),
          recordUsage: async (usage) => {
            await recordUsage({
              userId,
              sessionId,
              endpoint: 'master',
              model: getMasterProvider().name === 'anthropic' ? (process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5') : (process.env.OPENAI_MASTER_MODEL ?? 'gpt-5'),
              usage,
            });
          },
          onEvent: (ev) => send(ev.type, ev),
        });
```

- [ ] **Step 2: Build check**

```bash
pkill -f "next dev" 2>/dev/null || true
sleep 2
pnpm build 2>&1 | tail -10
```
Expected: build succeeds.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck 2>&1 | tail -3
git add "src/app/api/sessions/[id]/turn/route.ts"
git commit -m "refactor(api): turn route uses provider dispatcher"
```

---

## Phase 4 — Verification & ship

### Task 11: Full unit + lint + e2e + tag

- [ ] **Step 1: Full unit suite**

```bash
pnpm test 2>&1 | tail -10
```
Expected: 254 (current) + ~18 new (3 dispatcher + 10 adapter + 3 openai mock + 2 openai live) = ~272 pass. Note: live tests skip if no key.

- [ ] **Step 2: Lint**

```bash
pnpm lint 2>&1 | tail -10
```
Expected: 0 errors. The 3 pre-existing warnings (`_input`, `_rng`, `_`) remain.

- [ ] **Step 3: E2E**

```bash
pkill -f "next dev" 2>/dev/null || true
sleep 2
pnpm test:e2e 2>&1 | tail -10
```
Expected: 4 pass + 1 skipped (auth gated).

- [ ] **Step 4: Build**

```bash
pnpm build 2>&1 | tail -10
```
Expected: succeeds.

- [ ] **Step 5: Live OpenAI sanity (optional, requires key)**

```bash
MASTER_PROVIDER=openai pnpm test tests/ai/provider/openai-live-smoke.test.ts 2>&1 | tail -5
```
Expected: 2 pass (skipped if `OPENAI_API_KEY` not set).

- [ ] **Step 6: Tag**

```bash
git tag plan-e-multi-provider-done
git tag --list | grep plan-
git rev-parse plan-e-multi-provider-done
```

The app now supports `MASTER_PROVIDER=openai` end-to-end: master tool loop, language detection, and wizard proposals all route to GPT-5 / GPT-5-mini. Default unchanged.

---

## Self-review

**Spec coverage:**
- §Architecture (provider abstraction, lazy dispatcher, loop in tool-loop.ts) — Tasks 1, 4, 7
- §File map — Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (all listed files covered)
- §Provider interface — Task 1 defines, Tasks 3 & 5 implement, Task 7 consumes
- §Env vars (MASTER_PROVIDER, OPENAI_*, symmetric naming) — Tasks 4 (dispatcher reads MASTER_PROVIDER) + 5 (OpenAI provider reads MASTER + LANGUAGE)
- §Adapter conversions (tool defs, messages, system prompt, response, usage) — Task 2 fully
- §Behavior matrix — Task 4 (dispatcher tests) + Task 11 step 1 (combined run)
- §Test plan (~18) — Task 2 (10) + Task 4 (4) + Task 5 (3) + Task 6 (2) = 19
- §Wizard hardcode fix — Task 9 explicit
- §Backward compat — verified by Task 7's tests still passing (Anthropic side unchanged) + Task 11 final suite

**Placeholder scan:** every step lists exact files, exact code blocks, exact commands with expected output.

**Type consistency:** `MasterProvider`, `CompleteMessageInput/Output`, `NormalizedUsage`, `ContentBlock`, `SystemBlock`, `Message`, `ToolDef` — all defined in Task 1's `types.ts` and reused identically in Tasks 2-10.

**Deviations from spec registered for follow-up:**
- The turn route's `recordUsage` callback duplicates the model-name lookup (one of two env vars depending on provider). This is acceptable for MVP. Cleanup: provider exposes `currentModel(): string`.
