# Phase 02: Vault Write Path (Event Sourcing) — Research

**Researched:** 2026-05-25
**Domain:** Event-sourced mutation layer for the markdown vault — `apply_event` tool, `EventsWriter` single-writer mutex, materialized-view projector, per-campaign directories under `VAULT_CAMPAIGNS_ROOT`
**Confidence:** HIGH (every primitive validated by an existing spike; codebase verified file-by-file; Phase 01 already exported the constants Phase 02 consumes)

## Summary

Phase 02 closes the 4th tool in the vault tool surface (`apply_event`) and turns the per-campaign directory tree into a writable, event-sourced store. Every primitive on the critical path has a validated spike behind it: `EventsWriter` mutex (spike 010), events.md → state replay projector (spike 008), DR by replay (spike 013), and the cautionary tale of why naive read-modify-write was abandoned (spike 006). Phase 01 already shipped both `VAULT_ROOT` (static) and `VAULT_CAMPAIGNS_ROOT` (env-configurable, runtime-only) in `src/ai/master/vault/path.ts` — Phase 02 just CONSUMES them. The vault tool loop (`src/ai/master/vault/loop.ts`) already dispatches via `dispatchVaultTool` — Phase 02 adds one branch and one new export from `tools.ts`.

There are only **two genuinely open questions** that are not pre-determined by the spike rollup or Phase 01 closure:

1. **The event-type schema shape** — TypeScript discriminated union (closed, type-safe, breaking when extended) vs. Zod-validated `{type: string, payload: unknown}` (open, runtime-validated, additive). [VERIFIED: zod is NOT in package.json — adding it is a new dependency decision.]
2. **The backup-strategy decision deferred from spike 013** — REQ-007 mandates campaign data outside the repo; the planner must pick tarball+cron / separate git repo / S3 sync, OR document a new deferral with explicit criteria.

Everything else — single-writer mutex pattern, append-only invariant, materialized-view regeneration timing, tool surface extension, opt-in flag, concurrent-write smoke test — has either a validated spike pattern or a clear precedent from Phase 01.

**Primary recommendation:** lift the validated `EventsWriter` from `.planning/spikes/010-events-md-concurrency/writer.ts` near-verbatim into `src/ai/master/vault/events-writer.ts`. Add the 4th tool definition in the existing `VAULT_TOOL_DEFINITIONS` array and a 4th branch in `dispatchVaultTool`. Resolve per-campaign paths via `join(VAULT_CAMPAIGNS_ROOT, campaignId, 'events.md')` and `characters/<name>.md`. Adopt a TypeScript discriminated union for the 7 initial event types validated by a slim Zod-equivalent runtime check (hand-rolled type guards — no new dependency). Run the materialized-view projector synchronously inside `apply_event` (cheap; spike 008 measured <1ms for 100 events, the Phase 02 budget is one event per call). Extend `CampaignSettings` with a new field `vaultMutations?: boolean` (separate from `masterBackend` — additive, can be flipped independently). Pick **separate git repo** as the backup strategy for REQ-007 (one-line decision, matches the spike-013 DR validation, requires no new infra).

## User Constraints (from CONTEXT.md)

No CONTEXT.md exists for this phase — `gsd-discuss-phase` was not run. The phase scope comes from `.planning/ROADMAP.md` (Phase 02 section, LOCKED) and the requirement IDs in `.planning/REQUIREMENTS.md` (REQ-004, REQ-005, REQ-006, REQ-007, REQ-010 — all LOCKED by spike validation; cannot be revised without re-spiking per REQUIREMENTS.md preamble).

Locked-by-spike requirements that constrain every Phase 02 decision:

- **REQ-004** (events.md is source of truth, materialized views are projections) — locked by spikes 008, 010, 013
- **REQ-005** (mutations go through `EventsWriter` single-writer mutex, NEVER naive read-modify-write) — locked by spike 006 INVALIDATION and spike 010 validation
- **REQ-006** (DR = events.md is the only durable artifact; restore = replay events.md → regenerate views; backup strategy out-of-band) — locked by spike 013
- **REQ-007** (campaign data lives OUTSIDE the codebase repo under `VAULT_CAMPAIGNS_ROOT`, default `~/.dnd-ai-master/vault/campaigns/`) — locked by 2026-05-24 design decision
- **REQ-010** (fixed 4-tool surface includes `apply_event`) — locked by spike 009

## Project Constraints (from CLAUDE.md / AGENTS.md)

- **Italian in chat, English in code/commits/docs.** Phase 02 RESEARCH.md and PLAN.md stay in English.
- **AGENTS.md: "This is NOT the Next.js you know."** Heed deprecation notices in `node_modules/next/dist/docs/`. [VERIFIED: next is 16.2.4 — `cat node_modules/next/package.json | grep version`.] Phase 02 does NOT introduce new Next.js routing patterns — it extends the existing `src/app/api/sessions/[id]/turn/route.ts` route handler. The vault branch in that file (lines 248-409, plan 07 of Phase 01) is the only entry point. No new Next.js APIs need to be learned.
- **Auto-loaded skill `spike-findings-dnd-ai-master`** — `references/storage-and-mutation.md` is the implementation blueprint for `EventsWriter`, the events.md replay pattern, and DR. The planner MUST read this skill page; it is exactly the contract for Phase 02. [CITED: .claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md]

## Phase Requirements

| ID | Description (from REQUIREMENTS.md) | Research Support |
|----|-----------------------------------|------------------|
| REQ-004 | events.md per campaign is the source of truth; per-entity .md files are materialized views | §4 EventsWriter + §5 projector design; spike 008 replay byte-exact validation |
| REQ-005 | Mutations go through EventsWriter single-writer mutex; NEVER naive read-modify-write | §4 EventsWriter — direct lift from spike 010 source (`.planning/spikes/010-events-md-concurrency/writer.ts`) |
| REQ-006 | DR: events.md is the only durable artifact; restore = replay events.md → regenerate views | §5 projector + §6 DR + backup strategy; spike 013 byte-exact restore validation |
| REQ-007 | Campaign data OUTSIDE codebase repo at VAULT_CAMPAIGNS_ROOT (default ~/.dnd-ai-master/vault/campaigns/) | §3 path resolution — Phase 01 already shipped the constant in `path.ts:26-28`; §6 backup strategy decision |
| REQ-010 | Fixed 4-tool surface: read_vault_multi, list_vault, apply_event, end_turn | §7 — extend `VAULT_TOOL_DEFINITIONS` from 3 to 4; extend `dispatchVaultTool` with `apply_event` branch |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `apply_event` tool emission | LLM (Ollama) | — | Tool call goes through provider/local.ts unchanged; Phase 02 only adds the tool definition |
| Tool dispatch + path resolution | Frontend Server (Next.js process) | — | `dispatchVaultTool` runs inside the vault tool loop, in the Next.js server process |
| `EventsWriter` mutex serialization | Frontend Server (in-process) | — | NON-REQ-001: single-Next.js-server invariant; in-process mutex is sufficient (spike 010 validated) |
| Append to events.md | OS Filesystem (POSIX O_APPEND) | — | atomicity guarantee for <4KB writes is FS-level (spike 010 commentary); same-volume as VAULT_CAMPAIGNS_ROOT mandatory (spike 006) |
| Replay events → state | Frontend Server (pure function) | — | `applyEvent(state, event)` is a pure projector — deterministic, testable in isolation; spike 008 proved exact replay |
| Serialize state → frontmatter view | Frontend Server (filesystem write) | — | Materialized view regeneration runs synchronously after each `apply_event` (cheap, <5ms; see §5) |
| Per-campaign storage | OS Filesystem (under VAULT_CAMPAIGNS_ROOT) | — | REQ-007: outside codebase repo; default `~/.dnd-ai-master/vault/campaigns/<id>/` |
| Postgres game state | Database | — | UNCHANGED — Postgres remains source of truth for any campaign without `vaultMutations: true` (coexistence) |
| Telemetry (ai_usage) | Database | — | UNCHANGED — `recordUsage` continues firing identically; events.md writes are NOT logged to ai_usage |
| Backup of events.md | OS / Operator | — | OUT OF BAND per REQ-006/REQ-007; Phase 02 decision is which mechanism (separate git repo recommended) |

## Standard Stack

### Core (already in repo — no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:fs/promises` | builtin | `appendFile`, `readFile`, `writeFile`, `mkdir` — the only FS primitives needed | Spike 010 used these directly; `appendFile` with default flags is `O_APPEND` atomic for <4KB writes on POSIX |
| `node:path` | builtin | `join`, `dirname`, `resolve` — path manipulation under VAULT_CAMPAIGNS_ROOT | Already used by `src/ai/master/vault/path.ts` |
| `node:crypto` | builtin | `randomUUID()` for event IDs | Already used by Phase 01 `prompt-builder.ts` (createHash); idempotency via event_id (spike 008) |
| `drizzle-orm` | `^0.45.2` | Read/write `CampaignSettings.vaultMutations` flag via the existing `campaigns.settings` JSONB column | Same pattern as Phase 01's `masterBackend` field |
| `vitest` | `^4.1.5` | Unit + integration tests; existing `tests/ai/master/vault/` directory + scope (REQ ONLY in `tests/`, NEVER colocated — see Phase 01 SUMMARY) | Phase 01 cumulative 123 tests across 8 files all green; same pattern |

[VERIFIED: package.json lines 38-65 — every dependency listed is already in the repo; `npm view drizzle-orm version` not run because version is already pinned and not changing.]

### Supporting (no new packages)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@anthropic-ai/sdk` | `^0.92.0` | `ToolDef = Anthropic.Messages.Tool` shape — already the canonical form for vault tools | Phase 02 extends the existing array; no schema-format change |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled type guards (`isApplyEventInput`) | `zod` validation | Zod gives ergonomic schemas + automatic error messages, BUT adds a runtime dep (~50KB), and the validation surface is small (7 event types). Hand-rolled is ~80 LOC, no dep cost. **Recommendation: hand-rolled.** [VERIFIED: zod NOT in package.json — would be a new dep] |
| In-process mutex via Map<path, Promise> | `proper-lockfile` (cross-process flock) | Cross-process is overkill for the single-Next.js-server deployment (NON-REQ-001). Spike 010 validated the in-process pattern at 100 concurrent writes in 7ms. **Recommendation: in-process per spike 010.** Future-proof: the `EventsWriter` public API stays identical if v2 ever swaps the implementation to flock |
| Synchronous view regen inside apply_event | Async post-turn regen via waitUntil | Async = faster turn return, but introduces eventual consistency (a follow-up `read_vault_multi` may see stale view). Synchronous = ~5ms cost per regen for small campaigns (spike 008 measured ~1ms for 100 events; one event in real time is <100µs). **Recommendation: synchronous** — simpler, correct, latency cost is negligible |
| Separate git repo for VAULT_CAMPAIGNS_ROOT | Tarball+cron / S3 sync | Git: per-commit history, free DR rehearsal, no infra. Tarball: simpler but no version history without naming convention. S3: requires AWS creds + ongoing cost. **Recommendation: separate git repo** — matches the spike 013 DR procedure ("git clone + replay") |

**Installation:** none — every primitive is already in the repo. Phase 02 ships purely new application code under `src/ai/master/vault/`.

**Version verification:** All packages pinned; no fetches needed. [VERIFIED: `cat package.json | grep -E '(zod|drizzle|vitest|tsx|@anthropic)'` 2026-05-25 — zod absent, others present at versions listed above.]

## Architecture Patterns

### System Architecture Diagram

```
                          ┌─────────────────────────────────────────────────┐
                          │  Player POST /api/sessions/[id]/turn            │
                          │  (existing route handler)                       │
                          └────────────────────┬────────────────────────────┘
                                               │
                          (masterBackend resolver chain — Phase 01)
                                               │
                              vault │  ←  vaultMutations gate (NEW Phase 02)
                                    │       campaign.settings.vaultMutations
                                    │       ↓
                                    ↓     true  → vault WRITES enabled (4 tools)
                          ┌─────────┴─────────────────────────────────────┐
                          │  runVaultToolLoop                              │
                          │  (existing — Phase 02 adds apply_event branch) │
                          └────────────┬───────────────────────────────────┘
                                       │
                          provider.completeMessage → LLM
                                       │
                          tool_use blocks returned
                                       │
                          ┌────────────┴─────────┬──────────────┬───────────┐
                          ▼                      ▼              ▼           ▼
                  read_vault_multi         list_vault     apply_event   end_turn
                       (P01)                 (P01)         (NEW P02)      (P01)
                                                                 │
                                                                 ▼
                                           ┌──────────────────────────────────────┐
                                           │  dispatchVaultTool('apply_event', …) │
                                           │  • validate event type + payload     │
                                           │  • resolve campaign path             │
                                           │  • EventsWriter.append (single       │
                                           │    writer per campaign_id mutex)     │
                                           │  • run projector → regenerate        │
                                           │    materialized view                 │
                                           └──────────────┬───────────────────────┘
                                                          │
                                                          ▼
              ┌──────────────────────────────────────────────────────────────────┐
              │  VAULT_CAMPAIGNS_ROOT  (default ~/.dnd-ai-master/vault/campaigns) │
              │                                                                    │
              │  campaigns/<campaign-id>/                                          │
              │    events.md          ← append-only SOURCE OF TRUTH (spike 008)   │
              │    characters/<n>.md  ← materialized VIEW (regenerated on write)  │
              │    sessions/<n>.md    ← materialized VIEW (Phase 03+)             │
              └──────────────────────────────────────────────────────────────────┘
                                                          │
                                                          │
                                  (OUT-OF-BAND backup — Phase 02 decision)
                                                          │
                                                          ▼
                                     ┌──────────────────────────────────┐
                                     │  Separate git repo (recommended) │
                                     │  git commit + push per session   │
                                     │  Recovery = git clone + replay   │
                                     │  (spike 013 byte-exact restore)  │
                                     └──────────────────────────────────┘
```

**Data flow (one `apply_event` call):**
1. LLM emits `apply_event` tool_use with `{type, payload}`
2. `dispatchVaultTool` validates type ∈ {7 known types} and payload shape
3. Resolve path: `join(VAULT_CAMPAIGNS_ROOT, campaign.id, 'events.md')`
4. `EventsWriter.applyEvent(path, {id, version, type, payload, timestamp})` — mutex-serialized append
5. After append succeeds: read full events.md, replay through projector, write `characters/<name>.md` (and any other affected views)
6. Return `{ok: true, event_id}` as tool_result; LLM continues turn

### Recommended Project Structure

```
src/ai/master/vault/
├── path.ts                    # EXISTING — exports VAULT_ROOT, VAULT_CAMPAIGNS_ROOT, safeVaultPath
├── prompt-builder.ts          # EXISTING — pure-function vault system prompt (Phase 01)
├── tools.ts                   # MODIFY — add 4th tool `apply_event` + branch in dispatchVaultTool
├── loop.ts                    # READ-ONLY — already dispatches via dispatchVaultTool
├── index.ts                   # MODIFY — export EventsWriter, projector, event types
├── __forbidden-patterns.ts    # READ-ONLY — Phase 01 lint patterns
│
├── events-writer.ts           # NEW — EventsWriter class (lift from spike 010 writer.ts)
├── events-schema.ts           # NEW — Event discriminated union + runtime type guards
├── projector.ts               # NEW — applyEvent(state, event) + replay(events) + serializeView
├── campaign-paths.ts          # NEW — resolve per-campaign paths under VAULT_CAMPAIGNS_ROOT
│
└── (test files live under tests/ai/master/vault/, NOT colocated)

tests/ai/master/vault/
├── path.test.ts                       # EXISTING
├── prompt-builder.test.ts             # EXISTING
├── tools.test.ts                      # MODIFY — add apply_event tests
├── loop.test.ts                       # MODIFY — add apply_event branch tests
├── phase-smoke.test.ts                # MODIFY — drop the "no tool named apply_event" assertion (Phase 02 inverts it)
│
├── events-writer.test.ts              # NEW — 100 concurrent appends → 0 lost (mirrors spike 010 stress.ts)
├── events-schema.test.ts              # NEW — type guards reject malformed payloads
├── projector.test.ts                  # NEW — replay byte-exact, corruption fail-fast (mirrors spike 008 replay.ts)
├── campaign-paths.test.ts             # NEW — VAULT_CAMPAIGNS_ROOT env override + default + safety
└── apply-event-integration.test.ts    # NEW — end-to-end: 5 mock apply_event calls → events.md + view files match expected

tests/sessions/
└── vault-mutations-gate.test.ts       # NEW — turn route honors campaign.settings.vaultMutations flag

src/db/schema/campaigns.ts
└── CampaignSettings                   # MODIFY — add `vaultMutations?: boolean` field

src/lib/preferences.ts
└── resolveVaultMutations()            # NEW — campaign settings → env override → default false

scripts/
├── vault-flip.ts                      # READ-ONLY — Phase 01 already toggles masterBackend; Phase 02 may add --vault-mutations flag
├── replay-vault-campaign.ts           # NEW (optional) — operator tool to rebuild views from events.md
└── seed-vault-campaign.ts             # NEW (optional) — bootstrap a campaign dir from a Postgres campaign (Phase 03 prep)
```

### Pattern 1: EventsWriter single-writer mutex (REQ-005)

**What:** Per-path promise chain that serializes all `appendFile` calls on the same events.md file.
**When to use:** EVERY mutation. The mutex is the only legitimate writer to events.md in the system.
**Example:** Direct lift from spike 010 — see `.planning/spikes/010-events-md-concurrency/writer.ts`. Validated 100/100 concurrent appends in 7ms with 0 lost / 0 corrupted / 0 duplicated.

```typescript
// Source: .planning/spikes/010-events-md-concurrency/writer.ts (spike 010 VALIDATED)
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class EventsWriter {
  private static queues = new Map<string, Promise<void>>();

  static async append(path: string, line: string): Promise<void> {
    const previous = EventsWriter.queues.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    EventsWriter.queues.set(path, next);
    try {
      await previous;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line.endsWith('\n') ? line : line + '\n', 'utf8');
    } finally {
      release();
      if (EventsWriter.queues.get(path) === next) {
        EventsWriter.queues.delete(path);
      }
    }
  }

  static async applyEvent(path: string, event: object): Promise<void> {
    await EventsWriter.append(path, JSON.stringify(event));
  }
}
```

**Mutex key:** filesystem path (resolved absolute path under VAULT_CAMPAIGNS_ROOT). Spike 010 recommended keying on `campaign_id` directly to defend against path normalization differences — Phase 02 should resolve the absolute path once via `resolve()` and use it as the key. [CITED: `.planning/spikes/010-events-md-concurrency/README.md` lines 99-100]

### Pattern 2: Event-sourced state replay (REQ-004)

**What:** A pure `applyEvent(state, event)` reducer that, given an initial state and an ordered list of events, deterministically produces a final state.
**When to use:** On every read of a materialized view, AND after every write to validate consistency.
**Example:** Direct lift from spike 008 — see `.planning/spikes/008-events-md-replay/replay.ts`.

```typescript
// Source: .planning/spikes/008-events-md-replay/replay.ts (spike 008 VALIDATED)
type Event =
  | { type: 'hp_change'; payload: { delta: number } }
  | { type: 'condition_add'; payload: { condition: string } }
  | { type: 'condition_remove'; payload: { condition: string } }
  | { type: 'spell_slot_use'; payload: { level: number } }
  | { type: 'spell_slot_restore'; payload: { level: number } }
  | { type: 'inventory_add'; payload: { item: string; qty: number } }
  | { type: 'inventory_remove'; payload: { item: string; qty: number } };

interface CharacterState {
  hp_current: number;
  hp_max: number;
  conditions: string[];
  spell_slots: Record<number, { max: number; used: number }>;
  inventory: { item: string; qty: number }[];
}

function applyEvent(state: CharacterState, event: Event): CharacterState {
  const next = structuredClone(state);
  switch (event.type) {
    case 'hp_change':
      next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + event.payload.delta));
      return next;
    // ... other cases
  }
}

// Replay flow: read events.md → split lines → parse → reduce
const raw = await readFile(eventsPath, 'utf8');
const events = raw.trim().split('\n').map((l) => JSON.parse(l));
const state = events.reduce(applyEvent, INITIAL_STATE);
```

**Critical invariant:** the projector is PURE. No `Date.now()`, no random IDs allocated inside the reducer, no env reads. The same input always produces the same output (validated byte-for-byte by spike 013).

### Pattern 3: Materialized view regeneration (REQ-006)

**What:** After every `apply_event`, re-run the projector for the affected entity and rewrite the per-entity .md file.
**When to use:** Synchronously inside `dispatchVaultTool('apply_event', …)` — see Architectural Decision 2 below.

```typescript
async function regenerateCharacterView(campaignDir: string, characterName: string): Promise<void> {
  const eventsPath = join(campaignDir, 'events.md');
  const viewPath = join(campaignDir, 'characters', `${characterName}.md`);
  const raw = await readFile(eventsPath, 'utf8').catch(() => '');
  const events = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = events.reduce(applyEvent, initialStateFor(characterName));
  await writeFile(viewPath, serializeView(state), 'utf8');
}
```

Cost: ~1ms for 100 events (spike 008), ~10ms for 1000 events, ~100ms for 10K events. The first session of a campaign will have <50 events; a year-long campaign accumulates <2K events. Synchronous regen is safe.

### Pattern 4: Per-campaign path resolution (REQ-007)

**What:** Always resolve campaign-scoped paths under `VAULT_CAMPAIGNS_ROOT`, never under `VAULT_ROOT` (which is the static repo-committed handbook).
**When to use:** Every Phase 02 file write or read of dynamic state.

```typescript
// Source: NEW — campaign-paths.ts
import { join, resolve } from 'node:path';
import { VAULT_CAMPAIGNS_ROOT } from './path';

export function campaignDir(campaignId: string): string {
  // VAULT_CAMPAIGNS_ROOT is already absolute (resolved at module load).
  // campaignId is a UUID from Postgres — safe for path use without sanitization.
  return resolve(VAULT_CAMPAIGNS_ROOT, campaignId);
}

export function eventsPath(campaignId: string): string {
  return join(campaignDir(campaignId), 'events.md');
}

export function characterViewPath(campaignId: string, characterName: string): string {
  // characterName may contain spaces/non-ascii — sanitize to slug for filename.
  const slug = slugifyForFilename(characterName);
  return join(campaignDir(campaignId), 'characters', `${slug}.md`);
}
```

### Anti-Patterns to Avoid

- **Naive read-modify-write on a materialized view file** — spike 006 measured 99/100 lost updates under contention. Never call `patchFrontmatter(charPath, …)` directly. ALL state changes go via `apply_event` → events.md append → view regen. The view file is the projector's output; treat as read-only from everywhere else. [CITED: `.planning/spikes/006-frontmatter-atomicity/README.md`]
- **Skipping the EventsWriter mutex "because we're single-agent"** — the in-process mutex is cheap (~30 LOC) and protects against (1) deploy windows where two requests slip through the API lock, (2) future background jobs (auto-save, scheduled NPC actions), (3) parallel test runs. Always use it. [CITED: `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` lines 134-141]
- **Writing materialized views from outside the projector** — anyone writing directly to `characters/aragorn.md` (a tool call, a script, the UI) creates state that does not survive replay. The view IS the projector's output; treat as read-only.
- **Cross-volume temp files** — spike 006 commentary: `rename(2)` atomicity holds only on the same filesystem. If a temp file is written to a different mount than `VAULT_CAMPAIGNS_ROOT`, atomicity is gone. Phase 02 uses `appendFile` (no rename), but if any future code path uses `rename`-based atomic writes, the temp file MUST land in the same volume as the target. [CITED: spike 006 README]
- **Mid-line edits to events.md** — spike 008 corrupted line 50 with malformed JSON and replay aborted fast. Good. But the inverse — silently editing a line in events.md to "correct" a typo — produces undetectable state divergence. **Correction policy: NEVER edit a past event line. Append a compensating event instead** (e.g., `hp_change` with `delta: +5` to undo a prior `hp_change` with `delta: -5`). [CITED: spike 008 README]
- **Letting `events.md` grow without bound** — fine for v1 (a year-long campaign is ~2K events, ~200KB). At ~10K events, replay starts taking ~100ms per turn. Phase 02 ships without compaction; Phase 03+ adds snapshot-and-compact when needed. [CITED: spike 008 README "Compaction strategy"]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrent-safe append-only log | Custom file-locking + write-buffering | `EventsWriter` from spike 010 | Spike 010 already validated 100 concurrent writes with 0 loss. Reinventing this is exactly the path that led to the 99% lost-update disaster in spike 006. The validated pattern is 30 LOC; copy it. |
| Atomic single-file mutation | `rename(2)` over a tmp file | Append-only events.md | Spike 006 INVALIDATED this pattern. Atomic at FS layer ≠ safe read-modify-write under contention. |
| YAML frontmatter parsing | Custom regex + line iteration | Use the projector's `serializeView` to GENERATE frontmatter; never PARSE it back | Materialized views are write-only from the projector's perspective. If you need state, replay events.md — don't reverse-parse the view. |
| JSON-line append format | Custom serialization | `JSON.stringify(event) + '\n'` | Standard JSONL. Each line stands alone; corruption of one line is detected on `JSON.parse` and aborts replay (spike 008 fail-fast). |
| Cross-process file lock | `proper-lockfile` or `flock(2)` | In-process Map<path, Promise<void>> mutex (spike 010) | NON-REQ-001 declares single-Next.js-server invariant. In-process mutex is sufficient and faster. Future-proof: `EventsWriter` public API stays identical if v2 ever swaps to flock. |
| Event ID generation | Custom counter / timestamp | `crypto.randomUUID()` | Built-in Node, no collision concern, no global counter needed for idempotency (spike 008 §"Idempotent event application"). |

**Key insight:** Every primitive on the Phase 02 critical path has either a validated spike or a Node builtin. Hand-rolling any of these is regression risk against work the spike phase already proved.

## Runtime State Inventory

> This is a feature-addition phase (not a rename/refactor). Most categories are not applicable. Listed here for completeness because **per-campaign state migration** is technically a Phase 03 concern but a few items overlap.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | **None for new vault campaigns** — Phase 02 only creates per-campaign dirs for campaigns flagged `vaultMutations: true`. Existing Postgres state for non-flagged campaigns stays in `characters` / `session_state` tables, untouched. | None for Phase 02. Phase 03's export script reads Postgres → writes vault. |
| Live service config | **None** — no external service has the vault path stored as config. The Next.js process resolves paths at runtime from env. | None. |
| OS-registered state | **None** — no Task Scheduler / launchd / pm2 entries reference the vault path. | None. |
| Secrets / env vars | `VAULT_CAMPAIGNS_ROOT` is an OPTIONAL env override. Default is `~/.dnd-ai-master/vault/campaigns/` (resolved via `os.homedir()`). Code reads it at module load via `path.ts:26`. | None — the env var is consumed by code, not by SOPS / Vercel / CI scripts. Document in operator notes that the env may be set in `.env.local` for dev. |
| Build artifacts / installed packages | **None** — no new dependencies, no compiled binaries, no scripts that need rebuilding. | None. |

**The canonical question:** After every file in the repo is updated, what runtime systems still have the old string cached or registered? — **N/A** for Phase 02 because nothing is being renamed. The phase is purely additive.

## Common Pitfalls

### Pitfall 1: Same-volume invariant for VAULT_CAMPAIGNS_ROOT
**What goes wrong:** If `VAULT_CAMPAIGNS_ROOT` is set to a path on a different filesystem mount than where Node writes temp files (e.g., user sets it to an external SSD, but `/tmp` is on the boot volume), any future `rename(2)`-based atomic operation on that path loses its atomicity guarantee.
**Why it happens:** POSIX `rename(2)` is atomic only on the same filesystem. macOS APFS treats `~/...` and `/Volumes/Externe/...` as different filesystems even if they look like one tree.
**How to avoid:** Phase 02 uses `appendFile` exclusively (no rename), so this is NOT a Phase 02 hazard. BUT Phase 03+ might add view-rewrite via tmp+rename (e.g., for atomic full-file updates). The planner should document this constraint in the operator notes and add a runtime assertion in `EventsWriter` (or a sibling helper) that verifies `os.tmpdir()` is on the same volume as `VAULT_CAMPAIGNS_ROOT` IF tmp+rename is ever used. [CITED: `.planning/spikes/006-frontmatter-atomicity/README.md` "What rename(2) actually guarantees"]
**Warning signs:** Sporadic "partial frontmatter" reports on shared external drives. Or, simpler: a user with VAULT_CAMPAIGNS_ROOT pointing to an SD card.

### Pitfall 2: Multi-process EventsWriter assumption
**What goes wrong:** Two Node processes (e.g., dev server + a debug script + a test process) all write the same events.md. Each holds its own in-process Map<path, Promise>. The mutexes do NOT coordinate across processes; appends interleave and corrupt the file.
**Why it happens:** The in-process mutex is by design single-process. Multi-process safety requires `flock(2)` or a writer daemon.
**How to avoid:** Enforce single-Next.js-server invariant at the operational level (documented in NON-REQ-001). Add a smoke test that asserts only the Next.js process writes events.md. If any script ever needs to bulk-mutate events.md (Phase 03 import, recovery tool), it MUST do so while the Next.js server is stopped — document this in the operator runbook. [CITED: spike 010 README "What this doesn't cover"]
**Warning signs:** `JSON.parse` errors on events.md replay after a dev session that involved running both `pnpm dev` AND a one-off `tsx scripts/some-write.ts`.

### Pitfall 3: Materialized view regen blocking the turn
**What goes wrong:** A campaign with 10K+ events takes ~100ms to replay synchronously on every `apply_event` call. A turn that fires 3 `apply_event` calls adds ~300ms latency. M4 budget is < 10s warm wall-clock; this is a few percent of the budget, but it compounds.
**Why it happens:** Synchronous projector runs full events.md replay every time. The cost scales linearly with event count.
**How to avoid:** Phase 02 ships synchronous regen (simplest, correct). Add a follow-up note for Phase 03 to introduce snapshot-and-compact at the 10K-event boundary OR an in-memory state cache keyed on `last_event_id` that skips the full replay when only one event is new. [CITED: spike 008 README "Compaction strategy"]
**Warning signs:** `prompt_eval_duration_ms` stays normal but the gap between tool_use_start and tool_use_end for apply_event grows linearly with campaign age.

### Pitfall 4: Tool-call cap regression after adding the 4th tool
**What goes wrong:** The vault tool loop has `TURN_TOOL_CALL_CAP` (existing project value, 12). A turn that fires 3 reads + 5 apply_events + 1 end_turn = 9 calls — fine. But a complex combat turn with 10 mutations + 2 reads + end_turn = 13 calls — truncated. Phase 01 measured ~6 calls per turn; Phase 02 will push this higher.
**Why it happens:** `apply_event` adds a new class of tool calls that didn't exist in Phase 01. Each HP change, condition add, spell slot use is a separate call.
**How to avoid:** Either raise `TURN_TOOL_CALL_CAP` to ~20 for vault-mutation turns, OR design event-payload to batch multiple mutations in one call (e.g., `apply_event({type: 'batch', payload: {events: [...]}})`). Recommendation: **don't batch in v1** — preserves event-stream readability (each line is one atomic change) and keeps the projector simple. Raise the cap to 20 for vault turns. Document the trigger threshold. [CITED: spike 005 PARTIAL noting complex turns need more rounds; spike 009 validated read_vault_multi specifically to reduce round-trips, which only applies to reads.]
**Warning signs:** `truncated: true` in `VaultLoopResult` for combat turns; final response is partial.

### Pitfall 5: vaultMutations flag + masterBackend interaction
**What goes wrong:** A campaign has `masterBackend: 'baked'` (Phase 01 default) AND `vaultMutations: true` (Phase 02 opt-in). The baked path never invokes the vault tool loop, so `apply_event` is never even exposed — but the flag is set, suggesting the campaign opted into vault mutations. Confusing for the operator.
**Why it happens:** The two flags are conceptually orthogonal but operationally one implies the other.
**How to avoid:** Two clean options:
- (a) Validate at write time: setting `vaultMutations: true` requires `masterBackend: 'vault'`. Reject the PUT otherwise.
- (b) Document that `vaultMutations` has no effect when `masterBackend !== 'vault'`, and have `resolveVaultMutations()` return false in that case.
**Recommendation: (b)** — purely a resolver-level concern; no API breakage; clear semantic ("vault mutations are only meaningful on the vault path"). The `vault-flip.ts` script can warn when flipping `vaultMutations: true` on a baked campaign.
**Warning signs:** Operator sees `vaultMutations: true` in DB and expects writes to happen on a baked campaign.

### Pitfall 6: Event payload schema drift across releases
**What goes wrong:** Phase 02 ships 7 event types. Phase 03 needs an 8th (`level_up`). A campaign played during the transition has both old and new event types in events.md. The old replay code throws on the new event type.
**Why it happens:** No event-schema version field, no graceful fallback for unknown types.
**How to avoid:** Every event has a `version: 1` field (spike 008 recommendation). The projector reducer has a `default` case that LOGS the unknown event type but does NOT throw (graceful degradation — the state may be stale, but replay completes). Phase 03 can bump the version and add migrations. [CITED: `.planning/spikes/008-events-md-replay/README.md` lines 64-69]
**Warning signs:** After a deploy, replay throws on `Unexpected event type 'X'` for a campaign whose events.md was written by a later code version.

## Code Examples

### apply_event tool definition (extending Phase 01)

```typescript
// Source: extend src/ai/master/vault/tools.ts (Phase 01 has 3 entries; this adds the 4th)
// Description wording aligned with the spike-findings skill at
// .claude/skills/spike-findings-dnd-ai-master/references/tool-surface.md lines 64-77.
{
  name: 'apply_event',
  description: 'Append a game-state mutation event (HP change, condition add, slot use, inventory change, etc.). Returns the new event_id on success.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Event type. One of: hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove.',
      },
      payload: {
        type: 'object',
        description: 'Event-specific data. For hp_change: {character: string, delta: number}. For condition_add/remove: {character: string, condition: string}. For spell_slot_use/restore: {character: string, level: number}. For inventory_add/remove: {character: string, item: string, qty: number}.',
      },
    },
    required: ['type', 'payload'],
  },
},
```

### apply_event dispatch branch

```typescript
// Source: extend dispatchVaultTool in src/ai/master/vault/tools.ts
// Combines spike 010 EventsWriter pattern + spike 008 projector pattern.
if (name === 'apply_event') {
  const raw = (input ?? {}) as { type?: unknown; payload?: unknown };
  if (typeof raw.type !== 'string' || typeof raw.payload !== 'object' || raw.payload === null) {
    return { content: 'ERROR: apply_event requires {type: string, payload: object}', isError: true };
  }
  if (!ctx?.campaignId) {
    return { content: 'ERROR: apply_event requires campaignId in dispatch context', isError: true };
  }

  // Validate event shape (hand-rolled type guard, no zod).
  const guarded = validateEvent({ type: raw.type, payload: raw.payload });
  if (!guarded.ok) {
    return { content: `ERROR: ${guarded.error}`, isError: true };
  }

  // Build the canonical event record.
  const event = {
    id: randomUUID(),
    version: 1,
    type: guarded.value.type,
    payload: guarded.value.payload,
    timestamp: new Date().toISOString(),  // ⚠ timestamp is metadata, not used by projector — projector remains pure
  };

  // Persist (mutex-serialized) + regenerate views.
  await EventsWriter.applyEvent(eventsPath(ctx.campaignId), event);
  await regenerateAffectedViews(ctx.campaignId, event);

  return { content: JSON.stringify({ ok: true, event_id: event.id }), isError: false };
}
```

### Hand-rolled event type guard (alternative to Zod)

```typescript
// Source: NEW — src/ai/master/vault/events-schema.ts
export type VaultEvent =
  | { type: 'hp_change'; payload: { character: string; delta: number } }
  | { type: 'condition_add'; payload: { character: string; condition: string } }
  | { type: 'condition_remove'; payload: { character: string; condition: string } }
  | { type: 'spell_slot_use'; payload: { character: string; level: number } }
  | { type: 'spell_slot_restore'; payload: { character: string; level: number } }
  | { type: 'inventory_add'; payload: { character: string; item: string; qty: number } }
  | { type: 'inventory_remove'; payload: { character: string; item: string; qty: number } };

type ValidateResult = { ok: true; value: VaultEvent } | { ok: false; error: string };

export function validateEvent(input: { type: string; payload: object }): ValidateResult {
  const p = input.payload as Record<string, unknown>;
  switch (input.type) {
    case 'hp_change': {
      if (typeof p.character !== 'string' || typeof p.delta !== 'number') {
        return { ok: false, error: 'hp_change requires {character: string, delta: number}' };
      }
      return { ok: true, value: { type: 'hp_change', payload: { character: p.character, delta: p.delta } } };
    }
    // ... 6 more cases
    default:
      return { ok: false, error: `unknown event type: ${input.type}` };
  }
}
```

### Per-campaign path resolver

```typescript
// Source: NEW — src/ai/master/vault/campaign-paths.ts
import { join, resolve } from 'node:path';
import { VAULT_CAMPAIGNS_ROOT } from './path';

export function campaignDir(campaignId: string): string {
  return resolve(VAULT_CAMPAIGNS_ROOT, campaignId);
}

export function eventsPath(campaignId: string): string {
  return join(campaignDir(campaignId), 'events.md');
}

export function characterViewPath(campaignId: string, characterName: string): string {
  const slug = characterName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return join(campaignDir(campaignId), 'characters', `${slug}.md`);
}
```

### Concurrent-write smoke test (port spike 010 to Vitest)

```typescript
// Source: NEW — tests/ai/master/vault/events-writer.test.ts
// Mirrors .planning/spikes/010-events-md-concurrency/stress.ts but in Vitest.
import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventsWriter } from '@/ai/master/vault/events-writer';

describe('EventsWriter concurrency (spike 010 regression test)', () => {
  it('100 parallel appendEvent → 100 events persisted, 0 lost, 0 corrupted', async () => {
    const N = 100;
    const path = join(tmpdir(), `test-events-${Date.now()}.md`);
    await rm(path, { force: true });

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        EventsWriter.applyEvent(path, { id: i, type: 'hp_change', payload: { delta: 1 } }),
      ),
    );

    const raw = await readFile(path, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(N);

    const parsed = lines.map((l) => JSON.parse(l));
    const ids = new Set(parsed.map((e) => e.id));
    expect(ids.size).toBe(N);  // 0 duplicates
    for (let i = 0; i < N; i++) expect(ids.has(i)).toBe(true);  // 0 missing
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Postgres `characters` + `session_state` tables for game state | events.md append-only log + materialized views | Spike phase 2026-05-22 → 2026-05-24 | Phase 02 introduces the alternative for opted-in campaigns; Phase 03 cuts over fully |
| Direct frontmatter mutation via `rename(2)` atomic rewrite | Event sourcing + EventsWriter mutex | Spike 006 INVALIDATED 2026-05-23 | Mandatory — naive read-modify-write loses 99% under contention |
| `pg_dump` for DR | `git push` of VAULT_CAMPAIGNS_ROOT separate repo | Spike 013 validated 2026-05-23 | Phase 02 chooses one of three; recommendation: separate git repo (zero new infra) |
| Hand-rolled per-tool-doc strict protocol | Lenient discovery via `/tools/index.md` | Spike 002 PARTIAL 2026-05-22 | Phase 02 inherits this — no new tool-doc strict enforcement |

**Deprecated / outdated (relative to this phase):**
- The `patchFrontmatter` helper from `.planning/spikes/006-frontmatter-atomicity/patch.ts` is **preserved as a cautionary tale only**. Do not import it, do not adapt it. The mutex+events.md replacement is the only validated pattern.

## Architectural Decisions (open design questions resolved)

The phase brief flagged 7 open design questions. Each is addressed below with a recommended answer and rationale. The planner can adopt or override these; this section exists so the plan-phase agent does not re-litigate them from scratch.

### Decision 1: Event-type schema shape

**Question:** TypeScript discriminated union + hand-rolled type guards, OR `{type: string, payload: unknown}` with Zod validation?

**Recommendation:** **TypeScript discriminated union + hand-rolled type guards.**

**Rationale:**
- Zod is NOT in `package.json` [VERIFIED] — adding it is a new dependency decision (~50KB minified, transitive deps).
- The event-type surface is small (7 types in Phase 02; perhaps 12 in Phase 03 with `level_up`, `xp_gain`, etc.).
- Hand-rolled type guards are ~80 LOC for 7 types — readable, dependency-free, easy to extend.
- A discriminated union gives compile-time exhaustiveness checks in the projector (`default` case throws if a case is missing).
- The spike skill page (`storage-and-mutation.md`) uses the discriminated-union pattern directly — matches established codebase style.

**If the planner overrules:** the Zod path is also valid. It would add one dependency and ~30 LOC of schema declarations. The downstream impact is small. [CITED: `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` lines 82-95]

### Decision 2: Materialized view regeneration timing

**Question:** Synchronously inside `apply_event` (slower turn, simpler) OR async post-turn (faster turn, eventual consistency)?

**Recommendation:** **Synchronously inside `apply_event`.**

**Rationale:**
- Spike 008 measured replay at ~1ms for 100 events. A typical Phase 02 turn has < 10 events; regen cost is <100µs.
- A year-long campaign accumulates ~2K events → regen cost ~20ms. Still negligible vs. the LLM tool round-trip (~3s warm on M4).
- Synchronous = the next tool call (e.g., a follow-up `read_vault_multi` of the character file) sees fresh state. Eventual consistency is a footgun the LLM cannot reason about.
- Async via `waitUntil` is more complex (requires error reporting back to the route), saves <100ms per turn, and introduces a class of bugs (read-after-write inconsistency) that the LLM would surface as confusing behavior.

**Warning signs to revisit:** if `prompt_eval_duration_ms` is healthy but the per-tool latency for `apply_event` exceeds ~200ms, the regen is the cost — switch to async + an in-memory cache.

### Decision 3: `apply_event` return shape

**Question:** Return `{ok: true, event_id}` immediately OR return the updated state slice (heavier prompt re-eval)?

**Recommendation:** **`{ok: true, event_id}` immediately.**

**Rationale:**
- Spike 009 measured: every byte returned in a tool_result increases the next round's prompt_eval count. Returning the full state slice doubles the per-mutation token cost.
- The LLM doesn't need the new state to continue the turn — it has the prior state in context and knows what change it applied. If it needs to re-read, it calls `read_vault_multi`.
- Keeping the success envelope minimal preserves the prefix-cache hygiene work from Phase 01.

**Error case:** when validation fails, return `{ok: false, error: '<reason>'}` — the LLM can self-correct. Mirror spike 009's "per-file errors don't fail the batch" pattern.

### Decision 4: Tool surface extension

**Question:** Does `read_vault_multi` learn to read paths under VAULT_CAMPAIGNS_ROOT transparently, OR add a separate `read_vault_campaign_multi`?

**Recommendation:** **Extend `read_vault_multi` to transparently resolve campaign paths.**

**Rationale:**
- REQ-010 LOCKS the tool surface at exactly 4 tools. Adding a 5th tool violates the lock.
- The LLM should not have to think about "which root does this path live under." From the LLM's perspective, `/handbook/spells/fireball.md` and `/campaigns/<id>/characters/aragorn.md` are both "vault paths."
- Implementation: `read_vault_multi` takes a path → if it starts with `/campaigns/<id>/`, resolve under `VAULT_CAMPAIGNS_ROOT`; otherwise under `VAULT_ROOT`. Both roots have `safeVaultPath()` applied (extend the helper to take a root parameter; it already does — `path.ts:42`).

**Implementation note:** `safeVaultPath()` already accepts a `root` parameter as a test seam. Phase 02 promotes it from "test seam" to "production parameter" — the dispatcher decides which root to pass based on the path prefix.

### Decision 5: Per-campaign opt-in flag shape

**Question:** Extend `masterBackend` enum to a 3rd value `'vault-mutations'`, OR add a separate `vaultMutations: boolean`?

**Recommendation:** **Separate `vaultMutations: boolean` field.**

**Rationale:**
- The two concerns are orthogonal at the data model level: `masterBackend` selects the LLM tool surface (vault vs baked); `vaultMutations` selects whether the vault path is read-only or read-write.
- A 3-value enum forces all consumers (resolvers, validators, UI labels, scripts) to deal with three states even when only two distinctions matter to them.
- The separate field also gives a clean future state: `masterBackend: 'vault' + vaultMutations: false` = Phase 01-style read-only vault (still useful for "ask rules questions, but don't trust the LLM with state yet"). `masterBackend: 'vault' + vaultMutations: true` = Phase 02 full vault.
- The resolver returns `false` for `vaultMutations` if `masterBackend !== 'vault'` (no effect on baked campaigns — see Pitfall 5).

### Decision 6: Concurrent-write smoke test in CI

**Question:** Same Vitest harness as Phase 01, OR new dedicated runner with N parallel workers?

**Recommendation:** **Same Vitest harness.**

**Rationale:**
- Phase 01's 123 tests across 8 files all run via `vitest run` in the same process. Adding the Phase 02 concurrency test as another `tests/ai/master/vault/events-writer.test.ts` keeps the CI surface unchanged.
- The spike 010 stress harness uses `Promise.all` for N=100 — that works inside a single Vitest test case. Node's event loop multiplexes the appends; the mutex serializes them. The test does NOT need a separate worker pool.
- A separate runner adds CI complexity (a second command to invoke, a second log to inspect, a second failure surface). Not worth it for "one concurrency test."
- The test should run with N=100 by default and N=1000 under an env flag (`STRESS_N=1000`) for ad-hoc validation, matching spike 010's runner shape.

### Decision 7: Backup strategy (REQ-007 / REQ-006)

**Question:** Pick one of the three spike-013 options (tarball+cron / separate git repo / S3 sync) OR document re-deferral with criteria.

**Recommendation:** **Separate git repo.**

**Rationale:**
- Matches the spike 013 DR validation procedure exactly ("`git clone <vault-repo> && tsx scripts/rebuild-views.ts`").
- Zero new infrastructure: git is on every dev machine, free-tier private repos cover the personal-scale workload.
- Per-commit history = automatic versioning, no naming convention needed.
- Push frequency: per session (low-cost, ~10KB diff per session). A pre-commit hook in the vault repo can run the projector validation as a self-test.
- Recovery is the documented one-liner from spike 013.

**What this costs:**
- Operator has to create the remote repo once (`gh repo create dnd-ai-master-vault --private`).
- The Next.js process needs to push (or a cron job pushes on its behalf). Decision: push via `child_process.spawn('git', ['push'])` from an `after-event` hook OR via a separate `pnpm vault:backup` script run by the operator. Recommendation: separate script (Phase 02 doesn't need automated push — the dev runs `pnpm vault:backup` after each session).
- `.gitignore` rules: only commit `events.md` + view files; ignore any temp files, `.DS_Store`, etc.

**Why not tarball+cron:** loses per-commit granularity; recovery is "find the right tarball and untar," more steps.
**Why not S3 sync:** requires AWS credentials, billing, IAM policy. Overkill for personal use.

**If the planner overrules:** if the user prefers no remote push (true offline-first), tarball+cron is the next-best. Document a daily tarball under `~/Backups/dnd-ai-master/<date>.tar.gz` with rotation. [CITED: `.planning/spikes/013-vault-backup-restore/README.md` "Signal for the real build"]

## Open Questions

1. **Character name → file slug collision policy.** Two characters with names that slugify to the same value (e.g., "Ára" and "Ara") → same view file. Mitigation: append the character id (first 8 chars of UUID) to the filename: `characters/<slug>-<id8>.md`. Researcher leans **yes, append id8** — defensive, no real ergonomic cost. Planner decides.

2. **Initial state seed.** When `apply_event` is the first mutation on a new campaign, what is `INITIAL_STATE` for the projector? Options: (a) hardcoded zero state in the projector module; (b) seeded from the Postgres `characters` row at the moment the campaign is flagged `vaultMutations: true`; (c) emitted as a synthetic `character_create` event when the campaign starts. **Researcher leans (c)** — keeps the projector pure (no DB read), gives a complete event trail, integrates with Phase 03's Postgres-→-vault migration story (which emits seed events). Planner picks.

3. **Does `apply_event` mutate the Postgres `characters` table during coexistence?** ROADMAP says "Postgres remains source-of-truth for any campaign not opted in." For opted-in campaigns, does Phase 02 dual-write (events.md AND Postgres) or single-write (events.md only)? Phase 03 explicitly handles dual-write reconciliation, so Phase 02 could go either way. **Researcher leans single-write** — Phase 02's job is to prove vault writes work end-to-end on opted-in campaigns; dual-write reconciliation is Phase 03's explicit scope. But: the UI currently reads from Postgres, so an opted-in campaign whose vault is the truth would surface stale numbers in the UI. The planner must address this — either ship a read-from-vault path in the UI for opted-in campaigns OR dual-write in Phase 02 OR explicitly accept the stale-UI cost during opt-in.

4. **TURN_TOOL_CALL_CAP for vault-mutation turns.** Phase 01 inherits the existing cap of 12. A combat turn with multiple HP changes + condition adds + spell slot uses easily fires 8-10 `apply_event` calls plus read_vault_multi + end_turn. Researcher leans **raise to 20 for vault turns** (or unify around `TURN_TOOL_CALL_CAP=15` and validate). The planner should size this against observed sample turns. [CITED: Pitfall 4 above]

5. **Pre-existing campaign vault scaffold.** When a campaign is flagged `vaultMutations: true`, does Phase 02 auto-create `~/.dnd-ai-master/vault/campaigns/<id>/{events.md,characters/}` or wait for the first event? Researcher leans **lazy** — first `apply_event` call creates the dir tree via `mkdir(recursive: true)` already in the `EventsWriter`. No bootstrap step needed.

6. **System-prompt hint about apply_event.** Phase 01's `buildVaultSystemPrompt` says `toolCount: 3`. Phase 02 bumps to 4. The prompt template already supports variable tool counts (line 45: `'After that, use any of the ' + input.toolCount + ' listed tools directly.'`). No prompt-builder change needed beyond bumping the count at the call site in `turn/route.ts`. But: should `/tools/index.md` (the migration script-generated tool index) document `apply_event`? **YES** — the migration script in `scripts/migrate-handbook-to-vault.ts` already generates `tools/index.md`; Phase 02 adds the 4th row. Migration is idempotent (Phase 01 SUMMARY confirms), so re-running it via `pnpm migrate-handbook-to-vault` after Phase 02 ships is the operator step.

7. **`stripReasoningPreamble` interaction with `apply_event`.** The vault loop strips reasoning preambles from final text (`loop.ts:122`). `apply_event` tool results are NOT final text — they go back to the model as `tool_result` messages. Should reasoning preambles in the model's THINKING that precedes an `apply_event` call be stripped? Phase 01 already handles this for text blocks. **No change needed** — text-block stripping is orthogonal to tool dispatch.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node `node:fs/promises` | EventsWriter, projector, path resolution | ✓ | Node 20+ (builtin) | — |
| Node `node:crypto.randomUUID` | Event ID generation | ✓ | Node 20+ (builtin) | — |
| Node `node:path` | Per-campaign path resolution | ✓ | Node 20+ (builtin) | — |
| `~/.dnd-ai-master/vault/campaigns/` writable | Default VAULT_CAMPAIGNS_ROOT location | ✓ (dev machine: M5 Pro 1TB SSD; prod: M4 256GB SSD) | — | Env override to a different writable path |
| Same volume for VAULT_CAMPAIGNS_ROOT and `/tmp` | Future tmp+rename atomic writes (Phase 03+); not needed in Phase 02 | ✓ (default APFS boot volume) | — | If user sets VAULT_CAMPAIGNS_ROOT to external drive, document the constraint |
| Git CLI (for backup strategy) | `pnpm vault:backup` script | ✓ (dev machine has gh) | — | — |
| Vitest test runner | Concurrency test, projector test, schema test | ✓ | 4.1.5 [VERIFIED: package.json] | — |
| Drizzle ORM | Campaign settings JSONB read/write | ✓ | 0.45.2 [VERIFIED: package.json] | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

**M4 production SSD budget consideration:** 256GB SSD on M4 [VERIFIED: ~/.claude/projects/.../memory/project_dnd_ai_master_target_hw.md]. A year-long campaign accumulates ~2K events ≈ 200KB events.md + ~50KB view files ≈ 250KB per campaign. Five campaigns = 1.25MB. Negligible on a 256GB SSD. **No SSD-budget concern for Phase 02.** [CITED: spike 008 "Performance is not a concern" + project memory]

## Validation Architecture

> No `.planning/config.json` exists in this repo [VERIFIED: `cat .planning/config.json` failed with "no config.json"]. Per the research protocol, when the config key is absent the section is INCLUDED.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 (`"test": "vitest run"`) |
| Config file | `vitest.config.ts` (existing, Phase 01 already passes 123 tests) |
| Quick run command | `pnpm test tests/ai/master/vault/events-writer.test.ts -- --reporter=verbose` |
| Full suite command | `pnpm test` |

**Critical note inherited from Phase 01 SUMMARY:** vitest scans ONLY `tests/**/*.test.{ts,tsx}` (see `vitest.config.ts:31-40`). Colocated `src/**/*.test.ts` files are NOT picked up. ALL Phase 02 tests live under `tests/ai/master/vault/` and `tests/sessions/`. RESEARCH.md from Phase 01 §6 incorrectly suggested colocated tests work — corrected by the SUMMARY. **Phase 02 honors this — every test goes under `tests/`.** [CITED: `.planning/phases/01-vault-read-path/SUMMARY.md` line 51]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REQ-004 | events.md is source of truth — replay produces byte-exact materialized view | unit | `pnpm test tests/ai/master/vault/projector.test.ts` | ❌ Wave 0 |
| REQ-005 | EventsWriter mutex serializes 100 concurrent appends with 0 lost / 0 corrupted | unit/integration | `pnpm test tests/ai/master/vault/events-writer.test.ts` | ❌ Wave 0 |
| REQ-005 | Corrupted line in events.md aborts replay fast (no silent state divergence) | unit | `pnpm test tests/ai/master/vault/projector.test.ts -t "corruption"` | ❌ Wave 0 |
| REQ-006 | DR procedure: corrupted view restored from events.md replay = byte-for-byte original | integration | `pnpm test tests/ai/master/vault/apply-event-integration.test.ts -t "dr"` | ❌ Wave 0 |
| REQ-007 | VAULT_CAMPAIGNS_ROOT env override resolves under home when unset; under env when set | unit | `pnpm test tests/ai/master/vault/campaign-paths.test.ts` | ❌ Wave 0 |
| REQ-007 | apply_event writes ONLY under VAULT_CAMPAIGNS_ROOT, never under VAULT_ROOT | unit | `pnpm test tests/ai/master/vault/apply-event-integration.test.ts -t "campaigns-root"` | ❌ Wave 0 |
| REQ-010 | Tool surface has exactly 4 tools (read_vault_multi, list_vault, apply_event, end_turn) | unit | `pnpm test tests/ai/master/vault/phase-smoke.test.ts` | ✓ MODIFY — invert "no apply_event" assertion |
| REQ-010 | apply_event tool definition input_schema validates the 7 event types | unit | `pnpm test tests/ai/master/vault/tools.test.ts -t "apply_event"` | ✓ EXTEND existing tools.test.ts |
| Phase gate | Property test: round-trip (event → state → view → assert state derivable back from view's frontmatter) | integration | `pnpm test tests/ai/master/vault/apply-event-integration.test.ts -t "property"` | ❌ Wave 0 |
| Phase gate | Restart preserves state via events.md replay on session resume | integration | `pnpm test tests/sessions/vault-mutations-resume.test.ts` | ❌ Wave 0 |
| Phase gate | Both backends coexist: opted-in campaigns write to vault, others to Postgres | integration | `pnpm test tests/sessions/vault-mutations-gate.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test tests/ai/master/vault/` (vault-only subset, runs in ~5s)
- **Per wave merge:** `pnpm test` (full Vitest suite — Phase 01 baseline 123 tests + Phase 02 additions)
- **Phase gate:** Full suite green + manual M4 smoke (run `pnpm bench-vault-m4` on the Mac Mini with a flagged campaign) before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/ai/master/vault/events-writer.test.ts` — covers REQ-005 (concurrency)
- [ ] `tests/ai/master/vault/events-schema.test.ts` — type guard rejection cases (REQ-005 schema enforcement)
- [ ] `tests/ai/master/vault/projector.test.ts` — covers REQ-004 (replay determinism, corruption fail-fast)
- [ ] `tests/ai/master/vault/campaign-paths.test.ts` — covers REQ-007 (path resolution, env override)
- [ ] `tests/ai/master/vault/apply-event-integration.test.ts` — covers REQ-006 (DR) + REQ-007 (write location) + property test
- [ ] `tests/sessions/vault-mutations-gate.test.ts` — campaign settings flag honored by turn route
- [ ] `tests/sessions/vault-mutations-resume.test.ts` — state survives Next.js restart via replay
- [ ] **Modify** `tests/ai/master/vault/tools.test.ts` — add `apply_event` dispatch cases (validation errors, success path, missing campaignId)
- [ ] **Modify** `tests/ai/master/vault/loop.test.ts` — add apply_event branch case (tool_use → dispatch → tool_result round trip)
- [ ] **Modify** `tests/ai/master/vault/phase-smoke.test.ts` — invert the "no apply_event" assertion (Phase 02 inverts Phase 01's Phase-01-scope assertion); change `toHaveLength(3)` to `toHaveLength(4)`

Framework install: none — Vitest already covers everything.

## Security Domain

> `security_enforcement` not declared in any config — treat as enabled per protocol.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Clerk JWT validated by `auth()` from `@clerk/nextjs/server` at the turn route entry (existing — Phase 01 inherited). Phase 02 adds no new entry points. |
| V3 Session Management | yes | Clerk session + per-campaign access check (`checkPartyAccess`) — existing. Phase 02 adds no new session boundaries. |
| V4 Access Control | yes | `checkPartyAccess(userId, sessionId)` gates the turn route. `apply_event` is dispatched inside the loop; the access check has already passed. No additional auth needed because the LLM is acting on behalf of an already-authorized user. |
| V5 Input Validation | yes | `validateEvent({type, payload})` hand-rolled type guard rejects malformed payloads at the tool dispatcher boundary. `safeVaultPath()` rejects path traversal in `read_vault_multi`. The model cannot pass an arbitrary path to `apply_event` — paths are resolved server-side from `campaignId` (from context, not LLM input). |
| V6 Cryptography | yes | `crypto.randomUUID()` for event IDs — Node builtin, do not hand-roll. No additional crypto needed. Vault content is at rest unencrypted (NON-REQ-005: file permissions sufficient on personal machine). |

### Known Threat Patterns for {Node.js + filesystem + LLM tool calls}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via LLM-supplied path | Information disclosure / Tampering | `safeVaultPath()` already validates every read; `apply_event` ignores LLM-supplied paths entirely and resolves from server-side `campaignId` in context |
| Concurrent write corruption | Tampering | `EventsWriter` single-writer mutex (validated by spike 010) |
| Event payload injection (e.g., `delta: 9999999` to one-shot heal) | Tampering | Type guards enforce numeric ranges per event type. Recommendation: `hp_change.delta` is unbounded at the schema layer (the projector clamps to `[0, hp_max]`); inventory `qty` validated `> 0` and `< 1000` |
| Replay attack (re-submit a past event id) | Tampering | Each event has a `randomUUID()` ID; idempotency requires checking existing events.md for the ID before appending (spike 008 §"Idempotent event application"). Phase 02 v1 can skip this — the LLM doesn't replay events; risk is mainly retries from the turn route, which is gated by `acquireTurnLock`. |
| Event log tampering (operator hand-edits events.md) | Tampering | Out of scope (NON-REQ-005). If the operator wants to "fix" state, they emit a compensating event via the LLM, not hand-edit. Documented in the operator runbook. |
| Disk-fill DoS via runaway event emission | DoS | TURN_TOOL_CALL_CAP limits events per turn. Phase 02 raises this to 20 (Pitfall 4); operational cap is ~20 events × 200 bytes × 50 turns/day = ~200KB/day per campaign. Negligible. |
| LLM emits malicious event payload (e.g., character name `../../../etc/passwd`) | Tampering / Information disclosure | The character-name slug step strips `[^a-z0-9-]`. The resulting view file lands at `characters/etc-passwd.md` (safe — under campaign dir). No path traversal possible. |
| Cross-campaign data leakage | Information disclosure | `campaignId` from server-side context (Clerk-validated session row), NEVER from LLM input. The dispatcher resolves paths under `campaignDir(ctx.campaignId)` only. |

## Sources

### Primary (HIGH confidence)

- `.planning/REQUIREMENTS.md` — REQ-004, REQ-005, REQ-006, REQ-007, REQ-010 (all LOCKED by spike validation)
- `.planning/ROADMAP.md` — Phase 02 scope (lines 35-61)
- `.planning/STATE.md` — File does not exist [VERIFIED: Read failed]. Confirmed no project-level decision log exists separate from REQUIREMENTS/ROADMAP.
- `.planning/spikes/MANIFEST.md` — All 14 spikes with verdicts
- `.planning/spikes/WRAP-UP-SUMMARY.md` — Phase rollup with Phase 1 deliverables (lines 67-75)
- `.planning/spikes/006-frontmatter-atomicity/README.md` — INVALIDATED pattern; cautionary tale for naive rename(2) RMW
- `.planning/spikes/008-events-md-replay/README.md` — VALIDATED replay determinism + corruption fail-fast
- `.planning/spikes/008-events-md-replay/replay.ts` — Reference projector implementation
- `.planning/spikes/010-events-md-concurrency/README.md` — VALIDATED in-process Map<path, Promise> mutex
- `.planning/spikes/010-events-md-concurrency/writer.ts` — Reference EventsWriter implementation (direct lift target)
- `.planning/spikes/013-vault-backup-restore/README.md` — VALIDATED byte-exact restore via replay
- `.planning/spikes/013-vault-backup-restore/run-backup-restore.ts` — Reference DR procedure
- `.claude/skills/spike-findings-dnd-ai-master/SKILL.md` — Auto-loaded skill (project-level rules)
- `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` — Implementation blueprint for Phase 02
- `.claude/skills/spike-findings-dnd-ai-master/references/tool-surface.md` — Tool definitions reference (apply_event description verbatim)
- `.planning/phases/01-vault-read-path/SUMMARY.md` — Phase 01 outcomes, deferrals, the M5 Pro smoke baseline
- `.planning/phases/01-vault-read-path/RESEARCH.md` — Patterns Phase 01 established that Phase 02 extends
- `src/ai/master/vault/path.ts` — Phase 01 path primitives + VAULT_CAMPAIGNS_ROOT (lines 26-28)
- `src/ai/master/vault/tools.ts` — Phase 01 tool definitions + dispatchVaultTool (the extension surface)
- `src/ai/master/vault/loop.ts` — Phase 01 vault tool loop (no Phase 02 changes needed beyond passing campaignId in ctx)
- `src/ai/master/vault/prompt-builder.ts` — Phase 01 prompt builder (Phase 02 only bumps toolCount: 3 → 4 at call site)
- `src/app/api/sessions/[id]/turn/route.ts` lines 248-409 — Phase 01 vault branch in turn route
- `src/db/schema/campaigns.ts` — CampaignSettings interface (add vaultMutations field)
- `src/lib/preferences.ts` — Settings resolver (add resolveVaultMutations)
- `package.json` — Dependency manifest [VERIFIED: zod absent, vitest 4.1.5, drizzle-orm 0.45.2, next 16.2.4]
- `~/.claude/projects/-Users-alessiodanna-projects-dnd-ai-master/memory/project_dnd_ai_master_target_hw.md` — M4 target hardware (256GB SSD, 32GB RAM)

### Secondary (MEDIUM confidence)

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` — Next.js 16 route handler conventions (NOT consumed by Phase 02 — no new route handlers added)
- AGENTS.md — "This is NOT the Next.js you know" caveat (informs the "extend existing patterns, don't introduce new ones" stance)
- `CLAUDE.md` — Italian-in-chat, English-in-code convention

### Tertiary (LOW confidence)

- None. Every Phase 02 design choice maps to a validated spike or an existing Phase 01 pattern. No external WebSearch findings were used.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The validated spike-010 EventsWriter implementation works identically in the Next.js 16 server runtime without modification | §4 Pattern 1 | LOW — spike 010 was run in the same Node version family (Node 20+) used by this Next.js install; the `appendFile` + `Promise` chain is plain Node, no Next.js-specific assumptions |
| A2 | Synchronous projector regeneration adds <10ms per `apply_event` for typical campaigns (<100 events) | §4 Pattern 3 + Decision 2 | LOW — spike 008 measured ~1ms for 100 events; extrapolation to typical campaigns is linear and well within the per-turn budget |
| A3 | `crypto.randomUUID()` is sufficient for event-id uniqueness without a global counter | §6 Code Example | LOW — UUIDv4 collision probability at the per-campaign scale is mathematically negligible; spike 008 §"Idempotent event application" recommends UUIDs explicitly |
| A4 | Separate git repo backup is the right REQ-007 backup choice for the personal-machine deployment | Decision 7 | MEDIUM — depends on operator preference. If the user explicitly wants offline-only operation (no remote push), tarball+cron is preferred. Planner should confirm with the user in /gsd-discuss-phase before locking. |
| A5 | The 7 event types listed (hp_change, condition_add, condition_remove, spell_slot_use, spell_slot_restore, inventory_add, inventory_remove) cover the Phase 02 mutation surface | §6 Code Example + Decision 1 | MEDIUM — these are the spike-008-validated set + extension to inventory. Real D&D combat may need: `temp_hp_set`, `death_save_success/fail`, `concentration_break`, `attune`, `unattune`. Researcher recommends shipping the 7 in v1 and adding more in patch releases (event types are additive; adding a new type does not break existing events.md). Planner should validate the list against an actual combat-turn sample. |
| A6 | Single-write to events.md is sufficient for Phase 02 (no dual-write to Postgres for opted-in campaigns) | Open Question 3 | HIGH — this is the unresolved question. If the UI continues reading from Postgres for opted-in campaigns, the player sees stale data. The planner MUST address this. Researcher's lean is single-write + add a read-from-vault path to the UI for opted-in campaigns (small UI change), but the planner may prefer dual-write to keep the UI untouched. |
| A7 | TURN_TOOL_CALL_CAP should be raised to ~20 for vault-mutation turns | Pitfall 4 | MEDIUM — assumption based on combat-turn shape extrapolation. The actual peak count should be measured against a recorded combat session before locking the value. |
| A8 | The materialized view file naming `characters/<slug>.md` (with slug = lowercased ascii-only) is collision-free in practice | Open Question 1 | LOW — campaign characters are user-named, typically <5 per campaign; slug collisions are extremely rare. The id8 suffix is a defensive choice with no real cost. |
| A9 | M4 production target has the SSD headroom for VAULT_CAMPAIGNS_ROOT under `~/.dnd-ai-master/` | §Environment Availability | LOW — 250KB per campaign × dozens of campaigns is negligible on a 256GB SSD; project memory `project_dnd_ai_master_target_hw.md` explicitly notes SSD budget for baked variants (~14-20 GB each), making event-log usage trivial by comparison |

## Project Constraints (from CLAUDE.md)

- All chat communication with the user is in Italian. **Code, commits, file names, RESEARCH.md, PLAN.md, doc files are English.**
- AGENTS.md: "This is NOT the Next.js you know" — heed deprecation notices in `node_modules/next/dist/docs/`. Phase 02 introduces no new Next.js APIs.
- Auto-loaded skill `spike-findings-dnd-ai-master` is mandatory reading for the planner. Specifically: `references/storage-and-mutation.md` is the implementation contract for Phase 02.

## Metadata

**Confidence breakdown:**

- **EventsWriter design:** HIGH — direct lift from validated spike 010, no design ambiguity
- **Projector pattern:** HIGH — direct lift from validated spike 008, no design ambiguity
- **DR procedure:** HIGH — validated end-to-end byte-exact by spike 013
- **Path resolution under VAULT_CAMPAIGNS_ROOT:** HIGH — Phase 01 already exports the constant, env override is implemented
- **Tool surface extension (3 → 4):** HIGH — extension surface is `VAULT_TOOL_DEFINITIONS` array + `dispatchVaultTool` switch; both already exist
- **Event-type schema (TS union vs Zod):** MEDIUM — researcher recommendation; planner may swap to Zod with no impact on other decisions
- **Backup strategy choice:** MEDIUM — depends on operator preference; researcher recommends separate git repo, but user could prefer tarball
- **Coexistence semantics (dual-write vs single-write):** LOW — Open Question 3 is genuinely unresolved; needs /gsd-discuss-phase or planner judgment
- **Initial state seeding:** MEDIUM — three viable approaches (Open Question 2); researcher leans synthetic seed event
- **Materialized view collision policy:** MEDIUM — Open Question 1; defensive id8 suffix recommended

**Research date:** 2026-05-25

**Valid until:** 2026-06-24 (30 days; codebase moves slowly; spike findings are LOCKED indefinitely)
