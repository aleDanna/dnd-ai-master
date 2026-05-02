'use client';
import { Icon } from '@/components/ui/icon';

export interface TileProps {
  name: string;
  note?: string;
  selected?: boolean;
  onClick?: () => void;
  accent?: string;
}

export function Tile({ name, note, selected, onClick, accent = 'var(--arcane)' }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: 14,
        borderRadius: 8,
        background: 'var(--bg-card)',
        border: selected ? `2px solid ${accent}` : '1px solid var(--border)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{name}</div>
        {selected && <Icon name="check" size={16} style={{ color: accent }} />}
      </div>
      {note && <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.45 }}>{note}</div>}
    </button>
  );
}
