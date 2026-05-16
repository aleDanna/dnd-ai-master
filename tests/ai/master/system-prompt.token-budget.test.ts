import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

/**
 * Rough token count via chars/4 heuristic. Real tokenization varies ±15%
 * for Italian/English mix. We assert generous ceilings to catch
 * regressions (a single block doubling in size) without flaking on
 * minor edits.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function bakedInput(overrides: Partial<Parameters<typeof buildMasterSystemPrompt>[0]> = {}) {
  // When staticBlocksAlreadyBaked=true the big static blocks are skipped,
  // simulating a baked-model turn. This is the configuration the budget
  // applies to (Plan D baked + Plan E.1 mode-aware).
  return {
    handbook: '',
    worldLore: '',
    srdContext: '',
    characterMonoSpace: JSON.stringify({ name: 'Test', hp: 10, ac: 14 }),
    scene: 'A dim tavern.',
    language: 'en' as const,
    manualRolls: false,
    masterGuidanceLevel: 'balanced' as const,
    showDifficultyNumbers: true,
    narrationPace: 'detailed' as const,
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    engagementProfile: [],
    party: [{ id: 'pc1', name: 'Test' }] as any,
    currentPlayerCharacterId: 'pc1',
    usesMetaTools: true,
    staticBlocksAlreadyBaked: true,
    ...overrides,
  };
}

// Targets from the Plan E.1 design (Appendix). Tolerances allow for the
// "guidance balanced" + "lang hint" + "party mode block" overhead.
const WIRE_BUDGET = {
  narrative: 2500,
  exploration: 2500,
  combat: 2500,
  'combat+spell': 3200,
} as const;

describe('Plan E.1 token budget (baked model turn, wire only)', () => {
  for (const mode of ['narrative', 'exploration', 'combat'] as const) {
    it(`mode=${mode} fits within ${WIRE_BUDGET[mode]} tokens`, () => {
      const { system } = buildMasterSystemPrompt(bakedInput({ mode }));
      const total = system.reduce((acc, b) => acc + approxTokens(b.text), 0);
      expect(total).toBeLessThanOrEqual(WIRE_BUDGET[mode]);
    });
  }

  it('mode=combat + spellcasting overlay fits within combat+spell budget', () => {
    const { system } = buildMasterSystemPrompt(
      bakedInput({ mode: 'combat', needsSpellcasting: true }),
    );
    const total = system.reduce((acc, b) => acc + approxTokens(b.text), 0);
    expect(total).toBeLessThanOrEqual(WIRE_BUDGET['combat+spell']);
  });
});
