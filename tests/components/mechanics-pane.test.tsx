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
        actors={[]}
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
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    const img = screen.getByRole('img', { name: 'Scene illustration' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sessions/sess-1/scene-image?v=7');
  });
});

describe('MechanicsPane travel display (PHB §6)', () => {
  it('hides the Travel section when state.travel is undefined', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.queryByText('Travel')).toBeNull();
  });

  it('renders the pace chip when set', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState({ travel: { pace: 'fast' } })}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByText(/Pace: Fast \(4 mi\/h, -5 PP\)/)).toBeInTheDocument();
  });

  it('renders the light level chip when set', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState({ travel: { lightLevel: 'darkness' } })}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByText('Light: Darkness')).toBeInTheDocument();
  });

  it('renders both pace and light when both are set', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState({ travel: { pace: 'slow', lightLevel: 'dim' } })}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.getByText(/Pace: Slow \(2 mi\/h, stealth\)/)).toBeInTheDocument();
    expect(screen.getByText('Light: Dim')).toBeInTheDocument();
  });

  it('hides the Travel section when travel object is set but empty', () => {
    render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState({ travel: {} })}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    expect(screen.queryByText('Travel')).toBeNull();
  });
});

describe('MechanicsPane compact prop', () => {
  it('renders without the sticky desktop sidebar chrome when compact=true', () => {
    const { container } = render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
        compact
      />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).not.toBe('sticky');
    expect(aside.style.width).not.toBe('320px');
    expect(aside.style.borderLeft).toBe('');
  });

  it('renders with the sticky sidebar chrome by default', () => {
    const { container } = render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).toBe('sticky');
    expect(aside.style.width).toBe('320px');
  });
});
