import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleSetTonalFrame,
  handleSetEngagementProfile,
  handleUpdateNPCBeats,
} from '@/engine/tools/handlers';
import { TOOL_DEFINITIONS } from '@/engine/tools';
import type { Character, EngineState } from '@/engine/types';

const fighter: Character = {
  id: 'pc1',
  name: 'Tharion',
  level: 3,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 14, DEX: 12, CON: 12, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 24,
  ac: 16,
  speed: 30,
  proficiencies: {
    saves: ['STR', 'CON'],
    skills: ['Athletics'],
    expertise: [],
    weapons: ['Simple', 'Martial'],
    armor: ['Light', 'Medium', 'Heavy', 'Shield'],
    tools: [],
    languages: ['Common'],
  },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 3,
  hitDieSize: 10,
};

function freshState(): EngineState {
  return {
    characters: [fighter],
    combatActors: [],
    runtime: {
      [fighter.id]: {
        actorId: fighter.id,
        hpCurrent: fighter.hpMax,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
    },
    combat: null,
    scene: 'tavern',
  };
}

// ─── handleSetTonalFrame ──────────────────────────────────────────────────

describe('handleSetTonalFrame', () => {
  it('accepts each of the 8 valid frames', () => {
    const frames = [
      'high_heroic',
      'sword_sorcery',
      'dark',
      'mythic',
      'cosmic_horror',
      'swashbuckling',
      'wuxia',
      'steampunk',
    ] as const;
    for (const frame of frames) {
      const r = handleSetTonalFrame({ frame });
      expect(r.ok).toBe(true);
      expect(r.mutations).toEqual([{ op: 'set_tonal_frame', frame }]);
    }
  });

  it('rejects unknown frame with invalid_tonal_frame', () => {
    const r = handleSetTonalFrame({ frame: 'grimdark' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_tonal_frame');
    expect(r.mutations).toEqual([]);
  });

  it('rejects empty string', () => {
    const r = handleSetTonalFrame({ frame: '' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_tonal_frame');
  });

  it('rejects non-string value', () => {
    const r = handleSetTonalFrame({ frame: 123 as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_tonal_frame');
  });

  it('exposed via TOOL_HANDLERS registry', () => {
    const state = freshState();
    const r = TOOL_HANDLERS['set_tonal_frame']!(state, { frame: 'dark' });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_tonal_frame', frame: 'dark' });
  });
});

// ─── handleSetEngagementProfile ───────────────────────────────────────────

describe('handleSetEngagementProfile', () => {
  it('accepts all 7 profiles in a single array', () => {
    const profiles = [
      'acting',
      'fighting',
      'instigating',
      'optimizing',
      'problem_solving',
      'storytelling',
      'exploring',
    ];
    const r = handleSetEngagementProfile({ profiles });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_engagement_profile', profiles });
  });

  it('accepts a partial subset', () => {
    const r = handleSetEngagementProfile({ profiles: ['exploring', 'storytelling'] });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({
      op: 'set_engagement_profile',
      profiles: ['exploring', 'storytelling'],
    });
  });

  it('accepts empty array (clears the hint)', () => {
    const r = handleSetEngagementProfile({ profiles: [] });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({ op: 'set_engagement_profile', profiles: [] });
  });

  it('rejects array with even one unknown profile', () => {
    const r = handleSetEngagementProfile({
      profiles: ['exploring', 'roleplaying'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_engagement_profile');
    expect(r.mutations).toEqual([]);
  });

  it('rejects non-array input', () => {
    const r = handleSetEngagementProfile({ profiles: 'exploring' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_engagement_profile');
  });

  it('rejects array of non-strings', () => {
    const r = handleSetEngagementProfile({ profiles: [123 as never] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_engagement_profile');
  });

  it('exposed via TOOL_HANDLERS registry', () => {
    const state = freshState();
    const r = TOOL_HANDLERS['set_engagement_profile']!(state, {
      profiles: ['exploring', 'storytelling'],
    });
    expect(r.ok).toBe(true);
  });
});

// ─── handleUpdateNPCBeats ─────────────────────────────────────────────────

describe('handleUpdateNPCBeats', () => {
  it('accepts a full beat record (all 4 fields)', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth-the-blacksmith',
      beats: {
        want: 'his daughter back',
        fear: 'the new lord',
        quirk: 'cracks knuckles',
        attitude: 'friendly',
      },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'update_npc_beats',
        npcSlug: 'gareth-the-blacksmith',
        beats: {
          want: 'his daughter back',
          fear: 'the new lord',
          quirk: 'cracks knuckles',
          attitude: 'friendly',
        },
      },
    ]);
  });

  it('accepts a partial beat record (only quirk)', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth-the-blacksmith',
      beats: { quirk: 'hums constantly' },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({
      op: 'update_npc_beats',
      npcSlug: 'gareth-the-blacksmith',
      beats: { quirk: 'hums constantly' },
    });
  });

  it('accepts a partial beat record (only attitude)', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'merlin',
      beats: { attitude: 'hostile' },
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({
      op: 'update_npc_beats',
      npcSlug: 'merlin',
      beats: { attitude: 'hostile' },
    });
  });

  it('rejects empty npcSlug', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: '',
      beats: { quirk: 'limps' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_npc_slug');
  });

  it('rejects whitespace-only npcSlug', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: '   ',
      beats: { quirk: 'limps' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_npc_slug');
  });

  it('rejects invalid attitude', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth',
      beats: { attitude: 'neutral' as never },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_attitude');
  });

  it('rejects ally as attitude (not a valid value)', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth',
      beats: { attitude: 'ally' as never },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_attitude');
  });

  it('drops non-string fields silently', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth',
      beats: {
        want: 'gold' as string,
        fear: 42 as never,
        quirk: 'limps',
      },
    });
    // The handler keeps only string fields; fear was dropped.
    expect(r.ok).toBe(true);
    const mutation = r.mutations[0];
    expect(mutation).toEqual({
      op: 'update_npc_beats',
      npcSlug: 'gareth',
      beats: { want: 'gold', quirk: 'limps' },
    });
  });

  it('handles missing beats object (treated as empty)', () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth',
      beats: {} as never,
    });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toEqual({
      op: 'update_npc_beats',
      npcSlug: 'gareth',
      beats: {},
    });
  });

  it('exposed via TOOL_HANDLERS registry', () => {
    const state = freshState();
    const r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth',
      beats: { want: 'his daughter', attitude: 'friendly' },
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Tool definitions ─────────────────────────────────────────────────────

describe('tool definitions — Phase 7 additions', () => {
  it('TOOL_DEFINITIONS contains set_tonal_frame', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_tonal_frame');
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/tonal frame|World Lore/i);
  });

  it('TOOL_DEFINITIONS contains set_engagement_profile', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_engagement_profile');
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/engagement profile|Master Handbook/i);
  });

  it('TOOL_DEFINITIONS contains update_npc_beats', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'update_npc_beats');
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/Want.*Fear.*Quirk|Three.*[Bb]eat/);
  });

  it('set_tonal_frame schema enumerates all 8 frames', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_tonal_frame');
    const schema = tool?.input_schema as { properties: { frame: { enum: string[] } } };
    expect(schema.properties.frame.enum).toHaveLength(8);
  });

  it('set_engagement_profile schema enumerates all 7 profiles', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_engagement_profile');
    const schema = tool?.input_schema as {
      properties: { profiles: { items: { enum: string[] } } };
    };
    expect(schema.properties.profiles.items.enum).toHaveLength(7);
  });

  it('update_npc_beats schema enumerates 3 attitudes', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'update_npc_beats');
    const schema = tool?.input_schema as {
      properties: { beats: { properties: { attitude: { enum: string[] } } } };
    };
    expect(schema.properties.beats.properties.attitude.enum).toHaveLength(3);
  });
});
