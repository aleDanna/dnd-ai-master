# Data files

This directory holds the SRD-derived game data the app uses at runtime and at seed time.

## Files

- `classes.csv`, `races.csv`, `backgrounds.csv`, `feats.csv`, `conditions.csv` — character building references.
- `spells.csv`, `monsters.csv` — game world references.
- `equipment_armor.csv`, `equipment_weapons.csv`, `equipment_gear.csv` — equipment catalogue.
- `rules.md` — narrative rules document, structured in sections for AI-agent consumption.

## Provenance

Derived from the D&D 5e SRD (Open Game License) and the Player's Handbook structural data. The original source PDFs (`DnD_BasicRules_2018.pdf`, `Player's Handbook.pdf`) are kept locally only and gitignored — they exceed git size limits and are reference material, not runtime data.

## Costs

Monetary values in CSVs use mixed units (`gp`, `sp`, `cp`, `pp`). The seeder normalizes them all to copper pieces (`*_cp`).

## Re-seeding

Running `pnpm db:seed` re-applies the data idempotently. To wipe and rebuild from scratch, use `pnpm db:reseed`.
