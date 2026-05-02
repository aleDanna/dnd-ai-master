import { config as loadEnv } from 'dotenv';
// Override pre-set shell envs (e.g. ANTHROPIC_API_KEY="" in some sandbox shells).
loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true });

import { describe, it, expect } from 'vitest';
import { detectLanguage } from '@/ai/master/language';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('live AI smoke', () => {
  it('detects Italian on a real Haiku call', async () => {
    const code = await detectLanguage({ text: 'Esploro la stanza con cautela e cerco trappole nel pavimento.' });
    expect(code).toBe('it');
  }, 30_000);

  it('detects English', async () => {
    const code = await detectLanguage({ text: 'I cautiously explore the room and search the floor for traps.' });
    expect(code).toBe('en');
  }, 30_000);
});
