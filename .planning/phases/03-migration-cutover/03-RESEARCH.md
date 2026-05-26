# Phase 03: Migration & Cutover — Research

**Researched:** 2026-05-26
**Domain:** Postgres → vault migration; dual-write coexistence; cutover + rollback semantics; RAG/baked decommission; per-turn summarization (REQ-023); final M4 sweep closing REQ-021
**Confidence:** HIGH on every primitive (each leans on a Phase 02 artifact, a validated spike, or an existing Postgres column); MEDIUM on the cutover semantics (genuine new decision space) and on the per-turn summarizer (spike 011 measured the gap but did NOT validate a concrete implementation — the pattern is sketched in `references/performance.md`, not in source)

## Summary

Phase 03 closes the vault-LLM-wiki migration. Phase 01 shipped the read path behind `masterBackend`; Phase 02 shipped the write path (`apply_event` + `EventsWriter` + projector + per-campaign opt-in `vaultMutations`); both shipped behind coexistence flags. Phase 03 takes the cohort across the line: **export every Postgres campaign into vault format**, **run dual-write for 2 weeks**, **flip source-of-truth**, **retire RAG + baked variants except `dnd-master-plus`**, **implement per-turn summarization (REQ-023)**, and **re-run spike 004 + 011 + 014 on M4 to close the REQ-021 gate deferred from Phase 01**.

The migration is mostly an **orchestration phase**, not a new-primitive phase. Phase 02 already validated every storage primitive — `EventsWriter`, projector, `regenerateAffectedViews`, `vault-flip --enable-mutations`, `vault-backup`, `vault-rebuild-views`. Phase 03's bulk-export script is the Phase 02 flip script in a loop; the cutover flag flip is one Boolean addition to `CampaignSettings`; the rollback window is a configurable env-driven retention period before the Postgres drop migration.

The five genuinely **new** technical pieces are:
1. **Bulk migration orchestration** (loop over campaigns, idempotent re-runs, divergence report).
2. **Dual-write fan-out architecture** — where in the turn loop does Postgres still get written, and how is divergence detected/alarmed?
3. **`sourceOfTruth` flag** + read-pivot logic in the snapshot builder + UI.
4. **`maybeCondense` per-turn summarizer** at the 15K-token boundary (REQ-023) — sketched in `references/performance.md`, but no production code exists.
5. **RAG/pgvector/embedder decommission ordering** — pure deletion work, but the ordering matters because Postgres holds the pgvector extension and the `rag_chunks` table.

**Primary recommendation:** ship Phase 03 in **four sequential sub-phases** to bound risk:

- **03-A: Migration & dual-write enablement.** Bulk-flip every campaign to `masterBackend: 'vault'` + `vaultMutations: true` via a script that wraps the Phase 02 flip per-campaign; add a dual-write fan-out in the turn-route's apply-event dispatch (Option B in the brief — a thin `DualWriter` wrapper around `EventsWriter` that ALSO writes through the existing engine handler to Postgres) plus a parity-check job; **don't change reads yet**.
- **03-B: Cutover + summarizer.** Add `sourceOfTruth: 'vault' | 'postgres'` to `CampaignSettings`; switch reads to vault when flipped; ship `maybeCondense` (REQ-023) behind `MASTER_SUMMARIZATION=on` flag, default ON. UI banner from Phase 02 deprecated.
- **03-C: Decommission.** Remove RAG modules + `build-rag-index.ts` + `pgvector` extension migration; remove baked variants `dnd-master-{lite,max,max2,max3}` from `TIER_NAMES` + Modelfile generation (keep `dnd-master-plus` as regression baseline); free SSD on M4. Each sub-step has its own commit so revert is one-file.
- **03-D: Final sweep + Phase 01 SUMMARY closure.** Re-run spike 004 (G1 warm), spike 011 (long-session prompt growth), spike 014 (narrative quality 5-keyword) bundled into one `pnpm bench-phase-03-m4` runner; capture decision-grade numbers; update Phase 01 SUMMARY.md `M4 target hardware` table closing REQ-021. Drop Postgres campaign tables only **after** the configurable rollback window (default 30d, ROLLBACK_WINDOW_DAYS env) elapses.

The four sub-phases land as independent waves in the plan; each is independently revertable. The cutover sub-phase 03-B is the only one that changes user-visible behavior (read path); 03-A is dormant (write-only) so it's safe to ship and observe before flipping the read.

## User Constraints (from CONTEXT.md)

**No CONTEXT.md exists for Phase 03** — `/gsd-discuss-phase` was not run. The scope comes from `.planning/ROADMAP.md` Phase 03 (LOCKED) + the requirement IDs in `.planning/REQUIREMENTS.md` (REQ-006, REQ-020, REQ-023, REQ-031, REQ-032, REQ-033, REQ-034 — all LOCKED by spike validation; cannot be revised without re-spiking per REQUIREMENTS.md preamble).

Locked-by-spike requirements that constrain every Phase 03 decision:

- **REQ-006** (DR via events.md replay) — locked by spike 013, Phase 02 ships `vault-rebuild-views` already; Phase 03 RE-USES it [VERIFIED: `/Users/alessiodanna/projects/dnd-ai-master/scripts/vault-rebuild-views.ts` exists]
- **REQ-020** (production hardware = Mac Mini M4 with 32GB RAM, 120 GB/s, 256GB SSD) — locked by project memory `project_dnd_ai_master_target_hw.md`
- **REQ-021** (Warm wall-clock per turn < 10s on M4) — DEFERRED from Phase 01 SUMMARY; Phase 03 deliverable to close the gate with decision-grade numbers [CITED: `.planning/phases/01-vault-read-path/SUMMARY.md` lines 62-72]
- **REQ-023** (Per-turn summarization at 15K-token boundary, condense prior 5 turns into ~200-word summary block) — locked by spike 011; **no production code shipped yet** in any prior phase [VERIFIED: `grep -rn "maybeCondense\|summari" src/sessions/ src/ai/master/` returns no relevant matches]
- **REQ-031** (Quality-fallback `qwen3:30b-a3b-instruct-2507` opt-in via Settings) — locked by spike 014; Phase 01 SUMMARY confirms `userPrefs.aiMasterModel` resolver is in place; Phase 03 confirms the quality-fallback variant is selectable
- **REQ-032** (Offline content tool `mistral-small3.2:24b` non-default) — locked by spike 014; Phase 03 confirms it remains available as a non-default Settings option, even though the migration eliminates `dnd-master-max` (mistral was the Max-tier baked)
- **REQ-033** (Drop all `dnd-master-*` baked variants from production; keep `dnd-master-plus` only as regression baseline) — locked by spikes 003 + 004; Phase 03 is the explicit retirement window
- **REQ-034** (No per-turn model router in Phase 1; switching between primary/fallback is per-session via user setting) — locked by spike 014; Phase 03 confirms the model selector remains per-session, no router added

## Project Constraints (from CLAUDE.md / AGENTS.md)

- **Italian in chat, English in code/commits/docs.** Phase 03 RESEARCH.md and downstream PLAN.md stay English. Operator-visible UI copy (banners, error toasts) follows the Phase 02 precedent — Italian when surfaced in the campaign UI.
- **AGENTS.md: "This is NOT the Next.js you know."** Heed deprecation notices in `node_modules/next/dist/docs/`. [VERIFIED: next is `16.2.4` from `package.json`.] Phase 03 introduces NO new Next.js routing patterns — it modifies the existing `src/app/api/sessions/[id]/turn/route.ts` route handler (vault branch from Phase 01/02 + dual-write fan-out + summarizer call) and the `buildClientSnapshot` reader (vault-read pivot). No new route handlers; no new middleware; no edge-runtime changes.
- **Auto-loaded skill `spike-findings-dnd-ai-master`** — `references/performance.md` is the implementation contract for the summarizer (REQ-023). [CITED: lines 92-114 — `maybeCondense` pattern shown in the skill page as the Phase 1 deliverable not yet built.] `references/storage-and-mutation.md` is the contract for migration writes; `references/model-selection.md` is the contract for the model decommission decisions.
- **CLAUDE.md auto-loaded skill: `spike-findings-dnd-ai-master`** (already wired in `CLAUDE.md`). Phase 03 planner MUST read `references/performance.md` + `references/storage-and-mutation.md` + `references/model-selection.md` before writing PLAN.md.

## Phase Requirements

| ID | Description (from REQUIREMENTS.md) | Research Support |
|----|-----------------------------------|------------------|
| REQ-006 | DR procedure: events.md is the only durable artifact needed; restore = replay events.md → regenerate views. Backup strategy is out-of-band. | §3 Migration script reuses `EventsWriter.applyEvent` + `regenerateAffectedViews` (Phase 02 primitives); §5 Cutover does NOT change DR — the rollback procedure for 30 days is "re-flip the source-of-truth back to Postgres". The Postgres-table drop migration (after the rollback window) is the only irrevocable step. |
| REQ-020 | Production target hardware: Mac Mini M4 (32GB RAM, 120 GB/s, 256GB SSD). All G1 measurements M4-validated. | §6 Final sweep — re-run spike 004/011/014 on M4; capture decision-grade numbers; update Phase 01 SUMMARY.md `M4 target hardware` table closing REQ-021. SSD budget recheck (§7 Environment) — Phase 03 RAG + baked decommission frees >30GB of SSD; well within REQ-020 256GB target. |
| REQ-023 | Per-turn summarization at 15K-token boundary (condense prior turns into ~200-word summary block) | §4 Summarizer design — `maybeCondense` skeleton from `references/performance.md` ported into `src/ai/master/vault/condense.ts`; trigger at cumulative prompt > 15K; uses primary `qwen3:30b-a3b-instruct-2507-q4_K_M` (single model in the system after decommission); summary stored in `session_state` JSONB column (additive — no schema migration). |
| REQ-031 | Quality-fallback (opt-in) `qwen3:30b-a3b-instruct-2507` | §6.1 Model decommission decisions — fallback remains in the user-pref `aiMasterModel` selector; no longer baked; loaded by Ollama on-demand (cold ~10s, warm 3.87s validated). |
| REQ-032 | Offline content tool (non-default) `mistral-small3.2:24b` | §6.1 — non-default Settings option; not in `TIER_NAMES`; Modelfile NOT generated; user can install via `ollama pull` directly. NO baked variant exists post-Phase 03 for mistral (`dnd-master-max` retired). |
| REQ-033 | Drop all `dnd-master-*` baked variants from production. Build script keeps `dnd-master-plus` only as a regression-test baseline. | §6.2 — strip `dnd-master-{lite,max,max2,max3}` from `TIER_NAMES` in `src/ai/master/baked-models.ts`; update `scripts/build-local-models.ts` to skip these bases by default; verify `dnd-master-plus` (gpt-oss:20b) still builds. SSD reclaim: ~50GB on dev (per skill page); ~14-18GB on M4 (just the variants currently installed). |
| REQ-034 | No per-turn model router in Phase 1. Switching primary/fallback is per-session via user setting. | §6.1 — the `userPrefs.aiMasterModel` resolver in `turn/route.ts` is the ONLY per-session selector. No router added; the summarizer (§4) re-uses the SAME model selected by the user for the session — no second-model call. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bulk migration loop (Postgres → vault, per-campaign) | CLI Script (offline) | OS Filesystem (writes) | Operator-driven, runs once per campaign cohort; reuses Phase 02 `EventsWriter.applyEvent` + `regenerateAffectedViews` |
| Dual-write fan-out (Postgres + vault) | Frontend Server (Next.js process) | Database + Filesystem | The turn route handler is where the LLM's tool dispatch lives; the fan-out happens there — single source of orchestration to keep both stores aligned |
| Divergence parity check | Backend Service (synchronous in turn route) | Database + Filesystem | Best to surface mismatch as an `ai_usage`-style row OR a `dual_write_divergences` table — operator can query without grepping logs. Synchronous so the LLM sees an alarm in the same turn (and so production-safety doesn't depend on a worker daemon) |
| `sourceOfTruth` resolver | Frontend Server (in-process) | Database (JSONB read) | Same shape as Phase 01's `resolveMasterBackend` + Phase 02's `resolveVaultMutations` — JSONB additive flag, in-process resolver, env override last |
| Snapshot read pivot (Postgres vs vault) | Frontend Server (snapshot builder) | Filesystem (vault read) | `buildClientSnapshot` reads from Postgres today; Phase 03 adds a branch that materializes from `parseEventsFile` + `replayEvents` when `sourceOfTruth === 'vault'` |
| Per-turn summarizer | Frontend Server (in-process LLM call) | Database (summary storage) | Synchronous before the next `provider.completeMessage`; same Ollama model the session uses; summary persisted in `session_state.summaryBlock` so it survives server restart |
| RAG / pgvector / embedder code removal | Frontend Server (source files) | Database (drop migration) | Pure deletion — code goes first, then a migration drops the `rag_chunks` table + `pgvector` extension. Reversal during the rollback window = `git revert` the deletion commit + `ollama pull nomic-embed-text` |
| Baked-variant retirement | Build pipeline (script) | OS (model unload) | `scripts/build-local-models.ts` drops 4 of 5 entries; `ollama rm` on M4 frees disk; runtime guard in `getBakedBaseModel` still works for any leftover slugs in user prefs |
| Final M4 sweep | CLI bench runner | OS Filesystem (results JSON) | Operator runs `pnpm bench-phase-03-m4` on the M4; aggregates spike 004/011/014 numbers; updates Phase 01 SUMMARY.md "deferred" rows |

## Standard Stack

### Core (already in repo — Phase 03 adds NO new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | `^0.45.2` | Postgres read for migration + dual-write + parity-check; drop migration for `rag_chunks` + `pgvector` | Same library Phase 01/02 used; no new ORM choices |
| `node:fs/promises` | builtin | Vault write reuse (`EventsWriter.applyEvent`, `regenerateAffectedViews`); no new file primitives | Phase 02 already validated |
| `node:child_process` | builtin | `ollama rm <model>` invocation in the baked decommission script | Same `execSync` pattern Phase 02 `vault-backup.ts` uses for git |
| `vitest` | `^4.1.5` | Test framework for migration script, parity-check, summarizer | Phase 01+02 pattern; `tests/**/*.test.ts` under `tests/` only (NOT colocated — locked by Phase 01 SUMMARY line 51) |
| `tsx` | `^4.21.0` | CLI runner for `scripts/migrate-campaigns-to-vault.ts`, `scripts/bench-phase-03-m4.ts`, decommission scripts | Same pattern as Phase 02 `scripts/vault-*` |

[VERIFIED: `cat /Users/alessiodanna/projects/dnd-ai-master/package.json` 2026-05-26 — drizzle-orm 0.45.2, vitest 4.1.5, tsx 4.21.0 all present; no new deps needed.]

### Existing Phase 02 Modules Phase 03 CONSUMES (no rewrites)

| Module | Path | Why Phase 03 uses it |
|--------|------|---------------------|
| `EventsWriter.applyEvent` | `src/ai/master/vault/events-writer.ts` | Migration script appends `campaign_initialized` seed + per-character bootstrap events; dual-write path appends mutation events |
| `regenerateAffectedViews` | `src/ai/master/vault/projector.ts` | Migration script regenerates views after seed; dual-write path regenerates views after each `apply_event` (Phase 02 dispatch already does this) |
| `parseEventsFile` + `replayEvents` | `src/ai/master/vault/projector.ts` | Parity check (replay events → compare against Postgres); snapshot read pivot (vault read materializes via replay) |
| `eventsPath` + `campaignDir` + `characterViewPath` | `src/ai/master/vault/campaign-paths.ts` | Path resolution for migration writes + parity reads |
| `vault-flip --enable-mutations` flow | `scripts/vault-flip.ts` lines 1-280 (Phase 02 plan 02-10) | Migration script wraps a loop around the existing per-campaign flip logic (the `LEFT JOIN sessions ⨝ session_state` is verbatim what Phase 03 needs) |
| `vault-backup` | `scripts/vault-backup.ts` (Phase 02) | DR/safety net for the 30-day rollback window — operator runs before flipping `sourceOfTruth` to vault |
| `vault-rebuild-views` | `scripts/vault-rebuild-views.ts` (Phase 02) | DR recovery if a divergence is detected post-cutover |
| `resolveMasterBackend` + `resolveVaultMutations` + `validateSettingsPatch` | `src/lib/preferences.ts` | Phase 03's `sourceOfTruth` field follows the same resolver/validator pattern (parallel-shape — Pattern D from `02-PATTERNS.md` line 933) |
| `VAULT_MUTATIONS_STALE_UI_BANNER` constant | `src/lib/preferences.ts` line 168 | DEPRECATED in Phase 03-B (UI reads from vault directly; banner no longer shown); kept as constant for legacy turn buffer until Phase 04+ |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| **In-process `DualWriter` wrapping `EventsWriter`** (recommended) | Reconciliation worker in background (Option C in brief) | Background reconciliation is async — divergence is detected with delay; harder to alarm in real time; introduces another moving part. In-process is synchronous; divergence is visible in the same turn. **Recommendation: in-process** for Phase 03 simplicity; revisit if turn latency suffers |
| **`maybeCondense` runs the same primary model** (recommended) | Smaller secondary model (e.g. `llama3.2:3b`) just for summarization | Smaller model: cheaper, faster — BUT requires Ollama to keep TWO models warm in 32GB RAM. Primary (~18GB) + llama3.2:3b (~3GB) + Node + macOS = ~25GB. Tight but feasible. **Recommendation: primary model** in v1 — already loaded, no extra cold-start cost. Re-evaluate if condensation latency > 2s |
| **`sourceOfTruth: 'vault' \| 'postgres'` enum** (recommended) | Boolean `vaultIsSourceOfTruth: true` | Enum future-proof if a third store ever joins; clearer in JSONB inspection. **Recommendation: enum** — costs nothing vs boolean, reads cleaner in `pnpm vault:flip` listing |
| **Bulk script writes a `campaign_initialized` seed event per campaign** (recommended) | Bulk script writes per-event reconstruction of historic Postgres mutations as N events.md lines | Per-event reconstruction is "perfect history" but requires either (a) `ai_usage` to carry the historic mutation trail (it doesn't — see verification) or (b) a snapshot-then-events approach. The seed event IS the snapshot — and the projector accepts it as the campaign's bootstrap state. Phase 02 already validated this for the per-campaign `vault-flip --enable-mutations` flow. **Recommendation: seed-only** — bit-exact for the cutover moment, no historic-reconstruction speculation |
| **Each decommission step in its own commit** (recommended) | One atomic "Phase 03 decommission" commit | Atomic = simpler to read in git log; harder to revert one specific piece (e.g. need to back out RAG removal but keep baked retirement). **Recommendation: per-step commits** — matches the 4-sub-phase wave structure of Phase 03 |
| **`MASTER_SUMMARIZATION` env flag default ON** (recommended) | Default OFF in Phase 03-B; flip ON in a Phase 04 | Default OFF means REQ-023 ships dormant — defeats the gate. Default ON with env override gives operator a safety hatch. **Recommendation: default ON** — REQ-023 is locked |

[Version verification — all dependencies already in `package.json`; ran `cat package.json | grep -E "(drizzle|vitest|tsx|@vercel/functions)"` 2026-05-26: all present at stated versions.]

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-A: Bulk Migration (one-shot CLI)                                  │
│                                                                              │
│  pnpm migrate-campaigns-to-vault                                            │
│      ↓                                                                       │
│  ┌──────────────────────────────────┐                                       │
│  │ Loop over every campaign in PG   │                                       │
│  │  WHERE deletedAt IS NULL         │                                       │
│  └─────────────┬────────────────────┘                                       │
│                ↓                                                             │
│  ┌──────────────────────────────────┐                                       │
│  │ Reuse vault-flip --enable-       │  ← same code path Phase 02 shipped   │
│  │ mutations logic per-campaign     │     (LEFT JOIN sessions ⨝ state)    │
│  └─────────────┬────────────────────┘                                       │
│                ↓                                                             │
│         events.md (campaign_initialized seed)                                │
│         characters/<slug>-<id8>.md (materialized view)                       │
│                ↓                                                             │
│  pnpm vault:backup  ← operator runs after bulk migration for safety net     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-A: Dual-write at turn-route apply_event dispatch                  │
│                                                                              │
│  POST /api/sessions/[id]/turn (existing route)                              │
│      ↓                                                                       │
│  runVaultToolLoop (Phase 01/02 unchanged)                                   │
│      ↓                                                                       │
│  LLM emits apply_event tool_use                                             │
│      ↓                                                                       │
│  dispatchVaultTool('apply_event', {type, payload}, ctx)                     │
│      ↓                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  DualWriter (NEW Phase 03-A)                                  │           │
│  │  if (resolveDualWrite(campaign.settings)) {                   │           │
│  │    await Promise.all([                                        │           │
│  │      EventsWriter.applyEvent(eventsPath, env),    ← VAULT    │           │
│  │      applyEngineMutation(state, action),          ← POSTGRES │           │
│  │    ]);                                                        │           │
│  │    const divergence = await parityCheck(campaignId, charId); │           │
│  │    if (divergence) recordDivergence(sessionId, divergence); │           │
│  │  }                                                            │           │
│  │  else { EventsWriter.applyEvent only (Phase 02 behavior) }    │           │
│  └──────────────────────────────────────────────────────────────┘           │
│      ↓                                                                       │
│  regenerateAffectedViews (Phase 02 unchanged)                                │
│      ↓                                                                       │
│  return {ok: true, event_id}                                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-B: Cutover (sourceOfTruth flag flip)                              │
│                                                                              │
│  campaigns.settings.sourceOfTruth: 'postgres' (default) | 'vault'           │
│                                                                              │
│  POST /api/sessions/[id]/turn (existing) — UNCHANGED, still dual-writes     │
│  GET /api/sessions/[id]/stream  (existing) — buildClientSnapshot pivots:    │
│      ↓                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  buildClientSnapshot (MODIFIED Phase 03-B)                    │           │
│  │  if (sourceOfTruth === 'vault') {                             │           │
│  │    state = await materializeFromVault(campaignId, charId);    │           │
│  │  } else {                                                     │           │
│  │    state = await loadPostgresSessionState(sessionId);  ← OLD │           │
│  │  }                                                            │           │
│  │  return {session, campaign, state, character, ...}            │           │
│  └──────────────────────────────────────────────────────────────┘           │
│                                                                              │
│  pnpm vault:flip --id=<uuid> --source-of-truth=vault                        │
│  pnpm vault:flip --id=<uuid> --source-of-truth=postgres   ← rollback        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-B: Per-turn summarizer (REQ-023)                                  │
│                                                                              │
│  runVaultToolLoop entry (before provider.completeMessage)                   │
│      ↓                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  maybeCondense (NEW Phase 03-B)                                │           │
│  │  if (estimateTokens(history) > 15_000) {                       │           │
│  │    const recent = history.slice(-6);  // last 3 user/assist    │           │
│  │    const older = history.slice(0, -6);                         │           │
│  │    const summary = await summarize(older, model);              │           │
│  │    await persistSummary(sessionId, summary);                   │           │
│  │    history = [system, {role:'user', content:`[Summary] ${s}`}, │           │
│  │               ...recent];                                       │           │
│  │  }                                                              │           │
│  └──────────────────────────────────────────────────────────────┘           │
│      ↓                                                                       │
│  provider.completeMessage with reduced history                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-C: Decommission (per-step commits)                                │
│                                                                              │
│  1. Remove RAG imports in turn-route.ts (no callers in vault path already)  │
│  2. Delete src/ai/master/rag/*.ts + tests                                   │
│  3. Delete scripts/build-rag-index.ts + tests                               │
│  4. Drizzle migration: DROP TABLE rag_chunks; DROP EXTENSION vector;        │
│  5. ollama rm nomic-embed-text  (on M4)                                     │
│  6. Strip dnd-master-{lite,max,max2,max3} from TIER_NAMES (keep plus)       │
│  7. Update build-local-models.ts skip-list                                  │
│  8. ollama rm dnd-master-{lite,max,max2,max3}  (on M4)                      │
│  9. Confirm pnpm test green; confirm pnpm bench-phase-03-m4 stays GREEN     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 03-D: Final M4 sweep + REQ-021 closure                               │
│                                                                              │
│  pnpm bench-phase-03-m4 (NEW unified runner)                                │
│      ↓                                                                       │
│  Stage 1: spike 004 — warm wall-clock G1 (target < 5s)                      │
│  Stage 2: spike 011 — long-session prompt growth (with maybeCondense ON)   │
│  Stage 3: spike 014 — narrative quality 5-keyword (target ≥4/5)            │
│      ↓                                                                       │
│  results/phase-03-m4-<ts>.json                                              │
│      ↓                                                                       │
│  Update .planning/phases/01-vault-read-path/SUMMARY.md                      │
│  "M4 target hardware" table → swap "Deferred" cells for measured numbers   │
└─────────────────────────────────────────────────────────────────────────────┘

  (After 30 days, configurable via ROLLBACK_WINDOW_DAYS env)
  drizzle migration: DROP TABLE characters_legacy, session_state_legacy, ...
  ← Postgres game-state tables retired permanently
```

### Recommended Project Structure

```
src/ai/master/vault/
├── path.ts                       # EXISTING — VAULT_ROOT, VAULT_CAMPAIGNS_ROOT
├── prompt-builder.ts             # MODIFY — add summarizer-aware history pruning hook (optional; default behavior unchanged)
├── tools.ts                      # READ-ONLY — Phase 02's 4-tool surface unchanged
├── loop.ts                       # MODIFY — call maybeCondense before provider.completeMessage
├── events-writer.ts              # READ-ONLY — Phase 02 mutex
├── events-schema.ts              # READ-ONLY — Phase 02 union (Phase 03 may ADD new types per §3.4)
├── projector.ts                  # READ-ONLY — Phase 02 reducer (Phase 03 ADDS reducer arms iff §3.4 lands)
├── campaign-paths.ts             # READ-ONLY — Phase 02 path resolver
├── __forbidden-patterns.ts       # READ-ONLY — purity discipline
│
├── dual-writer.ts                # NEW Phase 03-A — wraps EventsWriter + Postgres engine mutation
├── parity-check.ts               # NEW Phase 03-A — replay vs Postgres state comparator
├── divergence-record.ts          # NEW Phase 03-A — write to `dual_write_divergences` table + log
├── source-of-truth.ts            # NEW Phase 03-B — `sourceOfTruth` flag resolver + JSONB read
├── snapshot-reader.ts            # NEW Phase 03-B — materialize ClientSnapshot from vault events
├── condense.ts                   # NEW Phase 03-B — maybeCondense (REQ-023 per-turn summarizer)
└── tests/ (under tests/ai/master/vault/, NEVER colocated)

src/db/schema/
├── campaigns.ts                  # MODIFY — add `sourceOfTruth?: 'vault' | 'postgres'` to CampaignSettings
├── rag-chunks.ts                 # DELETE Phase 03-C
├── session-state.ts              # MODIFY Phase 03-B — add `summaryBlock?: jsonb` column for REQ-023 storage
└── dual-write-divergences.ts     # NEW Phase 03-A — divergence audit log

src/sessions/
└── client-snapshot.ts            # MODIFY — pivot reads to vault when sourceOfTruth === 'vault'

src/lib/preferences.ts            # MODIFY — add resolveSourceOfTruth + validator arm

src/app/api/sessions/[id]/turn/route.ts
                                  # MODIFY — gate dual-write on resolveDualWrite; call maybeCondense; remove RAG imports (Phase 03-C)

src/ai/master/baked-models.ts     # MODIFY Phase 03-C — strip TIER_NAMES of lite/max/max2/max3; keep plus
                                  # NOTE: see §6.1 Decision on quality-fallback — `qwen3:30b-a3b-instruct-2507` (REQ-031) stays in user-pref as a BASE slug (not baked); resolver in turn-route maps it to BASE not to TIER

src/ai/master/rag/                # DELETE Phase 03-C (chunker, embedder, format, indexer, intent,
                                  # retriever, store, store-memory, store-pgvector, types)
scripts/
├── migrate-campaigns-to-vault.ts # NEW Phase 03-A — bulk wrap of vault-flip --enable-mutations
├── decommission-rag.ts           # NEW Phase 03-C — confirms no callers, removes files, drops PG table
├── decommission-baked.ts         # NEW Phase 03-C — strips TIER_NAMES, runs ollama rm
├── bench-phase-03-m4.ts          # NEW Phase 03-D — unified spike 004/011/014 runner
├── build-rag-index.ts            # DELETE Phase 03-C
├── vault-flip.ts                 # MODIFY — add --source-of-truth=vault|postgres flag (Phase 03-B)
└── ... (Phase 01/02 scripts unchanged)

drizzle/
└── 003X_drop_pgvector.sql        # NEW Phase 03-C — DROP TABLE rag_chunks; DROP EXTENSION vector
└── 003Y_session_state_summary.sql# NEW Phase 03-B — ADD COLUMN session_state.summary_block jsonb
└── 003Z_drop_legacy_state.sql    # NEW (post-rollback window) — DROP characters, session_state (legacy)

tests/ai/master/vault/
├── dual-writer.test.ts           # NEW — Promise.all both writes + divergence on mismatch
├── parity-check.test.ts          # NEW — replay produces state matching Postgres
├── source-of-truth.test.ts       # NEW — resolver + validator pattern
├── snapshot-reader.test.ts       # NEW — materialize from events.md → ClientSnapshot
├── condense.test.ts              # NEW — maybeCondense skips < 15K, fires ≥ 15K, persists summary
└── apply-event-integration.test.ts  # MODIFY — extend with dual-write scenario

tests/scripts/
├── migrate-campaigns-to-vault.test.ts  # NEW — bulk script idempotency + per-campaign error isolation
└── bench-phase-03-m4.test.ts            # NEW (lightweight — script-shape only, real bench runs on M4)
```

### Pattern 1: Dual-write fan-out (Phase 03-A)

**What:** wrap the existing `EventsWriter.applyEvent` + the existing engine-tool dispatch into a single `DualWriter` that issues BOTH writes in parallel + runs a parity check synchronously.
**When to use:** during the 2-week dual-write coexistence period. Phase 03-C decommission removes this once cutover is permanent.
**Example:**

```typescript
// Source: NEW src/ai/master/vault/dual-writer.ts (Phase 03-A)
// Combines Phase 02 EventsWriter (validated by spike 010) + existing engine
// applicator pattern from src/sessions/applicator.ts.
import { EventsWriter } from './events-writer';
import { regenerateAffectedViews } from './projector';
import { eventsPath } from './campaign-paths';
import { applyEngineMutation } from '@/sessions/applicator';
import { parityCheck } from './parity-check';
import { recordDivergence } from './divergence-record';
import type { VaultEventEnvelope } from './events-schema';
import type { EngineMutation } from '@/engine/types';

export interface DualWriteContext {
  campaignId: string;
  sessionId: string;
  characterId: string;
}

export async function dualWriteApplyEvent(
  env: VaultEventEnvelope,
  engineMutation: EngineMutation,
  ctx: DualWriteContext,
): Promise<{ divergence: boolean; reason?: string }> {
  // Both writes run in parallel — Postgres ops are slower than file appends,
  // so this saves ~10-50ms vs sequential. Either failing throws — we don't
  // suppress, the LLM sees ERROR: dual_write failed and can retry.
  await Promise.all([
    EventsWriter.applyEvent(eventsPath(ctx.campaignId), env),
    applyEngineMutation(ctx.sessionId, ctx.characterId, engineMutation),
  ]);
  await regenerateAffectedViews(ctx.campaignId, env);

  const divergence = await parityCheck(ctx.campaignId, ctx.characterId, ctx.sessionId);
  if (divergence) {
    // Fire-and-forget audit record so it doesn't block the turn.
    void recordDivergence(ctx.sessionId, divergence).catch((e) =>
      console.error('[divergence-record] failed', e),
    );
    return { divergence: true, reason: divergence.summary };
  }
  return { divergence: false };
}
```

**Rationale:** parallel + synchronous parity-check is the simplest reliable shape. `Promise.all` so the slower side (Postgres ~5-20ms) doesn't double the latency vs serial. Divergence record is fire-and-forget because it's an audit signal, not a blocker (the turn already succeeded on both sides — the divergence means state DIVERGED, not that the writes failed).

### Pattern 2: Parity check (Phase 03-A)

**What:** replay events.md to compute the vault-side state, then read Postgres engine state, then diff. Surface a normalized "summary" string for the audit table.
**When to use:** every `apply_event` call during the dual-write window. NOT every turn (parity-check itself is read-only and lightweight, but limiting to apply-event dispatch keeps the parity-check cost bounded).
**Example:**

```typescript
// Source: NEW src/ai/master/vault/parity-check.ts (Phase 03-A)
import { parseEventsFile, replayEvents } from './projector';
import { eventsPath } from './campaign-paths';
import { db } from '@/db/client';
import { characters, sessionState, sessions } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';

export interface ParityResult {
  diverged: true;
  summary: string;     // human-readable
  vault: object;
  postgres: object;
}

export async function parityCheck(
  campaignId: string,
  characterId: string,
  sessionId: string,
): Promise<ParityResult | null> {
  // Vault side
  const envelopes = await parseEventsFile(eventsPath(campaignId));
  const states = replayEvents(envelopes);
  const vault = states.get(characterId);
  if (!vault) return null; // character not in vault yet — skip parity

  // Postgres side — mirror the snapshot reader's joins
  const [char] = await db.select().from(characters).where(eq(characters.id, characterId)).limit(1);
  const [state] = await db
    .select()
    .from(sessionState)
    .where(eq(sessionState.sessionId, sessionId))
    .limit(1);
  if (!char || !state) return null;

  // Diff the load-bearing fields. Use a normalized comparison so JSONB
  // representations don't trigger false positives.
  const postgres = {
    hp_current: state.hpCurrent,
    hp_max: char.hpMax,
    conditions: state.conditions.map((c) => c.slug).sort(),
    spell_slots: normalizeSlots(char.spellcasting?.slotsMax ?? {}, char.spellSlotsUsed ?? {}),
    inventory: normalizeInventory(char.inventory ?? []),
  };
  const vaultNormalized = {
    hp_current: vault.hp_current,
    hp_max: vault.hp_max,
    conditions: [...vault.conditions].sort(),
    spell_slots: vault.spell_slots,
    inventory: vault.inventory,
  };

  if (JSON.stringify(vaultNormalized) === JSON.stringify(postgres)) return null;

  return {
    diverged: true,
    summary: summarizeDiff(vaultNormalized, postgres),
    vault: vaultNormalized,
    postgres,
  };
}
```

**Critical:** **prefer Postgres on divergence during the dual-write window** — the ROADMAP explicitly says "if Postgres and Vault states disagree, log alarm and prefer Postgres (until cutover)". The DualWriter does NOT auto-correct; the divergence record is an alarm. Manual remediation: operator inspects the audit table, runs `pnpm vault:rebuild-views --campaign=<uuid>` if Postgres should win, or backs out the offending event with a compensating event.

### Pattern 3: Per-turn summarizer (Phase 03-B — REQ-023)

**What:** when cumulative message history exceeds 15K tokens, condense the older turns into a 200-word summary block emitted by the same primary model, then truncate the history.
**When to use:** inside `runVaultToolLoop` before `provider.completeMessage`. Synchronous so the next round-trip sees the truncated history.
**Example:**

```typescript
// Source: NEW src/ai/master/vault/condense.ts (Phase 03-B)
// Implementation of REQ-023 — pattern from references/performance.md lines 92-114
// adapted to the runVaultToolLoop entry point.
import type { Message } from '@/ai/provider/types';
import type { MasterProvider } from '@/ai/provider/types';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const SUMMARIZE_TRIGGER_TOKENS = Number(process.env.MASTER_SUMMARIZE_TRIGGER ?? 15_000);
export const SUMMARIZE_KEEP_TURNS = Number(process.env.MASTER_SUMMARIZE_KEEP_TURNS ?? 3);

function estimateTokens(messages: Message[]): number {
  // char/4 heuristic per references/performance.md. Cheap; the actual token
  // count from Ollama isn't available until completeMessage returns.
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

export async function maybeCondense(
  history: Message[],
  provider: MasterProvider,
  model: string,
  sessionId: string,
): Promise<{ history: Message[]; condensed: boolean; tokensBefore: number; tokensAfter: number }> {
  const tokensBefore = estimateTokens(history);
  if (tokensBefore < SUMMARIZE_TRIGGER_TOKENS) {
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // History layout: history[0] is system; we keep system + last N*2 messages
  // (user/assistant pairs). All in between gets summarized.
  const system = history[0];
  const keepCount = SUMMARIZE_KEEP_TURNS * 2;
  const recent = history.slice(-keepCount);
  const older = history.slice(1, -keepCount);

  if (older.length === 0) {
    // History is mostly system + recent — nothing to condense (edge case).
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // Summarize via the same primary model — no second-model selection (REQ-034).
  const summaryResp = await provider.completeMessage({
    model,
    systemBlocks: [
      'Sei un assistente che produce riassunti per il Master di D&D.',
      'Condensa i turni precedenti in MAX 200 parole, preservando: scelte, conseguenze, NPC importanti, stato narrativo.',
      'Linguaggio: italiano. Conciso, asciutto, fatti rilevanti.',
    ],
    history: older,
    tools: [],
    options: { num_predict: 400 },
  });
  const summary = extractText(summaryResp.contentBlocks);

  const condensedHistory: Message[] = [
    system!,
    { role: 'user', content: `[Riassunto dei turni precedenti]\n${summary}` },
    ...recent,
  ];

  // Persist the summary so the next request after server restart doesn't
  // re-summarize from scratch. The summary block is in session_state.
  await db
    .update(sessionState)
    .set({ summaryBlock: { text: summary, generatedAt: new Date().toISOString(), tokensBefore } })
    .where(eq(sessionState.sessionId, sessionId));

  const tokensAfter = estimateTokens(condensedHistory);
  return { history: condensedHistory, condensed: true, tokensBefore, tokensAfter };
}
```

**Storage decision:** the summary block lives in `session_state.summaryBlock` (NEW Phase 03-B column — `jsonb`, nullable). Rationale:
- Survives Next.js restart (the in-memory loop would re-trigger condensation on every cold start otherwise).
- Belongs to the session (history is per-session), not the campaign (which spans sessions). So it's natural to live alongside `session_state` rows that already key on `sessionId`.
- NOT in `events.md` — the summary is a runtime artifact for the LLM history budget, not a game-state mutation. Events.md is the SOT for game state; mixing in artifacts would muddy that contract.
- The column is additive — Phase 03-C decommission does NOT touch it.

**Why not in vault events:** vault `events.md` is append-only for GAME-STATE mutations. The summary is a prompt-engineering artifact (REQ-023 is about prefix-cache hygiene, not state). Putting it in events.md would also forfeit deterministic replay (the summary text would change if the summarizing model temperature differs across runs — non-determinism). Keep summary OUT of vault.

### Pattern 4: Source-of-truth flag (Phase 03-B)

**What:** mirror Phase 01/02's resolver pattern for a new `sourceOfTruth` setting that flips snapshot reads from Postgres to vault.
**When to use:** every snapshot read (`buildClientSnapshot`). Per-campaign override > env > 'postgres' default.
**Example:**

```typescript
// Source: extend src/lib/preferences.ts
export type SourceOfTruth = 'postgres' | 'vault';

export function isSourceOfTruth(v: unknown): v is SourceOfTruth {
  return v === 'postgres' || v === 'vault';
}

function envDefaultSourceOfTruth(): SourceOfTruth {
  const raw = (process.env.MASTER_SOURCE_OF_TRUTH ?? '').trim().toLowerCase();
  return raw === 'vault' ? 'vault' : 'postgres';
}

export function resolveSourceOfTruth(
  stored: SourceOfTruth | undefined,
): SourceOfTruth {
  if (stored === 'postgres' || stored === 'vault') return stored;
  return envDefaultSourceOfTruth();
}
```

```typescript
// Source: modify src/sessions/client-snapshot.ts
import { resolveSourceOfTruth } from '@/lib/preferences';
import { materializeFromVault } from '@/ai/master/vault/snapshot-reader';

export async function buildClientSnapshot(sessionId: string, userId: string) {
  // ... existing PG reads for session + viewer + party
  const sourceOfTruth = resolveSourceOfTruth(campaign?.settings?.sourceOfTruth);

  let state: SessionStateRow | null;
  if (sourceOfTruth === 'vault') {
    state = await materializeFromVault(campaign.id, character.id);
  } else {
    [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
  }
  // ... rest unchanged
}
```

**Critical:** the `materializeFromVault` function consumes Phase 02's `parseEventsFile` + `replayEvents` and translates the projector's `CharacterState` shape into the `SessionStateRow` shape the UI expects. Spike 013 already proves this is byte-deterministic; the translation layer is straightforward.

### Anti-Patterns to Avoid

- **Don't auto-correct during dual-write.** When parity-check detects divergence, RECORD it — don't try to "fix" Postgres or vault automatically. ROADMAP says "prefer Postgres until cutover" — that means **reads** prefer Postgres; both stores keep accumulating their own mutations. Operator decides which one is right via the audit table. Auto-correction risks compounding the divergence.
- **Don't drop Postgres tables before the rollback window elapses.** The 30-day window is a safety net. The decommission migration that drops `characters`, `session_state`, etc. (LEGACY tables — different from `rag_chunks` which is RAG-only) lands AFTER 30 days. Phase 03 ships only the RAG/pgvector drop and the legacy-game-state drop is a separate scheduled migration.
- **Don't summarize on every turn.** REQ-023 triggers at 15K tokens. A 3-turn session with 4K tokens does NOT summarize. The trigger is the gate, not "always condense."
- **Don't summarize at the events.md layer.** The summary is prompt artifact; events.md is game-state SOT. Mixing them re-introduces the non-determinism spike 008 warned about (LLM summaries are not deterministic across temperatures / minor model updates).
- **Don't run a parity-check on EVERY turn, only on apply-event dispatch.** A turn that reads vault files but doesn't mutate state doesn't need parity. Bounding the check to mutation events keeps the dual-write overhead minimal.
- **Don't bundle the M4 sweep with the cutover commit.** The sweep is the GATE for closing REQ-021; running it AFTER the decommission means a regression there can't be diagnosed against a known-baked baseline. Run the sweep AFTER 03-A migration + 03-B summarizer is live, but BEFORE 03-C decommission removes the baked baseline.
- **Don't conflate `dnd-master-plus` with `qwen3:30b-a3b-instruct-2507-q4_K_M`.** `dnd-master-plus` is the gpt-oss:20b regression baseline kept per REQ-033 — used only for spike-004-style A/B regression. The actual production model is the qwen3 primary; the `aiMasterModel` resolver in `turn/route.ts` uses the BASE slug directly on the vault path, never a baked variant. Phase 01 already enforces this; Phase 03 keeps it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-campaign migration loop | Custom iteration of campaigns + bespoke seed-event builder | `scripts/migrate-campaigns-to-vault.ts` wrapping the existing Phase 02 `vault-flip --enable-mutations` logic | Phase 02 ALREADY validated the LEFT JOIN sessions ⨝ session_state pattern for `hp_current`. Re-implementing it here invites the same BLOCKER 1 from Phase 02 plan 02-10 (referencing the wrong column). Wrap, don't rewrite. |
| Postgres-vault diff comparison | Bespoke deep-equal with custom array sort | Normalize both sides into a stable JSON shape (sort arrays, omit metadata) + `JSON.stringify` equality | Deterministic, easy to audit. The projector already enforces sorted `conditions` + `inventory` for spike 013 byte-stability; mirror that on the Postgres side once during normalization. |
| Token estimation | Custom tokenizer (gpt-tokenizer, tiktoken-bpe) | `char.length / 4` heuristic from `references/performance.md` line 99 | The summarizer trigger is approximate by design — REQ-023 says "15K boundary", not "exactly 15000 tokens". A heuristic is faster (no tokenizer module load) and good enough for the trigger decision. The actual prompt_eval_count from Ollama validates at request time. |
| Summary generation | Custom LLM prompt template with multi-step CoT | Single `completeMessage` call with a focused system prompt + `num_predict: 400` cap | The spike 011 finding says "200-word summary"; ~400 tokens of output budget gives the model room for that with prose overhead. No multi-step reasoning needed; the model is summarizing prose, not constructing an argument. |
| Source-of-truth flag plumbing | Bespoke env reader + DB column + UI control + resolver | Mirror the EXACT 4-place pattern from Phase 01 `masterBackend` (Pattern D in 02-PATTERNS.md): `CampaignSettings` + `UserPreferences` + `DEFAULT_PREFERENCES` + resolver + validator arm | Phase 01 + 02 both followed this. Reading the Phase 02 PATTERNS doc end-to-end and copying the parallel-shape is faster + less error-prone than re-deriving. |
| Drizzle migration for pgvector drop | Hand-write SQL | `drizzle-kit generate` from schema delete + check the generated SQL | Drizzle's generator handles the "remove column from index" + "remove FK" + "DROP TABLE" reordering. Hand-writing the SQL risks reordering issues. |
| Ollama model unload | Custom HTTP call to `/api/delete` | `execSync('ollama', ['rm', '<model>'], {stdio: 'inherit'})` | Same shell pattern Phase 02 `vault-backup.ts` uses for git. No new abstraction. |
| Bench runner orchestration | Bespoke stage runner | `scripts/bench-phase-03-m4.ts` that just shells out to `bash .planning/spikes/004-m4-validation/run-on-m4.sh && tsx .planning/spikes/011-full-session-simulation/run-session.ts && bash .planning/spikes/014-narrative-quality/run-on-m4.sh` | The spike harnesses are already validated. The Phase 03 runner is a thin orchestrator + result-aggregator, not a re-implementation. |

**Key insight:** Phase 03 is an orchestration phase. Every primitive on its critical path has either a validated spike OR a Phase 02 module. Hand-rolling here re-introduces regression risk that Phase 02 already absorbed. The Phase 03 acceptance criterion is "the existing pieces compose correctly end-to-end on M4", not "a new framework for migration ships".

## Runtime State Inventory

Phase 03 is a migration phase, so this section is REQUIRED. The question is: after Phase 03's code lands, what runtime systems still hold the old representation?

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | (1) Postgres tables `characters`, `session_state`, `combat_actors` — all per-campaign mutable game state. (2) Postgres table `rag_chunks` + `pgvector` extension. (3) `~/.dnd-ai-master/vault/campaigns/<id>/` per-campaign dirs (Phase 02 already created — Phase 03 bulk-migrates here). | (1) Postgres tables stay during 30-day rollback window; drop migration runs AFTER `ROLLBACK_WINDOW_DAYS` elapses. (2) `rag_chunks` + `pgvector` extension dropped in Phase 03-C (NO rollback window — RAG is off the read path even today). (3) `vault/campaigns/` populated by the bulk migration script in Phase 03-A. |
| Live service config | (1) `MASTER_BACKEND` env var (Phase 01 default `'baked'`). (2) `VAULT_CAMPAIGNS_ROOT` env var (Phase 02 default `~/.dnd-ai-master/vault/campaigns/`). (3) NEW Phase 03 env vars: `MASTER_SOURCE_OF_TRUTH`, `MASTER_SUMMARIZE_TRIGGER`, `MASTER_SUMMARIZE_KEEP_TURNS`, `MASTER_SUMMARIZATION` (on/off kill switch), `ROLLBACK_WINDOW_DAYS`. | (1) `MASTER_BACKEND=vault` MUST be set on M4 before cutover (Phase 03-B). (2) Unchanged. (3) Document defaults in `docs/operators/`; user can override in `.env.local` or Vercel env. |
| OS-registered state | (1) Ollama-installed models on M4: `qwen3:30b-a3b-instruct-2507-q4_K_M` (primary), `qwen3:30b-a3b-instruct-2507` (fallback), `dnd-master-plus` (regression baseline), `dnd-master-{lite,max,max2,max3}` (to be removed), `nomic-embed-text` (RAG embedder — to be removed). | Phase 03-C: `ollama rm dnd-master-lite dnd-master-max dnd-master-max2 dnd-master-max3 nomic-embed-text` on M4. Keep `qwen3:*` and `dnd-master-plus`. |
| Secrets / env vars | No secrets touched. The new env vars (`MASTER_SOURCE_OF_TRUTH`, summarizer config, `ROLLBACK_WINDOW_DAYS`) are non-secret config. | None for secrets. Env vars get a row in `.env.example` if such a file exists in the repo (verify during plan-phase). |
| Build artifacts / installed packages | (1) `node_modules/` re-resolves on `pnpm install` — no change (no new deps). (2) Modelfiles under `Modelfiles/` (if persisted) for retired baked variants — Phase 03-C deletes those. (3) Drizzle migration metadata in `drizzle/meta/` — Phase 03-C migrations add entries. | (1) None. (2) `scripts/build-local-models.ts` already writes Modelfiles to tmpdir per its current shape [VERIFIED: `grep -n "mkdirSync" scripts/build-local-models.ts`]; nothing persisted in-tree. (3) Standard Drizzle workflow — `pnpm db:generate` + commit the SQL. |

**The canonical question:** *After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?*

Three categories survive past code update:

1. **Postgres tables that contained game state.** They are retained for 30 days (configurable) before drop. During that window, the rollback procedure can flip `sourceOfTruth` back to `postgres` and the system functions on the legacy path. After the 30-day drop migration runs, this is irreversible — DR depends solely on vault.

2. **Ollama models on M4.** The decommission script explicitly removes the retired variants. Without that step, the M4 keeps ~50GB of unused baked variants on disk (REQ-020 256GB SSD pressure).

3. **Existing campaign settings JSONB with `masterBackend: 'baked'` or `sourceOfTruth: 'postgres'`.** The bulk migration script flips both to `vault` for every campaign. A campaign created MID-migration (between bulk-flip and cutover) needs the resolver default to fall to vault — hence the env `MASTER_SOURCE_OF_TRUTH=vault` set on M4 before cutover.

Nothing in `SOPS`, Vercel envs, Tailscale ACLs, or external service configs references the old game-state representation. The vault rename Phase 02 already did is OS-local; no external dependencies hold the old paths.

## Common Pitfalls

### Pitfall 1: Mutation-event completeness gap

**What goes wrong:** Phase 02 ships 7 mutation event types (`hp_change`, `condition_add`, `condition_remove`, `spell_slot_use`, `spell_slot_restore`, `inventory_add`, `inventory_remove`). The engine handlers ship ~60+ mutation types (see `src/engine/tools/handlers.ts` lines 99-865 — `roll_dice`, `apply_damage`, `apply_condition`, `make_death_save`, `concentration_check`, `grant_inspiration`, `start_rage`, `use_action_surge`, `set_bastion`, ...). Many of these have no vault counterpart. During dual-write, the engine mutates Postgres but the vault stays stale. Parity-check fires on every divergence; the audit table fills up; the cutover becomes a goal post that recedes.

**Why it happens:** Phase 02 explicitly deferred "additional event types" to Phase 03 [CITED: `02-SUMMARY.md` line 197]. Phase 03 must close this gap BEFORE enabling dual-write or the divergence rate will be 100% on every combat turn.

**How to avoid:** add a Phase 03-A pre-task: **completeness audit**. Grep `src/engine/tools/handlers.ts` for every mutation handler, classify each as:
- (a) **Already covered** by one of the 7 Phase 02 event types (e.g. `apply_damage` → `hp_change`).
- (b) **Stateless** (no game-state mutation; only emits dice rolls / narrative — e.g. `roll_dice`).
- (c) **Needs a new vault event type** (e.g. `make_death_save` → new `death_save_success`/`death_save_fail` events; `start_rage` → `condition_add` with condition='raging' suffices? — TBD).

For each (c), add a discriminant + reducer arm + projector test. The Phase 02 PATTERNS doc shows the exact extension surface (`events-schema.ts` discriminated union + `projector.ts` reducer arm + corresponding test in `tests/ai/master/vault/projector.test.ts`).

**Warning signs:** `parity_check_diverged_rate > 5%` after the dual-write goes live for 24h. If a specific event type is the offender, the diff summary will say so (the parity-check pattern emits `summary: hp_current 50 vs 32` style).

### Pitfall 2: dual-write timeout doubles turn latency

**What goes wrong:** `Promise.all([vaultWrite, postgresWrite])` returns when the SLOWER side completes. If Postgres is briefly slow (Supabase free-tier cold start, network blip), the vault path's "fast write" gets gated to the slow side. Warm wall-clock target REQ-021 (< 10s) might still pass, but the margin shrinks.

**Why it happens:** parallel execution preserves latency of the slowest leg, not average.

**How to avoid:** budget the dual-write at `MASTER_DUAL_WRITE_TIMEOUT_MS` (env, default 5000). If Postgres exceeds it, log "[dual-write] postgres slow" + proceed with vault-only. The divergence record captures the skip. Operator can re-replay later.

**Warning signs:** in `ai_usage`, `eval_duration_ms` plus a new `dual_write_duration_ms` column would show the gap. Phase 03-A can add a metric column to `ai_usage` (lightweight: `dual_write_ms INTEGER NULL`). Plan-phase decides if worth it.

### Pitfall 3: Snapshot-read pivot misses real-time UI updates

**What goes wrong:** Phase 02 surfaced the `VAULT_MUTATIONS_STALE_UI_BANNER` because UI continues reading Postgres while vault writes happen. Phase 03-B pivots reads to vault when `sourceOfTruth === 'vault'`. But the existing SSE stream (`/api/sessions/[id]/stream`) emits `state` events keyed on Postgres update. If Postgres no longer updates (post-cutover), the SSE stops firing → UI doesn't refresh.

**Why it happens:** the SSE event source is Postgres LISTEN/NOTIFY (existing pattern), not filesystem change events.

**How to avoid:** during dual-write (Phase 03-A through 03-B), Postgres KEEPS updating. The SSE keeps firing. Only after the legacy-state drop migration (post-30-day window) does Postgres stop updating — and by then, the operator should have set up either (a) a manual reload pattern in the UI (vault → snapshot-builder re-read on player action), or (b) a Phase 04 feature emitting SSE on EventsWriter completion. **Plan-phase decision: explicitly mark the SSE-firing-from-vault as Phase 04 work** OR ship a minimal `EventsWriter` event-emitter hook in 03-B. Recommendation: defer to Phase 04 with a documented manual-reload UX during the rollback window.

**Warning signs:** Post-cutover, player makes an action, UI doesn't reflect HP change for >5s. Either the SSE didn't fire (post-drop) or the snapshot reader hit cached state.

### Pitfall 4: Summarizer cold-start re-summarizes after restart

**What goes wrong:** Without persistence, every Next.js restart loses the in-memory summary and re-runs `maybeCondense` on the existing accumulated history. For a long-running session, this means a fresh 5-10s condensation hit on the first turn after every restart.

**Why it happens:** the summary lives only in the response stream (in the message history) — it's not in the database.

**How to avoid:** persist the summary in `session_state.summaryBlock` (Phase 03-B new column). On resume, the loop reads the existing summary + recent turns and skips re-summarization unless the cumulative threshold is exceeded AGAIN.

**Warning signs:** `MASTER_SUMMARIZE_TRIGGER` count increases in telemetry on every cold start. If you see it firing on a known-condensed session, the persistence broke.

### Pitfall 5: Drizzle migration order for pgvector drop

**What goes wrong:** `DROP EXTENSION vector` fails if any column or index still references the `vector` type. Drizzle's auto-generator may produce: `DROP COLUMN embedding → DROP TABLE rag_chunks → DROP EXTENSION vector`. If hand-edited, the order could land wrong.

**Why it happens:** Postgres rejects `DROP EXTENSION vector` while any object references it (the `embedding` column in `rag_chunks`).

**How to avoid:** the migration MUST be: (1) DROP INDEX `rag_chunks_embedding_idx`; (2) DROP TABLE `rag_chunks`; (3) `DROP EXTENSION IF EXISTS vector;`. Validate with `pnpm db:migrate` on a fresh PG instance before deploying.

**Warning signs:** migration fails on production with `ERROR: cannot drop extension vector because column embedding ... depends on it`.

### Pitfall 6: Model resolver still references `dnd-master-max2` after retirement

**What goes wrong:** A user's stored `userPrefs.aiMasterModel` is `dnd-master-max2` from before the decommission. After Phase 03-C removes the entry from `TIER_NAMES`, `getBakedBaseModel('dnd-master-max2')` returns `null`; `isBakedModel('dnd-master-max2')` returns `true` (matches prefix); the turn route asks Ollama for `dnd-master-max2:latest` which doesn't exist → 404 → turn fails.

**Why it happens:** stale user-prefs survive decommission. Phase 03's `TIER_NAMES` strip removes the mapping; the legacy slug-derived fallback (`dnd-master-qwen3-30b-a3b-instruct-2507`) STILL applies, but the variant was also removed via `ollama rm`.

**How to avoid:** Phase 03-C decommission script also runs an "userPrefs migration" — `UPDATE users SET preferences = jsonb_set(preferences, '{aiMasterModel}', '"qwen3:30b-a3b-instruct-2507-q4_K_M"') WHERE preferences->>'aiMasterModel' IN ('dnd-master-max', 'dnd-master-max2', 'dnd-master-max3', 'dnd-master-lite')`. Same for `campaigns.settings.aiMasterModel` if it lives there. Plan-phase verifies the column path.

**Warning signs:** post-decommission, a specific user's turns fail with `ollama 404 model not found`. Telemetry in `ai_usage` would show the bad model.

### Pitfall 7: Final M4 sweep run before decommission corrupts baseline

**What goes wrong:** Phase 03-D bench compares vault-on-M4 against the spike 003/004 baked baseline (26s warm baked). If the bench runs AFTER decommission removes `dnd-master-plus`, there's no baseline to compare against — the comparison degenerates to "vault on its own".

**Why it happens:** ordering of waves. The naive Phase 03 ordering "decommission then bench" makes the bench unable to A/B test.

**How to avoid:** run Phase 03-D BEFORE 03-C. Sub-phase ordering: 03-A → 03-B → 03-D → 03-C. The bench captures the decision-grade numbers WHILE `dnd-master-plus` still exists, then decommission strips everything except plus.

**Warning signs:** Phase 03-D bench result file says "baked baseline: not found".

### Pitfall 8: `events.md` grows past 10K events before snapshot/compact

**What goes wrong:** Phase 02 SUMMARY explicitly defers compaction to Phase 03 [CITED: `02-SUMMARY.md` line 195]. After dual-write enables, every turn writes multiple events. A 50-turn session with 10 events per turn = 500 events. Multiple sessions per campaign = 5K-10K events.

**Why it happens:** replay scales linearly; 10K events ≈ 100ms on M4 [CITED: skill page `storage-and-mutation.md` line 151]. Every snapshot read pays this cost.

**How to avoid:** Phase 03 ships WITHOUT compaction (it's Phase 03 SUMMARY line 195's call-out to "if telemetry warrants" — Phase 03 measures telemetry, but is not committed to shipping compaction). Plan-phase decision: include a `pnpm vault:snapshot-compact --campaign=<uuid>` script for offline compaction IF the M4 sweep shows a regression. Default: defer to a Phase 04 if avg replay > 200ms.

**Warning signs:** Phase 03-D M4 sweep shows turn latency creeping above 8s on a long-played campaign. Replay is the culprit.

## Code Examples

### Bulk migration script (Phase 03-A)

```typescript
// Source: NEW scripts/migrate-campaigns-to-vault.ts (Phase 03-A)
// Reuses scripts/vault-flip.ts flipCampaign + enable-mutations logic in a loop.
import './_env-loader';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';
import { isNull, sql } from 'drizzle-orm';
import { flipCampaignToVault, enableMutationsForCampaign } from './vault-flip-helpers';
// ↑ NEW exports from scripts/vault-flip.ts (refactored — current vault-flip.ts has these
//   inline in main(); plan-phase exports them as named functions for reuse).

interface Args {
  dryRun: boolean;
  filter: string | null;  // optional substring match on campaign name
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, filter: null };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--filter=')) args.filter = a.slice('--filter='.length);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(sql`last_played_at DESC NULLS LAST`);

  console.log(`[migrate] found ${rows.length} campaign(s)`);

  let migrated = 0;
  let skipped = 0;
  let errored = 0;
  const errors: { id: string; name: string; error: string }[] = [];

  for (const row of rows) {
    if (args.filter && !row.name.toLowerCase().includes(args.filter.toLowerCase())) {
      skipped++;
      continue;
    }
    const alreadyVault = row.settings?.masterBackend === 'vault' && row.settings?.vaultMutations === true;
    if (alreadyVault) {
      console.log(`[migrate] ${row.id} ${row.name} — already on vault, skipping`);
      skipped++;
      continue;
    }
    try {
      if (!args.dryRun) {
        await flipCampaignToVault(row.id);              // sets masterBackend='vault'
        await enableMutationsForCampaign(row.id);       // sets vaultMutations=true + writes seed event
      }
      migrated++;
      console.log(`[migrate] ${row.id} ${row.name} — ${args.dryRun ? 'DRY' : 'MIGRATED'}`);
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ id: row.id, name: row.name, error: msg });
      console.error(`[migrate] ${row.id} ${row.name} — ERROR: ${msg}`);
    }
  }

  console.log('---');
  console.log(`[migrate] migrated=${migrated} skipped=${skipped} errored=${errored}`);
  if (errored > 0) {
    console.log('[migrate] errors:');
    for (const e of errors) console.log(`  - ${e.id} ${e.name}: ${e.error}`);
  }
  await pool.end();
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('migrate-campaigns-to-vault failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

### Bench-phase-03-m4 runner

```typescript
// Source: NEW scripts/bench-phase-03-m4.ts (Phase 03-D)
// Unified runner for spike 004 + 011 + 014 against the post-cutover state.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface BenchResult {
  stage: 'g1' | 'g2' | 'long-session' | 'narrative';
  passed: boolean;
  measured: number | string;
  target: number | string;
  notes?: string;
}

const RESULTS_DIR = '.planning/phases/03-migration-cutover/bench-results';
const TS = new Date().toISOString().replace(/[:.]/g, '-');

function runStage(name: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], env });
}

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const results: BenchResult[] = [];

  // Stage 1: spike 004 — G1 warm wall-clock < 5s target (decision-grade)
  const stage1 = runStage('Stage 1 — spike 004 M4 sweep', 'bash .planning/spikes/004-m4-validation/run-on-m4.sh');
  // (parse logs; populate results[])

  // Stage 2: spike 011 — long-session prompt growth + summarizer enabled
  const stage2 = runStage(
    'Stage 2 — spike 011 long-session (summarizer ON)',
    'pnpm exec tsx .planning/spikes/011-full-session-simulation/run-session.ts',
    { ...process.env, MASTER_SUMMARIZATION: 'on' },
  );

  // Stage 3: spike 014 — narrative quality 5-keyword
  const stage3 = runStage('Stage 3 — spike 014 narrative quality', 'bash .planning/spikes/014-narrative-quality/run-on-m4.sh');

  // Aggregate
  const outPath = join(RESULTS_DIR, `phase-03-m4-${TS}.json`);
  writeFileSync(outPath, JSON.stringify({ ts: TS, results, stages: { stage1, stage2, stage3 } }, null, 2));
  console.log(`\n→ results: ${outPath}`);

  // Update Phase 01 SUMMARY.md table — prompt operator to confirm + apply manually
  // (NOT automated — table edits are sensitive and the operator should verify the numbers)
  console.log('\nNext: update .planning/phases/01-vault-read-path/SUMMARY.md "M4 target hardware" table');
}

main();
```

### Drizzle migration: pgvector drop

```sql
-- Source: NEW drizzle/003X_drop_pgvector.sql (Phase 03-C)
-- Order matters: index first, table second, extension last.
DROP INDEX IF EXISTS "rag_chunks_embedding_idx";
DROP INDEX IF EXISTS "rag_chunks_source_hash_idx";
DROP TABLE IF EXISTS "rag_chunks";
DROP EXTENSION IF EXISTS vector;
```

### Drizzle migration: session_state.summaryBlock

```sql
-- Source: NEW drizzle/003Y_session_state_summary.sql (Phase 03-B)
-- Additive column for the summarizer's persisted summary block.
ALTER TABLE "session_state" ADD COLUMN "summary_block" jsonb;
```

```typescript
// Source: MODIFY src/db/schema/session-state.ts
// Add after existing columns:
summaryBlock: jsonb('summary_block').$type<{ text: string; generatedAt: string; tokensBefore: number } | null>().default(null),
```

## Phase 02 → Phase 03 Decision Carry-Over

Phase 02 closed 11 decisions. Phase 03 carries them forward unchanged. The 7 Phase-02-open-questions (Open Items section, `02-SUMMARY.md` lines 178-211) are addressed in Phase 03 as follows:

| Phase 02 deferred item | Phase 03 disposition |
|------------------------|----------------------|
| Dual-write to Postgres for opted-in campaigns | **OWNED — Phase 03-A** (DualWriter pattern §3.1) |
| UI vault-read path | **OWNED — Phase 03-B** (snapshot-reader §3.4 + sourceOfTruth pivot) |
| RAG retirement + baked-variant retirement | **OWNED — Phase 03-C** (§6) |
| Event-log compaction / snapshot (T-02-09) | **MEASURED in Phase 03-D**; ship only if M4 sweep shows degradation > target |
| Per-turn summarization at 15K tokens (REQ-023) | **OWNED — Phase 03-B** (condense.ts §3.3) |
| Additional event types (`temp_hp_set`, `death_save_*`, `concentration_break`, `attune`, `unattune`) | **OWNED — Phase 03-A pre-task** (completeness audit; see Pitfall 1) |
| Automated post-event push from Next.js | **DEFERRED — Phase 04** (Phase 03 keeps operator-driven `pnpm vault:backup`; the cron-from-server is non-critical) |
| Multi-process EventsWriter | **DEFERRED — Phase 04+** (NON-REQ-001 single-server invariant unchanged) |
| End coexistence by ending the baked path | **OWNED — Phase 03-C** (decommission baked variants) + Phase 03-B (UI reads vault) |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Postgres-backed game state (`session_state` + `characters`) | events.md per-campaign + materialized views | Phase 02 (per-campaign opt-in) → Phase 03 (cohort-wide cutover) | Phase 03 closes the migration; Postgres tables drop after 30-day rollback window |
| RAG retrieval (pgvector + nomic-embed-text + ollama embedder) | Vault path with `read_vault_multi` + `list_vault` | Phase 01 (alternative path behind flag) → Phase 03 (RAG fully retired) | -84% prompt tokens; -85.5% warm wall-clock on M4 [CITED: spike 004] |
| 5 baked variants (`dnd-master-{lite,max,max2,max3,plus}`) | Single base model `qwen3:30b-a3b-instruct-2507-q4_K_M` resolved at runtime via `userPrefs.aiMasterModel` (vault path) | Phase 03-C decommission | -50GB SSD on dev; -14-18GB on M4; matches REQ-033 + the Phase 02 SUMMARY "End coexistence" item |
| Unbounded prompt growth on long sessions | Per-turn summarization at 15K-token boundary (`maybeCondense`) | Phase 03-B | Closes spike 011 turn 8 finding (22K prompt tokens, 31.5s wall); estimated 20-turn session avg stays flat |
| Postgres-LISTEN/NOTIFY SSE for state updates | (Phase 03 transitionary — Postgres still updates during dual-write window) | Phase 04+ (filesystem watcher or EventsWriter event emitter for SSE) | Documented but deferred |

**Deprecated/outdated (relative to Phase 03):**
- `src/ai/master/rag/*` — DELETED in Phase 03-C
- `scripts/build-rag-index.ts` — DELETED in Phase 03-C
- `rag_chunks` table + `pgvector` extension — DROPPED in Phase 03-C migration
- `dnd-master-{lite,max,max2,max3}` baked variants — REMOVED from `TIER_NAMES` + Modelfile generation in Phase 03-C
- `VAULT_MUTATIONS_STALE_UI_BANNER` constant — DEPRECATED in Phase 03-B (UI reads vault directly; no more stale banner); kept in source for the rollback window
- Postgres `characters` + `session_state` + `combat_actors` tables — RETAINED 30 days post-cutover; DROPPED in a scheduled migration after the rollback window

## Architectural Decisions (Phase 03)

The phase brief flagged 10 open design questions. Each is addressed below with a recommended answer and rationale. The planner can adopt or override these; this section exists so plan-phase doesn't re-litigate them from scratch.

### Decision 1: Migration trigger

**Question:** One-shot bulk script OR per-campaign opt-in?

**Recommendation:** **Bulk script that wraps the Phase 02 per-campaign flip in a loop.**

**Rationale:** Per-campaign opt-in is already shipped (`vault-flip --enable-mutations`). Phase 03's bulk script is a thin loop around it with idempotency (re-run-safe: skips campaigns already on vault), a `--dry-run` flag, a `--filter` flag, and a divergence-report at the end. ~80 LOC of orchestration over the Phase 02 primitive. No new design risk.

### Decision 2: Dual-write architecture

**Question:** (A) inline in turn-route, (B) `DualWriter` wrapper class, (C) async reconciliation worker.

**Recommendation:** **Option B — `DualWriter` class.**

**Rationale:** Option A makes the route handler grow unbounded (the vault branch is already ~160 LOC in `turn/route.ts` from Phase 01+02). Option C introduces eventual consistency, which makes parity-check ambiguous (when do we check?). Option B encapsulates the fan-out + parity-check in one module, testable in isolation, and removable in Phase 03-C decommission. The handler change is a one-line replacement: `await EventsWriter.applyEvent(...)` → `await dualWriteApplyEvent(env, mutation, ctx)`.

### Decision 3: Divergence alarm channel

**Question:** console+log aggregator, dedicated DB table, or both.

**Recommendation:** **Both — DB table `dual_write_divergences` as the primary, with console.error fallback for visibility during local dev.**

**Rationale:** A DB table is queryable (operator can `SELECT * FROM dual_write_divergences WHERE created_at > now() - interval '24h'`). Console-only would require log aggregator setup (Sentry, Datadog) which isn't in scope. The schema is minimal:

```sql
CREATE TABLE dual_write_divergences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id uuid,
  event_type  text,
  vault_state jsonb,
  postgres_state jsonb,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dual_write_divergences_session_idx ON dual_write_divergences (session_id, created_at DESC);
```

### Decision 4: Cutover semantics

**Question:** `sourceOfTruth: 'postgres' | 'vault'` flag flip → all reads pivot; Postgres becomes read-only mirror.

**Recommendation:** **YES — exactly as stated. Reads pivot; writes STILL dual-write during the rollback window so Postgres stays in sync as a rollback target.**

**Rationale:** Reads pivoting to vault is what makes "cutover" cut over. Writes continuing to Postgres for 30 days keeps the rollback path viable. After the 30-day legacy-table drop migration, Postgres writes for game state stop (the engine handlers that write to `session_state` get removed in a Phase 04 cleanup). For the rollback window: source-of-truth IS vault; Postgres is a read-only mirror maintained by dual-write.

### Decision 5: Rollback window

**Question:** 24h cutover reversibility + 30d Postgres retention. Configurable.

**Recommendation:** **Make BOTH configurable via env, with sane defaults: `CUTOVER_ROLLBACK_HOURS=24`, `ROLLBACK_WINDOW_DAYS=30`.**

**Rationale:** The 24h is the "if something burns in the first day, flip back" gate — different from the 30d "data still recoverable from PG" gate. They're independent. Env-driven so an operator can extend either window if cutover happens during a low-traffic period (e.g., extend to 14d if going on vacation). The legacy-state drop migration runs only after `ROLLBACK_WINDOW_DAYS` AND a manual `pnpm decommission-legacy-state --confirm` step (the migration is destructive; manual confirmation gates it).

### Decision 6: Per-turn summarization trigger logic (REQ-023)

**Question:** Trigger count? Where in loop? What model? Sync/async? Where stored?

**Recommendation:**
- **Trigger:** cumulative prompt > 15K tokens (env override `MASTER_SUMMARIZE_TRIGGER`, default 15000). Spike 011 measured the bottleneck at this threshold.
- **Where:** inside `runVaultToolLoop`, before each `provider.completeMessage`. Synchronous — the LLM sees the truncated history on the next round-trip.
- **Model:** same primary model the session uses (REQ-034 — no per-turn router). Spike 011 sketch in `references/performance.md` already assumes single-model.
- **Sync/async:** synchronous. ~5-10s condensation latency (LLM call) per ~50 turns; amortizes cleanly.
- **Storage:** `session_state.summaryBlock` JSONB column (NEW Phase 03-B). Survives restart.

**Rationale:** the trigger + storage decisions follow spike 011 + skill page verbatim. The "same model" choice is REQ-034. Sync is simpler and matches the rest of the loop.

### Decision 7: RAG decommission ordering

**Question:** Multiple ordered steps; each independently revertable?

**Recommendation:** **Per-step commits — 5 commits total, in this order:**
1. Remove RAG imports + callers in `turn/route.ts` (no callers in vault path already; baked-path callers go away in step 4).
2. Delete `src/ai/master/rag/*` + tests.
3. Delete `scripts/build-rag-index.ts` + `pnpm build-rag-index` script entry.
4. Drizzle migration: DROP INDEX → DROP TABLE rag_chunks → DROP EXTENSION vector.
5. `ollama rm nomic-embed-text` on M4 (operator-run during cutover).

Each commit lands in a separate plan task. If a regression surfaces, revert the single offending commit.

### Decision 8: Baked variant decommission

**Question:** Keep `dnd-master-plus` only? Or also `dnd-master-max2`?

**Recommendation:** **Keep `dnd-master-plus` ONLY. Per REQ-033 the regression baseline is one model. `qwen3:30b-a3b-instruct-2507-q4_K_M` is the production model resolved as the BASE slug at runtime (not baked).**

**Rationale:** REQ-033 says "keeps `dnd-master-plus` only as a regression-test baseline". The Phase 01 SUMMARY confirms `dnd-master-max2` was used as the smoke-validation baked variant; that smoke is closed. The production model never goes through the baked path on vault — it's resolved as a BASE slug. Keeping `dnd-master-max2` baked would defeat REQ-033 ("drop all baked variants").

The `qwen3:30b-a3b-instruct-2507` quality-fallback (REQ-031) also stays as a BASE slug, not baked. Phase 03-C plan-phase confirms the model selector dropdown shows: `qwen3:30b-a3b-instruct-2507-q4_K_M` (primary, default), `qwen3:30b-a3b-instruct-2507` (quality fallback, REQ-031), `mistral-small3.2:24b` (offline content, REQ-032), `dnd-master-plus` (regression baseline, REQ-033). All others removed from the dropdown.

### Decision 9: Final M4 sweep deliverable

**Question:** Single bundled bench script? Output format? Where stored?

**Recommendation:** **`pnpm bench-phase-03-m4` — single CLI runner that shells out to the existing spike harnesses in sequence + aggregates. Output: `.planning/phases/03-migration-cutover/bench-results/phase-03-m4-<ts>.json`. Operator manually updates Phase 01 SUMMARY.md "M4 target hardware" table after reviewing the JSON.**

**Rationale:** the spike harnesses are validated; re-implementing them invites regression. A thin orchestrator + result aggregator is ~50 LOC. The Phase 01 SUMMARY update is manual because table edits are sensitive — the operator confirms the numbers look right before applying. The JSON gets committed (alongside the SUMMARY update) so future sweeps can diff.

### Decision 10: Cumulative migration completeness audit

**Question:** Does every Postgres mutation pattern have a corresponding event_type?

**Recommendation:** **Add a Phase 03-A pre-task (Task 0) — grep engine handlers, classify, propose new event types as needed. Plan-phase produces a concrete list.**

**Rationale:** Phase 02 SUMMARY explicitly defers this [line 197 — `temp_hp_set`, `death_save_*`, `concentration_break`, `attune`, `unattune`]. Phase 03 cannot enable dual-write until the gap closes — every uncovered mutation would cause a parity divergence on every combat turn. The audit is mechanical (grep + classify) but load-bearing.

Concrete approach: enumerate the `TOOL_HANDLERS` keys in `src/engine/tools/handlers.ts` (~60+ keys per the grep). For each, decide:
- (a) Already covered (e.g., `apply_damage` → emit `hp_change` event).
- (b) Stateless (e.g., `roll_dice` doesn't mutate persistent state — no vault event needed).
- (c) Needs new event type — list those for the planner to spec in PLAN.md.

Phase 03 should ship the (c) event types BEFORE turning on dual-write — otherwise dual-write divergence rate is ~100% on combat turns. Estimated count of (c): 8-15 new event types. Same additive surface Phase 02 used (TS discriminated union + reducer arm + projector test). Budget ~1-2 days of work.

## Open Questions

1. **SSE event source post-cutover.** The current SSE stream emits `state` events on Postgres LISTEN/NOTIFY. After 30-day legacy-state drop, Postgres no longer updates. What replaces the SSE trigger? Options: (a) `EventsWriter` post-write hook emits a filesystem-watchable event; (b) explicit refetch on player action; (c) Phase 04 fully replaces SSE with filesystem watcher. **Researcher leans: defer to Phase 04** with a documented "manual refresh" UX during the rollback window. Plan-phase confirms with operator if acceptable.

2. **Sync vs async dual-write timeout.** Pitfall 2 raises this. `MASTER_DUAL_WRITE_TIMEOUT_MS=5000` is a sensible default; needs validation against real Supabase latency.

3. **Mistral non-default Settings option (REQ-032) — install path.** `mistral-small3.2:24b` is the offline content tool. After decommission, no `dnd-master-max` baked exists. The Settings dropdown shows the BASE slug. User must `ollama pull mistral-small3.2:24b` manually. Should Phase 03 include a "click to install" UI affordance? **Researcher leans: NO** — defer to Phase 04+. Phase 03 documents the manual install command.

4. **Backup cadence during cutover window.** Phase 02 ships operator-driven `pnpm vault:backup`. During the 30-day rollback window, the operator should backup MORE frequently (daily? after every session?). Defer to plan-phase to spec the cadence + add a cron-job snippet in `docs/operators/`.

5. **`session_state.summaryBlock` JSONB shape evolution.** Phase 03-B ships `{ text, generatedAt, tokensBefore }`. Future fields (e.g., `summaryModel`, `condensedFromTurns`) are additive. Planner decides if the initial shape should include those fields as optional from day one (forward-compat) or add them later when telemetry warrants.

6. **Bench-script-vs-manual M4 sweep.** Decision 9 recommends a unified runner. Alternative: each spike runs independently and the operator manually aggregates. **Researcher leans: unified runner** because the 3 stages share env setup (cold-start M4, dedicated machine). Plan-phase confirms.

7. **Parity-check granularity.** Parity-check runs per `apply_event`. Should it ALSO run at session-resume (catch divergences accumulated during server downtime)? **Researcher leans: YES** — add a session-start parity-check as a smoke gate. Cheap (one comparison) and catches divergences the per-event check missed. Plan-phase decides.

8. **Decommission script vs manual decommission.** Phase 03-C is 9 separate steps. A `scripts/decommission-rag.ts` + `scripts/decommission-baked.ts` automates some of them. Worth the scripting overhead? **Researcher leans: YES for `decommission-baked.ts`** (because it runs `ollama rm` which needs to coordinate with the M4 host) and **NO for `decommission-rag.ts`** (it's just file deletion + 1 migration — git makes this safer to do manually).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node `node:fs/promises` | EventsWriter, projector, migration script | ✓ | Node 20+ (builtin) | — |
| Node `node:child_process` | `ollama rm`, git invocations in decommission scripts | ✓ | Node 20+ (builtin) | — |
| `drizzle-orm` | Postgres reads/writes during dual-write + migration | ✓ | 0.45.2 [VERIFIED: package.json] | — |
| `vitest` | All test files | ✓ | 4.1.5 [VERIFIED: package.json] | — |
| `tsx` | CLI script execution | ✓ | 4.21.0 [VERIFIED: package.json] | — |
| Postgres + drizzle-kit | Drop migrations (rag_chunks, pgvector); session_state.summary_block ADD COLUMN | ✓ (Supabase prod) | — | — |
| Ollama on M4 with `qwen3:30b-a3b-instruct-2507-q4_K_M` | Bench runner Stage 1 (G1 warm wall-clock) | ✓ (per spike 004 — already pulled) | — | — |
| Ollama on M4 with `qwen3:30b-a3b-instruct-2507` (non-q4 quality fallback) | Stage 1 (G1 compare) + REQ-031 production availability | ✓ (per spike 004) | — | — |
| Ollama on M4 with `dnd-master-plus` | Bench runner Stage 1 baked baseline (REQ-033 regression baseline) | ✓ (per spike 004) | — | — |
| Ollama on M4 with `mistral-small3.2:24b` | REQ-032 offline content (NOT in benchmark; just availability) | ✓ (per spike 014) | — | Defer to Phase 04: include "install command" UI hint |
| `VAULT_CAMPAIGNS_ROOT` writable on M4 | Vault writes (migration + dual-write + post-cutover) | ✓ (Phase 02 already validated) | — | — |
| Git CLI for `pnpm vault:backup` | Operator-driven backup during cutover window | ✓ (dev machine has gh) | — | Tarball fallback (Phase 02 already supports `--strategy=tarball`) |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

**M4 production SSD budget consideration:** post-decommission SSD reclaim:
- `nomic-embed-text` removed: ~270 MB.
- `dnd-master-{lite,max,max2,max3}` removed: ~14-18 GB each × 4 = ~50 GB.
- Total reclaim: ~50 GB.

Final M4 SSD post-decommission: ~256 GB total - (macOS 50 GB + Node + Ollama + `qwen3:30b-a3b-instruct-2507-q4_K_M` 18 GB + `qwen3:30b-a3b-instruct-2507` 18 GB + `mistral-small3.2:24b` 14 GB + `dnd-master-plus` 13 GB + vault data <2 GB) ≈ ~140 GB free. Comfortable. Matches ROADMAP criterion "SSD usage drops by >30GB".

## Validation Architecture

> `.planning/config.json` does NOT exist in this repo [VERIFIED: `cat .planning/config.json` failed with file-not-found]. Per the research protocol, when the config key is absent the section is INCLUDED.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 (`"test": "vitest run"`) |
| Config file | `vitest.config.ts` (existing; Phase 01+02 cumulative 399 passed / 2 skipped) |
| Quick run command | `pnpm test tests/ai/master/vault/dual-writer.test.ts -- --reporter=verbose` |
| Full suite command | `pnpm test` |

**Critical scope rule (inherited from Phase 01 SUMMARY line 51 + Phase 02 SUMMARY):** Vitest scans ONLY `tests/**/*.test.{ts,tsx}`. Colocated tests are NOT picked up. ALL Phase 03 tests under `tests/ai/master/vault/`, `tests/sessions/`, `tests/scripts/`, `tests/lib/`. **Honor this — every test goes under `tests/`.**

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REQ-006 | DR via events.md replay (already proven; Phase 03 confirms migration script preserves DR) | integration | `pnpm test tests/ai/master/vault/apply-event-integration.test.ts -t "dr"` | ✓ (Phase 02 existing) |
| REQ-020 | M4 production hardware (manual sweep — not automated in CI) | manual-only | `pnpm bench-phase-03-m4` on M4 (REQ-020 requires production hw) | ❌ Wave 03-D |
| REQ-023 | Summarizer fires at 15K tokens; condenses to ~200 words; persists | unit + integration | `pnpm test tests/ai/master/vault/condense.test.ts` | ❌ Wave 03-B |
| REQ-031 | `qwen3:30b-a3b-instruct-2507` selectable as `aiMasterModel` | unit | `pnpm test tests/lib/preferences-master-backend.test.ts -t "fallback"` | ✓ MODIFY existing |
| REQ-032 | `mistral-small3.2:24b` selectable as `aiMasterModel` (no baked variant required) | unit | `pnpm test tests/lib/preferences-master-backend.test.ts -t "mistral"` | ✓ MODIFY existing |
| REQ-033 | `TIER_NAMES` has only `dnd-master-plus`; build script skips others | unit | `pnpm test tests/ai/master/baked-models.test.ts -t "tier-names"` | ❌ Wave 03-C |
| REQ-034 | Summarizer uses the same primary model (no router) | unit | `pnpm test tests/ai/master/vault/condense.test.ts -t "same-model"` | ❌ Wave 03-B |
| Phase gate | Bulk migration is idempotent (re-run produces no new events) | integration | `pnpm test tests/scripts/migrate-campaigns-to-vault.test.ts -t "idempotent"` | ❌ Wave 03-A |
| Phase gate | Dual-write divergence rate < 0.1% over 100 simulated turns | integration | `pnpm test tests/ai/master/vault/dual-writer.test.ts -t "divergence-rate"` | ❌ Wave 03-A |
| Phase gate | Cutover script is reversible (flip sourceOfTruth back to postgres) | integration | `pnpm test tests/scripts/vault-flip.test.ts -t "source-of-truth-rollback"` | ❌ Wave 03-B |
| Phase gate | RAG code paths fully removed; build succeeds without pgvector | smoke | `pnpm build` after Phase 03-C migration | manual-verify |
| Phase gate | M4 sweep: G1 warm < 5s, narrative ≥4/5 | manual-only | `pnpm bench-phase-03-m4` on M4 | ❌ Wave 03-D |

### Sampling Rate

- **Per task commit:** `pnpm test tests/ai/master/vault/ tests/lib/ tests/sessions/` (vault + preferences + sessions subsets — runs in ~5-8s)
- **Per wave merge:** `pnpm test` (full Vitest suite — Phase 01 + 02 + 03 cumulative; expected ~450 cases at Phase 03 close)
- **Phase gate:** Full suite green + manual M4 bench run (`pnpm bench-phase-03-m4` produces decision-grade numbers) before `/gsd-verify-work`

### Wave 0 Gaps

Phase 03-A:
- [ ] `tests/scripts/migrate-campaigns-to-vault.test.ts` — bulk migration idempotency + per-campaign error isolation + dry-run mode + filter mode
- [ ] `tests/ai/master/vault/dual-writer.test.ts` — Promise.all both writes; parity-check fires; divergence record on mismatch; divergence rate over 100 simulated turns
- [ ] `tests/ai/master/vault/parity-check.test.ts` — replay matches Postgres; diff summary normalized; skips unseeded characters
- [ ] `tests/ai/master/vault/events-schema.test.ts` — **MODIFY** to add the new event types from the completeness audit (Decision 10)
- [ ] `tests/ai/master/vault/projector.test.ts` — **MODIFY** to add reducer arms for new event types
- [ ] `tests/db/dual-write-divergences.test.ts` — schema + index test for the new table

Phase 03-B:
- [ ] `tests/ai/master/vault/condense.test.ts` — trigger at 15K; skip below; condense to N words; persist; restore on restart
- [ ] `tests/ai/master/vault/source-of-truth.test.ts` — resolver follows Phase 01 pattern; env override works
- [ ] `tests/ai/master/vault/snapshot-reader.test.ts` — materialize from vault → matches Postgres shape during dual-write
- [ ] `tests/sessions/client-snapshot.test.ts` — **MODIFY** to add sourceOfTruth='vault' pivot case
- [ ] `tests/lib/preferences-source-of-truth.test.ts` — validator + resolver tests (parallel-shape from Phase 01/02)
- [ ] `tests/scripts/vault-flip.test.ts` — **MODIFY** to add `--source-of-truth=vault|postgres` flag tests

Phase 03-C:
- [ ] `tests/ai/master/baked-models.test.ts` — assert TIER_NAMES contains only `dnd-master-plus`; legacy stale-pref migration test
- [ ] `tests/db/migrations/0XYZ-pgvector-drop.test.ts` (or smoke via `pnpm db:migrate` on fresh schema)
- [ ] Decommission scripts (decommission-rag.ts, decommission-baked.ts) — happy path + reversal documentation
- [ ] **DELETE** `tests/ai/master/rag/*` (alongside source deletion)

Phase 03-D:
- [ ] `scripts/bench-phase-03-m4.ts` — orchestrator (real bench runs on M4 only — manual; CI lints script-shape)
- [ ] Phase 01 SUMMARY.md update (manual operator step after reviewing bench JSON)

**Framework install: NONE.** Vitest covers everything; no new test runner needed.

## Security Domain

> `security_enforcement` not declared in any config — treat as enabled per protocol.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Clerk JWT validated by `auth()` from `@clerk/nextjs/server` at the turn route entry (existing — inherited from Phase 01+02). Phase 03 adds no new entry points. Decommission scripts run via CLI (operator-trusted). |
| V3 Session Management | yes | Clerk session + per-campaign access check (`checkPartyAccess`) — existing. Phase 03 adds no new session boundaries. |
| V4 Access Control | yes | `checkPartyAccess(userId, sessionId)` gates the turn route. Decommission scripts run with operator credentials. Migration script can be hardened with a `--user=<id>` filter if multi-tenant; for single-user M4 deployment, this is unneeded. |
| V5 Input Validation | yes | Migration script validates UUIDs (reuse Phase 02 `UUID_REGEX`); dual-write validates event payloads (existing Phase 02 `validateEvent`). The `sourceOfTruth` flag is validated by `validateSettingsPatch` (parallel-shape from Phase 01/02). Summarizer input is the existing message history (already trusted). |
| V6 Cryptography | yes | `crypto.randomUUID()` for new event IDs (existing Phase 02 pattern). No new crypto needed. Vault content unencrypted at rest (NON-REQ-005). |

### Known Threat Patterns for {Phase 03 specifics}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Migration script run by unauthorized user | Elevation of privilege | The script reads `DATABASE_URL` from env — anyone with shell access on the M4 already has full access. Single-user invariant. Document in operator notes that the script must be run AS the operator. |
| Decommission migration runs before all campaigns migrated | Tampering / Denial of service | The drop-pgvector migration runs in Phase 03-C — AFTER 03-A bulk migration. The legacy-state drop runs even later, after `ROLLBACK_WINDOW_DAYS`. Documented in plan-phase ordering; operator runs `pnpm db:migrate` manually at the right wave boundary. |
| Dual-write divergence used to inject malicious state | Tampering | The DualWriter does NOT auto-correct on divergence; an audit row is created but no state is "fixed". The operator inspects manually. The LLM (which COULD try to game the divergence) is sandboxed by the existing `validateEvent` type guards (Phase 02). |
| Summary block exfiltration via the summarizer | Information disclosure | The summary is the LLM's compressed view of the history — it cannot contain anything not already in the prompt. Storage in `session_state.summaryBlock` is RLS-gated by the existing session-access patterns (campaign owner + party members can read). No new exfil surface. |
| Stale baked-model reference after decommission causes 404 turns | Denial of service (self-inflicted) | Pitfall 6 — Phase 03-C decommission migrates `userPrefs.aiMasterModel` to the BASE slug for any stored baked variants. Post-decommission, no user can land on a missing model. |
| `pnpm vault:backup` push during cutover races with dual-write | Tampering | `vault-backup.ts` already refuses to push on uncommitted manual edits (T-02-06 defense from Phase 02). Dual-write appends to events.md are legitimate appends — diff shows added lines only — backup proceeds. Backup during active dual-write is safe. |
| Postgres tables dropped while vault data corrupt | Denial of service (irreversible) | The legacy-state drop migration is gated by manual confirmation (`pnpm decommission-legacy-state --confirm`). Pre-flight: confirm `pnpm vault:rebuild-views --all` succeeds without errors. Pre-flight: confirm bench-phase-03-m4 results passed. |

## Sources

### Primary (HIGH confidence)

- `.planning/REQUIREMENTS.md` — REQ-006, REQ-020, REQ-023, REQ-031, REQ-032, REQ-033, REQ-034 (LOCKED by spike validation)
- `.planning/ROADMAP.md` — Phase 03 scope (lines 64-89)
- `.planning/PROJECT.md` — Project overview and current milestone
- `.planning/spikes/MANIFEST.md` — All 14 spikes with verdicts; G1/G2 gate status
- `.planning/spikes/WRAP-UP-SUMMARY.md` — Phase 1 deliverables (per-turn summarization line 73)
- `.planning/spikes/004-m4-validation/README.md` — M4 sweep procedure + decision-grade numbers (3.78s warm primary)
- `.planning/spikes/011-full-session-simulation/README.md` — Long-session prompt growth + condensation pattern (Signal for real build, line 122)
- `.planning/spikes/013-vault-backup-restore/README.md` — DR procedure (Phase 02 already shipped backup/restore)
- `.planning/spikes/014-narrative-quality/README.md` — Narrative quality validation (primary unchanged, mistral offline-only)
- `.planning/phases/01-vault-read-path/SUMMARY.md` — Phase 01 outcomes + REQ-021 deferral language (lines 58-86)
- `.planning/phases/01-vault-read-path/RESEARCH.md` — Phase 01 design choices (vitest scope, branch routing, etc.)
- `.planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md` — Phase 02 outcomes + Open Items (lines 178-211) + 11 locked decisions
- `.planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md` — Phase 02 architectural decisions + open questions
- `.planning/phases/02-vault-write-path-event-sourcing/02-PATTERNS.md` — Pattern map (lines 933-947 Pattern D parallel-shape; line 965 Pattern F CLI script shape)
- `.claude/skills/spike-findings-dnd-ai-master/SKILL.md` — Auto-loaded skill
- `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` — Implementation contract for migration writes
- `.claude/skills/spike-findings-dnd-ai-master/references/performance.md` — `maybeCondense` pattern (lines 92-114) for REQ-023
- `.claude/skills/spike-findings-dnd-ai-master/references/model-selection.md` — Model decommission decisions
- `src/ai/master/vault/path.ts` — Phase 01 VAULT_CAMPAIGNS_ROOT
- `src/ai/master/vault/events-writer.ts` — Phase 02 EventsWriter (Phase 03 wraps in DualWriter)
- `src/ai/master/vault/projector.ts` — Phase 02 projector (Phase 03 extends with new event arms per Decision 10)
- `src/ai/master/vault/campaign-paths.ts` — Phase 02 path resolver
- `src/ai/master/vault/events-schema.ts` — Phase 02 event union (Phase 03 extends per Decision 10)
- `src/ai/master/baked-models.ts` — TIER_NAMES (Phase 03 strips 4 of 5 entries per REQ-033)
- `src/ai/master/rag/*.ts` — RAG modules (Phase 03 deletes)
- `src/db/schema/rag-chunks.ts` — pgvector schema (Phase 03 drops)
- `src/db/schema/session-state.ts` — session state (Phase 03 adds summaryBlock column)
- `src/db/schema/campaigns.ts` — CampaignSettings (Phase 03 adds sourceOfTruth field)
- `src/sessions/client-snapshot.ts` — Snapshot builder (Phase 03 modifies to pivot reads)
- `src/lib/preferences.ts` — Resolver patterns (Phase 03 follows for sourceOfTruth)
- `src/app/api/sessions/[id]/turn/route.ts` — Turn route (Phase 03 modifies for dual-write + summarizer)
- `scripts/vault-flip.ts` — Phase 02 flip script (Phase 03 extends with --source-of-truth flag + refactors for migrate-campaigns-to-vault reuse)
- `scripts/vault-backup.ts` — Phase 02 backup (Phase 03 uses during cutover)
- `scripts/vault-rebuild-views.ts` — Phase 02 DR (Phase 03 uses during divergence resolution)
- `scripts/build-local-models.ts` — Modelfile generator (Phase 03 strips retired bases)
- `scripts/build-rag-index.ts` — RAG indexer (Phase 03 deletes)
- `drizzle/0034_cooing_morgan_stark.sql` — pgvector CREATE EXTENSION (Phase 03 mirrors a DROP migration)
- `src/engine/tools/handlers.ts` — Engine mutation surface (Phase 03 audits per Decision 10)
- `package.json` — [VERIFIED 2026-05-26: drizzle-orm 0.45.2, vitest 4.1.5, tsx 4.21.0, next 16.2.4. No new deps needed.]
- `~/.claude/projects/-Users-alessiodanna-projects-dnd-ai-master/memory/project_dnd_ai_master_target_hw.md` — M4 production target

### Secondary (MEDIUM confidence)

- AGENTS.md (Next.js-is-not-what-you-know caveat — Phase 03 introduces no new Next.js APIs)
- CLAUDE.md (Italian-in-chat, English-in-code convention; auto-loaded skill list)
- `tests/sessions/turn-route-branch.test.ts` (Phase 01 branch-test precedent for Phase 03 dual-write gate)
- `tests/lib/preferences-master-backend.test.ts` + `tests/lib/preferences-vault-mutations.test.ts` (Phase 01/02 resolver-test precedents for Phase 03 sourceOfTruth)
- `tests/scripts/migrate-handbook-to-vault.test.ts` (Phase 01) + `tests/scripts/vault-backup.test.ts` (Phase 02) — script-test precedents for `migrate-campaigns-to-vault.test.ts`

### Tertiary (LOW confidence)

- None. Every Phase 03 design choice maps to a validated spike or an existing Phase 01/02 pattern. No external WebSearch findings used.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Dual-write fan-out via `Promise.all` adds <50ms warm latency to a typical turn (Postgres ~5-20ms; vault append ~2-8ms; parity-check ~5-15ms; in parallel) | §3.1 Pattern 1 | LOW — order-of-magnitude analysis; verify against real turn logs in Phase 03-A |
| A2 | The 8-15 new event types (Decision 10 completeness audit estimate) can ship in Phase 03-A as additive extensions to Phase 02's union | §Pitfall 1 + Decision 10 | MEDIUM — depends on the actual count + complexity. If a mutation has cross-character side effects (e.g., AOE damage), the event-per-character pattern may not fit. Plan-phase confirms during the audit. |
| A3 | The summarizer (REQ-023) uses the same Ollama model as the session without adding measurable warm-load overhead | §3.3 Pattern 3 + Decision 6 | MEDIUM — depends on Ollama's KV-cache behavior when a different prompt (the summarizer's prompt) is sent. May invalidate the session's prefix cache. Spike 011 didn't measure this directly; plan-phase confirms during Phase 03-B implementation. Mitigation: use a distinct conversation context for the summarization call to avoid cache pollution. |
| A4 | Postgres legacy-state drop migration is safe to run after `ROLLBACK_WINDOW_DAYS=30` elapses with manual confirmation | §Pitfall 7 + Decision 5 | LOW — manual gate + DR validated by spike 013. Plan-phase confirms by running a dry-run drop on a copy of production first. |
| A5 | M4 final sweep (Phase 03-D) reproduces spike 004's 3.78s warm wall-clock within ±20% (REQ-021 target < 10s) | §6 Final M4 sweep | LOW — spike 004 measured this on identical hardware with the same model. Drift would indicate a regression in Phase 01/02/03 code; spike 011 conditions (system noise) could also fire. Mitigation: re-run on isolated M4. |
| A6 | The bulk migration script can complete the entire campaign cohort in <30 minutes on M4 | §3 Bulk migration script | LOW — for the personal-scale deployment (1-10 campaigns), each per-campaign flip is ~1-2s. Even with 100 campaigns this is <5 minutes. Verify on actual cohort during plan-phase. |
| A7 | `dual_write_divergences` audit table with append-only writes scales to the dual-write window (~14 days × ~30 turns/day × ~5 mutations/turn = ~2100 rows max) | §Decision 3 + Pitfall 1 | LOW — Postgres handles 1000s of rows trivially. Index on (session_id, created_at DESC) keeps query latency negligible. |
| A8 | RAG removal doesn't break any baked-path code (the baked path uses RAG via `useRagRetrieval` flag; removal must coordinate with baked retirement) | §Decision 7 + Phase 03-C ordering | MEDIUM — verify by grep: `grep -rn "retrieveRelevant\|getRagStore" src/` returns matches in turn-route.ts only (verified). All callers are inside the baked branch; Phase 03-C step 4 (DROP TABLE rag_chunks) lands AFTER step 1 (remove RAG imports from turn-route.ts), so dependencies are removed before storage. Plan-phase confirms ordering. |
| A9 | `userPrefs.aiMasterModel` stored values for retired baked variants are limited to the 4 we know about (lite/max/max2/max3); no other stale slugs lurk | §Pitfall 6 | MEDIUM — verify by `SELECT DISTINCT preferences->>'aiMasterModel' FROM users` on prod before migration. If any unexpected slugs exist, the migration handles them by falling back to the default. |
| A10 | `qwen3:30b-a3b-instruct-2507-q4_K_M` keep-alive on M4 (`OLLAMA_KEEP_ALIVE` default 30m) is sufficient for the summarizer to NOT cold-start mid-session | §3.3 Pattern 3 + Decision 6 | LOW — keep-alive matches the typical session length (30+ turns at ~5s each = ~150s, well within 30m). |
| A11 | Phase 02's `vault-flip --enable-mutations` flow handles the LEFT JOIN to `session_state.hpCurrent` correctly for sessions that don't exist yet | §Decision 1 + §3 Bulk migration | LOW — Phase 02 SUMMARY confirms the LEFT JOIN pattern with hp_max fallback for freshly-created campaigns. Phase 03 wraps it; no semantic change. |
| A12 | The summary block stored in `session_state.summaryBlock` doesn't break the existing snapshot SSE pipeline (the SSE emits on state-change; adding a new column shouldn't trigger spurious emits) | §3.3 + Decision 6 | LOW — depends on the LISTEN/NOTIFY trigger shape. If it fires on any session_state write, the summarizer's persistence will trigger an SSE → UI refetch → not harmful, just noisy. Plan-phase confirms during Phase 03-B. |

## Metadata

**Confidence breakdown:**

- **Migration orchestration (bulk script):** HIGH — wraps validated Phase 02 primitives; pure orchestration
- **Dual-write architecture (Pattern B class):** HIGH — synchronous Promise.all is the simplest correct pattern; parity-check is straightforward replay-vs-DB diff
- **Parity-check + divergence record:** HIGH — DB schema + audit pattern straightforward; replay primitive validated by spike 008/013
- **Cutover semantics (sourceOfTruth flag + read pivot):** HIGH — follows Phase 01/02 parallel-shape pattern verbatim
- **Per-turn summarizer (REQ-023):** MEDIUM — pattern sketched in `references/performance.md` but never validated in production code; concrete in-process LLM call may have prefix-cache interactions that need real-world measurement
- **RAG decommission:** HIGH — pure file deletion + 1 drop migration; well-understood Drizzle workflow
- **Baked variant decommission:** HIGH — `TIER_NAMES` strip + `scripts/build-local-models.ts` skip-list + `ollama rm` are clear ops
- **Final M4 sweep:** HIGH — thin orchestrator over validated spike harnesses
- **Cumulative completeness audit (Decision 10):** MEDIUM — mechanical (grep + classify) but the resulting count of new event types is unknown until the audit runs; budget impact uncertain
- **Open questions:** HONEST — researcher flagged 8 decisions plan-phase must make

**Research date:** 2026-05-26

**Valid until:** 2026-06-25 (30 days; codebase moves slowly; spike findings + Phase 01/02 outputs LOCKED indefinitely)
