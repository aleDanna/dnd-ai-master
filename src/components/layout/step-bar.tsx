export interface StepBarProps {
  steps: string[];
  current: number;
}

export function StepBar({ steps, current }: StepBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '16px 32px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        overflow: 'auto',
        flexShrink: 0,
      }}
    >
      {steps.map((s, i) => {
        const isCurrent = i === current;
        const isPast = i < current;
        return (
          <div
            key={s}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              color: isCurrent ? 'var(--ink)' : isPast ? 'var(--fg)' : 'var(--fg-muted)',
              background: isCurrent ? 'var(--bone)' : isPast ? 'var(--bg-card)' : 'transparent',
              border: isPast ? '1px solid var(--border)' : '1px solid transparent',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 600,
                background: isCurrent ? 'var(--ink)' : 'transparent',
                color: isCurrent ? 'var(--bone)' : 'currentColor',
                border: !isCurrent ? '1px solid currentColor' : 'none',
                opacity: isCurrent ? 1 : 0.6,
              }}
            >
              {isPast ? '✓' : i + 1}
            </span>
            {s}
          </div>
        );
      })}
    </div>
  );
}
