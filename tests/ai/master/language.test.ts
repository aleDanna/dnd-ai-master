import { describe, it, expect, vi } from 'vitest';
import { detectLanguage } from '@/ai/master/language';

describe('detectLanguage', () => {
  it('returns null for too-short input', async () => {
    const out = await detectLanguage({ text: 'ok', stub: { detect: vi.fn() } });
    expect(out).toBeNull();
  });

  it('uses the stub to classify and returns the lowercase code', async () => {
    const stub = { detect: vi.fn().mockResolvedValue('it') };
    const out = await detectLanguage({ text: 'Esploro la stanza con cautela e cerco trappole.', stub });
    expect(out).toBe('it');
    expect(stub.detect).toHaveBeenCalledOnce();
  });

  it('falls back to null on stub error', async () => {
    const stub = { detect: vi.fn().mockRejectedValue(new Error('boom')) };
    const out = await detectLanguage({ text: 'I draw my sword and approach the door.', stub });
    expect(out).toBeNull();
  });
});
