import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db so buildSrdContext doesn't need a live Postgres connection.
// Each select() returns a chainable that resolves with the stub rows for
// the relevant table. We discriminate by inspecting which table was
// requested via .from(table) — drizzle calls our mock's from with the
// drizzle table object, which we identify by reference equality.

const STUB_RULES = [
  { sectionPath: '1.1 The d20 Test', anchor: 'a', markdown: 'core mechanic body' },
  { sectionPath: '2.3 Backgrounds', anchor: 'b', markdown: 'char creation body' },
  { sectionPath: '3.1 Attacks', anchor: 'c', markdown: 'combat body' },
  { sectionPath: '4.1 Blinded', anchor: 'd', markdown: 'conditions body' },
  { sectionPath: '9.1 Armor', anchor: 'e', markdown: 'equipment body' },
  { sectionPath: '12.1 Class Summary', anchor: 'f', markdown: 'class table body' },
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

import { buildSrdContext, clearSrdContextCache } from '@/ai/master/srd-context';

describe('buildSrdContext — full vs compact (Plan C)', () => {
  beforeEach(() => {
    clearSrdContextCache();
  });

  it('full build includes Classes / Races / Backgrounds rosters', async () => {
    const text = await buildSrdContext();
    expect(text).toMatch(/# Classes/);
    expect(text).toMatch(/Fighter/);
    expect(text).toMatch(/# Races/);
    expect(text).toMatch(/Human/);
    expect(text).toMatch(/# Backgrounds/);
    expect(text).toMatch(/Soldier/);
  });

  it('compact build drops Classes / Races / Backgrounds rosters', async () => {
    const text = await buildSrdContext({ compact: true });
    expect(text).not.toMatch(/# Classes/);
    expect(text).not.toMatch(/# Races/);
    expect(text).not.toMatch(/# Backgrounds/);
  });

  it('compact build keeps Conditions (frequently referenced mid-turn)', async () => {
    const text = await buildSrdContext({ compact: true });
    expect(text).toMatch(/# Conditions/);
    expect(text).toMatch(/Blinded/);
    expect(text).toMatch(/cannot attack the charmer/);
  });

  it('compact build filters rule sections to the curated set', async () => {
    const text = await buildSrdContext({ compact: true });
    // Section 1, 3, 4, 18 are in the COMPACT_RULE_SECTIONS allow-list → kept.
    expect(text).toMatch(/## 1\.1 The d20 Test/);
    expect(text).toMatch(/## 3\.1 Attacks/);
    expect(text).toMatch(/## 4\.1 Blinded/);
    expect(text).toMatch(/## 18\.1 DM-Facing/);
    // Section 2 (char creation), 9 (equipment), 12 (class summary table)
    // are NOT in the allow-list → dropped.
    expect(text).not.toMatch(/## 2\.3 Backgrounds/);
    expect(text).not.toMatch(/## 9\.1 Armor/);
    expect(text).not.toMatch(/## 12\.1 Class Summary/);
  });

  it('compact build is shorter than the full build', async () => {
    const full = await buildSrdContext();
    clearSrdContextCache();
    const compact = await buildSrdContext({ compact: true });
    expect(compact.length).toBeLessThan(full.length);
  });

  it('caches full and compact builds independently', async () => {
    const fullA = await buildSrdContext();
    const fullB = await buildSrdContext();
    expect(fullA).toBe(fullB);
    const compactA = await buildSrdContext({ compact: true });
    const compactB = await buildSrdContext({ compact: true });
    expect(compactA).toBe(compactB);
    expect(compactA).not.toBe(fullA);
  });
});
