import { GoogleGenAI } from '@google/genai';
import type { ImageGenResult } from './openai';

let _client: GoogleGenAI | null = null;
let _override: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

/** Test-only seam — let unit tests inject a mocked GoogleGenAI instance. */
export function __setGeminiClientForTest(mock: GoogleGenAI | null): void {
  _override = mock;
}

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';

interface InlineDataPart { inlineData?: { mimeType?: string; data?: string } }

export async function generateBytesGemini(prompt: string, model?: string): Promise<ImageGenResult> {
  const m = model ?? DEFAULT_MODEL;
  try {
    if (m.startsWith('imagen-')) {
      const res = (await client().models.generateImages({
        model: m,
        prompt,
        config: { numberOfImages: 1, aspectRatio: '1:1' },
      })) as { generatedImages?: { image?: { imageBytes?: string } }[] };
      const b64 = res.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) return { ok: false, reason: 'empty_response' };
      return { ok: true, bytes: Buffer.from(b64, 'base64') };
    }
    const res = (await client().models.generateContent({
      model: m,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })) as { candidates?: { content?: { parts?: InlineDataPart[] } }[] };
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(inline.data, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
