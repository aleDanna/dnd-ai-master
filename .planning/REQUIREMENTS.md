# Requirements

All requirements below are **LOCKED** by spike validation work (rounds 1-3 + narrative iteration, 14 spikes total). Cannot be revised without re-spiking.

## Storage layer

| REQ | Statement | Locked by |
|-----|-----------|-----------|
| REQ-001 | Vault is filesystem-only markdown. Obsidian-app is optional, never required at runtime. | `/gsd-explore` 2026-05-22 |
| REQ-002 | Static knowledge is path-deterministic: `/handbook/<category>/<id>.md` | `/gsd-explore` 2026-05-22 |
| REQ-003 | Dynamic knowledge entry point: `/campaigns/<campaign-id>/index.md` (link traversal from there) | `/gsd-explore` 2026-05-22 |
| REQ-004 | `events.md` per campaign is the source of truth. Per-entity `.md` files are materialized views. | spike 008, 010, 013 |
| REQ-005 | Mutations go through `EventsWriter` single-writer mutex per campaign_id. NEVER naive read-modify-write on frontmatter. | spike 006 (invalidated), 010 |
| REQ-006 | DR procedure: events.md is the only durable artifact needed; restore = `replay events.md → regenerate views`. Backup strategy is out-of-band (cron tarball / S3 sync / separate git repo) — see REQ-007. | spike 013 + 2026-05-24 design decision |
| REQ-007 | **Campaign data lives OUTSIDE the codebase repo.** `data/vault/` (committed) holds ONLY static content (handbook, lore, tool docs). Per-campaign dirs (`events.md` + materialized views) live under a configurable `VAULT_CAMPAIGNS_ROOT` directory, defaulting to `~/.dnd-ai-master/vault/campaigns/` (gitignored if it ends up inside the project root). Env var `VAULT_CAMPAIGNS_ROOT` overrides the default. Rationale: gameplay data is private/PII-bearing (player dialogue, narrative choices), repo would gonfiare with mutation history, and every state change would otherwise trigger a Vercel build. | 2026-05-24 design decision |

## LLM tool surface

| REQ | Statement | Locked by |
|-----|-----------|-----------|
| REQ-010 | Tool surface is fixed at 4 tools: `read_vault_multi`, `list_vault`, `apply_event`, `end_turn` | spike 009 |
| REQ-011 | NEVER expose singular `read_vault(path)` — only batched `read_vault_multi({paths: []})` | spike 009 |
| REQ-012 | Lenient discovery protocol: LLM reads `/tools/index.md` once at session start, then uses tools directly. NO strict per-tool-doc lookup. | spike 002 |
| REQ-013 | Server accepts BOTH turn terminators: `end_turn` tool call AND `no_tool_calls + content` | spike 002 |
| REQ-014 | Path sanitization on every vault read: `safeVaultPath()` returns `null` for traversal attempts | spike 001 |

## Performance

| REQ | Statement | Locked by |
|-----|-----------|-----------|
| REQ-020 | Production target hardware: Mac Mini M4 (32GB RAM, 120 GB/s, 256GB SSD). All G1 measurements must be M4-validated. | memory project_dnd_ai_master_target_hw |
| REQ-021 | Warm wall-clock per turn < 10s on M4 (target measured at 3.78s; budget room for complex turns) | spike 003, 004, 011 |
| REQ-022 | Prefix-cache hygiene: system prompt is a pure function. ESLint rule + CI test enforce no `Date.now`, `Math.random`, `process.env`, `randomUUID`, `process.hrtime`, hostnames in builder source. | spike 007, 012 |
| REQ-023 | Per-turn summarization at 15K-token boundary (condense prior turns into ~200-word summary block) | spike 011 |

## Model selection

| REQ | Statement | Locked by |
|-----|-----------|-----------|
| REQ-030 | Primary local model: `qwen3:30b-a3b-instruct-2507-q4_K_M` | spike 004, 014 |
| REQ-031 | Quality-fallback (opt-in via Settings): `qwen3:30b-a3b-instruct-2507` | spike 014 |
| REQ-032 | Offline content tool (non-default): `mistral-small3.2:24b` for voice-strong non-standard prose | spike 014 |
| REQ-033 | Drop all `dnd-master-*` baked variants from production. Build script keeps `dnd-master-plus` only as a regression-test baseline. | spike 003, 004 |
| REQ-034 | No per-turn model router in Phase 1. Switching between primary/fallback is per-session via user setting. | spike 014 |
| REQ-035 | Vault-path master must not railroad the player character — narrate world / NPCs / consequences of declared actions only; never invent the PC's actions, dialogue, decisions, or outcomes. | gemma4 experiment 2026-05-28 |

## Game mechanics (vault path)

| REQ | Statement | Locked by |
|-----|-----------|-----------|
| REQ-036 | Vault-path master must call for ability checks / saving throws (and attack/damage rolls) via the existing manual-roll surface: write parser-compatible roll requests in prose (the client renders 🎲 buttons), gated on the campaign `manualRolls` setting, reusing the proven `buildManualRollsRule` content. Prompt-only; REQ-022 byte-stability preserved. | ability-checks design 2026-05-28 |
| REQ-037 | Vault-path combat state is event-sourced: encounter-scoped events (`combat_start`, `monster_spawn`, `initiative_set`, `turn_advance`, `monster_hp_change`, `combat_end`) appended to `events.md` → projector encounter reducer → `combat.md` materialized view → snapshot wiring feeds the existing backend-agnostic `CombatTracker`. State is replayable + Postgres-free (REQ-004/007). Decomposed: D1 = state foundation (headless); D2 = LLM tools/prompt/bestiary/turn-interleaving; D3 = action economy. | combat D1 design 2026-05-28 |
| REQ-038 | Vault-path combat is LLM-playable: the master drives the D1 encounter lifecycle via `apply_event` (UUID guard relaxed for encounter events; the 6 types advertised in the tool schema), guided by a `vaultMutations`-gated "Combat lifecycle" prompt block; monsters come from a seeded SRD bestiary (`handbook/monsters/<slug>.md`, 180 from `data/monsters.csv`) plus master-invented custom bosses via the fat `monster_spawn` payload; turns interleave PCs and monsters by driving handoff from `EncounterState.turnOrder` in the turn route (master runs monster turns, hands to the PC on a PC turn; `detectAddressee` fallback; non-combat handoff unchanged); One Piece flipped to `sourceOfTruth:'vault'` so combat renders live. | combat D2 design 2026-05-28 |
| REQ-039 | Vault-path combat resolution is DETERMINISTIC / server-side: when a roll-result arrives during an active encounter, the turn route resolves the mechanics (parse roll → kind+target from label → to-hit total vs monster AC → hit/miss → damage → `monster_hp_change` → `turn_advance`) reusing the engine math (`makeAttack`/`applyDamage`/`dice`), and the LLM only NARRATES the server-determined outcome. Fixes the local-model ceiling found in the D2 smoke (models free-narrate outcomes, ignore the rolled number, never apply HP/turns). Decomposed: v1 = player attacks (needs only monster AC); v2 = monster turns (PC-AC Postgres bridge); v3 = polish. | combat resolver ceiling, D2 smoke 2026-05-29 |

## Out of scope (explicit non-requirements)

| Non-REQ | Statement |
|---------|-----------|
| NON-REQ-001 | Multi-process EventsWriter (in-process mutex sufficient for single-Next.js-server deployment) |
| NON-REQ-002 | Per-turn model router (re-evaluate post-launch with engagement data) |
| NON-REQ-003 | Chain-of-thought extraction pipeline (needed only if qwen3:30b-a3b base re-enters the candidate pool, which is currently NOT planned) |
| NON-REQ-004 | Multi-agent concurrent campaigns (single-agent invariant enforced at API layer) |
| NON-REQ-005 | Vault encryption at rest (file permissions sufficient on personal machine) |
