import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBytesComfyUI, loadWorkflowTemplate, escapeJsonString } from '@/sessions/image-providers/comfyui';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

describe('comfyui workflow loader', () => {
  it('loads flux-schnell template containing {{PROMPT}} placeholder', async () => {
    const tmpl = await loadWorkflowTemplate('flux-schnell');
    expect(tmpl).toContain('{{PROMPT}}');
    const parsed = JSON.parse(tmpl.replace('{{PROMPT}}', escapeJsonString('a wizard')));
    expect(parsed).toBeTypeOf('object');
  });

  it('throws on unknown workflow name', async () => {
    await expect(loadWorkflowTemplate('does-not-exist')).rejects.toThrow();
  });

  it('escapeJsonString escapes quotes and backslashes', () => {
    expect(escapeJsonString('a "quoted" \\ value')).toBe('a \\"quoted\\" \\\\ value');
  });
});

describe('generateBytesComfyUI', () => {
  beforeEach(() => {
    vi.stubEnv('COMFYUI_BASE_URL', 'http://localhost:8188');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('submits, polls, fetches view, returns PNG bytes', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'p_001' }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      p_001: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } },
    }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer, { status: 200 }));

    const r = await generateBytesComfyUI('a wizard', 'flux-schnell');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.length).toBe(4);
      expect(r.bytes[0]).toBe(0x89);
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8188/prompt');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:8188/history/p_001');
    expect(fetchMock.mock.calls[2]?.[0] as string).toMatch(/\/view\?filename=out\.png/);
  });

  it('returns api_error when submit returns 5xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const r = await generateBytesComfyUI('x', 'flux-schnell');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('api_error');
  });

  it('returns empty_response when SaveImage node has no images', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'p_001' }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      p_001: { status: { completed: true }, outputs: { '9': { images: [] } } },
    }), { status: 200 }));

    const r = await generateBytesComfyUI('x', 'flux-schnell');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_response');
  });
});

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
    expect(body.override_settings.sd_model_checkpoint).toBe('realisticVisionV60');
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
