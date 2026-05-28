/**
 * REQ-038 — Per-turn anti-anchoring directive for the vault path.
 *
 * Root cause (validated 2026-05-28 via _probe-combat.ts diagnostic):
 * local MoE models (qwen3:30b, gemma4) copy the RECENCY PATTERN of the
 * conversation over the system prompt. A narration-heavy history with
 * zero tool calls anchors the model to pure narration, suppressing
 * apply_event emission entirely.
 *
 * Fix: append a brief directive at the END of the assembled history
 * (recency position) so the model's most recent "instruction" is an
 * explicit reminder to use combat tools and 2nd-person POV.
 *
 * This module is SEPARATE from buildVaultSystemPrompt — it does NOT
 * modify the system prompt, so REQ-022's byte-stability is untouched.
 *
 * Determinism contract: no Date.now, Math.random, or process.env.
 * Caller passes all runtime flags as arguments.
 */

export interface TurnDirectiveOpts {
  /** When true, include the apply_event/combat line in the directive. */
  vaultMutations?: boolean;
  /** When true, include the roll-request line in the directive. */
  manualRolls?: boolean;
  /**
   * Campaign language. Currently only used to future-proof the signature
   * (the directive is always written in Italian — the primary play language).
   * Kept as an explicit param so callers don't need to change when a
   * multi-language expansion lands.
   */
  language?: string;
}

/**
 * Build a per-turn anti-anchoring directive string.
 *
 * Returns `null` when BOTH `vaultMutations` and `manualRolls` are falsy —
 * read-only campaigns with no roll interface get no directive (no noise).
 *
 * Lines (semantics LOCKED; Italian is the primary play language):
 *   1. Header marker
 *   2. POV line (always, when non-null): narrate in 2nd person ("tu")
 *   3. apply_event/combat line (only when vaultMutations)
 *   4. Roll line (only when manualRolls)
 */
export function buildTurnDirective(opts: TurnDirectiveOpts): string | null {
  const { vaultMutations, manualRolls } = opts;

  if (!vaultMutations && !manualRolls) {
    return null;
  }

  const lines: string[] = [];

  // Header marker — square-bracket convention signals a meta-instruction
  // to the model without being part of the narration.
  lines.push('[Promemoria di sistema — IMPORTANTE]');
  lines.push('');

  // POV line — always present when the directive is non-null.
  // Must use "tu" / "seconda persona" so the test regex matches.
  lines.push('Narra sempre in seconda persona ("tu"): il soggetto delle azioni');
  lines.push('è sempre il personaggio giocante, non il suo nome proprio come soggetto.');
  lines.push('');

  // apply_event / combat line — only when vaultMutations is true.
  if (vaultMutations) {
    lines.push('Quando lo stato di gioco cambia (danni, condizioni, inizio/fine scontro,');
    lines.push('turni in combattimento), USA apply_event — non limitarti alla narrazione.');
    lines.push('Tipi di evento per il combattimento:');
    lines.push('  combat_start, monster_spawn, initiative_set,');
    lines.push('  monster_hp_change, turn_advance, combat_end.');
    lines.push('Ogni cambiamento di stato DEVE passare per apply_event, poi narra il risultato.');
    lines.push('');
  }

  // Roll line — only when manualRolls is true.
  if (manualRolls) {
    lines.push('Quando l\'esito di un\'azione è incerto, chiedi un tiro al giocatore.');
    lines.push('Formula per attacchi: "Tira 1d20+<bonus> per attaccare <BERSAGLIO>."');
    lines.push('Formula per prove: "Tira una prova di <Abilità> (CD <n>)."');
    lines.push('Non inventare risultati: aspetta il messaggio del giocatore col numero in grassetto.');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Append `directive` to the last user turn of `history` (recency position).
 *
 * Immutability contract:
 *   - Returns a NEW array — input array is never mutated.
 *   - The modified element is a new object — the original element is untouched.
 *
 * Behaviour:
 *   - If the last turn is `role: 'user'`, append directive to its content
 *     with a "\n\n" separator and return a new array with that new element.
 *   - If the last turn is NOT `role: 'user'` (e.g. assistant) OR history is
 *     empty, push a new `{role: 'user', content: directive}` turn.
 */
export function appendDirectiveToHistory<T extends { role: string; content: string }>(
  history: T[],
  directive: string,
): T[] {
  if (history.length === 0) {
    // Empty history — push a new user turn with the directive alone.
    return [{ role: 'user', content: directive } as T];
  }

  const last = history[history.length - 1]!;

  if (last.role === 'user') {
    // Append to the last user turn. Spread to preserve any extra fields on T.
    const updated: T = { ...last, content: last.content + '\n\n' + directive };
    return [...history.slice(0, -1), updated];
  }

  // Last turn is not a user turn — push a new trailing user turn.
  return [...history, { role: 'user', content: directive } as T];
}
