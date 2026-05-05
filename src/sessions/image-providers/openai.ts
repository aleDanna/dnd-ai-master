import OpenAI from 'openai';

let _client: OpenAI | null = null;
let _override: OpenAI | null = null;

function client(): OpenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

/** Test-only seam — let unit tests inject a mocked OpenAI instance. */
export function __setOpenAIClientForTest(mock: OpenAI | null): void {
  _override = mock;
}

const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';

export type ImageGenResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'empty_response' | 'api_error'; detail?: string };

export async function generateBytesOpenAI(prompt: string, model?: string): Promise<ImageGenResult> {
  const m = model ?? DEFAULT_MODEL;
  try {
    const res = await client().images.generate({ model: m, prompt, size: '1024x1024' });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(b64, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
