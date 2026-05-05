# Master memory: progressive summary + structured codex

**Status**: design approved, ready for implementation plan
**Date**: 2026-05-05
**Author**: brainstormed with Claude
**Touches**: `src/sessions/`, `src/ai/master/`, `src/db/schema/`, `src/engine/tools/`, `src/app/api/sessions/[id]/turn/`, new `src/app/api/sessions/[id]/memory/`

## Problem

The master AI hallucinates and contradicts itself as a campaign grows past ~20 player↔master turns. Three patterns observed:

- **Forgets**: NPCs introduced earlier disappear; open quests are no longer mentioned; lore details fade.
- **Contradicts**: the same NPC's name/description changes; locations are re-described inconsistently; antagonist motivation drifts.
- **Invents conflicting details**: backstory added to an NPC that doesn't fit prior fiction; "discovers" things the player already discovered.

### Root cause

In `src/app/api/sessions/[id]/turn/route.ts` the master receives only the **last 20 messages** of conversation history (line 95: `.limit(20)`). Beyond that window the narrative is invisible to the model. The `EngineState` snapshot passed alongside contains only mechanical state (HP, conditions, inventory, a one-line `scene`) — no cumulative narrative memory: NPCs, locations, quests, lore, decisions are not tracked.

Campaigns observed regularly cross **500+ turns** on a single `sessions.id` row, so the gap is large.

## Goals

1. The master remains narratively consistent across a 500+ turn campaign on the same `sessions.id`.
2. No new latency on the player-facing turn (extra cost paid asynchronously).
3. Token budget per turn bounded as the campaign grows (no linear blow-up).
4. Internal: no new player-facing UI surface (banner during backfill is the only exception).
5. Existing campaigns recover memory via on-demand backfill.

## Non-goals (deferred)

- Player-facing "campaign journal" UI.
- Manual editing of the codex via UI.
- Multi-level meta-summary (today's chapters stay flat; revisit if campaigns reach 1000+ turns).
- Codex export.
- Refactor of every tool handler's signature to receive `sessionId` (only `lookup_codex` needs it; uses a dedicated pattern).

## Architecture

Three new components, isolated from the existing turn flow:

1. **Codex** — structured store of seven narrative entity kinds.
2. **Chapters** — append-only narrative summaries of fixed-size message windows.
3. **Memory extractor** — async function (via `waitUntil`) that runs after each turn, updating codex on every turn (light mode) and producing a chapter every 40 messages (full mode).

The master receives an enriched system prompt at turn time:

```
[existing base + tool contract + SRD]
[chapter digests, concatenated, all chapters in order]
[scene card: in-scene NPCs + open quests + recently mentioned entities]
[codex index: bare list of entity names per kind]
[existing character snapshot + scene]
```

Plus one new tool: `lookup_codex(kind, query)` for on-demand fetch of full entity records not in the scene card.

### Why this shape (key trade-offs already settled)

- **Hybrid summary + codex** chosen over summary-only (loses precise facts) or codex-only (loses narrative flow).
- **Async extraction** chosen over synchronous so player-facing latency is unchanged.
- **Append-only chapters** chosen over a single rolling summary so old facts don't dilute through repeated lossy compression.
- **One unified extractor** (chapter + codex patch in a single model call) chosen over two separate passes for cost and consistency.
- **Single `lookup_codex` tool** with a `kind` enum chosen over seven separate tools to keep the master's tool surface small.
- **Internal-only codex** (no player UI) chosen for MVP to ship the actual fix without UI work; rebuild button is the only escape valve.

## Data model

### `session_chapters` (new table)

```
id              uuid PK
session_id      uuid FK → sessions(id) ON DELETE CASCADE
chapter_index   integer (0-based, sequential per session)
first_msg_id    uuid FK → session_messages(id)
last_msg_id     uuid FK → session_messages(id)
message_count   integer
summary         text                         -- ~250 token narrative digest
created_at      timestamptz
INDEX (session_id, chapter_index)
UNIQUE (session_id, chapter_index)
```

A chapter covers exactly 40 consecutive non-OOC messages. Chapters are produced sequentially: chapter `N` starts immediately after chapter `N-1`'s `last_msg_id`.

### `codex_entities` (new table)

Single discriminated table for the seven kinds:

```
id               uuid PK
session_id       uuid FK → sessions(id) ON DELETE CASCADE
kind             enum: 'npc'|'location'|'quest'|'faction'|'lore_fact'|'named_item'|'relationship'
slug             text                  -- normalized (lowercase, dashed) for dedup/lookup
name             text                  -- canonical visible form
data             jsonb                 -- payload typed per kind
last_seen_msg_id uuid FK → session_messages(id) NULL
created_at       timestamptz
updated_at       timestamptz
INDEX (session_id, kind)
INDEX (session_id, last_seen_msg_id)
UNIQUE (session_id, kind, slug)
```

Per-kind payload schemas (TypeScript discriminated union, validated in `applyPatch`):

```ts
type CodexNpc          = { description: string; status: 'alive'|'dead'|'unknown'; disposition: 'ally'|'neutral'|'hostile'|'unknown'; tags: string[] }
type CodexLocation     = { description: string; region?: string; tags: string[] }
type CodexQuest        = { description: string; status: 'open'|'completed'|'failed'|'abandoned'; giver_slug?: string }
type CodexFaction      = { description: string; pc_relation: 'ally'|'neutral'|'hostile'|'unknown' }
type CodexLoreFact     = { statement: string; tags: string[] }
type CodexNamedItem    = { description: string; holder_slug?: string; magical: boolean }
type CodexRelationship = { from_slug: string; to_slug: string; nature: string }
```

`session_messages` is unchanged. The existing `cacheBreakpoint` boolean on it is left alone (intended for prompt-cache use; different semantic).

## Memory extractor

New module `src/sessions/memory/`:

- `extractor.ts` — orchestrator
- `prompt.ts` — extractor's dedicated system prompt (versioned)
- `patch.ts` — deterministic `applyPatch(sessionId, patch)`: upserts entities by `(session_id, kind, slug)`, inserts chapter row in a single transaction
- `types.ts` — extractor patch type

### Trigger

In `src/app/api/sessions/[id]/turn/route.ts`, after the master message is persisted (step 6), add:

```ts
waitUntil(extractMemory(sessionId));
```

The extractor's failure does not propagate to the response.

### Modes

**Light (every turn)**
- Input: latest player message + master message + compact codex digest.
- Output JSON: `{ codexPatch: EntityPatch[] }`.
- Purpose: capture entities introduced just now so the next turn already has them.

**Full (every 40 non-OOC messages)**
- Input: the 40 messages of the new chapter + compact codex digest + previous chapters' summaries (concatenated).
- Output JSON: `{ chapterSummary: string, codexPatch: EntityPatch[] }`.
- Purpose: produce the chapter row + a richer codex update consolidated across the chapter.

The extractor decides which mode by counting non-OOC messages since the last chapter's `last_msg_id`. If the count reaches the chapter size, it does Full; otherwise Light.

### Provider/model

Extractor uses the same `MasterProvider` interface as the master. Configurable via env (e.g. `MEMORY_EXTRACTOR_MODEL`); default: a smaller/cheaper model than the master (e.g. Haiku 4.5).

### Concurrency

Extractor acquires `pg_try_advisory_lock(hashtext(sessionId))` at start. If not acquired, it returns silently — another extractor is processing the same session, and the next turn's trigger will catch up if needed.

### OOC filter

Messages whose content starts with `!` are excluded from chapter ranges and from extractor input — they are meta-game (rules questions, recap requests) and do not produce codex updates. Consistent with the OOC convention in commit `7b26f4b`.

### Failure modes

- Rate limit / timeout: log; no throw. Next turn re-attempts. The set of "messages pending extraction" is recomputed from the DB each time, so retries are safe.
- Malformed JSON output: log; no patch applied. Next turn re-attempts.
- Patch apply fails (DB error): transaction rolls back; log; no partial state.

### Cost (rough)

- Light: ~1k input + ~300 output token on cheap model ≈ $0.001-0.005 per turn.
- Full: input grows with chapter count (40 messages ≈ 4-12k tokens + codex digest ~1k + previous-chapter summaries at ~250 tokens each); ~600 output. Roughly $0.01-0.03 per chapter early, up to ~$0.05 by chapter 15. One chapter is produced every 40 non-OOC messages (≈ every 20 turns).

## Master prompt augmentation

### `loadMemoryContext(sessionId, sceneText)` (new helper)

Returns:

```ts
type MemoryContext = {
  chapterDigests: string;   // all chapter summaries concatenated, in chronological order, with index headers
  sceneCard: string;        // compact card of in-scene entities (see selection logic below)
  codexIndex: string;       // bare-name index per kind: "npcs: [Aldric, Vex, Mira]\nlocations: [...]\n..."
};
```

### Scene card selection

Deterministic logic (no model call) to pick which entities to surface:

1. All entities with `last_seen_msg_id` in the last 5 messages.
2. All `quest` rows with `status = 'open'`.
3. All entities whose `name` or `slug` appears as a case-insensitive substring of the current `scene` text or the latest player message.
4. Dedup; cap at 15 entries (keep most recently seen by `last_seen_msg_id`).

### `buildMasterSystemPrompt` change

Adds three blocks to the existing system blocks, in order:

1. `chapterDigests` — `cache_control: ephemeral` (stable within a turn, prefix-cacheable).
2. `sceneCard` — no cache (turn-specific).
3. `codexIndex` — no cache (turn-specific).

History limit stays at 20 messages — chapter digests cover anything older.

### `MASTER_TOOL_CONTRACT` update

Adds a "Memory tools" section explaining when to call `lookup_codex` ("an entity is referenced in the chat that is not visible in the scene card") and when not to ("the entity is in the scene card; just use that"). Reinforces that the master must NOT invent or contradict facts that are in the codex.

## New tool: `lookup_codex`

Read-only. Pattern matches existing `lookup_rule` / `lookup_monster`.

```ts
{
  name: 'lookup_codex',
  description: 'Look up an entity in the campaign codex by kind + name. Use when the player references an NPC, location, quest, faction, item, or piece of lore that may have been established earlier and is not visible in the current scene card. Returns the entity record(s) or empty array.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['npc','location','quest','faction','lore_fact','named_item','relationship'] },
      query: { type: 'string', description: 'Name or slug. Fuzzy: case-insensitive substring on slug and name.' }
    },
    required: ['kind', 'query']
  }
}
```

### Handler

`src/engine/tools/lookup-codex.ts`. Query:

```sql
SELECT * FROM codex_entities
WHERE session_id = $1
  AND kind = $2
  AND (slug ILIKE '%' || $3 || '%' OR name ILIKE '%' || $3 || '%')
ORDER BY last_seen_msg_id DESC NULLS LAST
LIMIT 5
```

Returns up to 5 matches. Tool result is JSON serialized, max 2KB; if larger, truncated with `truncated: true` flag.

### Architectural exception: db-aware tool handlers

Existing `TOOL_HANDLERS` is `(state: EngineState, input) => ActionResult` — pure, no DB. `lookup_codex` needs `sessionId` + `db`.

Solution: add a parallel registry `TOOL_HANDLERS_DB: Record<string, (state, input, ctx: { sessionId, db }) => Promise<ActionResult>>` in `src/engine/tools/index.ts`. In `runToolLoop`, look up `TOOL_HANDLERS` first (sync, pure); fall through to `TOOL_HANDLERS_DB` (async, db-aware). Only `lookup_codex` lives in the new registry. No existing handler signatures change.

`runToolLoop` accepts an optional `db` and `sessionId` already in input — pass them through to `TOOL_HANDLERS_DB` calls.

### Tool registration

`buildToolDefinitions` exposes `lookup_codex` always, regardless of `inCombat`. It is always relevant.

## Backfill (existing campaigns)

### Endpoint: `POST /api/sessions/[id]/memory/rebuild`

Idempotent. Streams progress as SSE.

Flow:
1. Acquire `pg_try_advisory_lock(hashtext(sessionId))` — if held, return `409 conflict`.
2. Delete `session_chapters` and `codex_entities` for this session.
3. Iterate the message history in chunks of 40 non-OOC messages, calling the extractor in Full mode for each chunk.
4. Stream events: `event: chapter_done\ndata: { index: N, total: M }`. Final event: `event: complete`.

### Status endpoint: `GET /api/sessions/[id]/memory/status`

Returns:

```ts
{
  messageCount: number;       // non-OOC
  chapterCount: number;
  needsBackfill: boolean;     // true if messageCount >= 40 && chapterCount == 0
}
```

### Auto-trigger on first session open

Client calls `/memory/status` when opening a session. If `needsBackfill: true`:
- Show banner above chat: "Memoria della campagna in costruzione… X/Y capitoli".
- Disable the chat input.
- Connect to `/memory/rebuild` SSE; update banner with progress.
- On `complete` event, dismiss banner, re-enable input.

### Manual rebuild

Same `POST /memory/rebuild` endpoint. Surfaced in session settings as a button "Ricostruisci memoria" with confirm dialog. Reuses the same banner UI for progress.

## Edge cases

- **Player corrects the master in chat** ("no, Aldric is dead"): the next turn's Light extraction reads the correction and updates `npc.status = 'dead'`. Master sees the new state on the following turn.
- **Sessions with `deletedAt` set**: cascades clean up codex + chapters.
- **OOC messages**: filtered out of chapter ranges and extractor input. Do not increment toward the chapter threshold.
- **Multi-language campaigns**: extractor prompt mentions `session.language`; chapter summary and codex `data` text are produced in that language.
- **Concurrent rebuild + turn**: advisory lock prevents both. Turn loses the lock contest → its `extractMemory` exits silently; rebuild continues to completion. Player turn isn't blocked because lock is on extractor only.
- **Master invokes `lookup_codex` with an unknown kind**: schema validation rejects → tool returns error string → master adapts narration (existing pattern).
- **Session ENDED**: no extractor runs (no turns); rebuild endpoint still works if the player wants to retroactively build memory before a recap.

## Testing

### Unit (`vitest`)

- `extractor.ts`: with a fake provider that returns canned JSON, verify Light mode produces only codex patch; Full mode produces summary + patch; OOC messages are filtered.
- `patch.ts`: idempotent on re-application; correctly upserts by `(session_id, kind, slug)`; transaction rollback on payload-shape mismatch.
- `loadMemoryContext.ts`: scene-card selection logic for each of the four selection rules; cap at 15.
- `lookup-codex` handler: fuzzy match on slug and name; truncation at 2KB; ordering by `last_seen_msg_id`.

### Integration (`vitest`)

- `POST /memory/rebuild`: lock acquisition; idempotency on re-call; deletes existing rows; SSE event sequence.
- `GET /memory/status`: `needsBackfill` flag for various message/chapter counts.
- Turn route: after `db.insert(sessionMessages)` of the master message, `extractMemory` is called (mocked).

### E2E (`playwright`)

- Fresh session, 5 turns: no chapter rows, codex populated incrementally; asking "who was X?" works without `lookup_codex` (X is in scene card).
- Fixture session with 80 messages preloaded: trigger backfill via auto-banner, observe 2 chapters created and codex populated; subsequent turn, master correctly references an NPC introduced in chapter 0.
- Manual rebuild button in settings: clears existing memory, re-runs.

## Migrations

- New drizzle migration generated via `pnpm db:generate`.
- Adds `session_chapters` and `codex_entities` tables + the new enum values.
- Backfilled existing campaigns get an empty memory until the player triggers rebuild.

## Open questions for implementation

- Exact extractor prompt wording — drafted in implementation, validated against a real campaign.
- Final chapter size constant: `40` is the start, may tune to 30 or 50 after measuring.
- `MEMORY_EXTRACTOR_MODEL` env default per provider.
- Exact format of `chapterDigests` block (header per chapter? bullet-style? plain prose?). Try a header per chapter (`## Chapter 3 (turns 81-120)\n<summary>`) for navigability.
