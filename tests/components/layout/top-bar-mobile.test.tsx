import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';

describe('TopBarMobile', () => {
  it('renders the title', () => {
    render(<TopBarMobile title="The Mill at Hollowcreek" />);
    expect(screen.getByText('The Mill at Hollowcreek')).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<TopBarMobile title="Hub" subtitle="AI&Games" />);
    expect(screen.getByText('AI&Games')).toBeInTheDocument();
  });

  it('renders leading and trailing slots', () => {
    render(
      <TopBarMobile
        title="Title"
        leading={<button>Back</button>}
        trailing={<button>Menu</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });
});
