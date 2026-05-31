/**
 * The campaign-opener ("begin") user message, shared by the baked and vault
 * turn paths.
 *
 * The opener prepends the campaign premise verbatim (non-thinking MoE models
 * weight recent user content far above system blocks) and then the BEGIN
 * instruction in the campaign language.
 *
 * Tonal-frame mandate (`opts.tonalMandate`, default true):
 *   The baked path requires the master to call `meta_action set_tonal_frame`
 *   as the first opening step (enforced by `requiredToolsBeforeEnd` in
 *   tool-loop.ts; the meta_action tool is in META_TOOL_DEFINITIONS). The VAULT
 *   path does NOT expose meta_action, never reads tonalFrame, and has no
 *   requiredToolsBeforeEnd enforcement — so ordering the mandate there makes a
 *   local model emit `meta_action: {...}` as TEXT instead of narrating, which
 *   stalls the opening turn. The vault caller passes `tonalMandate: false`.
 */

/** Language → BEGIN instruction (scene-opening directive, no tool mandate). */
const BEGIN_INSTRUCTION: Record<string, string> = {
  en: '[Begin the campaign now. Open the scene by narrating, in second person, the player character\'s immediate surroundings and the situation that draws them in — strictly grounded in the Campaign premise above. Voice any NPCs in earshot. Do NOT call any state-mutating tool (no add_item, award_xp, apply_damage, roll_initiative, etc.) on this opening turn — just establish the scene. End with an open-ended cue inviting the player\'s first action.]',
  it: '[Inizia la campagna ora. Apri la scena narrando, in seconda persona, ciò che il personaggio giocante percepisce nell\'ambiente circostante e la situazione che lo coinvolge — strettamente ancorato alla Premessa della campagna sopra. Dai voce a qualunque PNG a portata d\'orecchio. NON chiamare alcun tool che muta lo stato (niente add_item, award_xp, apply_damage, roll_initiative, ecc.) in questo turno di apertura — limitati a stabilire la scena. Concludi con uno spunto aperto che inviti la prima azione del giocatore.]',
  es: '[Comienza la campaña ahora. Abre la escena narrando, en segunda persona, lo que el personaje jugador percibe a su alrededor y la situación que lo involucra — estrictamente anclado a la Premisa de la campaña arriba. Da voz a cualquier PNJ al alcance. NO llames a ninguna herramienta que mute el estado en este turno de apertura — solo establece la escena. Termina con un cierre abierto que invite a la primera acción del jugador.]',
  fr: '[Commence la campagne maintenant. Ouvre la scène en narrant, à la deuxième personne, ce que le personnage perçoit autour de lui et la situation qui le concerne — strictement ancrée dans la Prémisse de la campagne ci-dessus. Donne voix aux PNJ à portée. N\'appelle AUCUN outil qui mute l\'état pendant ce tour d\'ouverture — établis simplement la scène. Termine par une invite ouverte appelant la première action du joueur.]',
  de: '[Beginne die Kampagne jetzt. Eröffne die Szene, indem du in der zweiten Person erzählst, was die Spielfigur in der unmittelbaren Umgebung wahrnimmt und welche Situation sie hineinzieht — streng verankert in der obenstehenden Kampagnen-Prämisse. Verleihe etwaigen NSCs in Hörweite eine Stimme. Rufe in dieser Eröffnungsrunde KEIN zustandsänderndes Werkzeug auf — etabliere nur die Szene. Schließe mit einem offenen Hinweis, der die erste Aktion der Spielerin einlädt.]',
  pt: '[Comece a campanha agora. Abra a cena narrando, na segunda pessoa, o que o personagem percebe no entorno imediato e a situação que o envolve — estritamente ancorada na Premissa da campanha acima. Dê voz a quaisquer NPCs ao alcance. NÃO chame nenhuma ferramenta que mute o estado neste turno de abertura — apenas estabeleça a cena. Termine com um gancho aberto convidando a primeira ação do jogador.]',
};

/** Language → tonal-frame mandate (baked path only; see module doc). */
const BEGIN_TONAL_MANDATE: Record<string, string> = {
  en: '[MANDATORY OPENING STEP] Before writing any narration, you MUST call the meta_action tool with subaction="set_tonal_frame" and a frame value exactly once. Choose the frame that best fits the campaign premise from: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. The server will reject the opening turn and re-prompt you if this tool is not called first.',
  it: '[PASSO DI APERTURA OBBLIGATORIO] Prima di scrivere qualsiasi narrazione, DEVI chiamare il tool meta_action con subaction="set_tonal_frame" e un valore frame esattamente una volta. Scegli il frame che meglio si adatta alla premessa della campagna fra: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Il server rifiuterà il turno di apertura e ti riassegnerà il prompt se questo tool non viene chiamato per primo.',
  es: '[PASO DE APERTURA OBLIGATORIO] Antes de escribir cualquier narración, DEBES llamar al tool meta_action con subaction="set_tonal_frame" y un valor frame exactamente una vez. Elige el frame que mejor encaje con la premisa de la campaña entre: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. El servidor rechazará el turno de apertura y volverá a pedirte el prompt si esta herramienta no se llama primero.',
  fr: '[ÉTAPE D\'OUVERTURE OBLIGATOIRE] Avant d\'écrire toute narration, tu DOIS appeler le tool meta_action avec subaction="set_tonal_frame" et une valeur frame exactement une fois. Choisis le frame qui correspond le mieux à la prémisse parmi : high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Le serveur rejettera le tour d\'ouverture si cet outil n\'est pas appelé en premier.',
  de: '[OBLIGATORISCHER ERÖFFNUNGSSCHRITT] Bevor du irgendeine Erzählung schreibst, MUSST du das Werkzeug meta_action mit subaction="set_tonal_frame" und einem frame-Wert genau einmal aufrufen. Wähle den Frame, der am besten zur Prämisse passt, aus: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. Der Server lehnt die Eröffnungsrunde ab und stellt die Anfrage erneut, wenn dieses Werkzeug nicht zuerst aufgerufen wird.',
  pt: '[PASSO DE ABERTURA OBRIGATÓRIO] Antes de escrever qualquer narração, você DEVE chamar a ferramenta meta_action com subaction="set_tonal_frame" e um valor frame exatamente uma vez. Escolha o frame que melhor combine com a premissa entre: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk. O servidor rejeitará o turno de abertura se esta ferramenta não for chamada primeiro.',
};

export interface BeginMessageOptions {
  /**
   * Prefix the tonal-frame mandate (baked path). Default true. The vault path
   * passes false — it has no meta_action tool / tonalFrame / enforcement, so
   * the mandate only makes local models emit the tool call as text.
   */
  tonalMandate?: boolean;
}

export function buildBeginUserMessage(
  premise: string | null | undefined,
  language: string | null | undefined,
  opts?: BeginMessageOptions,
): string {
  const lang = language ?? 'en';
  const blocks: string[] = [];
  if (premise && premise.trim()) {
    blocks.push(`Campaign premise:\n\n${premise.trim()}`);
  }
  if (opts?.tonalMandate !== false) {
    blocks.push(BEGIN_TONAL_MANDATE[lang] ?? BEGIN_TONAL_MANDATE.en!);
  }
  blocks.push(BEGIN_INSTRUCTION[lang] ?? BEGIN_INSTRUCTION.en!);
  return blocks.join('\n\n');
}
