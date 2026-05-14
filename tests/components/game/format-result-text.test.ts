import { describe, it, expect } from 'vitest';
import { formatResultText } from '@/components/game/roll-request-button';
import type { RollRequest, RollResult } from '@/lib/roll-parser';

function req(label: string, formula: string, kind: RollRequest['kind'] = 'check'): RollRequest {
  return { formula, label, kind, index: 0, groupMode: 'or' };
}

function res(total: number, rolls: number[], modifier = 0): RollResult {
  return { formula: '1d20', total, rolls, modifier };
}

describe('formatResultText', () => {
  it('omits the redundant parenthetical for a bare single die', () => {
    // The historical "🎲 I rolled **20** for Intuito (20)." was confusing the
    // master LLM into narrating a different number — the "(20)" added nothing
    // beyond the bolded total. Drop it.
    const text = formatResultText(req('Intuito', '1d20'), res(20, [20], 0));
    expect(text).toBe('🎲 I rolled **20** for Intuito.');
    expect(text).not.toContain('(');
  });

  it('keeps the breakdown when there is a non-zero positive modifier', () => {
    const text = formatResultText(req('Persuasione (CD 14)', '1d20+5'), res(18, [13], 5));
    expect(text).toBe('🎲 I rolled **18** for Persuasione (CD 14) (13+5).');
  });

  it('keeps the breakdown when there is a non-zero negative modifier', () => {
    const text = formatResultText(req('Stealth', '1d20-1'), res(9, [10], -1));
    expect(text).toBe('🎲 I rolled **9** for Stealth (10-1).');
  });

  it('keeps the breakdown when multiple dice are rolled (e.g. damage)', () => {
    const text = formatResultText(req('damage', '2d6'), res(7, [4, 3], 0));
    expect(text).toBe('🎲 I rolled **7** for damage (4+3).');
  });

  it('keeps the breakdown for multi-dice with a modifier', () => {
    const text = formatResultText(req('damage', '2d6+3'), res(10, [4, 3], 3));
    expect(text).toBe('🎲 I rolled **10** for damage (4+3+3).');
  });

  it('always bolds the total so the master can locate it unambiguously', () => {
    const text = formatResultText(req('Forza', '1d20'), res(15, [15], 0));
    expect(text).toMatch(/\*\*15\*\*/);
  });
});
