import { describe, it, expect } from 'vitest';
import {
  MODE_COMBAT_BLOCK,
  MODE_NARRATIVE_BLOCK,
  MODE_EXPLORATION_BLOCK,
  MODE_BLOCKS,
  SPELLCASTING_OVERLAY_BLOCK,
} from '@/ai/master/mode-blocks';

describe('mode blocks', () => {
  it('all blocks are non-empty strings', () => {
    expect(MODE_COMBAT_BLOCK.length).toBeGreaterThan(100);
    expect(MODE_NARRATIVE_BLOCK.length).toBeGreaterThan(100);
    expect(MODE_EXPLORATION_BLOCK.length).toBeGreaterThan(100);
  });

  it('all blocks fit within the ~400 token budget (rough char/4 estimate)', () => {
    const MAX_CHARS = 2000;
    expect(MODE_COMBAT_BLOCK.length).toBeLessThan(MAX_CHARS);
    expect(MODE_NARRATIVE_BLOCK.length).toBeLessThan(MAX_CHARS);
    expect(MODE_EXPLORATION_BLOCK.length).toBeLessThan(MAX_CHARS);
  });

  it('combat block mentions initiative + concentration', () => {
    expect(MODE_COMBAT_BLOCK).toMatch(/initiative/i);
    expect(MODE_COMBAT_BLOCK).toMatch(/concentration/i);
  });

  it('narrative block contains a COMBAT INITIATION sub-block', () => {
    expect(MODE_NARRATIVE_BLOCK).toMatch(/COMBAT INITIATION/);
    expect(MODE_NARRATIVE_BLOCK).toMatch(/combat_action[^.].*subaction.*initiative/i);
  });

  it('exploration block mentions pace + vision', () => {
    expect(MODE_EXPLORATION_BLOCK).toMatch(/pace/i);
    expect(MODE_EXPLORATION_BLOCK).toMatch(/vision/i);
  });

  it('MODE_BLOCKS map covers all three modes', () => {
    expect(MODE_BLOCKS.combat).toBe(MODE_COMBAT_BLOCK);
    expect(MODE_BLOCKS.narrative).toBe(MODE_NARRATIVE_BLOCK);
    expect(MODE_BLOCKS.exploration).toBe(MODE_EXPLORATION_BLOCK);
  });
});

describe('spellcasting overlay', () => {
  it('is a non-empty string within ~600 token budget', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK.length).toBeGreaterThan(200);
    expect(SPELLCASTING_OVERLAY_BLOCK.length).toBeLessThan(3000);
  });

  it('covers slot mechanics + concentration + components', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/slot/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/concentration/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/components?/i);
  });

  it('mentions both spell attack rolls and save DC formula', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/spell attack/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/DC\s*=\s*8\s*\+\s*spellcasting/i);
  });
});
