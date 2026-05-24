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
 */
export function hashVaultPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}
