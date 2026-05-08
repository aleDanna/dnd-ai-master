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
});
