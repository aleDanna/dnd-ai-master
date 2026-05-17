/**
 * Defensive filter for visible model output.
 *
 * Sonnet sometimes emits a plaintext "reasoning preamble" inside a regular
 * text block (extended thinking is OFF in this app). Three shapes have been
 * observed in the wild:
 *
 *   THINK
 *   <one or more lines of reasoning>
 *
 *   <actual narration>
 *
 * the XML-style:
 *
 *   <think>...</think><narration>
 *
 * and unmarked first-person GM reasoning paragraphs at the start, e.g.:
 *
 *   I need to handle this error. The player asked for X, so I should...
 *
 *   <actual narration>
 *
 * All three leak to the player via `narrative_delta` if not stripped. The
 * system prompt forbids them, but the prompt is not always honoured — this
 * is the belt-and-braces filter applied at the streaming chokepoint.
 */

const THINK_HEADER = /^[ \t]*(?:THINK|PENSIERO|REASONING|THINKING)\b[ \t]*:?[ \t]*\n/;

// Optional discourse connector that may precede a meta-game opener:
//   "However, I will ask..."     "Then, I need to check..."
//   "Now, the player has..."     "First, let me describe..."
const DISCOURSE_CONNECTOR =
  '(?:(?:However|Then|Also|Additionally|Furthermore|Moreover|Alternatively|First|Next|Now|Initially|Thus|So|Therefore|Hence|Of course|Indeed|Actually|Importantly|Finally|Generally|Typically)[,.;:]?[ \\t]+)?';

// Markers that, when they OPEN a paragraph (after an optional discourse
// connector), identify it as meta-game reasoning rather than narration. The
// master narrates in second person ("You ..."); first-person GM voice and
// references to "the player" / "the DC" are essentially never narration.
//
// Anchored to paragraph start to avoid false positives on NPC dialogue
// embedded in prose ("'I will help you,' says the merchant.").
const REASONING_PARAGRAPH_START = new RegExp(
  '^[ \\t]*' +
    DISCOURSE_CONNECTOR +
    '(?:' +
    [
      // First-person GM voice
      "I (?:will|'ll|should|need|must|'ve|can|might|'m going)\\b",
      // Planning openers
      'Given (?:the|that|what|how)\\b',
      'Since (?:the|that|what|the player)\\b',
      'Considering (?:the|that)\\b',
      'Looking at (?:the|this|what)\\b',
      'Based on (?:the|what|this|my)\\b',
      'To (?:handle|address|resolve|adjudicate|narrate|determine)\\b',
      'For (?:now|this turn|this response|this message)[,.]',
      'Let me\\b',
      // Meta-game references
      'The player\\b',
      // The user is/has/wants/asked... — qwen3 chain-of-thought leak
      'The user (?:is|has|wants|just|asked|said|gave|provided|wrote)\\b',
      // qwen3 thinking-mode openers
      "Okay,?[ \\t]+(?:let'?s|let me|so|now|the user|I|we|first|the player|the response|this)\\b",
      'Alright,?[ \\t]+(?:let|so|now|I)\\b',
      'Hmm,?[ \\t]+',
      'Wait,?[ \\t]+',
      "Let'?s (?:break|think|check|analyze|see|figure|recap|consider|start|begin|look)\\b",
      // Tool-call-as-text dumps
      '\\{[ \\t\\r\\n]*"name"[ \\t]*:',
      'tool_call\\b',
      // "The tool call(s) would be:" / "Tool calls:" — meta about tooling
      'The tool[ \\t]*calls?\\b',
      'Tool[ \\t]*calls?[ \\t]*:',
      // Explicit reasoning labels
      '(?:Note|Reasoning|Plan|Thought|Thinking|Pensiero|Ragionamento)\\s*:',
    ].join('|') +
    ')',
  'i',
);

// "Strong" markers that prove a paragraph is meta-game reasoning when found
// ANYWHERE in it — not just at the start. These phrases are essentially never
// produced by legitimate second-person narration:
//   - "the player" used as a third-person handle (narration uses "you")
//   - DC adjudication discussion ("DC should be high", "set it to 18")
//   - GM deliberation ("Let's set", "seems appropriate")
//   - meta-game labelling of a roll ("This is a Persuasion check, not...")
//
// Used in addition to REASONING_PARAGRAPH_START so paragraphs that don't open
// with an obvious marker but contain meta phrasing still get caught.
const STRONG_REASONING_MARKERS: RegExp[] = [
  /\bthe player\b/i,
  /\bDC (?:should be|of \d+|seems|stays at|stays|is set)\b/i,
  /\bset (?:it|the DC|that) to \d/i,
  /\bseems (?:appropriate|reasonable|fair|fitting|right|correct|too (?:high|low|easy|hard))\b/i,
  /\bLet'?s (?:set|say|assume|go with|use|make|treat|call|pick|break|think|check|recap|consider)\b/i,
  /\bThis is (?:an?|the)\b[^\n]{0,60}\b(?:check|save|saving throw|attack roll)\b/i,
  // qwen3-30b-a3b chain-of-thought leak markers (paragraphs that are clearly
  // meta-reasoning even when they don't open with a standard marker):
  /\bthe user (?:is|has|wants|asked|just|said|gave|wrote)\b/i,
  /\baccording to (?:the|my|our) (?:rules|context|spec|lore|handbook)\b/i,
  /\bI need to (?:check|call|use|verify|decide|figure|narrate|describe)\b/i,
  /\bso the (?:next step|response|narration|tool call)\b/i,
  /\bthe (?:tool|tool call|tool_call|next step) (?:would be|is to|should be)\b/i,
  // Tool-call JSON dump embedded in text content (model wrote the tool call
  // as visible text instead of using the structured tool_calls API).
  /^\s*\{\s*"name"\s*:\s*"[a-z_]+_action"/im,
  /\btool_call\s*\n/i,
];

function isReasoningParagraph(para: string): boolean {
  if (REASONING_PARAGRAPH_START.test(para)) return true;
  for (const re of STRONG_REASONING_MARKERS) {
    if (re.test(para)) return true;
  }
  return false;
}

export function stripReasoningPreamble(text: string): string {
  if (!text) return text;

  // 1. <think>...</think> XML blocks anywhere in the text.
  let cleaned = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>\s*/gi, '');

  // 2. Leading "THINK\n..." preamble. Stripped up to the first blank line
  //    (paragraph break = narration starts), or to end-of-text if the entire
  //    block is reasoning with no following narration.
  const lead = cleaned.match(THINK_HEADER);
  if (lead) {
    const afterHeader = cleaned.slice(lead[0].length);
    const blankLine = afterHeader.search(/\n[ \t]*\n/);
    if (blankLine === -1) {
      cleaned = '';
    } else {
      cleaned = afterHeader.slice(blankLine).replace(/^\s+/, '');
    }
  }

  // 3. Markerless first-person GM reasoning paragraphs at the start. Walk
  //    paragraphs (split on blank lines) and drop each leading one that opens
  //    with a reasoning marker, stopping at the first paragraph that doesn't.
  cleaned = stripLeadingReasoningParagraphs(cleaned);

  // 4. Safety fallback: if the input had substantial content (>200 chars) but
  //    we stripped it to nothing or near-nothing (<20 chars), the strip is
  //    almost certainly over-aggressive — the model emitted pure reasoning
  //    with no narration paragraph that escaped our patterns. Returning empty
  //    triggers "Master non ha prodotto risposta" in the UI. Better to return
  //    a tail slice of the original so the player at least sees something
  //    (even if it's the noisy reasoning) than to swallow the entire turn.
  //
  //    We return the LAST paragraph of the original input — heuristically
  //    that's where the narration usually lands when the model dumps a long
  //    chain-of-thought before getting to the actual scene description.
  if (text.length > 200 && cleaned.trim().length < 20) {
    const paragraphs = text.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
    const lastPara = paragraphs[paragraphs.length - 1];
    if (lastPara && lastPara.length >= 20) {
      // eslint-disable-next-line no-console
      console.warn('[reasoning-strip] aggressive strip — falling back to last paragraph of original',
        { originalLen: text.length, cleanedLen: cleaned.trim().length, lastParaLen: lastPara.length });
      return lastPara;
    }
  }

  return cleaned;
}

function stripLeadingReasoningParagraphs(text: string): string {
  if (!text) return text;
  // Split into paragraphs while preserving the separators so we can rejoin
  // exactly. A "paragraph" here is a run of non-blank lines.
  const parts = text.split(/(\n[ \t]*\n+)/);
  // parts looks like [para0, sep0, para1, sep1, ...]
  let i = 0;
  while (i < parts.length) {
    const para = parts[i] ?? '';
    if (para.trim().length === 0) {
      // Skip a blank piece (shouldn't normally appear at even index, but be safe).
      i += 2;
      continue;
    }
    if (isReasoningParagraph(para)) {
      i += 2; // drop this paragraph and its trailing separator
      continue;
    }
    break;
  }
  if (i === 0) return text;
  return parts.slice(i).join('').replace(/^\s+/, '');
}
