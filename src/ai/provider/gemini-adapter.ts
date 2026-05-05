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
  const rest: Record<string, unknown> = { ...schema };
  delete rest.additionalProperties;
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
