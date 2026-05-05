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
  handbook: '# DM Handbook\n(stub)',
  worldLore: '# World Lore\n(stub)',
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
  it('does NOT mention generate_scene_image: scene image generation is now a manual user action via the chat UI, not a master tool', () => {
    const out = buildMasterSystemPrompt({ ...baseInput });
    const text = out.system.map((b) => b.text).join('\n');
    expect(text).not.toMatch(/generate_scene_image/);
  });
});

describe('buildMasterSystemPrompt — rewards mandate', () => {
  it('always includes the MASTER_REWARDS_MANDATE block, regardless of other settings', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const text = out.system.map((b) => b.text).join('\n\n');
    // Anchor phrases from the mandate.
    expect(text).toMatch(/Rewards at the end of every dungeon/i);
    expect(text).toMatch(/CRITICAL — do not skip/i);
    expect(text).toMatch(/MUST narrate a tangible reward/i);
    expect(text).toMatch(/dungeon-end checklist/i);
    // The mandate must be a CACHED block, since it ships on every turn.
    const mandateBlock = out.system.find((b) => b.text.includes('Rewards at the end of every dungeon'));
    expect(mandateBlock?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('positions the rewards mandate before the SRD context (priority signal)', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const texts = out.system.map((b) => b.text);
    const mandateIdx = texts.findIndex((t) => t.includes('Rewards at the end of every dungeon'));
    const srdIdx = texts.findIndex((t) => t.includes(baseInput.srdContext));
    expect(mandateIdx).toBeGreaterThanOrEqual(0);
    expect(srdIdx).toBeGreaterThanOrEqual(0);
    expect(mandateIdx).toBeLessThan(srdIdx);
  });
});

describe('buildMasterSystemPrompt — world & lore block', () => {
  it('embeds the worldLore string as a cached block', () => {
    const worldLore = '# World Lore (TEST MARKER 7be4)\n\n## 1. Cosmology\nstub';
    const out = buildMasterSystemPrompt({ ...baseInput, worldLore });
    const texts = out.system.map((b) => b.text);
    const idx = texts.findIndex((t) => t.includes('TEST MARKER 7be4'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.system[idx]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('buildMasterSystemPrompt — DM craft handbook block', () => {
  it('embeds the handbook string as one of the cached blocks', () => {
    const handbook = '# DM Craft Handbook (TEST MARKER 39c8)\n\n## 1.1 example\nhello';
    const out = buildMasterSystemPrompt({ ...baseInput, handbook });
    const texts = out.system.map((b) => b.text);
    const blockIdx = texts.findIndex((t) => t.includes('TEST MARKER 39c8'));
    expect(blockIdx).toBeGreaterThanOrEqual(0);
    // Handbook block must be cached so the prompt-cache hit covers it.
    expect(out.system[blockIdx]!.cache_control).toEqual({ type: 'ephemeral' });
    // Order: ROLE → TOOLS → HANDBOOK → SRD. The handbook should sit between
    // the tool contract and the SRD reference.
    const srdIdx = texts.findIndex((t) => t.includes(baseInput.srdContext));
    expect(blockIdx).toBeLessThan(srdIdx);
  });
});

describe('buildMasterSystemPrompt — out-of-character convention', () => {
  it('explains the "!" prefix and forbids state mutations on OOC turns', () => {
    const out = buildMasterSystemPrompt({ ...baseInput });
    const text = out.system.map((b) => b.text).join('\n');
    expect(text).toMatch(/Out-of-character/i);
    expect(text).toMatch(/begins with "!"/);
    expect(text).toMatch(/Do NOT advance the in-game scene/i);
    expect(text).toMatch(/Do NOT call any state-mutating tool/i);
    // Must explicitly forbid rolling tools so the master doesn't call
    // roll_d20 in response to a meta-game question.
    expect(text).toMatch(/Do NOT call.*roll_d20/i);
  });
});
