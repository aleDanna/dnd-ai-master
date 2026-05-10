import { describe, it, expect } from 'vitest';
import {
  TOOL_HANDLERS,
  handleGrantInspiration,
  handleSpendInspiration,
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
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 28,
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

function stateWith(char: Character): EngineState {
  return {
    characters: [char],
    combatActors: [],
    runtime: {
      [char.id]: {
        actorId: char.id,
        hpCurrent: char.hpMax,
        tempHp: 0,
        deathSaves: { successes: 0, failures: 0 },
        conditions: [],
      },
    },
    combat: null,
    scene: 'tavern',
  };
}

describe('handleGrantInspiration (PHB §18.1)', () => {
  it('grants inspiration to an uninspired PC and emits grant_inspiration mutation', () => {
    const state = stateWith({ ...fighter, inspiration: false });
    const r = handleGrantInspiration(state, { character: fighter.id });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ granted: true });
    expect(r.mutations).toEqual([
      { op: 'grant_inspiration', characterId: fighter.id },
    ]);
  });

  it('is idempotent: granting to an already-inspired PC is a no-op', () => {
    const state = stateWith({ ...fighter, inspiration: true });
    const r = handleGrantInspiration(state, { character: fighter.id });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ granted: false });
    expect(r.mutations).toEqual([]);
  });

  it('returns unknown_character error for missing character', () => {
    const state = stateWith({ ...fighter, inspiration: false });
    const r = handleGrantInspiration(state, { character: 'unknown-id' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
    expect(r.mutations).toEqual([]);
  });

  it('treats undefined inspiration the same as false (legacy rows)', () => {
    const noInsField: Character = { ...fighter };
    delete noInsField.inspiration;
    const state = stateWith(noInsField);
    const r = handleGrantInspiration(state, { character: noInsField.id });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ granted: true });
    expect(r.mutations).toEqual([
      { op: 'grant_inspiration', characterId: noInsField.id },
    ]);
  });
});

describe('handleSpendInspiration (PHB §18.1)', () => {
  it('spends inspiration when the PC has it and emits spend_inspiration mutation', () => {
    const state = stateWith({ ...fighter, inspiration: true });
    const r = handleSpendInspiration(state, { character: fighter.id });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ spent: true });
    expect(r.mutations).toEqual([
      { op: 'spend_inspiration', characterId: fighter.id },
    ]);
  });

  it("errors with no_inspiration when the PC doesn't have it", () => {
    const state = stateWith({ ...fighter, inspiration: false });
    const r = handleSpendInspiration(state, { character: fighter.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspiration');
    expect(r.mutations).toEqual([]);
  });

  it('errors with no_inspiration when inspiration is undefined', () => {
    const noInsField: Character = { ...fighter };
    delete noInsField.inspiration;
    const state = stateWith(noInsField);
    const r = handleSpendInspiration(state, { character: noInsField.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspiration');
  });

  it('returns unknown_character error for missing character', () => {
    const state = stateWith({ ...fighter, inspiration: true });
    const r = handleSpendInspiration(state, { character: 'unknown-id' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

describe('TOOL_HANDLERS registry — grant_inspiration & spend_inspiration', () => {
  it('grant_inspiration is wired into the registry', () => {
    expect(TOOL_HANDLERS['grant_inspiration']).toBeDefined();
    const state = stateWith({ ...fighter, inspiration: false });
    const r = TOOL_HANDLERS['grant_inspiration']!(state, { character: fighter.id });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'grant_inspiration', characterId: fighter.id },
    ]);
  });

  it('spend_inspiration is wired into the registry', () => {
    expect(TOOL_HANDLERS['spend_inspiration']).toBeDefined();
    const state = stateWith({ ...fighter, inspiration: true });
    const r = TOOL_HANDLERS['spend_inspiration']!(state, { character: fighter.id });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'spend_inspiration', characterId: fighter.id },
    ]);
  });

  it('grant_inspiration accepts the player_character alias', () => {
    const state = stateWith({ ...fighter, inspiration: false });
    const r = TOOL_HANDLERS['grant_inspiration']!(state, { character: 'player_character' });
    expect(r.ok).toBe(true);
    expect(r.mutations).toEqual([
      { op: 'grant_inspiration', characterId: fighter.id },
    ]);
  });

  it('spend_inspiration also resolves via `actor` alias for backward compat', () => {
    const state = stateWith({ ...fighter, inspiration: true });
    const r = TOOL_HANDLERS['spend_inspiration']!(state, { actor: fighter.id });
    expect(r.ok).toBe(true);
  });

  it('grant_inspiration without character or actor → unknown_character', () => {
    const state = stateWith({ ...fighter, inspiration: false });
    const r = TOOL_HANDLERS['grant_inspiration']!(state, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_character');
  });
});

describe('TOOL_DEFINITIONS — inspiration tools advertised', () => {
  it('grant_inspiration tool definition exists', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'grant_inspiration');
    expect(def).toBeDefined();
    expect((def?.description ?? '').toLowerCase()).toContain('inspiration');
  });

  it('spend_inspiration tool definition exists', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === 'spend_inspiration');
    expect(def).toBeDefined();
    expect((def?.description ?? '').toLowerCase()).toContain('inspiration');
  });
});
