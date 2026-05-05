import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicMessagesToGemini,
  anthropicToolToGemini,
  flattenSystemBlocksForGemini,
  geminiFinishReasonToStopReason,
  geminiResponseToContentBlocks,
  normalizeGeminiUsage,
  type GeminiResponse,
} from './gemini-adapter';
import { recordUsage } from '@/ai/master/usage';

const MASTER_MODEL = process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
const LANGUAGE_MODEL = process.env.GEMINI_LANGUAGE_MODEL ?? 'gemini-2.5-flash-lite';

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const client = getClient();
    const systemInstruction = flattenSystemBlocksForGemini(input.systemBlocks);
    const contents = anthropicMessagesToGemini(input.messages);
    const functionDeclarations = input.tools.map(anthropicToolToGemini);

    const response = (await client.models.generateContent({
      model: input.model ?? MASTER_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
        maxOutputTokens: input.maxTokens ?? 4096,
      },
    })) as GeminiResponse;

    const contentBlocks = geminiResponseToContentBlocks(response);
    const hasFunctionCall = contentBlocks.some((b) => b.type === 'tool_use');
    return {
      contentBlocks,
      stopReason: geminiFinishReasonToStopReason(
        response.candidates?.[0]?.finishReason,
        hasFunctionCall,
      ),
      usage: normalizeGeminiUsage(response.usageMetadata),
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    const client = getClient();
    try {
      const response = (await client.models.generateContent({
        model: LANGUAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
        config: {
          systemInstruction: {
            parts: [{
              text:
                'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
            }],
          },
          maxOutputTokens: 8,
        },
      })) as GeminiResponse;
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: LANGUAGE_MODEL,
          usage: normalizeGeminiUsage(response.usageMetadata),
        });
      }
      const text = response.candidates?.[0]?.content?.parts
        ?.map((p) => ('text' in p && p.text) || '')
        .join('')
        .trim()
        .toLowerCase() ?? '';
      return /^[a-z]{2}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const client = getClient();
    const tool = anthropicToolToGemini(input.toolDefinition);
    const model = input.model ?? MASTER_MODEL;
    const response = (await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: input.userMessage }] }],
      config: {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        tools: [{ functionDeclarations: [tool] }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [input.toolDefinition.name],
          },
        },
        maxOutputTokens: 1024,
      },
    })) as GeminiResponse;

    const usage = normalizeGeminiUsage(response.usageMetadata);
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model,
        usage,
      });
    }

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if ('functionCall' in part && part.functionCall?.name === input.toolDefinition.name) {
        const args = part.functionCall.args;
        let toolInput: Record<string, unknown>;
        if (typeof args === 'string') {
          try {
            toolInput = JSON.parse(args) as Record<string, unknown>;
          } catch {
            toolInput = { _raw: args };
          }
        } else {
          toolInput = (args ?? {}) as Record<string, unknown>;
        }
        return { toolInput, usage };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}

