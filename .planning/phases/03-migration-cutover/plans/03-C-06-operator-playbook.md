---
phase: 03
plan: C-06
type: execute
wave: 8
depends_on: []
files_modified:
  - docs/operators/phase-03-cutover.md
  - scripts/decommission-baked.ts
  - package.json
autonomous: true
requirements: [REQ-033]
must_haves:
  truths:
    - "docs/operators/phase-03-cutover.md documents the full Phase 03 cutover procedure end-to-end, in operator-friendly numbered steps"
    - "The playbook covers: pre-checks, bulk migration, dual-write enablement, parity-check monitoring, cutover, rollback, M4 bench, decommission, post-30d Postgres drop reminder"
    - "Every operator command in the playbook has its exact CLI invocation + expected output snippet"
    - "scripts/decommission-baked.ts wraps the manual `ollama rm` commands so the operator runs ONE script instead of 5 (4 retired tier variants + nomic-embed-text)"
    - "The script confirms with the operator before running each `ollama rm` (interactive — type 'yes' to proceed)"
    - "The post-30d Postgres-table-drop instruction is documented but NOT shipped as a script in Phase 03 (operator-gated manual step)"
    - "The playbook references the SMOKE CAMPAIGN One Piece (3ef630db) as a verification target — operator confirms it still works after each step"
  artifacts:
    - path: "docs/operators/phase-03-cutover.md"
      provides: "End-to-end operator playbook"
    - path: "scripts/decommission-baked.ts"
      provides: "Interactive ollama rm wrapper"
    - path: "package.json"
      provides: "decommission-baked script entry"
      contains: "decommission-baked"
  key_links:
    - from: "docs/operators/phase-03-cutover.md"
      to: "scripts/decommission-baked.ts"
      via: "Playbook step references the script"
      pattern: "decommission-baked"
---

# Plan 03-C-06: Operator Playbook + Decommission Script

**Phase:** 03-migration-cutover
**Wave:** 8 (parallel-safe with 03-C-03 + 03-C-05)
**Status:** Pending
**Estimated diff size:** ~400 LOC docs + ~120 LOC script / 3 files

## Goal

Phase 03's operator surface is bigger than Phase 02's (bulk migration + dual-write + cutover + bench + decommission + post-30d). Without a runbook, the operator has to read every plan to know the order. This plan ships a single end-to-end playbook + an interactive decommission script for the `ollama rm` ops.

## Requirements satisfied

- **REQ-033** — Operator playbook for the manual `ollama rm` retirements

## Files touched

| File | Action | Why |
|---|---|---|
| `docs/operators/phase-03-cutover.md` | NEW | End-to-end playbook |
| `scripts/decommission-baked.ts` | NEW | Interactive ollama rm wrapper |
| `package.json` | EDIT | Add decommission-baked script entry |

## Tasks

<task type="auto">
  <name>Task 1: Write docs/operators/phase-03-cutover.md</name>
  <files>docs/operators/phase-03-cutover.md</files>
  <read_first>
    - docs/operators/vault-backup.md (Phase 02 operator runbook — the structure + Italian-where-it-surfaces-in-UI convention)
    - .planning/phases/03-migration-cutover/PLAN.md (the wave structure + sub-phase ordering)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (Decisions + Pitfalls — every operator-relevant constraint)
  </read_first>
  <action>
Create `docs/operators/phase-03-cutover.md`. Use this structure:

```markdown
# Phase 03 — Migration & Cutover Operator Playbook

## Overview

Phase 03 migrates every campaign to the vault format, validates parity via dual-write, flips the source-of-truth to vault, runs the final M4 bench, then decommissions RAG + 4-of-5 baked variants.

This playbook is the END-TO-END procedure. Run each step in order. **DO NOT skip steps.** Each step's success gate must be confirmed before the next.

**Smoke campaign for verification:** **One Piece (3ef630db)** is the canonical smoke target — after each step, fire one turn from this campaign and confirm it still works.

## Pre-flight

- [ ] `pnpm test` — full Vitest suite green at Phase 02 close
- [ ] `pnpm vault:backup` — backup before any destructive operation
- [ ] Confirm M4 has `qwen3:30b-a3b-instruct-2507-q4_K_M` + `qwen3:30b-a3b-instruct-2507` + `dnd-master-plus` + `mistral-small3.2:24b` installed
- [ ] `DATABASE_URL` set in `.env.local`

---

## Step 1 — Mutation Event Completeness Audit

Output: `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md`

The audit identifies new event types that need to ship BEFORE dual-write. Plans 03-A-02 + 03-A-03 + 03-A-04 ship them.

After plans 03-A-01 through 03-A-04 land:
- [ ] `pnpm test tests/ai/master/vault/` (vault suite green)

## Step 2 — Bulk Migration

```
pnpm migrate-campaigns-to-vault --dry-run
```

Review the output. EVERY campaign with `deletedAt IS NULL` should be listed.

```
pnpm migrate-campaigns-to-vault
```

Confirm `migrated=N skipped=0 errored=0`. Re-run to confirm idempotency:

```
pnpm migrate-campaigns-to-vault
```

This should print `migrated=0 skipped=N errored=0`.

Smoke: fire a turn from One Piece. Confirm `events.md` under `~/.dnd-ai-master/vault/campaigns/3ef630db-.../events.md` has the seed + (eventually) per-turn events.

## Step 3 — Enable Dual-Write Per Campaign

For each campaign that should dual-write (recommendation: ALL during the coexistence window):

```
psql ... -c "UPDATE campaigns SET settings = jsonb_set(settings, '{dualWrite}', 'true') WHERE id = '<uuid>'"
```

OR add a `--enable-dual-write` flag to `vault:flip` (future polish).

Smoke: fire a turn. Confirm both events.md AND session_state are updated.

Monitor divergences:
```
psql ... -c "SELECT created_at, summary FROM dual_write_divergences WHERE created_at > now() - interval '1h'"
```

Target: < 0.1% divergence rate over 2 weeks (ROADMAP gate).

## Step 4 — Per-Turn Summarizer Live

The summarizer is ENABLED by default (env `MASTER_SUMMARIZATION=on`). To override for testing:

```
MASTER_SUMMARIZE_TRIGGER=1000 pnpm dev
```

Fire 5 verbose turns; confirm `session_state.summary_block` is populated:

```
psql ... -c "SELECT summary_block FROM session_state WHERE session_id = '<uuid>'"
```

## Step 5 — Run the M4 Bench (REQ-021 Closure)

**On the Mac Mini M4 production host:**

```
pnpm bench-phase-03-m4
```

This runs spike 004 + 011 + 014 in sequence. Expected runtime: 5-15 minutes.

Review the output:
- Stage 1 g1-warm: **< 5s pass**
- Stage 2 long-session: avg flat over 20 turns
- Stage 3 narrative: **>= 4/5 pass**

If overall PASS, the output JSON path is printed. Note it for the next step.

If FAIL: investigate before proceeding. Common causes:
- M4 host has OOM (kill other processes, retry)
- Model state changed (re-pull qwen3:30b-a3b-instruct-2507-q4_K_M)
- Recent code regression (`git bisect` between Phase 02 close and HEAD)

## Step 6 — Update Phase 01 SUMMARY.md (REQ-021 Closure)

Manually edit `.planning/phases/01-vault-read-path/SUMMARY.md` — the "M4 target hardware" table. Replace the `Deferred` cells with the measured numbers from Step 5's JSON.

Commit: `docs(phase-01): close REQ-021 deferral with Phase 03 M4 bench numbers`

## Step 7 — Cutover (sourceOfTruth Flip)

**Pre-cutover verification:**
- Step 5 bench PASSED
- Step 3 divergence rate over the past week is **< 0.1%**
- `pnpm vault:backup` ran successfully today

**Cutover:**

```
pnpm vault:cutover --id=3ef630db-... --dry-run
pnpm vault:cutover --id=3ef630db-...
```

Smoke: refresh the One Piece campaign in the UI. Confirm the character state matches expectations (HP, conditions, etc.) — these now read from vault.

**Rollback (if needed) within CUTOVER_ROLLBACK_HOURS (default 24h):**

```
pnpm vault:cutover --id=3ef630db-... --rollback
```

Cutover ALL campaigns:

```
psql ... -c "SELECT id FROM campaigns WHERE deleted_at IS NULL" | xargs -I {} pnpm vault:cutover --id={}
```

OR script it as a loop (future polish: `pnpm vault:cutover --all`).

## Step 8 — Decommission RAG (Code + DB)

Code-side: plans 03-C-01 + 03-C-02 already landed (deleted `src/ai/master/rag/*` etc.).

DB-side: plan 03-C-03 ships the drop migration. Apply:

```
pnpm db:migrate
```

Verify:

```
psql ... -c "\dx" | grep vector   # should return nothing
psql ... -c "\dt rag_chunks"      # should error 'did not find any relation'
```

## Step 9 — Decommission Baked Variants

Code-side: plans 03-C-04 + 03-C-05 already landed (stripped TIER_NAMES + migrated user prefs).

**On the Mac Mini M4:**

```
pnpm decommission-baked
```

This is interactive — type `yes` for each ollama rm. Removes:
- `dnd-master-lite` (~3GB)
- `dnd-master-max` (~14GB)
- `dnd-master-max2` (~18GB)
- `dnd-master-max3` (~18GB)
- `nomic-embed-text` (~270MB)

Total SSD reclaim: ~50GB (matches REQ-020 + Phase 02 sizing).

## Step 10 — Post-30-Day Postgres Drop (DEFERRED — Phase 04+)

After CUTOVER_ROLLBACK_HOURS (24h) AND ROLLBACK_WINDOW_DAYS (30d) have BOTH elapsed, the legacy game-state Postgres tables (`characters`, `session_state`, `combat_actors`) can be dropped.

**DO NOT** run this in Phase 03. The post-30d drop is a separate, manually-gated migration that lands in Phase 04+:

```
pnpm decommission-legacy-state --confirm
```

(Plan: future plan ships this script with multi-step confirmation + a pre-flight `pnpm vault:rebuild-views --all` to validate vault completeness.)

Until the drop runs, the Postgres tables retain the legacy data — operator can roll back any campaign individually via `pnpm vault:cutover --id=<uuid> --rollback`.

## Step 11 — Final Verification

- [ ] `pnpm test` — full suite green
- [ ] `pnpm build` — production build succeeds (no RAG imports)
- [ ] One Piece smoke turn — works
- [ ] All campaigns flipped to sourceOfTruth=vault (audit via psql)
- [ ] `dual_write_divergences` table query returns < 0.1% divergence over the past week
- [ ] M4 has `qwen3:30b-a3b-instruct-2507-q4_K_M` + `qwen3:30b-a3b-instruct-2507` + `dnd-master-plus` + `mistral-small3.2:24b` (the 4 supported models post-Phase 03); retired tier variants are GONE
- [ ] Phase 01 SUMMARY.md "M4 target hardware" table is updated with measured numbers (REQ-021 closed)

If all checks pass: Phase 03 is COMPLETE. Plan 03-99 ships the SUMMARY.md.

## Reference: Env Knobs

| Env var | Default | Purpose |
|---|---|---|
| `MASTER_BACKEND` | `baked` | Phase 01 default backend — set to `vault` on M4 (or after migration is universal) |
| `MASTER_SOURCE_OF_TRUTH` | `postgres` | Phase 03 sourceOfTruth default — set to `vault` after cutover (or leave default + flip per-campaign) |
| `MASTER_SUMMARIZATION` | `on` | Per-turn summarizer kill switch (REQ-023) |
| `MASTER_SUMMARIZE_TRIGGER` | `15000` | Trigger threshold in tokens |
| `MASTER_SUMMARIZE_KEEP_TURNS` | `3` | Last N user/assistant pairs to keep |
| `CUTOVER_ROLLBACK_HOURS` | `24` | Cutover reversibility window |
| `ROLLBACK_WINDOW_DAYS` | `30` | Postgres legacy-table retention (informational — drop migration is separate) |
| `VAULT_CAMPAIGNS_ROOT` | `~/.dnd-ai-master/vault/campaigns/` | Phase 02 — per-campaign vault location |

## Reference: Daily Operator Commands

| Frequency | Command | Purpose |
|---|---|---|
| Per session | `pnpm vault:backup` | Backup events.md + materialized views |
| Weekly during coexistence | Divergence query | Confirm < 0.1% rate |
| Once after Phase 03-A lands | `pnpm migrate-campaigns-to-vault` | Bulk migration |
| Once before decommission | `pnpm bench-phase-03-m4` (on M4) | REQ-021 closure |
| Once during cutover | `pnpm vault:cutover --id=<uuid>` | Flip sourceOfTruth |
| Once after decommission | `pnpm decommission-baked` | ollama rm retired tiers |

## Italian UI Copy Notes

The Phase 02 stale-UI banner constant (`VAULT_MUTATIONS_STALE_UI_BANNER`) is DEPRECATED in Phase 03 (the UI now reads from vault directly when sourceOfTruth=vault — no stale banner needed). The constant stays in source for legacy paths during the rollback window.
```

Total ~400 LOC of structured markdown. Adjust to actual command shapes (e.g., if `pnpm vault:cutover --all` doesn't ship, document the loop alternative).
  </action>
  <verify>
    <automated>test -f docs/operators/phase-03-cutover.md && wc -l docs/operators/phase-03-cutover.md</automated>
  </verify>
  <acceptance_criteria>
    - File exists
    - Has at least 200 lines (rich playbook)
    - References EVERY major Phase 03 command (migrate-campaigns-to-vault, vault:cutover, bench-phase-03-m4, decommission-baked, db:migrate)
    - Has a numbered step structure (Step 1 through Step 11)
    - Documents the post-30d Postgres drop as DEFERRED + explicitly NOT-IN-PHASE-03
    - References the smoke campaign One Piece (3ef630db) for verification
  </acceptance_criteria>
  <done>
    Playbook ships.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write scripts/decommission-baked.ts</name>
  <files>scripts/decommission-baked.ts</files>
  <read_first>
    - scripts/vault-flip.ts (CLI structure with _env-loader)
    - scripts/build-local-models.ts (ollama interaction pattern via execSync)
  </read_first>
  <action>
Create `scripts/decommission-baked.ts`:

```ts
#!/usr/bin/env tsx
/**
 * scripts/decommission-baked.ts — operator-run on Mac Mini M4 to remove
 * retired baked variants + the RAG embedder.
 *
 * INTERACTIVE — confirms each `ollama rm` with the operator before running.
 *
 * SAFETY: refuses to run if the host does NOT have these models installed
 * already (use `ollama list` to verify before running).
 */
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';

const MODELS_TO_REMOVE = [
  // Phase 03 REQ-033 retired baked variants
  { name: 'dnd-master-lite', sizeNote: '~3GB' },
  { name: 'dnd-master-max', sizeNote: '~14GB' },
  { name: 'dnd-master-max2', sizeNote: '~18GB' },
  { name: 'dnd-master-max3', sizeNote: '~18GB' },
  // Phase 03 RAG embedder
  { name: 'nomic-embed-text', sizeNote: '~270MB' },
];

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function listInstalled(): Set<string> {
  try {
    const stdout = execSync('ollama list', { encoding: 'utf8' });
    const installed = new Set<string>();
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([\w-:.]+)/);
      if (m && m[1] !== 'NAME') installed.add(m[1].replace(/:latest$/, ''));
    }
    return installed;
  } catch (e) {
    console.error('[decommission-baked] cannot run `ollama list` — is the daemon running?');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('=== Phase 03-C decommission: retire baked variants + RAG embedder ===\n');
  const installed = listInstalled();

  for (const m of MODELS_TO_REMOVE) {
    if (!installed.has(m.name)) {
      console.log(`[skip] ${m.name} (not installed)`);
      continue;
    }
    const answer = await ask(`Remove ${m.name} (${m.sizeNote})? [yes/no]: `);
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log(`[skip] ${m.name} — user declined`);
      continue;
    }
    try {
      execSync(`ollama rm ${m.name}`, { encoding: 'utf8', stdio: 'inherit' });
      console.log(`[removed] ${m.name}`);
    } catch (e) {
      console.error(`[error] failed to remove ${m.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log('\n=== decommission complete ===');
  console.log('Verify remaining: ollama list');
  console.log('Expected remaining D&D models: dnd-master-plus, qwen3:30b-a3b-instruct-2507-q4_K_M, qwen3:30b-a3b-instruct-2507, mistral-small3.2:24b');
}

main();
```
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - Script is interactive (asks for confirmation per model)
    - Lists what's installed before prompting
    - Handles missing-model case gracefully (`skip` log)
    - The list of models matches Decision 8 exactly
  </acceptance_criteria>
  <done>
    Operator script ships.
  </done>
</task>

<task type="auto">
  <name>Task 3: Add decommission-baked to package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (existing — see Phase 02 scripts block)
  </read_first>
  <action>
Add `"decommission-baked": "tsx scripts/decommission-baked.ts",` near the other Phase 03 scripts.
  </action>
  <verify>
    <automated>grep -c "decommission-baked" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "decommission-baked" package.json` returns 1
  </acceptance_criteria>
  <done>
    Entry added.
  </done>
</task>
