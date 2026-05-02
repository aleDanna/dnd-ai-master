'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { DiceLogEntry } from './dice-log-entry';
import type { DiceRollRow } from '@/sessions/client-types';

export interface DiceLogPanelProps {
  rolls: DiceRollRow[];
  limit?: number;
}

export function DiceLogPanel({ rolls, limit = 7 }: DiceLogPanelProps) {
  const visible = rolls.slice(0, limit);
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Eyebrow>Dice log</Eyebrow>
        <span style={{ fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>last {limit}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>no rolls yet</div>
        ) : (
          visible.map((r) => (
            <DiceLogEntry
              key={r.id}
              kind={r.kind}
              formula={r.formula}
              total={r.total}
              note={typeof r.meta?.note === 'string' ? r.meta.note : undefined}
              crit={typeof r.meta?.crit === 'boolean' ? r.meta.crit : undefined}
              fail={typeof r.meta?.fail === 'boolean' ? r.meta.fail : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}
