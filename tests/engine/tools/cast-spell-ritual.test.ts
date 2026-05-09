import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TOOL_HANDLERS_DB } from '@/engine';
import type { EngineState, Character, CombatActor } from '@/engine';

// Mock lookupSpellMeta so we can assert different ritual/concentration values
// per test without seeding the SRD DB. Each test sets the resolved value via
// vi.mocked(...).mockResolvedValueOnce(...).
vi.mock('@/srd/lookup', async () => {
  const actual = await vi.importActual<typeof import('@/srd/lookup')>('@/srd/lookup');
  return {
    ...actual,
    lookupSpellMeta: vi.fn(),
  };
});

import { lookupSpellMeta } from '@/srd/lookup';

const DB_CTX = { sessionId: 'test-session' };

const wizard: Character = {
  id: 'pc2',
  name: 'Lyra',
  level: 5,
  xp: 0,
  classSlug: 'wizard',
  raceSlug: 'high-elf',
  backgroundSlug: 'sage',
  abilities: { STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 },
  proficiencyBonus: 3,
  hpMax: 28,
  ac: 12,
  speed: 30,
  proficiencies: {
    saves: ['INT', 'WIS'],
    skills: ['Arcana'],
    expertise: [],
    weapons: [],
    armor: [],
    tools: [],
    languages: ['Common'],
  },
  spellcasting: {
    ability: 'INT',
    spellSaveDC: 15,
    spellAttackBonus: 7,
    slotsMax: { 1: 4, 2: 3, 3: 2 },
    spellsKnown: ['detect-magic', 'fire-bolt', 'magic-missile'],
    spellsPrepared: [],
  },
  features: [],
  inventory: [],
  hitDiceMax: 5,
  hitDieSize: 6,
};

const goblin: CombatActor = {
  id: 'm1',
  kind: 'monster',
  name: 'Goblin',
  hpMax: 7,
  ac: 15,
  abilities: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
  proficiencyBonus: 2,
  initiativeBonus: 2,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
};

const wizardState: EngineState = {
  characters: [wizard],
  combatActors: [goblin],
  runtime: {
    pc2: {
      actorId: 'pc2',
      hpCurrent: 28,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
      hitDiceRemaining: 5,
      spellSlotsUsed: {},
      resourcesUsed: {},
    },
    m1: {
      actorId: 'm1',
      hpCurrent: 7,
      tempHp: 0,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    },
  },
  combat: null,
  scene: 'wizard tower',
};

describe('tool cast_spell — asRitual', () => {
  beforeEach(() => {
    vi.mocked(lookupSpellMeta).mockReset();
  });

  it('asRitual: true on detect-magic skips slot consumption', async () => {
    // detect-magic is a ritual spell (PHB §10.69).
    vi.mocked(lookupSpellMeta).mockResolvedValueOnce({ ritual: true, concentration: false });

    const r = await TOOL_HANDLERS_DB['cast_spell']!(DB_CTX, wizardState, {
      caster: 'player_character',
      spellSlug: 'detect-magic',
      slotLevel: 1,
      asRitual: true,
    });

    expect(r.ok).toBe(true);
    // No slot consumed for ritual cast.
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(false);
    // Effects array should mention ritual.
    const effects = (r.data as { effects: string[] } | undefined)?.effects ?? [];
    expect(effects).toContain('ritual');
  });

  it('asRitual: true on fire-bolt errors out', async () => {
    // fire-bolt is a cantrip with no ritual tag.
    vi.mocked(lookupSpellMeta).mockResolvedValueOnce({ ritual: false, concentration: false });

    const r = await TOOL_HANDLERS_DB['cast_spell']!(DB_CTX, wizardState, {
      caster: 'player_character',
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      asRitual: true,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ritual/i);
  });

  it('asRitual: false on magic-missile consumes slot normally (no DB lookup)', async () => {
    const r = await TOOL_HANDLERS_DB['cast_spell']!(DB_CTX, wizardState, {
      caster: 'player_character',
      spellSlug: 'magic-missile',
      slotLevel: 1,
      targets: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }],
      asRitual: false,
    });

    expect(r.ok).toBe(true);
    expect(r.mutations.some((m) => m.op === 'use_spell_slot')).toBe(true);
    // Sanity: lookupSpellMeta should NOT have been called when asRitual is false.
    expect(vi.mocked(lookupSpellMeta)).not.toHaveBeenCalled();
  });

  it('asRitual: true but spell missing from SRD errors out', async () => {
    // lookupSpellMeta returns undefined → engine sees no ritual flag.
    vi.mocked(lookupSpellMeta).mockResolvedValueOnce(undefined);

    const r = await TOOL_HANDLERS_DB['cast_spell']!(DB_CTX, wizardState, {
      caster: 'player_character',
      spellSlug: 'detect-magic',
      slotLevel: 1,
      asRitual: true,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ritual/i);
  });
});
