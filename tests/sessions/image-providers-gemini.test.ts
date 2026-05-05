import { describe, it, expect, vi, afterEach } from 'vitest';

const generateContent = vi.fn();
const generateImages = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class FakeGenAI {
      models = { generateContent, generateImages };
    },
  };
});

process.env.GEMINI_API_KEY = 'test-key';
const { generateBytesGemini, __setGeminiClientForTest } = await import(
  '@/sessions/image-providers/gemini'
);

describe('generateBytesGemini', () => {
  afterEach(() => {
    __setGeminiClientForTest(null);
    generateContent.mockReset();
    generateImages.mockReset();
  });

  it('happy path with gemini-2.5-flash-image returns inlineData bytes', async () => {
    const fakeBytes = Buffer.from([0x89, 0x50]);
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: fakeBytes.toString('base64') } }],
          },
        },
      ],
    });
    const out = await generateBytesGemini('a tower', 'gemini-2.5-flash-image');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bytes.equals(fakeBytes)).toBe(true);
    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateImages).not.toHaveBeenCalled();
  });

  it('happy path with imagen-4.0-generate-001 uses generateImages', async () => {
    const fakeBytes = Buffer.from([0xff, 0xd8]);
    generateImages.mockResolvedValueOnce({
      generatedImages: [{ image: { imageBytes: fakeBytes.toString('base64') } }],
    });
    const out = await generateBytesGemini('a tower', 'imagen-4.0-generate-001');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bytes.equals(fakeBytes)).toBe(true);
    expect(generateImages).toHaveBeenCalledOnce();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('empty response → ok:false, reason:empty_response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'no image here' }] } }],
    });
    const out = await generateBytesGemini('x', 'gemini-2.5-flash-image');
    expect(out).toEqual({ ok: false, reason: 'empty_response' });
  });

  it('SDK throws → ok:false, reason:api_error with detail', async () => {
    generateContent.mockRejectedValueOnce(new Error('rate_limit'));
    const out = await generateBytesGemini('x', 'gemini-2.5-flash-image');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('api_error');
      expect(out.detail).toContain('rate_limit');
    }
  });
});
