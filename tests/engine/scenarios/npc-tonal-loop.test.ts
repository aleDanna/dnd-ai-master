import { describe, expect, it } from 'vitest';
import {
  TOOL_HANDLERS,
  handleSetTonalFrame,
  handleSetEngagementProfile,
  handleUpdateNPCBeats,
} from '@/engine/tools/handlers';
import type {
  Character,
  EngagementProfile,
  EngineState,
  Mutation,
  NPCAttitude,
  NPCBeats,
  TonalFrame,
} from '@/engine/types';

// ─── In-memory applicator scoped to the Phase 7 mutations ────────────────
// Mirrors the relevant cases from src/sessions/applicator.ts. We only handle
// the 3 new ops (set_tonal_frame, set_engagement_profile, update_npc_beats)
// plus the basic state shape. The codex itself is held in a side-table so
// the scenarios can assert NPC beat persistence end-to-end.

interface FakeNpcRow {
  slug: string;
  name: string;
  want?: string;
  fear?: string;
  quirk?: string;
  attitude?: NPCAttitude;
}

interface ScenarioState extends EngineState {
  /** Side table — mirrors the codex_entities row(s) for kind='npc'. */
  codexNpcs: Record<string, FakeNpcRow>;
}

function applyMutation(state: ScenarioState, m: Mutation): ScenarioState {
  const next: ScenarioState = {
    ...state,
    runtime: { ...state.runtime },
    characters: state.characters.map((c) => ({ ...c })),
    combatActors: state.combatActors.map((a) => ({ ...a })),
    codexNpcs: { ...state.codexNpcs },
    tonalFrame: state.tonalFrame,
    engagementProfile: state.engagementProfile ? [...state.engagementProfile] : undefined,
  };
  switch (m.op) {
    case 'set_tonal_frame': {
      next.tonalFrame = m.frame;
      break;
    }
    case 'set_engagement_profile': {
      next.engagementProfile = [...m.profiles];
      break;
    }
    case 'update_npc_beats': {
      const existing = next.codexNpcs[m.npcSlug];
      // The DB applicator silently no-ops on missing slug; mirror that here.
      if (!existing) break;
      const patch: Partial<FakeNpcRow> = {};
      if (m.beats.want != null) patch.want = m.beats.want;
      if (m.beats.fear != null) patch.fear = m.beats.fear;
      if (m.beats.quirk != null) patch.quirk = m.beats.quirk;
      if (m.beats.attitude != null) patch.attitude = m.beats.attitude;
      next.codexNpcs[m.npcSlug] = { ...existing, ...patch };
      break;
    }
    default:
      break;
  }
  return next;
}

function applyAll(state: ScenarioState, mutations: Mutation[]): ScenarioState {
  return mutations.reduce(applyMutation, state);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

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

function freshState(): ScenarioState {
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
    scene: 'a quiet village square',
    codexNpcs: {
      // Pre-seed an NPC so update_npc_beats has something to patch.
      'gareth-the-blacksmith': {
        slug: 'gareth-the-blacksmith',
        name: 'Gareth the Blacksmith',
      },
    },
  };
}

// ─── Scenario 1: Set tonal frame 'dark' ───────────────────────────────────

describe('npc tonal loop — Scenario 1: set_tonal_frame persists on session state', () => {
  it("master pins the campaign frame to 'dark' → state.tonalFrame === 'dark'", () => {
    let state = freshState();
    expect(state.tonalFrame).toBeUndefined();

    const r = TOOL_HANDLERS['set_tonal_frame']!(state, { frame: 'dark' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([{ op: 'set_tonal_frame', frame: 'dark' }]);

    state = applyAll(state, r.mutations);
    expect(state.tonalFrame).toBe<TonalFrame>('dark');

    // Switching to a different frame should overwrite — the session has at
    // most one frame at a time.
    const r2 = TOOL_HANDLERS['set_tonal_frame']!(state, { frame: 'mythic' });
    state = applyAll(state, r2.mutations);
    expect(state.tonalFrame).toBe<TonalFrame>('mythic');
  });
});

// ─── Scenario 2: Set engagement profile ['exploring', 'storytelling'] ─────

describe("npc tonal loop — Scenario 2: set_engagement_profile persists on session", () => {
  it('records detected profiles and re-call replaces the array', () => {
    let state = freshState();
    // The fixture starts with no engagement profile (undefined). The
    // applicator persists the new value as-is when the master calls the
    // tool, so we pivot to a non-empty assertion AFTER the first set call.
    expect(state.engagementProfile ?? []).toEqual([]);

    const r = TOOL_HANDLERS['set_engagement_profile']!(state, {
      profiles: ['exploring', 'storytelling'],
    });
    expect(r.ok).toBe(true);
    state = applyAll(state, r.mutations);
    expect(state.engagementProfile).toEqual<EngagementProfile[]>([
      'exploring',
      'storytelling',
    ]);

    // The master refines later — the new array replaces the old one wholesale
    // (no merging). This matches the applicator's UPDATE behavior.
    const r2 = TOOL_HANDLERS['set_engagement_profile']!(state, {
      profiles: ['exploring', 'fighting', 'optimizing'],
    });
    state = applyAll(state, r2.mutations);
    expect(state.engagementProfile).toEqual<EngagementProfile[]>([
      'exploring',
      'fighting',
      'optimizing',
    ]);

    // Empty array clears the hint.
    const r3 = TOOL_HANDLERS['set_engagement_profile']!(state, { profiles: [] });
    state = applyAll(state, r3.mutations);
    expect(state.engagementProfile).toEqual<EngagementProfile[]>([]);
  });
});

// ─── Scenario 3: update_npc_beats (full record) ───────────────────────────

describe('npc tonal loop — Scenario 3: update_npc_beats with all 4 fields', () => {
  it('persists Want/Fear/Quirk/Attitude on the codex NPC entry', () => {
    let state = freshState();
    expect(state.codexNpcs['gareth-the-blacksmith']).toEqual({
      slug: 'gareth-the-blacksmith',
      name: 'Gareth the Blacksmith',
    });

    const beats: NPCBeats = {
      want: 'his daughter back',
      fear: 'the new lord',
      quirk: 'cracks knuckles',
      attitude: 'friendly',
    };
    const r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth-the-blacksmith',
      beats,
    });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      {
        op: 'update_npc_beats',
        npcSlug: 'gareth-the-blacksmith',
        beats,
      },
    ]);

    state = applyAll(state, r.mutations);
    expect(state.codexNpcs['gareth-the-blacksmith']).toEqual({
      slug: 'gareth-the-blacksmith',
      name: 'Gareth the Blacksmith',
      want: 'his daughter back',
      fear: 'the new lord',
      quirk: 'cracks knuckles',
      attitude: 'friendly',
    });
  });
});

// ─── Scenario 4: update_npc_beats partial — preserves unspecified fields ──

describe('npc tonal loop — Scenario 4: update_npc_beats partial preserves existing values', () => {
  it("only changes the field passed; want/fear/attitude stay intact", () => {
    let state = freshState();

    // Step 1: seed all 4 fields.
    let r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth-the-blacksmith',
      beats: {
        want: 'his daughter back',
        fear: 'the new lord',
        quirk: 'cracks knuckles',
        attitude: 'friendly',
      },
    });
    state = applyAll(state, r.mutations);

    // Step 2: refine ONLY the quirk.
    r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth-the-blacksmith',
      beats: { quirk: 'hums constantly' },
    });
    state = applyAll(state, r.mutations);

    expect(state.codexNpcs['gareth-the-blacksmith']).toEqual({
      slug: 'gareth-the-blacksmith',
      name: 'Gareth the Blacksmith',
      want: 'his daughter back', // preserved
      fear: 'the new lord', // preserved
      quirk: 'hums constantly', // updated
      attitude: 'friendly', // preserved
    });

    // Step 3: shift attitude only — quirk stays at the partial-update value.
    r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth-the-blacksmith',
      beats: { attitude: 'hostile' },
    });
    state = applyAll(state, r.mutations);

    expect(state.codexNpcs['gareth-the-blacksmith']).toEqual({
      slug: 'gareth-the-blacksmith',
      name: 'Gareth the Blacksmith',
      want: 'his daughter back',
      fear: 'the new lord',
      quirk: 'hums constantly',
      attitude: 'hostile',
    });
  });
});

// ─── Scenario 5: invalid_tonal_frame error ────────────────────────────────

describe('npc tonal loop — Scenario 5: invalid_tonal_frame error', () => {
  it("set_tonal_frame with 'grimdark' returns invalid_tonal_frame", () => {
    const state = freshState();

    const r = handleSetTonalFrame({ frame: 'grimdark' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_tonal_frame');
    expect(r.mutations).toEqual([]);

    // Through the registry too
    const r2 = TOOL_HANDLERS['set_tonal_frame']!(state, { frame: 'grimdark' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('invalid_tonal_frame');
  });

  it("rejects empty string and non-string values", () => {
    expect(handleSetTonalFrame({ frame: '' as never }).error).toBe('invalid_tonal_frame');
    expect(handleSetTonalFrame({ frame: null as never }).error).toBe('invalid_tonal_frame');
    expect(handleSetTonalFrame({ frame: 42 as never }).error).toBe('invalid_tonal_frame');
  });
});

// ─── Scenario 6: invalid_engagement_profile error ────────────────────────

describe('npc tonal loop — Scenario 6: invalid_engagement_profile error', () => {
  it("an array with even one unknown profile rejects the whole call", () => {
    const state = freshState();

    const r = handleSetEngagementProfile({
      profiles: ['exploring', 'roleplaying'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_engagement_profile');
    expect(r.mutations).toEqual([]);

    // Through the registry
    const r2 = TOOL_HANDLERS['set_engagement_profile']!(state, {
      profiles: ['exploring', 'roleplaying'],
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('invalid_engagement_profile');
  });

  it('non-array input also rejects', () => {
    expect(handleSetEngagementProfile({ profiles: 'exploring' as never }).error).toBe(
      'invalid_engagement_profile',
    );
  });
});

// ─── Bonus: invalid_attitude error path ───────────────────────────────────

describe('npc tonal loop — invalid_attitude error path', () => {
  it("'neutral' is rejected (only friendly/indifferent/hostile)", () => {
    const r = handleUpdateNPCBeats({
      npcSlug: 'gareth-the-blacksmith',
      beats: { attitude: 'neutral' as never },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_attitude');
    expect(r.mutations).toEqual([]);
  });

  it("missing_npc_slug when slug is empty", () => {
    const r = handleUpdateNPCBeats({
      npcSlug: '',
      beats: { quirk: 'limps' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_npc_slug');
  });
});

// ─── Bonus: full E2E loop combining all three tools ───────────────────────

describe('npc tonal loop — E2E setup of a campaign session', () => {
  it('master sets frame, profile, then beats over multiple turns', () => {
    let state = freshState();

    // Turn 1: master picks the frame.
    let r = TOOL_HANDLERS['set_tonal_frame']!(state, { frame: 'dark' });
    state = applyAll(state, r.mutations);

    // Turn 2: master detects engagement profile.
    r = TOOL_HANDLERS['set_engagement_profile']!(state, {
      profiles: ['exploring', 'storytelling'],
    });
    state = applyAll(state, r.mutations);

    // Turn 3: master fleshes out the blacksmith with all 4 fields.
    r = TOOL_HANDLERS['update_npc_beats']!(state, {
      npcSlug: 'gareth-the-blacksmith',
      beats: {
        want: 'his daughter back',
        fear: 'the new lord',
        quirk: 'cracks knuckles',
        attitude: 'friendly',
      },
    });
    state = applyAll(state, r.mutations);

    expect(state.tonalFrame).toBe<TonalFrame>('dark');
    expect(state.engagementProfile).toEqual<EngagementProfile[]>([
      'exploring',
      'storytelling',
    ]);
    expect(state.codexNpcs['gareth-the-blacksmith']).toMatchObject({
      want: 'his daughter back',
      fear: 'the new lord',
      quirk: 'cracks knuckles',
      attitude: 'friendly',
    });
  });
});
