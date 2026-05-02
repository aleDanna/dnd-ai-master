import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CombatTracker } from '@/components/game/combat-tracker';

describe('CombatTracker', () => {
  it('renders the exploration card when not in combat', () => {
    render(
      <CombatTracker
        state={{ inCombat: false, combat: null }}
        actors={[]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
      />,
    );
    expect(screen.getByText(/Exploration/i)).toBeInTheDocument();
    expect(screen.getByText(/No active combat/i)).toBeInTheDocument();
  });

  it('renders initiative order with PC and monster, highlighting current actor', () => {
    render(
      <CombatTracker
        state={{
          inCombat: true,
          combat: { round: 2, turnOrder: [{ actorId: 'pc1', initiative: 18 }, { actorId: 'm1', initiative: 12 }], currentIdx: 0 },
        }}
        actors={[
          { id: 'm1', sessionId: 's', name: 'Goblin', monsterSlug: 'goblin', hpCurrent: 4, hpMax: 7, initiative: 12, isAlive: true, conditions: [] },
        ]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
      />,
    );
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
    expect(screen.getByText('Tharion')).toBeInTheDocument();
    expect(screen.getByText('Goblin')).toBeInTheDocument();
  });
});
