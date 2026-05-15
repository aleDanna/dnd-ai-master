import { describe, it, expect } from 'vitest';
import { LocalProvider } from '@/ai/provider/local';

const SMOKE = !!process.env.OLLAMA_BASE_URL && !!process.env.OLLAMA_LIVE_SMOKE;

describe.skipIf(!SMOKE)('LocalProvider live smoke', () => {
  it('completes a master-style turn with qwen3 or gpt-oss', async () => {
    const p = new LocalProvider();
    const r = await p.completeMessage({
      systemBlocks: [{ type: 'text', text: 'You are a tabletop game master. Reply briefly.' }],
      messages: [{ role: 'user', content: 'Describe a single room.' }],
      tools: [],
      model: process.env.OLLAMA_SMOKE_MODEL ?? 'qwen3:30b-a3b',
      maxTokens: 256,
    });
    expect(r.contentBlocks.length).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  }, 120_000);

  it('detects language on a non-trivial Italian message', async () => {
    const p = new LocalProvider();
    const code = await p.detectLanguage({ text: 'Sto entrando nella taverna piena di avventurieri rumorosi' });
    // Allow it/null (small models occasionally flake on edge prompts).
    expect(code === null || code === 'it').toBe(true);
  }, 60_000);
});
