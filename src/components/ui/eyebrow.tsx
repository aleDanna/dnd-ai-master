import * as React from 'react';

export interface EyebrowProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Eyebrow({ children, style, ...rest }: EyebrowProps) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
