'use client';
import * as React from 'react';

/**
 * Tiny inline-only markdown renderer for chat bubbles. We don't need a full
 * commonmark engine — the master narrates in prose and the auto-generated roll
 * messages emit at most:
 *
 *   - **bold** for emphasising the rolled number
 *   - \n line breaks
 *   - "- " bullet prefixes (for the AND-mode combined roll message)
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

  return (
    <span style={style}>
      {lines.map((line, lineIdx) => {
        const isBullet = /^\s*-\s+/.test(line);
        const content = isBullet ? line.replace(/^\s*-\s+/, '') : line;
        const inline = renderInline(content);
        return (
          <React.Fragment key={lineIdx}>
            {isBullet ? (
              <span style={{ display: 'block', paddingLeft: 16, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 4 }}>•</span>
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
