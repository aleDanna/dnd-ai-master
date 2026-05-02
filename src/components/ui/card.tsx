import * as React from 'react';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'> {
  onClick?: () => void;
  accent?: boolean;
}

export function Card({ onClick, accent, children, style, ...rest }: CardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${accent ? 'var(--arcane)' : 'var(--border)'}`,
        borderRadius: 8,
        padding: 18,
        boxShadow: 'var(--shadow-1)',
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 120ms ease-out, transform 80ms ease-out',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
