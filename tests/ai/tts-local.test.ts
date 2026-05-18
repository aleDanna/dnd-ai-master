import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { synthesizeSpeech } from '@/ai/tts';

describe('synthesizeSpeech — provider=local engine=piper', () => {
  beforeEach(() => {
    vi.stubEnv('PIPER_BASE_URL', 'http://localhost:8050');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('POSTs to /v1/audio/speech with OpenAI-compat body and returns MP3', async () => {
    const fakeMp3 = new Uint8Array([0xff, 0xfb, 0x00, 0x00]).buffer;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(fakeMp3, { status: 200 }));

    const r = await synthesizeSpeech({
      text: 'hello',
      provider: 'local',
      model: 'piper',
      voice: 'en_US-amy-low',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8050/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'piper',
          voice: 'en_US-amy-low',
          input: 'hello',
          response_format: 'mp3',
        }),
      }),
    );
    expect(r.mimeType).toBe('audio/mpeg');
    expect(new Uint8Array(r.bytes)).toEqual(new Uint8Array(fakeMp3));
  });

  it('throws when Piper returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('bad voice', { status: 400 }));
    await expect(synthesizeSpeech({
      text: 'hi', provider: 'local', model: 'piper', voice: 'nope',
    })).rejects.toThrow(/piper 400/);
  });

  it('throws when PIPER_BASE_URL is unset', async () => {
    vi.stubEnv('PIPER_BASE_URL', '');
    await expect(synthesizeSpeech({
      text: 'hi', provider: 'local', model: 'piper', voice: 'en_US-amy-low',
    })).rejects.toThrow(/PIPER_BASE_URL is not set/);
  });
});

describe('synthesizeSpeech — provider=local invalid engine', () => {
  it('throws when model is missing or unknown', async () => {
    await expect(synthesizeSpeech({ text: 'x', provider: 'local' }))
      .rejects.toThrow(/local engine must be 'piper'/);
    await expect(synthesizeSpeech({ text: 'x', provider: 'local', model: 'unknown' }))
      .rejects.toThrow(/local engine must be 'piper'/);
  });
});
