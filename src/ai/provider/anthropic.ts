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
    const model = input.model ?? MASTER_MODEL;
    const resp = await client.messages.create({
      model,
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
        model,
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
