import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AuthedLayout from '@/app/(authed)/layout';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));
vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: vi.fn(),
}));

import { usePathname } from 'next/navigation';
import { useIsMobile } from '@/lib/use-is-mobile';

function setup(pathname: string, mobile: boolean) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useIsMobile).mockReturnValue(mobile);
}

describe('(authed)/layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the desktop top bar on /hub at desktop width', () => {
    setup('/hub', false);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.getByRole('link', { name: 'Characters' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });

  it('renders the mobile top bar + bottom nav on /hub at mobile width', () => {
    setup('/hub', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull();
    expect(screen.getByRole('link', { name: /Heroes/ })).toBeInTheDocument();
  });

  it('does NOT render bottom nav on /campaigns/[id] at mobile width', () => {
    setup('/campaigns/abc-123', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });

  it('does NOT render any chrome top bar on /sessions/[id]', () => {
    setup('/sessions/abc-123', true);
    render(<AuthedLayout><div data-testid="page">page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('does NOT render bottom nav on /campaigns/new at mobile width', () => {
    setup('/campaigns/new', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });
});
