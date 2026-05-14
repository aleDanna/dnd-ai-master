'use client';
import * as React from 'react';

export interface TopBarMobileProps {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

export function TopBarMobile({ title, subtitle, leading, trailing }: TopBarMobileProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: 'var(--bg-elev)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 20,
        minHeight: 44,
      }}
    >
      <div style={{ width: 60, display: 'flex', justifyContent: 'flex-start' }}>{leading}</div>
      <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 1.1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-subtle)',
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      <div style={{ width: 60, display: 'flex', justifyContent: 'flex-end', gap: 4 }}>{trailing}</div>
    </header>
  );
}
