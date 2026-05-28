---
phase: 07-vault-combat-playable-d2
plan: "01"
subsystem: vault-combat
tags: [vault, combat, bestiary, tool-schema, uuid-guard]
dependency_graph:
  requires: [06-01, 06-02]
  provides: [encounter-event-dispatch, srd-bestiary]
  affects: [src/ai/master/vault/tools.ts, data/vault/tools/, data/vault/handbook/monsters/]
tech_stack:
  added: []
  patterns: [ENCOUNTER_EVENT_TYPES.has guard skip, static-vault-knowledge, csv-seed-script]
key_files:
  created:
    - data/vault/tools/apply_event.md
    - scripts/seed-bestiary.ts
    - data/vault/handbook/monsters/*.md (180 files)
  modified:
    - src/ai/master/vault/tools.ts
    - data/vault/tools/index.md
    - tests/ai/master/vault/tools.test.ts
decisions:
  - UUID guard relaxation scoped to ENCOUNTER_EVENT_TYPES.has(type) O(1) check — character events retain UUID validation
  - Encounter types advertised inline in tool description strings (explicit-beats-implicit; matches spike 009 principle)
  - seed-bestiary.ts uses only Node.js built-ins (fs, path) — no new package dependencies
  - Generated monster .md files committed to repo as static vault knowledge (not DB-driven)
metrics:
  duration: "~4 min"
  completed: "2026-05-28"
  tasks_completed: 2
  files_created: 183
  files_modified: 3
---

# Phase 07 Plan 01: Tool Exposure + SRD Bestiary Seed Summary

UUID guard relaxed for ENCOUNTER_EVENT_TYPES via O(1) membership check; apply_event schema description extended with 6 encounter types + payload shapes; apply_event.md doc created; index.md updated to 4 tools; 180 SRD monster files seeded from data/monsters.csv to data/vault/handbook/monsters/.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| RED | Failing tests for D2 UUID guard skip | 182efa5 | tests/ai/master/vault/tools.test.ts |
| 1 | Relax UUID guard + extend apply_event schema + tool docs | 4214782 | tools.ts, apply_event.md, index.md |
| 2 | Seed 180-monster SRD bestiary | df02ba8 | scripts/seed-bestiary.ts, data/vault/handbook/monsters/*.md |

## Decisions Made

### UUID guard relaxation condition

Changed the guard from `type !== 'campaign_initialized'` to `type !== 'campaign_initialized' && !ENCOUNTER_EVENT_TYPES.has(type)`. The O(1) set lookup is consistent with the Phase 06 D1 routing pattern. Character events retain the UUID requirement — the test suite verifies hp_change with a non-UUID character is still rejected.

### Description extension strategy

The 6 encounter type names were added to `input_schema.properties.type.description` and their payload shapes were added to `input_schema.properties.payload.description`. This follows the Phase 03 "explicit-in-description" precedent (spike 009 principle — puts the contract in front of the model on every turn).

### seed-bestiary.ts — no package dependencies

A minimal quoted-CSV parser was written inline using Node.js built-ins only. Avoids any npm package install for a simple 180-row CSV with a single-line field pattern.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] hp_change without character hits validateEvent before UUID guard**

- **Found during:** Task 1 RED phase
- **Issue:** The TDD plan specified test (c) as `hp_change {payload: {delta: -5}}` (missing character field) asserting content contains 'UUID'. But `validateEvent` catches a missing `character` before the UUID guard runs, returning "hp_change requires {character: non-empty string, delta: number}" — not a UUID error.
- **Fix:** Adjusted test (c) to use `hp_change {payload: {character: 'pc-001', delta: -5}}` — a non-empty, non-UUID character — which correctly reaches the UUID guard. Same invariant validated (character events still rejected), more accurate test.
- **Files modified:** tests/ai/master/vault/tools.test.ts

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. All threat model dispositions from plan frontmatter confirmed mitigated:

- T-07-01 (UUID guard relaxation): `ENCOUNTER_EVENT_TYPES.has(type)` O(1) check + test (c) verifies character events still rejected.
- T-07-02 (monster id): no injection sink — encounter-local dictionary key only.
- T-07-03 (bestiary files): SRD open-licensed data, no PII/secrets.

## Known Stubs

None — no placeholder data. All 180 monster files are wired from the committed CSV. The apply_event.md doc references `<pc-uuid>` in an example (illustrative only, not rendered data).

## Self-Check: PASSED

- tools.ts: FOUND
- apply_event.md: FOUND
- index.md: FOUND
- seed-bestiary.ts: FOUND
- goblin.md: FOUND
- commit 182efa5 (RED tests): FOUND
- commit 4214782 (Task 1 feat): FOUND
- commit df02ba8 (Task 2 feat): FOUND
