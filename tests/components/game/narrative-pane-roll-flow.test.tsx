import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';
import type { MessageRow } from '@/sessions/client-types';

/**
 * End-to-end flow tests for the manual-rolls UX.
 *
 * Critical invariant: a rolled number must NEVER end up inside the editable
 * textarea. The textarea is reserved for the player's free-text prose; the
 * roll result lives in a separate read-only "chip" beside the input. This is
 * what prevents the player from rewriting the rolled number ("3" → "17")
 * before pressing Send.
 */
describe('NarrativePane — manual roll flow', () => {
  const masterMsg: MessageRow = {
    id: 'm1',
    sessionId: 's1',
    role: 'master',
    content: 'Roll 1d6+1 for damage. Conferma: stavi mirando alla sentinella o al fuggitivo?',
    createdAt: new Date().toISOString(),
  };

  it('shows the roll result as a read-only chip — NOT inside the editable textarea', async () => {
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

    const rollButton = screen.getByRole('button', { name: /Roll 1d6\+1/ });
    fireEvent.click(rollButton);

    // 600ms spinner + 700ms post-roll delay + setTimeout(0) for focus.
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { vi.advanceTimersByTime(700); });
    await act(async () => { vi.advanceTimersByTime(1); });

    // Tamper-resistance: the rolled number is NOT in the textarea.
    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    // It IS rendered as a read-only chip with a status role.
    const chip = screen.getByRole('status', { name: /Pending dice roll/i });
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toMatch(/I rolled.*1d6\+1/);
    // And no message has been sent yet — the player chooses when to send.
    expect(onSend).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('combines the chip text with the textarea prose on submit', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Roll 1d6\+1/ }));
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { vi.advanceTimersByTime(700); });
    await act(async () => { vi.advanceTimersByTime(1); });

    // Player types target context.
    const textarea = screen.getByPlaceholderText('What do you do?') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'la sentinella' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]![0] as string;
    // Prose first, then the (unmodified, system-generated) roll line.
    expect(sent).toMatch(/^la sentinella\n.*I rolled \*\*\d+\*\* for 1d6\+1/s);

    vi.useRealTimers();
  });

  it('discarding the chip removes the pending roll without sending', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Roll 1d6\+1/ }));
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { vi.advanceTimersByTime(700); });
    await act(async () => { vi.advanceTimersByTime(1); });

    // Discard the chip.
    const discardBtn = screen.getByRole('button', { name: /Discard pending roll/i });
    fireEvent.click(discardBtn);

    // Chip is gone. Textarea still empty. onSend not called.
    expect(screen.queryByRole('status', { name: /Pending dice roll/i })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('auto-rolls and appends the result when the player commits in prose without clicking', async () => {
    // Master offers 3 options, one of which needs an Intimidation check.
    // Player types "intimidisco urlando" and presses Enter without clicking.
    // The system rolls server-side at submit time and bundles the result —
    // the player never gets a chance to edit the number.
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

    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]![0] as string;
    expect(sent).toMatch(/^intimidisco urlando\n/);
    expect(sent).toContain('🎲');
    expect(sent).toContain('Intimidazione');
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
});
