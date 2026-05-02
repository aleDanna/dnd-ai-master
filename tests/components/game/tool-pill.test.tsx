import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolPill } from '@/components/game/tool-pill';

describe('ToolPill', () => {
  it('renders the tool name', () => {
    render(<ToolPill toolName="make_attack" status="ok" />);
    expect(screen.getByText(/make_attack/)).toBeInTheDocument();
  });

  it('renders formula and result', () => {
    render(<ToolPill toolName="make_attack" formula="1d20+5" result="18 vs AC 13" status="ok" />);
    expect(screen.getByText('1d20+5')).toBeInTheDocument();
    expect(screen.getByText(/18 vs AC 13/)).toBeInTheDocument();
  });

  it('renders the spinning d20 when pending (no tool name visible)', () => {
    const { container } = render(<ToolPill toolName="make_attack" status="pending" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    // pending state hides the literal "⚙ make_attack" prefix
    expect(screen.queryByText(/⚙ make_attack/)).toBeNull();
  });
});
