import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BottomNav } from '@/components/layout/bottom-nav';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

import { usePathname } from 'next/navigation';

describe('BottomNav', () => {
  it('renders the three tab labels', () => {
    vi.mocked(usePathname).mockReturnValue('/hub');
    render(<BottomNav />);
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Heroes')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('marks /hub as the active tab when pathname is /hub', () => {
    vi.mocked(usePathname).mockReturnValue('/hub');
    render(<BottomNav />);
    const heroes = screen.getByRole('link', { name: /Heroes/ });
    expect(heroes).toHaveAttribute('aria-current', 'page');
    const campaigns = screen.getByRole('link', { name: /Campaigns/ });
    expect(campaigns).not.toHaveAttribute('aria-current');
  });

  it('marks /campaigns as the active tab when pathname is /campaigns', () => {
    vi.mocked(usePathname).mockReturnValue('/campaigns');
    render(<BottomNav />);
    expect(screen.getByRole('link', { name: /Campaigns/ })).toHaveAttribute('aria-current', 'page');
  });

  it('marks /settings as the active tab when pathname is /settings', () => {
    vi.mocked(usePathname).mockReturnValue('/settings');
    render(<BottomNav />);
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark any tab active on unrelated paths', () => {
    vi.mocked(usePathname).mockReturnValue('/campaigns/abc-123');
    render(<BottomNav />);
    for (const label of ['Campaigns', 'Heroes', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).not.toHaveAttribute('aria-current');
    }
  });
});
