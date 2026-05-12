import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';
import type { MessageRow } from '@/sessions/client-types';

/**
 * Multiplayer gating: when `disabled` is true (composer locked because it's
 * not the viewer's turn) the textarea AND every command/roll affordance must
 * be unusable. A roll button or quick-action chip you can never send is pure
 * noise — and worse, it confuses players into thinking they can act on a
 * teammate's turn.
 */
describe('NarrativePane — disabled gating', () => {
  const masterMsg: MessageRow = {
    id: 'm1',
    sessionId: 's1',
    role: 'master',
    content: 'Roll 1d20+5 for Perception.',
    createdAt: new Date().toISOString(),
  };

  it('textarea is disabled and shows the custom placeholder', () => {
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={true}
        disabled={true}
        disabledPlaceholder="Waiting for Luffy…"
      />,
    );
    const textarea = screen.getByPlaceholderText('Waiting for Luffy…') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('Quick action buttons are disabled when locked', () => {
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={true}
        disabled={true}
        onCastSpell={vi.fn()}
      />,
    );
    // Each Quick chip should be a disabled <button>.
    for (const label of ['Skill check', 'Attack', 'Cast spell', 'Dodge', 'Short rest', 'Look up rule']) {
      const btn = screen.getByRole('button', { name: new RegExp(label, 'i') });
      expect(btn).toBeDisabled();
    }
  });

  it('inline roll buttons on master messages are suppressed when locked', () => {
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={true}
        disabled={true}
      />,
    );
    // The "Roll 1d20+5" button must NOT be rendered when the composer is
    // locked — a roll the viewer can never send is dead weight.
    expect(screen.queryByRole('button', { name: /Roll 1d20\+5/ })).toBeNull();
  });

  it('Quick + roll buttons remain interactive when NOT disabled', () => {
    render(
      <NarrativePane
        sessionId="s1"
        history={[masterMsg]}
        liveEvents={[]}
        busy={false}
        onSend={vi.fn()}
        manualRolls={true}
        disabled={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Skill check/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Roll 1d20\+5/ })).toBeInTheDocument();
  });
});
