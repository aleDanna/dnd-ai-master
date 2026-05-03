import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownText } from '@/components/game/markdown-text';

describe('MarkdownText', () => {
  it('renders plain text unchanged', () => {
    const { container } = render(<MarkdownText text="hello world" />);
    expect(container.textContent).toBe('hello world');
    // No <strong>, no <br>.
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('br')).toBeNull();
  });

  it('renders **bold** as <strong>', () => {
    const { container } = render(<MarkdownText text="I rolled **10** for initiative." />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('10');
    expect(container.textContent).toBe('I rolled 10 for initiative.');
  });

  it('reproduces the screenshot scenario without literal asterisks', () => {
    // The exact text the auto-roll generates and that the user sees in the bubble.
    const text = '🎲 I rolled **10** for 1d20+1 (iniziativa) (9+1).';
    const { container } = render(<MarkdownText text={text} />);
    expect(container.textContent).toBe('🎲 I rolled 10 for 1d20+1 (iniziativa) (9+1).');
    expect(container.textContent).not.toContain('**');
  });

  it('renders multiple bold spans on the same line', () => {
    const { container } = render(<MarkdownText text="**A** and **B** rolled." />);
    const strongs = container.querySelectorAll('strong');
    expect(strongs.length).toBe(2);
    expect(strongs[0]!.textContent).toBe('A');
    expect(strongs[1]!.textContent).toBe('B');
  });

  it('preserves newlines as <br> for non-bullet lines', () => {
    const { container } = render(<MarkdownText text={'line one\nline two'} />);
    expect(container.querySelector('br')).not.toBeNull();
    // <br> contributes no text, so the two lines concatenate in textContent.
    expect(container.textContent).toBe('line oneline two');
  });

  it('renders "- prefix" lines as bulleted blocks', () => {
    const text = '🎲 I rolled:\n- **18** for DEX save\n- **14** for CON save';
    const { container } = render(<MarkdownText text={text} />);
    // At least one bullet "•" present — exact count depends on markup, just assert presence.
    expect(container.textContent).toContain('•');
    // Bold values still rendered.
    const strongs = container.querySelectorAll('strong');
    expect(strongs.length).toBe(2);
    expect(strongs[0]!.textContent).toBe('18');
    expect(strongs[1]!.textContent).toBe('14');
    // No literal markdown markers in the output.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toMatch(/^- /m);
  });

  it('leaves an unpaired ** as literal characters', () => {
    const { container } = render(<MarkdownText text="this is **broken" />);
    expect(container.textContent).toBe('this is **broken');
    expect(container.querySelector('strong')).toBeNull();
  });
});
