import type { Anthropic } from '@anthropic-ai/sdk';

/** All provider implementations available via `getProviderByName`. */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'local';

/** Subset of `ProviderName` referring to cloud-hosted SDK providers (not local).
 *  Some call sites (e.g. the turn route's language-detection branch) opt into
 *  cloud-only behavior; narrow with `isCloudProvider` to handle that path. */
export type CloudProviderName = Exclude<ProviderName, 'local'>;

/** Guard function to narrow a ProviderName to the cloud subset. */
export function isCloudProvider(value: unknown): value is CloudProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

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
  /** Ollama model-load time (ms). Undefined for cloud providers. */
  loadDurationMs?: number;
  /** Ollama prompt-eval time / prefill (ms). Undefined for cloud providers. */
  promptEvalDurationMs?: number;
  /** Ollama eval time / decode (ms). Undefined for cloud providers. */
  evalDurationMs?: number;
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
  /**
   * Gemini-specific: cap the internal "thinking" token budget. Anthropic and
   * OpenAI ignore this. Gemini 2.5 spends output tokens on internal reasoning
   * before emitting visible content, and on structured tasks like the memory
   * extractor that reasoning can consume the entire `maxTokens` budget and
   * leave zero content (observed: stopReason=max_tokens, contentBlockCount=0).
   *
   * Pass a small positive integer (e.g. 1024) to bound thinking; the
   * remaining maxTokens budget is then available for actual JSON output.
   * Passing 0 disables thinking entirely BUT errors on models that require it
   * (gemini-2.5-pro returns "Budget 0 is invalid. This model only works in
   * thinking mode."), so prefer a positive cap unless you know the target
   * model supports disable.
   */
  geminiThinkingBudget?: number;
  /**
   * Optional streaming callback. When provided, the provider streams output
   * tokens via NDJSON (where supported — currently only LocalProvider) and
   * invokes `onDelta(text)` for each incremental chunk of assistant content
   * — AFTER any thinking-mode preamble has been filtered out. The full
   * assembled content (still raw, including thinking) is returned in
   * `CompleteMessageOutput` for downstream reasoning-strip / persistence.
   * Tool calls are NOT streamed — they arrive in the final response shape.
   *
   * Callers that don't want streaming simply omit this and the provider
   * falls back to its non-streaming path.
   */
  onDelta?: (text: string) => void;
  /**
   * Optional thinking-state callback for streaming local models. Fires
   * 'start' when the provider detects the model has entered a chain-of-
   * thought phase (either via explicit `<think>` tag or markerless
   * heuristic on the first chunks). Fires 'end' when the thinking phase
   * closes and `onDelta` is about to start emitting real narration.
   *
   * Use this to render a "Master is thinking..." placeholder in the UI
   * while the thinking phase runs (it can take 5-20s on small models),
   * then swap it for the streaming narration once 'end' fires.
   */
  onThinking?: (state: 'start' | 'end') => void;
  /**
   * ISO 639-1 language code of the campaign narration ('it', 'en', 'es',
   * ...). When set AND streaming AND the model's content begins in a
   * different language than this, the provider treats the opening as
   * meta-reasoning (CoT) and discards it until the stream switches to
   * the expected language. This is the scalable fallback for models
   * that emit chain-of-thought in English (their pretrain default) even
   * when the campaign is non-English.
   */
  campaignLanguage?: string;
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
  /** Optional model override; provider falls back to its env-configured default. */
  model?: string;
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
