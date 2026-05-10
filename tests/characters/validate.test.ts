import { describe, it, expect } from 'vitest';
import { validateWizardState } from '@/characters/validate';
import { emptyWizardState } from '@/characters/types';

describe('validateWizardState', () => {
  const completeOptions = {
    raceSlugs: ['half-elf', 'human'],
    classSlugs: ['fighter', 'wizard'],
    backgroundSlugs: ['soldier', 'sage'],
  };

  it('rejects empty wizard state', () => {
    const r = validateWizardState(emptyWizardState(), completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('race-required');
  });

  it('rejects unknown raceSlug', () => {
    const w = emptyWizardState();
    w.raceSlug = 'unknown';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('race-unknown');
  });

  it('requires identity.name', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('name-required');
  });

  it('accepts a complete state', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.classChoices = { 'fighting-style': 'fighting-style-defense' };
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects ability scores outside 8..15 for standard array (lvl 1 only)', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilities.STR = 19;
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-out-of-range');
  });

  it('rejects standard array with duplicates / wrong values', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'array';
    w.abilities = { STR: 15, DEX: 15, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-array-mismatch');
  });

  it('rejects pointbuy that has not spent all 27 points', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    w.abilities = { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-pointbuy-incomplete');
  });

  it('rejects pointbuy that overspends the budget', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    // 15+15+15+8+8+8 = 9+9+9 = 27 (exactly on budget — valid)
    // Force overspend by going beyond max:
    w.abilities = { STR: 15, DEX: 15, CON: 15, INT: 12, WIS: 8, CHA: 8 };
    // Spent: 9+9+9+4+0+0 = 31 → over.
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('ability-pointbuy-overspent');
  });

  it('accepts a valid completed pointbuy', () => {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.classChoices = { 'fighting-style': 'fighting-style-defense' };
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    w.abilityMethod = 'pointbuy';
    // 15+14+13+12+10+8 = 9+7+5+4+2+0 = 27, all in [8..15]
    w.abilities = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
    const r = validateWizardState(w, completeOptions);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  // ─── Skills ──────────────────────────────────────────────────────────────────

  const optionsWithSkillRules = {
    ...completeOptions,
    classSkillRules: {
      fighter: { skillsChoose: 2, skillsFrom: ['Acrobatics', 'Athletics', 'Intimidation', 'Perception'] },
      wizard: { skillsChoose: 2, skillsFrom: ['Arcana', 'History', 'Insight', 'Investigation'] },
    },
    backgroundSkills: {
      soldier: ['Athletics', 'Intimidation'],
      sage: ['Arcana', 'History'],
    },
  };

  function baseValidWizard() {
    const w = emptyWizardState();
    w.raceSlug = 'half-elf';
    w.classSlug = 'fighter';
    w.classChoices = { 'fighting-style': 'fighting-style-defense' };
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Tharion';
    return w;
  }

  it('rejects a fighter with too many class skill picks', () => {
    const w = baseValidWizard();
    // Athletics + Intimidation are background — free. Acrobatics + Perception = 2 picks (OK).
    // Add a third class pick to trigger the cap.
    w.skills = ['Acrobatics', 'Perception', 'Athletics']; // Athletics is bg, doesn't count
    // Actually that's 2 class picks — let me make it 3.
    w.skills = ['Acrobatics', 'Perception', 'Intimidation']; // Intimidation is bg, doesn't count
    // Still 2. Let's push past:
    w.skills = ['Acrobatics', 'Perception', 'Insight']; // Insight not on fighter list
    // That'll trigger off-list. Test that separately. Let me do a real overflow:
    // fighter list = [Acrobatics, Athletics, Intimidation, Perception]. Background grants Athletics + Intimidation.
    // So picks NOT from background = Acrobatics, Perception. To exceed 2, I need a third class-list non-bg skill.
    // But there are only 4 class skills total, 2 of which are bg. So only 2 non-bg class skills exist.
    // To test "too many", I need a class with more options not granted by bg. Use wizard.
    const ww = emptyWizardState();
    ww.raceSlug = 'half-elf';
    ww.classSlug = 'wizard';
    ww.backgroundSlug = 'soldier'; // soldier grants Athletics + Intimidation, neither on wizard list
    ww.identity.name = 'Mord';
    ww.skills = ['Arcana', 'History', 'Insight']; // 3 picks, all on wizard list, no bg overlap
    const r = validateWizardState(ww, optionsWithSkillRules);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('skills-too-many');
  });

  it('rejects a fighter with skills off the class list', () => {
    const w = baseValidWizard();
    w.skills = ['Arcana', 'Acrobatics']; // Arcana is not on fighter list and not granted by Soldier
    const r = validateWizardState(w, optionsWithSkillRules);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('skills-off-list');
  });

  it('rejects a fighter with too few class skills', () => {
    const w = baseValidWizard();
    w.skills = ['Acrobatics']; // only 1 class pick, fighter wants 2
    const r = validateWizardState(w, optionsWithSkillRules);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('skills-too-few');
  });

  it('accepts exactly 2 class picks (background grants do not count toward the budget)', () => {
    const w = baseValidWizard();
    // Soldier grants Athletics + Intimidation. Player picks 2 more from fighter list.
    w.skills = ['Acrobatics', 'Perception'];
    const r = validateWizardState(w, optionsWithSkillRules);
    expect(r.ok).toBe(true);
  });

  // ─── Class L1 choices ──────────────────────────────────────────────────────

  describe('class L1 choices', () => {
    it('rejects a fighter without fighting-style', () => {
      const w = emptyWizardState();
      w.raceSlug = 'half-elf';
      w.classSlug = 'fighter';
      w.backgroundSlug = 'soldier';
      w.identity.name = 'Tharion';
      // no classChoices — fighter requires fighting-style
      const r = validateWizardState(w, completeOptions);
      expect(r.errors).toContain('class-choice-required:fighting-style');
    });

    it('rejects an unknown fighting-style slug', () => {
      const w = emptyWizardState();
      w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'X';
      w.classChoices = { 'fighting-style': 'fighting-style-bogus' };
      const r = validateWizardState(w, completeOptions);
      expect(r.errors).toContain('class-choice-unknown:fighting-style');
    });

    it('classes without L1 choices (e.g. wizard) need no classChoices entry', () => {
      const w = emptyWizardState();
      w.raceSlug = 'half-elf'; w.classSlug = 'wizard'; w.backgroundSlug = 'soldier'; w.identity.name = 'X';
      const r = validateWizardState(w, completeOptions);
      // wizard has no L1 choices in CLASS_L1_CHOICES → no class-choice-* errors
      expect(r.errors.filter((e) => e.startsWith('class-choice-'))).toEqual([]);
    });
  });

  // ─── Subrace ───────────────────────────────────────────────────────────────

  describe('subrace requirement', () => {
    const subracesByBase = {
      dwarf: ['hill-dwarf', 'mountain-dwarf'],
      elf: ['high-elf', 'wood-elf'],
      // half-elf has none — no subraces in PHB
    };
    const optsWithSubrace = {
      ...completeOptions,
      raceSlugs: ['dwarf', 'hill-dwarf', 'mountain-dwarf', 'elf', 'high-elf', 'wood-elf', 'half-elf'],
      subracesByBase,
    };

    function dwarvenWizard(subraceSlug: string | null) {
      const w = emptyWizardState();
      w.raceSlug = 'dwarf';
      w.subraceSlug = subraceSlug;
      w.classSlug = 'fighter';
      w.backgroundSlug = 'soldier';
      w.identity.name = 'Tharion';
      return w;
    }

    it('rejects when base race has subraces and none is picked', () => {
      const r = validateWizardState(dwarvenWizard(null), optsWithSubrace);
      expect(r.errors).toContain('subrace-required');
    });

    it('accepts a valid subrace pick', () => {
      const r = validateWizardState(dwarvenWizard('hill-dwarf'), optsWithSubrace);
      expect(r.errors).not.toContain('subrace-required');
      expect(r.errors).not.toContain('subrace-unknown');
    });

    it('rejects an unknown subrace slug for the base race', () => {
      const r = validateWizardState(dwarvenWizard('drow'), optsWithSubrace);
      expect(r.errors).toContain('subrace-unknown');
    });

    it('rejects a subrace pick when the base race has no subraces', () => {
      const w = emptyWizardState();
      w.raceSlug = 'half-elf';
      w.subraceSlug = 'hill-dwarf';   // nonsense
      w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'X';
      const r = validateWizardState(w, optsWithSubrace);
      expect(r.errors).toContain('subrace-not-applicable');
    });

    it('does not enforce subrace selection when no subraceByBase map is given', () => {
      const w = dwarvenWizard(null);
      const r = validateWizardState(w, completeOptions);
      // raceSlug 'dwarf' is not in completeOptions.raceSlugs (has 'half-elf', 'human') — but that's a different error
      expect(r.errors).not.toContain('subrace-required');
    });
  });
});
