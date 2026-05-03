import { describe, it, expect } from 'vitest';
import {
  buildMasterSystemPrompt,
  MASTER_GUIDANCE_FREE,
  MASTER_GUIDANCE_BALANCED,
  MASTER_GUIDANCE_STRUCTURED,
  MASTER_HIDE_DIFFICULTY_RULE,
} from '@/ai/master/system-prompt';

const baseInput = {
  srdContext: '## SRD\n(stub)',
  characterMonoSpace: '{}',
  scene: '(no scene)',
  language: null,
};

describe('buildMasterSystemPrompt — master guidance level', () => {
  it("appends the 'free' guidance block when level=free", () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, masterGuidanceLevel: 'free' });
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_GUIDANCE_FREE);
    expect(texts).not.toContain(MASTER_GUIDANCE_BALANCED);
    expect(texts).not.toContain(MASTER_GUIDANCE_STRUCTURED);
  });

  it("appends the 'balanced' guidance block when level=balanced", () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, masterGuidanceLevel: 'balanced' });
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_GUIDANCE_BALANCED);
    expect(texts).not.toContain(MASTER_GUIDANCE_FREE);
    expect(texts).not.toContain(MASTER_GUIDANCE_STRUCTURED);
  });

  it("appends the 'structured' guidance block when level=structured", () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, masterGuidanceLevel: 'structured' });
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_GUIDANCE_STRUCTURED);
    expect(texts).not.toContain(MASTER_GUIDANCE_FREE);
    expect(texts).not.toContain(MASTER_GUIDANCE_BALANCED);
  });

  it("falls back to 'balanced' when level is unset", () => {
    const { system } = buildMasterSystemPrompt(baseInput);
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_GUIDANCE_BALANCED);
  });

  it('appends the hide-difficulty rule when showDifficultyNumbers=false', () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, showDifficultyNumbers: false });
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_HIDE_DIFFICULTY_RULE);
  });

  it('does NOT append the hide-difficulty rule when showDifficultyNumbers=true', () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, showDifficultyNumbers: true });
    const texts = system.map((b) => b.text);
    expect(texts).not.toContain(MASTER_HIDE_DIFFICULTY_RULE);
  });

  it('does NOT append the hide-difficulty rule when showDifficultyNumbers is unset (default = visible)', () => {
    const { system } = buildMasterSystemPrompt(baseInput);
    const texts = system.map((b) => b.text);
    expect(texts).not.toContain(MASTER_HIDE_DIFFICULTY_RULE);
  });

  it('places the guidance block AFTER the cached static prefix (so prompt cache survives)', () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, masterGuidanceLevel: 'free' });
    const guidanceIdx = system.findIndex((b) => b.text === MASTER_GUIDANCE_FREE);
    // The first three blocks are cached static prefix (role + tool contract + SRD).
    expect(guidanceIdx).toBeGreaterThanOrEqual(3);
    // The cached blocks must precede it (they have cache_control set).
    for (let i = 0; i < 3; i++) {
      expect(system[i]!.cache_control).toEqual({ type: 'ephemeral' });
    }
    // The guidance block itself is per-user, NOT cached.
    expect(system[guidanceIdx]!.cache_control).toBeUndefined();
  });
});
