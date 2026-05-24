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

## Out of scope (explicit non-requirements)

| Non-REQ | Statement |
|---------|-----------|
| NON-REQ-001 | Multi-process EventsWriter (in-process mutex sufficient for single-Next.js-server deployment) |
| NON-REQ-002 | Per-turn model router (re-evaluate post-launch with engagement data) |
| NON-REQ-003 | Chain-of-thought extraction pipeline (needed only if qwen3:30b-a3b base re-enters the candidate pool, which is currently NOT planned) |
| NON-REQ-004 | Multi-agent concurrent campaigns (single-agent invariant enforced at API layer) |
| NON-REQ-005 | Vault encryption at rest (file permissions sufficient on personal machine) |
