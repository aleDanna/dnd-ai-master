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
