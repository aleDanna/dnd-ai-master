import { describe, it, expect } from 'vitest';
import { defaultCampaignName } from '@/campaigns/default-name';

describe('defaultCampaignName', () => {
  it('formats from a character name', () => {
    expect(defaultCampaignName({ name: 'Tharion' })).toBe("Tharion's tale");
  });
  it('falls back when the character is null', () => {
    expect(defaultCampaignName(null)).toBe("Untitled's tale");
  });
  it('falls back when the character has no name', () => {
    expect(defaultCampaignName({ name: '' })).toBe("Untitled's tale");
  });
});
