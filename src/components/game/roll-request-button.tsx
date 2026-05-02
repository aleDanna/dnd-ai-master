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
  /** Optional override of the post-roll send delay (ms). Defaults to 700ms — long
   *  enough to read the result, short enough not to feel sluggish. */
  sendDelayMs?: number;
}

type Phase = 'idle' | 'rolling' | 'done';

export function RollRequestButton({ request, onResult, sendDelayMs = 700 }: RollRequestButtonProps) {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [result, setResult] = React.useState<RollResult | null>(null);

  const onClick = (): void => {
    if (phase !== 'idle') return;
    setPhase('rolling');
    // Animation window: long enough to register as a "roll", short enough not to bore.
    setTimeout(() => {
      const rolled = rollFormula(request.formula);
      setResult(rolled);
      setPhase('done');
      // Give the user a beat to see the number, then forward to the master.
      setTimeout(() => {
        const text = formatResultText(request, rolled);
        onResult(text, rolled);
      }, sendDelayMs);
    }, 600);
  };

  const tone =
    request.kind === 'damage' ? 'var(--ember)' :
    request.kind === 'attack' ? 'var(--gold)' :
    request.kind === 'save'   ? 'var(--arcane)' :
    request.kind === 'check'  ? 'var(--verdigris)' :
                                 'var(--fg-muted)';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={phase !== 'idle'}
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
        border: `1px solid ${phase === 'done' ? 'var(--arcane)' : tone}`,
        borderRadius: 999,
        color: phase === 'done' ? 'var(--fg)' : tone,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        cursor: phase === 'idle' ? 'pointer' : 'default',
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

function formatResultText(req: RollRequest, r: RollResult): string {
  const breakdown =
    r.rolls.length === 1 && r.modifier === 0
      ? `${r.rolls[0]}`
      : r.modifier !== 0
        ? `${r.rolls.join('+')}${r.modifier >= 0 ? '+' : ''}${r.modifier}`
        : r.rolls.join('+');
  return `🎲 I rolled **${r.total}** for ${req.label} (${breakdown}).`;
}
