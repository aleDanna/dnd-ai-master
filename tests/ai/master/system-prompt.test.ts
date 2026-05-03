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

describe('buildMasterSystemPrompt — scene illustrations', () => {
  it('omits the scene-image section when imageGenerationEnabled is false', () => {
    const out = buildMasterSystemPrompt({ ...baseInput, imageGenerationEnabled: false });
    const text = out.system.map((b) => b.text).join('\n');
    expect(text).not.toMatch(/generate_scene_image/);
  });

  it('includes a generate_scene_image section when enabled', () => {
    const out = buildMasterSystemPrompt({ ...baseInput, imageGenerationEnabled: true });
    const text = out.system.map((b) => b.text).join('\n');
    expect(text).toMatch(/generate_scene_image/);
    expect(text).toMatch(/visualPrompt`?\s*must be in English/i);
    // The rule should be encouraging, not deterring — gpt-5 was too
    // conservative with the original "Use it sparingly" / "every 3-5 turns"
    // wording and rarely called the tool. The prompt now leans toward
    // generation: "use it actively", "lean toward generating".
    expect(text).toMatch(/use it actively/i);
    expect(text).toMatch(/lean toward generating/i);
  });
});
