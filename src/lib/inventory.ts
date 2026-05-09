import type { MasterInventoryView } from '@/srd/enrich-inventory';

/**
 * Client-side categorization for an inventory list. The character payload
 * carries items as `{ slug, qty, equipped }` triples — we don't ship SRD
 * metadata to the browser, so categorization is heuristic on the slug.
 *
 * Three buckets that map to the user's mental model:
 *   - currency:  gold / silver / copper / electrum / platinum coins
 *   - equipped:  anything the character is currently wearing or wielding
 *   - other:     gear, treasure, consumables not currently in use
 *
 * Currency slugs follow D&D 5e SRD shorthand (gp/sp/cp/ep/pp). Any aliases
 * we want to recognize (e.g. "gold", "monete") get listed here.
 */
export interface InventoryItem {
  slug: string;
  qty: number;
  equipped: boolean;
}

const CURRENCY_SLUGS: Record<string, { code: 'pp' | 'gp' | 'ep' | 'sp' | 'cp'; rank: number }> = {
  pp: { code: 'pp', rank: 0 },
  gp: { code: 'gp', rank: 1 },
  ep: { code: 'ep', rank: 2 },
  sp: { code: 'sp', rank: 3 },
  cp: { code: 'cp', rank: 4 },
  // Common natural-language aliases the master might produce.
  platinum: { code: 'pp', rank: 0 },
  gold: { code: 'gp', rank: 1 },
  electrum: { code: 'ep', rank: 2 },
  silver: { code: 'sp', rank: 3 },
  copper: { code: 'cp', rank: 4 },
};

export type CurrencyCode = 'pp' | 'gp' | 'ep' | 'sp' | 'cp';

export interface CategorizedInventory {
  /** Sum of each currency code, sorted by descending rank (pp first). */
  currency: { code: CurrencyCode; qty: number }[];
  /** Items currently equipped, ordered as in the source list. */
  equipped: InventoryItem[];
  /** Everything else (gear/treasure/consumables not equipped). */
  other: InventoryItem[];
  /** Convenience: total currency converted to copper for sanity. */
  totalCopper: number;
}

const CURRENCY_TO_COPPER: Record<CurrencyCode, number> = {
  pp: 1000, // 1 pp = 10 gp = 1000 cp
  gp: 100,  // 1 gp = 100 cp
  ep: 50,   // 1 ep = 5 sp = 50 cp
  sp: 10,   // 1 sp = 10 cp
  cp: 1,
};

export function categorizeInventory(items: InventoryItem[]): CategorizedInventory {
  const currencyMap: Partial<Record<CurrencyCode, number>> = {};
  const equipped: InventoryItem[] = [];
  const other: InventoryItem[] = [];

  for (const it of items) {
    const lower = it.slug.toLowerCase();
    const cur = CURRENCY_SLUGS[lower];
    if (cur) {
      currencyMap[cur.code] = (currencyMap[cur.code] ?? 0) + it.qty;
      continue;
    }
    if (it.equipped) {
      equipped.push(it);
    } else {
      other.push(it);
    }
  }

  const currency = (Object.keys(CURRENCY_TO_COPPER) as CurrencyCode[])
    .map((code) => ({ code, qty: currencyMap[code] ?? 0 }))
    .filter((c) => c.qty > 0);

  let totalCopper = 0;
  for (const { code, qty } of currency) {
    totalCopper += qty * CURRENCY_TO_COPPER[code];
  }

  return { currency, equipped, other, totalCopper };
}

/**
 * Turn a slug like "leather-armor" or "rope-hempen" into a human-readable
 * label. The master usually writes natural slugs already; this is a fallback
 * when items are shown raw.
 */
export function slugToLabel(slug: string): string {
  if (!slug) return '';
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Decide what label to render for an inventory row, and whether to apply
 * the narrative-item visual treatment. Pure — no DB access.
 *
 * - Falls back to slugToLabel when no enriched view is supplied (older SSE
 *   tick that hasn't shipped enriched data yet).
 * - For named_items, uses `view.name` when present; appends "(narrativo)"
 *   only when `magical === false`. Magical named items get the full name
 *   without suffix (the player should see them as real items).
 */
export function formatInventoryDisplay(
  slug: string,
  view?: MasterInventoryView,
): { label: string; isNarrative: boolean } {
  if (!view) return { label: slugToLabel(slug), isNarrative: false };

  const baseName = view.name && view.name.trim() ? view.name : slugToLabel(slug);
  const isNarrative = view.kind === 'named_item' && view.magical === false;

  return {
    label: isNarrative ? `${baseName} (narrativo)` : baseName,
    isNarrative,
  };
}
