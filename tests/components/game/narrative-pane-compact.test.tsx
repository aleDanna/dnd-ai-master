import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';

describe('NarrativePane compact prop', () => {
  it('hides the quick-action bar when compact=true', () => {
    render(
      <NarrativePane
        sessionId="sess-1"
        history={[]}
        liveEvents={[]}
        busy={false}
        onSend={() => {}}
        manualRolls={false}
        compact
      />,
    );
    expect(screen.queryByRole('button', { name: /Skill check/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Attack$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dodge/i })).toBeNull();
  });

  it('shows the quick-action bar when compact is false (default)', () => {
    render(
      <NarrativePane
        sessionId="sess-1"
        history={[]}
        liveEvents={[]}
        busy={false}
        onSend={() => {}}
        manualRolls={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Skill check/i })).toBeInTheDocument();
  });
});
