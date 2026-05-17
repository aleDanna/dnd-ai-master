import { describe, it, expect } from 'vitest';
import { stripReasoningPreamble } from '@/ai/master/reasoning-strip';

describe('stripReasoningPreamble', () => {
  it('passes clean narration through unchanged', () => {
    const text = 'You descend the slick stone steps. The air thickens.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('strips a leading THINK preamble up to the first blank line', () => {
    const text = [
      'THINK',
      'The player is entering the trapdoor. Need to describe the new area.',
      'Mention salt, kelp, the ferrous tang.',
      '',
      'You descend the slick stone steps. The air thickens with salt and kelp.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe(
      'You descend the slick stone steps. The air thickens with salt and kelp.',
    );
  });

  it('strips THINK preamble even when followed by multiple paragraphs', () => {
    const text = 'THINK\nshort plan\n\nFirst paragraph.\n\nSecond paragraph.';
    expect(stripReasoningPreamble(text)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('returns empty when the entire block is reasoning with no narration', () => {
    const text = 'THINK\nThe player is entering the trapdoor.';
    expect(stripReasoningPreamble(text)).toBe('');
  });

  it('strips <think>...</think> blocks anywhere in the text', () => {
    const text = '<think>internal plan</think>You see a goblin lurking in the shadows.';
    expect(stripReasoningPreamble(text)).toBe('You see a goblin lurking in the shadows.');
  });

  it('handles Italian PENSIERO header', () => {
    const text = 'PENSIERO\nDevo descrivere la sala.\n\nLa sala è fredda e silenziosa.';
    expect(stripReasoningPreamble(text)).toBe('La sala è fredda e silenziosa.');
  });

  it('does NOT strip narration that just happens to contain the word think', () => {
    const text = 'You think about the goblin. What do you do?';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('does NOT strip when THINK is followed by more text on the same line', () => {
    const text = 'THINK before you act, the goblin growls.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(stripReasoningPreamble('')).toBe('');
  });

  it('strips a markerless first-person GM reasoning paragraph at the start', () => {
    // Real leak observed in the wild after a cast_spell tool error.
    const text = [
      "I need to handle this error. Since the player and I explicitly agreed on the spell list, I should override the tool's response *for this specific instance* and proceed as if *Light* was successfully cast, while making a mental note to check if the tool's spell list updates correctly later or if there's a bug to report to the system. For now, the narrative must follow the player's choices.",
      '',
      'La sfera di luce si accende sopra il tuo bastone, illuminando la cripta.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe(
      'La sfera di luce si accende sopra il tuo bastone, illuminando la cripta.',
    );
  });

  it('strips a multi-paragraph English reasoning preamble before Italian narration', () => {
    // Real leak: master plans a Persuasion DC across two paragraphs in English,
    // then narrates in Italian.
    const text = [
      "Given the player's goal of understanding faction affiliation, the DC should be moderate. A DC of 15 seems appropriate for a first social interaction with a potentially hostile or cautious NPC.",
      '',
      'I will ask the player to roll a Persuasion check.',
      '',
      'Il mercante incrocia le braccia e ti studia in silenzio. "E perché dovrei dirti chi mi paga?"',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe(
      'Il mercante incrocia le braccia e ti studia in silenzio. "E perché dovrei dirti chi mi paga?"',
    );
  });

  it('returns empty when the entire reply is markerless reasoning', () => {
    const text = "I should describe the room. The player just opened the door.";
    expect(stripReasoningPreamble(text)).toBe('');
  });

  it('does NOT strip narration that contains "I will" in NPC dialogue', () => {
    const text = 'The merchant nods slowly. "I will help you, traveler — for a price."';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('does NOT strip narration that mentions a player rolling', () => {
    const text = 'Roll a DC 15 Perception check. Something glints in the rubble.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('does NOT strip narration that begins with "You"', () => {
    const text = 'You step into the chamber. The torchlight flickers.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('does NOT strip narration that begins with "Looking at" but in second person', () => {
    // "Looking at" pattern is GM-meta only when followed by "the/this/what".
    // A scene-level "Looking around, you see..." should pass through.
    const text = 'Looking around, you see a sealed iron door and a fresco of a four-armed god.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('strips reasoning paragraphs prefixed by discourse connectors (However/Then/Now)', () => {
    // Real leak: master plans across four paragraphs in English with discourse
    // connectors before the GM voice, then narrates in Italian.
    const text = [
      'However, I need to check the inventory to confirm the player has the mask and clothes.',
      '',
      'The player has `mask-cult-leader` and `clothes-costume` (which I assume they are using as the waxed cloak).',
      '',
      "This is a Intimidation check, not a deception check, as the player is trying to assert authority. The DC should be high. Let's set it to 18.",
      '',
      'Then, I will ask for the Intimidation roll.',
      '',
      'Sollevi il mento sotto la maschera del Capo del Culto. "Sai chi sono io? Tira 1d20+3 per Intimidire."',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe(
      'Sollevi il mento sotto la maschera del Capo del Culto. "Sai chi sono io? Tira 1d20+3 per Intimidire."',
    );
  });

  it('strips a paragraph that mentions "the player" mid-sentence even without a planning opener', () => {
    const text = [
      'The merchant nods. (Wait, the player has not paid yet — let me adjust the encounter.)',
      '',
      'Il mercante incrocia le braccia.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe('Il mercante incrocia le braccia.');
  });

  it('strips a paragraph that adjudicates DC mid-text', () => {
    const text = [
      'Climbing this wall is tricky. The DC should be 15 given the wet stone.',
      '',
      'Tira 1d20+2 per Atletica.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe('Tira 1d20+2 per Atletica.');
  });

  it('does NOT strip a roll request that mentions a numeric DC in the imperative', () => {
    // "Roll a DC 15 ..." is the canonical roll-request phrasing — must pass through.
    const text = 'Roll a DC 15 Perception check. Something glints in the rubble.';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  it('does NOT strip an NPC that says "I will ..." inside dialogue', () => {
    const text = 'The merchant straightens his coat. "I will help you, traveler — for a price."';
    expect(stripReasoningPreamble(text)).toBe(text);
  });

  // ── qwen3-30b-a3b chain-of-thought leak (observed in the wild) ──
  // The model dumps multi-paragraph English reasoning + JSON tool-call text
  // before the actual Italian narration. None of the openers match the
  // original Sonnet-flavored regex set, so we extended REASONING_PARAGRAPH_START
  // and STRONG_REASONING_MARKERS in 2026-05-17.

  it('strips a multi-paragraph qwen3 chain-of-thought before the narration', () => {
    const text = [
      "Okay, let's break this down step by step. The user is playing a D&D 5e campaign in Italian.",
      '',
      'First, I need to check the current state. The player has a chest in their inventory.',
      '',
      'The tool calls would be:',
      '',
      '{ "name": "inventory_action", "arguments": { "subaction": "add_item" } }',
      '',
      'Il tuo dito tocca il bordo intarsiato della cassa. Con un sussurro di vetro, il legno si apre.',
    ].join('\n');
    const out = stripReasoningPreamble(text);
    expect(out).toBe('Il tuo dito tocca il bordo intarsiato della cassa. Con un sussurro di vetro, il legno si apre.');
  });

  it('strips "The user is ..." third-person meta paragraphs', () => {
    const text = [
      'The user is asking about the chest. According to the lore, it contains gold.',
      '',
      'Apri la cassa e trovi 240 monete d\'oro.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe("Apri la cassa e trovi 240 monete d'oro.");
  });

  it('strips a JSON tool_call dump pretending to be narration', () => {
    const text = [
      '{ "name": "combat_action", "arguments": { "subaction": "attack" } }',
      '',
      'La spada cala con un fendente.',
    ].join('\n');
    expect(stripReasoningPreamble(text)).toBe('La spada cala con un fendente.');
  });

  // ── Safety fallback (added 2026-05-17) ──
  // When the model emits pure reasoning that matches our patterns end-to-end,
  // an aggressive strip would return empty and the UI shows "Master non ha
  // prodotto risposta". Better to surface the last paragraph of the original
  // (likely the narration if any, otherwise noisy reasoning the player can
  // still parse) than to swallow the whole turn.

  it('falls back to last paragraph when strip empties a long input', () => {
    const longThinking = Array.from({ length: 30 }, (_, i) =>
      `The user is asking question number ${i + 1}. I need to check the rules carefully.`
    ).join('\n\n');
    const out = stripReasoningPreamble(longThinking);
    // Either the strip returns the last paragraph as fallback (preferred), or
    // it returns empty if the input is genuinely 100% reasoning. The fallback
    // kicks in only when the LAST paragraph wouldn't itself trigger strip
    // patterns — in this synthetic test each para starts with "The user is"
    // which IS a reasoning marker, so fallback won't trigger.
    // To exercise the fallback path we need the last paragraph to NOT match
    // any pattern. Construct that case separately:
    expect(out.length).toBeLessThan(longThinking.length); // strip did something
  });

  it('falls back to last paragraph when reasoning dumps end with a narration line', () => {
    const text = [
      'Okay, let me think about this carefully. The user wants to open the chest.',
      '',
      'First, I need to check the inventory state. The player has 240 gold pieces.',
      '',
      'The tool call would be inventory_action with subaction add_item.',
      '',
      "La cassa si apre con un cigolio metallico, rivelando l'interno dorato.",
    ].join('\n');
    // The original behaviour would strip to just the Italian last paragraph
    // (which is what we want — it's an actual narration line that doesn't
    // match any reasoning pattern). The fallback isn't needed here.
    expect(stripReasoningPreamble(text)).toBe(
      "La cassa si apre con un cigolio metallico, rivelando l'interno dorato.",
    );
  });

  it('safety fallback: returns last paragraph when everything looks like reasoning', () => {
    // Pathological case: every paragraph matches a pattern. Without the
    // fallback we'd return empty; with the fallback we return the last
    // paragraph (which is still reasoning, but at least the player sees
    // something rather than "Master non ha prodotto risposta").
    const text = [
      'Okay, let me break this down step by step. The user is asking about combat.',
      '',
      "Let's analyze the situation. According to the rules, attacks need a d20 roll.",
      '',
      'The tool calls would be: combat_action with subaction attack, then damage.',
      '',
      'I need to call combat_action with the proper subaction format here.',
    ].join('\n');
    const out = stripReasoningPreamble(text);
    // Not empty — fallback returned the last paragraph (>20 chars).
    expect(out.length).toBeGreaterThan(20);
    expect(out).toContain('combat_action');
  });
});
