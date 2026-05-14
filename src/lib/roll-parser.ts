/**
 * Lightweight client-side parser for roll requests in master narration.
 * When manualRolls is ON, the master writes prose like "Roll 1d20+5" or
 * "Roll a DC 14 Dexterity save" instead of calling the rolling tools.
 * The UI parses each master message and offers a roll button per match.
 *
 * Best-effort grammar — covers the patterns the master is instructed to use
 * but won't catch every creative phrasing. Add patterns as needed.
 */

export type RollKind = 'attack' | 'damage' | 'check' | 'save' | 'init' | 'generic';

/**
 * Group coordination mode for multiple rolls in the same message.
 * - 'and': every button must be clicked before the result is sent (e.g. two saves required).
 * - 'or':  the first button click sends, the others lock out (e.g. multi-option choice or
 *   a conditional second roll like "if you hit, then roll damage").
 *
 * A single-roll message is always 'or' (mode is moot, but 'or' = "first click wins" is the
 * trivial answer).
 */
export type RollGroupMode = 'and' | 'or';

export interface RollRequest {
  /** A parseable formula like "1d20+5" or "2d6+3". */
  formula: string;
  /** Short label shown on the button — e.g. "Attack 1d20+5" or "DEX save (DC 14)". */
  label: string;
  kind: RollKind;
  /** Index inside the source text — used as a stable React key alongside messageId. */
  index: number;
  /** Group coordination mode. All requests parsed from the same message share this value. */
  groupMode: RollGroupMode;
}

/** Parse a free-form master text for explicit roll requests. */
export function parseRollRequests(text: string): RollRequest[] {
  const requests: RollRequest[] = [];
  const seen = new Set<string>();

  // 1a. Tagged formula: "Tira iniziativa: 1d20+1"  /  "Roll initiative: 1d20+2"
  //     The verb is followed by a short noun-phrase describing the roll, then a
  //     colon, then the formula. Group 1 is the descriptor (used as label),
  //     group 2 is the formula. We run this BEFORE the bare pattern so we don't
  //     miss formulas tagged this way; the seen-set dedupes any overlap.
  const taggedRe = /(?:^|[\s(.,!])(?:roll|tira|lancia)\s+([^.!?\n:]{1,40}?)\s*:\s*((?:\d+)?d\d+\s*(?:[+-]\s*\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = taggedRe.exec(text)) !== null) {
    const purposeRaw = m[1]!.trim();
    const formulaRaw = m[2]!.replace(/\s+/g, '');
    const formula = normalizeFormula(formulaRaw);
    if (!formula) continue;
    const key = `${m.index}:${formula}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const purpose = cleanInlinePurpose(purposeRaw);
    requests.push({
      formula,
      label: purpose ? `${formula} (${purpose})` : formula,
      kind: inferKind(text, m.index),
      index: m.index,
      groupMode: 'or',
    });
  }

  // 1b. Bare formula: "Roll 1d20+5"  /  "Roll 2d6 + 3"  / "Roll 1d8"
  // Capture group 1 is the formula; we then look at the text right after to extract the purpose.
  const bareRe = /(?:^|[\s(.,!])(?:roll|tira|lancia)\s+((?:\d+)?d\d+\s*(?:[+-]\s*\d+)?)/gi;
  while ((m = bareRe.exec(text)) !== null) {
    const raw = m[1]!.replace(/\s+/g, '');
    const formula = normalizeFormula(raw);
    if (!formula) continue;
    const key = `${m.index}:${formula}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const formulaEnd = m.index + m[0].length;
    const purpose = extractPurpose(text, formulaEnd);
    requests.push({
      formula,
      label: purpose ? `${formula} (${purpose})` : formula,
      kind: inferKind(text, m.index),
      index: m.index,
      // groupMode is stamped after all rolls are collected, see below.
      groupMode: 'or',
    });
  }

  // 2. Saves: "Roll a DC 14 Dexterity save"
  const saveRe =
    /(?:roll|make)\s+a?\s*DC\s*(\d+)\s+(STR|DEX|CON|INT|WIS|CHA|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+save/gi;
  while ((m = saveRe.exec(text)) !== null) {
    const dc = parseInt(m[1]!, 10);
    const ability = abbrAbility(m[2]!);
    const formula = '1d20';
    const key = `${m.index}:save:${ability}:${dc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: `${ability} save (DC ${dc})`,
      kind: 'save',
      index: m.index,
      groupMode: 'or',
    });
  }

  // 3. Skill / ability check: "Roll a DC 14 Perception check" / "Roll a Perception check"
  const checkRe =
    /(?:roll|make)\s+a?\s*(?:DC\s*(\d+)\s+)?(Acrobatics|Animal Handling|Arcana|Athletics|Deception|History|Insight|Intimidation|Investigation|Medicine|Nature|Perception|Performance|Persuasion|Religion|Sleight of Hand|Stealth|Survival|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+check/gi;
  while ((m = checkRe.exec(text)) !== null) {
    const dc = m[1] ? parseInt(m[1], 10) : null;
    const skill = m[2]!;
    const formula = '1d20';
    const key = `${m.index}:check:${skill}:${dc ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: dc !== null ? `${skill} check (DC ${dc})` : `${skill} check`,
      kind: 'check',
      index: m.index,
      groupMode: 'or',
    });
  }

  // 4. Italian skill / ability check (no explicit formula):
  //    "tira una prova di Intimidazione (CD 12)"  /  "fai una prova di Sopravvivenza"
  //    The DC can appear after the skill ("CD 12") and is optional.
  //    `roll`/`lancia` are accepted alongside the canonical Italian verbs to
  //    catch hybrid-language master output ("Roll una prova di Intimidazione")
  //    that would otherwise slip past both the English and Italian patterns.
  //    `tenta`/`esegui`/`compi` cover imperative variants the master sometimes
  //    picks ("Tenta una prova di Persuasione") — they only match when followed
  //    by "prova/controllo" so unrelated prose ("tenta la fortuna") can't fire.
  const ITALIAN_SKILL =
    'Acrobazia|Addestrare\\s+Animali|Arcano|Arcana|Atletica|Inganno|Intuito|Intuizione|Intimidazione|Intimidire|Investigazione|Indagine|Indagare|Medicina|Natura|Percezione|Intrattenere|Spettacolo|Persuasione|Religione|Rapidit[àa]\\s+di\\s+Mano|Mano\\s+Lesta|Furtivit[àa]|Sopravvivenza|Storia';
  const ITALIAN_ABILITY = 'Forza|Destrezza|Costituzione|Intelligenza|Saggezza|Carisma';
  const ITALIAN_CHECK_VERB = 'tira|fai|effettua|lancia|tenta|esegui|compi|roll';
  // Allowed prepositions between "prova"/"tiro [di] salvezza" and the
  // ability/skill name. The Master is instructed to use "di" (or omit the
  // preposition), but the LLM frequently slips into the natural-Italian
  // "su" + article forms ("sulla Saggezza", "sul Carisma", "sull'Intelligenza").
  // The elided "sull'X" form has no trailing whitespace, so it's a separate
  // alternation branch. Longer variants come first so the regex engine doesn't
  // greedily pick the shorter "sul"/"su" before checking "sulla"/"sullo".
  const ITALIAN_ROLL_PREP = `(?:(?:sull[aoe]|sugli|sui|sul|su|di)\\s+|sull['’])`;
  const checkReIt = new RegExp(
    `(?:${ITALIAN_CHECK_VERB})\\s+(?:un[ao]?\\s+)?(?:prova|controllo)\\s+${ITALIAN_ROLL_PREP}?(${ITALIAN_SKILL}|${ITALIAN_ABILITY})(?:[^.!?\\n]{0,30}?\\bCD\\s*(\\d+))?`,
    'gi',
  );
  while ((m = checkReIt.exec(text)) !== null) {
    const skill = normalizeItalianSkill(m[1]!);
    const dc = m[2] ? parseInt(m[2], 10) : null;
    const formula = '1d20';
    const key = `${m.index}:check:${skill}:${dc ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: dc !== null ? `${skill} (CD ${dc})` : skill,
      kind: 'check',
      index: m.index,
      groupMode: 'or',
    });
  }

  // 5. Italian saving throw:
  //    "tira un TS Destrezza CD 14" / "tira un tiro salvezza di Costituzione (CD 12)"
  //    Same imperative-verb tolerance as the check pattern above.
  //    Also accepts "su"-family prepositions ("tiro salvezza sulla Saggezza",
  //    "sul Carisma", "sull'Intelligenza") via ITALIAN_ROLL_PREP.
  const saveReIt = new RegExp(
    `(?:${ITALIAN_CHECK_VERB})\\s+(?:un[ao]?\\s+)?(?:TS|tiro\\s+(?:di\\s+)?salvezza)\\s+${ITALIAN_ROLL_PREP}?(${ITALIAN_ABILITY})(?:[^.!?\\n]{0,30}?\\bCD\\s*(\\d+))?`,
    'gi',
  );
  while ((m = saveReIt.exec(text)) !== null) {
    const ability = abbrItalianAbility(m[1]!);
    const dc = m[2] ? parseInt(m[2], 10) : null;
    const formula = '1d20';
    const key = `${m.index}:save:${ability}:${dc ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      formula,
      label: dc !== null ? `TS ${ability} (CD ${dc})` : `TS ${ability}`,
      kind: 'save',
      index: m.index,
      groupMode: 'or',
    });
  }

  // Safety net: in a single master message the player should never see a damage
  // button next to an attack button — they can't know whether they hit until
  // the to-hit roll resolves. The system prompt instructs the master to split
  // attack and damage across two turns, but this filter catches sloppy turns
  // where it pre-emits both. The damage roll will be re-requested by the
  // master in the next turn iff the attack actually hit.
  let filtered = requests;
  if (requests.some((r) => r.kind === 'attack') && requests.some((r) => r.kind === 'damage')) {
    filtered = requests.filter((r) => r.kind !== 'damage');
  }

  // Dedup logical save/check duplicates within the same message. The master
  // often restates the same check in two beats — once in narration ("Fai una
  // prova di Intuizione per capire se...") and once in the closing prompt
  // ("Tira una prova di Intuizione.") — which would otherwise produce two
  // identical buttons the player can't tell apart. Collapse to one,
  // preferring the variant with a DC (more informative) over the bare form.
  //
  // Different abilities/skills stay as separate buttons. Two requests for
  // the SAME ability with DIFFERENT DCs also both stay — those are
  // semantically distinct rolls (e.g., "Fai una prova di Forza CD 14 per
  // scalare. Fai una prova di Forza CD 18 per la pietra finale.").
  //
  // Attack / damage / generic rolls bypass this pass: the per-position
  // dedup inside each pattern loop already handles uniqueness, and multiple
  // same-formula attacks in one message are legitimate (sequential strikes).
  filtered = dedupLogicalSavesAndChecks(filtered);

  // Determine the group mode once for the whole message and stamp it onto every request.
  // All rolls in the same master message share the same coordination policy.
  const mode = detectGroupMode(text, filtered.length);
  for (const r of filtered) r.groupMode = mode;

  // Bullet-aware label numbering: when the master writes a choice list of
  // bullet items and EACH item contains a roll, we suffix every button label
  // with "(N)" matching the bullet's rendered number. This way "Roll 1d20+4
  // (attaccare)" and "Roll 1d20+4 (attaccare)" become "(1)" and "(2)" so the
  // player can tell them apart at a glance. We only apply this when every
  // request lives inside a distinct bullet — otherwise the numbering would
  // be ambiguous (two rolls in the same bullet would share a number).
  filtered.sort((a, b) => a.index - b.index);
  if (filtered.length > 1) {
    const bulletIndices = filtered.map((r) => bulletIndexAt(text, r.index));
    const allInBullets = bulletIndices.every((b) => b !== null);
    const allDistinct = new Set(bulletIndices).size === bulletIndices.length;
    if (allInBullets && allDistinct) {
      for (let i = 0; i < filtered.length; i++) {
        const n = bulletIndices[i]! + 1;
        filtered[i]!.label = `${filtered[i]!.label} (${n})`;
      }
    }
  }

  return filtered;
}

/**
 * Collapse save/check requests that refer to the same logical roll (same
 * ability or skill name) within a single master message. The DC suffix
 * `(CD N)` / `(DC N)` is stripped to compute the dedup key.
 *
 * Merge policy when duplicates collide:
 *   - one has a DC and the other doesn't → keep the one with the DC
 *   - both have the same DC → keep the LATER one (closer to the closing
 *     prompt, which is the authoritative ask)
 *   - both have DCs but they DIFFER → keep both (semantically distinct
 *     rolls, even if the ability is the same)
 *   - neither has a DC → keep the LATER one
 *
 * Attack / damage / generic rolls pass through untouched: the per-position
 * dedup inside each pattern loop already covers their uniqueness, and
 * legitimate repetitions (sequential attacks) must not collapse.
 */
function dedupLogicalSavesAndChecks(requests: RollRequest[]): RollRequest[] {
  const out: RollRequest[] = [];
  // Map from logical key → index inside `out`. Used to locate the previous
  // request when a duplicate arrives.
  const indexByKey = new Map<string, number>();
  for (const r of requests) {
    if (r.kind !== 'save' && r.kind !== 'check') {
      out.push(r);
      continue;
    }
    const semantic = stripDcSuffix(r.label).toLowerCase();
    const key = `${r.kind}:${semantic}`;
    const prevIdx = indexByKey.get(key);
    if (prevIdx === undefined) {
      indexByKey.set(key, out.length);
      out.push(r);
      continue;
    }
    const prev = out[prevIdx]!;
    const prevDc = parseDcFromLabel(prev.label);
    const curDc = parseDcFromLabel(r.label);
    if (curDc !== null && prevDc !== null && curDc !== prevDc) {
      // Two distinct DCs for the same ability — keep both. Don't update
      // the index map: future duplicates with either DC still collapse
      // against the FIRST occurrence, which is conservative.
      out.push(r);
      continue;
    }
    // Pick the winner: whichever is more informative, else later position.
    const currentWins =
      (curDc !== null && prevDc === null) ||
      (curDc === prevDc && r.index > prev.index);
    if (currentWins) {
      out[prevIdx] = r;
    }
  }
  return out;
}

function stripDcSuffix(label: string): string {
  return label.replace(/\s*\((?:CD|DC)\s*\d+\)\s*$/i, '').trim();
}

function parseDcFromLabel(label: string): number | null {
  const m = /\((?:CD|DC)\s*(\d+)\)/i.exec(label);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Try to identify which pending roll the player's free-text prose commits to,
 * so the UI can fire that roll automatically (saving the player from having to
 * click the corresponding button explicitly).
 *
 * Returns the matching request, or null if there's no clear winner. We only
 * fire when:
 *  - there is at least one pending roll;
 *  - the request set is in OR group mode (mutually-exclusive options or a
 *    single roll). AND-mode messages require every roll, not just one
 *    inferred from prose;
 *  - exactly one bullet's keywords beat every other bullet — ties produce
 *    null so the player gets a chance to pick explicitly.
 *
 * Matching strategy: for each request we tokenize the bullet line that
 * contains it (plus the request's own label) into "content words" — alphabetic
 * runs of length 4+, minus a small Italian/English stopword set of generic
 * roll vocabulary ("tira", "prova", "roll", "check", etc.). Each bullet's
 * keywords are matched against the player's tokens with a 4-char
 * case-insensitive prefix comparison (so "Intimidazione" / "intimidisco"
 * both stem to "inti", "attaccare" / "attacco" both stem to "atta").
 */
export function pickAutoRoll(
  playerText: string,
  requests: RollRequest[],
  masterContent: string,
): RollRequest | null {
  if (requests.length === 0) return null;
  // Only OR-mode (incl. single-roll) messages auto-route by prose. AND-mode
  // expects every roll to land before continuing.
  if (requests[0]!.groupMode !== 'or') return null;

  // Skip auto-roll when the player is asking a question rather than
  // committing to an action. "ho un longbow?" should NOT trigger a damage
  // roll just because "longbow" matches one of the bullets — the player is
  // asking, not declaring. Question-detection is intentionally minimal:
  // a trailing "?" after trimming is enough. Roleplay prose like
  //   "Vado, dico al goblin: cosa vuoi?"
  // would still skip auto-roll, which is fine — the player can click the
  // button to commit explicitly.
  const trimmed = playerText.trim();
  if (trimmed.endsWith('?')) return null;

  const playerTokens = tokenize(playerText);
  if (playerTokens.length === 0) return null;

  const scored = requests.map((req) => {
    const bulletLine = bulletLineAt(masterContent, req.index);
    const baseKeywords = [...tokenize(bulletLine), ...tokenize(req.label)];

    // Build the set of 4-char stems that match this bullet. Includes both
    // direct word stems extracted from the bullet/label and — when the bullet
    // mentions a canonical D&D skill name — the synonym verb stems for that
    // skill (so "gridando"/"ordino" can match a bullet that asked for an
    // Intimidazione check).
    const targetStems = new Set<string>();
    for (const kw of baseKeywords) {
      targetStems.add(kw.slice(0, 4).toLowerCase());
    }
    for (const stem of skillSynonymStems(bulletLine)) {
      targetStems.add(stem);
    }

    // Count distinct player stems that hit the target set. Dedup on the
    // player side too so repeating a word doesn't inflate the score.
    let score = 0;
    const seenPlayerStems = new Set<string>();
    for (const p of playerTokens) {
      const ps = p.slice(0, 4).toLowerCase();
      if (seenPlayerStems.has(ps)) continue;
      seenPlayerStems.add(ps);
      if (targetStems.has(ps)) score++;
    }
    return { req, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (scored[0]!.score === 0) return null;
  // Tie → ambiguous, let the player click instead.
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.req;
}

/**
 * For each canonical D&D 5e skill name, a list of Italian + English action
 * verbs/nouns that semantically imply that skill. When a master's bullet
 * mentions the skill by name (e.g. "tira una prova di Intimidazione"), the
 * pickAutoRoll matcher expands the bullet's keyword set with these synonyms
 * so the player can commit to the action with natural prose ("gridando",
 * "ordino di fermarsi", "minaccio") instead of repeating the skill name.
 *
 * Synonyms are only activated when the bullet contains the canonical name
 * (case-insensitive substring) — they don't pollute matches for unrelated
 * bullets in the same message.
 */
const SKILL_SYNONYM_VERBS: Record<string, string[]> = {
  Intimidazione: [
    'intimidire', 'intimidisco', 'intimidisce', 'minacciare', 'minaccia', 'minacciando',
    'urlare', 'urlando', 'urlo', 'urli', 'urla',
    'gridare', 'gridando', 'grido', 'grida', 'gridi',
    'ordinare', 'ordina', 'ordino', 'ordini',
    'comandare', 'comando', 'spaventare', 'terrorizzare', 'intimorire',
    'threaten', 'scare', 'frighten', 'yell', 'shout', 'command', 'order',
  ],
  Inganno: [
    'ingannare', 'inganno', 'mentire', 'mento', 'mentisco', 'fingere', 'fingo',
    'simulare', 'simulo', 'falsificare', 'bugia', 'menzogna',
    'deceive', 'lie', 'feign', 'pretend', 'falsify',
  ],
  Persuasione: [
    'persuadere', 'persuado', 'convincere', 'convinco', 'argomentare', 'argomento',
    'mediare', 'parlamentare', 'spiegare', 'spiego', 'ragionare',
    'persuade', 'convince', 'argue', 'mediate', 'reason', 'explain',
  ],
  Furtività: [
    'nascondersi', 'nascondo', 'sgattaiolare', 'sgattaiolo', 'soppiatto',
    'silenziosamente', 'eludere', 'sgusciare', 'sguscio',
    'sneak', 'hide', 'slip', 'shadow', 'silent',
  ],
  Acrobazia: [
    'saltare', 'salto', 'balzare', 'balzo', 'capriola', 'equilibrio', 'rotolare',
    'ruzzolare', 'piroetta',
    'jump', 'leap', 'tumble', 'roll', 'balance',
  ],
  Atletica: [
    'scalare', 'scalo', 'arrampicare', 'arrampico', 'nuotare', 'nuoto',
    'correre', 'corro', 'lottare', 'lotto', 'spingere', 'spingo',
    'sollevare', 'sollevo',
    'climb', 'swim', 'run', 'push', 'grapple', 'lift',
  ],
  Percezione: [
    'notare', 'noto', 'accorgersi', 'accorgo', 'ascoltare', 'ascolto',
    'osservare', 'osservo', 'guardare', 'guardo',
    'notice', 'observe', 'listen', 'spot',
  ],
  Investigazione: [
    'investigare', 'investigo', 'esaminare', 'esamino', 'studiare', 'studio',
    'analizzare', 'analizzo', 'cercare', 'cerco', 'frugare', 'frugo',
    'examine', 'study', 'analyze', 'search', 'investigate',
  ],
  Intuito: [
    'intuire', 'intuisco', 'sospettare', 'sospetto', 'capire', 'capisco',
    'percepire', 'percepisco', 'leggere',
    'sense', 'suspect', 'gut', 'read',
  ],
  // Italian translations sometimes use "Intuizione" instead of the canonical
  // "Intuito" — both refer to the Insight skill. Listed as a separate key so
  // skillSynonymStems' substring match catches the bullet either way.
  Intuizione: [
    'intuire', 'intuisco', 'sospettare', 'sospetto', 'capire', 'capisco',
    'percepire', 'percepisco', 'leggere',
    'sense', 'suspect', 'gut', 'read',
  ],
  Sopravvivenza: [
    'tracciare', 'tracce', 'orientarsi', 'oriento', 'cacciare', 'caccio',
    'foraggiare', 'seguire',
    'track', 'forage', 'navigate', 'hunt',
  ],
  Medicina: [
    'curare', 'curo', 'soccorrere', 'soccorro', 'rianimare', 'rianimo',
    'medicare', 'medico', 'bendare', 'bendo',
    'heal', 'treat', 'tend', 'bandage',
  ],
  'Addestrare Animali': [
    'calmare', 'calmo', 'addestrare', 'addestro', 'cavalcare', 'cavalco',
    'placare',
    'tame', 'mount', 'ride', 'soothe',
  ],
  'Rapidità di Mano': [
    'rubare', 'rubo', 'borseggiare', 'borseggio', 'sottrarre', 'sottraggo',
    'palmeggiare', 'sgraffignare',
    'pickpocket', 'palm', 'pilfer', 'steal',
  ],
  Intrattenere: [
    'cantare', 'canto', 'recitare', 'recito', 'suonare', 'suono',
    'danzare', 'ballare', 'ballo', 'esibire',
    'sing', 'recite', 'play', 'dance', 'perform',
  ],
};

/**
 * Italian + English stopwords that appear in roll requests regardless of which
 * action they describe. Filtering them out leaves only the action-specific
 * vocabulary that distinguishes one bullet from another.
 */
const AUTO_ROLL_STOPWORDS = new Set([
  // Italian roll vocabulary
  'tira', 'tiro', 'fai', 'effettua', 'lancia', 'prova', 'controllo', 'salvezza',
  'sono', 'stai', 'devo', 'voglio', 'puoi', 'vuoi', 'allora', 'quando', 'mentre',
  'dopo', 'prima', 'molto', 'poco', 'questa', 'questo', 'quella', 'quello',
  'mezza', 'mezzo', 'tutti', 'tutto', 'ogni', 'caso', 'volta',
  // English roll vocabulary
  'roll', 'make', 'check', 'save', 'with', 'from', 'into', 'onto', 'when',
  'where', 'while', 'this', 'that', 'these', 'those', 'have', 'will', 'would',
  'after', 'before', 'every', 'some',
]);

function tokenize(text: string): string[] {
  return text
    .split(/[^a-zà-ÿ]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !AUTO_ROLL_STOPWORDS.has(w.toLowerCase()));
}

/**
 * If `bulletText` mentions a canonical D&D skill name (case-insensitive
 * substring), return all 4-char synonym verb stems that semantically imply
 * that skill. Empty array when the bullet doesn't reference a known skill.
 */
function skillSynonymStems(bulletText: string): string[] {
  const lower = bulletText.toLowerCase();
  const stems: string[] = [];
  for (const [skill, synonyms] of Object.entries(SKILL_SYNONYM_VERBS)) {
    if (!lower.includes(skill.toLowerCase())) continue;
    for (const syn of synonyms) {
      const stem = syn.slice(0, 4).toLowerCase();
      if (stem.length === 4) stems.push(stem);
    }
  }
  return stems;
}

/**
 * Return the line of `text` that contains `charIdx`. If charIdx is on a
 * non-bullet line that follows a bullet line, returns just that line — we
 * don't try to merge continuation lines for now (the bullet content rarely
 * spans multiple lines in master prose).
 */
function bulletLineAt(text: string, charIdx: number): string {
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      if (charIdx >= lineStart && charIdx <= i) {
        return text.slice(lineStart, i);
      }
      lineStart = i + 1;
    }
  }
  return '';
}

/**
 * Find the 0-based bullet index for the bullet line that contains the given
 * character position, or null if the position is outside any bullet.
 *
 * "Bullet line" = a line whose first non-whitespace token is `-`, `*`, or
 * `<digits>.` followed by whitespace. Continuation lines that hang off a
 * previous bullet (no leading marker) inherit that bullet's index.
 *
 * Returns null when the position lies in prose that came before the first
 * bullet — common case is the lead-in paragraph.
 */
export function bulletIndexAt(text: string, charIdx: number): number | null {
  let lineStart = 0;
  let bulletIndex = -1;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(lineStart, i);
      const isBulletStart = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
      if (isBulletStart) bulletIndex++;
      // Are we on the line that contains charIdx?
      if (charIdx >= lineStart && charIdx <= i) {
        return bulletIndex >= 0 ? bulletIndex : null;
      }
      lineStart = i + 1;
    }
  }
  return null;
}

/**
 * Pick the group coordination mode for a master message containing N rolls.
 *
 * Default for 2+ rolls is 'and' — safer because in case of doubt the app waits
 * for every roll instead of sending prematurely. We escape to 'or' only when we
 * see clear cues:
 *
 * 1. **Choice introducers**: "Vuoi:", "Scegli:", "Puoi:", "Choose:", "You can:",
 *    "Either ... or", "Oppure". The master writes these when offering a list of
 *    mutually exclusive options.
 * 2. **Conditional second roll**: "if you hit", "se colpisci", "in caso di
 *    successo", etc. — the second roll is gated on the first, so the player
 *    only commits to the first now and the master will ask for the rest later.
 *
 * Single-roll messages are always 'or' (mode is moot — there's nothing to wait
 * for; first-click-wins is the trivial answer).
 */
export function detectGroupMode(text: string, count: number): RollGroupMode {
  if (count < 2) return 'or';

  // Choice introducers (Italian + English). The keyword is followed (eventually,
  // within the same sentence) by a colon that introduces the list of options.
  // The relaxed colon match (up to 120 chars, no sentence-end in between) catches:
  //   "Scegli l'approccio:"        → "scegli" + " l'approccio" + ":"
  //   "Vuoi:"                      → "vuoi" + ":" (zero chars between)
  //   "Choose the path:"           → "choose" + " the path" + ":"
  //   "You have two options:"      → "options" + ":" (zero chars between)
  //   "Hai due opzioni davanti a te:" → "opzioni" + " davanti a te" + ":"
  // It does NOT cross sentence boundaries (`.!?\n`), so prose like
  //   "Devi scegliere. Tira 1d20."  doesn't trigger (no colon at all)
  //   "Sembra che tu debba scegliere bene la tua arma. Poi: tira 1d20."
  //   here "scegliere" and ":" are split by ".", so no match.
  const choiceIntroducers =
    /\b(?:vuoi|scegli|scegliere|scelta|puoi|opzioni|opzione|alternative|alternativa|decidi|decisione)\b[^.!?\n]{0,120}:/i;
  if (choiceIntroducers.test(text)) return 'or';

  const choiceIntroducersEn =
    /\b(?:choose|options|option|pick|decide|decision|either)\b[^.!?\n]{0,120}:/i;
  if (choiceIntroducersEn.test(text)) return 'or';

  // "You can:" / "You may:" — softer choice introducer; accept too. The colon
  // here MUST follow within a few words, otherwise too many false positives.
  if (/\byou\s+(?:can|may)\b[^.!?\n]{0,30}:/i.test(text)) return 'or';

  // Disjunctive connectives — "oppure" in Italian, "either ... or" in English.
  if (/\boppure\b/i.test(text)) return 'or';
  if (/\beither\b[^.!?\n]+\bor\b/i.test(text)) return 'or';

  // Conditional second roll — the master gates roll #2 on the result of roll #1.
  // English: "if you hit", "if it hits", "if successful", "on a hit", "on success".
  if (/\bif\s+(?:you|it|that)?\s*(?:hit|hits|succeed|succeeds|miss|misses)/i.test(text)) return 'or';
  if (/\bon\s+(?:a\s+)?(?:hit|success|miss)/i.test(text)) return 'or';
  // Italian: "se colpisci/colpisce/riesci/riesce/va a segno/hai successo/ha successo".
  if (/\bse\s+(?:colpisci|colpisce|riesci|riesce|va\s+a\s+segno|hai\s+successo|ha\s+successo|manchi|manca)/i.test(text)) {
    return 'or';
  }
  if (/\bin\s+caso\s+di\s+(?:successo|colpo|fallimento)/i.test(text)) return 'or';

  return 'and';
}

/** Normalize a formula like "d20" → "1d20" and clamp valid die sizes. */
export function normalizeFormula(raw: string): string | null {
  const m = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(raw);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  if (count < 1 || count > 100) return null;
  if (![4, 6, 8, 10, 12, 20, 100].includes(sides)) return null;
  const modifier = m[3] ?? '';
  return `${count}d${sides}${modifier}`;
}

export interface RollResult {
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export function rollFormula(formula: string, rng: () => number = Math.random): RollResult {
  const m = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(formula);
  if (!m) throw new Error(`bad formula: ${formula}`);
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2]!, 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(rng() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { formula, rolls, modifier, total };
}

function abbrAbility(raw: string): string {
  const k = raw.slice(0, 3).toUpperCase();
  if (['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].includes(k)) return k;
  return raw;
}

/**
 * Map an Italian ability name (Forza/Destrezza/...) to its standard 3-letter
 * abbreviation. Falls back to the title-cased input when no match.
 */
function abbrItalianAbility(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case 'forza':
      return 'FOR';
    case 'destrezza':
      return 'DES';
    case 'costituzione':
      return 'COS';
    case 'intelligenza':
      return 'INT';
    case 'saggezza':
      return 'SAG';
    case 'carisma':
      return 'CAR';
    default:
      return raw;
  }
}

/**
 * Title-case + collapse whitespace for an Italian skill name captured by the
 * regex. Maps "Intimidire" → "Intimidazione" so the label is consistent
 * regardless of the verb form the master used. Also normalizes "Spettacolo" /
 * "Mano Lesta" alternative wordings to the canonical D&D 5e Italian skill list.
 */
function normalizeItalianSkill(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const lower = collapsed.toLowerCase();
  // Aliases → canonical form.
  const aliases: Record<string, string> = {
    intimidire: 'Intimidazione',
    spettacolo: 'Intrattenere',
    'mano lesta': 'Rapidità di Mano',
    'rapidita di mano': 'Rapidità di Mano',
    furtivita: 'Furtività',
    intuizione: 'Intuito',
    // "Indagine" / "Indagare" are common Italian translations for the
    // Investigation skill — some sources use them in place of the more
    // literal "Investigazione". Treat both as the same skill.
    indagine: 'Investigazione',
    indagare: 'Investigazione',
    // "Arcana" is the English/feminine variant of the SRD-Italian
    // "Arcano" skill — masters use either depending on register.
    arcana: 'Arcano',
  };
  if (aliases[lower]) return aliases[lower]!;
  // Otherwise return the original casing (the regex captured it as the master wrote it).
  return collapsed;
}

/**
 * Look at the text immediately after a formula and try to pull out a short
 * purpose phrase ("Sopravvivenza", "Perception", "attaccare il goblin", "damage").
 * Stops at the first sentence-ending delimiter so we don't bleed into the next
 * action in a multi-option message.
 */
export function extractPurpose(text: string, fromIdx: number): string | null {
  // Window after the formula, capped at the next strong delimiter.
  const window = text.slice(fromIdx);
  // Optional leading punctuation/whitespace, then "per/for ..." up to a sentence break.
  const m = /^[\s,]*(?:per|for)\s+([^.;:!?\n]+)/i.exec(window);
  if (!m) return null;
  let phrase = m[1]!.trim();

  // Strip trailing parentheticals like "(CD 10)" / "(DC 14)" / "(TS Forza)".
  phrase = phrase.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // Strip leading article: "una/un/uno/an/a/the".
  phrase = phrase.replace(/^(?:un[ao]?|an?|the)\s+/i, '');

  // Strip the boilerplate template that wraps the actual descriptor:
  //   "prova [di] ", "tiro salvezza [di] ", "tiro di ", "saving throw [of] ", "skill check ".
  phrase = phrase.replace(/^(?:prova\s+(?:di\s+)?|tiro\s+(?:salvezza\s+)?(?:di\s+)?|saving\s+throw\s+(?:of\s+)?|skill\s+check\s+(?:of\s+)?)/i, '');

  // After stripping the template, a second article might surface: "for a Perception check"
  // → "a Perception check" → after stripping leading "a " → "Perception check".
  phrase = phrase.replace(/^(?:un[ao]?|an?|a)\s+/i, '');

  // Strip mid-phrase parentheticals (e.g. "Intelligenza (Investigazione)" → "Intelligenza").
  phrase = phrase.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

  // Strip trailing "check" / "save" / "throw" / "prova" / "tiro".
  phrase = phrase.replace(/\s+(?:check|save|saving\s+throw|throw|prova|tiro)$/i, '');

  // Cap length and bail on empties.
  phrase = phrase.trim();
  if (!phrase) return null;
  if (phrase.length > 35) phrase = phrase.slice(0, 32).trimEnd() + '…';

  return phrase;
}

/**
 * Cleanup helper for the descriptor that lives BEFORE the formula in the
 * tagged-pattern case ("Tira iniziativa: 1d20+1" → "iniziativa"). Lighter than
 * extractPurpose because the descriptor is already a short noun-phrase — we
 * only strip leading articles and trailing parentheticals, then cap length.
 */
export function cleanInlinePurpose(raw: string): string | null {
  let p = raw.trim();
  // Strip leading articles. Two forms:
  //   1) word-articles followed by a space: "un ", "una ", "an ", "the ", "il ", "la ", ...
  //   2) Italian apostrophe-elided forms: "l'", "un'" (no space between article and noun).
  // It is critical that the space-separated form requires \s+ (not \s*) so we
  // don't strip the leading "a" of "attacco" or "anything".
  p = p.replace(/^(?:(?:un[ao]?|an?|the|il|la|lo|i|gli|le)\s+|(?:un['’]|l['’]))/i, '');
  // Strip trailing parentheticals like "(CD 14)" or "(DC 12)".
  p = p.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Strip "prova di " / "tiro [salvezza] [di] " / "saving throw of " prefixes.
  p = p.replace(/^(?:prova\s+(?:di\s+)?|tiro\s+(?:salvezza\s+)?(?:di\s+)?|saving\s+throw\s+(?:of\s+)?)/i, '');
  p = p.trim();
  if (!p) return null;
  if (p.length > 35) p = p.slice(0, 32).trimEnd() + '…';
  return p;
}

function inferKind(text: string, idx: number): RollKind {
  // Tight window: only the descriptor right around the formula. A wider window
  // could leak from one sentence to the next ("attack. ... damage." → false hit).
  const window = text.slice(Math.max(0, idx - 15), idx + 40).toLowerCase();
  // Damage first because "for damage" and "to attack" can both appear in a
  // single chained sentence; the descriptor closest to the formula wins.
  if (/damage|danno|danni|impatt/.test(window)) return 'damage';
  // English "attack/hit" + Italian "attacc(o|are|hi|a)" / "colp(ire|isci|isce|ito)".
  if (/attack|attacc|\bhit\b|colpir|colpisc|colpit/.test(window)) return 'attack';
  if (/save|salvezza|tiro\s+salvezza|\bts\b/.test(window)) return 'save';
  if (/check|prova/.test(window)) return 'check';
  if (/initiative|iniziativa/.test(window)) return 'init';
  return 'generic';
}
