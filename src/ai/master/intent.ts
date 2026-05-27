/**
 * Mechanical-intent heuristic for the master turn route.
 *
 * Originally introduced for Plan E.2 RAG retrieval gating (commit 65d7bf5):
 * on turns where the player declared a mechanical action (`tiro percezione`,
 * `attacco il goblin`, `lancio palla di fuoco`), RAG retrieval was skipped
 * because the model resolves outcomes via the baked SRD + tool definitions
 * alone — no handbook chunk lookup adds value, and the tokens spent on
 * chunks are pure overhead.
 *
 * Phase 03 (vault-llm-wiki migration) decommissioned RAG entirely. This
 * heuristic survives because the baked path still uses it to gate the
 * `injectRollTriggersSlim` block: baked models do NOT carry the full
 * MASTER_ROLL_TRIGGERS in their Modelfile (Plan E.1 slim manifest), so a
 * baked master on "tiro percezione" has no explicit roll-trigger guidance
 * left unless the SLIM block is injected at runtime. The gate keeps that
 * ~500-tok block off narrative turns where it would be pure overhead.
 *
 * We treat questions as non-mechanical (rules lookup, lore query, NPC
 * details), because those are exactly the turns where the model benefits
 * from richer narration context, not from a roll-trigger guard-rail.
 *
 * False positives (skip when injection would have helped) are cheaper
 * than false negatives (inject on every turn) — the model can always
 * fall back to general rules guidance if it really needs to.
 */

const MECHANICAL_ACTION_PATTERNS: RegExp[] = [
  // ── Italian — imperative / 1st-person action verbs ──
  // Roll / check / cast / attack / use / move / dodge / hide / rest / search
  // Investigation / inspection verbs added 2026-05-21 — without them, prompts
  // like "Ispeziono il sigillo", "Investigo la stanza", "Studio l'iscrizione"
  // bypassed the mechanical-intent gate and the master narrated the outcome
  // without asking for an ability check (session 6b11f581).
  /^(?:tiro|tira|tirate|tiramo|lancio|lancia|incanto|attacco|attacca|colpisco|colpisce|uso|usa|utilizzo|attivo|attiva|bevo|mangio|raccolgo|prendo|afferro|schivo|paro|disingaggio|cerco|cerca|esamino|esamina|ispeziono|ispeziona|investigo|investiga|indago|indaga|studio|studia|leggo|legge|decifro|decifra|analizzo|analizza|valuto|valuta|scruto|scruta|tasto|tasta|tocco|tocca|annuso|annusa|ascolto|ascolta|origlio|origlia|guardo|osservo|controllo|vado|muovo|corro|salto|nascondo|riposo|salvataggio|iniziativa|spendo|persuado|intimidisco|inganno|convinco)\b/i,
  // "faccio un tiro/prova/controllo di X" / "tento una prova di X"
  /^(?:faccio|tento|provo|effettuo|eseguo)\s+(?:un[ao]?\s+)?(?:tiro|prova|controllo|check|salvezza|TS)\b/i,
  // Reflexive forms ("mi muovo", "mi nascondo", "mi riposo"). Note:
  // "mi guardo intorno" is intentionally NOT included — it's typically
  // narrative ("look around and describe") rather than a Perception check
  // request. If the player wants a check they should say "guardo" (bare,
  // matched by the main pattern) or "tira percezione".
  /^mi\s+(?:muovo|nascondo|riposo|sposto|paro|allontano|avvicino|concentro)\b/i,
  // Save / saving throw — Italian
  /^(?:tiro\s+salvezza|salvataggio\s+(?:su\s+)?[a-z])/i,
  // Short / long rest
  /^riposo\s+(?:breve|lungo)\b/i,

  // ── English — imperative / 1st-person action verbs ──
  /^i\s+(?:roll|attack|cast|use|drink|grab|take|dodge|parry|disengage|search|examine|inspect|investigate|study|read|decipher|analyze|analyse|scan|scrutinize|listen|smell|touch|look|check|move|run|jump|hide|rest|swing|stab|shoot|throw|grapple|shove|ready|persuade|intimidate|deceive|convince)\b/i,
  // "I make/try a X check/save" — allow an optional skill/ability name
  // between the verb and the check/roll/save noun (e.g. "I make a strength
  // check", "I try a perception roll").
  /^i\s+(?:make|try|attempt|do)\s+(?:an?\s+)?(?:[a-z]+\s+)?(?:check|roll|save|saving\s+throw)\b/i,
  // Bare imperative
  /^(?:roll|attack|cast|move|dodge|parry|disengage|hide|search|inspect|investigate|grapple|shove|initiative|short\s+rest|long\s+rest)\b/i,
  // "Saving throw on X" / "X saving throw"
  /^(?:saving\s+throw|save\s+vs)\b/i,
];

export function isMechanicalIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Questions probably need a rules / lore lookup — keep the SLIM block off
  // (the model will narrate, not call out for a roll).
  if (trimmed.includes('?')) return false;

  // Whitelist of mechanical-action patterns.
  for (const pattern of MECHANICAL_ACTION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}
