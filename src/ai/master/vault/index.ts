// Barrel export for the markdown vault layer.
// Phase 01 (vault-llm-wiki migration) — read path + 3-tool surface.
// Phase 02 (vault-write-path-event-sourcing) — events.md + projector + 4th tool.
//
// See:
//   .planning/phases/01-vault-read-path/PLAN.md (Phase 01 overview)
//   .planning/phases/02-vault-write-path-event-sourcing/PLAN.md (Phase 02 overview)
//
// Note: VAULT_CAMPAIGNS_ROOT is exported by `./path`; it was unused at runtime
// in Phase 01 (vault was read-only) and becomes the resolution root for every
// per-campaign write in Phase 02.

// Phase 01 — path primitives + read-only tool dispatch + master loop.
export * from './path';
export * from './prompt-builder';
export * from './tools';
export * from './loop';

// Phase 02 — event schema, single-writer mutex, pure projector, per-campaign paths.
export * from './events-schema'; // VaultEvent, VaultEventEnvelope, validateEvent, VAULT_EVENT_TYPES, EVENT_SCHEMA_VERSION
export * from './events-writer'; // EventsWriter
export * from './projector'; // applyEvent, replayEvents, regenerateCharacterView, regenerateAffectedViews, serializeView, parseView, parseEventsFile, INITIAL_CHARACTER_STATE
export * from './campaign-paths'; // campaignDir, eventsPath, characterViewPath, slugifyCharacterName, UUID_REGEX, assertSameVolumeForTempFiles

// Phase 02 — Coexistence gate. `resolveVaultMutations` lives outside vault/
// (in src/lib/preferences.ts) but is part of the public surface the dispatch
// callers gate on. Re-exported here so consumers can `import { ... } from
// '@/ai/master/vault'` without reaching into preferences directly.
export { resolveVaultMutations } from '@/lib/preferences';
