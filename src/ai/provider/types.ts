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
