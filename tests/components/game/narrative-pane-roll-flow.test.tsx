import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';
import type { MessageRow } from '@/sessions/client-types';

/**
 * End-to-end flow test for the manual-rolls UX: when the player clicks a roll
 * button, the result should land in the input draft (NOT be auto-sent), so the
 * player can append context (e.g. "stavo mirando alla sentinella") before
 * pressing Enter.
 */
describe('NarrativePane — manual roll flow', () => {
  const masterMsg: MessageRow = {
    id: 'm1',
    sessionId: 's1',
    role: 'master',
    content: 'Roll 1d6+1 for damage. Conferma: stavi mirando alla sentinella o al fuggitivo?',
    createdAt: new Date().toISOString(),
  };

  it('populates the input draft instead of auto-sending when a roll settles', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={onSend}
        manualRolls={true}
      />,
    );

    // The master message is in OR mode (single roll), so one button shows up.
    const rollButton = screen.getByRole('button', { name: /Roll 1d6\+1/ });
    expect(rollButton).toBeInTheDocument();

    fireEvent.click(rollButton);

    // 600ms spinner + 700ms post-roll delay. Advance both.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    // Flush the queued setTimeout(0) for the focus + cursor placement.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // The input should now contain the roll result text.
    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/I rolled \*\*\d+\*\* for 1d6\+1/);
    // And critically, onSend was NOT called — auto-send is disabled.
    expect(onSend).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('appends to existing draft text on a new line instead of clobbering', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={onSend}
        manualRolls={true}
      />,
    );

    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    // Player has typed their target choice first.
    fireEvent.change(textarea, { target: { value: 'la sentinella' } });

    fireEvent.click(screen.getByRole('button', { name: /Roll 1d6\+1/ }));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // Existing text preserved, roll result appended on a new line.
    expect(textarea.value).toMatch(/^la sentinella\n.*1d6\+1/s);
    expect(onSend).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
