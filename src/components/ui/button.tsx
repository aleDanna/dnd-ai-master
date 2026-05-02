import * as React from 'react';
import { Icon, type IconName } from './icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  type?: 'button' | 'submit' | 'reset';
}

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: { height: 28, padding: '0 10px', fontSize: 13 },
  md: { height: 36, padding: '0 14px', fontSize: 14 },
  lg: { height: 44, padding: '0 18px', fontSize: 15 },
};

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary:   { background: 'var(--arcane)', color: '#fff' },
  secondary: { background: 'var(--bg-card)', color: 'var(--fg)', borderColor: 'var(--border-strong)' },
  ghost:     { background: 'transparent', color: 'var(--fg)' },
  danger:    { background: 'var(--ember)', color: '#fff' },
  accent:    { background: 'var(--gold)', color: 'var(--ink)' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  children,
  disabled,
  onClick,
  style,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        fontFamily: 'var(--font-ui)',
        fontWeight: 500,
        border: '1px solid transparent',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background-color 120ms ease-out, border-color 120ms ease-out, transform 80ms ease-out',
        whiteSpace: 'nowrap',
        ...SIZE_STYLES[size],
        ...VARIANT_STYLES[variant],
        ...style,
      }}
      {...rest}
    >
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
}
