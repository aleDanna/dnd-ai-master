// Barrel export for the markdown vault layer (Phase 01 — vault-llm-wiki migration).
// See .planning/phases/01-vault-read-path/PLAN.md for the design overview.
// Note: VAULT_CAMPAIGNS_ROOT is exported here for Phase 02 consumers;
// it is unused at runtime in Phase 01 (vault is read-only).
export * from './path';
export * from './prompt-builder';
export * from './tools';
export * from './loop';
