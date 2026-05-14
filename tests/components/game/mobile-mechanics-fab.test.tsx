import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileMechanicsFab } from '@/components/game/mobile-mechanics-fab';

describe('MobileMechanicsFab', () => {
  it('renders a button with aria-label "Mechanics"', () => {
    render(<MobileMechanicsFab gameMode="exploration" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mechanics' })).toBeInTheDocument();
  });

  it('fires onOpen on click', () => {
    const onOpen = vi.fn();
    render(<MobileMechanicsFab gameMode="exploration" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the round badge in combat mode with a round number', () => {
    render(<MobileMechanicsFab gameMode="combat" round={3} onOpen={() => {}} />);
    expect(screen.getByText('R3')).toBeInTheDocument();
  });

  it('does not show a badge when round is not provided even in combat', () => {
    render(<MobileMechanicsFab gameMode="combat" onOpen={() => {}} />);
    expect(screen.queryByText(/^R\d+$/)).toBeNull();
  });

  it('does not show a badge in exploration mode', () => {
    render(<MobileMechanicsFab gameMode="exploration" round={2} onOpen={() => {}} />);
    expect(screen.queryByText(/^R\d+$/)).toBeNull();
  });
});
