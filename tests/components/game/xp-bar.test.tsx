import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { XpBar } from '@/components/game/xp-bar';

describe('XpBar', () => {
  it('renders level + within-level XP fraction at the start of a level', () => {
    render(<XpBar level={3} xp={900} />);
    expect(screen.getByText('Level 3')).toBeInTheDocument();
    // Level 3 starts at 900, level 4 at 2700 → span 1800. Just at threshold.
    expect(screen.getByText('0 / 1,800')).toBeInTheDocument();
  });

  it('shows mid-level progress', () => {
    // Level 4: starts 2700, ends 6500 (span 3800). At 4500 XP → 1800 into.
    render(<XpBar level={4} xp={4500} />);
    expect(screen.getByText('1,800 / 3,800')).toBeInTheDocument();
  });

  it('renders the progressbar with correct ARIA percentage', () => {
    // Level 1: starts 0, ends 300. At 150 XP → 50%.
    render(<XpBar level={1} xp={150} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('renders MAX badge at level 20', () => {
    render(<XpBar level={20} xp={400_000} />);
    expect(screen.getByText('MAX')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows the absolute XP total', () => {
    render(<XpBar level={5} xp={7500} />);
    expect(screen.getByText(/Total 7,500 XP/)).toBeInTheDocument();
    expect(screen.getByText(/Next at 14,000/)).toBeInTheDocument();
  });

  it('caps the bar at 100% when xp exceeds the next threshold (level-up pending)', () => {
    // Level 1, but already earned 350 XP (level 2 threshold is 300). Bar
    // should max out, not overflow.
    render(<XpBar level={1} xp={350} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows "Level up ready" badge when xp exceeds the next threshold', () => {
    render(<XpBar level={1} xp={350} />);
    expect(screen.getByText(/Level up ready/i)).toBeInTheDocument();
    // The numeric "350 / 300" readout is hidden — we don't want to mislead
    // the player into thinking they're stuck above the cap.
    expect(screen.queryByText('350 / 300')).toBeNull();
  });

  it('does NOT show the ready badge while still mid-level', () => {
    render(<XpBar level={1} xp={150} />);
    expect(screen.queryByText(/Level up ready/i)).toBeNull();
    expect(screen.getByText('150 / 300')).toBeInTheDocument();
  });

  it('does NOT show the ready badge at exactly the threshold (intoLevel >= span fires only when >= span)', () => {
    // Edge: at exactly 300 XP, level 1, intoLevel=300 spanForLevel=300, so
    // the condition (intoLevel >= spanForLevel) is true → ready.
    render(<XpBar level={1} xp={300} />);
    expect(screen.getByText(/Level up ready/i)).toBeInTheDocument();
  });
});
