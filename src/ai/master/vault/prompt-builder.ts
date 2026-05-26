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
