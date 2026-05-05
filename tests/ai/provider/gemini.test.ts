import { describe, it, expect, vi } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class FakeGenAI {
      models = { generateContent };
    },
    // The provider uses FunctionCallingConfigMode.ANY; the actual SDK
    // exports a TypeScript enum whose runtime value is the string "ANY".
    // The mock just needs an object with that property so the provider's
    // `mode: FunctionCallingConfigMode.ANY` assignment doesn't read undefined.
    FunctionCallingConfigMode: { ANY: 'ANY', NONE: 'NONE', AUTO: 'AUTO', MODE_UNSPECIFIED: 'MODE_UNSPECIFIED' },
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

describe('GeminiProvider.detectLanguage', () => {
  it('returns null for trivial text without calling the API', async () => {
    const provider = new GeminiProvider();
    const before = generateContent.mock.calls.length;
    const code = await provider.detectLanguage({ text: 'ok' });
    expect(code).toBeNull();
    expect(generateContent.mock.calls.length).toBe(before);
  });

  it('returns lowercase 2-letter code from Gemini response', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'IT' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBe('it');
    const args = generateContent.mock.calls.at(-1)![0] as { model: string };
    expect(args.model).toBe('gemini-2.5-flash-lite');
  });

  it('returns null when response is not a 2-letter code', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'italian' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBeNull();
  });

  it('returns null when SDK throws', async () => {
    generateContent.mockRejectedValueOnce(new Error('boom'));
    const provider = new GeminiProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBeNull();
  });
});

describe('GeminiProvider.proposeWizard', () => {
  it('forces tool call via toolConfig and returns parsed input', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'propose_choice',
                  args: { step: 'race', value: 'half-elf', reasoning: 'versatile' },
                },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
    });

    const provider = new GeminiProvider();
    const out = await provider.proposeWizard({
      systemPrompt: 'You are a wizard helper.',
      toolDefinition: {
        name: 'propose_choice',
        description: 'propose a value',
        input_schema: {
          type: 'object',
          required: ['step', 'value', 'reasoning'],
          properties: {
            step: { type: 'string' },
            value: {},
            reasoning: { type: 'string' },
          },
        } as never,
      },
      userMessage: 'pick a race',
    });
    expect(out.toolInput).toEqual({ step: 'race', value: 'half-elf', reasoning: 'versatile' });

    const args = generateContent.mock.calls.at(-1)![0] as {
      config: { toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } } };
    };
    expect(args.config.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(args.config.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(['propose_choice']);
  });

  it('throws when no functionCall is returned', async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { role: 'model', parts: [{ text: 'sorry' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    });
    const provider = new GeminiProvider();
    await expect(
      provider.proposeWizard({
        systemPrompt: 's',
        toolDefinition: { name: 'tool_x', input_schema: { type: 'object', properties: {} } as never },
        userMessage: 'm',
      }),
    ).rejects.toThrow(/AI did not call tool_x/);
  });
});
