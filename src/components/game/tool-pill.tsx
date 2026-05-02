'use client';
import { Icon } from '@/components/ui/icon';

export type ToolPillStatus = 'pending' | 'ok' | 'error';

export interface ToolPillProps {
  toolName: string;
  formula?: string;
  result?: string;
  status: ToolPillStatus;
}

export function ToolPill({ toolName, formula, result, status }: ToolPillProps) {
  const tone =
    status === 'ok' ? 'var(--verdigris)' :
    status === 'error' ? 'var(--ember)' :
    'var(--fg-muted)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        padding: '4px 10px',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--fg-muted)',
      }}
    >
      {status === 'pending' ? (
        <span style={{ display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>
          <Icon name="logo-d20" size={12} />
        </span>
      ) : (
        <span style={{ color: 'var(--fg)' }}>⚙ {toolName}</span>
      )}
      {formula && <span>{formula}</span>}
      {result && <span style={{ color: tone, fontWeight: 600 }}>→ {result}</span>}
    </span>
  );
}
