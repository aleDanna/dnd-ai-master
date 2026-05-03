'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { xpProgress } from '@/engine/xp';

export interface XpBarProps {
  /** Current character level (1-20). */
  level: number;
  /** Cumulative XP. */
  xp: number;
}

/**
 * Progress bar showing the character's experience inside the current level.
 * The bar fills from the level's starting XP to the next level's threshold;
 * the readout below reports the within-level progress and the absolute total.
 *
 * At level 20 the bar is full and the next-level row collapses to a "MAX
 * LEVEL" badge — there's no progression target left.
 */
export function XpBar({ level, xp }: XpBarProps) {
  const p = xpProgress(xp, level);

  return (
    <section aria-label="Character experience">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <Eyebrow>Level {p.level}</Eyebrow>
        {p.atMaxLevel ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: 0.6,
              color: 'var(--gold)',
              textTransform: 'uppercase',
            }}
          >
            MAX
          </span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--fg-subtle)',
              fontVariantNumeric: 'tabular-nums',
            }}
            aria-label={`${p.intoLevel} of ${p.spanForLevel} XP toward level ${p.level + 1}`}
          >
            {p.intoLevel.toLocaleString()} / {p.spanForLevel.toLocaleString()}
          </span>
        )}
      </div>

      {/* Progress track */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p.fraction * 100)}
        aria-label="Experience to next level"
        style={{
          height: 8,
          width: '100%',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(p.fraction * 100)}%`,
            background: p.atMaxLevel ? 'var(--gold)' : 'var(--arcane)',
            transition: 'width 0.4s ease-out',
          }}
        />
      </div>

      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
        Total {p.xp.toLocaleString()} XP
        {!p.atMaxLevel && p.nextLevelStart !== null && (
          <> · Next at {p.nextLevelStart.toLocaleString()}</>
        )}
      </div>
    </section>
  );
}
