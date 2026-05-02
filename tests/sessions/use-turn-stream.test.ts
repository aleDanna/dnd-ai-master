import { describe, it, expect } from 'vitest';

/** Mirrors the parsing logic inside useTurnStream's reader loop, in isolation. */
function parseSseChunk(buffer: string): { events: { name: string; data: string }[]; remaining: string } {
  const events: { name: string; data: string }[] = [];
  const lines = buffer.split('\n\n');
  const remaining = lines.pop() ?? '';
  for (const block of lines) {
    const evMatch = /^event: (.+)$/m.exec(block);
    const dataMatch = /^data: (.+)$/m.exec(block);
    if (evMatch && dataMatch) events.push({ name: evMatch[1]!, data: dataMatch[1]! });
  }
  return { events, remaining };
}

describe('SSE chunk parser', () => {
  it('parses a single complete event', () => {
    const r = parseSseChunk('event: narrative_delta\ndata: {"type":"narrative_delta","text":"Hi"}\n\n');
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.name).toBe('narrative_delta');
    expect(JSON.parse(r.events[0]!.data).text).toBe('Hi');
    expect(r.remaining).toBe('');
  });

  it('parses two events back-to-back', () => {
    const wire =
      'event: a\ndata: {"x":1}\n\n' +
      'event: b\ndata: {"x":2}\n\n';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(2);
    expect(r.events.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('keeps an incomplete trailing event in the remainder', () => {
    const wire =
      'event: a\ndata: {"x":1}\n\n' +
      'event: b\ndata: {"x":';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(1);
    expect(r.remaining).toBe('event: b\ndata: {"x":');
  });

  it('ignores blocks missing event or data line', () => {
    const wire = 'data: nope\n\nevent: x\n\n';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(0);
  });
});
