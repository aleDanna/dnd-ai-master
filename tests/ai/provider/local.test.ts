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

  describe('streaming (onDelta)', () => {
    function ndjsonStream(frames: object[]): Response {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) {
            controller.enqueue(enc.encode(JSON.stringify(f) + '\n'));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }

    it('passes stream:true to Ollama when onDelta is provided', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: 'hello ' } },
        { message: { role: 'assistant', content: 'world' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 },
      ]));

      const onDelta = vi.fn();
      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'You are a DM.' }],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta,
      });

      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string);
      expect(body.stream).toBe(true);
    });

    it('invokes onDelta with assembled narration content and returns the response', async () => {
      // Short narration that never crosses the init-decision threshold:
      // each chunk is buffered until done, then flushed in a single
      // onDelta call. The accumulated text is returned in contentBlocks.
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: 'Il guardiano ' } },
        { message: { role: 'assistant', content: 'si avvicina.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
      ]));

      const deltas: string[] = [];
      const p = new LocalProvider();
      const r = await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'You are a DM.' }],
        messages: [{ role: 'user', content: 'guardo' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta: (t) => deltas.push(t),
      });

      expect(deltas.join('')).toBe('Il guardiano si avvicina.');
      const textBlock = r.contentBlocks.find((b) => b.type === 'text');
      expect(textBlock).toBeDefined();
      if (textBlock?.type === 'text') {
        expect(textBlock.text).toBe('Il guardiano si avvicina.');
      }
    });

    it('streams narration incrementally when content crosses the decision threshold', async () => {
      // Longer narration (>80 chars in first chunk): provider decides
      // 'narration' on the first chunk and pumps subsequent chunks
      // straight through.
      const long = 'Il guardiano della torre si avvicina lentamente, la lanterna oscilla nel vento gelido della notte.';
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: long } },
        { message: { role: 'assistant', content: ' Le ombre danzano.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ]));

      const deltas: string[] = [];
      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'guardo' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta: (t) => deltas.push(t),
      });

      // Two separate deltas: the first chunk (flushed at threshold) and
      // the second chunk (passed through directly).
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.join('')).toBe(long + ' Le ombre danzano.');
    });

    it('falls back to non-streaming JSON when onDelta is omitted', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: 'assistant', content: 'ok' },
        done_reason: 'stop', prompt_eval_count: 10, eval_count: 5,
      }), { status: 200 }));

      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        model: 'qwen3:30b-a3b',
      });

      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string);
      expect(body.stream).toBe(false);
    });

    it('filters explicit <think>...</think> chain-of-thought from streaming output', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: '<think>' } },
        { message: { role: 'assistant', content: 'Let me figure out the attack...' } },
        { message: { role: 'assistant', content: '</think>\n\n' } },
        { message: { role: 'assistant', content: 'Il guardiano si avvicina.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ]));

      const deltas: string[] = [];
      const thinkingEvents: ('start' | 'end')[] = [];
      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'attacco' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta: (t) => deltas.push(t),
        onThinking: (s) => thinkingEvents.push(s),
      });

      // Only the narration after </think> reaches the UI
      const joined = deltas.join('');
      expect(joined).not.toMatch(/figure out the attack/);
      expect(joined).toContain('Il guardiano si avvicina.');
      // Thinking start+end fired exactly once each
      expect(thinkingEvents).toEqual(['start', 'end']);
    });

    it('filters markerless chain-of-thought ("Okay, let\'s break...") before narration', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: "Okay, let's break this down step by step. " } },
        { message: { role: 'assistant', content: 'The user wants to attack the goblin.\n\n' } },
        { message: { role: 'assistant', content: 'First, I need to check the initiative order.\n\n' } },
        { message: { role: 'assistant', content: 'La spada si abbatte sul nemico con un fendente potente.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ]));

      const deltas: string[] = [];
      const thinkingEvents: ('start' | 'end')[] = [];
      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'attacco' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta: (t) => deltas.push(t),
        onThinking: (s) => thinkingEvents.push(s),
      });

      const joined = deltas.join('');
      expect(joined).not.toMatch(/Okay, let's break/);
      expect(joined).not.toMatch(/The user wants/);
      expect(joined).not.toMatch(/initiative order/);
      expect(joined).toContain('La spada si abbatte');
      expect(thinkingEvents).toEqual(['start', 'end']);
    });

    it('does NOT trigger thinking filter when first chunk is direct narration', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: 'Il guardiano ti guarda con sospetto. ' } },
        { message: { role: 'assistant', content: 'La sua mano scivola verso la spada.' } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ]));

      const deltas: string[] = [];
      const thinkingEvents: ('start' | 'end')[] = [];
      const p = new LocalProvider();
      await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'guardo' }],
        tools: [],
        model: 'qwen3:30b-a3b',
        onDelta: (t) => deltas.push(t),
        onThinking: (s) => thinkingEvents.push(s),
      });

      const joined = deltas.join('');
      expect(joined).toContain('Il guardiano');
      expect(joined).toContain('verso la spada');
      // No thinking phase detected → no events fired
      expect(thinkingEvents).toEqual([]);
    });

    it('accumulates tool_calls arriving across multiple stream frames', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ndjsonStream([
        { message: { role: 'assistant', content: 'attacco. ' } },
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'make_attack', arguments: { target: 'goblin' } } }] } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
      ]));

      const p = new LocalProvider();
      const r = await p.completeMessage({
        systemBlocks: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'attacco' }],
        tools: [{ name: 'make_attack', description: 'a', input_schema: { type: 'object', properties: {} } }],
        model: 'qwen3:30b-a3b',
        onDelta: () => {},
      });

      const toolBlock = r.contentBlocks.find((b) => b.type === 'tool_use');
      expect(toolBlock).toBeDefined();
      if (toolBlock?.type === 'tool_use') {
        expect(toolBlock.name).toBe('make_attack');
      }
      expect(r.stopReason).toBe('tool_use');
    });
  });
});
