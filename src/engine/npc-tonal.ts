import type { TonalFrame, EngagementProfile, NPCAttitude, NPCBeats } from './types';

/**
 * Master World Lore §5.1 — 8 tonal frames that flavor a campaign. The
 * master picks one (or none) and the system prompt's dynamic block
 * surfaces the corresponding guidance from TONAL_FRAME_GUIDANCE.
 */
export const TONAL_FRAMES: TonalFrame[] = [
  'high_heroic',
  'sword_sorcery',
  'dark',
  'mythic',
  'cosmic_horror',
  'swashbuckling',
  'wuxia',
  'steampunk',
];

/**
 * Master Handbook §2.1 — 7 engagement profiles the master can register
 * for the active player. Multiple values are allowed (a player can be
 * both an explorer and a storyteller).
 */
export const ENGAGEMENT_PROFILES: EngagementProfile[] = [
  'acting',
  'fighting',
  'instigating',
  'optimizing',
  'problem_solving',
  'storytelling',
  'exploring',
];

/**
 * Master Handbook §11.1 — three legal attitudes for a named NPC.
 */
export const NPC_ATTITUDES: NPCAttitude[] = [
  'friendly',
  'indifferent',
  'hostile',
];

export function isValidTonalFrame(s: string): s is TonalFrame {
  return (TONAL_FRAMES as readonly string[]).includes(s);
}

export function isValidEngagementProfile(s: string): s is EngagementProfile {
  return (ENGAGEMENT_PROFILES as readonly string[]).includes(s);
}

export function isValidNPCAttitude(s: string): s is NPCAttitude {
  return (NPC_ATTITUDES as readonly string[]).includes(s);
}

/**
 * Master Handbook §11.1: an NPC's beats are "complete" when all four
 * fields (want, fear, quirk, attitude) are non-empty. The master prompt
 * uses this to remind the AI to flesh out NPCs that are still partial.
 */
export function npcBeatsComplete(beats: NPCBeats): boolean {
  return Boolean(beats.want && beats.fear && beats.quirk && beats.attitude);
}

/**
 * Master World Lore §5.1 — 1-2 sentence guidance per tonal frame, ready
 * to be injected into the master's system prompt. Each entry tells the
 * AI Master what register, prose density, and consequence flavor to
 * apply when the campaign is set to that frame.
 */
export const TONAL_FRAME_GUIDANCE: Record<TonalFrame, string> = {
  high_heroic:
    'Heroes save kingdoms; evil is clear; magic is wondrous. Lean into LotR-style triumph and noble sacrifice — bright banners, sworn oaths, and victories worth singing about.',
  sword_sorcery:
    'Gritty, morally grey; magic is rare and corrupting. Conan/Elric flavor: lone protagonists, ambiguous victories, ruined civilisations, and silver-tongued cults at the edge of every map.',
  dark:
    'The world is dying; every win is a delaying action. Berserk/Bloodborne — body horror, futility undertones, mercy as the rarest currency. Bleed the prose; let triumph cost something.',
  mythic:
    'Gods walk the earth; prophecies bind; fate is real. Greek myth/Witcher — cosmic stakes, archetypal characters, oaths that echo across generations, and monsters with names older than any kingdom.',
  cosmic_horror:
    'The universe is indifferent; knowledge corrodes. Lovecraft/Bloodborne — sanity, dread, the unknowable. Silence between sentences; let the player feel watched. Truth is the enemy.',
  swashbuckling:
    'Flashy duels, wit over might, adventure as play. Princess Bride — banter, daring rescues, romance, balconies and rope-swung escapes. Keep the prose buoyant; let style win the day.',
  wuxia:
    'Martial schools, honor, ki, mountain monasteries. Eastern flavor: lineage, philosophical conflict, gravity-defying combat, debts of teacher and student. Stillness is power.',
  steampunk:
    'Magic intersects with industry; airships, gunsmoke, factory cities. Eberron — pulp investigation, magitech, soot-stained alleys and bright neon glyphs. The marvelous is mass-produced.',
};
