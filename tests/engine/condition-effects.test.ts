import { describe, expect, it } from 'vitest';
import { getEffectsForActor } from '../../src/engine/condition-effects';
import type { ConditionInstance } from '../../src/engine/types';

const cond = (slug: ConditionInstance['slug'], extra?: Partial<ConditionInstance>): ConditionInstance => ({
  slug,
  source: 'test',
  durationRounds: 'until_removed',
  appliedRound: 0,
  ...extra,
});

describe('getEffectsForActor — flags base', () => {
  it('nessuna condizione → tutti i flag a default', () => {
    const fx = getEffectsForActor([]);
    expect(fx.speedZero).toBe(false);
    expect(fx.speedHalvedFactor).toBe(1);
    expect(fx.hpMaxFactor).toBe(1);
    expect(fx.incapacitated).toBe(false);
    expect(fx.attackRollDisadvantage).toBe(false);
    expect(fx.incomingAttackAdvantage).toBe(false);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(false);
    expect(fx.abilityCheckDisadvantage).toBe(false);
    expect(fx.saveAutoFail.STR).toBe(false);
    expect(fx.saveAutoFail.DEX).toBe(false);
  });

  it('blinded → attack DIS, incoming attack ADV', () => {
    const fx = getEffectsForActor([cond('blinded')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('grappled → speedZero', () => {
    const fx = getEffectsForActor([cond('grappled')]);
    expect(fx.speedZero).toBe(true);
  });

  it('incapacitated → cannot act, cannot react', () => {
    const fx = getEffectsForActor([cond('incapacitated')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.cannotReact).toBe(true);
  });

  it('paralyzed → incapacitated + auto-fail STR/DEX + incoming ADV + melee 5ft auto-crit', () => {
    const fx = getEffectsForActor([cond('paralyzed')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.saveAutoFail.DEX).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(true);
  });

  it('petrified → incapacitated + auto-fail STR/DEX + resistance all damage', () => {
    const fx = getEffectsForActor([cond('petrified')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.resistanceAllDamage).toBe(true);
  });

  it('poisoned → attack DIS + check DIS', () => {
    const fx = getEffectsForActor([cond('poisoned')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('prone → attack DIS + incoming melee 5ft ADV + incoming ranged DIS', () => {
    const fx = getEffectsForActor([cond('prone')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.incomingMeleeWithin5ftAdvantage).toBe(true);
    expect(fx.incomingRangedDisadvantage).toBe(true);
  });

  it('restrained → speedZero + attack DIS + DEX save DIS + incoming ADV', () => {
    const fx = getEffectsForActor([cond('restrained')]);
    expect(fx.speedZero).toBe(true);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.saveDisadvantage.DEX).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('stunned → incapacitated + auto-fail STR/DEX + incoming ADV', () => {
    const fx = getEffectsForActor([cond('stunned')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.incomingAttackAdvantage).toBe(true);
  });

  it('unconscious → incapacitated + speed 0 + drops + auto-fail + melee 5ft auto-crit', () => {
    const fx = getEffectsForActor([cond('unconscious')]);
    expect(fx.incapacitated).toBe(true);
    expect(fx.speedZero).toBe(true);
    expect(fx.dropsHeldItems).toBe(true);
    expect(fx.saveAutoFail.STR).toBe(true);
    expect(fx.incomingMeleeWithin5ftAutoCrit).toBe(true);
  });

  it('frightened → attack DIS + check DIS', () => {
    const fx = getEffectsForActor([cond('frightened')]);
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('invisible → attack ADV + incoming attack DIS', () => {
    const fx = getEffectsForActor([cond('invisible')]);
    expect(fx.attackRollAdvantage).toBe(true);
    expect(fx.incomingAttackDisadvantage).toBe(true);
  });
});

describe('getEffectsForActor — exhaustion levels', () => {
  it('exhaustion lvl 1 → ability check DIS', () => {
    const fx = getEffectsForActor([cond('exhaustion', { durationRounds: 1, appliedRound: 1 })], { exhaustionLevel: 1 });
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('exhaustion lvl 2 → speed halved', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 2 });
    expect(fx.speedHalvedFactor).toBe(0.5);
    expect(fx.abilityCheckDisadvantage).toBe(true);
  });

  it('exhaustion lvl 3 → attack DIS + save DIS all', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 3 });
    expect(fx.attackRollDisadvantage).toBe(true);
    expect(fx.saveDisadvantage.STR).toBe(true);
    expect(fx.saveDisadvantage.WIS).toBe(true);
  });

  it('exhaustion lvl 4 → HP max halved', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 4 });
    expect(fx.hpMaxFactor).toBe(0.5);
  });

  it('exhaustion lvl 5 → speedZero', () => {
    const fx = getEffectsForActor([cond('exhaustion')], { exhaustionLevel: 5 });
    expect(fx.speedZero).toBe(true);
  });
});

describe('getEffectsForActor — combinazioni', () => {
  it('blinded + restrained → entrambi gli effetti', () => {
    const fx = getEffectsForActor([cond('blinded'), cond('restrained')]);
    expect(fx.attackRollDisadvantage).toBe(true);  // entrambi causano DIS
    expect(fx.incomingAttackAdvantage).toBe(true);  // entrambi causano ADV in ingresso
    expect(fx.speedZero).toBe(true);                // restrained
    expect(fx.saveDisadvantage.DEX).toBe(true);     // restrained
  });
});
