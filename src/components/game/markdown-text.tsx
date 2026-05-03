'use client';
import * as React from 'react';

/**
 * Tiny inline-only markdown renderer for chat bubbles. We don't need a full
 * commonmark engine — the master narrates in prose and the auto-generated roll
 * messages emit at most:
 *
 *   - **bold** for emphasising the rolled number
 *   - \n line breaks
 *   - "- " bullet prefixes — rendered as a numbered list (1., 2., 3., …)
 *     because the choice lists in master prose are easier to reference by
 *     ordinal (and the roll buttons get matching "(N)" suffixes).
 *
 * Pulling in a markdown library for that would be overkill. This renderer
 * handles exactly those three things and nothing else, so unsupported markdown
 * (e.g. links, images, headings) renders as literal text — the same way the
 * pre-renderer raw-string version did.
 */
export interface MarkdownTextProps {
  text: string;
  /** Optional additional style applied to the wrapper. */
  style?: React.CSSProperties;
}

export function MarkdownText({ text, style }: MarkdownTextProps) {
  const lines = text.split('\n');

  // Pre-pass: assign a sequential number to every "- prefix" bullet line so we
  // can render them as a numbered list (1., 2., 3., …). Numbering resets only
  // when the document ends — consecutive blocks of bullets continue the same
  // count, which matches how the master usually presents a single choice list.
  // If the master ever interleaves two distinct bullet groups separated by
  // prose, they'll keep counting upward; that's an acceptable tradeoff for the
  // common case (single choice list per turn).
  const bulletNumbers: (number | null)[] = [];
  let counter = 0;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      counter++;
      bulletNumbers.push(counter);
    } else {
      bulletNumbers.push(null);
    }
  }
  // Width in characters of the largest number — used to right-align the marker
  // column so "10." and "1." line up nicely.
  const markerWidth = `${counter}`.length;

  return (
    <span style={style}>
      {lines.map((line, lineIdx) => {
        const bulletNum = bulletNumbers[lineIdx];
        const isBullet = bulletNum !== null;
        const content = isBullet ? line.replace(/^\s*-\s+/, '') : line;
        const inline = renderInline(content);
        return (
          <React.Fragment key={lineIdx}>
            {isBullet ? (
              <span style={{ display: 'block', paddingLeft: `${markerWidth + 2}ch`, position: 'relative' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    minWidth: `${markerWidth + 1}ch`,
                    textAlign: 'right',
                    paddingRight: 4,
                    color: 'var(--fg-muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {bulletNum}.
                </span>
                {inline}
              </span>
            ) : (
              <>
                {inline}
                {lineIdx < lines.length - 1 && <br />}
              </>
            )}
          </React.Fragment>
        );
      })}
    </span>
  );
}

/**
 * Parse the bold `**...**` markers in a single line of text. Returns an array
 * of React nodes (strings + <strong>) ready to splat into JSX. Any `**` that
 * doesn't have a closing partner is left as literal characters.
 */
function renderInline(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Greedy match of paired ** ... ** with non-empty contents and no nested **.
  // The [^*] restriction prevents a "**" inside the contents from confusing pairing.
  const re = /\*\*([^*]+?)\*\*/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) out.push(line.slice(lastIndex, m.index));
    out.push(
      <strong key={`b-${key++}`} style={{ fontWeight: 700 }}>
        {m[1]}
      </strong>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) out.push(line.slice(lastIndex));
  return out;
}
