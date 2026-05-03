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

  it('auto-rolls and appends the result when the player commits in prose without clicking', async () => {
    // Master offers 3 options, one of which needs an Intimidation check.
    // Player types "intimidisco urlando" and presses Enter without clicking.
    // The system should auto-roll the matching bullet, append the result,
    // and send it all in one outgoing message.
    const masterContent =
      'Tocca a te. Vuoi:\n' +
      '- Scoccare una freccia: tira 1d20+3 per attaccare il fuggitivo (CA 14).\n' +
      '- Inseguirlo a tutta velocità con una Corsa (Dash): nessun tiro.\n' +
      '- Fermarlo a voce con un urlo minaccioso: tira una prova di Intimidazione CD 12.';
    const messages: MessageRow[] = [
      {
        id: 'm-vuoi',
        sessionId: 's1',
        role: 'master',
        content: masterContent,
        createdAt: new Date().toISOString(),
      },
    ];
    const onSend = vi.fn();
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={onSend}
        manualRolls={true}
      />,
    );

    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'intimidisco urlando' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // onSend was called once with the player's prose + the auto-rolled
    // Intimidation result appended on a new line.
    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]![0] as string;
    expect(sent).toMatch(/^intimidisco urlando\n/);
    expect(sent).toContain('🎲');
    expect(sent).toContain('Intimidazione');
    // Sanity: the appended line includes a rolled total in bold markdown.
    expect(sent).toMatch(/I rolled \*\*\d+\*\*/);
  });

  it('does NOT auto-roll when the player text matches no bullet', async () => {
    const masterContent =
      'Tocca a te. Vuoi:\n' +
      '- Scoccare una freccia: tira 1d20+3 per attaccare il fuggitivo (CA 14).\n' +
      '- Fermarlo a voce con un urlo minaccioso: tira una prova di Intimidazione CD 12.';
    const messages: MessageRow[] = [
      {
        id: 'm-vuoi',
        sessionId: 's1',
        role: 'master',
        content: masterContent,
        createdAt: new Date().toISOString(),
      },
    ];
    const onSend = vi.fn();
    render(
      <NarrativePane
        sessionId="s1"
        history={messages}
        liveEvents={[]}
        busy={false}
        onSend={onSend}
        manualRolls={true}
      />,
    );

    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'voglio guardarmi intorno con calma' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]![0] as string;
    expect(sent).toBe('voglio guardarmi intorno con calma');
    expect(sent).not.toContain('🎲');
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
