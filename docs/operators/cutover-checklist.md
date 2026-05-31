# Vault Cutover — Operator Checklist

A tight, copy-pasteable sequence for executing the Postgres → vault migration on
the **production Mac Mini M4**. This is the actionable distillation of the full
11-step runbook in [`phase-03-cutover.md`](./phase-03-cutover.md) — read that for
rationale; use this to *do it*.

> **Where this runs:** the Mac Mini M4 (production host with the live Postgres +
> Ollama). Not the dev machine. Every `pnpm` command below is run from the repo
> root on the M4 with `.env.local` populated (`vercel env pull`).
>
> **State model — what actually changes:** Postgres is **not** decommissioned.
> Auth (`users`), telemetry (`ai_usage`), the `campaigns` row (which holds the
> `sourceOfTruth` flag), and the `dual_write_divergences` audit table all stay.
> Only the dynamic game-state tables move to the vault, and only **two leaf
> tables** are ever dropped: `session_state` + `combat_actors`. `characters`
> stays (see Step 7).

---

## Pre-flight (once)

- [ ] **Backups exist.** Take a fresh `pg_dump` of the production DB AND a vault
      backup: `pnpm vault:backup`. The cutover is reversible for 24h; the legacy
      drop (Step 7) is **not** reversible except from this `pg_dump`.
- [ ] **Env vars set** in `.env.local` on the M4: `DATABASE_URL`,
      `DATABASE_URL_UNPOOLED` (session pooler — required for SSE `LISTEN`),
      `VAULT_CAMPAIGNS_ROOT`, `OLLAMA_BASE_URL`, and optionally
      `CUTOVER_ROLLBACK_HOURS` (default 24), `ROLLBACK_WINDOW_DAYS` (default 30),
      `MASTER_SUMMARIZE_TRIGGER` (default 15000).
- [ ] **Migrations applied:** `pnpm db:migrate` (brings the DB to the latest
      schema, incl. `dual_write_divergences` + `session_state.summary_block`).
- [ ] **Ollama up** on the M4 with the production model pulled:
      `ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M`.

---

## Step 1 — Migrate campaign data into the vault

Idempotent: re-runs are no-ops. Dry-run first.

```bash
pnpm migrate-campaigns-to-vault --dry-run     # review the candidate set
pnpm migrate-campaigns-to-vault               # write events.md + views per campaign
pnpm migrate-campaigns-to-vault               # re-run → expect "0 new events" (idempotency proof)
```

- [ ] Dry-run lists the expected campaigns.
- [ ] Real run reports each campaign migrated.
- [ ] Re-run is a clean no-op.

## Step 2 — Enable dual-write (start the soak)

Per-campaign opt-in. This makes every mutation write to **both** Postgres and the
vault, with a synchronous parity-check logging any divergence (never auto-corrected).

```bash
# inspect current per-campaign flags (backend / mut / dualWrite / sourceOfTruth)
pnpm vault:cutover

# enable dual-write for a campaign (psql one-liner; repeat per campaign id)
psql "$DATABASE_URL" -c "UPDATE campaigns SET settings = jsonb_set(settings,'{dualWrite}','true') WHERE id = '<uuid>';"
```

- [ ] `pnpm vault:cutover` (no args) shows the target campaigns with `dw on`.
- [ ] Play a few real turns per campaign to generate dual-write traffic.

## Step 3 — Soak & watch divergence (≈2 weeks)

The cutover gate is divergence rate **< 0.1%** (REQ-006).

```bash
# divergence rows in the last 24h (target: near zero)
psql "$DATABASE_URL" -c "SELECT count(*) FROM dual_write_divergences WHERE created_at > now() - interval '24h';"

# inspect any divergences (field-level diff is stored)
psql "$DATABASE_URL" -c "SELECT campaign_id, event_type, summary, created_at FROM dual_write_divergences ORDER BY created_at DESC LIMIT 20;"
```

- [ ] Divergence rate stays < 0.1% across the soak window.
- [ ] Any divergence is investigated (it means a handler writes PG but not the
      vault, or vice-versa) before proceeding.

## Step 4 — Bench the M4 (REQ-021 gate)

```bash
pnpm bench-phase-03-m4
```

- [ ] Production model warm wall-clock is acceptable (< 10s budget; ~8s observed).
- [ ] Narrative quality is eyeballed on the produced comparison markdown.

## Step 5 — Cut over (flip reads to the vault)

Reversible within `CUTOVER_ROLLBACK_HOURS` (default 24h). The script **refuses**
unless the campaign is already `masterBackend=vault`, `vaultMutations=on`, AND
`dualWrite=on` (i.e. it soaked).

```bash
pnpm vault:cutover --id=<short-or-full-uuid> --dry-run   # preview
pnpm vault:cutover --id=<short-or-full-uuid>             # flip sourceOfTruth → vault
```

- [ ] After the flip, reads come from the vault. **The UI refreshes live on the
      vault path** — the SSE `state` event is now emitted by the vault
      `apply_event` dispatcher (combat tracker, HP, state pane all update without
      a manual refresh).
- [ ] Smoke a turn per cut-over campaign: a mutation visibly updates the UI.
- [ ] **Rollback if anything breaks within the window:**
      `pnpm vault:cutover --id=<uuid> --rollback`.

## Step 6 — Post-cutover soak (24h) then decommission models

Dual-write keeps Postgres warm as the rollback target through the window. Once
you're confident:

```bash
# rewrite any stored references to retired baked slugs FIRST (avoids 404 turns)
pnpm migrate-stale-userprefs

# then free SSD: remove retired baked variants + the RAG embedder from Ollama
pnpm decommission-baked --dry-run     # preview
pnpm decommission-baked               # interactive ollama rm (keeps dnd-master-plus)
```

- [ ] `migrate-stale-userprefs` ran before any `ollama rm`.
- [ ] SSD usage drops (retired models + embedder removed; expect >30GB).

## Step 7 — Retire legacy state tables (after the 30-day window)

**Only** after the rollback window has fully elapsed and the divergence audit is
clean. Drops **only** `session_state` + `combat_actors`. **`characters` is NOT
dropped** — it still has inbound FKs (`sessions`, `session_messages`) and is read
at runtime by the Phase 09 monster-turn resolver (PC-AC/HP bridge). Retiring
`characters` is a separate later migration (repoint FKs + move the PC read onto
the vault first).

```bash
pnpm decommission-legacy-state              # readiness report — lists every blocker
pnpm decommission-legacy-state --dry-run    # print the exact DROP SQL, no exec
# take a FINAL pg_dump here — this step is irreversible
pnpm decommission-legacy-state --confirm    # execute (only runs when fully ready)
```

The script refuses unless **all** hold: `--confirm` passed · ≥1 campaign ·
every campaign `sourceOfTruth=vault` · no campaign still `dualWrite=on` · every
vault campaign's rollback window (`cutoverAt` + `ROLLBACK_WINDOW_DAYS`) elapsed.

- [ ] Readiness report shows **no blockers**.
- [ ] Final `pg_dump` taken.
- [ ] `--confirm` run; `session_state` + `combat_actors` dropped; `characters`
      retained by design.

---

## Current state (as of 2026-05-31)

- **Default `sourceOfTruth` is still `postgres`.** No production cutover has run yet.
- **One Piece** (`3ef630db…`) is flipped to `sourceOfTruth=vault` for combat
  testing (Phases 06–09). It is the natural first cutover candidate.
- **SSE UI-refresh on the vault path is in place** (commit `4b231f0`) — the
  Phase 03 "SSE hand-off" gap is closed; the vault `apply_event` now drives the
  `state` event the client refetches on.
- **`decommission-legacy-state` exists and is inert** (commit `ad26afc`) — safe
  to run for a readiness report at any time; it will refuse until the gates pass.

## Known blockers / open items before a real cutover

- [ ] **Phase 09 live smoke** still pending (`VERIFICATION.md` = `human_needed`):
      monster-turn combat has never been exercised end-to-end on a vault campaign
      by a human. Do this before cutting over a combat-active campaign — see the
      dice-chip smoke in the Phase 09 close-out.
- [ ] **Free-text attacks** aren't reliably resolved server-side by the local
      model (v1/prompt-reliability gap, tracked in
      `09-v2-monster-turns/deferred-items.md`). Not a cutover blocker, but affects
      combat UX during the soak.
- [ ] **Long-session summarizer probe** (spike 011) is unvalidated end-to-end
      (harness incompatible with the new schema). The summarizer ships with unit
      coverage; the "keeps avg turn flat over 20 turns" property is unproven.
