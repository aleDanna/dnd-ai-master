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
