/**
 * Pre-built campaign premises for the new-session flow. Picking one fills the
 * premise textarea with the suggested setup; the user can still edit before
 * starting. A "Custom" option leaves the field free-form.
 */

export interface CampaignPreset {
  id: string;
  name: string;
  blurb: string;        // one-line teaser shown on the card
  difficulty: 'novice' | 'standard' | 'gritty';
  themes: string[];     // 2–3 short tags
  premise: string;      // multi-sentence prompt that ships to the master
}

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  {
    id: 'goblin-warren',
    name: 'The Goblin Warren',
    blurb: 'A cramped warren beneath an old mill — a perfect first dungeon.',
    difficulty: 'novice',
    themes: ['dungeon', 'combat', 'starter'],
    premise:
      'A goblin warren beneath an old mill. Heavy rain outside, dim torchlight inside. ' +
      'Locals report missing livestock and a child who never came home. The mayor offers 50 gp for proof of what is taking them.',
  },
  {
    id: 'haunted-lighthouse',
    name: 'The Haunted Lighthouse',
    blurb: 'The lighthouse keeper has not lit the beacon in a week. Ships are wrecking.',
    difficulty: 'standard',
    themes: ['mystery', 'horror', 'investigation'],
    premise:
      'A coastal village hires you to investigate the lighthouse on Cape Mournhollow. ' +
      'For seven nights the beacon has been dark; three ships have wrecked on the rocks. The keeper, an old half-elf named Ilvarion, has not been seen in town. ' +
      'A heavy fog rolls in as you approach the cliff path.',
  },
  {
    id: 'wedding-ambush',
    name: 'The Bandit Wedding',
    blurb: 'You are guests at a noble wedding. The bandits arrive between the toasts.',
    difficulty: 'standard',
    themes: ['social', 'intrigue', 'combat'],
    premise:
      'You are seated at the wedding of Lady Cosima Vellante to the merchant prince Aldric Mardus. ' +
      'Halfway through the third toast, masked bandits crash through the chapel doors. ' +
      'Among the guests are nobles, mercenaries, and at least one rival the bride spurned. Someone here is helping the bandits.',
  },
  {
    id: 'wandering-sage-crypt',
    name: 'Crypt of the Wandering Sage',
    blurb: 'A scholar long thought dead has been seen entering an ancient crypt.',
    difficulty: 'gritty',
    themes: ['dungeon', 'undead', 'lore'],
    premise:
      'The sage Aerith Vorm vanished forty years ago studying necromantic ruins beneath the Whisperwood. ' +
      'Last week a hunter saw a lantern in the crypt of the old kings. ' +
      'The College of Brassgate will pay for any of his journals — or his bones. The crypt is half-flooded; the dead, allegedly, do not stay dead.',
  },
  {
    id: 'caravan-pass',
    name: 'The Iron Pass Caravan',
    blurb: 'You are escorting a caravan through the only safe pass for thirty miles.',
    difficulty: 'novice',
    themes: ['travel', 'wilderness', 'combat'],
    premise:
      'You hire on as caravan guards through the Iron Pass — a narrow road carved into a mountainside, the only safe route to Dornholt before the snows close it. ' +
      'The merchant carries crates marked "fragile" and refuses to say what is inside. ' +
      'On the second night, scouts spot a fire on the cliffs above.',
  },
];

export const DEFAULT_PRESET_ID = 'goblin-warren';

export function getPresetById(id: string): CampaignPreset | undefined {
  return CAMPAIGN_PRESETS.find((p) => p.id === id);
}
