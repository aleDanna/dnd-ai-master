import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MechanicsPane } from '@/components/game/mechanics-pane';
import type { SessionStateRow } from '@/sessions/client-types';

function baseState(over: Partial<SessionStateRow> = {}): SessionStateRow {
  return {
    sessionId: 'sess-1',
    hpCurrent: 10, tempHp: 0, hitDiceRemaining: 1,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null, scene: '',
    sceneImageVersion: 0, sceneImagePrompt: null,
    ...over,
  };
}

describe('MechanicsPane scene image', () => {
  it('does not render an <img> when sceneImageVersion is 0', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]} diceLog={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.queryByRole('img', { name: /scene/i })).toBeNull();
  });

  it('renders an <img> with the correct cache-busted src when version > 0', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState({ sceneImageVersion: 7, sceneImagePrompt: 'a tower' })}
        actors={[]} diceLog={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    const img = screen.getByRole('img', { name: 'Scene illustration' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sessions/sess-1/scene-image?v=7');
  });
});
