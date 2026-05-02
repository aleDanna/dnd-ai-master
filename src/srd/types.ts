import type {
  SrdArmorInsert,
  SrdBackgroundInsert,
  SrdClassInsert,
  SrdConditionInsert,
  SrdFeatInsert,
  SrdGearInsert,
  SrdMonsterInsert,
  SrdRaceInsert,
  SrdRuleDocInsert,
  SrdSpellInsert,
  SrdWeaponInsert,
} from '@/db/schema';

export type ParsedSrd = {
  classes: SrdClassInsert[];
  races: SrdRaceInsert[];
  backgrounds: SrdBackgroundInsert[];
  feats: SrdFeatInsert[];
  conditions: SrdConditionInsert[];
  spells: SrdSpellInsert[];
  monsters: SrdMonsterInsert[];
  armor: SrdArmorInsert[];
  weapons: SrdWeaponInsert[];
  gear: SrdGearInsert[];
  rules: SrdRuleDocInsert[];
};
