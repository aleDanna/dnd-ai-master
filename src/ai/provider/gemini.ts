import { GoogleGenAI } from '@google/genai';
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

const MASTER_MODEL = process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
const LANGUAGE_MODEL = process.env.GEMINI_LANGUAGE_MODEL ?? 'gemini-2.5-flash-lite';

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

  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('GeminiProvider.detectLanguage not implemented yet');
  }

  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('GeminiProvider.proposeWizard not implemented yet');
  }
}

// Suppress unused-variable warning — LANGUAGE_MODEL is reserved for Tasks 11/12.
void LANGUAGE_MODEL;
