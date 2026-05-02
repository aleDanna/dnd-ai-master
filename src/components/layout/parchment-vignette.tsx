import * as React from 'react';

export interface ParchmentVignetteProps {
  size?: number;
  style?: React.CSSProperties;
}

export function ParchmentVignette({ size = 220, style }: ParchmentVignetteProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" style={{ opacity: 0.1, ...style }}>
      <defs>
        <radialGradient id="parch-v" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="100" fill="url(#parch-v)" />
      <polygon points="100,20 170,55 170,145 100,180 30,145 30,55" fill="none" stroke="currentColor" strokeWidth="1" />
      <polygon points="100,20 170,55 100,90 30,55" fill="none" stroke="currentColor" strokeWidth="1" />
      <line x1="100" y1="90" x2="100" y2="180" stroke="currentColor" strokeWidth="1" />
      <line x1="100" y1="90" x2="170" y2="145" stroke="currentColor" strokeWidth="1" />
      <line x1="100" y1="90" x2="30" y2="145" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
