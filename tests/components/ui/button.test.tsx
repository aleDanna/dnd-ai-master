import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Open the table</Button>);
    expect(screen.getByRole('button', { name: 'Open the table' })).toBeInTheDocument();
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders left icon when `icon` prop is set', () => {
    render(<Button icon="plus">Add</Button>);
    const button = screen.getByRole('button', { name: 'Add' });
    expect(button.querySelector('svg')).toBeInTheDocument();
  });
});
