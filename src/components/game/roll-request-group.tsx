'use client';
import * as React from 'react';
import { RollRequestButton, formatResultText } from './roll-request-button';
import type { RollRequest, RollResult } from '@/lib/roll-parser';

export interface RollRequestGroupProps {
  /** Roll requests parsed from a single master message. All share the same groupMode. */
  requests: RollRequest[];
  /**
   * Forwarded once per group (not once per button). The parent typically posts the
   * text as a player turn so the master sees the outcome.
   *
   * - In OR mode: called the instant the first roll settles, with that single roll's text.
   * - In AND mode: called when the LAST roll settles, with a combined multi-line text.
   */
  onSend: (resultText: string) => void;
}

interface RolledItem {
  /** The original request. */
  request: RollRequest;
  /** The numeric result + breakdown. */
  result: RollResult;
  /** The formatted single-roll line (matches the OR-mode wording). */
  text: string;
}

/**
 * Coordinates a set of roll buttons that came from the same master message.
 *
 * **OR mode** (mutually exclusive options or conditional second roll):
 * - The first button click starts the spinner and immediately disables every peer.
 * - When that single roll settles, its text is forwarded to onSend (mirrors the
 *   classic single-button behaviour).
 *
 * **AND mode** (every roll required, e.g. two saves):
 * - All buttons stay clickable. The user must click each one.
 * - Each settled roll is buffered locally and the group shows a "X / N rolled"
 *   progress chip.
 * - When the last button settles, onSend fires once with a combined multi-line
 *   message listing every result.
 */
export function RollRequestGroup({ requests, onSend }: RollRequestGroupProps) {
  // OR mode: the moment any peer starts rolling, sibling buttons lock out so a
  // racing double-click can't fire two messages. We track the index that started
  // first; everyone else is dimmed.
  const [orStartedAt, setOrStartedAt] = React.useState<number | null>(null);

  // AND mode buffer. Keyed by the request index (already unique per message).
  const [rolled, setRolled] = React.useState<Record<number, RolledItem>>({});

  // Single-shot guard: forward to onSend at most once per group, regardless of
  // mode. The ref is read inside event handlers only (race-safe across rapid
  // clicks); the mirrored state drives the render-side bits like hiding the
  // progress chip after the group is complete.
  const sentRef = React.useRef(false);
  const [groupSent, setGroupSent] = React.useState(false);

  // Snapshot the mode once. Every request in a group carries the same groupMode,
  // but if the upstream stream re-parses while the master is still typing the
  // mode could in theory flip mid-group. We pin the first non-empty value.
  const groupMode = requests[0]?.groupMode ?? 'or';

  const handleStart = (req: RollRequest) => (): void => {
    if (groupMode === 'or' && orStartedAt === null) {
      setOrStartedAt(req.index);
    }
  };

  const handleResult = (req: RollRequest) => (text: string, result: RollResult): void => {
    if (sentRef.current) return;

    if (groupMode === 'or') {
      // First click wins: send the single-roll text and lock the group.
      sentRef.current = true;
      setGroupSent(true);
      onSend(text);
      return;
    }

    // AND mode: stash this result. If it's the last one, emit combined.
    setRolled((prev) => {
      const next: Record<number, RolledItem> = { ...prev, [req.index]: { request: req, result, text } };
      const allDone = Object.keys(next).length === requests.length;
      if (allDone && !sentRef.current) {
        sentRef.current = true;
        setGroupSent(true);
        const combined = formatCombinedResult(
          requests.map((r) => next[r.index]!),
        );
        onSend(combined);
      }
      return next;
    });
  };

  const doneCount = Object.keys(rolled).length;
  const showProgress = groupMode === 'and' && requests.length > 1 && !groupSent;

  return (
    <>
      {requests.map((req) => (
        <RollRequestButton
          key={`roll-${req.index}`}
          request={req}
          onStart={handleStart(req)}
          onResult={handleResult(req)}
          disabled={groupMode === 'or' && orStartedAt !== null && orStartedAt !== req.index}
        />
      ))}
      {showProgress && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            borderRadius: 999,
            border: '1px dashed var(--border-strong)',
            color: 'var(--fg-subtle)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
          aria-live="polite"
        >
          {doneCount}/{requests.length} rolled
        </span>
      )}
    </>
  );
}

/**
 * Build the combined player-side message for an AND group. Format:
 *
 * ```
 * 🎲 I rolled:
 * - <single-roll line>
 * - <single-roll line>
 * ```
 *
 * Each line reuses formatResultText() so the wording matches what the master
 * sees from a single-roll OR group, just stripped of the leading dice emoji
 * (which becomes the header instead).
 */
function formatCombinedResult(items: RolledItem[]): string {
  const lines = items.map(({ request, result }) => {
    const single = formatResultText(request, result);
    // formatResultText prefixes "🎲 I rolled" — strip that to make a clean bullet.
    return '- ' + single.replace(/^🎲\s*I rolled\s*/i, '').replace(/\.$/, '');
  });
  return `🎲 I rolled:\n${lines.join('\n')}`;
}
