import { describe, it, expect } from 'vitest';
import { synthesizeSpeech } from '@/ai/tts';

const PIPER_OK = !!process.env.PIPER_BASE_URL && !!process.env.LOCAL_TTS_LIVE_SMOKE;

describe.skipIf(!PIPER_OK)('synthesizePiper live smoke', () => {
  it('produces a non-empty MP3 for a short text', async () => {
    const r = await synthesizeSpeech({
      text: 'Hello from the local Piper smoke test.',
      provider: 'local',
      model: 'piper',
      voice: process.env.PIPER_SMOKE_VOICE ?? 'en_US-amy-low',
    });
    expect(r.mimeType).toBe('audio/mpeg');
    expect(r.bytes.byteLength).toBeGreaterThan(1000);
  }, 60_000);
});
