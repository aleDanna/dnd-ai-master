# Phase 03 — Migration & Cutover Operator Playbook

## Overview

Phase 03 migrates every campaign to the vault format, validates parity via
dual-write, flips `sourceOfTruth` from `postgres` to `vault`, runs the final
M4 bench (closing REQ-021), then decommissions RAG + 4-of-5 baked variants.

This playbook is the **END-TO-END procedure**. Run each step in order. **DO
NOT skip steps** — each step's success gate must be confirmed before the
next.

**Smoke campaign for verification:** **One Piece (`3ef630db`)** is the
canonical smoke target — after each step, fire one turn from this campaign
and confirm it still works (UI loads, last events visible, LLM responds).

**Complements** Phase 01 (`docs/superpowers/operations/vault-backend.md`)
and Phase 02 (`docs/operators/vault-backup.md`). Read those first if this
is your first time touching the vault.

---

## Pre-flight

Before starting **anything** in this playbook:

- [ ] `pnpm test` — full Vitest suite green at Phase 02 close (baseline:
      399 passed / 2 skipped; Phase 03 adds ~300 more cases)
- [ ] `pnpm typecheck` — exits 0
- [ ] `pnpm lint` — exits 0
- [ ] `pnpm vault:backup` — backup before any destructive operation
- [ ] `.env.local` populated (`DATABASE_URL` resolvable via
      `scripts/_env-loader`; `vercel env pull .env.local` if running from
      a fresh checkout)
- [ ] **On the Mac Mini M4 ONLY:** confirm Ollama has
      `qwen3:30b-a3b-instruct-2507-q4_K_M` (REQ-030 production primary),
      `qwen3:30b-a3b-instruct-2507` (REQ-031 quality fallback),
      `mistral-small3.2:24b` (REQ-032 offline content), and
      `dnd-master-plus` (REQ-033 regression baseline) installed:
      ```
      ollama list | grep -E "(qwen3:30b-a3b-instruct-2507|mistral-small3.2:24b|dnd-master-plus)"
      ```
      Expected: 4 model lines (q4_K_M variant, instruct variant, mistral,
      and the baked dnd-master-plus).

If any of the above fails, **STOP**. The playbook assumes a clean Phase 02
baseline.

---

## Step 1 — Mutation Event Completeness Audit (Plan 03-A-01)

**Output artifact:** `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md`

The audit identifies new event types that need to ship BEFORE dual-write
can be enabled on any campaign. Plans 03-A-02 + 03-A-03 + 03-A-04 ship the
schema extension + projector arms + dispatcher updates derived from the
audit. Pitfall 1: without the audit + extension, divergence rate is ~100%
on combat turns (the dispatcher silently drops mutations the new event
union doesn't model).

After plans 03-A-01 through 03-A-04 land:

```
pnpm test tests/ai/master/vault/
```

Expected: vault suite green. The new event-type tests in
`events-schema.test.ts` + `projector.test.ts` MUST pass before proceeding.

---

## Step 2 — Bulk Migration (Plan 03-A-07)

The bulk migration script wraps the per-campaign Phase 02
`vault-flip --enable-mutations` primitive in a loop. Idempotent: re-runs
are no-ops on already-migrated campaigns.

**Dry-run first:**

```
pnpm migrate-campaigns-to-vault --dry-run
```

Review the output. EVERY campaign with `deletedAt IS NULL` should be
listed. Lines that say `WOULD migrate` are the targets; lines that say
`already on vault, skipping` are no-ops.

**Apply:**

```
pnpm migrate-campaigns-to-vault
```

Expected last line: `migrated=N skipped=0 errored=0`.

**Re-run to confirm idempotency (T-03-03 mitigation):**

```
pnpm migrate-campaigns-to-vault
```

Expected last line: `migrated=0 skipped=N errored=0`. If `migrated > 0` on
the second run, **STOP** — the helpers did not record the per-campaign
flip correctly. Investigate before proceeding.

**Subset for testing:**

```
pnpm migrate-campaigns-to-vault --filter=onepiece    # case-insensitive substring match on name
pnpm migrate-campaigns-to-vault --limit=5            # cap at 5 campaigns
```

**Smoke:** Fire a turn from One Piece (`3ef630db`). Confirm
`~/.dnd-ai-master/vault/campaigns/3ef630db-.../events.md` exists and
contains a `campaign_initialized` seed event line. Confirm
`characters/<slug>-<id8>.md` materialized view files exist for each PC.

```
ls ~/.dnd-ai-master/vault/campaigns/3ef630db-*/
# events.md  characters/
cat ~/.dnd-ai-master/vault/campaigns/3ef630db-*/events.md | head -3
# {"id":"...","ts":"...","type":"campaign_initialized","payload":{...}}
```

---

## Step 3 — Enable Dual-Write Per Campaign (Plan 03-A-10)

Plan 03-A-09 ships the `DualWriter` class (Promise.all([EventsWriter,
applyEngineMutation]) + synchronous parityCheck + fire-and-forget
divergence audit). Plan 03-A-10 wires it into the turn route, gated on
`resolveDualWrite(settings) === true`.

**Recommendation:** enable dual-write on ALL campaigns during the
coexistence window. The parity-check overhead is bounded (replay vs
Postgres state on each `apply_event` only), and the divergence audit is
the operator's signal that vault is ready for cutover.

For each campaign, set `settings.dualWrite = true` via psql (raw SQL — no
CLI shipped for this in Phase 03; the operator-grade UX would be a Phase
04+ `pnpm vault:flip --enable-dual-write` extension):

```
export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's/^"//;s/"$//')

psql "$DATABASE_URL" -c "UPDATE campaigns SET settings = jsonb_set(settings, '{dualWrite}', 'true') WHERE id = '<uuid>'"
```

Or bulk-enable for ALL non-deleted campaigns at once:

```
psql "$DATABASE_URL" -c "UPDATE campaigns SET settings = jsonb_set(settings, '{dualWrite}', 'true') WHERE deleted_at IS NULL"
```

**Smoke:** Fire a turn from One Piece that mutates state (e.g., a combat
turn or HP change). Confirm BOTH `events.md` (a new event line appears)
AND `session_state` (the engine row updates) reflect the change:

```
# Vault side
tail -1 ~/.dnd-ai-master/vault/campaigns/3ef630db-*/events.md

# Postgres side — get the session id first
psql "$DATABASE_URL" -c "SELECT id, hp_current, conditions FROM session_state WHERE session_id = '<session-uuid>'"
```

Both should reflect the same mutation.

**Monitor divergences:**

```
psql "$DATABASE_URL" -c "SELECT created_at, event_type, summary FROM dual_write_divergences WHERE created_at > now() - interval '1h' ORDER BY created_at DESC LIMIT 20"
```

If `summary` strings appear, that's a parity mismatch — the operator
inspects `vault_state` vs `postgres_state` JSONB columns to identify the
divergence. Mitigation options:

1. **Compensating event** — emit a corrective mutation through the LLM
   tool surface (the `apply_event` correction-policy pattern from
   T-02-06).
2. **`pnpm vault:rebuild-views --campaign=<uuid>`** — Postgres wins, and
   we regenerate the vault materialized views from the events.md replay
   (rare; only if vault is more wrong than Postgres).

**Target gate (from ROADMAP):** < 0.1% divergence rate over 2 weeks.
Operationally:

```
psql "$DATABASE_URL" -c "
  SELECT
    (SELECT COUNT(*) FROM dual_write_divergences WHERE created_at > now() - interval '14 days') AS divergences,
    (SELECT COUNT(*) FROM ai_usage WHERE created_at > now() - interval '14 days' AND tool_name = 'apply_event') AS apply_events,
    ROUND(100.0 * (SELECT COUNT(*) FROM dual_write_divergences WHERE created_at > now() - interval '14 days')::numeric
              / NULLIF((SELECT COUNT(*) FROM ai_usage WHERE created_at > now() - interval '14 days' AND tool_name = 'apply_event'), 0), 4) AS pct"
```

The `pct` column should read `< 0.1` for cutover gate satisfaction.

---

## Step 4 — Per-Turn Summarizer Live (Plans 03-B-04 + 03-B-05)

REQ-023: condense prior turns into a ~200-word summary block when
cumulative history exceeds the trigger threshold. Plan 03-B-04 ships the
`maybeCondense` module; plan 03-B-05 wires it into `runVaultToolLoop`
before each `provider.completeMessage`.

**Default behavior:** ENABLED (env `MASTER_SUMMARIZATION=on`, trigger
15000 tokens).

**Override for testing** (lower the trigger so the summarizer fires
quickly on a few verbose turns):

```
MASTER_SUMMARIZE_TRIGGER=1000 pnpm dev
```

Fire 5 verbose turns. Confirm `session_state.summary_block` is populated:

```
psql "$DATABASE_URL" -c "SELECT summary_block FROM session_state WHERE session_id = '<session-uuid>'"
```

Expected: a JSONB blob like:

```json
{"text": "Il party ha ...", "generatedAt": "2026-05-...", "tokensBefore": 1234}
```

**Restart-restore (Pitfall 4):** restart the Next.js server (`pnpm dev`
→ Ctrl-C → `pnpm dev`). Fire another turn. Confirm the summarizer does
NOT re-fire unless cumulative tokens exceed the threshold AGAIN — the
existing `summary_block` is loaded from `session_state` and treated as
line 1 of `older` history.

**Kill switch:** if the summarizer misbehaves, disable it on the next
server restart:

```
MASTER_SUMMARIZATION=off pnpm dev
```

---

## Step 5 — Run the M4 Bench (REQ-021 Closure — Plan 03-D-01)

**MUST run on the Mac Mini M4 production host**, not the M5 Pro dev
machine. The bench uses the validated spike harnesses (004 G1 warm + 011
long-session + 014 narrative) and the M4 is the production gate per
REQ-020.

**Pre-flight:** Ollama up; `qwen3:30b-a3b-instruct-2507-q4_K_M` warm
(`ollama run qwen3:30b-a3b-instruct-2507-q4_K_M "ok"` to warm).

```
pnpm bench-phase-03-m4
```

Expected runtime: 5-15 minutes (sequential — spike 004 warm-up sample,
spike 011 20-turn simulation with `MASTER_SUMMARIZATION=on`, spike 014
narrative-quality 5-keyword).

**Review the output JSON** (path printed at end):

```
.planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json
```

**Acceptance gates** (recorded in JSON with pass/fail):

| Stage | Gate | REQ |
|---|---|---|
| Stage 1 (spike 004) | G1 warm wall-clock **< 5s** | REQ-021 |
| Stage 2 (spike 011) | Long-session avg flat over 20 turns (no >2x growth) | REQ-023 |
| Stage 3 (spike 014) | Narrative quality 5-keyword **>= 4/5** | quality reg. |

If overall PASS, note the JSON path for Step 6.

**If FAIL — investigate before proceeding:**

- M4 host OOM → kill background processes; retry. The bench needs
  ~20-25GB free for the primary model + Ollama + Node.
- Model state changed → `ollama rm qwen3:30b-a3b-instruct-2507-q4_K_M
  && ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M`.
- Recent code regression → `git bisect` between Phase 02 close and HEAD.
- For Stage 3 narrative manual-verdict UNKNOWN, the spike 014 reference
  narrative comparison is at
  `.planning/spikes/014-narrative-quality/README.md`; run the manual
  side-by-side judgment before declaring pass/fail.

---

## Step 6 — Update Phase 01 SUMMARY.md (REQ-021 Closure — Plan 03-D-02)

Manually edit `.planning/phases/01-vault-read-path/SUMMARY.md` — find the
**M4 target hardware** table. Replace the `Deferred` cells with the
measured numbers from Step 5's JSON.

The fields to update from the JSON's `stages.stage1` block:

- `G1 warm wall-clock (avg)` — milliseconds
- `G1 warm wall-clock (p95)` — milliseconds
- `Tokens / s` — sample throughput
- `Pass` — `✓` or `✗` against the < 5000ms gate

Commit (separate from the bench commit):

```
git add .planning/phases/01-vault-read-path/SUMMARY.md
git commit -m "docs(phase-01): close REQ-021 deferral with Phase 03 M4 bench numbers"
```

---

## Step 7 — Cutover (sourceOfTruth Flip — Plan 03-B-02)

The cutover script `pnpm vault:cutover` flips
`settings.sourceOfTruth` from `postgres` to `vault`. Reads now pivot to
the vault materialization; writes continue dual-writing to Postgres for
the rollback window (Decision 4).

**Pre-cutover verification:**

- [ ] Step 5 bench **PASSED** (G1 < 5s, narrative ≥ 4/5)
- [ ] Step 3 divergence rate over the past week is **< 0.1%** (query
      above)
- [ ] `pnpm vault:backup` ran successfully today
- [ ] Target campaign has `dualWrite = true` (coexistence prerequisite —
      script REFUSES otherwise)
- [ ] Target campaign has `masterBackend = 'vault'` AND `vaultMutations
      = true` (Phase 01/02 prerequisites — script REFUSES otherwise)

**List campaigns + current state:**

```
pnpm vault:cutover
```

Output table columns: `id (short)  backend  mut  dw  sot  cutoverAt
rollback`. Confirm the target row has `backend=vault, mut=on, dw=on,
sot=postgres`.

**Dry-run first:**

```
pnpm vault:cutover --id=3ef630db --dry-run
```

Expected: `WOULD flip sourceOfTruth: postgres → vault (dry-run, no changes
written)`. No mutation; no audit file written.

**Apply:**

```
pnpm vault:cutover --id=3ef630db
```

Expected:
```
[vault-cutover] 3ef630db <name> — sourceOfTruth: postgres → vault (FLIPPED)
[vault-cutover] audit: .planning/phases/03-migration-cutover/cutover-audit/3ef630db-<ts>.json
```

**Smoke:** refresh the One Piece campaign in the UI. Confirm character
state matches expectations (HP, conditions, inventory). Reads now come
from the vault materialization (`materializeFromVault` → `parseEventsFile`
→ `replayEvents`).

**Rollback within `CUTOVER_ROLLBACK_HOURS` (default 24h):**

```
pnpm vault:cutover --id=3ef630db --rollback
```

The script enforces the window: past 24h elapsed since `cutoverAt`, it
REFUSES (exit 1: `rollback window expired (25.0h > 24h)`). Override the
window for emergency rollback:

```
CUTOVER_ROLLBACK_HOURS=48 pnpm vault:cutover --id=3ef630db --rollback
```

**Cutover ALL campaigns (loop):**

```
psql "$DATABASE_URL" -tA -c "SELECT id FROM campaigns WHERE deleted_at IS NULL" | while read id; do
  pnpm vault:cutover --id="$id"
done
```

(Future polish: `pnpm vault:cutover --all` — Phase 04+.)

Smoke each campaign as you go, or batch-smoke at the end via the UI.

---

## Step 8 — Decommission RAG — Code + DB (Plans 03-C-01 through 03-C-03)

Code-side: Plans 03-C-01 (audit) + 03-C-02 (delete) already landed:
- `src/ai/master/rag/*` deleted (chunker, embedder, indexer, retriever,
  store, etc.)
- `scripts/build-rag-index.ts` deleted
- `src/app/api/rag/rebuild/route.ts` deleted
- All `retrieveRelevant + getRagStore + embed + isMechanicalIntent`
  imports removed from `turn/route.ts` baked branch
- `pingEmbedder` removed from `src/lib/local-services.ts`
- `ragChunkCount` telemetry stripped from `ai_usage`
- `useRagRetrieval` preference removed
- `build-rag-index` package.json entry removed

**Build sanity check:**

```
pnpm build
```

Expected: succeeds — confirms no RAG imports break the build.

**DB-side:** Plan 03-C-03 ships the drop migration. Apply:

```
pnpm db:migrate
```

The migration runs in the **exact** order (Pitfall 5 — index → table →
extension):
1. `DROP INDEX IF EXISTS "rag_chunks_embedding_idx"`
2. `DROP INDEX IF EXISTS "rag_chunks_source_hash_idx"`
3. `DROP TABLE IF EXISTS "rag_chunks"`
4. `DROP EXTENSION IF EXISTS vector`

**Verify:**

```
psql "$DATABASE_URL" -c "\dx" | grep -i vector
# (no output — extension is gone)

psql "$DATABASE_URL" -c "\dt rag_chunks"
# Did not find any relation named "rag_chunks".
```

**On the Mac Mini M4 ONLY — remove the embedder:**

```
ollama rm nomic-embed-text
```

This frees ~270MB SSD. The next section (`pnpm decommission-baked`)
also removes `nomic-embed-text` interactively — you can defer to Step 9
if you prefer batched cleanup.

---

## Step 9 — Decommission Baked Variants (Plans 03-C-04 + 03-C-05 + this plan)

Code-side: Plans 03-C-04 + 03-C-05 already landed:
- `TIER_NAMES` in `src/ai/master/baked-models.ts` contains ONLY entries
  that map to `dnd-master-plus` (regression baseline per REQ-033)
- `scripts/build-local-models.ts` `--base`-less invocations skip the
  retired tier bases (mistral, qwen3:30b-a3b-instruct-2507, qwen3:30b-a3b,
  llama3.2:3b)
- `scripts/migrate-stale-userprefs.ts` rewrites stored `userPrefs.aiMasterModel`
  AND `campaigns.settings.aiMasterModel` references of
  `'dnd-master-{lite,max,max2,max3}'` to
  `'qwen3:30b-a3b-instruct-2507-q4_K_M'` (REQ-030 production primary)

**Apply the userPrefs migration FIRST** (so no user / campaign lands a
404 on the next turn after the baked variants are removed — Pitfall 6
mitigation):

```
pnpm migrate-stale-userprefs --dry-run    # preview
pnpm migrate-stale-userprefs              # apply
pnpm migrate-stale-userprefs              # idempotency check (0 migrated)
```

The smoke campaign One Piece (`3ef630db`) currently uses `dnd-master-max2`
in `campaigns.settings.aiMasterModel` — it gets migrated to
`qwen3:30b-a3b-instruct-2507-q4_K_M` by default. To preserve any
`dnd-master-plus` references as the regression baseline:

```
pnpm migrate-stale-userprefs --preserve-pretty-names
```

**On the Mac Mini M4 ONLY** — remove the retired baked variants
interactively (this plan ships `scripts/decommission-baked.ts` — see
below):

```
pnpm decommission-baked
```

The script is interactive — type `yes` for each `ollama rm`. It lists
the installed models first, skips any that aren't installed, and prompts
per-model before removal. The retired models:

| Model | Size note |
|---|---|
| `dnd-master-lite` | ~3GB (tiny llama3.2 variant) |
| `dnd-master-max` | ~14GB (mistral-small3.2 variant) |
| `dnd-master-max2` | ~18GB (qwen3:30b-a3b-instruct-2507) |
| `dnd-master-max3` | ~18GB (qwen3:30b-a3b base) |
| `nomic-embed-text` | ~270MB (RAG embedder; if not removed in Step 8) |

Total SSD reclaim: ~50GB on a fully-baked M4 (matches REQ-020 +
Phase 02 sizing — exact reclaim depends on which variants were actually
installed at decommission time).

**For automation / CI** (skip prompts):

```
pnpm decommission-baked --yes
```

**Preview only:**

```
pnpm decommission-baked --dry-run
```

**PRESERVED** (do NOT remove): `dnd-master-plus` (regression baseline),
`qwen3:30b-a3b-instruct-2507-q4_K_M` (production primary),
`qwen3:30b-a3b-instruct-2507` (quality fallback),
`mistral-small3.2:24b` (offline content tool).

---

## Step 10 — Post-30-Day Postgres Drop (DEFERRED — NOT IN PHASE 03)

After `CUTOVER_ROLLBACK_HOURS` (24h) AND `ROLLBACK_WINDOW_DAYS` (30d)
have BOTH elapsed, the legacy game-state Postgres tables (`characters`,
`session_state`, `combat_actors`) can be dropped.

**DO NOT** run this in Phase 03. The post-30d drop is a separate,
manually-gated migration that lands in Phase 04+. The exact procedure
will look like:

```
# THIS DOES NOT YET EXIST — Phase 04+ ships the script.
pnpm decommission-legacy-state --confirm
```

The Phase 04 plan ships this script with:
- Multi-step confirmation prompts (type the campaign count + an
  acknowledgment phrase).
- Pre-flight `pnpm vault:rebuild-views --all` to validate vault
  completeness (every campaign's events.md replays cleanly).
- Pre-flight check that `cutoverAt + ROLLBACK_WINDOW_DAYS < now()` for
  every non-deleted campaign.
- The actual `DROP TABLE` statements (one drizzle migration; no
  partial-table drops).

Until the drop runs, the Postgres legacy tables retain the historic
state. The operator can roll back any individual campaign to Postgres
via `pnpm vault:cutover --id=<uuid> --rollback` *within the 24h
`CUTOVER_ROLLBACK_HOURS` window* — past 24h, rollback requires the
operator to explicitly extend the env (`CUTOVER_ROLLBACK_HOURS=720 pnpm
vault:cutover --id=<uuid> --rollback`) and accept the risk that the
in-Postgres state is now N days stale relative to the vault.

---

## Step 11 — Final Verification

After all prior steps have landed, run this end-to-end check:

- [ ] `pnpm test` — full suite green (target: 700+ passing)
- [ ] `pnpm typecheck` — exits 0
- [ ] `pnpm lint` — exits 0
- [ ] `pnpm build` — production build succeeds (no RAG imports left)
- [ ] One Piece (`3ef630db`) smoke turn — works
- [ ] All campaigns flipped to `sourceOfTruth=vault`:
      ```
      psql "$DATABASE_URL" -c "SELECT id, name, settings->>'sourceOfTruth' FROM campaigns WHERE deleted_at IS NULL"
      ```
      Every row should show `sourceOfTruth = vault`.
- [ ] `dual_write_divergences` over the past week < 0.1% (query in Step 3)
- [ ] M4 has the 4 supported models AND the retired tier variants are
      GONE:
      ```
      ollama list | grep -E "(qwen3:30b-a3b-instruct-2507|mistral-small3.2:24b|dnd-master-plus|dnd-master-(lite|max|max2|max3)|nomic-embed-text)"
      ```
      Expected: 4 lines (the supported 4); no lines for the retired 5.
- [ ] Phase 01 SUMMARY.md "M4 target hardware" table is updated with
      measured numbers (REQ-021 closed — see Step 6)

If all checks pass: **Phase 03 is COMPLETE.** Plan 03-99 ships the
SUMMARY.md with REQ traceability + Phase 04 hand-offs.

---

## Rollback Procedure

If something breaks within the 24h post-cutover window for a campaign:

1. **Identify** the affected campaign(s) — UI failures, divergence
   alarms, player complaints.
2. **Roll back** sourceOfTruth:
   ```
   pnpm vault:cutover --id=<uuid> --rollback
   ```
3. **Smoke** — refresh the campaign UI; confirm reads now come from
   Postgres (state matches the last known good).
4. **Investigate** the divergence/failure — inspect
   `dual_write_divergences` rows for the affected campaign:
   ```
   psql "$DATABASE_URL" -c "SELECT * FROM dual_write_divergences WHERE campaign_id = '<uuid>' ORDER BY created_at DESC LIMIT 20"
   ```
5. **Fix** root cause (compensating event, projector arm bug, etc.).
6. **Re-cutover** when fixed: `pnpm vault:cutover --id=<uuid>`.

**If 24h has elapsed and rollback is still needed:** see Step 10 caveats
and the env override (`CUTOVER_ROLLBACK_HOURS=720` extends to 30d).
Inspect divergence carefully — Postgres state will be N days stale.

**If the whole cohort needs rollback** (catastrophic — Phase 03-A bug):
```
psql "$DATABASE_URL" -tA -c "SELECT id FROM campaigns WHERE deleted_at IS NULL" | while read id; do
  pnpm vault:cutover --id="$id" --rollback
done
```

**If RAG deletion needs reverting** (during the rollback window only):
```
git revert <commit-hash-of-rag-deletion>
pnpm install   # restore any deps if needed
ollama pull nomic-embed-text   # on M4
# Recreate rag_chunks + vector extension by re-running the drop
# migration in reverse — there's no auto-down migration; hand-write the
# CREATE EXTENSION + CREATE TABLE + CREATE INDEX from the drop SQL.
```

**If baked variant deletion needs reverting** (also during the window):
```
git revert <commit-hash-of-tier-strip>
pnpm build-local-models --force   # rebuild from current bases
```

---

## Reference: Env Knobs

| Env var | Default | Purpose |
|---|---|---|
| `MASTER_BACKEND` | `baked` | Phase 01 default backend — set to `vault` on M4 (or after migration is universal) |
| `MASTER_SOURCE_OF_TRUTH` | `postgres` | Phase 03 sourceOfTruth default — set to `vault` after cutover (or leave default + flip per-campaign) |
| `MASTER_SUMMARIZATION` | `on` | Per-turn summarizer kill switch (REQ-023) |
| `MASTER_SUMMARIZE_TRIGGER` | `15000` | Trigger threshold in tokens |
| `MASTER_SUMMARIZE_KEEP_TURNS` | `3` | Last N user/assistant pairs to keep |
| `CUTOVER_ROLLBACK_HOURS` | `24` | Cutover reversibility window |
| `ROLLBACK_WINDOW_DAYS` | `30` | Postgres legacy-table retention (informational — drop migration is Phase 04+) |
| `CUTOVER_AUDIT_DIR` | `.planning/phases/03-migration-cutover/cutover-audit/` | Where cutover JSON audits land |
| `VAULT_CAMPAIGNS_ROOT` | `~/.dnd-ai-master/vault/campaigns/` | Phase 02 — per-campaign vault location |
| `DATABASE_URL` | (required) | Postgres connection string; auto-loaded from `.env.local` by every Phase 03 script via `scripts/_env-loader` |

---

## Reference: Daily Operator Commands

| Frequency | Command | Purpose |
|---|---|---|
| Per session | `pnpm vault:backup` | Backup events.md + materialized views |
| Weekly during coexistence | Divergence query (Step 3) | Confirm < 0.1% rate over rolling window |
| Once after Phase 03-A lands | `pnpm migrate-campaigns-to-vault` | Bulk migration |
| Once before decommission | `pnpm bench-phase-03-m4` (on M4) | REQ-021 closure |
| Once per campaign during cutover | `pnpm vault:cutover --id=<uuid>` | Flip sourceOfTruth |
| Once before baked decommission | `pnpm migrate-stale-userprefs` | Rewrite stored retired-tier slugs |
| Once after migration | `pnpm decommission-baked` | Interactive `ollama rm` for the 4 retired tiers + nomic-embed-text |

---

## Reference: Baselines

- **Phase 01 M4 numbers** (REQ-021 reference baseline) —
  `.planning/phases/01-vault-read-path/SUMMARY.md` "M4 target hardware"
  table. Updated by Step 6 with the Phase 03 measured numbers.
- **Spike 004 G1 warm baseline** —
  `.planning/spikes/004-m4-validation/README.md` (warm wall-clock per
  turn target).
- **Spike 011 long-session baseline** —
  `.planning/spikes/011-full-session-simulation/README.md` (prompt
  growth + summarizer trigger validation).
- **Spike 014 narrative-quality baseline** —
  `.planning/spikes/014-narrative-quality/README.md` (5-keyword
  side-by-side reference against `dnd-master-plus`).
- **Phase 02 vault backup runbook** — `docs/operators/vault-backup.md`
  (backup/restore + DR procedure; T-02-06 correction policy).
- **Phase 01 vault backend operator guide** —
  `docs/superpowers/operations/vault-backend.md` (per-campaign
  masterBackend flag + Settings UI path + base-slug model selector).

---

## Known Limitations / Phase 04 Hand-offs

- **SSE event source replacement DEFERRED.** The current SSE stream
  emits `state` events on Postgres LISTEN/NOTIFY. During the
  dual-write window, Postgres still updates → SSE keeps firing → UI
  keeps refreshing. After the 30-day legacy-state drop (Phase 04+),
  this breaks. Phase 04 owns the filesystem-watcher OR EventsWriter
  event-emitter replacement. During the rollback window, UX is
  "manual refresh" between turns for vault-cutover campaigns.
- **Long-session harness ERROR.** Spike 011 long-session simulation has
  a known hang under certain MoE routing conditions (tracked in
  `.planning/phases/03-migration-cutover/deferred-items.md` if present).
  The bench may report Stage 2 as `ERROR` rather than `PASS/FAIL` —
  treat this as a soft signal and validate flat-token-growth manually
  via the per-turn `ai_usage` rows.
- **Stage 3 narrative manual verdict pending** — the 5-keyword judgment
  is operator-eyeballed against the spike 014 reference paragraph. The
  bench output JSON records the raw text; the operator records pass/fail
  in `.planning/phases/03-migration-cutover/bench-results/manual-verdicts.md`
  (out of scope for the auto-runner).
- **No "click to install" UI for `mistral-small3.2:24b` (REQ-032).** The
  model remains selectable as a base slug in Settings; the user must
  `ollama pull mistral-small3.2:24b` manually. Phase 04+ may add a UI
  affordance.
- **No per-turn model router (REQ-034 — LOCKED).** The summarizer uses
  the SAME primary model the session uses. No secondary-model selection.
  No router. This is not "deferred" — it is an explicit phase-1 design
  invariant.
- **No event-log compaction / snapshot.** Negligible at Phase 03 scale
  per spike 008. Phase 04+ may ship `pnpm vault:snapshot-compact` if
  bench shows regression at >5K events per campaign.
- **No automated post-event push from Next.js.** `pnpm vault:backup`
  remains operator-driven. Recommend a daily backup cadence during the
  rollback window via cron, launchd, or your preferred mechanism.
- **No multi-process EventsWriter (NON-REQ-001).** Single-Next.js-server
  invariant unchanged. Bulk scripts MUST run with the dev server
  stopped.
- **No production deployment of `dnd-master-plus` for live turns.** Per
  REQ-033 it remains a regression baseline only; user-facing dropdown
  shows BASE slugs.

---

## Italian UI Copy Notes

The Phase 02 stale-UI banner constant
(`VAULT_MUTATIONS_STALE_UI_BANNER` in `src/lib/preferences.ts`) is
**DEPRECATED** in Phase 03 (the UI now reads from vault directly when
`sourceOfTruth = vault` — no stale banner needed). The constant stays in
source for legacy paths during the rollback window; it is removed in
Phase 04+ once the post-30d drop migration lands.

All UI-surfaced strings remain Italian per project convention. Operator
CLI output (this playbook's commands) is English per the
`docs in English` convention from CLAUDE.md.
