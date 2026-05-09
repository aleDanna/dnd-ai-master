import { describe, expect, it } from 'vitest';
import {
  TONAL_FRAMES,
  ENGAGEMENT_PROFILES,
  NPC_ATTITUDES,
  TONAL_FRAME_GUIDANCE,
  isValidTonalFrame,
  isValidEngagementProfile,
  isValidNPCAttitude,
  npcBeatsComplete,
} from '@/engine/npc-tonal';

describe('npc-tonal — constants', () => {
  it('TONAL_FRAMES has all 8 frames', () => {
    expect(TONAL_FRAMES).toHaveLength(8);
    expect(TONAL_FRAMES).toContain('high_heroic');
    expect(TONAL_FRAMES).toContain('sword_sorcery');
    expect(TONAL_FRAMES).toContain('dark');
    expect(TONAL_FRAMES).toContain('mythic');
    expect(TONAL_FRAMES).toContain('cosmic_horror');
    expect(TONAL_FRAMES).toContain('swashbuckling');
    expect(TONAL_FRAMES).toContain('wuxia');
    expect(TONAL_FRAMES).toContain('steampunk');
  });

  it('ENGAGEMENT_PROFILES has all 7 profiles', () => {
    expect(ENGAGEMENT_PROFILES).toHaveLength(7);
    expect(ENGAGEMENT_PROFILES).toContain('acting');
    expect(ENGAGEMENT_PROFILES).toContain('fighting');
    expect(ENGAGEMENT_PROFILES).toContain('instigating');
    expect(ENGAGEMENT_PROFILES).toContain('optimizing');
    expect(ENGAGEMENT_PROFILES).toContain('problem_solving');
    expect(ENGAGEMENT_PROFILES).toContain('storytelling');
    expect(ENGAGEMENT_PROFILES).toContain('exploring');
  });

  it('NPC_ATTITUDES has all 3 attitudes', () => {
    expect(NPC_ATTITUDES).toHaveLength(3);
    expect(NPC_ATTITUDES).toContain('friendly');
    expect(NPC_ATTITUDES).toContain('indifferent');
    expect(NPC_ATTITUDES).toContain('hostile');
  });
});

describe('npc-tonal — TONAL_FRAME_GUIDANCE', () => {
  it('has guidance for every tonal frame', () => {
    for (const frame of TONAL_FRAMES) {
      const guidance = TONAL_FRAME_GUIDANCE[frame];
      expect(guidance).toBeTypeOf('string');
      expect(guidance.length).toBeGreaterThan(20);
    }
  });

  it('has exactly 8 entries (no extras, no missing)', () => {
    expect(Object.keys(TONAL_FRAME_GUIDANCE)).toHaveLength(8);
  });

  it('high_heroic mentions LotR-style flavor', () => {
    expect(TONAL_FRAME_GUIDANCE.high_heroic.toLowerCase()).toMatch(/heroes|kingdom|magic/);
  });

  it('cosmic_horror mentions indifferent / unknowable', () => {
    expect(TONAL_FRAME_GUIDANCE.cosmic_horror.toLowerCase()).toMatch(/indifferent|unknowable|sanity|dread/);
  });
});

describe('npc-tonal — validators', () => {
  it('isValidTonalFrame accepts all known frames', () => {
    for (const frame of TONAL_FRAMES) {
      expect(isValidTonalFrame(frame)).toBe(true);
    }
  });

  it('isValidTonalFrame rejects unknown strings', () => {
    expect(isValidTonalFrame('grimdark')).toBe(false);
    expect(isValidTonalFrame('')).toBe(false);
    expect(isValidTonalFrame('HIGH_HEROIC')).toBe(false); // case-sensitive
    expect(isValidTonalFrame('high-heroic')).toBe(false); // hyphen variant
  });

  it('isValidEngagementProfile accepts all profiles', () => {
    for (const profile of ENGAGEMENT_PROFILES) {
      expect(isValidEngagementProfile(profile)).toBe(true);
    }
  });

  it('isValidEngagementProfile rejects unknown strings', () => {
    expect(isValidEngagementProfile('roleplaying')).toBe(false);
    expect(isValidEngagementProfile('')).toBe(false);
  });

  it('isValidNPCAttitude accepts all attitudes', () => {
    for (const attitude of NPC_ATTITUDES) {
      expect(isValidNPCAttitude(attitude)).toBe(true);
    }
  });

  it('isValidNPCAttitude rejects unknown strings', () => {
    expect(isValidNPCAttitude('neutral')).toBe(false);
    expect(isValidNPCAttitude('ally')).toBe(false);
    expect(isValidNPCAttitude('')).toBe(false);
  });
});

describe('npc-tonal — npcBeatsComplete', () => {
  it('returns true when all 4 fields are populated', () => {
    expect(
      npcBeatsComplete({
        want: 'his daughter back',
        fear: 'the new lord',
        quirk: 'cracks knuckles',
        attitude: 'friendly',
      }),
    ).toBe(true);
  });

  it('returns false when any field is missing', () => {
    expect(
      npcBeatsComplete({ want: 'gold', fear: 'death', quirk: 'limps' }),
    ).toBe(false);
    expect(
      npcBeatsComplete({ want: 'gold', fear: 'death', attitude: 'hostile' }),
    ).toBe(false);
    expect(
      npcBeatsComplete({ fear: 'death', quirk: 'limps', attitude: 'hostile' }),
    ).toBe(false);
    expect(
      npcBeatsComplete({ want: 'gold', quirk: 'limps', attitude: 'hostile' }),
    ).toBe(false);
  });

  it('returns false on empty object', () => {
    expect(npcBeatsComplete({})).toBe(false);
  });

  it('treats empty strings as incomplete', () => {
    expect(
      npcBeatsComplete({
        want: '',
        fear: 'death',
        quirk: 'limps',
        attitude: 'friendly',
      }),
    ).toBe(false);
  });
});
