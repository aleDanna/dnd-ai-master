// Hand-curated background equipment grants. The CSV column
// `starting_equipment` is descriptive prose mixing catalog items (e.g. "Set
// of common clothes") and narrative props (e.g. "favor of an admirer", "pet
// mouse"). We only enumerate the catalog items here — narrative props are
// surfaced via the background's `feature` description so the master sees
// them but they don't bloat the inventory.
//
// Currency-only entries (e.g. "pouch with 10 gp") just emit a `gp` qty.

import type { KitItem } from './starting-kits';

export const BACKGROUND_EQUIPMENT: Record<string, KitItem[]> = {
  acolyte: [
    { slug: 'clothes-common', qty: 1 },
    { slug: 'emblem-holy-symbol', qty: 1 },
    { slug: 'gp', qty: 15 },
  ],
  charlatan: [
    { slug: 'clothes-fine', qty: 1 },
    { slug: 'disguise-kit', qty: 1 },
    { slug: 'gp', qty: 15 },
  ],
  criminal: [
    { slug: 'crowbar', qty: 1 },
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 15 },
  ],
  entertainer: [
    { slug: 'clothes-costume', qty: 1 },
    { slug: 'gp', qty: 15 },
  ],
  'folk-hero': [
    { slug: 'shovel', qty: 1 },
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
  'guild-artisan': [
    { slug: 'clothes-travelers', qty: 1 },
    { slug: 'gp', qty: 15 },
  ],
  hermit: [
    { slug: 'clothes-common', qty: 1 },
    { slug: 'herbalism-kit', qty: 1 },
    { slug: 'gp', qty: 5 },
  ],
  noble: [
    { slug: 'clothes-fine', qty: 1 },
    { slug: 'signet-ring', qty: 1 },
    { slug: 'gp', qty: 25 },
  ],
  outlander: [
    { slug: 'quarterstaff', qty: 1 },
    { slug: 'hunting-trap', qty: 1 },
    { slug: 'clothes-travelers', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
  sage: [
    { slug: 'ink-1-oz-bottle', qty: 1 },
    { slug: 'ink-pen', qty: 1 },
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
  sailor: [
    { slug: 'club', qty: 1 },                 // Belaying pin (treated as club)
    { slug: 'rope-silk-50ft', qty: 1 },
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
  soldier: [
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
  urchin: [
    { slug: 'dagger', qty: 1 },               // Small knife
    { slug: 'clothes-common', qty: 1 },
    { slug: 'gp', qty: 10 },
  ],
};

export function getBackgroundEquipment(backgroundSlug: string | null): KitItem[] {
  if (!backgroundSlug) return [];
  return BACKGROUND_EQUIPMENT[backgroundSlug] ?? [];
}
