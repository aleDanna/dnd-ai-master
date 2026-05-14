import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileCharacterBar } from '@/components/game/mobile-character-bar';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

function character(over: Partial<Character> = {}): Character {
  return {
    id: 'ch-1', name: 'Tharion', raceSlug: 'half-elf', classSlug: 'fighter',
    level: 3, xp: 900, hpMax: 27, ac: 16, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [], features: [],
    ...over,
  } as unknown as Character;
}

function state(over: Partial<SessionStateRow> = {}): SessionStateRow {
  return {
    sessionId: 's-1', hpCurrent: 21, tempHp: 0, hitDiceRemaining: 3,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null, scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
    ...over,
  } as unknown as SessionStateRow;
}

describe('MobileCharacterBar', () => {
  it('shows the character name and L/AC stats', () => {
    render(<MobileCharacterBar character={character()} state={state()} onOpen={() => {}} />);
    expect(screen.getByText('Tharion')).toBeInTheDocument();
    expect(screen.getByText(/L3 · AC 16/)).toBeInTheDocument();
  });

  it('shows the HP fraction', () => {
    render(<MobileCharacterBar character={character()} state={state({ hpCurrent: 21 })} onOpen={() => {}} />);
    expect(screen.getByText('21/27 HP')).toBeInTheDocument();
  });

  it('fires onOpen when tapped', () => {
    const onOpen = vi.fn();
    render(<MobileCharacterBar character={character()} state={state()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the inspiration star when character.inspiration is true', () => {
    render(
      <MobileCharacterBar
        character={character({ inspiration: true } as Partial<Character>)}
        state={state()}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByLabelText(/inspiration/i)).toBeInTheDocument();
  });
});
