import type { Ability, ConditionInstance, ConditionSlug } from './types';

export interface ConditionEffectFlags {
  // movement
  speedZero: boolean;
  speedHalvedFactor: number;       // 1 (normal) or 0.5
  // hp
  hpMaxFactor: number;              // 1 (normal) or 0.5
  // action economy
  incapacitated: boolean;
  cannotReact: boolean;
  // own rolls
  attackRollAdvantage: boolean;
  attackRollDisadvantage: boolean;
  abilityCheckDisadvantage: boolean;
  saveAutoFail: Record<Ability, boolean>;
  saveDisadvantage: Record<Ability, boolean>;
  // incoming
  incomingAttackAdvantage: boolean;
  incomingAttackDisadvantage: boolean;
  incomingMeleeWithin5ftAdvantage: boolean;
  incomingMeleeWithin5ftAutoCrit: boolean;
  incomingRangedDisadvantage: boolean;
  // damage
  resistanceAllDamage: boolean;
  // misc
  dropsHeldItems: boolean;
}

export interface EffectContext {
  exhaustionLevel?: number;  // 0..6
}

const ABILITIES: Ability[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

function emptyAbilityFlags(): Record<Ability, boolean> {
  return { STR: false, DEX: false, CON: false, INT: false, WIS: false, CHA: false };
}

function defaultFlags(): ConditionEffectFlags {
  return {
    speedZero: false,
    speedHalvedFactor: 1,
    hpMaxFactor: 1,
    incapacitated: false,
    cannotReact: false,
    attackRollAdvantage: false,
    attackRollDisadvantage: false,
    abilityCheckDisadvantage: false,
    saveAutoFail: emptyAbilityFlags(),
    saveDisadvantage: emptyAbilityFlags(),
    incomingAttackAdvantage: false,
    incomingAttackDisadvantage: false,
    incomingMeleeWithin5ftAdvantage: false,
    incomingMeleeWithin5ftAutoCrit: false,
    incomingRangedDisadvantage: false,
    resistanceAllDamage: false,
    dropsHeldItems: false,
  };
}

const APPLIERS: Record<Exclude<ConditionSlug, 'exhaustion'>, (f: ConditionEffectFlags) => void> = {
  blinded: (f) => {
    f.attackRollDisadvantage = true;
    f.incomingAttackAdvantage = true;
  },
  charmed: () => {
    // no automatic mechanical effect — charmer-tracking is narrative
  },
  deafened: () => {
    // auto-fail check requiring hearing — narrative
  },
  frightened: (f) => {
    // assumes source visible (engine v1 shortcut)
    f.attackRollDisadvantage = true;
    f.abilityCheckDisadvantage = true;
  },
  grappled: (f) => {
    f.speedZero = true;
  },
  incapacitated: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
  },
  invisible: (f) => {
    f.attackRollAdvantage = true;
    f.incomingAttackDisadvantage = true;
  },
  paralyzed: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
    f.incomingMeleeWithin5ftAutoCrit = true;
  },
  petrified: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.resistanceAllDamage = true;
    f.incomingAttackAdvantage = true;
  },
  poisoned: (f) => {
    f.attackRollDisadvantage = true;
    f.abilityCheckDisadvantage = true;
  },
  prone: (f) => {
    f.attackRollDisadvantage = true;
    f.incomingMeleeWithin5ftAdvantage = true;
    f.incomingRangedDisadvantage = true;
  },
  restrained: (f) => {
    f.speedZero = true;
    f.attackRollDisadvantage = true;
    f.saveDisadvantage.DEX = true;
    f.incomingAttackAdvantage = true;
  },
  stunned: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
  },
  unconscious: (f) => {
    f.incapacitated = true;
    f.cannotReact = true;
    f.speedZero = true;
    f.dropsHeldItems = true;
    f.saveAutoFail.STR = true;
    f.saveAutoFail.DEX = true;
    f.incomingAttackAdvantage = true;
    f.incomingMeleeWithin5ftAutoCrit = true;
  },
  // Mechanical buff markers — tracked as condition-like state; effects (e.g. bless +1d4)
  // are resolved in narrative/roll-resolution layers, not in the static flag table here.
  blessed: () => { /* +1d4 attack/save handled at roll site */ },
  baned: () => { /* -1d4 attack/save handled at roll site */ },
  shielded: () => { /* +AC handled at AC compute */ },
  flying: () => { /* movement mode handled at movement layer */ },
  'mage-armored': () => { /* AC base override handled at AC compute */ },
  helped: () => { /* PHB §3.5: advantage on next d20 — handled at roll site */ },
};

function applyExhaustion(f: ConditionEffectFlags, level: number): void {
  if (level >= 1) f.abilityCheckDisadvantage = true;
  if (level >= 2) f.speedHalvedFactor = 0.5;
  if (level >= 3) {
    f.attackRollDisadvantage = true;
    for (const ab of ABILITIES) f.saveDisadvantage[ab] = true;
  }
  if (level >= 4) f.hpMaxFactor = 0.5;
  if (level >= 5) f.speedZero = true;
  // level 6 is death — handled elsewhere
}

export function getEffectsForActor(
  conditions: ConditionInstance[],
  ctx: EffectContext = {},
): ConditionEffectFlags {
  const flags = defaultFlags();
  for (const c of conditions) {
    if (c.slug === 'exhaustion') continue; // handled via ctx.exhaustionLevel
    const fn = APPLIERS[c.slug];
    if (fn) fn(flags);
  }
  if (ctx.exhaustionLevel && ctx.exhaustionLevel > 0) {
    applyExhaustion(flags, ctx.exhaustionLevel);
  }
  return flags;
}
