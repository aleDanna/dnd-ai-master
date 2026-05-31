import { describe, it, expect } from 'vitest';
import { parseInlineEvents } from '@/ai/master/vault/inline-events';

/**
 * Tests for the inline-event fallback parser.
 *
 * Local models (qwen3) frequently LEAK combat events as markdown bold text
 * in their narration instead of calling the `apply_event` tool. These tests
 * pin the recovery behavior against the two real observed leak shapes
 * (Goblin Warren / unquoted keys + nested arrays, and One Piece / quoted
 * marker + standalone JSON line).
 */

const ALLOWED = new Set([
  'combat_start',
  'monster_spawn',
  'initiative_set',
  'turn_advance',
  'monster_hp_change',
  'combat_end',
  'hp_change',
]);

// Example A — the primary case. Unquoted keys, nested array, mixed
// string/number values, markdown bold, trailing two-space hard breaks.
const EXAMPLE_A = [
  'Ti lanci in avanti con un grido.',
  '',
  '**combat_start**  ',
  '**monster_spawn** {id: "mutant-1", name: "Ombra del Mulino", hpMax: 24, ac: 13, initiativeBonus: 2, cr: 1}  ',
  '**initiative_set** {order: [{actorId: "302099dd-1572-44b7-8f1a-99b7a9ed39f7", initiative: 12}, {actorId: "mutant-1", initiative: 14}]}  ',
  '',
  'Il mostro si muove per primo.',
  '',
  '**monster_hp_change** {id: "mutant-1", delta: 0}  ',
  '**turn_advance**  ',
  '',
  'La lama ti sfiora il braccio. Che fai?',
].join('\n');

// Example B — quoted marker, payload is valid JSON on the next line and
// carries its own `type` key.
const EXAMPLE_B = [
  'Veyra riemerge.',
  '',
  '**"combat_start"**  ',
  '{"type":"combat_start"}',
].join('\n');

describe('parseInlineEvents — Example A (Goblin Warren)', () => {
  const result = parseInlineEvents(EXAMPLE_A, ALLOWED);

  it('parses exactly 5 events in document order', () => {
    expect(result.events.map((e) => e.type)).toEqual([
      'combat_start',
      'monster_spawn',
      'initiative_set',
      'monster_hp_change',
      'turn_advance',
    ]);
  });

  it('combat_start and turn_advance have empty payloads', () => {
    expect(result.events[0]!.payload).toEqual({});
    expect(result.events[4]!.payload).toEqual({});
  });

  it('monster_spawn payload preserves field types', () => {
    const payload = result.events[1]!.payload;
    expect(payload.id).toBe('mutant-1');
    expect(typeof payload.id).toBe('string');
    expect(payload.name).toBe('Ombra del Mulino');
    expect(payload.hpMax).toBe(24);
    expect(typeof payload.hpMax).toBe('number');
    expect(payload.ac).toBe(13);
    expect(payload.initiativeBonus).toBe(2);
    expect(payload.cr).toBe(1);
  });

  it('initiative_set preserves the nested order array (2 entries, UUID first)', () => {
    const order = result.events[2]!.payload.order as Array<Record<string, unknown>>;
    expect(Array.isArray(order)).toBe(true);
    expect(order).toHaveLength(2);
    expect(order[0]!.actorId).toBe('302099dd-1572-44b7-8f1a-99b7a9ed39f7');
    expect(order[0]!.initiative).toBe(12);
    expect(order[1]!.actorId).toBe('mutant-1');
    expect(order[1]!.initiative).toBe(14);
  });

  it('monster_hp_change keeps delta as the number 0', () => {
    const payload = result.events[3]!.payload;
    expect(payload.id).toBe('mutant-1');
    expect(payload.delta).toBe(0);
    expect(typeof payload.delta).toBe('number');
  });

  it('cleanedText keeps the three prose sentences and drops all markers/payloads', () => {
    expect(result.cleanedText).toContain('Ti lanci in avanti con un grido.');
    expect(result.cleanedText).toContain('Il mostro si muove per primo.');
    expect(result.cleanedText).toContain('La lama ti sfiora il braccio. Che fai?');
    expect(result.cleanedText).not.toContain('**');
    expect(result.cleanedText).not.toContain('monster_spawn');
    expect(result.cleanedText).not.toContain('{');
  });

  it('cleanedText collapses to clean double-newline-separated prose', () => {
    expect(result.cleanedText).toBe(
      'Ti lanci in avanti con un grido.\n\nIl mostro si muove per primo.\n\nLa lama ti sfiora il braccio. Che fai?',
    );
  });
});

describe('parseInlineEvents — Example B (One Piece, quoted marker + JSON line)', () => {
  const result = parseInlineEvents(EXAMPLE_B, ALLOWED);

  it('parses 1 combat_start event', () => {
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('combat_start');
  });

  it('does NOT duplicate the type into the payload', () => {
    expect(result.events[0]!.payload).toEqual({});
    expect('type' in result.events[0]!.payload).toBe(false);
  });

  it('cleanedText keeps the prose and drops the marker + JSON object', () => {
    expect(result.cleanedText).toContain('Veyra riemerge.');
    expect(result.cleanedText).not.toContain('{');
    expect(result.cleanedText).not.toContain('**');
    expect(result.cleanedText).toBe('Veyra riemerge.');
  });
});

describe('parseInlineEvents — standalone JSON line carrying extra fields', () => {
  it('uses the rest of the object as payload, minus the type key', () => {
    const text = ['**"hp_change"**', '{"type":"hp_change","actorId":"pc-1","delta":-3}'].join('\n');
    const result = parseInlineEvents(text, ALLOWED);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('hp_change');
    expect(result.events[0]!.payload).toEqual({ actorId: 'pc-1', delta: -3 });
  });
});

describe('parseInlineEvents — non-extraction guards', () => {
  it('ignores a bold marker whose type is not allowed', () => {
    const text = 'Prologo.\n\n**banana_split** {x: 1}\n\nEpilogo.';
    const result = parseInlineEvents(text, ALLOWED);
    expect(result.events).toHaveLength(0);
    // The unknown marker is left untouched (not an event we recognize).
    expect(result.cleanedText).toContain('banana_split');
    expect(result.cleanedText).toContain('Prologo.');
    expect(result.cleanedText).toContain('Epilogo.');
  });

  it('does not extract from plain prose that merely mentions combat_start', () => {
    const text =
      'The combat_start event normally begins a fight, but here we are just chatting.';
    const result = parseInlineEvents(text, ALLOWED);
    expect(result.events).toHaveLength(0);
    expect(result.cleanedText).toBe(text);
  });

  it('returns empty events and trimmed text when there are no markers', () => {
    const text = '   Solo narrazione, niente eventi.   ';
    const result = parseInlineEvents(text, ALLOWED);
    expect(result.events).toHaveLength(0);
    expect(result.cleanedText).toBe('Solo narrazione, niente eventi.');
  });
});

describe('parseInlineEvents — tolerant payload parsing', () => {
  it('recovers a payload with a trailing comma (tolerant normalize)', () => {
    const text = '**monster_spawn** {id: "x", }';
    const result = parseInlineEvents(text, ALLOWED);
    // A trailing comma is tolerated: the event is recovered with the one field.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('monster_spawn');
    expect(result.events[0]!.payload).toEqual({ id: 'x' });
  });

  it('skips (does not throw) when a payload is irrecoverably malformed', () => {
    const text = '**monster_spawn** {id: "x" "y" 123 nope]';
    const result = parseInlineEvents(text, ALLOWED);
    // Robustness over completeness: a broken payload yields no event.
    expect(result.events).toHaveLength(0);
  });

  it('keeps later valid events even when an earlier payload is malformed', () => {
    const text = ['**monster_spawn** {id: "x" "y" nope]', '**turn_advance**'].join('\n');
    const result = parseInlineEvents(text, ALLOWED);
    expect(result.events.map((e) => e.type)).toEqual(['turn_advance']);
  });
});
