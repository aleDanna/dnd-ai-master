'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useUser, useClerk } from '@clerk/nextjs';
import { Icon } from '@/components/ui/icon';

export interface UserMenuProps {
  /** Anchor the popover to the right edge (default) or left edge of the trigger. */
  align?: 'right' | 'left';
  /** Size of the circular avatar trigger (px). */
  size?: number;
}

export function UserMenu({ align = 'right', size = 28 }: UserMenuProps) {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const goToSettings = () => {
    setOpen(false);
    router.push('/settings');
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut({ redirectUrl: '/sign-in' });
    } finally {
      setSigningOut(false);
      setOpen(false);
    }
  };

  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const composedName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  const displayName =
    user?.fullName ||
    composedName ||
    user?.username ||
    email ||
    'Account';

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title="Account"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'var(--bone)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink)',
          border: '1px solid transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Icon name="user" size={Math.max(12, Math.round(size * 0.5))} />
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
            minWidth: 220,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            padding: 6,
            zIndex: 50,
            fontFamily: 'var(--font-ui)',
          }}
        >
          <div
            style={{
              padding: '8px 10px 10px',
              borderBottom: '1px solid var(--border)',
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--fg)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {isLoaded ? displayName : 'Loading…'}
            </div>
            {email && email !== displayName ? (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--fg-subtle)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {email}
              </div>
            ) : null}
          </div>
          <MenuButton onClick={goToSettings} icon="settings" label="Settings" />
          <MenuButton
            onClick={handleSignOut}
            icon="log-out"
            label={signingOut ? 'Signing out…' : 'Sign out'}
            tone="danger"
            disabled={signingOut}
          />
        </div>
      ) : null}
    </div>
  );
}

interface MenuButtonProps {
  onClick: () => void;
  icon: 'settings' | 'log-out';
  label: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

function MenuButton({ onClick, icon, label, tone = 'default', disabled = false }: MenuButtonProps) {
  const [hover, setHover] = React.useState(false);
  const color = tone === 'danger' ? 'var(--ember)' : 'var(--fg)';
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        background: hover && !disabled ? 'var(--bg-card)' : 'transparent',
        border: 'none',
        color,
        fontSize: 13,
        fontFamily: 'var(--font-ui)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 4,
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 120ms ease-out',
      }}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
}
