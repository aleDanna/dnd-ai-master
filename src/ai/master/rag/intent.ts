/**
 * Plan E.2 — runtime RAG gating.
 *
 * RAG retrieval costs ~80ms (embed + pgvector query) plus a few hundred
 * tokens added to the prompt. On turns where the player is declaring a
 * mechanical action (`tiro percezione`, `attacco il goblin`, `lancio
 * palla di fuoco`), the model resolves the outcome via the baked SRD +
 * tool definitions alone — no handbook chunk lookup adds value, and the
 * tokens spent on chunks are pure overhead.
 *
 * We skip RAG when the latest user message matches a *mechanical action*
 * pattern OR is clearly an imperative without a question mark. We keep
 * RAG when the player asks a question (rules lookup, lore query, NPC
 * details), because those are exactly the turns where handbook /
 * world-lore chunks improve narration grounding.
 *
 * False positives (skip when RAG would have helped) are cheaper than
 * false negatives (run RAG on every turn) — the model can always fall
 * back to `lookup_codex` as a tool call if it really needs a specific
 * fact mid-turn.
 */

const MECHANICAL_ACTION_PATTERNS: RegExp[] = [
  // ── Italian — imperative / 1st-person action verbs ──
  // Roll / check / cast / attack / use / move / dodge / hide / rest / search
  /^(?:tiro|tira|lancio|lancia|incanto|attacco|attacca|colpisco|colpisce|uso|usa|utilizzo|attivo|attiva|bevo|mangio|raccolgo|prendo|afferro|schivo|paro|disingaggio|cerco|cerca|esamino|guardo|osservo|controllo|vado|muovo|corro|salto|nascondo|riposo|salvataggio|iniziativa|spendo|tira(?:te|mo))\b/i,
  // Reflexive forms ("mi muovo", "mi nascondo", "mi riposo")
  /^mi\s+(?:muovo|nascondo|riposo|sposto|paro|allontano|avvicino)\b/i,
  // Save / saving throw — Italian
  /^(?:tiro\s+salvezza|salvataggio\s+(?:su\s+)?[a-z])/i,
  // Short / long rest
  /^riposo\s+(?:breve|lungo)\b/i,

  // ── English — imperative / 1st-person action verbs ──
  /^i\s+(?:roll|attack|cast|use|drink|grab|take|dodge|parry|disengage|search|examine|look|check|move|run|jump|hide|rest|swing|stab|shoot|throw|grapple|shove|ready)\b/i,
  // Bare imperative
  /^(?:roll|attack|cast|move|dodge|parry|disengage|hide|search|grapple|shove|initiative|short\s+rest|long\s+rest)\b/i,
  // "Saving throw on X" / "X saving throw"
  /^(?:saving\s+throw|save\s+vs)\b/i,
];

export function isMechanicalIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Questions probably need a rules / lore lookup — keep RAG on.
  if (trimmed.includes('?')) return false;

  // Whitelist of mechanical-action patterns.
  for (const pattern of MECHANICAL_ACTION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}
