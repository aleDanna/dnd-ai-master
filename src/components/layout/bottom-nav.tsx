'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/icon';

interface Tab {
  key: 'campaigns' | 'heroes' | 'settings';
  href: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { key: 'campaigns', href: '/campaigns', label: 'Campaigns', icon: 'book' },
  { key: 'heroes', href: '/hub', label: 'Heroes', icon: 'user' },
  { key: 'settings', href: '/settings', label: 'Settings', icon: 'settings' },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      style={{
        display: 'flex',
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        zIndex: 15,
      }}
    >
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: 1,
              padding: '10px 0 8px',
              textDecoration: 'none',
              color: active ? 'var(--arcane-2)' : 'var(--fg-subtle)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              fontFamily: 'var(--font-ui)',
            }}
          >
            <Icon name={t.icon} size={20} />
            <span style={{ fontSize: 10, fontWeight: 500 }}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
