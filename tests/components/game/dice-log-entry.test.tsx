import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiceLogEntry } from '@/components/game/dice-log-entry';

describe('DiceLogEntry', () => {
  it('renders kind, formula and total', () => {
    render(<DiceLogEntry kind="attack" formula="1d20+5" total={18} />);
    expect(screen.getByText(/attack/)).toBeInTheDocument();
    expect(screen.getByText(/1d20\+5/)).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('renders the note when provided', () => {
    render(<DiceLogEntry kind="attack" formula="1d20+5" total={18} note="vs goblin AC 13 — hit" />);
    expect(screen.getByText(/vs goblin AC 13/)).toBeInTheDocument();
  });
});
