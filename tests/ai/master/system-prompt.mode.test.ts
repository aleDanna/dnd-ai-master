import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

function baseInput(overrides: Partial<Parameters<typeof buildMasterSystemPrompt>[0]> = {}) {
  return {
    handbook: 'HANDBOOK_CONTENT',
    worldLore: 'LORE_CONTENT',
    srdContext: 'SRD_CONTENT',
    characterMonoSpace: '{}',
    scene: '',
    language: 'en' as const,
    manualRolls: false,
    masterGuidanceLevel: 'balanced' as const,
    showDifficultyNumbers: true,
    narrationPace: 'detailed' as const,
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    engagementProfile: [],
    party: [],
    currentPlayerCharacterId: null,
    usesMetaTools: false,
    staticBlocksAlreadyBaked: false,
    ...overrides,
  };
}

describe('buildMasterSystemPrompt — mode injection', () => {
  it('injects MODE_COMBAT_BLOCK when mode="combat"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'combat' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: COMBAT/);
    expect(text).not.toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: EXPLORATION/);
  });

  it('injects MODE_NARRATIVE_BLOCK when mode="narrative"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'narrative' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: COMBAT/);
  });

  it('injects MODE_EXPLORATION_BLOCK when mode="exploration"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'exploration' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: EXPLORATION/);
    expect(text).not.toMatch(/MODE: COMBAT/);
  });

  it('includes spellcasting overlay only when needsSpellcasting=true', () => {
    const withOverlay = buildMasterSystemPrompt(baseInput({ mode: 'combat', needsSpellcasting: true }));
    const withoutOverlay = buildMasterSystemPrompt(baseInput({ mode: 'combat', needsSpellcasting: false }));
    const withText = withOverlay.system.map((b) => b.text).join('\n');
    const withoutText = withoutOverlay.system.map((b) => b.text).join('\n');
    expect(withText).toMatch(/OVERLAY: SPELLCASTING/);
    expect(withoutText).not.toMatch(/OVERLAY: SPELLCASTING/);
  });

  it('overlay absent when needsSpellcasting is undefined (back-compat)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'combat' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).not.toMatch(/OVERLAY: SPELLCASTING/);
  });

  it('mode block + overlay carry ephemeral cache_control', () => {
    const { system } = buildMasterSystemPrompt(
      baseInput({ mode: 'combat', needsSpellcasting: true }),
    );
    const modeBlock = system.find((b) => b.text.includes('MODE: COMBAT'));
    const overlayBlock = system.find((b) => b.text.includes('OVERLAY: SPELLCASTING'));
    expect(modeBlock?.cache_control).toEqual({ type: 'ephemeral' });
    expect(overlayBlock?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('mode block appears AFTER static blocks and BEFORE active character / scene (cache stability)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'combat' }));
    const texts = system.map((b) => b.text);
    const baseIdx = texts.findIndex((t) => t.includes('HANDBOOK_CONTENT'));
    const modeIdx = texts.findIndex((t) => t.includes('MODE: COMBAT'));
    const activeCharIdx = texts.findIndex((t) => t.includes('ACTIVE PLAYER CHARACTER'));
    const sceneIdx = texts.findIndex((t) => t.includes('CURRENT SCENE'));
    expect(baseIdx).toBeLessThan(modeIdx);
    expect(modeIdx).toBeLessThan(activeCharIdx);
    expect(activeCharIdx).toBeLessThan(sceneIdx);
  });

  it('NO mode block injected when mode is undefined (backward compat with Plan B+C+D)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({}));
    const text = system.map((b) => b.text).join('\n');
    expect(text).not.toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: COMBAT/);
    expect(text).not.toMatch(/MODE: EXPLORATION/);
  });
});
