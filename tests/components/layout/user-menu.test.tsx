import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const pushMock = vi.fn();
const signOutMock = vi.fn(() => Promise.resolve());
const userState: { user: unknown; isLoaded: boolean } = { user: null, isLoaded: true };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@clerk/nextjs', () => ({
  useUser: () => userState,
  useClerk: () => ({ signOut: signOutMock }),
}));

import { UserMenu } from '@/components/layout/user-menu';

describe('UserMenu', () => {
  beforeEach(() => {
    pushMock.mockReset();
    signOutMock.mockReset();
    signOutMock.mockImplementation(() => Promise.resolve());
    userState.user = null;
    userState.isLoaded = true;
  });

  it('does not show the menu until the avatar is clicked', () => {
    render(<UserMenu />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('does not expose a Settings menu item (settings moved per-campaign)', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.queryByRole('menuitem', { name: /^settings$/i })).toBeNull();
  });

  it('exposes a Sign out menu item that calls Clerk signOut with a redirect', async () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: '/sign-in' });
  });

  it('closes the menu when Escape is pressed', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the user display name and email when available', () => {
    userState.user = {
      fullName: 'Alessio Danna',
      firstName: 'Alessio',
      lastName: 'Danna',
      username: 'aledanna',
      primaryEmailAddress: { emailAddress: 'alessio@example.com' },
    };
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByText('Alessio Danna')).toBeInTheDocument();
    expect(screen.getByText('alessio@example.com')).toBeInTheDocument();
  });

  it('falls back to "Account" when no user data is available', () => {
    userState.user = null;
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('shows a Loading… placeholder while Clerk has not finished loading', () => {
    userState.isLoaded = false;
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
