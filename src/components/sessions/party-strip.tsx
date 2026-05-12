'use client';

export type PartyStripProps = {
  party: Array<{ id: string; name: string; raceSlug: string; classSlug: string; level: number }>;
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

export function PartyStrip({ party, currentPlayerCharacterId, viewerCharacterId }: PartyStripProps) {
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '8px 12px',
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 8, marginBottom: 12,
      alignItems: 'center', overflowX: 'auto',
    }}>
      <span style={{ fontSize: 11, color: 'var(--fg-subtle)', letterSpacing: 1, textTransform: 'uppercase', marginRight: 4 }}>
        Party
      </span>
      {party.map((p) => {
        const isActive = p.id === currentPlayerCharacterId;
        const isMe = p.id === viewerCharacterId;
        return (
          <div key={p.id} style={{
            padding: '4px 10px', borderRadius: 16,
            background: isActive ? 'var(--accent)' : 'transparent',
            border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
            color: isActive ? '#000' : 'var(--fg)',
            fontSize: 12, whiteSpace: 'nowrap',
            fontWeight: isMe ? 600 : 400,
          }}>
            {isActive && <span style={{ marginRight: 4 }}>●</span>}
            {p.name}{isMe ? ' (you)' : ''}
          </div>
        );
      })}
    </div>
  );
}
