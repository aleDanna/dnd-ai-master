import { describe, it, expect } from 'vitest';
import {
  payCurrency,
  totalCpValue,
  distributeCp,
  isCurrencySlug,
  type InvRow,
} from '@/sessions/currency';

const ROW = (slug: string, qty: number): InvRow => ({ slug, qty, equipped: false });

describe('currency helpers', () => {
  it('isCurrencySlug recognises the five PHB denominations', () => {
    expect(isCurrencySlug('cp')).toBe(true);
    expect(isCurrencySlug('sp')).toBe(true);
    expect(isCurrencySlug('ep')).toBe(true);
    expect(isCurrencySlug('gp')).toBe(true);
    expect(isCurrencySlug('pp')).toBe(true);
    expect(isCurrencySlug('longbow')).toBe(false);
    expect(isCurrencySlug('gold')).toBe(false);                     // wrong slug, must use 'gp'
  });

  it('totalCpValue sums every currency row in cp', () => {
    expect(totalCpValue([ROW('gp', 1)])).toBe(100);
    expect(totalCpValue([ROW('sp', 3)])).toBe(30);
    expect(totalCpValue([ROW('cp', 7)])).toBe(7);
    expect(totalCpValue([ROW('pp', 2), ROW('gp', 3), ROW('sp', 4), ROW('cp', 5)])).toBe(2345);
    // Non-currency items are ignored.
    expect(totalCpValue([ROW('longbow', 1), ROW('gp', 2)])).toBe(200);
    // Electrum counts in.
    expect(totalCpValue([ROW('ep', 4)])).toBe(200);
  });

  it('distributeCp converts cp back to greedy pp/gp/sp/cp', () => {
    expect(distributeCp(0)).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
    expect(distributeCp(7)).toEqual({ pp: 0, gp: 0, sp: 0, cp: 7 });
    expect(distributeCp(42)).toEqual({ pp: 0, gp: 0, sp: 4, cp: 2 });
    expect(distributeCp(305)).toEqual({ pp: 0, gp: 3, sp: 0, cp: 5 });
    expect(distributeCp(2345)).toEqual({ pp: 2, gp: 3, sp: 4, cp: 5 });
  });
});

describe('payCurrency — fast path (same denomination)', () => {
  it('subtracts directly when the player has enough in the requested coin', () => {
    const inv = [ROW('gp', 10), ROW('sp', 50), ROW('longbow', 1)];
    const r = payCurrency(inv, 'gp', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // gp goes from 10 to 7, sp untouched, item untouched
    expect(r.next.find((i) => i.slug === 'gp')?.qty).toBe(7);
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(50);
    expect(r.next.find((i) => i.slug === 'longbow')?.qty).toBe(1);
  });

  it('drops the currency row entirely when subtraction lands on exactly zero', () => {
    const inv = [ROW('gp', 5), ROW('sp', 20)];
    const r = payCurrency(inv, 'gp', 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'gp')).toBeUndefined();
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(20);
  });
});

describe('payCurrency — conversion path (mixed denominations)', () => {
  it('pays gp with silver-only purse by redistributing the remainder', () => {
    // 50 sp = 500 cp. Pay 3 gp = 300 cp. Remaining: 200 cp = 2 gp.
    const inv = [ROW('sp', 50), ROW('longbow', 1)];
    const r = payCurrency(inv, 'gp', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'gp')?.qty).toBe(2);
    expect(r.next.find((i) => i.slug === 'sp')).toBeUndefined();    // was 50 sp, all converted
    expect(r.next.find((i) => i.slug === 'longbow')?.qty).toBe(1);
  });

  it('pays gp with mixed pile and produces change in lower denominations', () => {
    // 1 gp + 25 sp = 100 + 250 = 350 cp. Pay 3 gp = 300 cp. Remaining: 50 cp = 5 sp.
    const inv = [ROW('gp', 1), ROW('sp', 25)];
    const r = payCurrency(inv, 'gp', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'gp')).toBeUndefined();
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(5);
  });

  it('pays sp from a single gold coin and produces silver change', () => {
    // 1 gp = 100 cp. Pay 7 sp = 70 cp. Remaining: 30 cp = 3 sp.
    const inv = [ROW('gp', 1)];
    const r = payCurrency(inv, 'sp', 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'gp')).toBeUndefined();
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(3);
  });

  it('pays cp from a single silver coin and produces copper change', () => {
    const inv = [ROW('sp', 1)];
    const r = payCurrency(inv, 'cp', 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'sp')).toBeUndefined();
    expect(r.next.find((i) => i.slug === 'cp')?.qty).toBe(5);
  });

  it('absorbs electrum into the total but does not re-emit it on change', () => {
    // 1 ep = 50 cp. Pay 4 sp = 40 cp. Remaining: 10 cp = 1 sp.
    const inv = [ROW('ep', 1)];
    const r = payCurrency(inv, 'sp', 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'ep')).toBeUndefined();    // converted away
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(1);
  });

  it('handles a platinum-heavy purse by giving change down to copper', () => {
    // 1 pp = 1000 cp. Pay 3 gp + 4 sp + 5 cp = 345 cp. Remaining: 655 cp = 6 gp 5 sp 5 cp.
    const inv = [ROW('pp', 1)];
    const r = payCurrency(inv, 'cp', 345);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.find((i) => i.slug === 'pp')).toBeUndefined();
    expect(r.next.find((i) => i.slug === 'gp')?.qty).toBe(6);
    expect(r.next.find((i) => i.slug === 'sp')?.qty).toBe(5);
    expect(r.next.find((i) => i.slug === 'cp')?.qty).toBe(5);
  });
});

describe('payCurrency — insufficient funds', () => {
  it('rejects when total cp value is below cost and leaves inventory unchanged', () => {
    const inv = [ROW('sp', 5), ROW('longbow', 1)];   // 50 cp total
    const r = payCurrency(inv, 'gp', 1);              // need 100 cp
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient_funds');
    expect(r.needCp).toBe(100);
    expect(r.haveCp).toBe(50);
  });

  it('rejects when the player has no currency at all', () => {
    const inv = [ROW('longbow', 1)];
    const r = payCurrency(inv, 'cp', 1);
    expect(r.ok).toBe(false);
  });
});

describe('payCurrency — edge cases', () => {
  it('treats qty <= 0 as a no-op that keeps the inventory intact', () => {
    const inv = [ROW('gp', 10)];
    const r = payCurrency(inv, 'gp', 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toEqual(inv);
  });
});
