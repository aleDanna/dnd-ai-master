import type { IconName } from '@/components/ui/icon';

export type RestKind = 'short' | 'long' | 'encounter';
export type ResourceKind = 'pip' | 'pool';

export interface ResourceMeta {
  name: string;
  icon: IconName;
  recharge: RestKind;
  hint?: string;
  action?: string;
  kind?: ResourceKind;
  poolUnit?: string;
}

/**
 * Per-feature metadata that doesn't live in the DB (icon, recharge cadence,
 * UX hint, action verb, pip-vs-pool rendering). Slugs match the engine's
 * `FeatureInstance.slug` values. Anything not in this table falls back to
 * sensible defaults (no icon, long-rest recharge, name = slug).
 */
export const CLASS_RESOURCE_META: Record<string, ResourceMeta> = {
  'second-wind': { name: 'Second Wind', icon: 'heart', recharge: 'short', hint: 'Bonus action — regain 1d10 + fighter level HP.', action: 'Use' },
  'action-surge': { name: 'Action Surge', icon: 'flame', recharge: 'short', hint: 'Take an additional action on your turn.', action: 'Use' },
  'rage': { name: 'Rage', icon: 'axe', recharge: 'long', hint: '+ damage on melee, resistance to physical damage.', action: 'Enter rage' },
  'sorcery-points': { name: 'Sorcery Points', icon: 'sparkle', recharge: 'long', hint: 'Convert into spell slots, or fuel Metamagic.', action: 'Spend', kind: 'pool', poolUnit: 'pts' },
  'font-of-magic': { name: 'Font of Magic', icon: 'flame', recharge: 'long', hint: 'Convert sorcery points to a spell slot once per turn.', action: 'Convert' },
  'channel-divinity': { name: 'Channel Divinity', icon: 'sun', recharge: 'short', hint: 'Turn Undead, or your domain option.', action: 'Channel' },
  'lay-on-hands': { name: 'Lay on Hands', icon: 'heart', recharge: 'long', hint: 'Pool of HP to heal yourself or others.', kind: 'pool', poolUnit: 'HP' },
  'divine-spark': { name: 'Divine Spark', icon: 'heart', recharge: 'long', hint: 'Bonus action: heal an ally or harm an enemy.', action: 'Use' },
  'wild-shape': { name: 'Wild Shape', icon: 'leaf', recharge: 'short', hint: 'Transform into a beast.', action: 'Transform' },
  'bardic-inspiration': { name: 'Bardic Inspiration', icon: 'music', recharge: 'short', hint: 'Grant an ally a bonus die.', action: 'Inspire' },
  'ki': { name: 'Ki', icon: 'fist', recharge: 'short', hint: 'Spend on flurry, deflect, dodge bonus actions.', action: 'Spend', kind: 'pool', poolUnit: 'pts' },
  'arcane-recovery': { name: 'Arcane Recovery', icon: 'wand', recharge: 'long', hint: 'Recover spell slots on a short rest.', action: 'Recover' },
  'hit-dice': { name: 'Hit Dice', icon: 'dice', recharge: 'long', hint: 'Spend on a short rest to regain HP.', action: 'Spend 1' },
  'mystic-arcanum': { name: 'Mystic Arcanum', icon: 'eye', recharge: 'long', hint: 'Cast a high-level spell once per day.', action: 'Cast' },
};

export interface ClassGlyph {
  icon: IconName;
  accent: string;
  label: string;
}

export const CLASS_GLYPH: Record<string, ClassGlyph> = {
  fighter:   { icon: 'sword',   accent: 'var(--ember)',     label: 'Fighter' },
  barbarian: { icon: 'axe',     accent: 'var(--dragonfire)', label: 'Barbarian' },
  sorcerer:  { icon: 'flame',   accent: 'var(--arcane-2)',  label: 'Sorcerer' },
  wizard:    { icon: 'wand',    accent: 'var(--arcane)',    label: 'Wizard' },
  warlock:   { icon: 'eye',     accent: 'var(--arcane)',    label: 'Warlock' },
  cleric:    { icon: 'shield',  accent: 'var(--gold)',      label: 'Cleric' },
  paladin:   { icon: 'shield',  accent: 'var(--gold)',      label: 'Paladin' },
  druid:     { icon: 'leaf',    accent: 'var(--verdigris)', label: 'Druid' },
  ranger:    { icon: 'leaf',    accent: 'var(--verdigris)', label: 'Ranger' },
  bard:      { icon: 'music',   accent: 'var(--gold)',      label: 'Bard' },
  rogue:     { icon: 'sparkle', accent: 'var(--fg-muted)',  label: 'Rogue' },
  monk:      { icon: 'fist',    accent: 'var(--verdigris)', label: 'Monk' },
};

export const DEFAULT_GLYPH: ClassGlyph = CLASS_GLYPH.fighter!;
