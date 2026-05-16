import { describe, it, expect } from 'vitest';
import { buildStaticSystemContent } from '../../scripts/build-local-models';

describe('Plan E.1 slim baked manifest', () => {
  it('includes slim BASE, slim TOOL_CONTRACT, ultra-slim HANDBOOK', async () => {
    const content = await buildStaticSystemContent();
    expect(content).toMatch(/# ROLE\b/); // BASE_SLIM marker
    expect(content).toMatch(/# TOOL USAGE RULES\b/); // TOOL_CONTRACT_SLIM marker
    expect(content).toMatch(/# DM CRAFT - CORE PRINCIPLES\b/); // HANDBOOK_ULTRA_SLIM marker
  });

  it('does NOT include MASTER_WORLD_LORE content (dropped from baked)', async () => {
    const content = await buildStaticSystemContent();
    // World lore content has distinctive sections; verify none appear.
    expect(content).not.toMatch(/^# WORLD LORE/m);
    expect(content).not.toMatch(/^## COSMOLOGY/m);
  });

  it('does NOT include standalone MASTER_ROLL_TRIGGERS block (absorbed in mode blocks)', async () => {
    const content = await buildStaticSystemContent();
    expect(content).not.toMatch(/# ROLL TRIGGERS/);
  });

  it('still includes SRD_CONTEXT compact intact (per design decision)', async () => {
    const content = await buildStaticSystemContent();
    // SRD context content varies but should mention abilities, skills, or similar.
    expect(content).toMatch(/(abilities|skills|conditions|Strength|Dexterity)/i);
  });

  it('total baked content fits within ~7K tok ceiling', async () => {
    const content = await buildStaticSystemContent();
    const tokens = Math.ceil(content.length / 4);
    expect(tokens).toBeLessThanOrEqual(7500);
  });
});
