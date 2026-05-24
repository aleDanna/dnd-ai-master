# Roadmap

Milestone: **Vault-LLM-Wiki Migration**

The migration is decomposed into 3 phases. Each phase ships independently (the system remains functional via the existing Postgres+RAG path until cutover in Phase 03).

## Phase 01: Vault Read Path

**Goal:** The LLM master can answer rules/lore questions using ONLY the markdown vault for static knowledge, with no RAG retrieval and no `MASTER_TOOL_CONTRACT` injection. Behind a feature flag — the existing baked-variant + RAG path is untouched.

**Scope:**
- Vault layout scaffolded under `data/vault/` (handbook + tools dirs)
- Static handbook + lore migrated from existing `data/master_handbook.md` + `data/master_world_lore.md` into per-entity markdown files
- New tool surface: `read_vault_multi`, `list_vault`, `end_turn` exposed via Ollama tool calls
- `SystemPromptBuilder` pure function (REQ-022)
- ESLint rule + CI test for prompt stability
- Lenient discovery protocol (`/tools/index.md`)
- Feature flag `MASTER_BACKEND=vault|baked` at request level
- M4 benchmark gate: re-run spike 003 + 011 setup against the integrated Next.js path, confirm warm wall-clock < 10s

**Success criteria:**
- ✓ A turn that asks "Quanto danno fa Fireball al livello 5?" works end-to-end via vault path
- ✓ `prompt_eval_count` per turn drops from ~8,800 (baked) to ~3,000-5,000 (vault) — measured in `ai_usage`
- ✓ Warm wall-clock turn < 10s on M4 (measured via existing telemetry)
- ✓ Feature flag toggle works in both directions (baked ↔ vault) per request
- ✓ All existing E2E tests pass with `MASTER_BACKEND=baked` (default)
- ✓ New E2E test covers `MASTER_BACKEND=vault` happy path on 5 rules-lookup turns

**Depends on:** none (foundation)

**Requirements:** REQ-001, REQ-002, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-021, REQ-022, REQ-030, REQ-033

---

## Phase 02: Vault Write Path (Event Sourcing)

**Goal:** Game-state mutations (HP changes, condition adds, spell-slot use, narrative events) write to `events.md` via `EventsWriter`, with materialized views (`characters/<name>.md`, session logs) regenerated on read. Still behind feature flag — Postgres remains the source of truth for any campaign not opted in.

**Scope:**
- `EventsWriter` class with in-process Map<path, Promise> mutex (spike 010 pattern)
- `apply_event(type, payload)` Ollama tool exposed in the LLM tool surface
- Event projector module: converts events.md → in-memory state, then serializes to `characters/<name>.md` frontmatter
- Event type schema: `hp_change`, `condition_add`, `condition_remove`, `spell_slot_use`, `spell_slot_restore`, `inventory_add`, `inventory_remove`, plus extension hooks
- Materialized-view regeneration triggered by every `apply_event` call (cheap; ~5ms per regeneration for a small campaign)
- Concurrent-write smoke test in CI (100 parallel applyEvent calls, assert 0 lost — spike 010 pattern)
- Per-campaign opt-in flag: `vault_mutations: true` in campaign settings

**Success criteria:**
- ✓ A turn that resolves combat damage produces an `apply_event` tool call that lands in `events.md` AND updates `characters/<name>.md` frontmatter atomically
- ✓ Concurrent stress test (100 parallel applyEvents on same campaign) passes with 0 lost / 0 corrupted / 0 duplicated
- ✓ Restart of Next.js server preserves state via events.md replay on session resume
- ✓ Both backends (Postgres + Vault) can run side-by-side per campaign (some campaigns opted in, others not)
- ✓ Property test: round-trip serialization (event → state → view → assert state derivable back)

**Depends on:** Phase 01

**Requirements:** REQ-004, REQ-005, REQ-006, REQ-010

---

## Phase 03: Migration & Cutover

**Goal:** Existing Postgres campaigns (campaigns + characters + session_state) exported to vault format. Dual-write coexistence period validates parity. Cutover flips source-of-truth to vault. RAG layer (pgvector + embedder) retired. Baked variants other than `dnd-master-plus` regression-baseline removed.

**Scope:**
- Export script: `scripts/migrate-campaigns-to-vault.ts` — reads Postgres campaigns, generates `events.md` + materialized views per campaign
- Dual-write coexistence layer: both Postgres and Vault receive mutations; reconciliation check on every session-resume
- Divergence alarm: if Postgres and Vault states disagree, log alarm and prefer Postgres (until cutover)
- Cutover script: flip the source-of-truth flag, validate, archive Postgres tables (don't drop until +30 days)
- Decommission RAG: remove `src/ai/master/rag/*`, `scripts/build-rag-index.ts`, embedder model, `pgvector` extension
- Decommission baked variants: remove `dnd-master-{lite,max}` from build script; retain `dnd-master-plus` as regression baseline; free SSD
- Per-turn summarization implementation (REQ-023): cumulative prompt > 15K tok → condense prior 5 turns to ~200-word summary block
- Final M4 sweep: spike 004 + 011 + 014 setup re-run against the cutover state; produce a "post-migration" results bundle

**Success criteria:**
- ✓ All existing campaigns (>=1) migrated to vault format with bit-exact state reconstruction
- ✓ Dual-write divergence rate < 0.1% over 2 weeks of coexistence
- ✓ Cutover script is reversible (can flip back to Postgres if 24h post-cutover something breaks)
- ✓ M4 final sweep: G1 warm < 5s, G2 lenient 100%, narrative quality not degraded
- ✓ SSD usage drops by >30GB (no embedder model + decommissioned baked variants)
- ✓ RAG code paths fully removed; build succeeds without pgvector
- ✓ Per-turn summarization activates at 15K tok and keeps avg turn flat over a 20-turn session

**Depends on:** Phase 02

**Requirements:** REQ-006, REQ-020, REQ-023, REQ-031, REQ-032, REQ-033, REQ-034
