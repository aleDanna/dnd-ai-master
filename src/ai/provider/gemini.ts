import { GoogleGenAI, FunctionCallingConfigMode, HarmCategory, HarmBlockThreshold } from '@google/genai';
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

/**
 * Relaxed safety thresholds. D&D narration regularly contains implied violence
 * ("you slash the goblin", "blood pools on the stone"), and Gemini's default
 * BLOCK_MEDIUM_AND_ABOVE flags those scenes — the response comes back with
 * finishReason='SAFETY' and zero content parts, which the memory extractor
 * then logs as `extractor.bad_json` with an empty sample.
 *
 * BLOCK_ONLY_HIGH still blocks egregious content (graphic torture, hate, etc.)
 * but lets normal heroic-fantasy combat through. This is appropriate for a
 * D&D table where the genre baseline is "you fight monsters".
 */
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

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

/**
 * Retry a Gemini SDK call up to `maxAttempts` times with exponential backoff
 * (1s, 2s, 4s) when Google returns 503/UNAVAILABLE/overloaded. The Pro model
 * in particular hits these spikes; without retry every spike surfaces as a
 * turn_error in the UI.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/503|UNAVAILABLE|overloaded|high demand/i.test(msg)) throw e;
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

export class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const client = getClient();
    const systemInstruction = flattenSystemBlocksForGemini(input.systemBlocks);
    const contents = anthropicMessagesToGemini(input.messages);
    const functionDeclarations = input.tools.map(anthropicToolToGemini);

    const response = (await withRetry(() => client.models.generateContent({
      model: input.model ?? MASTER_MODEL,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
        maxOutputTokens: input.maxTokens ?? 4096,
        safetySettings: SAFETY_SETTINGS,
        // Gemini 2.5 spends output tokens on internal "thinking" before
        // emitting visible content. When the caller asks for a specific
        // thinking budget (structured-extraction tasks like the memory
        // extractor), cap it so it can't eat the entire maxOutputTokens.
        // Without this, observed: stopReason='max_tokens', contentBlockCount=0.
        ...(typeof input.geminiThinkingBudget === 'number'
          ? { thinkingConfig: { thinkingBudget: input.geminiThinkingBudget } }
          : {}),
      },
    }))) as GeminiResponse;

    // Make safety blocks visible. When finishReason is 'SAFETY' or 'BLOCKLIST'
    // the response has no content parts, and callers downstream (memory
    // extractor, etc.) silently produce empty output. Logging here lets the
    // user spot why a turn / chapter came back empty without enabling a debug
    // build.
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      console.warn('gemini.completeMessage.unusual_finish', {
        finishReason,
        partCount: response.candidates?.[0]?.content?.parts?.length ?? 0,
        model: input.model ?? MASTER_MODEL,
      });
    }

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
      const response = (await withRetry(() => client.models.generateContent({
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
          safetySettings: SAFETY_SETTINGS,
        },
      }))) as GeminiResponse;
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
    const response = (await withRetry(() => client.models.generateContent({
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
        safetySettings: SAFETY_SETTINGS,
      },
    }))) as GeminiResponse;

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

