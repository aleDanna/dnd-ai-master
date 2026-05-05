import { describe, it, expect, vi } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class FakeGenAI {
      models = { generateContent };
    },
  };
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MASTER_MODEL = 'gemini-2.5-pro';
process.env.GEMINI_LANGUAGE_MODEL = 'gemini-2.5-flash-lite';

const { GeminiProvider } = await import('@/ai/provider/gemini');

describe('GeminiProvider', () => {
  it('completeMessage routes systemBlocks → systemInstruction, sends tools, normalizes response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'roll_d20', args: { mod: 3 } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, cachedContentTokenCount: 80 },
    });

    const provider = new GeminiProvider();
    const out = await provider.completeMessage({
      systemBlocks: [{ type: 'text', text: 'be the master' }],
      messages: [{ role: 'user', content: 'roll please' }],
      tools: [
        {
          name: 'roll_d20',
          description: 'roll',
          input_schema: { type: 'object', properties: { mod: { type: 'number' } } } as never,
        },
      ],
    });

    expect(generateContent).toHaveBeenCalledOnce();
    const args = generateContent.mock.calls[0]![0] as {
      model: string;
      contents: unknown[];
      config: { systemInstruction: unknown; tools: unknown };
    };
    expect(args.model).toBe('gemini-2.5-pro');
    expect(args.config.systemInstruction).toEqual({ parts: [{ text: 'be the master' }] });
    expect(args.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'roll_d20',
            description: 'roll',
            parameters: { type: 'object', properties: { mod: { type: 'number' } } },
          },
        ],
      },
    ]);

    expect(out.stopReason).toBe('tool_use');
    expect(out.contentBlocks).toHaveLength(1);
    expect(out.contentBlocks[0]?.type).toBe('tool_use');
    if (out.contentBlocks[0]?.type === 'tool_use') {
      expect(out.contentBlocks[0].name).toBe('roll_d20');
      expect(out.contentBlocks[0].input).toEqual({ mod: 3 });
    }
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('completeMessage uses model override when provided', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    await provider.completeMessage({
      systemBlocks: [{ type: 'text', text: 's' }],
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      model: 'gemini-2.5-flash',
    });
    const args = generateContent.mock.calls.at(-1)![0] as { model: string };
    expect(args.model).toBe('gemini-2.5-flash');
  });
});
