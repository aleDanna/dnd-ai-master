import { createHash } from 'node:crypto';

/**
 * REQ-022 — Pure-function system-prompt builder for the vault path.
 *
 * The output is byte-identical for byte-identical inputs (validated by
 * SHA256 stability test). The file MUST NOT contain any non-deterministic
 * construct — the canonical list is in the sibling `__forbidden-patterns.ts`,
 * scanned by a Vitest case in `prompt-builder.test.ts` (REQ-022 lint).
 *
 * The template is the spike-014-validated form. It is intentionally NOT
 * the existing slim/full builder in `src/ai/master/{slim-prompts,system-prompt}.ts`
 * — those are baked-path concerns and stay untouched. The two builders
 * are parallel and selected by the route-branch in plan 07.
 */

export interface VaultPromptInput {
  vaultRoot: string;
  campaignId: string;
  toolCount: number;
  language?: string;
  /**
   * Phase 02 — when true, the prompt advertises 4 tools (including
   * apply_event) and mentions the mutation surface. When false or
   * undefined, the prompt is the Phase-01-equivalent read-only form
   * (3 tools, no apply_event mention).
   *
   * The campaign's `vaultMutations` setting (resolved via
   * `resolveVaultMutations` in `src/lib/preferences.ts`) feeds this
   * input. REQ-022 hygiene preserved (boolean input, no side effect).
   *
   * Consistency invariant (asserted at build time):
   *   - vaultMutations === true  ⇒ toolCount must be 4
   *   - vaultMutations !== true  ⇒ toolCount must be 3
   * Any other combination throws — catches caller mistakes at the
   * entry point rather than producing a silently-wrong prompt.
   */
  vaultMutations?: boolean;
  /**
   * Phase 02.1 (smoke 2026-05-26 follow-up) — character roster injection.
   *
   * When `vaultMutations === true`, the prompt SHOULD include the list of
   * available player characters with their UUIDs. Smoke testing revealed
   * qwen3:30b cannot deduce character UUIDs from the "read characters/<slug>.md
   * frontmatter" instruction in the dispatcher error marker — it just invents
   * `pc-001`, `luffy-001`, etc., and gives up after 5 retries.
   *
   * Injecting the roster directly into the system prompt removes the
   * "navigate filesystem to find UUID" step entirely: the model sees
   * `Luffy: 25158592-15cf-...` and copy-pastes when calling apply_event.
   *
   * Pure input: the roster is a function of the campaign's stored state,
   * passed in by the route handler. REQ-022 purity preserved (no DB access
   * inside the builder).
   *
   * Shape: `{id: <UUID>, name: <string>}[]`. Order is the caller's choice —
   * the builder serializes them in the given order, so callers should
   * pass them in a stable order (party creation order is the canonical
   * choice, matching `SnapshotForModel.party`).
   *
   * Empty array or undefined: no roster section is emitted. This keeps
   * Phase-01 read-only prompts byte-identical (no roster) and lets
   * callers opt into the roster only when vaultMutations is true AND
   * party.length > 0.
   */
  characters?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Phase 05 (REQ-036) — manual rolls block injection.
   *
   * When true, the prompt includes a `## Rolls` block that instructs
   * the vault-path DM to write parser-compatible roll requests in prose
   * so the existing in-app 🎲 button renders and resolves them. The block
   * is deterministic given (manualRolls, language, showDifficultyNumbers)
   * and preserves REQ-022 byte-stability.
   *
   * Default (undefined / false): block is absent → read-only default
   * prompt bytes are unchanged and the locked-snapshot hash
   * 60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e
   * remains valid.
   */
  manualRolls?: boolean;
  /**
   * Phase 05 (REQ-036) — whether to include numeric DC/AC values in the
   * roll-request examples. When false (hidden-difficulty mode), numeric
   * DCs are omitted from examples and a hidden-difficulty warning line is
   * appended. Default (undefined) is treated as true (show numbers).
   * Only relevant when manualRolls === true.
   */
  showDifficultyNumbers?: boolean;
}

/**
 * Phase 05 (REQ-036) — Build the lines for the `## Rolls` block.
 *
 * Accepts language and hideDC flags (mirrors buildManualRollsRule signature).
 * Returns an array of explicit line strings — no multi-line template literals
 * (same `\r\n`-drift paranoia as the rest of this file).
 *
 * MUST NOT call the non-deterministic constructs listed in the sibling
 * __forbidden-patterns lint — enforced by the REQ-022 lint test.
 */
function buildRollsBlock(opts: { language?: string; hideDC: boolean }): string[] {
  const it = opts.language === 'it';
  const hideDC = opts.hideDC;

  const lines: string[] = [];
  lines.push('## Rolls');
  lines.push('');
  lines.push('When the outcome of an action is uncertain AND failure would be interesting,');
  lines.push('call for a roll. Do NOT roll for trivial actions (they just succeed) or');
  lines.push('impossible ones (they just fail). Difficulty anchors: Easy 10, Medium 15, Hard 20.');
  lines.push('');
  lines.push('The app turns each roll request you write into a tap-to-roll button for the');
  lines.push('player; the result returns as the next player message in the exact form');
  lines.push('"I rolled **<TOTAL>** for <label>." The bold number is AUTHORITATIVE — never');
  lines.push('recompute or re-roll it, and never invent a result that was not sent. If no');
  lines.push('roll message arrived, ask again; do not fabricate one.');
  lines.push('');
  lines.push('- Ability check or saving throw: the button rolls a bare d20. Read the');
  lines.push("  character's relevant modifier from their sheet in the vault, add the modifier");
  lines.push('  to the bold number, then compare to the DC.');
  lines.push('- Attack or damage: put the bonus in the formula, so the bold number is the');
  lines.push('  final total — use it as-is.');
  lines.push('');
  if (it) {
    lines.push('Write roll requests using these phrasings (the in-app parser is tuned for');
    lines.push('them; in Italian use the Italian verb and skill names — never mix languages');
    lines.push('like "Roll una prova di Perception" or the button will not appear):');
    if (hideDC) {
      lines.push('- "Tira una prova di Percezione."   (prova di abilità — no CD)');
      lines.push('- "Tira un TS Destrezza."           (tiro salvezza — no CD)');
      lines.push('- "Tira 1d20+<bonus> per attaccare <NOME DEL BERSAGLIO>."  (attacco — no CA)');
      lines.push('- "Tira 2d6+<bonus> danni <tipo>."          (danni)');
    } else {
      lines.push('- "Tira una prova di Percezione (CD 15)."   (prova di abilità)');
      lines.push('- "Tira un TS Destrezza (CD 14)."           (tiro salvezza)');
      lines.push('- "Tira 1d20+<bonus> per attaccare <NOME DEL BERSAGLIO> (CA <ca>)."  (attacco)');
      lines.push('- "Tira 2d6+<bonus> danni <tipo>."          (danni)');
    }
  } else {
    lines.push('Write roll requests using these phrasings (the in-app parser is tuned for');
    lines.push('them; in English use the English verb and skill names — never mix languages');
    lines.push('like "Roll una prova di Perception" or the button will not appear):');
    if (hideDC) {
      lines.push('- "Roll a Perception check."   (ability check — no DC)');
      lines.push('- "Roll a DC 14 Dexterity save."   (saving throw)');
      lines.push('- "Roll 1d20+<bonus> to attack <TARGET NAME>."  (attack — no AC)');
      lines.push('- "Roll 2d6+<bonus> <type> damage."          (damage)');
    } else {
      lines.push('- "Roll a DC 15 Perception check."');
      lines.push('- "Roll a DC 14 Dexterity save."');
      lines.push('- "Roll 1d20+<bonus> to attack <TARGET NAME> (AC <ac>)."  (attack)');
      lines.push('- "Roll 2d6+<bonus> <type> damage."          (damage)');
    }
  }
  if (hideDC) {
    lines.push('');
    lines.push('Hidden difficulty is ON: do NOT write the numeric DC/AC in the roll request.');
    lines.push('You still know the DC internally and use it to judge the result.');
  }
  return lines;
}

/**
 * Build the vault system prompt as a byte-stable string.
 *
 * Implementation note: every line is an explicit element in an array
 * joined with `\n`. Template literals across multiple physical lines
 * would risk source-file line-ending differences (`\r\n` vs `\n`)
 * silently changing the hash — explicit `\n` is paranoid but correct.
 */
export function buildVaultSystemPrompt(input: VaultPromptInput): string {
  // Consistency assertion — Phase 02. Catches the (vaultMutations,
  // toolCount) mismatch at the boundary so a misconfigured caller cannot
  // produce a prompt that advertises a tool the dispatcher refuses to
  // dispatch (or vice versa). The assertion is symmetric.
  if (input.vaultMutations === true && input.toolCount !== 4) {
    throw new Error(
      'buildVaultSystemPrompt: vaultMutations:true requires toolCount:4 (got ' + input.toolCount + ')',
    );
  }
  if (input.vaultMutations !== true && input.toolCount !== 3) {
    throw new Error(
      'buildVaultSystemPrompt: vaultMutations:false (or undefined) requires toolCount:3 (got ' + input.toolCount + ')',
    );
  }

  // Phase 02 — when vaultMutations is enabled, append a brief mention of
  // the apply_event tool to the tool-usage protocol block. The body is
  // intentionally short: the LLM reads `/tools/index.md` (and per-tool
  // pages) for the full schema. This mention serves two purposes:
  //   1. Signal the tool exists when the LLM would otherwise skip the
  //      tool-doc lookup.
  //   2. Clarify the most common LLM mistake — passing a character NAME
  //      instead of the character UUID (names are not unique across
  //      campaigns and the dispatcher rejects non-UUID values).
  const applyEventMention = input.vaultMutations === true
    ? 'When the player describes a game-state change (damage taken, spell cast, condition applied), call `apply_event` with the appropriate type and payload. The `character` field MUST be the character UUID (the value of `id` in the materialized view frontmatter — not the character name; names are not unique across campaigns and the dispatcher rejects non-UUID values). One event per call; do not batch.'
    : '';

  const lines: string[] = [
    'You are an experienced D&D 5e Dungeon Master.',
    '',
    // Phase 04 (REQ-035) — anti-railroading `## Your role` block. UNCONDITIONAL:
    // present whether vaultMutations is true or false (unlike applyEventMention /
    // the roster, which are conditional). STATIC: no per-input variation, so it
    // preserves REQ-022 byte-stability. Content is LOCKED in 04-CONTEXT.md
    // §"Exact block content" — reproduced byte-identical (em-dash U+2014, ellipsis
    // U+2026). Each physical line is an explicit array element (no multi-line
    // template literal — that is the `\r\n`-drift risk this file guards against).
    '## Your role',
    '',
    'CRITICAL — POINT OF VIEW (the single most important rule). Address the',
    'player as "you" (tu/ti). NEVER use a player character\'s NAME as the',
    'subject of an action, thought, or line of speech: "Luffy si lancia",',
    '"Luffy grida" are forbidden third-person narration. Rewrite in second',
    'person ("Ti lanci", "gridi") or omit it.',
    '',
    'You control the world — environment, NPCs, and the CONSEQUENCES of what',
    'the player declares. You do NOT control the player\'s character.',
    '',
    '- The player decides their character\'s actions, words, and intentions.',
    '  Narrate the OUTCOME of an action the player stated — never invent actions,',
    '  dialogue, decisions, or successes the player did not declare.',
    '- Brief connective body language is allowed ("ti volti di scatto",',
    '  "stringi la presa") but NEVER a decision, a line of dialogue, or an',
    '  outcome the player didn\'t declare.',
    '- Multiplayer: never speak or decide for ANY player character. When another',
    '  character should act next, close your beat by addressing them BY NAME —',
    '  the system hands them the turn.',
    '- End with an open cue ("Che fai?"). Never a numbered menu of options.',
    '',
    'Example — player writes "provo ad attaccarlo":',
    '  GOOD: "Ti lanci in avanti; la tua lama trova un varco nella guardia',
    '        del nemico, che barcolla con un grugnito. Che fai?"',
    '  BAD:  "Luffy si lancia e decide di colpire al fianco. \'GUM GUM!\' grida,',
    '        mettendo a segno il colpo." (THIRD PERSON — uses the PC\'s name as',
    '        subject — AND invents the action, words, and outcome)',
    '',
    '## Knowledge layout',
    '',
    "Your knowledge lives in a markdown vault at root '" + input.vaultRoot + "'.",
    '- Static knowledge: /handbook/<category>/<id>.md',
    '- Active campaign: /campaigns/' + input.campaignId + '/ (reserved — populated in a later release)',
    '',
    '## Tool usage protocol',
    '',
    "If you don't know what tools exist, your FIRST action is to read /tools/index.md.",
    'After that, use any of the ' + input.toolCount + ' listed tools directly.',
    '',
  ];
  if (applyEventMention.length > 0) {
    lines.push(applyEventMention);
    lines.push('');
  }
  // Phase 02.1 — character roster injection (smoke 2026-05-26 follow-up).
  // Only emitted when vaultMutations is enabled AND a non-empty roster is
  // passed in. Format is a fixed-width block the model can scan once at
  // turn start; the UUIDs are quoted with backticks so the tokenizer keeps
  // them as single tokens (Apple silicon decoders preserve quoted strings
  // verbatim, reducing chance of digit-level invention).
  if (
    input.vaultMutations === true &&
    Array.isArray(input.characters) &&
    input.characters.length > 0
  ) {
    lines.push('## Available characters');
    lines.push('');
    lines.push('Use these UUIDs verbatim in `apply_event` payload.character — do NOT invent identifiers like `pc-001`, do NOT use names:');
    lines.push('');
    for (const c of input.characters) {
      lines.push('- ' + c.name + ': `' + c.id + '`');
    }
    lines.push('');
  }
  // Phase 05 (REQ-036) — manual rolls block. Gated solely on manualRolls === true,
  // independent of vaultMutations. Preserves REQ-022: when manualRolls is
  // undefined or false, no bytes are added so the locked-snapshot hash remains
  // unchanged. showDifficultyNumbers defaults to true (show DCs) when undefined.
  if (input.manualRolls === true) {
    const hideDC = input.showDifficultyNumbers === false;
    const rollLines = buildRollsBlock({ language: input.language, hideDC });
    for (const line of rollLines) {
      lines.push(line);
    }
    lines.push('');
  }
  if (typeof input.language === 'string' && input.language.length > 0) {
    lines.push('Respond in language: ' + input.language + '.');
    lines.push('');
  }
  lines.push('Keep responses concise.');
  return lines.join('\n');
}

/**
 * SHA256 hex digest of a built prompt. Used by:
 *  - The stability test (1000 builds → 1 unique hash).
 *  - Future runtime telemetry that wants to log prompt-cache identity
 *    without storing the prompt itself.
 *
 * Phase 02 note: prompts built with vaultMutations:true vs false produce
 * different bytes (the conditional applyEventMention text in
 * buildVaultSystemPrompt diverges between modes). This means
 * hashVaultPrompt(promptA_readonly) !== hashVaultPrompt(promptA_readwrite)
 * naturally — no separate signature change is needed to keep prefix-cache
 * identity isolated between the two surfaces. The signature stays
 * `(prompt: string) => string`.
 */
export function hashVaultPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}
