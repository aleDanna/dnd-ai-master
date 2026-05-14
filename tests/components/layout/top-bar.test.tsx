import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const pushMock = vi.fn();
const signOutMock = vi.fn(() => Promise.resolve());

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub',
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({ user: null, isLoaded: true, isSignedIn: false }),
  useClerk: () => ({ signOut: signOutMock }),
}));

import { TopBar } from '@/components/layout/top-bar';

describe('TopBar', () => {
  beforeEach(() => {
    pushMock.mockReset();
    signOutMock.mockReset();
    signOutMock.mockImplementation(() => Promise.resolve());
  });

  it('routes the Settings button to /settings when clicked', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(pushMock).toHaveBeenCalledWith('/settings');
  });

  it('opens the user account menu when the avatar is clicked', () => {
    render(<TopBar />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('signs the user out via Clerk when Sign out is chosen', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: '/sign-in' });
  });
});
