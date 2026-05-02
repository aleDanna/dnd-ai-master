'use client';
import { useRouter } from 'next/navigation';
import { Button, type ButtonSize, type ButtonVariant } from './button';

export interface SettingsLinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, render as a compact icon-only button (no label text). */
  iconOnly?: boolean;
}

/**
 * Bullet-proof settings nav button — uses router.push instead of <Link><Button>
 * so the click always navigates regardless of how the browser bubbles button clicks
 * inside an anchor.
 */
export function SettingsLink({ variant = 'ghost', size = 'md', iconOnly = false }: SettingsLinkProps) {
  const router = useRouter();
  return (
    <Button
      variant={variant}
      size={size}
      icon="settings"
      onClick={() => router.push('/settings')}
      style={iconOnly ? { padding: 0, width: size === 'sm' ? 28 : 36 } : undefined}
      aria-label="Settings"
      title="Settings"
    >
      {iconOnly ? null : 'Settings'}
    </Button>
  );
}
