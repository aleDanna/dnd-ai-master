# Phase 02 Summary: Vault Write Path (Event Sourcing)

**Status:** Shipped (all 11 plans landed, all tests green).
**Date:** 2026-05-25 (single-day execution, 4 parallel waves).
**Plan-landing commit range:** `2d0c89e` (plan 02-01 task 1) → `9f84140` (plan 02-08 SUMMARY).
**Plans executed in waves:** Wave 1 (02-01, 02-02, 02-05, 02-06) → Wave 2 (02-03, 02-04) → Wave 3 (02-07, 02-08, 02-09, 02-10) → Wave 4 (02-11, this doc).

Phase 02 ships the event-sourced write path for vault campaigns: an LLM `apply_event`
tool call lands a JSON line in `events.md` under a per-process mutex, regenerates the
affected materialized view, and persists the change without touching Postgres. The
path is dormant by default — only campaigns that have both `masterBackend === 'vault'`
AND `vaultMutations === true` see the 4th tool. Postgres remains the source of truth
for every other campaign. Operator-driven backup (`pnpm vault:backup`), DR rebuild
(`pnpm vault:rebuild-views`), and per-campaign opt-in flip (`pnpm vault:flip --enable-mutations`)
round out the operator surface.

## What shipped

- **Plan 02-01** — `events-schema.ts` (468 LOC) — `VaultEvent` discriminated union (8 members
  including `campaign_initialized` seed event) + `validateEvent` runtime guard + `VAULT_EVENT_TYPES`
  tuple + `EVENT_SCHEMA_VERSION = 1`. Zero imports — importable from tests without `DATABASE_URL`.
  ([plan](./plans/02-01-events-schema.md), commits `2d0c89e` + `233b65f`)
- **Plan 02-02** — `campaign-paths.ts` (215 LOC) — UUID-guarded `campaignDir`/`eventsPath`/
  `characterViewPath`, `slugifyCharacterName` with `-<id8>` collision suffix (Decision 10),
  `assertSameVolumeForTempFiles` POSIX best-effort invariant. T-02-04/T-02-05 mitigations
  ship here. ([plan](./plans/02-02-campaign-path-resolver.md), commits `31c46b0` + `945f6c5`)
- **Plan 02-03** — `events-writer.ts` (89 LOC) — verbatim lift of spike 010's
  `Map<absolute-path, Promise>` mutex. 100 parallel `applyEvent` calls land 100 distinct
  events in ~8ms; `STRESS_N=1000` in 65ms. ([plan](./plans/02-03-events-writer.md),
  commits `4c96930` + `87d6a82`)
- **Plan 02-04** — `projector.ts` (680 LOC) — pure `applyEvent` reducer with 8 type branches
  + exhaustiveness check, `replayEvents`/`regenerateCharacterView`/`serializeView`/`parseView`.
  Byte-stable view regeneration (spike 013 DR invariant); fail-fast on corrupt JSON
  (spike 008). ([plan](./plans/02-04-projector.md), commits `c1e8b5a` + `0a677bb` + `0a25e1e`)
- **Plan 02-05** — `vaultMutations` field on `CampaignSettings` + `resolveVaultMutations()`
  resolver that returns `false` whenever `masterBackend !== 'vault'` (Pitfall 5 enforcement).
  Parallel-shape mirror on `UserPreferences`. ([plan](./plans/02-05-vault-mutations-flag.md),
  commits `bd890c4` + `233b65f` + `7754c97`)
- **Plan 02-06** — `VAULT_TURN_TOOL_CALL_CAP = 20` added to `src/sessions/types.ts`; the
  vault loop reads the new cap (baked loop keeps `TURN_TOOL_CALL_CAP = 12`). Combat
  turns can fire ~10 mutations + reads + `end_turn` without truncation.
  ([plan](./plans/02-06-tool-loop-cap-bump.md), commits `efbf2f6` + `a24d2d0` + `4eaf09a`)
- **Plan 02-07** — `apply_event` wired as the 4th `VAULT_TOOL_DEFINITIONS` entry +
  dispatch branch in `tools.ts`. `VaultDispatchContext.campaignId` added and forwarded
  from `VaultLoopInput`. End-to-end integration suite (`apply-event-integration.test.ts`)
  covers REQ-006 DR roundtrip + REQ-007 isolation + concurrent dispatch + restart
  simulation. ([plan](./plans/02-07-apply-event-tool.md), commits `e3c7e20` + `8b5063a` +
  `e6911df` + `8d076bd` + `d7ab023` + `a134016` + `2f4fe25` + `21dbaef` + `874654e`)
- **Plan 02-08** — Coexistence semantics: prompt-builder extended with `vaultMutations`
  input (advertises 3 or 4 tools accordingly + clarifies `character` is a UUID, NIT 1);
  turn-route gates `apply_event` exposure on `resolveVaultMutations(userPrefs) === true`;
  `VAULT_MUTATIONS_STALE_UI_BANNER = "Vault attivo — ricarica per vedere lo stato più
  recente"` locked as the operator-approved Italian copy (Decision 8 Option A).
  ([plan](./plans/02-08-coexistence-semantics.md), commits `05ac258` + `27d50e6` +
  `2e33724` + `eef81c9` + `a493764`)
- **Plan 02-09** — `events-writer-stress.test.ts` (572 LOC, 7 active + 1 STRESS_N-gated
  case): N=1000 default + N=10000 override + multi-campaign isolation (5 × 100 events,
  10 pairwise intersection checks) + truncated-tail fail-fast + mid-line corruption.
  ([plan](./plans/02-09-concurrent-write-smoke.md), commit `cd20a55`)
- **Plan 02-10** — Operator playbook: `scripts/vault-backup.ts` (git default + tarball
  fallback, T-02-06 hand-edit refusal), `scripts/vault-rebuild-views.ts` (DR replay),
  `scripts/vault-flip.ts --enable-mutations` (seeds `campaign_initialized` from a
  Postgres LEFT JOIN), `docs/operators/vault-backup.md` (253-line runbook).
  ([plan](./plans/02-10-backup-strategy.md), commits `e40a9bb` + `e32772c` + `dedd3b6` +
  `29f032a` + `8af1c7a` + `764b9ab` + `e397a4e`)
- **Plan 02-11** — this summary.

## REQ traceability matrix

| REQ | Statement | Implementation | Test |
|---|---|---|---|
| REQ-004 | `events.md` per campaign is source of truth; per-entity `.md` files are projections | `src/ai/master/vault/projector.ts` (`applyEvent`, `replayEvents`, `regenerateCharacterView`, `serializeView`, `parseView`) | `tests/ai/master/vault/projector.test.ts` (53 cases — byte-stability, exhaustiveness, Pitfall 6 graceful degradation), `tests/ai/master/vault/apply-event-integration.test.ts` (round-trip property test) |
| REQ-005 | Mutations go through `EventsWriter` mutex per `campaign_id` — NEVER naive RMW | `src/ai/master/vault/events-writer.ts` (spike 010 `Map<absolute-path, Promise>` pattern) | `tests/ai/master/vault/events-writer.test.ts` (11+1 cases: 100 parallel → 0 lost), `tests/ai/master/vault/events-writer-stress.test.ts` (7+1 cases: N=1000 default + N=10000 override + truncated-tail recovery + multi-campaign isolation) |
| REQ-006 | DR procedure: events.md is the only durable artifact; restore = replay → regenerate views | `src/ai/master/vault/projector.ts` (`regenerateCharacterView`), `scripts/vault-rebuild-views.ts` | `tests/ai/master/vault/apply-event-integration.test.ts` (REQ-006 DR roundtrip case), `tests/scripts/vault-backup.test.ts` (10 CLI smoke cases) |
| REQ-007 | Campaign data lives OUTSIDE the codebase repo at `VAULT_CAMPAIGNS_ROOT` (default `~/.dnd-ai-master/vault/campaigns/`) | `src/ai/master/vault/campaign-paths.ts` (`campaignDir`, `eventsPath`, `characterViewPath`, UUID guard, path-prefix invariant), `scripts/vault-backup.ts`, `docs/operators/vault-backup.md` | `tests/ai/master/vault/campaign-paths.test.ts` (41 cases — UUID rejection, slug collisions, traversal defense), `tests/ai/master/vault/apply-event-integration.test.ts` (REQ-007 isolation case) |
| REQ-010 | 4-tool surface: `read_vault_multi`, `list_vault`, `apply_event`, `end_turn` | `src/ai/master/vault/tools.ts` (extended in plan 02-07 to 4 entries + dispatch branch), `src/ai/master/vault/index.ts` (barrel exports for the Phase 02 surface) | `tests/ai/master/vault/tools.test.ts` (45 cases), `tests/ai/master/vault/phase-smoke.test.ts` (Phase 01's `toHaveLength(3)` inverted to `toHaveLength(4)`), `tests/sessions/turn-route-branch.test.ts` (4-tool surface check) |

All 5 phase REQs covered. Full vault suite: `unset DATABASE_URL && pnpm test
tests/ai/master/vault/ tests/sessions/vault-mutations-*.test.ts tests/sessions/turn-tool-call-cap.test.ts
tests/sessions/turn-route-branch.test.ts tests/lib/preferences-vault-mutations.test.ts
tests/lib/preferences-master-backend.test.ts tests/scripts/vault-backup.test.ts
tests/scripts/migrate-handbook-to-vault.test.ts` → **399 passed / 2 skipped** in ~2.1s.

## ROADMAP Phase 02 success criteria

| Criterion (from `.planning/ROADMAP.md`) | Evidence | Verifying commit(s) |
|---|---|---|
| ✓ A turn that resolves combat damage produces an `apply_event` tool call that lands in `events.md` AND updates `characters/<name>.md` frontmatter atomically | `tests/ai/master/vault/apply-event-integration.test.ts` "happy path" + "round-trip property" cases exercise `dispatchVaultTool('apply_event', {hp_change}, …)` → file appended + view regenerated in the same synchronous slot | `e3c7e20` (dispatch branch) + `2f4fe25` (integration suite) |
| ✓ Concurrent stress test (100 parallel `apply_event` calls on same campaign) passes with 0 lost / 0 corrupted / 0 duplicated | Plan 02-03's `events-writer.test.ts` "100 parallel applyEvent" (8ms wall-clock); plan 02-09's `events-writer-stress.test.ts` N=1000 default (100ms) + N=10000 STRESS_N override (657ms) | `87d6a82` (basic concurrency) + `cd20a55` (stress regression) |
| ✓ Restart of Next.js server preserves state via events.md replay on session resume | `tests/sessions/vault-mutations-resume.test.ts` exercises `vi.resetModules` → re-instantiate vault stack → `replayEvents(eventsPath)` → assert state matches pre-restart (freshly-created seed + played-session seed + mixed seed cases) | `eef81c9` |
| ✓ Both backends (Postgres + Vault) can run side-by-side per campaign | `tests/sessions/vault-mutations-gate.test.ts` 19 cases across the 4-quadrant matrix (masterBackend × vaultMutations) verify Pitfall 5 + env-override + dispatch surface invariant | `27d50e6` (route gate) + `2e33724` (gate tests) |
| ✓ Property test: round-trip serialization (event → state → view → assert state derivable back via replay) | `tests/ai/master/vault/apply-event-integration.test.ts` "round-trip property test" — append N random events, parse view back, replay events independently, assert byte-equal states | `2f4fe25` |

All 5 ROADMAP success criteria are met by the test suite at HEAD.

## Threat model dispositions

From `PLAN.md` §"STRIDE Threat Register":

| Threat ID | Disposition | Mitigation location | Verifying commit |
|---|---|---|---|
| T-02-01 (Spoofing — apply_event campaignId injection) | mitigated | `tools.ts` dispatch branch resolves `campaignDir(ctx.campaignId)` server-side from Clerk-validated session row; LLM input is ignored for the path component | `e3c7e20` (dispatch) + `8b5063a` (campaignId forwarded from VaultLoopInput) |
| T-02-02 (Tampering — concurrent corruption to events.md) | mitigated | `EventsWriter.queues` mutex; spike 010 byte-for-byte port | `4c96930` (writer) + `87d6a82` (regression) + `cd20a55` (stress) |
| T-02-03 (Tampering — event payload injection like `delta: 999999`) | mitigated | `validateEvent` enforces typeof + finiteness; projector clamps `hp_current` to `[0, hp_max]`; qty bounds `(0, 1000)`; spell level `[1, 9]` | `2d0c89e` (schema guards) + `c1e8b5a` (projector clamps) |
| T-02-04 (Tampering — path traversal via `campaignId`) | mitigated | `UUID_REGEX.test(campaignId)` fail-closed before `path.resolve` in `campaignDir()` | `31c46b0` (UUID guard) + `945f6c5` (test) |
| T-02-05 (Tampering — path traversal via character name slug) | mitigated | `slugifyCharacterName` strips `[^a-z0-9-]`, appends `-<id8>`, path-prefix assertion guarantees containment | `31c46b0` (slug helper) + `945f6c5` (traversal test) |
| T-02-06 (Repudiation — operator hand-edits events.md) | accepted | NON-REQ-005; documented in `docs/operators/vault-backup.md` (correction policy = compensating events). `vault-backup.ts` defensively refuses to push if working tree has uncommitted manual edits | `8af1c7a` (runbook) + `e40a9bb` (refuse-to-push check) |
| T-02-07 (Information disclosure — cross-campaign leakage) | mitigated | Path-prefix invariant in `characterViewPath` + per-turn `ctx.campaignId` from session row | `31c46b0` (invariant) + `2f4fe25` (integration test "REQ-007 isolation") |
| T-02-08 (DoS — disk-fill via runaway event emission) | mitigated | `VAULT_TURN_TOOL_CALL_CAP = 20` operational cap (~200KB/day/campaign at worst case) | `efbf2f6` (constant) + `a24d2d0` (loop default) + `4eaf09a` (regression) |
| T-02-09 (DoS — replay degradation as events.md grows) | accepted (Phase 02) / deferred to Phase 03 | Sync replay scales linearly (~1ms/100 events, ~100ms/10K); snapshot+compact at 10K boundary is Phase 03 work | n/a — see "Open items / Phase 03 hand-offs" |
| T-02-10 (Elevation — multi-process EventsWriter race) | mitigated (operational) | NON-REQ-001 single-Next.js-server invariant; runbook in `docs/operators/vault-backup.md` requires bulk-mutation scripts to run with the server stopped | `8af1c7a` (runbook) |
| T-02-11 (Tampering — backup repo corruption / force-push) | mitigated | `vault-backup.ts` uses `git push` without `--force`; defensive refusal on uncommitted manual edits | `e40a9bb` (script) + `764b9ab` (refusal test) |
| T-02-12 (Tampering — stale view after partial-write crash) | mitigated | POSIX `O_APPEND` atomic <4KB; projector rebuilds from last valid prefix on next replay | `4c96930` (writer) + `cd20a55` (truncated-tail recovery test) |

No threats were re-disposed (mitigate → accept or vice versa) during execution.

## Test totals (Phase 02 cumulative)

Per-file counts come from `pnpm test <file>` (Vitest authoritative — `it.each` blocks
expand to N cases that grep-style line counts miss).

| Plan | Test file | Cases | Phase 01 baseline |
|---|---|---|---|
| 02-01 | `tests/ai/master/vault/events-schema.test.ts` | 50 | NEW |
| 02-02 | `tests/ai/master/vault/campaign-paths.test.ts` | 41 | NEW |
| 02-03 | `tests/ai/master/vault/events-writer.test.ts` | 11 + 1 skip | NEW |
| 02-04 | `tests/ai/master/vault/projector.test.ts` | 53 | NEW |
| 02-05 | `tests/lib/preferences-vault-mutations.test.ts` | 22 | NEW |
| 02-06 | `tests/sessions/turn-tool-call-cap.test.ts` | 7 | NEW |
| 02-07 | `tests/ai/master/vault/apply-event-integration.test.ts` | 8 | NEW |
| 02-07 (extends) | `tests/ai/master/vault/tools.test.ts` | 45 | 21 (Phase 01) → +24 |
| 02-07 (extends) | `tests/ai/master/vault/loop.test.ts` | 15 | 11 → +4 |
| 02-07 (extends) | `tests/ai/master/vault/phase-smoke.test.ts` | 4 | 4 (assertion inverted, count unchanged) |
| 02-08 | `tests/sessions/vault-mutations-gate.test.ts` | 19 | NEW |
| 02-08 | `tests/sessions/vault-mutations-resume.test.ts` | 8 | NEW |
| 02-08 (extends) | `tests/ai/master/vault/prompt-builder.test.ts` | 22 | 13 → +9 |
| 02-09 | `tests/ai/master/vault/events-writer-stress.test.ts` | 7 + 1 skip | NEW |
| 02-10 | `tests/scripts/vault-backup.test.ts` | 10 | NEW |
| **Phase 02 new files** | **11 new + 4 extended** | **236 new + 38 extension cases** | |
| **Phase 01 carry-over (unchanged)** | `path.test.ts` 26, `migrate-handbook-to-vault.test.ts` 15, `preferences-master-backend.test.ts` 22, `turn-route-branch.test.ts` 14 | **77** | |
| **Total Phase 01 + 02 vault suite at HEAD** | **19 files** | **399 passed / 2 skipped (401 cases)** | |

The 2 skipped cases are the env-overridable stress runs (`STRESS_N` unset in default
CI) — they pass when `STRESS_N` is set on the operator's machine.

The Phase 01 inheritance note (`path.test.ts` grew from 23 → 26) corresponds to
plan 02-07's Decision 4 routing additions; the 3 extra cases verify VAULT_ROOT
vs VAULT_CAMPAIGNS_ROOT resolution under the new dispatcher.

## Performance baseline

REQ-021 (warm wall-clock < 10s on M4) is hardware-specific and Phase 02 ships
behind the per-campaign opt-in (`vaultMutations: false` default). Like Phase 01,
the M4 number is decision-grade only when Phase 03 retires the baked path. Until
then, in-process micro-benchmarks confirm the write path itself is dominated by
LLM tokens, not by storage:

| Axis | M5 Pro observation | Cap / target | Spike 010/013 baseline |
|---|---|---|---|
| EventsWriter — 100 parallel writes | **8ms** | < 100ms | 7ms (spike 010 baseline) |
| EventsWriter — N=1000 writes (default stress) | **100ms** | < 5000ms | scaled 14× from spike-010's 100 |
| EventsWriter — N=10000 writes (`STRESS_N` override) | **657ms** | < 10s | n/a (new envelope) |
| Multi-campaign isolation — 5 × 100 events | **75ms** | n/a | n/a (new envelope) |
| Projector — replay 100 events | **~1ms** | n/a | 1ms (spike 008) |
| Projector — view regen byte-stability | **deterministic** | byte-exact | spike 013 DR invariant honored |
| `dispatchVaultTool('apply_event', …)` — per call | **0.22ms** | < 50ms (NIT 4) | n/a |

No M4 smoke captured for Phase 02 directly — the gate hardware is Mac Mini M4
(REQ-020), but the write path itself is hardware-agnostic (POSIX file I/O on
APFS / ext4 either way). The first real combat turn from production will produce
the M4 wall-clock for free via `ai_usage` rows + Next.js logs. If a controlled
M4 bench is needed before Phase 03, run `pnpm vault:flip --id=<uuid> --to=vault
--enable-mutations` on the Mac Mini, fire a representative combat turn via the
existing `bench-vault-m4` harness, and capture: `prompt_eval_count`, tool
round-trips, end-to-end wall-clock, `ai_usage` row signature.

## Open items / Phase 03 hand-offs

Bounded by Phase 02's event-sourced write scope; explicitly deferred to Phase 03:

- **Dual-write to Postgres for opted-in campaigns (Decision 8).** Phase 02 writes
  ONLY to `events.md` for opted-in campaigns. The UI continues reading Postgres,
  so opted-in campaigns surface the operator banner
  `"Vault attivo — ricarica per vedere lo stato più recente"`. Phase 03 owns the
  dual-write reconciliation layer that keeps the two stores converged during
  cutover, then flips the source-of-truth.
- **UI vault-read path for opted-in campaigns.** The banner is the only behavioral
  change visible in Phase 02. Phase 03 wires the UI to read materialized views
  directly + retires the banner.
- **RAG retirement + baked-variant retirement** (REQ-033 follow-up). Both stay
  running for non-opted-in campaigns in Phase 02; Phase 03 retires them once
  vault parity is proven across the cohort.
- **Event-log compaction / snapshot (T-02-09 deferred).** Negligible at Phase 02
  scale (~2K events/year per campaign per spike 008 sizing). Phase 03 adds
  snapshot+compact at the 10K-event boundary if telemetry warrants.
- **Per-turn summarization at 15K tokens (REQ-023).** Phase 03 deliverable.
- **Additional event types** — `temp_hp_set`, `death_save_success/fail`,
  `concentration_break`, `attune`, `unattune`. Additive (default case in projector
  logs and continues per Pitfall 6 graceful degradation — no schema migration
  needed). Phase 03 adds whichever the early combat sessions surface as
  high-frequency gaps.
- **Automated post-event push from the Next.js process.** Phase 02 backup is
  operator-driven (`pnpm vault:backup`). Phase 03 may add a post-event hook to
  amortize across turns if the manual cadence proves friction-heavy.
- **Multi-process EventsWriter** (NON-REQ-001). In-process `Map<path, Promise>`
  mutex only. If a multi-Next.js-server deployment ever happens, Phase 03+ swaps
  to flock or a writer daemon.
- **End coexistence by ending the baked path (Decision 8 follow-up).** Phase 03's
  cutover step removes `masterBackend === 'baked'` as a runtime option, retires
  the baked variants, and treats the UI banner as legacy.

### Items inherited from deferred-items.md

Pre-existing failures discovered during Phase 02 execution that do NOT belong
to any Phase 02 plan (logged for the appropriate owner):

- **`tests/ai/master/system-prompt.mode.test.ts`** — 2 pre-existing failures (RAG
  block injection / cache stability). Re-confirmed on `main` at commits `a24d2d0`
  + `7cbfcb9` via `git stash -u` round-trips. Owner: the RAG-block-assembler plan.
  Not on Phase 03's critical path (Phase 03 retires RAG entirely).
- **`tests/sessions/applicator.test.ts`** — engine inventory pre-existing breakage
  surfaced during plan 02-08 verification. Verified independent of the vault
  changes. Owner: the inventory-applicator plan.

The previous deferred-items entries for `src/lib/preferences.ts:367` typecheck
hole (Plan 02-05 Task 1 → resolved by Task 2) and `tests/ai/master/vault/events-schema.test.ts`
narrowing errors (resolved by Plan 02-04 commit `945f6c5`) are CLOSED at HEAD —
`pnpm typecheck` is clean across the tree.

## Operator playbook

The three Phase-02 operator commands, in order of typical use:

### 1. `pnpm vault:flip --id=<uuid> --enable-mutations`

Per-campaign opt-in. The script (`scripts/vault-flip.ts`):
1. Verifies the campaign exists in Postgres.
2. Requires `masterBackend === 'vault'` first (Pitfall 5 — if the campaign is
   still on baked, the flag is refused at parse time).
3. LEFT JOINs `characters` ⨝ `sessions` ⨝ `session_state` to build the
   `campaign_initialized` seed payload from Postgres (per Decision 9). The seed
   captures the snapshot at the moment of flip; the projector treats it as
   line 1 of `events.md`.
4. Calls `EventsWriter.applyEvent(eventsPath, campaignInitializedEvent)` once,
   then `regenerateAffectedViews` to materialize the initial character views.

Reverse direction: `pnpm vault:flip --id=<uuid> --disable-mutations` clears the
flag (the resolved value falls back to `false`); existing events.md is preserved
for forensics — Phase 02 never deletes a campaign's vault data.

Listing without arguments — `pnpm vault:flip` — prints all campaigns with their
`masterBackend` + new `mut` column (`vaultMutations`), useful as a quick audit.

### 2. `pnpm vault:backup [--strategy=git|tarball]`

Default `--strategy=git` (Decision 7). The script (`scripts/vault-backup.ts`):
1. Refuses to run if `VAULT_CAMPAIGNS_ROOT` is unset or doesn't exist (exit 1
   with clear error).
2. Refuses to push if any `events.md` has uncommitted manual edits — non-append
   diffs from the working tree are read as tampering (T-02-06 defense).
3. Initializes the backup repo on first invocation (configurable via
   `VAULT_BACKUP_GIT_REMOTE` env). Subsequent runs stage the new lines + view
   updates and `git push` (no `--force`).
4. `--strategy=tarball` fallback writes a timestamped `.tar.gz` to
   `VAULT_BACKUP_TARBALL_DIR` and rotates the oldest beyond `N` (configurable).

Cadence: operator-driven; no automated trigger from the Next.js process in
Phase 02.

### 3. `pnpm vault:rebuild-views [--campaign=<uuid> | --all]`

DR recovery (REQ-006). The script (`scripts/vault-rebuild-views.ts`):
1. UUID-guards `--campaign=<uuid>` before touching the filesystem.
2. `parseEventsFile(eventsPath)` → walks the events ledger.
3. `replayEvents(events, INITIAL_CHARACTER_STATE)` per character ID encountered
   in the events.
4. `regenerateCharacterView(campaignId, charId, state)` rewrites every view
   from scratch — byte-equal to what `apply_event` would have produced under
   live mutation (spike 013 invariant).
5. `--all` iterates every UUID-shaped directory under `VAULT_CAMPAIGNS_ROOT`.

Use cases:
- Recovery after backup restore (`git clone <vault-repo>; pnpm vault:rebuild-views --all`).
- Repair of a corrupted view file (mid-line corruption / partial-write crash;
  the test for this in `events-writer-stress.test.ts` exercises the recovery
  procedure).
- Migration to a new view format (when Phase 03 adds fields to the frontmatter
  schema, this script is the canonical re-materialization tool).

Full runbook (recovery one-liners, T-02-06 correction policy via compensating
events, dual-write coexistence semantics): see `docs/operators/vault-backup.md`.

## Locked decisions (Phase 02)

All 11 decisions from `PLAN.md` reached their final disposition exactly as
planned. None were re-litigated during execution.

| # | Decision | Final disposition |
|---|---|---|
| 1 | Event-type schema | Hand-rolled TypeScript discriminated union (8 types: `hp_change`, `condition_add/remove`, `spell_slot_use/restore`, `inventory_add/remove`, `campaign_initialized` seed). No Zod. Envelope `{id, version, type, payload, timestamp}` per spike 008. Union OPEN for extension via projector `default:` branch (Pitfall 6). |
| 2 | Materialized-view regeneration timing | Synchronous inside `dispatchVaultTool('apply_event', …)`. Spike 008 measured ~1ms per replay; negligible vs LLM round-trip. |
| 3 | `apply_event` return shape | `{ok: true, event_id}` minimal envelope (spike 009 prompt-eval budget). LLM re-reads via `read_vault_multi` if it needs the updated state. |
| 4 | Tool surface extension | `read_vault_multi` extended to resolve `/campaigns/<id>/…` to VAULT_CAMPAIGNS_ROOT (other prefixes → VAULT_ROOT). REQ-010 locks the surface at 4. |
| 5 | Per-campaign opt-in flag | Separate `vaultMutations: boolean` on `CampaignSettings`. Orthogonal to `masterBackend`. Pitfall 5: resolver returns `false` whenever `masterBackend !== 'vault'`. |
| 6 | Concurrent-write smoke test | Same Vitest harness as Phase 01. Default N=100; `STRESS_N` env override scales to 1000 / 10000. |
| 7 | Backup strategy | Separate git repo via `pnpm vault:backup` (operator-approved default). Tarball is documented fallback via `--strategy=tarball`. |
| 8 | Coexistence semantics | Single-write to `events.md` for opted-in campaigns. UI reads Postgres + surfaces banner `"Vault attivo — ricarica per vedere lo stato più recente"` (Option A, operator-approved). Phase 03 ends coexistence by retiring the baked path + dual-write reconciliation. |
| 9 | Initial state seeding | Synthetic `campaign_initialized` seed event, sourced from Postgres LEFT JOIN at the moment of `vault:flip --enable-mutations`. Projector treats the seed as a special type that populates `INITIAL_CHARACTER_STATE` per character. |
| 10 | Character file slug collision | `characters/<slug>-<id8>.md` (id8 = first 8 chars of character UUID). Verified in `campaign-paths.test.ts` — "Ára"/"Ara" with distinct UUIDs produce distinct paths. |
| 11 | TURN_TOOL_CALL_CAP for vault turns | `VAULT_TURN_TOOL_CALL_CAP = 20` (baked loop unchanged at 12). Combat turn budget: ~10 mutations + reads + `end_turn`. |

## Cross-references

- **Requirements satisfied:** REQ-004, REQ-005, REQ-006, REQ-007, REQ-010 (`.planning/REQUIREMENTS.md`)
- **Phase research:** `.planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md`
- **Phase patterns:** `.planning/phases/02-vault-write-path-event-sourcing/02-PATTERNS.md`
- **Phase validation:** `.planning/phases/02-vault-write-path-event-sourcing/02-VALIDATION.md` (per-task Nyquist verification map)
- **Spike findings consumed:**
  - `.planning/spikes/006-frontmatter-atomicity/README.md` (cautionary tale — naive frontmatter RMW lost data, motivated REQ-005)
  - `.planning/spikes/008-events-md-replay/README.md` (replay performance + fail-fast on corruption)
  - `.planning/spikes/010-events-md-concurrency/README.md` (the `Map<path, Promise>` mutex pattern — verbatim port into `events-writer.ts`)
  - `.planning/spikes/013-vault-backup-restore/README.md` (DR procedure: events.md is the only durable artifact)
- **Implementation contract:** `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md`
- **Phase 01 inheritance:** `.planning/phases/01-vault-read-path/SUMMARY.md` (vitest scope rule, test layout convention)
- **Phase 03 entry conditions:** Phase 03 starts with the operator playbook above in place + the per-campaign opt-in flag wired. Phase 03 retires Postgres writes for opted-in campaigns (dual-write reconciliation) and ends the coexistence banner.

## Self-Check: PASSED

- ✓ `.planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md` exists.
- ✓ All 11 plans referenced in "What shipped" with commit hashes.
- ✓ REQ-004/005/006/007/010 each appear in both prose and traceability matrix (≥ 2 occurrences each).
- ✓ 5 ROADMAP success criteria each cross-referenced to verifying test + commit.
- ✓ All 12 threat-register entries dispositioned with mitigation location + commit.
- ✓ Test totals report cumulative 399 passed / 2 skipped across 19 files.
- ✓ Spike 006/008/010/013 each cited under cross-references.
- ✓ Phase 03 hand-offs enumerated (8 items) + deferred-items.md residuals carried forward.
- ✓ Operator playbook documents `vault:flip`, `vault:backup`, `vault:rebuild-views` end-to-end.
- ✓ All 11 locked decisions tabulated with final disposition.
