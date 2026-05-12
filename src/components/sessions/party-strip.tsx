'use client';

export type PartyStripProps = {
  party: Array<{ id: string; name: string; raceSlug: string; classSlug: string; level: number }>;
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

/**
 * Sticky multiplayer party roster. The pill of the character whose turn is
 * active is **always** rendered as a saturated accent chip with a leading
 * pulse dot and an explicit "Turn" label, so a glance back to the strip
 * tells the table exactly who's up. The viewer's own chip is italicised and
 * tagged with "(you)" so they can spot themselves without scanning names.
 */
export function PartyStrip({ party, currentPlayerCharacterId, viewerCharacterId }: PartyStripProps) {
  // Surface the active player's name explicitly in the lead label — even
  // when the strip overflows horizontally on a narrow viewport, the
  // "Turn · <name>" eyebrow stays anchored on the left.
  const activeName = party.find((p) => p.id === currentPlayerCharacterId)?.name ?? null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        marginBottom: 12,
        alignItems: 'center',
        overflowX: 'auto',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 6,
          marginRight: 4,
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}
        aria-live="polite"
      >
        <span style={{ color: 'var(--fg-subtle)' }}>Turn</span>
        {activeName && (
          <span style={{ color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'none', fontSize: 13 }}>
            {activeName}
          </span>
        )}
      </div>

      {party.map((p) => {
        const isActive = p.id === currentPlayerCharacterId;
        const isMe = p.id === viewerCharacterId;
        return (
          <div
            key={p.id}
            aria-current={isActive ? 'true' : undefined}
            title={isActive ? `${p.name} — turno attivo` : p.name}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: isActive ? '6px 12px' : '4px 10px',
              borderRadius: 999,
              // Saturated accent fill on active; muted neutral on the rest.
              // The contrast gap is the whole point — a glance must tell you.
              background: isActive ? 'var(--accent)' : 'transparent',
              border: '1px solid ' + (isActive ? 'var(--accent)' : 'var(--border)'),
              color: isActive ? 'var(--fg-on-accent)' : (isMe ? 'var(--fg)' : 'var(--fg-muted)'),
              fontSize: 12,
              fontWeight: isActive ? 700 : isMe ? 600 : 400,
              fontStyle: isMe ? 'italic' : 'normal',
              whiteSpace: 'nowrap',
              boxShadow: isActive ? '0 0 0 3px rgba(215, 51, 28, 0.22)' : 'none',
              transition: 'background 160ms ease-out, box-shadow 200ms ease-out, color 160ms ease-out',
              flexShrink: 0,
            }}
          >
            {isActive && <PulseDot />}
            <span>
              {p.name}
              {isMe ? ' (you)' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Soft pulsing dot used as the leading affordance on the active-turn pill.
 * Implemented inline with a CSS keyframe injected as a `<style>` sibling so
 * the component stays drop-in (no global stylesheet edit required).
 */
function PulseDot() {
  return (
    <>
      <style>{`
        @keyframes party-strip-pulse {
          0%   { transform: scale(1);   opacity: 1;   }
          50%  { transform: scale(1.35); opacity: 0.6; }
          100% { transform: scale(1);   opacity: 1;   }
        }
      `}</style>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--fg-on-accent)',
          animation: 'party-strip-pulse 1.6s ease-in-out infinite',
        }}
      />
    </>
  );
}
