import * as React from 'react';

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'ok' | 'gold' | 'ember';

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  dot?: boolean;
}

const TONES: Record<ChipTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--bone)', fg: 'var(--ink)', bd: 'var(--border)' },
  accent:  { bg: 'rgba(122,79,184,0.14)', fg: 'var(--arcane)', bd: 'rgba(122,79,184,0.30)' },
  warn:    { bg: 'rgba(184,84,50,0.12)', fg: 'var(--ember)', bd: 'rgba(184,84,50,0.25)' },
  ok:      { bg: 'rgba(92,138,107,0.14)', fg: 'var(--verdigris)', bd: 'rgba(92,138,107,0.28)' },
  gold:    { bg: 'rgba(197,163,87,0.18)', fg: '#7A5F22', bd: 'rgba(197,163,87,0.4)' },
  ember:   { bg: 'rgba(215,51,28,0.14)', fg: 'var(--dragonfire)', bd: 'rgba(215,51,28,0.30)' },
};

export function Chip({ tone = 'neutral', dot, children, style, ...rest }: ChipProps) {
  const t = TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        lineHeight: 1,
        ...style,
      }}
      {...rest}
    >
      {dot ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} /> : null}
      {children}
    </span>
  );
}
