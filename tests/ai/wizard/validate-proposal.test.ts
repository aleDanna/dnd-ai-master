import { describe, it, expect } from 'vitest';
import { validateProposal } from '@/ai/wizard/validate-proposal';

const opts = {
  raceSlugs: ['human', 'half-elf'],
  classSlugs: ['fighter', 'wizard'],
  backgroundSlugs: ['soldier', 'sage'],
};

describe('validateProposal', () => {
  it('accepts a valid race string', () => {
    expect(validateProposal({ step: 'race', value: 'half-elf', reasoning: 'fits' }, opts).ok).toBe(true);
  });
  it('rejects unknown race', () => {
    const r = validateProposal({ step: 'race', value: 'dragonborn-purple', reasoning: '' }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('race');
  });
  it('rejects abilities outside [3,18]', () => {
    expect(
      validateProposal({ step: 'abilities', value: { STR: 25, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 }, reasoning: '' }, opts).ok,
    ).toBe(false);
  });
  it('accepts equipment kit', () => {
    expect(validateProposal({ step: 'equipment', value: 'kit', reasoning: '' }, opts).ok).toBe(true);
  });
  it('rejects skills with non-skill string', () => {
    expect(validateProposal({ step: 'skills', value: ['Athletics', 'NotARealSkill'], reasoning: '' }, opts).ok).toBe(false);
  });
});
