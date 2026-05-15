import type { Anthropic } from '@anthropic-ai/sdk';

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';

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
