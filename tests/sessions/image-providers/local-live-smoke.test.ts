import { describe, it, expect } from 'vitest';
import { generateBytesComfyUI } from '@/sessions/image-providers/comfyui';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

const COMFY_OK = !!process.env.COMFYUI_BASE_URL && !!process.env.LOCAL_IMAGE_LIVE_SMOKE;
const DT_OK    = !!process.env.DRAW_THINGS_BASE_URL && !!process.env.LOCAL_IMAGE_LIVE_SMOKE;

describe.skipIf(!COMFY_OK)('generateBytesComfyUI live smoke', () => {
  it('produces a PNG ≥ 50KB for a simple prompt', async () => {
    const r = await generateBytesComfyUI('a single candle in a dark room, fantasy painting', 'flux-schnell');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeGreaterThan(50_000);
  }, 180_000);
});

describe.skipIf(!DT_OK)('generateBytesDrawThings live smoke', () => {
  it('produces a PNG ≥ 50KB for a simple prompt', async () => {
    const model = process.env.DRAW_THINGS_SMOKE_MODEL ?? 'SDXL Base 1.0';
    const r = await generateBytesDrawThings('a single candle in a dark room, fantasy painting', model);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeGreaterThan(50_000);
  }, 120_000);
});
