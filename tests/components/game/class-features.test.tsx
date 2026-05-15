import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClassFeatures } from '@/components/game/class-features';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

function character(over: Partial<Character> = {}): Character {
  return {
    id: 'ch-1', name: 'Tharion',
    raceSlug: 'half-elf', classSlug: 'fighter', level: 3,
    xp: 900, hpMax: 27, ac: 16, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [],
    features: [],
    spellcasting: null,
    ...over,
  } as unknown as Character;
}

function state(over: Partial<SessionStateRow> = {}): SessionStateRow {
  return {
    sessionId: 's-1',
    hpCurrent: 27, tempHp: 0, hitDiceRemaining: 3,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null,
    scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
    ...over,
  } as unknown as SessionStateRow;
}

describe('ClassFeatures', () => {
  it('renders null when the character has no spell slots and no counted features', () => {
    const { container } = render(<ClassFeatures character={character()} state={state()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the Fighter glyph header for a fighter', () => {
    const c = character({
      features: [{ slug: 'second-wind', source: 'class', usesMax: 1, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state()} />);
    expect(screen.getByText('Fighter')).toBeInTheDocument();
    expect(screen.getByText(/Lv 3/)).toBeInTheDocument();
  });

  it('does NOT render the spell-slots tile inside ClassFeatures (moved to the Spellbook modal)', () => {
    // Pre-redesign the slot tile lived in the class-features block above the
    // inventory. It now lives inside the Spellbook modal so the side panel
    // collapses spells under a single "Spellbook" entry.
    const c = character({
      classSlug: 'wizard',
      spellcasting: {
        ability: 'INT', spellSaveDC: 13, spellAttackBonus: 5,
        slotsMax: { 1: 4, 2: 2 },
        spellsKnown: [], spellsPrepared: [],
      },
    } as Partial<Character>);
    const { container } = render(<ClassFeatures character={c} state={state({ spellSlotsUsed: { 1: 1 } })} />);
    // Wizard has no counted/pool features — with the slot tile gone, the
    // whole block returns null and renders nothing.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Spell slots')).not.toBeInTheDocument();
  });

  it('still renders class-feature tiles for half-casters (slot tile is in the modal, other resources stay here)', () => {
    const c = character({
      classSlug: 'paladin',
      spellcasting: {
        ability: 'CHA', spellSaveDC: 13, spellAttackBonus: 5,
        slotsMax: { 1: 2 },
        spellsKnown: [], spellsPrepared: [],
      },
      features: [{ slug: 'lay-on-hands', source: 'class', usesMax: 15, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state()} />);
    // Lay on Hands resource stays in this block.
    expect(screen.getByText('Lay on Hands')).toBeInTheDocument();
    // Spell slots tile is now exclusively in the spellbook modal.
    expect(screen.queryByText('Spell slots')).not.toBeInTheDocument();
  });

  it('renders a resource tile with name + action chip when available', () => {
    const c = character({
      features: [{ slug: 'action-surge', source: 'class', usesMax: 1, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state()} />);
    expect(screen.getByText('Action Surge')).toBeInTheDocument();
    expect(screen.getByText('Use')).toBeInTheDocument();
  });

  it('shows "Spent" when the feature is fully consumed', () => {
    const c = character({
      features: [{ slug: 'action-surge', source: 'class', usesMax: 1, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state({ resourcesUsed: { 'action-surge': 1 } })} />);
    expect(screen.getByText('Spent')).toBeInTheDocument();
  });

  it('renders a pool-kind tile with a percentage bar for sorcery-points', () => {
    const c = character({
      classSlug: 'sorcerer',
      features: [{ slug: 'sorcery-points', source: 'class', usesMax: 4, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state({ resourcesUsed: { 'sorcery-points': 1 } })} />);
    expect(screen.getByText('Sorcery Points')).toBeInTheDocument();
    // 4 - 1 = 3 remaining → "3 / 4"
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('/ 4')).toBeInTheDocument();
    expect(screen.getByText('pts')).toBeInTheDocument();
  });

  it('falls back gracefully for an unknown feature slug', () => {
    const c = character({
      features: [{ slug: 'mystery-thing', source: 'class', usesMax: 2, description: '' }],
    } as Partial<Character>);
    render(<ClassFeatures character={c} state={state()} />);
    // slugToLabel converts to "Mystery Thing"
    expect(screen.getByText('Mystery Thing')).toBeInTheDocument();
  });
});
