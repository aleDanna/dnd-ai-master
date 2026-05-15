'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/ui/wordmark';
import { Chip } from '@/components/ui/chip';
import { UserMenu } from '@/components/layout/user-menu';

export interface TopBarProps {
  mode?: string;
}

export function TopBar({ mode = 'Solo' }: TopBarProps) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 32px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        flexShrink: 0,
      }}
    >
      <Link href="/hub" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'inherit' }}>
        <Icon name="logo-d20" size={22} />
        <Wordmark size={18} />
      </Link>
      <nav style={{ marginLeft: 24, display: 'flex', gap: 4 }}>
        {[
          { label: 'Campaigns', href: '/campaigns' },
          { label: 'Characters', href: '/hub' },
        ].map((n) => (
          <Link
            key={n.label}
            href={n.href}
            style={{
              background: isActive(n.href) ? 'var(--bg-card)' : 'transparent',
              color: isActive(n.href) ? 'var(--fg)' : 'var(--fg-muted)',
              height: 28,
              padding: '0 12px',
              borderRadius: 6,
              fontFamily: 'var(--font-ui)',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      <Chip tone="accent" dot>{mode}</Chip>
      <UserMenu />
    </header>
  );
}
