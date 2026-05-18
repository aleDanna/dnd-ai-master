import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

describe('generateBytesDrawThings', () => {
  beforeEach(() => {
    vi.stubEnv('DRAW_THINGS_BASE_URL', 'http://localhost:7860');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('POSTs to /sdapi/v1/txt2img and decodes the first image', async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      images: [pngBase64],
    }), { status: 200 }));

    const r = await generateBytesDrawThings('a wizard', 'realisticVisionV60');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes[0]).toBe(0x89);
      expect(r.bytes.length).toBe(4);
    }
    const callBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body as string;
    const body = JSON.parse(callBody);
    expect(body.prompt).toBe('a wizard');
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    // Draw Things rejects override_settings (HTTP 422 'Unrecognized keys'),
    // so we don't include it. Model switching happens in the app itself.
    expect(body.override_settings).toBeUndefined();
  });

  it('returns api_error when API returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const r = await generateBytesDrawThings('x', 'm');
    expect(r.ok).toBe(false);
  });

  it('returns empty_response when images array is empty', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ images: [] }), { status: 200 }));
    const r = await generateBytesDrawThings('x', 'm');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_response');
  });
});
