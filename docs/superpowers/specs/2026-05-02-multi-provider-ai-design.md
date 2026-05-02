# Multi-Provider AI (Anthropic + OpenAI) — Design

**Status:** Approved · **Date:** 2026-05-02 · **Author:** alessio.danna.94@gmail.com

## Goal

Add OpenAI as an alternative AI provider, selectable at deploy time via the `MASTER_PROVIDER` env var. When set to `openai`, all three AI callsites (master tool loop, language detection, wizard proposal) route to OpenAI instead of Anthropic. Default remains `anthropic` — existing deployments are unaffected.

## Non-goals

- ❌ UI for selecting the provider (env-var only)
- ❌ Schema migration (no `sessions.provider` column)
- ❌ Per-session or per-account override
- ❌ Automatic failover between providers if one is down
- ❌ Refactoring of the existing Anthropic callsites beyond what's needed to insert the abstraction layer
- ❌ Removal of the Anthropic implementation (always available)
- ❌ Migration from OpenAI Chat Completions API to the Responses API (deferred)

## Architecture

A thin abstraction layer at `src/ai/provider/` exposes a single interface, `MasterProvider`, with two concrete implementations: `AnthropicProvider` (wraps existing logic) and `OpenAIProvider` (new). A cached singleton dispatcher reads `MASTER_PROVIDER` at first request and returns the matching instance. The three AI callsites — `src/ai/master/tool-loop.ts`, `src/ai/master/language.ts`, and the wizard proposal endpoint — call `getMasterProvider().<method>(...)` and receive normalized output, with no knowledge of which provider was selected.

The master tool loop's iterative behaviour (per-turn tool-call cap, timeout, mutation application, `onEvent` SSE flushing) **stays in `tool-loop.ts`**. The provider abstraction handles only one round-trip API call at a time. This keeps the loop logic in one place and minimizes per-provider duplication.

## File map

**New files:**

```
src/ai/provider/
├── types.ts            — MasterProvider interface, NormalizedUsage, ProviderName, request/response shapes
├── index.ts            — getMasterProvider() dispatcher (cached singleton)
├── anthropic.ts        — AnthropicProvider implementing MasterProvider (wraps existing client)
├── openai.ts           — OpenAIProvider implementing MasterProvider (new)
└── tool-adapter.ts     — Anthropic↔OpenAI conversions for tools, messages, system prompt, response, usage
```

**Modified files (minimal changes):**
- `src/ai/master/tool-loop.ts` — accepts `provider: MasterProvider` instead of `client: Anthropic`; replaces `client.messages.create(...)` with `provider.completeMessage(...)`. Loop, cap, timeout, `onEvent`, `applyMutations`, `recordUsage` unchanged.
- `src/ai/master/language.ts` — replaces inline Anthropic call with `getMasterProvider().detectLanguage(...)`.
- `src/ai/wizard/loop.ts` — replaces hardcoded `claude-sonnet-4-5-20250929` with `getMasterProvider().proposeWizard(...)`. **In-passing fix** of the Plan C debt: model is no longer hardcoded.
- `src/app/api/sessions/[id]/turn/route.ts` — passes `getMasterProvider()` to `runToolLoop` instead of `getAnthropicClient()`.
- `tests/ai/master/tool-loop.test.ts` — updates the mock client to a fake `MasterProvider`. Asserts unchanged.

## Provider interface

```ts
export type ProviderName = 'anthropic' | 'openai';

export interface MasterProvider {
  readonly name: ProviderName;

  /** Single API round-trip with tool definitions. The iterative loop lives in tool-loop.ts. */
  completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput>;

  /** One-shot 2-letter language detection. */
  detectLanguage(input: { text: string }): Promise<string | null>;

  /** One-shot wizard character proposal (returns parseable JSON proposal). */
  proposeWizard(input: WizardProposalInput): Promise<WizardProposalOutput>;
}

export interface CompleteMessageInput {
  systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: AnthropicLikeMessage[];   // existing tool-loop shape — adapter converts internally for OpenAI
  tools: AnthropicLikeToolDef[];      // engine TOOL_DEFINITIONS shape (Anthropic-style)
  model?: string;                     // optional override; defaults to provider's master model env
  maxTokens?: number;                 // default 4096
  sessionId?: string;                 // optional, used as OpenAI prompt_cache_key for affinity
}

export interface CompleteMessageOutput {
  contentBlocks: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  )[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage: NormalizedUsage;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;   // 0 for OpenAI (no concept)
}
```

## Env vars

| Var | Default | Effect |
|-----|---------|--------|
| `MASTER_PROVIDER` | `anthropic` | dispatcher selector: `anthropic` or `openai` |
| `OPENAI_API_KEY` | — | required if provider=openai (lazy fail at first call) |
| `OPENAI_MASTER_MODEL` | `gpt-5` | master tool loop + wizard (OpenAI side) |
| `OPENAI_LANGUAGE_MODEL` | `gpt-5-mini` | language detection (OpenAI side) |
| `ANTHROPIC_API_KEY` | — | existing |
| `ANTHROPIC_MASTER_MODEL` | `claude-sonnet-4-5` | existing — now also used by wizard (after in-passing fix) |
| `ANTHROPIC_LANGUAGE_MODEL` | `claude-haiku-4-5` | existing |

Naming is symmetric: `MASTER` + `LANGUAGE` for both providers. Wizard uses the master model on either side (heavy + structured output). Language detection uses a cheaper model.

## Adapter conversions (`tool-adapter.ts`)

### Tool definitions: Anthropic → OpenAI

```
{ name, description, input_schema }
```
becomes
```
{ type: 'function', function: { name, description, parameters: input_schema } }
```

JSON Schema is portable. **Strict mode is OFF** in the MVP — many of our 18 engine tools have non-required properties that would violate `additionalProperties: false`. Tightening is a follow-up.

### Messages: Anthropic → OpenAI Chat Completions

| Anthropic shape | OpenAI shape |
|---|---|
| `{role:'user', content:'string'}` | `{role:'user', content:'string'}` |
| `{role:'assistant', content:[{type:'text',text}]}` | `{role:'assistant', content:'text'}` (collapse text blocks) |
| `{role:'assistant', content:[text + tool_use blocks]}` | `{role:'assistant', content:'text', tool_calls:[{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]}` |
| `{role:'user', content:[tool_result × N]}` | **Fan-out**: N messages `{role:'tool', content, tool_call_id}` (OpenAI requires one tool message per result) |

### System prompt: Anthropic → OpenAI

Anthropic's system blocks `[{type:'text', text, cache_control}, ...]` are flattened into a single string by concatenating `text` values with `\n\n`. The `cache_control` field is dropped — OpenAI uses automatic caching for prompts ≥1024 tokens with no client opt-in.

### Response: OpenAI → internal (Anthropic-shape)

```
choices[0].message.content (string|null)  →  { type:'text', text } block (skip if null)
choices[0].message.tool_calls (array)     →  { type:'tool_use', id, name, input: JSON.parse(arguments) } blocks
finish_reason mapping:
  'stop'           → 'end_turn'
  'tool_calls'     → 'tool_use'
  'length'         → 'max_tokens'
  'content_filter' → 'other'
```

### Usage normalization

| Field | Anthropic source | OpenAI source |
|---|---|---|
| `inputTokens` | `usage.input_tokens` | `usage.prompt_tokens` |
| `outputTokens` | `usage.output_tokens` | `usage.completion_tokens` |
| `cacheReadTokens` | `usage.cache_read_input_tokens ?? 0` | `usage.prompt_tokens_details?.cached_tokens ?? 0` |
| `cacheCreationTokens` | `usage.cache_creation_input_tokens ?? 0` | `0` (no concept on OpenAI) |

`recordUsage` (in `src/ai/master/usage.ts`) already accepts the normalized shape — no changes downstream.

## Behavior matrix

| `MASTER_PROVIDER` | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | Outcome |
|---|---|---|---|
| unset (default) | set | (any) | Anthropic — current behavior unchanged |
| unset (default) | unset | (any) | Throws at first call: `ANTHROPIC_API_KEY is not set` |
| `anthropic` | set | (any) | Anthropic |
| `anthropic` | unset | (any) | Throws at first call |
| `openai` | (any) | set | OpenAI, all three callsites |
| `openai` | (any) | unset | Throws at first call: `OPENAI_API_KEY is not set` |
| any other value | (any) | (any) | Dispatcher throws: `unknown MASTER_PROVIDER: <x>` |

Validation is lazy (at first request), matching the existing `getAnthropicClient()` pattern. No boot-time check.

## Test plan

**New tests (~18):**

```
tests/ai/provider/
├── dispatcher.test.ts          (3) — env combinations
├── tool-adapter.test.ts        (10) — conversions A↔O
├── openai.test.ts              (3) — OpenAIProvider with mocked SDK
└── openai-live-smoke.test.ts   (2) — gated by OPENAI_API_KEY
```

**`tool-adapter.test.ts` covers:**
1. Tool definition Anthropic → OpenAI function (base case)
2. System prompt flatten (concat + drop cache_control)
3. User message string → OpenAI user message
4. Assistant text blocks → OpenAI assistant string
5. Assistant text + tool_use → OpenAI assistant + tool_calls (with `JSON.stringify(input)`)
6. User tool_result blocks (N) → fan-out to N OpenAI `role:'tool'` messages
7. OpenAI response text-only → Anthropic-shape `[{type:'text', text}]`
8. OpenAI response tool_calls-only → Anthropic-shape `[{type:'tool_use', ...}]` (with `JSON.parse(arguments)`)
9. OpenAI response mixed text + tool_calls → mixed blocks
10. `finish_reason` mapping (4 values) + usage normalization (both providers)

**Existing tests — zero changes to assertions:**
- `tests/ai/master/tool-loop.test.ts` (5) — small mock update from `client` to a fake `MasterProvider`. Same behavior asserted.
- `tests/ai/master/live-smoke.test.ts` (2) — gated by `ANTHROPIC_API_KEY`, tests `AnthropicProvider`. No content changes.

**Total expected:** 254 current + ~18 new = ~272.

## Wizard hardcode fix (in-passing)

`src/ai/wizard/loop.ts` currently hardcodes `'claude-sonnet-4-5-20250929'`. This violates the env-overridable pattern used elsewhere. The wizard is one of the three callsites being refactored — fixing the hardcode in the same PR is the natural moment.

After this design lands:
- Wizard goes through `getMasterProvider().proposeWizard(...)`
- Anthropic side reads `ANTHROPIC_MASTER_MODEL` (default `claude-sonnet-4-5`)
- OpenAI side reads `OPENAI_MASTER_MODEL` (default `gpt-5`)

## Backward compatibility

- Default behavior identical to today (Anthropic, all three callsites).
- All existing Anthropic tests continue to pass with minimal mock updates (s/client/provider/).
- Existing env vars are unchanged in name and semantics.
- Anthropic implementation is preserved; switching providers is bidirectional.

## Out-of-scope future work

- **Per-session provider selection** — would require schema migration (`sessions.provider` column) and UI on `/sessions/new`.
- **Automatic failover** — useful if a provider has an outage, but adds retry/circuit-breaker complexity.
- **OpenAI Responses API** — newer API with built-in reasoning summaries. Migration could improve master quality but doubles the API surface during transition.
- **Strict tool schemas** — requires auditing all 18 engine tools for `additionalProperties: false` and `required` completeness.
- **Vercel AI Gateway** — unified routing across providers. Would replace this design entirely; viable when/if you want zero direct-provider keys.
- **Cross-provider cost reporting** — `recordUsage` records normalized tokens but the per-token price differs by model. Out of scope; quotas today are tokens-based and provider-agnostic.
