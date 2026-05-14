import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon, type IconName } from '@/components/ui/icon';

const NEW_NAMES: IconName[] = [
  'image', 'menu', 'copy', 'chevron-down', 'chevron-up',
  'globe', 'compass', 'flame', 'star', 'eye',
  'moon', 'sun', 'campfire', 'axe', 'wand', 'leaf', 'music', 'fist',
];

describe('Icon — mobile additions', () => {
  for (const name of NEW_NAMES) {
    it(`renders an <svg> for ${name}`, () => {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    });
  }

  it('respects the size prop', () => {
    const { container } = render(<Icon name="star" size={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
  });

  it('renders star with fill="currentColor" (filled glyph)', () => {
    const { container } = render(<Icon name="star" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
  });
});
