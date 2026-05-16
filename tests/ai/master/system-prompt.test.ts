import { describe, it, expect } from 'vitest';
import {
  buildMasterSystemPrompt,
  MASTER_GUIDANCE_FREE,
  MASTER_GUIDANCE_BALANCED,
  MASTER_GUIDANCE_STRUCTURED,
  MASTER_HIDE_DIFFICULTY_RULE,
  MASTER_BRISK_PACING_RULE,
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
    // The guidance block is session-stable (set at campaign creation, rarely
    // changed), so it ALSO carries cache_control: ephemeral. It sits AFTER
    // the cross-campaign static prefix but BEFORE any per-turn dynamic block.
    expect(system[guidanceIdx]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('appends the brisk-pacing rule when narrationPace=brisk', () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, narrationPace: 'brisk' });
    const texts = system.map((b) => b.text);
    expect(texts).toContain(MASTER_BRISK_PACING_RULE);
  });

  it('does NOT append the brisk-pacing rule when narrationPace=detailed', () => {
    const { system } = buildMasterSystemPrompt({ ...baseInput, narrationPace: 'detailed' });
    const texts = system.map((b) => b.text);
    expect(texts).not.toContain(MASTER_BRISK_PACING_RULE);
  });

  it('does NOT append the brisk-pacing rule when narrationPace is unset (default = detailed)', () => {
    const { system } = buildMasterSystemPrompt(baseInput);
    const texts = system.map((b) => b.text);
    expect(texts).not.toContain(MASTER_BRISK_PACING_RULE);
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

describe('buildMasterSystemPrompt — NPC Three-Beat static section', () => {
  it('includes the NPC Three-Beat block in the tool contract', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const text = out.system.map((b) => b.text).join('\n\n');
    expect(text).toMatch(/NPC Three-Beat \(Master Handbook §11.1\)/);
    expect(text).toMatch(/\bWant\b/);
    expect(text).toMatch(/\bFear\b/);
    expect(text).toMatch(/\bQuirk\b/);
    expect(text).toMatch(/\bAttitude\b/);
    expect(text).toMatch(/update_npc_beats/);
  });

  it('explains all 8 tonal frames somewhere in the static prompt', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const text = out.system.map((b) => b.text).join('\n\n');
    for (const frame of [
      'high_heroic',
      'sword_sorcery',
      'dark',
      'mythic',
      'cosmic_horror',
      'swashbuckling',
      'wuxia',
      'steampunk',
    ]) {
      expect(text).toContain(frame);
    }
  });

  it('mentions all 7 engagement profiles', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const text = out.system.map((b) => b.text).join('\n\n');
    for (const profile of [
      'acting',
      'fighting',
      'instigating',
      'optimizing',
      'problem_solving',
      'storytelling',
      'exploring',
    ]) {
      expect(text).toContain(profile);
    }
  });

  it('has Italian guidance for the new tools', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const text = out.system.map((b) => b.text).join('\n\n');
    expect(text).toMatch(/Italiano:/);
    expect(text).toMatch(/update_npc_beats/);
    expect(text).toMatch(/tonal frame/i);
  });
});

describe('buildMasterSystemPrompt — dynamic Campaign Tonal Frame block', () => {
  it('does NOT inject the block when tonalFrame is unset', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const texts = out.system.map((b) => b.text);
    expect(texts.some((t) => t.startsWith('## Campaign Tonal Frame'))).toBe(false);
  });

  it('injects the block with frame name + guidance when tonalFrame is set', () => {
    const out = buildMasterSystemPrompt({ ...baseInput, tonalFrame: 'dark' });
    const texts = out.system.map((b) => b.text);
    const block = texts.find((t) => t.startsWith('## Campaign Tonal Frame'));
    expect(block).toBeDefined();
    expect(block).toContain('`dark`');
    // Guidance text from TONAL_FRAME_GUIDANCE.dark
    expect(block).toMatch(/dying|delaying|Berserk|Bloodborne|body horror/i);
    expect(block).toMatch(/lens/);
  });

  it('uses the correct guidance for each frame', () => {
    const cosmic = buildMasterSystemPrompt({ ...baseInput, tonalFrame: 'cosmic_horror' });
    const cosmicBlock = cosmic.system
      .map((b) => b.text)
      .find((t) => t.startsWith('## Campaign Tonal Frame'));
    expect(cosmicBlock).toMatch(/Lovecraft|sanity|dread|unknowable|indifferent/i);

    const heroic = buildMasterSystemPrompt({ ...baseInput, tonalFrame: 'high_heroic' });
    const heroicBlock = heroic.system
      .map((b) => b.text)
      .find((t) => t.startsWith('## Campaign Tonal Frame'));
    expect(heroicBlock).toMatch(/heroes|kingdom|magic|LotR|triumph|noble/i);
  });

  it('places the tonal-frame block AFTER the cross-campaign static prefix but still cached for session reuse', () => {
    const out = buildMasterSystemPrompt({ ...baseInput, tonalFrame: 'mythic' });
    const blockIdx = out.system.findIndex((b) =>
      b.text.startsWith('## Campaign Tonal Frame'),
    );
    expect(blockIdx).toBeGreaterThanOrEqual(3);
    // The tonal frame is session-stable (set at campaign creation and rarely
    // mutated), so it carries cache_control: ephemeral. It sits in the
    // "session-stable" group AFTER the cross-campaign static prefix but
    // BEFORE any per-turn dynamic block (party / scene / character).
    expect(out.system[blockIdx]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('buildMasterSystemPrompt — dynamic Player Engagement Hint block', () => {
  it('does NOT inject the block when engagementProfile is unset', () => {
    const out = buildMasterSystemPrompt(baseInput);
    const texts = out.system.map((b) => b.text);
    expect(texts.some((t) => t.startsWith('## Player Engagement Hint'))).toBe(false);
  });

  it('does NOT inject the block when engagementProfile is empty array', () => {
    const out = buildMasterSystemPrompt({ ...baseInput, engagementProfile: [] });
    const texts = out.system.map((b) => b.text);
    expect(texts.some((t) => t.startsWith('## Player Engagement Hint'))).toBe(false);
  });

  it('injects the block with detected profiles when non-empty', () => {
    const out = buildMasterSystemPrompt({
      ...baseInput,
      engagementProfile: ['exploring', 'storytelling'],
    });
    const texts = out.system.map((b) => b.text);
    const block = texts.find((t) => t.startsWith('## Player Engagement Hint'));
    expect(block).toBeDefined();
    expect(block).toContain('exploring');
    expect(block).toContain('storytelling');
    expect(block).toMatch(/Lean into scenes/i);
  });

  it('injects block alongside the tonal frame block when both are set', () => {
    const out = buildMasterSystemPrompt({
      ...baseInput,
      tonalFrame: 'sword_sorcery',
      engagementProfile: ['fighting'],
    });
    const texts = out.system.map((b) => b.text);
    expect(texts.some((t) => t.startsWith('## Campaign Tonal Frame'))).toBe(true);
    expect(texts.some((t) => t.startsWith('## Player Engagement Hint'))).toBe(true);
  });
});
