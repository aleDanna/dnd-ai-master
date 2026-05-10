import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CombatTracker } from '@/components/game/combat-tracker';
import type { CombatActorRow, SessionStateRow } from '@/sessions/client-types';

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

const goblin: CombatActorRow = {
  id: 'm1', sessionId: 's', name: 'Goblin', monsterSlug: 'goblin',
  hpCurrent: 4, hpMax: 7, initiative: 12, isAlive: true, conditions: [],
};

const inCombatState: Pick<SessionStateRow, 'inCombat' | 'combat'> = {
  inCombat: true,
  combat: {
    round: 1,
    turnOrder: [
      { actorId: 'pc1', initiative: 18 },
      { actorId: 'm1', initiative: 12 },
    ],
    currentIdx: 0,
  },
};

describe('CombatTracker active actor turnState (PHB §9.2)', () => {
  it('shows Action / Bonus / Reaction chips with budget when PC is active', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcSpeed={30}
        pcTurnState={{
          actionUsed: false,
          bonusUsed: false,
          reactionUsed: false,
          movementSpentFt: 0,
          freeInteractionsUsed: 0,
          dodging: false,
          disengaged: false,
          dashed: false,
        }}
      />,
    );
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Bonus')).toBeInTheDocument();
    expect(screen.getByText('Reaction')).toBeInTheDocument();
    expect(screen.getByText(/Move 0\/30 ft/)).toBeInTheDocument();
  });

  it('marks chips with ✓ once an action is consumed', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcSpeed={30}
        pcTurnState={{
          actionUsed: true,
          bonusUsed: false,
          reactionUsed: true,
          movementSpentFt: 15,
          freeInteractionsUsed: 0,
          dodging: false,
          disengaged: false,
          dashed: false,
        }}
      />,
    );
    // Action and Reaction used → checkmark
    expect(screen.getAllByText('✓').length).toBe(2);
    expect(screen.getByText(/Move 15\/30 ft/)).toBeInTheDocument();
  });

  it('doubles the movement budget when dashed', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcSpeed={30}
        pcTurnState={{
          actionUsed: false,
          bonusUsed: false,
          reactionUsed: false,
          movementSpentFt: 0,
          freeInteractionsUsed: 0,
          dodging: false,
          disengaged: false,
          dashed: true,
        }}
      />,
    );
    expect(screen.getByText(/Move 0\/60 ft/)).toBeInTheDocument();
    expect(screen.getByText('Dashed')).toBeInTheDocument();
  });

  it('shows status badges Dodging, Disengaged, Loading shot used, Off-hand used', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcSpeed={30}
        pcTurnState={{
          actionUsed: true,
          bonusUsed: true,
          reactionUsed: false,
          movementSpentFt: 5,
          freeInteractionsUsed: 0,
          dodging: true,
          disengaged: true,
          dashed: false,
          loadingShotUsed: true,
          offHandAttackUsed: true,
        }}
      />,
    );
    expect(screen.getByText('Dodging')).toBeInTheDocument();
    expect(screen.getByText('Disengaged')).toBeInTheDocument();
    expect(screen.getByText('Loading shot used')).toBeInTheDocument();
    expect(screen.getByText('Off-hand used')).toBeInTheDocument();
  });

  it('shows Readied chip with the planned action when set', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcSpeed={30}
        pcTurnState={{
          actionUsed: true,
          bonusUsed: false,
          reactionUsed: false,
          movementSpentFt: 0,
          freeInteractionsUsed: 0,
          dodging: false,
          disengaged: false,
          dashed: false,
          readied: { trigger: 'enemy enters 30 ft', action: 'fire crossbow' },
        }}
      />,
    );
    expect(screen.getByText(/Readied: fire crossbow/)).toBeInTheDocument();
  });
});

describe('CombatTracker position (PHB §3.5)', () => {
  it('shows the band and engagement list resolved to friendly names', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcPosition={{ band: 'engaged', engagedWith: ['m1'] }}
      />,
    );
    // The band is in its own <span>; the engagement summary is in the parent.
    expect(screen.getByText('engaged')).toBeInTheDocument();
    expect(screen.getByText(/Engaged with: Goblin/)).toBeInTheDocument();
  });

  it('shows the band even when engagement list is empty', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcPosition={{ band: 'far', engagedWith: [] }}
      />,
    );
    // The text contains the band but no "Engaged with" suffix.
    expect(screen.getByText(/far/i)).toBeInTheDocument();
    expect(screen.queryByText(/Engaged with:/)).toBeNull();
  });
});

describe('CombatTracker condition durations (PHB §3.6)', () => {
  it('renders condition chips with "(N rds)" countdown for finite durations on the active actor', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcConditions={[
          { slug: 'poisoned', source: 'spider', durationRounds: 4, appliedRound: 1 },
        ]}
      />,
    );
    expect(screen.getByText('poisoned')).toBeInTheDocument();
    expect(screen.getByText(/\(4 rds\)/)).toBeInTheDocument();
  });

  it('omits the countdown for until_removed conditions', () => {
    render(
      <CombatTracker
        state={inCombatState}
        actors={[goblin]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
        pcConditions={[
          { slug: 'cursed', source: 'lich', durationRounds: 'until_removed', appliedRound: 1 },
        ]}
      />,
    );
    expect(screen.getByText('cursed')).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+/)).toBeNull();
  });
});
