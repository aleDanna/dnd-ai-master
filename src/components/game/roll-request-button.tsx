'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';
import { SpinningDie } from './spinning-die';
import { rollFormula, type RollRequest, type RollResult } from '@/lib/roll-parser';

export interface RollRequestButtonProps {
  request: RollRequest;
  /** Called once with the formatted result text after the dice settle. The parent
   *  typically forwards this as a player turn so the master sees the outcome. */
  onResult: (resultText: string, result: RollResult) => void;
  /** Fired the instant the user clicks (before the spinner). Used by group
   *  coordinators to lock peer buttons in OR mode the moment any one starts. */
  onStart?: () => void;
  /**
   * External lock-out. When true and the button hasn't been clicked yet, it renders
   * dim and ignores clicks. Used by the OR group coordinator to mark sibling buttons
   * as "you already chose". Has no effect once this button is past idle.
   */
  disabled?: boolean;
}

type Phase = 'idle' | 'rolling' | 'done';

export function RollRequestButton({ request, onResult, onStart, disabled = false }: RollRequestButtonProps) {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [result, setResult] = React.useState<RollResult | null>(null);

  const onClick = (): void => {
    if (phase !== 'idle' || disabled) return;
    onStart?.();
    setPhase('rolling');
    // Animation window: long enough to register as a "roll", short enough not to
    // bore. CRITICAL: the result is computed AND forwarded in the same tick the
    // spinner ends. Any post-roll delay would create a race window where the
    // user could press Enter, see the textarea has no chip yet, and trigger the
    // auto-roll-from-prose path — rolling a different number than the one shown
    // on the button.
    setTimeout(() => {
      const rolled = rollFormula(request.formula);
      setResult(rolled);
      setPhase('done');
      const text = formatResultText(request, rolled);
      onResult(text, rolled);
    }, 600);
  };

  const tone =
    request.kind === 'damage' ? 'var(--ember)' :
    request.kind === 'attack' ? 'var(--gold)' :
    request.kind === 'save'   ? 'var(--arcane)' :
    request.kind === 'check'  ? 'var(--verdigris)' :
                                 'var(--fg-muted)';

  // Idle + locked out by parent (OR group, somebody else already chose).
  const lockedOut = phase === 'idle' && disabled;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={phase !== 'idle' || disabled}
      title={lockedOut ? 'Another option was already chosen' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 12px',
        background:
          phase === 'done' ? 'rgba(122, 79, 184, 0.10)' :
          phase === 'rolling' ? 'var(--bg-card)' :
          'var(--bg-card)',
        border: `1px solid ${phase === 'done' ? 'var(--arcane)' : lockedOut ? 'var(--border)' : tone}`,
        borderRadius: 999,
        color: phase === 'done' ? 'var(--fg)' : lockedOut ? 'var(--fg-subtle)' : tone,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        cursor: phase === 'idle' && !disabled ? 'pointer' : 'default',
        opacity: lockedOut ? 0.45 : 1,
        textDecoration: lockedOut ? 'line-through' : 'none',
      }}
    >
      {phase === 'rolling' ? (
        <>
          <SpinningDie size={14} />
          <span>Rolling {request.formula}…</span>
        </>
      ) : phase === 'done' && result ? (
        <>
          <Icon name="dice" size={14} />
          <span>{request.label}</span>
          <span style={{ color: 'var(--fg-subtle)' }}>→</span>
          <strong style={{ color: 'var(--fg)' }}>{result.total}</strong>
          {result.modifier !== 0 && (
            <span style={{ color: 'var(--fg-subtle)', fontSize: 10 }}>
              ({result.rolls.join('+')}{result.modifier >= 0 ? '+' : ''}{result.modifier})
            </span>
          )}
        </>
      ) : (
        <>
          <Icon name="dice" size={14} />
          <span>Roll {request.label}</span>
        </>
      )}
    </button>
  );
}

/**
 * Format a single roll result as a player-facing chat line. Exported so the
 * AND group coordinator can reuse the exact wording when assembling a combined
 * message from multiple rolls.
 *
 * The total is bolded and unambiguous so the master LLM cannot mis-read it.
 * The optional breakdown is appended ONLY when it carries information the
 * total alone doesn't convey — multiple dice, or a non-zero modifier. For a
 * bare single d20 (e.g. 1d20 → 20) the breakdown is identical to the total
 * and showing it as "(20)" was historically confusing the model into
 * inventing a different number ("I rolled 20 for Intuito (20)." → master
 * narrated 12). Dropping the redundant parenthetical eliminates that
 * ambiguity at the source.
 */
export function formatResultText(req: RollRequest, r: RollResult): string {
  const showBreakdown = r.rolls.length > 1 || r.modifier !== 0;
  if (!showBreakdown) {
    return `🎲 I rolled **${r.total}** for ${req.label}.`;
  }
  const dice = r.rolls.join('+');
  const mod =
    r.modifier === 0 ? '' : `${r.modifier > 0 ? '+' : ''}${r.modifier}`;
  return `🎲 I rolled **${r.total}** for ${req.label} (${dice}${mod}).`;
}
