import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true });

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '@/ai/provider/openai';

const HAS_KEY = !!process.env.OPENAI_API_KEY;

describe.skipIf(!HAS_KEY)('OpenAI live smoke', () => {
  it('detects Italian on a real call', async () => {
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole nel pavimento.',
    });
    expect(code).toBe('it');
  }, 30_000);

  it('detects English', async () => {
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'I cautiously explore the room and search the floor for traps.',
    });
    expect(code).toBe('en');
  }, 30_000);
});
