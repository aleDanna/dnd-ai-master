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
