import * as React from 'react';

export interface WordmarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
}

export function Wordmark({ size = 28, style, ...rest }: WordmarkProps) {
  return (
    <span
      style={{
        fontFamily: "'Cormorant Garamond', Georgia, serif",
        fontWeight: 600,
        fontSize: size,
        letterSpacing: '-0.01em',
        lineHeight: 1,
        ...style,
      }}
      {...rest}
    >
      D&amp;D <span style={{ fontStyle: 'italic', fontWeight: 500 }}>AI</span> Master
    </span>
  );
}
