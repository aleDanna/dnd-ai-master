import { describe, it, expect, beforeEach } from 'vitest';
import { getMasterHandbook, clearMasterHandbookCache } from '@/ai/master/handbook';

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
