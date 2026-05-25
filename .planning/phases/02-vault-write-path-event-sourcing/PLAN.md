---
phase: 02-vault-write-path-event-sourcing
type: phase-index
status: planned
mode: standard
created: 2026-05-25
requirements: [REQ-004, REQ-005, REQ-006, REQ-007, REQ-010]
plan_count: 11
wave_count: 4
plans:
  - 02-01-events-schema
  - 02-02-campaign-path-resolver
  - 02-03-events-writer
  - 02-04-projector
  - 02-05-vault-mutations-flag
  - 02-06-tool-loop-cap-bump
  - 02-07-apply-event-tool
  - 02-08-coexistence-semantics
  - 02-09-concurrent-write-smoke
  - 02-10-backup-strategy
  - 02-11-summary
must_haves:
  truths:
    - "An apply_event tool call from the LLM produces an appended JSON line in <VAULT_CAMPAIGNS_ROOT>/<campaignId>/events.md AND an updated characters/<slug>.md materialized view"
    - "100 concurrent apply_event calls against the same campaign land 100 distinct events with 0 lost / 0 corrupted / 0 duplicated"
    - "After a Next.js server restart, the next read of a character's state via the projector matches what was written before restart (state survives via events.md replay)"
    - "Vault writes only happen for campaigns where settings.vaultMutations === true; campaigns without the flag continue using the Postgres path with zero behavioural change"
    - "Restoring a corrupted materialized view from events.md replay produces a byte-for-byte match to the pre-corruption file (spike 013 DR procedure)"
    - "The tool surface for vault campaigns has EXACTLY 4 tools: read_vault_multi, list_vault, apply_event, end_turn (REQ-010)"
    - "An apply_event with an unknown event type or a payload that fails the type guard returns isError:true and does NOT touch events.md"
    - "An operator can run `pnpm vault:backup` (or the chosen backup strategy command) and produce a recoverable artifact for VAULT_CAMPAIGNS_ROOT"
  artifacts:
    - path: "src/ai/master/vault/events-schema.ts"
      provides: "VaultEvent discriminated union + validateEvent type guard for the 7 event types"
      exports: ["VaultEvent", "validateEvent", "VAULT_EVENT_TYPES", "EVENT_SCHEMA_VERSION"]
    - path: "src/ai/master/vault/campaign-paths.ts"
      provides: "Per-campaign path resolution under VAULT_CAMPAIGNS_ROOT + same-volume invariant assertion"
      exports: ["campaignDir", "eventsPath", "characterViewPath", "slugifyCharacterName", "assertSameVolumeForTempFiles"]
    - path: "src/ai/master/vault/events-writer.ts"
      provides: "EventsWriter class with in-process Map<path, Promise> mutex (spike 010 pattern)"
      exports: ["EventsWriter"]
    - path: "src/ai/master/vault/projector.ts"
      provides: "Pure applyEvent reducer, replay(events), regenerateCharacterView, serializeView"
      exports: ["applyEvent", "replayEvents", "regenerateCharacterView", "INITIAL_CHARACTER_STATE", "serializeView"]
    - path: "src/ai/master/vault/tools.ts"
      provides: "Extended to 4 tools — adds apply_event definition + dispatch branch"
      contains: "apply_event"
    - path: "src/db/schema/campaigns.ts"
      provides: "CampaignSettings.vaultMutations field added (per D-Decision-5)"
      contains: "vaultMutations"
    - path: "src/lib/preferences.ts"
      provides: "validateSettingsPatch arm for vaultMutations + resolveVaultMutations() resolver"
      exports: ["resolveVaultMutations"]
    - path: "src/sessions/types.ts"
      provides: "VAULT_TURN_TOOL_CALL_CAP raised to 20 for vault-mutation turns"
      contains: "VAULT_TURN_TOOL_CALL_CAP"
    - path: "scripts/vault-backup.ts"
      provides: "Chosen backup-strategy script (separate git repo, per Decision 7)"
    - path: "tests/ai/master/vault/events-writer.test.ts"
      provides: "100 concurrent appends → 0 lost (spike 010 regression test)"
    - path: "tests/ai/master/vault/projector.test.ts"
      provides: "Replay byte-exact + corruption fail-fast (spike 008 regression test)"
    - path: "tests/ai/master/vault/apply-event-integration.test.ts"
      provides: "End-to-end: apply_event → events.md + view file + DR + property test"
    - path: "tests/sessions/vault-mutations-gate.test.ts"
      provides: "Turn route honors vaultMutations flag (coexistence)"
    - path: ".planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md"
      provides: "Phase outcomes + REQ traceability"
  key_links:
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/events-writer.ts"
      via: "EventsWriter.applyEvent(eventsPath(campaignId), event)"
      pattern: "EventsWriter\\.applyEvent"
    - from: "src/ai/master/vault/tools.ts (apply_event branch)"
      to: "src/ai/master/vault/projector.ts"
      via: "regenerateCharacterView called synchronously after append"
      pattern: "regenerateCharacterView"
    - from: "src/ai/master/vault/loop.ts"
      to: "src/ai/master/vault/tools.ts dispatchVaultTool"
      via: "VaultDispatchContext.campaignId added to dispatch context"
      pattern: "campaignId"
    - from: "src/app/api/sessions/[id]/turn/route.ts (vault branch)"
      to: "src/lib/preferences.ts resolveVaultMutations"
      via: "Gate apply_event exposure on vaultMutations === true"
      pattern: "resolveVaultMutations"
    - from: "src/ai/master/vault/events-writer.ts"
      to: "src/ai/master/vault/campaign-paths.ts"
      via: "Mutex key = absolute resolved path from eventsPath(campaignId)"
      pattern: "resolve\\(.*VAULT_CAMPAIGNS_ROOT"
---

# Phase 02: Vault Write Path (Event Sourcing)

**Goal:** Game-state mutations (HP changes, condition adds, spell-slot use, inventory changes) write to `events.md` per-campaign via `EventsWriter`, with materialized views (`characters/<name>.md`) regenerated on each event. Campaign data lives under `VAULT_CAMPAIGNS_ROOT` outside the codebase repo (REQ-007). Still behind a per-campaign opt-in flag — Postgres remains the source of truth for any campaign not opted in.

**Status:** Planned, ready for execution
**Estimated total scope:** ~1700 LOC source + ~650 LOC tests / 13 source files + 7 test files + 1 script

---

## Phase-wide decisions (resolved from RESEARCH.md open questions)

These are the planner's locked decisions for Phase 02. The execute step may not re-litigate them without explicit user override.

1. **Event-type schema (RESEARCH Decision 1):** **Hand-rolled TypeScript discriminated union + type guards.** No Zod dependency. The 7 initial event types from RESEARCH §6 — `hp_change`, `condition_add`, `condition_remove`, `spell_slot_use`, `spell_slot_restore`, `inventory_add`, `inventory_remove`. Event envelope adds `{id, version, type, payload, timestamp}` per spike 008. The union is OPEN for extension via the `default:` branch of the projector (graceful degradation on unknown event types — see Pitfall 6).

2. **Materialized view regeneration timing (Decision 2):** **Synchronous inside apply_event.** Spike 008 measured replay at ~1ms for 100 events; the cost is negligible vs an LLM round-trip. Synchronous regen guarantees the next `read_vault_multi` of `characters/<slug>.md` sees fresh state.

3. **apply_event return shape (Decision 3):** **`{ok: true, event_id}` minimal envelope.** Returning the updated state slice doubles per-mutation token cost (spike 009 prompt_eval budget). The LLM has prior state in context and can re-read via `read_vault_multi` if needed.

4. **Tool surface extension (Decision 4):** **Extend `read_vault_multi` to transparently resolve campaign paths.** REQ-010 LOCKS the tool surface at 4. The dispatcher routes `/campaigns/<id>/…` prefixes to `VAULT_CAMPAIGNS_ROOT` and everything else to `VAULT_ROOT` via the existing `safeVaultPath(input, root)` test-seam.

5. **Per-campaign opt-in flag (Decision 5):** **Separate `vaultMutations: boolean` on `CampaignSettings`.** Orthogonal to `masterBackend`. The resolver returns `false` for `vaultMutations` if `masterBackend !== 'vault'` (no effect on baked campaigns; resolver-level concern, no API breakage — see Pitfall 5).

6. **Concurrent-write smoke test (Decision 6):** **Same Vitest harness as Phase 01.** A single `tests/ai/master/vault/events-writer.test.ts` runs N=100 by default and N=1000 under `STRESS_N=1000` env override.

7. **Backup strategy (Decision 7, REQ-007):** **Separate git repo via `pnpm vault:backup` script.** Matches spike 013 DR validation exactly. Zero new infrastructure (git is on every dev machine, free-tier private repos cover the workload). Recovery is the documented one-liner: `git clone <vault-repo> && pnpm vault:rebuild-views`. Tarball+cron is the documented fallback for users preferring true offline-first operation; the script supports both via `--strategy=git|tarball`.

8. **Coexistence semantics (RESEARCH Open Question 3 — HIGH-risk):** **Single-write to events.md for opted-in campaigns.** The UI continues reading from Postgres in Phase 02 — opted-in campaigns surface a UI banner ("Vault mutations active — UI reflects last Postgres state until session refresh"). Phase 03 handles the dual-write reconciliation. **Rationale:** Phase 02's job is to PROVE vault writes work end-to-end on opted-in campaigns; dual-write is Phase 03's explicit scope. The stale-UI cost is acceptable for the opt-in cohort (developer/tester only — production rolls forward to Phase 03 before public traffic flips). Plan 02-08 implements + documents this; the UI banner is the only behavioural change visible to the operator.

9. **Initial state seeding (RESEARCH Open Question 2):** **Synthetic `campaign_initialized` seed event.** When a campaign is first flagged `vaultMutations: true`, the `vault-flip --enable-mutations` command appends the seed event as line 1 of `events.md`. The seed payload is bootstrapped FROM the Postgres `characters` snapshot at the moment of flip (so coexistence-mode reads see the same starting state). The projector treats `campaign_initialized` as a special event type that populates `INITIAL_CHARACTER_STATE` for each character listed in the payload. This gives a complete event trail (no implicit DB read from the projector — projector stays pure) and integrates cleanly with Phase 03's Postgres→vault export.

10. **Character file slug collision (RESEARCH Open Question 1):** **Append `-<id8>` suffix.** `characters/<slug>-<id8>.md` where `id8` is the first 8 chars of the character UUID. Defensive against name-slug collisions (e.g., "Ára" vs "Ara") at zero ergonomic cost — the LLM never types the slug directly; it reads the filename via `list_vault`.

11. **TURN_TOOL_CALL_CAP for vault turns (RESEARCH Open Question 4):** **Introduce `VAULT_TURN_TOOL_CALL_CAP = 20`** in `src/sessions/types.ts`. The vault loop reads the new constant; the baked loop continues using the existing `TURN_TOOL_CALL_CAP = 12`. Combat turns can fire ~10 mutations + reads + end_turn without truncation.

---

## Plan execution order (dependency graph + waves)

Plans split along the dependency lines defined by the artifact map. Each plan = one reviewable atomic commit.

| Order | Plan | Wave | Depends on | Net diff |
|---|---|---|---|---|
| 1 | `plans/02-01-events-schema.md` | 1 | none | ~120 LOC + 90 LOC tests |
| 2 | `plans/02-02-campaign-path-resolver.md` | 1 | none | ~120 LOC + 110 LOC tests |
| 3 | `plans/02-03-events-writer.md` | 2 | 02-02 | ~80 LOC + 100 LOC tests |
| 4 | `plans/02-04-projector.md` | 2 | 02-01, 02-02 | ~220 LOC + 160 LOC tests |
| 5 | `plans/02-05-vault-mutations-flag.md` | 1 | none | ~90 LOC + 80 LOC tests |
| 6 | `plans/02-06-tool-loop-cap-bump.md` | 1 | none | ~40 LOC + 50 LOC tests |
| 7 | `plans/02-07-apply-event-tool.md` | 3 | 02-01, 02-02, 02-03, 02-04, 02-05, 02-06 | ~180 LOC + 140 LOC tests |
| 8 | `plans/02-08-coexistence-semantics.md` | 3 | 02-05, 02-07 | ~120 LOC + 90 LOC tests |
| 9 | `plans/02-09-concurrent-write-smoke.md` | 3 | 02-03, 02-07 | ~60 LOC + 100 LOC tests |
| 10 | `plans/02-10-backup-strategy.md` | 3 | 02-02 | ~180 LOC + 60 LOC tests |
| 11 | `plans/02-11-summary.md` | 4 | all | ~150 LOC docs |

**Wave structure (parallelism):**

```
Wave 1 (independent foundation): 02-01, 02-02, 02-05, 02-06
Wave 2 (depends on Wave 1):       02-03 (needs 02-02), 02-04 (needs 02-01, 02-02)
Wave 3 (integration):             02-07 (needs all of Wave 1+2), 02-08, 02-09, 02-10
Wave 4 (wrap-up):                  02-11
```

Within Wave 3, plans 02-08, 02-09, 02-10 touch disjoint files relative to 02-07 (the integration anchor); they can run in parallel after 02-07 lands.

**File ownership matrix (no overlap = safe parallel):**

| Plan | Owns these files (exclusive write) |
|---|---|
| 02-01 | `src/ai/master/vault/events-schema.ts`, `tests/ai/master/vault/events-schema.test.ts` |
| 02-02 | `src/ai/master/vault/campaign-paths.ts`, `tests/ai/master/vault/campaign-paths.test.ts` |
| 02-03 | `src/ai/master/vault/events-writer.ts`, `tests/ai/master/vault/events-writer.test.ts` |
| 02-04 | `src/ai/master/vault/projector.ts`, `tests/ai/master/vault/projector.test.ts` |
| 02-05 | `src/db/schema/campaigns.ts` (extend type), `src/lib/preferences.ts` (extend validator + resolver), `tests/lib/preferences-vault-mutations.test.ts` |
| 02-06 | `src/sessions/types.ts`, `src/ai/master/vault/loop.ts` (one-line cap source change), `tests/sessions/turn-tool-call-cap.test.ts` |
| 02-07 | `src/ai/master/vault/tools.ts` (extend), `src/ai/master/vault/index.ts` (barrel export), `tests/ai/master/vault/tools.test.ts` (extend), `tests/ai/master/vault/loop.test.ts` (extend), `tests/ai/master/vault/phase-smoke.test.ts` (invert assertion), `tests/ai/master/vault/apply-event-integration.test.ts` (new) |
| 02-08 | `src/app/api/sessions/[id]/turn/route.ts` (gate apply_event exposure on vaultMutations), `tests/sessions/vault-mutations-gate.test.ts`, `tests/sessions/vault-mutations-resume.test.ts` |
| 02-09 | `tests/ai/master/vault/events-writer-stress.test.ts` (large-N stress harness — separate file from 02-03's basic concurrency test) |
| 02-10 | `scripts/vault-backup.ts`, `scripts/vault-rebuild-views.ts`, `package.json` (add `vault:backup` + `vault:rebuild-views` scripts), `docs/operators/vault-backup.md` |
| 02-11 | `.planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md` |

---

## Phase-level success criteria (from ROADMAP)

- ✓ A turn that resolves combat damage produces an `apply_event` tool call that lands in `events.md` AND updates `characters/<name>.md` frontmatter atomically (single transaction at the EventsWriter mutex layer)
- ✓ Concurrent stress test (100 parallel `apply_event` calls on same campaign) passes with 0 lost / 0 corrupted / 0 duplicated
- ✓ Restart of Next.js server preserves state via events.md replay on session resume
- ✓ Both backends (Postgres + Vault) can run side-by-side per campaign (some campaigns opted in via `vaultMutations: true`, others not)
- ✓ Property test: round-trip serialization (event → state → view → assert state derivable back via replay)

---

## Threat model

### Trust Boundaries

| Boundary | Description |
|---|---|
| LLM → tool dispatcher | LLM-supplied event payload crosses here; type guards must reject malformed input before EventsWriter sees it |
| tool dispatcher → filesystem | All paths resolved server-side from `ctx.campaignId` (never from LLM input); EventsWriter mutex serializes writes |
| events.md → projector | Disk content parsed via JSON.parse per line; corrupted line aborts replay fast |
| materialized view → consumer | View file is read-only output of projector; never written from outside |
| VAULT_CAMPAIGNS_ROOT → backup repo | Out-of-band; operator-driven via `pnpm vault:backup` |

### STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|---|---|---|---|---|
| T-02-01 | Spoofing | apply_event tool call from LLM | mitigate | Server-side `campaignId` from validated Clerk session row (existing `checkPartyAccess`); the LLM cannot supply a different campaignId. Dispatcher resolves `campaignDir(ctx.campaignId)` — LLM path input is ignored entirely for writes. |
| T-02-02 | Tampering | Concurrent write corruption to events.md | mitigate | `EventsWriter` single-writer mutex (Map<absolute-path, Promise<void>>), validated by spike 010 at 100 concurrent writes with 0 loss. Plan 02-03 ships the writer; plan 02-09 verifies regression at 100 & 1000 parallelism. |
| T-02-03 | Tampering | Event payload injection (e.g., `delta: 999999`) | mitigate | Type guard `validateEvent` enforces typeof and numeric finiteness. The PROJECTOR clamps `hp_current` to `[0, hp_max]` (spike 008 example). Inventory `qty` validated `> 0` and `< 1000`. Spell slot levels validated `1 ≤ level ≤ 9`. Plan 02-01 ships the guard + clamp boundaries. |
| T-02-04 | Tampering | Path traversal via `campaignId` (e.g., `../../etc/passwd`) | mitigate | `campaignId` is a Postgres UUID from validated session — typed `string` from drizzle, but `campaignDir()` calls `path.resolve(VAULT_CAMPAIGNS_ROOT, campaignId)` which normalizes; additionally plan 02-02 adds a UUID-format regex check before `resolve` (fail-closed: invalid format → throw) so any non-UUID string short-circuits before touching the filesystem. |
| T-02-05 | Tampering | Path traversal via character name slug (e.g., `../etc/passwd`) | mitigate | `slugifyCharacterName()` strips `[^a-z0-9-]` to ASCII slug ∪ id8 suffix. Result `etc-passwd-<id8>.md` lands safely under `campaignDir`. Plan 02-02 ships the slug helper + path-prefix assertion. |
| T-02-06 | Repudiation | Operator manually edits events.md to "fix" a past event line | accept | NON-REQ-005 (vault unencrypted at rest, file permissions sufficient). Documented in `docs/operators/vault-backup.md` (plan 02-10): correction policy is COMPENSATING events, never line edits. The projector cannot detect tampering — out of scope. |
| T-02-07 | Information disclosure | Cross-campaign data leakage via path manipulation | mitigate | `campaignId` resolved server-side from Clerk-validated session row (existing). Dispatcher resolves paths under `campaignDir(ctx.campaignId)` ONLY. Path-prefix assertion in plan 02-02: every resolved file must be a descendant of `campaignDir(ctx.campaignId)`. Test in plan 02-07 verifies an `apply_event` with a hostile character name like `../../other-campaign/characters/aragorn` still resolves under the caller's campaign dir. |
| T-02-08 | DoS | Disk-fill via runaway event emission | mitigate | `VAULT_TURN_TOOL_CALL_CAP = 20` (plan 02-06) limits events per turn. Operational cap: 20 events × 200 bytes × 50 turns/day = ~200KB/day/campaign. Negligible on M4 256GB SSD. |
| T-02-09 | DoS | Replay performance degradation as events.md grows | accept (Phase 02) / defer | Synchronous replay scales linearly: ~1ms/100 events, ~100ms/10K events (spike 008). Phase 02 ships without compaction. Documented in plan 02-11 SUMMARY as Phase 03 follow-up: snapshot+compact at the 10K-event boundary. |
| T-02-10 | Elevation of privilege | Multi-process EventsWriter race (dev server + a debug script both write same events.md) | mitigate (operational) | NON-REQ-001 declares single-Next.js-server invariant. `docs/operators/vault-backup.md` documents the runbook: any bulk-mutation script (Phase 03 import, recovery tool) MUST run with the Next.js server stopped. No code-level guard — the in-process mutex is single-process by design (spike 010 commentary). |
| T-02-11 | Tampering | Backup repo corruption / accidental force-push | mitigate | `pnpm vault:backup` uses `git push` without `--force` (plan 02-10). The script refuses to push if the working tree has uncommitted manual edits to events.md (defensive). Recovery via `git reflog` is documented in plan 02-10's runbook. |
| T-02-12 | Tampering | Stale view file after partial write crash | mitigate | After `EventsWriter.append` returns, the projector regenerates the view from the now-complete events.md. If the process crashes mid-`appendFile`, the last event may be truncated; on next replay the view is rebuilt from the valid prefix. Spike 010 commentary confirms POSIX `O_APPEND` is atomic for whole-write operations under 4KB. Test in plan 02-09 verifies recovery from a synthetic truncated-tail events.md. |

---

## How to validate phase completion

Run, in order:

1. **Unit + integration tests pass:**
   ```
   pnpm test
   ```
   Phase 01's 123 tests stay green. Phase 02 adds ~150 new test cases across 7 new test files + 4 extensions.

2. **Concurrency regression test (Phase 02-specific):**
   ```
   pnpm test tests/ai/master/vault/events-writer.test.ts
   STRESS_N=1000 pnpm test tests/ai/master/vault/events-writer-stress.test.ts
   ```
   Both must pass with 0 lost / 0 corrupted / 0 duplicated.

3. **Type + lint clean:**
   ```
   pnpm typecheck
   pnpm lint
   ```

4. **Backup roundtrip (manual, plan 02-10):**
   ```
   pnpm vault:flip --id=<test-campaign-uuid> --enable-mutations
   # ... play a turn that fires apply_event ...
   pnpm vault:backup --strategy=git
   # ... corrupt a view file ...
   pnpm vault:rebuild-views --campaign=<uuid>
   # ... assert view restored ...
   ```

5. **Live smoke test on a vault-flagged campaign:**
   - Set `campaigns.settings.masterBackend = 'vault'` AND `campaigns.settings.vaultMutations = true`
   - Send a combat turn ("Aragorn attacks the goblin and takes 5 damage")
   - Confirm `events.md` contains the `hp_change` event with `delta: -5`
   - Confirm `characters/aragorn-<id8>.md` frontmatter shows the new `hp_current`
   - Restart Next.js server; query `read_vault_multi(['/campaigns/<id>/characters/aragorn-<id8>.md'])` via a debug turn; confirm post-restart state matches pre-restart (replay works)
   - Flip `vaultMutations` back to `false`; confirm `apply_event` is rejected at the dispatch layer (campaign no longer opted in)

---

## What this phase explicitly does NOT do

Bounded by Phase 02's event-sourced write scope:

- ❌ **No dual-write to Postgres for opted-in campaigns.** Single-write to events.md only (Decision 8). Phase 03 owns dual-write reconciliation.
- ❌ **No UI vault-read path for opted-in campaigns.** The UI continues reading from Postgres; operator sees a stale-state banner (Decision 8). Phase 03 wires the UI to read from materialized views.
- ❌ **No RAG retirement / baked-variant retirement.** Both stay running for non-opted-in campaigns. Phase 03 retires them.
- ❌ **No multi-process EventsWriter.** In-process Map<path, Promise> mutex (NON-REQ-001).
- ❌ **No event-log compaction or snapshot.** Trivial follow-up for Phase 03+ once campaigns approach 10K events (negligible for v1 — a year-long campaign is ~2K events; spike 008).
- ❌ **No per-turn summarization at 15K tokens** (REQ-023). Phase 03 deliverable.
- ❌ **No additional event types beyond the 7 listed.** Combat-critical follow-ups (`temp_hp_set`, `death_save_success/fail`, `concentration_break`, `attune/unattune`) are tracked in plan 02-11's SUMMARY as Phase 03 candidates — additive (no migration needed, default case in projector logs and continues).
- ❌ **No automated push from the Next.js process.** `pnpm vault:backup` is operator-driven; Phase 02 doesn't add a post-event hook to git push.
- ❌ **No new dependency added to package.json.** Zod is intentionally excluded (Decision 1) — hand-rolled type guards instead.
- ❌ **No event-id idempotency check.** Every event gets a fresh `randomUUID()`; the API-layer `acquireTurnLock` prevents retry storms. Spike 008 §"Idempotent event application" recommended this for cross-process scenarios; NON-REQ-001 makes it irrelevant for Phase 02.

---

## Cross-references

- **Requirements satisfied:** REQ-004, REQ-005, REQ-006, REQ-007, REQ-010 (`.planning/REQUIREMENTS.md`)
- **Research input:** `02-RESEARCH.md` (this directory) — architectural decisions, code examples, pitfalls
- **Validation strategy:** `02-VALIDATION.md` (this directory) — per-task verification map, sampling rate
- **Spike findings:** `.planning/spikes/006-frontmatter-atomicity/README.md` (cautionary tale), `008-events-md-replay`, `010-events-md-concurrency`, `013-vault-backup-restore`
- **Auto-loaded skill:** `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` — the implementation contract
- **Phase 01 inheritance:** `.planning/phases/01-vault-read-path/SUMMARY.md` — vitest scope rule, M5 Pro smoke baseline
- **Project constraints:** `./CLAUDE.md` (Italian in chat, English in code), `./AGENTS.md` (Next.js 16 breaking changes — Phase 02 introduces no new routing patterns)
