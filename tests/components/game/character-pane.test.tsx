import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CharacterPane } from '@/components/game/character-pane';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

const baseState: SessionStateRow = {
  sessionId: 's1',
  hpCurrent: 10,
  tempHp: 0,
  hitDiceRemaining: 1,
  spellSlotsUsed: {},
  conditions: [],
  resourcesUsed: {},
  inCombat: false,
  combat: null,
  scene: '',
  sceneImageVersion: 0,
  sceneImagePrompt: null,
};

const baseCharacter: Character = {
  id: 'c1',
  name: 'Tharion',
  level: 1,
  xp: 0,
  classSlug: 'fighter',
  raceSlug: 'human',
  backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 8 },
  proficiencyBonus: 2,
  hpMax: 12,
  ac: 16,
  speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
  spellcasting: null,
  features: [],
  inventory: [],
  hitDiceMax: 1,
  hitDieSize: 10,
};

describe('CharacterPane Spells section', () => {
  it('does not render Spells for non-spellcasters', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.queryByText('Spells')).not.toBeInTheDocument();
  });

  it('renders Spells with empty fallback for a caster class even when spellcasting is null (legacy character)', () => {
    const legacyWizard: Character = {
      ...baseCharacter,
      classSlug: 'wizard',
      spellcasting: null,
    };
    render(<CharacterPane character={legacyWizard} state={baseState} />);
    expect(screen.getByText('Spells')).toBeInTheDocument();
    expect(screen.getByText(/No spells known yet/i)).toBeInTheDocument();
  });

  it('renders known spell labels for spellcasters', () => {
    const wizard: Character = {
      ...baseCharacter,
      classSlug: 'wizard',
      spellcasting: {
        ability: 'INT',
        spellSaveDC: 13,
        spellAttackBonus: 5,
        slotsMax: { 1: 2 },
        spellsKnown: ['magic-missile', 'fire-bolt', 'shield'],
        spellsPrepared: ['magic-missile', 'shield'],
      },
    };
    render(<CharacterPane character={wizard} state={baseState} />);
    expect(screen.getByText('Spells')).toBeInTheDocument();
    expect(screen.getByText('Magic Missile')).toBeInTheDocument();
    expect(screen.getByText('Fire Bolt')).toBeInTheDocument();
    expect(screen.getByText('Shield')).toBeInTheDocument();
    // Two prepared spells get the "prep" badge; the unprepared one does not.
    expect(screen.getAllByText('prep')).toHaveLength(2);
  });

  it('shows empty fallback when spellsKnown is empty for a spellcaster', () => {
    const noviceCaster: Character = {
      ...baseCharacter,
      classSlug: 'sorcerer',
      spellcasting: {
        ability: 'CHA',
        spellSaveDC: 13,
        spellAttackBonus: 5,
        slotsMax: { 1: 2 },
        spellsKnown: [],
        spellsPrepared: [],
      },
    };
    render(<CharacterPane character={noviceCaster} state={baseState} />);
    expect(screen.getByText('Spells')).toBeInTheDocument();
    expect(screen.getByText(/No spells known yet/i)).toBeInTheDocument();
  });

  it('does not show prep badges when prepared equals known (sorcerer/warlock pattern)', () => {
    const sorcerer: Character = {
      ...baseCharacter,
      classSlug: 'sorcerer',
      spellcasting: {
        ability: 'CHA',
        spellSaveDC: 13,
        spellAttackBonus: 5,
        slotsMax: { 1: 2 },
        spellsKnown: ['fire-bolt', 'magic-missile'],
        spellsPrepared: ['fire-bolt', 'magic-missile'],
      },
    };
    render(<CharacterPane character={sorcerer} state={baseState} />);
    expect(screen.queryByText('prep')).not.toBeInTheDocument();
  });
});

describe('CharacterPane Inspiration', () => {
  it('hides the star when inspiration is missing or false', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.queryByLabelText('Has Inspiration')).toBeNull();
  });

  it('renders the gold star next to the name when inspiration is true (PHB §18.1)', () => {
    const inspired: Character = { ...baseCharacter, inspiration: true };
    render(<CharacterPane character={inspired} state={baseState} />);
    expect(screen.getByLabelText('Has Inspiration')).toBeInTheDocument();
  });
});

describe('CharacterPane multi-class breakdown (PHB §2.5)', () => {
  it('falls back to single class when classes[] is empty', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.getByText(/human · Fighter 1/i)).toBeInTheDocument();
  });

  it('joins multiple classes with " / " when classes[] has entries', () => {
    const multi: Character = {
      ...baseCharacter,
      level: 7,
      classes: [
        { slug: 'wizard', level: 5 },
        { slug: 'fighter', level: 2 },
      ],
    };
    render(<CharacterPane character={multi} state={baseState} />);
    expect(screen.getByText(/Wizard 5 \/ Fighter 2/)).toBeInTheDocument();
  });
});

describe('CharacterPane Attunement (PHB §10.1)', () => {
  it('hides the section when attunedItems is empty', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.queryByText(/Attuned:/i)).toBeNull();
  });

  it('shows N/3 and item slugs when attunedItems is present', () => {
    const attuned: Character = {
      ...baseCharacter,
      attunedItems: ['amulet-of-health', 'cloak-of-protection'],
    };
    render(<CharacterPane character={attuned} state={baseState} />);
    expect(screen.getByText(/Attuned:\s*2\s*\/\s*3/)).toBeInTheDocument();
    expect(screen.getByText('Amulet Of Health')).toBeInTheDocument();
    expect(screen.getByText('Cloak Of Protection')).toBeInTheDocument();
  });
});

describe('CharacterPane Equipped Focus (PHB §8.4)', () => {
  it('hides the section when no focus is set', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.queryByText('Focus')).toBeNull();
  });

  it('renders the focus kind + slug when set', () => {
    const focused: Character = {
      ...baseCharacter,
      equippedFocus: { kind: 'holy', itemSlug: 'emblem-pelor' },
    };
    render(<CharacterPane character={focused} state={baseState} />);
    expect(screen.getByText('Focus')).toBeInTheDocument();
    expect(screen.getByText(/Holy: Emblem Pelor/)).toBeInTheDocument();
  });
});

describe('CharacterPane Senses (PHB §6.4)', () => {
  it('hides the section when senses is undefined', () => {
    render(<CharacterPane character={baseCharacter} state={baseState} />);
    expect(screen.queryByText('Senses')).toBeNull();
  });

  it('renders only the present senses', () => {
    const elf: Character = {
      ...baseCharacter,
      senses: { darkvisionFt: 60, blindsightFt: 30 },
    };
    render(<CharacterPane character={elf} state={baseState} />);
    expect(screen.getByText('Senses')).toBeInTheDocument();
    expect(screen.getByText('Darkvision 60 ft')).toBeInTheDocument();
    expect(screen.getByText('Blindsight 30 ft')).toBeInTheDocument();
    expect(screen.queryByText(/Tremorsense/)).toBeNull();
    expect(screen.queryByText(/Truesight/)).toBeNull();
  });
});

describe('CharacterPane condition durations (PHB §3.6)', () => {
  it('shows "(N rds)" for finite durations', () => {
    const stateWithCond: SessionStateRow = {
      ...baseState,
      conditions: [
        { slug: 'poisoned', source: 'spider', durationRounds: 3, appliedRound: 1 },
      ],
    };
    render(<CharacterPane character={baseCharacter} state={stateWithCond} />);
    expect(screen.getByText('poisoned')).toBeInTheDocument();
    expect(screen.getByText(/\(3 rds\)/)).toBeInTheDocument();
  });

  it('shows "(1 rd)" singular for one-round durations', () => {
    const stateWithCond: SessionStateRow = {
      ...baseState,
      conditions: [
        { slug: 'frightened', source: 'wolf', durationRounds: 1, appliedRound: 1 },
      ],
    };
    render(<CharacterPane character={baseCharacter} state={stateWithCond} />);
    expect(screen.getByText(/\(1 rd\)/)).toBeInTheDocument();
  });

  it('omits the countdown for "until_removed" conditions', () => {
    const stateWithCond: SessionStateRow = {
      ...baseState,
      conditions: [
        { slug: 'cursed', source: 'lich', durationRounds: 'until_removed', appliedRound: 1 },
      ],
    };
    render(<CharacterPane character={baseCharacter} state={stateWithCond} />);
    expect(screen.getByText('cursed')).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+/)).toBeNull();
  });
});
