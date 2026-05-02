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
    const model = input.model ?? MASTER_MODEL;
    const resp = await client.chat.completions.create({
      model,
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
        model,
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
