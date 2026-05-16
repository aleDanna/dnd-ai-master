import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalProvider } from '@/ai/provider/local';

describe('LocalProvider', () => {
  beforeEach(() => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('completeMessage POSTs to /api/chat and returns canonical shape', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        role: 'assistant',
        content: 'rolling now',
        tool_calls: [{ function: { name: 'roll_dice', arguments: { sides: 20 } } }],
      },
      done_reason: 'stop',
      prompt_eval_count: 100,
      eval_count: 50,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.completeMessage({
      systemBlocks: [{ type: 'text', text: 'You are a DM.' }],
      messages: [{ role: 'user', content: 'attack the goblin' }],
      tools: [{ name: 'roll_dice', description: 'roll', input_schema: { type: 'object', properties: {} } }],
      model: 'qwen3:30b-a3b',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(r.contentBlocks).toHaveLength(2);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
  });

  it('completeMessage throws when /api/chat returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('Bad model', { status: 404 }));

    const p = new LocalProvider();
    await expect(p.completeMessage({
      systemBlocks: [], messages: [], tools: [], model: 'qwen3:30b-a3b',
    })).rejects.toThrow(/ollama chat 404/);
  });

  it('detectLanguage returns null for trivial text', async () => {
    const p = new LocalProvider();
    expect(await p.detectLanguage({ text: 'ok' })).toBeNull();
  });

  it('detectLanguage returns ISO code from response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'it' },
      done_reason: 'stop',
      prompt_eval_count: 50,
      eval_count: 2,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.detectLanguage({ text: 'Buongiorno come va oggi nel parco' });
    expect(r).toBe('it');
  });

  it('proposeWizard returns toolInput when tool_call present', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'propose_choice', arguments: { choice: 'wizard', stat: 'INT' } } }],
      },
      done_reason: 'stop',
      prompt_eval_count: 80,
      eval_count: 20,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.proposeWizard({
      systemPrompt: 'You propose.',
      toolDefinition: {
        name: 'propose_choice',
        description: 'pick',
        input_schema: { type: 'object', properties: { choice: { type: 'string' }, stat: { type: 'string' } } },
      },
      userMessage: 'Suggest a class',
    });
    expect(r.toolInput).toEqual({ choice: 'wizard', stat: 'INT' });
  });

  it('proposeWizard throws if response has no tool_call', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'I think you should pick wizard.' },
      done_reason: 'stop',
      prompt_eval_count: 80,
      eval_count: 30,
    }), { status: 200 }));

    const p = new LocalProvider();
    await expect(p.proposeWizard({
      systemPrompt: 'X',
      userMessage: 'Y',
      toolDefinition: { name: 'propose_choice', description: '', input_schema: { type: 'object' } },
    })).rejects.toThrow(/AI did not call propose_choice/);
  });
});
