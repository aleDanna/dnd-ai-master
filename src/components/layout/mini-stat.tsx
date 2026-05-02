import * as React from 'react';

export interface MiniStatProps {
  label: string;
  value: React.ReactNode;
}

export function MiniStat({ label, value }: MiniStatProps) {
  return (
    <div style={{ background: 'var(--bg-sunken)', borderRadius: 6, padding: '6px 0', textAlign: 'center' }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, marginTop: 1 }}>{value}</div>
    </div>
  );
}
