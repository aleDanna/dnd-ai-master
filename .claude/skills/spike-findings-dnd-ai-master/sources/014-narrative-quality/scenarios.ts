/**
 * Five narrative-quality scenarios. Each probes a different dimension
 * that spikes 002-004 did not measure: scene description, NPC voicing,
 * combat narration, moral choice, lore improvisation.
 *
 * All scenarios force ITALIAN output (per user preference) and remove
 * the "Keep responses concise" constraint — we WANT prose here.
 */

export interface NarrativeScenario {
  id: string;
  dimension: string;
  user_message: string;
  context_files?: string[]; // Files the model should consult before responding
  rubric: string; // What good looks like (for human eval, not auto-scored)
}

export const SCENARIOS: NarrativeScenario[] = [
  {
    id: "scene-description",
    dimension: "Scene description / atmosphere",
    user_message:
      "Il party (Aragorn ranger livello 5) ha appena aperto la pesante porta di legno della torre dello stregone abbandonata. È notte. Descrivi cosa vedono i giocatori. Sii evocativo. 4-6 frasi.",
    rubric:
      "Vince chi: usa sensi multipli (vista, olfatto, suono), introduce 1-2 dettagli unici/memorabili, costruisce tensione senza essere generico, evita cliché logorati ('umido', 'oscuro', 'silenzio inquietante').",
  },
  {
    id: "npc-dialogue",
    dimension: "NPC voicing / dialogue",
    user_message:
      "Il party incontra un vecchio mercante itinerante di nome Bargo che chiaramente nasconde qualcosa. È sgradevole ma non apertamente ostile. Scrivi 4-5 battute di dialogo (solo le sue, in stile sceneggiatura: 'Bargo: «...»'). Deve avere una voce riconoscibile, non generica.",
    rubric:
      "Vince chi: dà a Bargo un tic verbale o lessico distintivo, lascia trapelare la menzogna senza renderla esplicita, evita 'sii ostile' generico e crea un personaggio che si potrebbe rigiocare in sessioni future.",
  },
  {
    id: "combat-narration",
    dimension: "Combat narration",
    user_message:
      "Aragorn (longsword) ha appena tirato 20 naturale sull'attack roll contro un goblin. Damage roll: 2d8+3 = 16 danni. Il goblin aveva 7 HP. Narra il colpo in 2-3 frasi cinematiche.",
    rubric:
      "Vince chi: rende il critico fisicamente specifico (dove colpisce, come reagisce il goblin), evita 'una pioggia di sangue' generico, gestisce il fatto che 16 dmg su 7 HP è overkill (non solo morte, ma spettacolo).",
  },
  {
    id: "moral-choice",
    dimension: "Choice quality / dramatic weight",
    user_message:
      "Scenario: la dimora del culto sta crollando. Nella stanza del rituale c'è una bambina legata sull'altare (vivente, terrorizzata) e una statuetta di giada antica (l'artefatto che il party è venuto a recuperare, ricompensa: 5000 monete d'oro). Il soffitto cede tra 10 secondi. Aragorn ha tempo per UNA azione: salvare la bambina O afferrare la statuetta. NON dare la risposta, ma presenta la scelta al giocatore in 3-4 frasi che diano peso a ENTRAMBE le opzioni.",
    rubric:
      "Vince chi: dà davvero peso a entrambe (non solo a quella moralmente 'giusta'), introduce 1 dettaglio che complica (la bambina implora? la statuetta è chiave per un'arc futuro?), non finisce con 'cosa fai?' generico ma con una pressione concreta.",
  },
  {
    id: "lore-improv",
    dimension: "Lore improvisation",
    user_message:
      "Il party ha appena ucciso 3 goblin in un covo nei boschi. Mentre rovistano, trovano un piccolo diario scritto in goblin. Sei il DM: improvvisa il contenuto del diario in 5-7 frasi, in modo che apra un'arc narrativa interessante per le prossime sessioni. Lo scritto deve sembrare autentico (un goblin che scrive, non un romanziere).",
    rubric:
      "Vince chi: cattura voice 'goblin' (grammatica scorretta? logica strana? ossessioni?), pianta 2-3 hook plot azionabili (nomi propri, luoghi, eventi datati), evita la trama generica 'un male più grande si avvicina'.",
  },
];
