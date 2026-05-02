import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true });

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '@/ai/provider/openai';

const HAS_KEY = !!process.env.OPENAI_API_KEY;
// Live smoke tests cost real money and require an OpenAI account with active billing.
// Opt in explicitly via OPENAI_LIVE_SMOKE_ENABLED=1 to run them.
const ENABLED = process.env.OPENAI_LIVE_SMOKE_ENABLED === '1';

describe.skipIf(!HAS_KEY || !ENABLED)('OpenAI live smoke', () => {
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
