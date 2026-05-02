import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tile } from '@/components/wizard/tile';

describe('Tile', () => {
  it('renders name and note', () => {
    render(<Tile name="Half-Elf" note="Versatile" />);
    expect(screen.getByText('Half-Elf')).toBeInTheDocument();
    expect(screen.getByText('Versatile')).toBeInTheDocument();
  });

  it('shows check icon when selected', () => {
    const { container } = render(<Tile name="Fighter" selected />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<Tile name="Wizard" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
