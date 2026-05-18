import type { ImageGenResult } from './openai';
import { localServiceHeaders } from '@/lib/local-fetch';

/** Generates an image via the Draw Things macOS app HTTP server. Uses the
 *  AUTOMATIC1111 SD-compatible /sdapi/v1/txt2img endpoint. */
export async function generateBytesDrawThings(prompt: string, modelName: string): Promise<ImageGenResult> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return { ok: false, reason: 'api_error', detail: 'DRAW_THINGS_BASE_URL is not set' };
  try {
    // Draw Things accepts a subset of the AUTOMATIC1111 txt2img API but rejects
    // `override_settings` (HTTP 422 'Unrecognized keys'). Switch model from
    // inside the Draw Things app, not via API. `modelName` is therefore
    // documentational only — kept in the signature for parity with OpenAI/Gemini
    // and for the live-smoke test annotation. Marked underscore-unused.
    void modelName;
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: localServiceHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        prompt,
        negative_prompt: '',
        width: 1024,
        height: 1024,
        steps: 4,  // Flux Schnell is 4-step
        sampler_name: 'DPM++ 2M Karras',
      }),
    });
    if (!res.ok) return { ok: false, reason: 'api_error', detail: `${res.status}` };
    const json = (await res.json()) as { images?: string[] };
    const b64 = json.images?.[0];
    if (!b64) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(b64, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
