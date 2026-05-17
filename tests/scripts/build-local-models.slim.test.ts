import { describe, it, expect, vi } from 'vitest';

// Mock the db so buildSrdContext (called by buildStaticSystemContent) doesn't
// need a live Postgres connection. Pattern copied verbatim from
// tests/ai/master/srd-context.test.ts.

const STUB_RULES = [
  { sectionPath: '1.1 The d20 Test', anchor: 'a', markdown: 'core mechanic body' },
  { sectionPath: '3.1 Attacks', anchor: 'c', markdown: 'combat body' },
  { sectionPath: '4.1 Blinded', anchor: 'd', markdown: 'conditions body' },
  { sectionPath: '18.1 DM-Facing', anchor: 'g', markdown: 'dm rules body' },
];
const STUB_CLASSES = [
  { name: 'Fighter', hitDie: 'd10', savingThrows: ['STR', 'CON'] },
];
const STUB_RACES = [
  { name: 'Human', parentRaceSlug: null },
];
const STUB_BACKGROUNDS = [
  { name: 'Soldier', skillProficiencies: ['Athletics', 'Intimidation'] },
];
const STUB_CONDITIONS = [
  { name: 'Blinded', description: 'cannot see' },
  { name: 'Charmed', description: 'cannot attack the charmer' },
];

vi.mock('@/db/schema', () => ({
  srdRuleDoc: { __tag: 'rules' },
  srdClass: { __tag: 'classes' },
  srdRace: { __tag: 'races' },
  srdBackground: { __tag: 'backgrounds' },
  srdCondition: { __tag: 'conditions' },
}));

vi.mock('@/db/client', () => {
  const rowsFor = (table: { __tag: string }): unknown[] => {
    switch (table.__tag) {
      case 'rules':       return STUB_RULES;
      case 'classes':     return STUB_CLASSES;
      case 'races':       return STUB_RACES;
      case 'backgrounds': return STUB_BACKGROUNDS;
      case 'conditions':  return STUB_CONDITIONS;
      default:            return [];
    }
  };
  return {
    db: {
      select: () => ({
        from: (table: { __tag: string }) => ({
          orderBy: async () => rowsFor(table),
        }),
      }),
    },
  };
});

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

describe('Plan E.2 selective Phase 3: per-base manifest', () => {
  it('isLarge=true OMITS MASTER_HANDBOOK_ULTRA_SLIM', async () => {
    const content = await buildStaticSystemContent({ isLarge: true });
    expect(content).not.toMatch(/# DM CRAFT - CORE PRINCIPLES/);
    // Other blocks still present
    expect(content).toMatch(/# ROLE\b/);
    expect(content).toMatch(/# TOOL USAGE RULES\b/);
  });

  it('isLarge=false KEEPS MASTER_HANDBOOK_ULTRA_SLIM (backward compat default)', async () => {
    const content = await buildStaticSystemContent({ isLarge: false });
    expect(content).toMatch(/# DM CRAFT - CORE PRINCIPLES/);
  });

  it('isLarge=true content is strictly shorter than isLarge=false', async () => {
    const lean = await buildStaticSystemContent({ isLarge: true });
    const guard = await buildStaticSystemContent({ isLarge: false });
    expect(lean.length).toBeLessThan(guard.length);
    // ultra-slim ~1KB chars; lean should be ~400-1200 chars shorter
    expect(guard.length - lean.length).toBeGreaterThan(400);
  });
});
