/**
 * D&D 5e currency conversion + payment helpers.
 *
 * Background: the inventory schema treats coins as plain `{slug, qty}` rows,
 * one row per denomination. The naive `remove_inventory` path subtracts qty
 * from the matching slug only — so if the master charges "3 gp" but the
 * player has `{sp: 30}` (no gp row), nothing gets debited and the player
 * pays for free. Reported as: "i soldi non vengono scalati" when the
 * conversion is needed.
 *
 * Conversion table (PHB §5.2, Equipment):
 *   1 pp = 10 gp = 100 sp = 1000 cp
 *   1 gp = 10 sp = 100 cp
 *   1 ep = 5 sp = 50 cp                (legacy, rarely used post-3.5e)
 *   1 sp = 10 cp
 *   1 cp = 1 cp
 *
 * Strategy when paying:
 *   1. If the player has enough in the REQUESTED denomination, just subtract
 *      from that row — denominations stay intact, which is the common case
 *      and what feels natural to the player ("you paid 3 gp from your gold").
 *   2. Otherwise, sum all coin denominations in cp, check the total covers
 *      the cost, subtract, and redistribute greedily (pp → gp → sp → cp).
 *      The player effectively "made change". `ep` is absorbed but never
 *      reissued because almost no campaign tracks electrum.
 *   3. If the total is still insufficient, payment is REJECTED and the
 *      original inventory is returned unchanged. The applicator surfaces
 *      this as a warning so the master can react in the next turn.
 *
 * Additions are intentionally NOT converted — when the master grants
 * "30 sp" we keep them as 30 sp in inventory, not auto-collapsed to gp.
 */

export const CURRENCY_TO_CP: Record<string, number> = {
  cp: 1,
  sp: 10,
  ep: 50,
  gp: 100,
  pp: 1000,
};

export type CurrencySlug = keyof typeof CURRENCY_TO_CP;
export const CURRENCY_SLUGS: readonly string[] = Object.keys(CURRENCY_TO_CP);

export function isCurrencySlug(slug: string): slug is CurrencySlug {
  return slug in CURRENCY_TO_CP;
}

export interface InvRow {
  slug: string;
  qty: number;
  equipped: boolean;
}

/** Sum every currency row in `inv` and return the total expressed in cp. */
export function totalCpValue(inv: InvRow[]): number {
  let total = 0;
  for (const it of inv) {
    if (isCurrencySlug(it.slug)) {
      total += it.qty * CURRENCY_TO_CP[it.slug]!;
    }
  }
  return total;
}

/** Greedy split: convert a cp amount into the four "common" denominations
 *  (pp, gp, sp, cp). Skips electrum on purpose. */
export function distributeCp(totalCp: number): { pp: number; gp: number; sp: number; cp: number } {
  let rem = Math.max(0, Math.floor(totalCp));
  const pp = Math.floor(rem / 1000); rem -= pp * 1000;
  const gp = Math.floor(rem / 100);  rem -= gp * 100;
  const sp = Math.floor(rem / 10);   rem -= sp * 10;
  const cp = rem;
  return { pp, gp, sp, cp };
}

export type PayResult =
  | { ok: true; next: InvRow[] }
  | { ok: false; reason: 'insufficient_funds'; needCp: number; haveCp: number };

/**
 * Attempt to subtract a currency payment from `inv`. Implements the
 * "simple subtract first, full conversion fallback" strategy described at
 * the top of the file.
 *
 * `qty` is the amount of coins in `slug` to charge; the cp value is
 * `qty * CURRENCY_TO_CP[slug]`. Caller must verify `isCurrencySlug(slug)`.
 */
export function payCurrency(inv: InvRow[], slug: CurrencySlug, qty: number): PayResult {
  const safeQty = Math.max(0, Math.floor(qty));
  if (safeQty === 0) return { ok: true, next: inv };

  // Fast path: enough in the requested denomination — leave other rows alone.
  const direct = inv.find((it) => it.slug === slug);
  if (direct && direct.qty >= safeQty) {
    const next = inv
      .map((it) => (it.slug === slug ? { ...it, qty: it.qty - safeQty } : it))
      .filter((it) => !(isCurrencySlug(it.slug) && it.qty <= 0));
    return { ok: true, next };
  }

  // Conversion path. Sum total cp, check funds, redistribute.
  const costCp = safeQty * CURRENCY_TO_CP[slug]!;
  const haveCp = totalCpValue(inv);
  if (haveCp < costCp) {
    return { ok: false, reason: 'insufficient_funds', needCp: costCp, haveCp };
  }

  const remainingCp = haveCp - costCp;
  const distributed = distributeCp(remainingCp);

  // Strip every currency row, then re-emit the ones with qty > 0 from the
  // greedy distribution. Non-currency rows pass through unchanged.
  const nonCurrency = inv.filter((it) => !isCurrencySlug(it.slug));
  const newCurrency: InvRow[] = [];
  if (distributed.pp > 0) newCurrency.push({ slug: 'pp', qty: distributed.pp, equipped: false });
  if (distributed.gp > 0) newCurrency.push({ slug: 'gp', qty: distributed.gp, equipped: false });
  if (distributed.sp > 0) newCurrency.push({ slug: 'sp', qty: distributed.sp, equipped: false });
  if (distributed.cp > 0) newCurrency.push({ slug: 'cp', qty: distributed.cp, equipped: false });

  return { ok: true, next: [...nonCurrency, ...newCurrency] };
}
