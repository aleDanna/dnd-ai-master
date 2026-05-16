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

describe('getMasterHandbook({ compact: true }) — Plan C', () => {
  beforeEach(() => {
    clearMasterHandbookCache();
  });

  it('loads the compact handbook from data/master_handbook_compact.md', () => {
    const text = getMasterHandbook({ compact: true });
    expect(text).toMatch(/compact — local-model variant/);
    expect(text).toMatch(/## 4\. Resolving Outcomes/);
    expect(text).toMatch(/Very easy 5/);
  });

  it('compact variant is materially smaller than the full handbook', () => {
    const full = getMasterHandbook();
    const compact = getMasterHandbook({ compact: true });
    expect(compact.length).toBeLessThan(full.length / 2);
  });

  it('caches the compact variant independently of the full variant', () => {
    const a = getMasterHandbook({ compact: true });
    const b = getMasterHandbook({ compact: true });
    expect(a).toBe(b);
    const full = getMasterHandbook();
    expect(a).not.toBe(full);
  });

  it('clearMasterHandbookCache also clears the compact caches', () => {
    const a = getMasterHandbook({ compact: true });
    clearMasterHandbookCache();
    const b = getMasterHandbook({ compact: true });
    expect(a).toEqual(b);
  });
});

describe('getMasterWorldLore({ compact: true }) — Plan C', () => {
  beforeEach(() => {
    clearMasterHandbookCache();
  });

  it('loads the compact world lore from data/master_world_lore_compact.md', () => {
    const text = getMasterWorldLore({ compact: true });
    expect(text).toMatch(/compact — local-model variant/);
    // The Rewards mandate is the one thing the compact variant must keep.
    expect(text).toMatch(/Rewards and Gratification/);
    expect(text).toMatch(/add_item/);
    expect(text).toMatch(/award_xp/);
  });

  it('compact variant is materially smaller than the full world lore', () => {
    const full = getMasterWorldLore();
    const compact = getMasterWorldLore({ compact: true });
    expect(compact.length).toBeLessThan(full.length / 2);
  });
});
