import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chip } from '@/components/ui/chip';

describe('Chip', () => {
  it('renders children', () => {
    render(<Chip>Solo</Chip>);
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });

  it('applies the tone background style', () => {
    const { container } = render(<Chip tone="accent">Accent</Chip>);
    const span = container.firstChild as HTMLElement;
    expect(span.style.background).toContain('rgba(122');
  });

  it('renders a dot when dot=true', () => {
    const { container } = render(<Chip dot>Active</Chip>);
    const span = container.firstChild as HTMLElement;
    expect(span.querySelectorAll('span')).toHaveLength(1);
  });
});
