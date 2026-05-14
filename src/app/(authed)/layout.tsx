'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from '@/components/layout/top-bar';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';
import { BottomNav } from '@/components/layout/bottom-nav';
import { UserMenu } from '@/components/layout/user-menu';
import { Icon } from '@/components/ui/icon';
import { useIsMobile } from '@/lib/use-is-mobile';

const HUB_ROUTES = new Set(['/hub', '/campaigns', '/settings']);

function isSessionPage(pathname: string): boolean {
  return pathname.startsWith('/sessions/');
}

function isHubRoute(pathname: string): boolean {
  return HUB_ROUTES.has(pathname);
}

function pageLabelFor(pathname: string): string {
  if (pathname.startsWith('/campaigns/new')) return 'New campaign';
  if (pathname.startsWith('/characters/new')) return 'New character';
  if (pathname.startsWith('/campaigns/')) return 'Campaign';
  if (pathname.startsWith('/characters/')) return 'Character';
  if (pathname.startsWith('/r/')) return 'Invite';
  if (pathname === '/hub') return 'Heroes';
  if (pathname === '/campaigns') return 'Campaigns';
  if (pathname === '/settings') return 'Settings';
  return 'AI&Games';
}

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const isMobile = useIsMobile();

  if (isSessionPage(pathname)) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>{children}</div>;
  }

  const showBottomNav = isMobile && isHubRoute(pathname);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {isMobile ? (
        <TopBarMobile
          leading={<Icon name="logo-d20" size={20} />}
          title={pageLabelFor(pathname)}
          subtitle="AI&Games"
          trailing={<UserMenu size={32} />}
        />
      ) : (
        <TopBar />
      )}
      <div style={{ paddingBottom: showBottomNav ? 72 : 0 }}>{children}</div>
      {showBottomNav ? <BottomNav /> : null}
    </div>
  );
}
