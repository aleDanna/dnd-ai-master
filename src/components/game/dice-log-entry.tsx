'use client';

export interface DiceLogEntryProps {
  kind: string;
  formula: string;
  total: number;
  note?: string;
  crit?: boolean;
  fail?: boolean;
}

export function DiceLogEntry({ kind, formula, total, note, crit, fail }: DiceLogEntryProps) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: 1.45,
        padding: '4px 6px',
        borderRadius: 4,
        background: crit ? 'rgba(224,184,74,0.10)' : 'transparent',
      }}
    >
      <span style={{ color: 'var(--fg-muted)' }}>{kind.padEnd(7)}</span>
      <span style={{ color: 'var(--fg)' }}> {formula} → </span>
      <span style={{ color: crit ? 'var(--gold)' : fail ? 'var(--ember)' : 'var(--fg)', fontWeight: 600 }}>{total}</span>
      {note && <div style={{ color: 'var(--fg-subtle)', paddingLeft: 56, marginTop: -1 }}>{note}</div>}
    </div>
  );
}
