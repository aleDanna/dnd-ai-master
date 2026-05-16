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

  describe('Plan D — baked-model message shape', () => {
    function lastFetchBody(): { messages: Array<{ role: string; content: string }> } {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1];
      const body = JSON.parse(last![1].body as string) as { messages: Array<{ role: string; content: string }> };
      return body;
    }

    it('non-baked model: passes systemBlocks as role:system (legacy path)', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: 'assistant', content: 'ok' },
        done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
      }), { status: 200 }));

      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'GUIDANCE: balanced' }],
        messages: [{ role: 'user', content: 'attack' }],
        tools: [],
        model: 'qwen3:30b',
      });

      const body = lastFetchBody();
      expect(body.messages[0]!.role).toBe('system');
      expect(body.messages[0]!.content).toContain('GUIDANCE: balanced');
      expect(body.messages[1]!.role).toBe('user');
    });

    it('baked model: NO system role; dynamic state injected into the LAST user message', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: 'assistant', content: 'ok' },
        done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
      }), { status: 200 }));

      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'GUIDANCE: balanced' }],
        messages: [{ role: 'user', content: 'attack' }],
        tools: [],
        model: 'dnd-master-qwen3-30b',
      });

      const body = lastFetchBody();
      // No system role anywhere — Modelfile SYSTEM must be the only system source.
      expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
      // Single user message containing both the state header AND the player input.
      expect(body.messages.length).toBe(1);
      expect(body.messages[0]!.role).toBe('user');
      expect(body.messages[0]!.content).toContain('CURRENT STATE');
      expect(body.messages[0]!.content).toContain('GUIDANCE: balanced');
      expect(body.messages[0]!.content).toContain('END CURRENT STATE');
      // The actual player input comes AFTER the state block.
      expect(body.messages[0]!.content).toMatch(/END CURRENT STATE\][\s\S]*attack/);
    });

    it('baked model with history: state injected only into the LATEST user message', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: 'assistant', content: 'ok' },
        done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
      }), { status: 200 }));

      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'GUIDANCE: balanced' }],
        messages: [
          { role: 'user', content: 'old player message' },
          { role: 'assistant', content: 'old master response' },
          { role: 'user', content: 'current input' },
        ],
        tools: [],
        model: 'dnd-master-qwen3-30b',
      });

      const body = lastFetchBody();
      expect(body.messages.length).toBe(3);
      // Old messages: bare content, NO state header (KV cache prefix stays stable).
      expect(body.messages[0]!.content).toBe('old player message');
      expect(body.messages[0]!.content).not.toContain('CURRENT STATE');
      expect(body.messages[1]!.content).toBe('old master response');
      // Latest message: state injected before the player input.
      expect(body.messages[2]!.content).toContain('CURRENT STATE');
      expect(body.messages[2]!.content).toContain('GUIDANCE: balanced');
      expect(body.messages[2]!.content).toMatch(/END CURRENT STATE\][\s\S]*current input/);
    });

    it('baked model: empty systemBlocks still wraps the last user message (cache prefix stability)', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: 'assistant', content: 'ok' },
        done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
      }), { status: 200 }));

      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [],
        messages: [{ role: 'user', content: 'attack' }],
        tools: [],
        model: 'dnd-master-qwen3-30b',
      });

      const body = lastFetchBody();
      expect(body.messages.length).toBe(1);
      expect(body.messages[0]!.role).toBe('user');
      expect(body.messages[0]!.content).toContain('CURRENT STATE');
      expect(body.messages[0]!.content).toContain('attack');
    });
  });
});
