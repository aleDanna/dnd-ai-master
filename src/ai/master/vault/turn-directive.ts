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
  /**
   * The player's latest message text. When it expresses combat intent
   * (attack verbs) AND vaultMutations is on, the directive switches to a
   * STRONG combat-first form. Validated 2026-05-29 (_probe-combat.ts): the
   * general directive was too soft to break the narration anchoring (0/1
   * tool calls), while the situational combat-first directive reliably
   * bootstraps combat (3/3 → apply_event{combat_start}).
   */
  playerMessage?: string;
  /**
   * Phase 08 (D-07 / REQ-039) — when `true`, the SERVER already resolved this
   * combat turn (resolveCombat emitted the authoritative monster_hp_change /
   * turn_advance events server-side) and is injecting its own narration
   * directive. In that case the player-side "resolve" directive below (the
   * 07-05 re-ask-breaker that instructs the model to call apply_event with
   * monster_hp_change / turn_advance) is SUPPRESSED — we must not ask the model
   * to emit the very events the loop is about to drop (suppressCombatMutations).
   * Belt-and-suspenders with the loop drop (RESEARCH Pitfall 3): don't ask, and
   * don't honor if asked anyway. When this flag is absent the resolve directive
   * is emitted byte-identically to Phase 07 (regression-protected).
   */
  serverResolved?: boolean;
  /**
   * Phase 09 (D-16) — when `true`, the SERVER already resolved this MONSTER turn
   * (the monster-turn loop emitted the authoritative monster_hp_change /
   * hp_change / turn_advance events server-side) and is injecting its own
   * narration directive. Mirrors `serverResolved` (the v1 player-side analog):
   * the combat re-ask directives (the combat-intent strong directive and the
   * vaultMutations combat-event catalog) are SUPPRESSED so the model is not told
   * to emit hp_change / turn_advance / combat events the loop already emitted
   * (double-apply re-ask, RESEARCH Pitfall 3 / T-09-15). Belt-and-suspenders
   * with the loop's suppressCombatMutations drop. When this flag is absent the
   * directive output is byte-identical to its Phase-08 behavior
   * (regression-protected). The POV / 2nd-person line is NOT suppressed — only
   * the combat re-asks are; the server injects its own narration directive.
   */
  monsterResolved?: boolean;
}

/**
 * Combat-intent detector. Stem-based regex over common IT (+ EN) attack
 * verbs. Deterministic, no external state. Conservative-ish to limit false
 * positives (a false positive just adds a combat nudge to a non-combat turn;
 * a false negative falls back to the general directive).
 */
const COMBAT_INTENT_RE =
  /\b(attacc\w*|colpisc\w*|colpir\w*|combatt\w*|ingagg\w*|sferr\w*|assal\w*|scagli\w*|menar\w*|pugn\w*|calci\w*|affront\w*|carica\b|uccid\w*|ammazz\w*|attack\w*|strik\w*|fight\w*|punch\w*|engage\w*|slash\w*|stab\w*)/i;

export function detectCombatIntent(playerMessage?: string): boolean {
  if (typeof playerMessage !== 'string' || playerMessage.length === 0) return false;
  return COMBAT_INTENT_RE.test(playerMessage);
}

/**
 * Roll-result detector. The in-app 🎲 button sends the result as
 * "🎲 I rolled **<TOTAL>** for <label>." When the player's latest message is
 * such a result, the directive MUST switch to "resolve" mode — NOT re-ask for
 * the same roll. Without this, a roll-result message like
 * "🎲 I rolled **18** for 1d20+3 (attaccare Veyra)" trips COMBAT_INTENT_RE
 * (it contains "attaccare") and the combat-start directive re-asks the roll →
 * infinite loop (observed 2026-05-29). Checked BEFORE combat-intent.
 */
const ROLL_RESULT_RE = /🎲|\bI rolled\b/i;

export function isRollResult(playerMessage?: string): boolean {
  if (typeof playerMessage !== 'string' || playerMessage.length === 0) return false;
  return ROLL_RESULT_RE.test(playerMessage);
}

/**
 * Phase 08-05 — a "combat declaration" turn: the player declares a combat action
 * (attack verb) that is NOT a roll-result. On these turns the SERVER owns the combat
 * mechanics — the encounter opener spawns monsters (Phase 10), the to-hit request is
 * appended server-side (08-03 canonicalizeToHitTarget), and the resolver / monster-loop
 * handle rolls. The local model must therefore NOT be handed `apply_event` here: weak
 * models (gemma4:12b) misuse it — re-emitting `combat_start` (which WIPES the server-set
 * encounter) and looping on malformed calls until the turn-lock TTL, leaving no narration
 * (observed live 2026-06-04). The route uses this to force narration-only
 * (`offerTools: false`) so the model only narrates while the server owns the mechanics.
 *
 * `isRollResult` is checked FIRST: a roll-result echoes the attack verb but the resolver
 * (not this gate) handles it via suppressCombatMutations.
 */
export function isCombatDeclaration(playerMessage?: string): boolean {
  return detectCombatIntent(playerMessage) && !isRollResult(playerMessage);
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
  const { vaultMutations, manualRolls, playerMessage, serverResolved, monsterResolved } = opts;

  if (!vaultMutations && !manualRolls) {
    return null;
  }

  // Roll-result → RESOLVE directive (checked BEFORE combat-intent, because a
  // roll-result echoes the attack label e.g. "...per attaccare Veyra" which
  // trips COMBAT_INTENT_RE). Tells the model to USE the rolled number and
  // advance — never re-ask the same roll (fixes the 2026-05-29 stall loop).
  //
  // Phase 08 (D-07): SKIP this branch entirely when the server already resolved
  // the turn (`serverResolved`). The server emits the authoritative events and
  // injects its own narration directive, so re-instructing the model to call
  // apply_event monster_hp_change / turn_advance here would only ask for the
  // events the loop is about to drop (suppressCombatMutations) — belt-and-
  // suspenders with RESEARCH Pitfall 3. Fall through to the combat-intent /
  // general directive as if this were not a roll-result.
  if (!serverResolved && isRollResult(playerMessage)) {
    const r: string[] = [];
    r.push('[ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato]');
    r.push('');
    r.push('Il numero in grassetto è il totale del tiro. NON chiederlo di nuovo, NON ripetere la stessa richiesta di tiro.');
    r.push('Risolvi l\'azione con quel numero e narra l\'esito in seconda persona ("tu").');
    if (vaultMutations) {
      r.push('Se era un tiro PER COLPIRE: confronta il totale con la CA del bersaglio (vedi combat.md). Se colpisce, chiedi il tiro per i danni ("Tira <XdY+bonus> danni"); se manca, narra il mancato.');
      r.push('Se era un tiro PER I DANNI: chiama apply_event con monster_hp_change (id del bersaglio, delta negativo).');
      r.push('Quando l\'azione del turno è conclusa, chiama apply_event con turn_advance per passare al turno successivo.');
    }
    return r.join('\n');
  }

  // Combat-intent → STRONG situational directive (validated 3/3 to break the
  // narration anchoring where the general directive failed). Combat-first +
  // explicitly counters the anti-railroading "narrate the outcome" pull. Only
  // when vaultMutations (apply_event available) AND the player is attacking.
  //
  // Phase 08 (D-07): also gated on `!serverResolved`. A server-resolved roll
  // result still trips detectCombatIntent (it echoes "...attaccare Veyra"), so
  // without this gate the suppressed resolve directive would simply fall through
  // to THIS combat-start directive — which re-asks combat_start / monster_spawn
  // / monster_hp_change / turn_advance, defeating the suppression (T-08-04). On
  // a server-resolved turn both re-ask directives are suppressed; the route
  // injects the server's authoritative narration directive instead, and the
  // general POV directive below supplies the 2nd-person guidance.
  //
  // Phase 09 (D-16): also gated on `!monsterResolved` — mirrors serverResolved.
  // On a server-resolved MONSTER turn the loop already emitted the authoritative
  // monster_hp_change / hp_change / turn_advance events; re-asking the model to
  // emit combat_start / monster_spawn / monster_hp_change / turn_advance here
  // would re-ask the very events the loop dropped (double-apply, T-09-15).
  if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(playerMessage)) {
    return [
      '[ISTRUZIONE PRIORITARIA — il giocatore sta attaccando]',
      '',
      'PRIMA di narrare l\'esito DEVI usare gli strumenti (apply_event):',
      '- Se il combattimento NON è ancora iniziato: chiama combat_start, poi monster_spawn per ogni nemico presente, poi initiative_set.',
      '- Se è già in corso: usa monster_hp_change e turn_advance secondo il turno.',
      'Poi chiedi il tiro al giocatore: "Tira 1d20+<bonus> per attaccare <nemico>."',
      'Narra l\'esito SOLO dopo che il giocatore ha tirato. Scrivi sempre in seconda persona ("tu").',
    ].join('\n');
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
  //
  // Phase 08 (D-07): suppressed when `serverResolved`. On a server-resolved turn
  // the server is the authority for mutations and injects its own narration
  // directive; re-listing the combat apply_event catalog here (combat_start …
  // monster_hp_change … turn_advance) would re-ask for the very events the loop
  // is dropping (suppressCombatMutations) — the same double-apply re-ask D-07
  // guards against (T-08-04). The POV line above still anchors 2nd-person
  // narration; the server's directive carries the combat semantics.
  //
  // Phase 09 (D-16): also gated on `!monsterResolved` — mirrors serverResolved.
  // On a server-resolved MONSTER turn the loop already emitted the combat events;
  // re-listing the combat apply_event catalog here would re-ask for the very
  // events the loop dropped (double-apply, T-09-15). The POV line still anchors
  // 2nd-person narration; the server's narration directive carries the combat
  // semantics for that turn.
  if (vaultMutations && !serverResolved && !monsterResolved) {
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
    // Phase 08-02: when numbered monsters exist (e.g. "Pirata di Buggy 1/2/3"),
    // the master MUST use the exact name from combat.md — including the number —
    // in the attack-roll request so the server resolver can match it precisely.
    // Without this, a bare base name ("Pirata di Buggy") matches none of the
    // numbered names and the server falls through to the unreliable LLM fallback.
    lines.push('IMPORTANTE: usa sempre il NOME ESATTO dal tracker (combat.md), numero incluso.');
    lines.push('Esempio: "Tira 1d20+4 per attaccare Pirata di Buggy 2." — non "il pirata" o solo "Pirata di Buggy".');
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
