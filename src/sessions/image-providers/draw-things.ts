import type { ImageGenResult } from './openai';

/** Generates an image via the Draw Things macOS app HTTP server. Uses the
 *  AUTOMATIC1111 SD-compatible /sdapi/v1/txt2img endpoint. */
export async function generateBytesDrawThings(prompt: string, modelName: string): Promise<ImageGenResult> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return { ok: false, reason: 'api_error', detail: 'DRAW_THINGS_BASE_URL is not set' };
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        negative_prompt: '',
        width: 1024,
        height: 1024,
        steps: 8,
        sampler_name: 'DPM++ 2M Karras',
        override_settings: { sd_model_checkpoint: modelName },
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
