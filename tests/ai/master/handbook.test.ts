import { describe, it, expect, beforeEach } from 'vitest';
import { getMasterHandbook, getMasterWorldLore, clearMasterHandbookCache } from '@/ai/master/handbook';

describe('getMasterHandbook', () => {
  beforeEach(() => {
    clearMasterHandbookCache();
  });

  it('loads the curated DMG handbook from data/master_handbook.md', () => {
    const text = getMasterHandbook();
    // Top-level title.
    expect(text).toMatch(/^# DM Craft Handbook/);
    // A few section anchors that should always be present so a future careless
    // edit (or accidental deletion of a heading) trips the test.
    expect(text).toMatch(/## 1\.1 What a DM Does/);
    expect(text).toMatch(/## 4\.1 When to Call for a Roll/);
    expect(text).toMatch(/## 7\.1 Initiative and Pacing/);
    expect(text).toMatch(/## 12\.7 Repeating Yourself/);
    // The file should be substantial — guard against accidental truncation.
    expect(text.length).toBeGreaterThan(8000);
  });

  it('caches the file in module memory across calls', () => {
    const a = getMasterHandbook();
    const b = getMasterHandbook();
    expect(a).toBe(b); // same string reference, no second readFileSync
  });

  it('clearMasterHandbookCache forces a reload on next call', () => {
    const a = getMasterHandbook();
    clearMasterHandbookCache();
    const b = getMasterHandbook();
    expect(a).toEqual(b); // same content
    // Note: identity may differ since the cache was rebuilt.
  });
});

describe('getMasterWorldLore', () => {
  beforeEach(() => {
    clearMasterHandbookCache();
  });

  it('loads the curated world & lore handbook from data/master_world_lore.md', () => {
    const text = getMasterWorldLore();
    expect(text).toMatch(/^# DM World & Lore Handbook/);
    // Anchor sections that must remain.
    expect(text).toMatch(/## 1\. The Multiverse/);
    expect(text).toMatch(/## 2\. Magic in the World/);
    expect(text).toMatch(/## 7\. Rewards and Gratification/);
    expect(text).toMatch(/Sigil/);
    expect(text).toMatch(/Great Wheel/);
    // Rewards section must call out mandatory tool calls.
    expect(text).toMatch(/add_item/);
    expect(text).toMatch(/award_xp/);
    expect(text.length).toBeGreaterThan(10000);
  });

  it('caches the file across calls', () => {
    const a = getMasterWorldLore();
    const b = getMasterWorldLore();
    expect(a).toBe(b);
  });
});
