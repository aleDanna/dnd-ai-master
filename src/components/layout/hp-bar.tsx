export interface HpBarProps {
  current: number;
  max: number;
}

export function HpBar({ current, max }: HpBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round((current / max) * 100)));
  const tone = pct <= 25 ? 'var(--ember)' : pct <= 50 ? 'var(--gold)' : 'var(--verdigris)';
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-sunken)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: tone, transition: 'width 220ms' }} />
    </div>
  );
}
