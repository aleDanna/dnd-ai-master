import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';
import type { MessageRow } from '@/sessions/client-types';

/**
 * Pagination tests: the chat shows only the most recent 10 messages by
 * default; a "Show previous" link reveals 10 more above with each click.
 */
function makeMessages(n: number): MessageRow[] {
  const out: MessageRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m-${i}`,
      sessionId: 's1',
      role: i % 2 === 0 ? 'master' : 'player',
      content: `MSG#${i}`,
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    });
  }
  return out;
}

describe('NarrativePane — pagination', () => {
  it('renders only the last 10 messages on first paint when history is longer', () => {
    const messages = makeMessages(25);
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );

    // The 15 oldest messages are NOT in the DOM.
    for (let i = 0; i < 15; i++) {
      expect(screen.queryByText(`MSG#${i}`)).toBeNull();
    }
    // The 10 newest are present.
    for (let i = 15; i < 25; i++) {
      expect(screen.getByText(`MSG#${i}`)).toBeInTheDocument();
    }
  });

  it('shows "Show previous" link with the hidden count', () => {
    const messages = makeMessages(25);
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );
    const link = screen.getByRole('button', { name: /Show previous 10 messages/i });
    expect(link).toBeInTheDocument();
    // 25 - 10 = 15 hidden; the link badge should mention the total
    // hidden count when it's larger than one page.
    expect(link.textContent).toContain('15 hidden');
  });

  it('clicking "Show previous" reveals the next 10 older messages above', () => {
    const messages = makeMessages(25);
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Show previous 10 messages/i }));

    // Now we see the last 20 messages (5..24). The first 5 are still hidden.
    for (let i = 0; i < 5; i++) {
      expect(screen.queryByText(`MSG#${i}`)).toBeNull();
    }
    for (let i = 5; i < 25; i++) {
      expect(screen.getByText(`MSG#${i}`)).toBeInTheDocument();
    }

    // Link is still there, now showing only 5 hidden (no extra "· N hidden"
    // badge because hiddenCount is exactly one page).
    const link = screen.getByRole('button', { name: /Show previous 5 messages/i });
    expect(link.textContent).not.toMatch(/hidden/);
  });

  it('hides the link entirely once all messages are visible', () => {
    const messages = makeMessages(25);
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );

    // Click twice: 10 + 10 + 10 = 30 > 25, so all visible.
    fireEvent.click(screen.getByRole('button', { name: /Show previous/i }));
    fireEvent.click(screen.getByRole('button', { name: /Show previous/i }));

    expect(screen.queryByRole('button', { name: /Show previous/i })).toBeNull();
    // Every message rendered.
    for (let i = 0; i < 25; i++) {
      expect(screen.getByText(`MSG#${i}`)).toBeInTheDocument();
    }
  });

  it('does not show the link at all when history is short (≤10 messages)', () => {
    const messages = makeMessages(7);
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /Show previous/i })).toBeNull();
    for (let i = 0; i < 7; i++) {
      expect(screen.getByText(`MSG#${i}`)).toBeInTheDocument();
    }
  });

  it('keeps the latest message visible even when a new one arrives mid-session', () => {
    const messages = makeMessages(25);
    const { rerender } = render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );
    // Sanity: latest is visible.
    expect(screen.getByText('MSG#24')).toBeInTheDocument();

    // A new message arrives — append to history, rerender.
    const newer = [...messages, {
      id: 'm-25',
      sessionId: 's1',
      role: 'master' as const,
      content: 'MSG#25',
      createdAt: new Date(2026, 0, 1, 1, 0, 0).toISOString(),
    }];
    rerender(
      <NarrativePane
        sessionId="s1"
        history={newer}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={false}
      />,
    );

    // The new message is in view (and the oldest of the previous window
    // — MSG#15 — has scrolled out as expected).
    expect(screen.getByText('MSG#25')).toBeInTheDocument();
    expect(screen.queryByText('MSG#15')).toBeNull();
  });
});
