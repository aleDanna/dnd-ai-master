# Vault Backend — Operator Guide

This document covers operating the **vault-llm-wiki migration** read-path that landed in Phase 01. The flag is `campaigns.settings.masterBackend` (`'vault' | 'baked'`).

Full design context: `docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md` + `risks.md`. Validated by 14 spikes (see `.planning/spikes/MANIFEST.md`).

## Flipping a campaign onto the vault backend

### Via SQL (dev / quick toggling)

```bash
# 1. Find the campaign UUID
psql "$DATABASE_URL" -c "SELECT id, name FROM campaigns WHERE deleted_at IS NULL;"

# 2. Set the flag
psql "$DATABASE_URL" -c \
  "UPDATE campaigns
     SET settings = jsonb_set(settings, '{masterBackend}', '\"vault\"')
   WHERE id = '<uuid>';"
```

### Via API (production-style)

```bash
curl -X PUT https://your-host/api/campaigns/<uuid>/settings \
  -H 'content-type: application/json' \
  -H 'Cookie: __session=<clerk-jwt>' \
  -d '{"masterBackend":"vault"}'
```

The next turn runs the vault path; no restart needed.

## Rolling back to baked

Same shape, value `'baked'`:

```bash
psql "$DATABASE_URL" -c \
  "UPDATE campaigns
     SET settings = jsonb_set(settings, '{masterBackend}', '\"baked\"')
   WHERE id = '<uuid>';"
```

The next turn runs the baked path. No cache invalidation needed — the two paths use different system prompts and tool surfaces, so they don't share Ollama KV-cache prefixes.

## Env-level override (ops / CI)

```bash
MASTER_BACKEND=vault pnpm dev
```

Makes ALL campaigns that have NO explicit `masterBackend` setting default to `'vault'`. Useful for:
- Local dev smoke-test runs without touching the DB.
- CI integration tests on a fresh DB.

**Do NOT set this in production.** A stored campaign value always wins over the env override, but the env affects every unflagged campaign — that's not what you want in a prod deployment where you flip campaigns individually.

## What works on the vault path

- Rules + lore lookups via the markdown vault (handbook H2 sections).
- 3-tool surface: `read_vault_multi`, `list_vault`, `end_turn`.
- Streaming via the existing `MasterProvider`.
- `ai_usage` telemetry continues to land (with `mode=NULL`, `needsSpellcasting=NULL`, `ragChunkCount=NULL`).
- Multiplayer turn-advance (round-robin + addressee detection) — same as baked path.
- Memory extraction (post-turn `extractMemory` background job).

## What does NOT work yet on the vault path (Phase 01 scope)

- **Game-state mutation.** Vault-flagged campaigns are READ-ONLY for game state. Players can ask rules questions ("Quanto danno fa Fireball al 5° livello?") but combat resolution, spell-slot consumption, HP changes, conditions — none of these run via tools on the vault path. Phase 02 adds `apply_event` to fix this.
- **Per-tool documentation lookups.** The spike 002 measurement showed local models won't reliably read `/tools/<name>.md` before each tool call; the lenient protocol just requires reading `/tools/index.md` once. Per-tool stubs exist but are optional reference material.
- **UI toggle.** Flipping the flag is backend-only (SQL or API). Settings UI control is a Phase 02 task.

## Running the M4 benchmark

```bash
# On the Mac Mini M4 (one-time setup):
vercel env pull .env.production.local --environment=production  # pull real DATABASE_URL
pnpm migrate-handbook-to-vault                                   # generate data/vault/

# Flip ONE campaign onto vault (any existing campaign works):
psql "$DATABASE_URL" -c \
  "UPDATE campaigns SET settings = jsonb_set(settings, '{masterBackend}', '\"vault\"')
     WHERE id = '<campaign-uuid>';"

# Run the bench — session is auto-discovered (most recently played
# vault-flagged campaign's session).
pnpm dev                              # in one terminal
pnpm bench-vault-m4 --user-jwt=<__session-cookie>  # in another
```

Override auto-discovery with `--session=<uuid>` if you need to bench a
specific session.

The script:
1. Pre-flight checks (vault migrated, session has `masterBackend=vault`, Ollama reachable).
2. Sends 5 rules-lookup prompts via the integrated turn route.
3. Polls `ai_usage` for each turn's timing.
4. Prints a summary table with REQ-021 gate (`max wall < 10s`).
5. Writes `bench-vault-m4-<ts>.json` for follow-up analysis.

JWT extraction recipe: open the app in Chrome → devtools (⌘⌥I) → Application → Cookies → `__session` → copy. Token expires in ~7 days in Clerk dev.

See `scripts/bench-vault-m4.ts` top comment for the full prerequisite checklist and the spike-004 reference baselines.

## Where the data lives

| Path | Purpose | Updates | Git? |
|---|---|---|---|
| `data/vault/handbook/{craft,lore}/<slug>.md` | Generated H2 sections — runtime source of truth | Re-run `pnpm migrate-handbook-to-vault` after editing the legacy sources | ✓ committed |
| `data/vault/handbook/{spells,monsters,items,rules,classes}/.gitkeep` | Phase 02+ placeholders | Don't add files in Phase 01 — the tool surface doesn't expose them | ✓ committed |
| `data/vault/handbook/index.md` | TOC (generated) | Same — regenerated by the migration | ✓ committed |
| `data/vault/tools/index.md` + per-tool stubs | Lenient-discovery surface (REQ-012) | Same | ✓ committed |
| `data/master_handbook.md` + `data/master_world_lore.md` | LEGACY authoring sources (NOT removed in Phase 01) | Edit these → re-run migration | ✓ committed |
| `$VAULT_CAMPAIGNS_ROOT/<campaign-id>/events.md` + views | **Per-campaign data — Phase 02** (default `~/.dnd-ai-master/vault/campaigns/`, REQ-007) | Written at runtime by `apply_event` (Phase 02); backed up out-of-band (tarball/S3/separate git) | ✗ **NOT in this repo** |

The legacy `data/master_*.md` files stay in place because the baked path still reads them. Phase 03 will retire them along with the baked variants.

## Coexistence period

Phase 01 ships in coexistence mode: every campaign has its own `masterBackend` flag, and the two paths run side-by-side. You can:
- Run some campaigns on baked, others on vault.
- Flip individual campaigns back and forth without restarting the server.
- Keep both data sources (vault + legacy) in sync via the migration script.

Phase 03 ends coexistence by retiring the baked path. Until then, this dual-source model is intentional.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bench script: "Vault not migrated" | `data/vault/handbook/index.md` missing | Run `pnpm migrate-handbook-to-vault` |
| Bench script: "Campaign … is on 'baked' backend" | Flag not set | Run the SQL UPDATE above |
| Turn: `tool_use_end ok=false error=unknown vault tool: cast_spell` | Model called an engine tool that vault doesn't expose | Expected behavior on Phase 01 — the LLM gets corrective feedback and proceeds. If this happens often on a specific campaign, check the system prompt isn't accidentally referencing engine tools. |
| Turn: `prompt_eval_count` higher than ~5K | History accumulated past the lean envelope | Trim message history (`MASTER_HISTORY_LIMIT` env) or wait for Phase 02's per-turn summarization |
| Vault path is slow on M5 Pro dev | Expected — MoE A3B routing makes the model FASTER on M4 than dev. Production target is M4. | Run `pnpm bench-vault-m4` on M4 for decision-grade numbers. |
