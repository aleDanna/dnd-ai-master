import { describe, it, expect, vi } from 'vitest';

// Mock the OpenAI module BEFORE importing the provider.
const create = vi.fn();
vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = { completions: { create } };
    },
  };
});

// Set env vars BEFORE the provider module loads (it reads them at module top-level).
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MASTER_MODEL = 'gpt-5';
process.env.OPENAI_LANGUAGE_MODEL = 'gpt-5-mini';

const { OpenAIProvider } = await import('@/ai/provider/openai');

describe('OpenAIProvider', () => {
  it('completeMessage flattens system, sends tools, normalizes response', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'roll_d20', arguments: '{"mod":3}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    });

    const provider = new OpenAIProvider();
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

    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]![0] as { messages: unknown[]; tools: unknown[]; model: string };
    expect(args.model).toBe('gpt-5');
    expect((args.messages[0] as { role: string }).role).toBe('system');
    expect(args.tools).toHaveLength(1);

    expect(out.stopReason).toBe('tool_use');
    expect(out.contentBlocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'roll_d20', input: { mod: 3 } },
    ]);
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  it('detectLanguage returns lowercase 2-letter code', async () => {
    create.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'IT' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
    const provider = new OpenAIProvider();
    const code = await provider.detectLanguage({
      text: 'Esploro la stanza con cautela e cerco trappole sul pavimento.',
    });
    expect(code).toBe('it');
  });

  it('proposeWizard returns the parsed tool input', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: {
                  name: 'propose_choice',
                  arguments: '{"step":"race","value":"half-elf","reasoning":"versatile"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const provider = new OpenAIProvider();
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
  });
});
