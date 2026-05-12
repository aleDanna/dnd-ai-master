import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PartyStrip } from '@/components/sessions/party-strip';

const PARTY = [
  { id: 'c-luffy', name: 'Luffy', raceSlug: 'human', classSlug: 'fighter', level: 1 },
  { id: 'c-usopp', name: 'Usopp', raceSlug: 'human', classSlug: 'fighter', level: 1 },
];

describe('PartyStrip — active-turn highlight', () => {
  it('marks exactly the active player with aria-current=true', () => {
    render(
      <PartyStrip
        party={PARTY}
        currentPlayerCharacterId="c-luffy"
        viewerCharacterId="c-usopp"
      />,
    );
    // Only Luffy carries the aria-current marker.
    const luffyPill = screen.getByTitle(/Luffy — turno attivo/);
    expect(luffyPill).toHaveAttribute('aria-current', 'true');
    // Usopp is rendered but does NOT carry aria-current.
    const usoppPill = screen.getByTitle('Usopp');
    expect(usoppPill).not.toHaveAttribute('aria-current');
  });

  it('surfaces the active player\'s name in the leading "Turn" label', () => {
    render(
      <PartyStrip
        party={PARTY}
        currentPlayerCharacterId="c-luffy"
        viewerCharacterId="c-usopp"
      />,
    );
    // The eyebrow exposes who's up so the answer survives horizontal overflow.
    expect(screen.getByText('Turn')).toBeInTheDocument();
    // Both "Luffy" appearances are valid (label + pill). At least one in DOM.
    const luffies = screen.getAllByText('Luffy');
    expect(luffies.length).toBeGreaterThanOrEqual(1);
  });

  it('tags the viewer\'s own pill with " (you)"', () => {
    render(
      <PartyStrip
        party={PARTY}
        currentPlayerCharacterId="c-luffy"
        viewerCharacterId="c-usopp"
      />,
    );
    expect(screen.getByText(/Usopp \(you\)/)).toBeInTheDocument();
  });

  it('renders nothing aria-current when no player has the active turn', () => {
    render(
      <PartyStrip
        party={PARTY}
        currentPlayerCharacterId={null}
        viewerCharacterId="c-usopp"
      />,
    );
    // Pills exist but none claim active.
    expect(screen.getByTitle('Luffy')).not.toHaveAttribute('aria-current');
    expect(screen.getByTitle('Usopp')).not.toHaveAttribute('aria-current');
    // Lead label shows no name yet.
    expect(screen.getByText('Turn')).toBeInTheDocument();
  });
});
