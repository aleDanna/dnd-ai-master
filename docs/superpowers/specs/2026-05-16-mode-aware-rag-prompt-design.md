# Local Provider Token Floor — Mode-Aware Prompt + RAG (Plan E)

**Status:** Draft · **Date:** 2026-05-16 · **Author:** alessio.danna.94@gmail.com
**Builds on:** [2026-05-16-local-ai-provider-design.md](./2026-05-16-local-ai-provider-design.md), [2026-05-16-local-tools-contextual-subset-design.md](./2026-05-16-local-tools-contextual-subset-design.md) (Plan B + C), Plan D (baked Modelfile, in `feat/local-meta-tools`)

## Goals

Push the local-provider context-window requirement low enough that **3–4B and 7–8B class models become viable** for full D&D sessions, without sacrificing rules coverage or narrative quality.

Two complementary, layered optimizations on top of Plan B/C/D:

1. **Plan E.1 — Mode-aware prompt**: split the SRD/rules into three swappable **mode blocks** (`combat`, `exploration`, `narrative`), plus a conditional `spellcasting` overlay. The mode is derived deterministically from `EngineState.combat` + `state.travel?.pace`. Only the relevant block ships per turn.
2. **Plan E.2 — RAG retrieval**: move `master_world_lore.md` (full) and `master_handbook.md` (full) out of the baked Modelfile into a **pgvector index**, retrieved per-turn as top-K=3 chunks via `nomic-embed-text` embeddings. Falls back to in-memory if pgvector unavailable, and to "no RAG" if the embedder is offline.

### Target floors (post-Plan E vs current B+C+D)

| Mode | Baked (in Modelfile) | Wire/turn | Total context | vs B+C+D |
|---|---:|---:|---:|---|
| Narrative | ~6.9K | ~1.7K | **~8.6K** | from ~15K (-43%) |
| Exploration | ~6.9K | ~1.7K | **~8.6K** | from ~15K (-43%) |
| Combat | ~6.9K | ~1.7K | **~8.6K** | from ~15K (-43%) |
| Combat + spellcasting | ~6.9K | ~2.3K | **~9.2K** | from ~15K (-39%) |

(Detailed breakdown in the Appendix.)

### Model coverage matrix

| Native context | Coverage | Examples |
|---:|---|---|
| 4K | ❌ Out of scope (Phase 3 if ever needed) | phi-3-mini-4k |
| 8K | ✅ Narrative/exploration ample; combat tight | gemma:7b, mistral-7b |
| 16K+ | ✅ All modes with margin | qwen3:7b, llama3.1:8b |
| 32K+ | ✅ Ample margin everywhere | qwen3:4b, llama3.2:3b, qwen3:30b |

### Memory targets (VRAM)

The `num_ctx` parameter controls KV cache allocation. Recommended profiles:

| Model class | num_ctx | RAM est. |
|---|---:|---:|
| 3-4B | 8K | ~4 GB |
| 7-8B | 16K | ~10 GB |
| 13B+ | model native | discretion |

(Note: prior `num_ctx` tuning attempt was rolled back in `42e35d1` because it broke output generation. This design re-enables it conservatively, but only after telemetry confirms the prompt fits within the new ceiling.)

## Non-goals

- ❌ Touch cloud provider behaviour — Anthropic/OpenAI/Gemini stay on full prompts + 72 flat tools.
- ❌ Refactor the game engine's tool handlers. Mode-awareness lives in the prompt builder, not in the engine.
- ❌ Mid-turn mode hot-swap. The mode is derived at turn-build time; transitions take effect on the **next** turn.
- ❌ Chunk the SRD into RAG. SRD stays as a single compact block baked into the Modelfile. (User-validated trade-off: keep SRD intact for reliability, only handbook/lore go to RAG.)
- ❌ Support phi-3-mini-4k or other 4K-native models. Out of scope.
- ❌ Multi-language RAG corpus. The handbook/lore are language-pinned at index build time.
- ❌ Streaming responses or speculative decoding. Orthogonal optimizations, deferred.

## Architecture

### Mode derivation

A single deterministic function reads `EngineState` and returns the active mode. No new enum is introduced into the engine; mode is a **prompt-layer concept**.

```ts
// src/ai/master/mode.ts
export type MasterMode = 'combat' | 'exploration' | 'narrative';

export function deriveMode(state: EngineState): MasterMode {
  if (state.combat !== null) return 'combat';
  if (state.travel?.pace !== undefined) return 'exploration';
  return 'narrative';
}

export function needsSpellcastingOverlay(snapshot: SnapshotForModel): boolean {
  const pc = snapshot.party.find(c => c.id === snapshot.currentPlayerCharacterId);
  return pc?.spellcasting != null;
}
```

**Rationale**:
- `state.combat` (`/src/engine/types.ts:678`) is the only existing source of truth for "in combat / out of combat". A `null` value means narrative or exploration.
- `state.travel?.pace` (`/src/engine/types.ts:686`) is an optional overlay; when present, the party is travelling and `exploration` mode is appropriate.
- Rest is **event-driven, not a mode**: `short_rest` / `long_rest` are atomic tool calls. No mode switch needed.

### System prompt composition

The new ordering of blocks, optimized for KV-cache stability:

```
[BAKED in Modelfile — Plan D, sempre cacheable]              ~6.7K tok
  ├ MASTER_SYSTEM_PROMPT_BASE (slim)                         ~2.0K
  ├ MASTER_TOOL_CONTRACT / META_TOOLS_INSTRUCTION (slim)     ~0.8K
  ├ MASTER_REWARDS_MANDATE (slim)                            ~0.5K
  ├ MASTER_MEMORY_TOOL_RULE (slim)                           ~0.2K
  ├ MASTER_HANDBOOK_ULTRA_SLIM                               ~0.4K
  └ SRD_CONTEXT_COMPACT (intact, per user decision)          ~3.0K
  → NOT baked: MASTER_WORLD_LORE (moved to RAG)
  → NOT baked: MASTER_HANDBOOK full (moved to RAG)
  → NOT baked: ROLL_TRIGGERS standalone (absorbed into mode blocks)

[WIRE per turn]                                              ~1.6-3.0K
  ├ MODE_BLOCK[mode]                                         ~400 (per mode)
  │   ├ combat: tactical priming + reaction priorities
  │   ├ exploration: travel/vision/perception priorities
  │   └ narrative: NPC tone + scene framing + COMBAT_INITIATION sub-block
  ├ SPELLCASTING_OVERLAY (if needsSpellcastingOverlay)       ~600
  ├ RAG_CHUNKS (top-K=3, dedupe by section_path)             ~400-800
  └ DYNAMIC_BLOCKS                                            ~800
      ├ scene card
      ├ snapshot (character JSON)
      ├ memory recap
      └ codex index

[user message preamble with current state — cache-hit pattern from c7eec4a]
```

**KV-cache stability**:
- Baked block is always cached (first prompt processing only).
- `MODE_BLOCK` is stable across same-mode turns → cache hit until mode transition (estimated 3-5 turns).
- `SPELLCASTING_OVERLAY` is stable while the active spellcaster PC stays current.
- `RAG_CHUNKS` and `DYNAMIC_BLOCKS` change every turn (cache miss expected here, small cost).
- State-in-last-user-message pattern (commit `c7eec4a`) is preserved.

### Mode blocks — content sketch

Each block is concise (~400 tok) because the full rules sections live in the baked SRD. The mode block provides **tactical priming** and **mode-specific reminders**, not rule duplication.

#### MODE_COMBAT (~400 tok)
```
You are running an active combat encounter.

PRIORITIES:
- Track initiative order; announce current actor each turn.
- Resolve opportunity attacks on movement out of threatened squares.
- Check concentration on damage to spellcasters (DC = max(10, damage/2)).
- Apply reactions before turn end.
- After damage: if HP<=0 for PC, prompt death save next turn.

TURN ECONOMY: action, bonus action, reaction, movement, free interaction.
COMBAT RULES IN BAKED SRD: use as authoritative reference. Use lookup_codex
for monster stat blocks or specific spell effects not in your current context.
```

#### MODE_NARRATIVE (~400 tok)
```
You are running a narrative scene (out of combat, no active travel).

PRIORITIES:
- Establish scene: place, time, mood, present NPCs.
- For social interactions: roleplay first, request Insight/Persuasion/etc.
  only when the outcome is uncertain. Default DCs: easy 10, medium 15, hard 20.
- Use scene card entities to maintain continuity.
- Award XP at scene end if it served a quest milestone (REWARDS_MANDATE in baked).

COMBAT INITIATION (sub-block):
  If you describe an ambush, hostile encounter, or aggression that will lead
  to combat:
    1. FIRST call combat_action.initiative with the combatants.
    2. THEN narrate the opening of the fight.
  Do NOT narrate combat actions without initiative rolled.
```

#### MODE_EXPLORATION (~400 tok)
```
You are running travel/exploration (state.travel.pace is set).

PRIORITIES:
- Honor the chosen travel pace (Fast/Normal/Slow) for stealth, perception,
  and forced march checks.
- Track marching order for surprise rounds.
- Apply vision/light effects (bright/dim/dark) on perception DC.
- Forced march beyond 8h: CON save DC 10 + 1 per extra hour, fail = 1 exhaustion.

TRANSITIONS:
- Random encounter / planned encounter → see COMBAT INITIATION (narrative block).
- End of travel leg → environment_action.set_travel_pace with pace=None or
  describe arrival without further travel tool calls.
```

#### SPELLCASTING_OVERLAY (~600 tok, conditional)
```
The active PC is a spellcaster.

SLOT MECHANICS:
- spell_action.cast_spell consumes a slot of the cast level.
- Cantrips: no slot, scale by character level (1-4: base, 5-10: 2x, etc.).
- Long rest: all slots restored. Short rest: only warlock pact slots + 
  features marked "regains on short rest".

CONCENTRATION:
- Only one concentration spell at a time.
- Take damage → DC = max(10, damage/2) CON save, fail = drop concentration.
- Cast a new concentration spell → previous one drops automatically.

COMPONENTS:
- V/S/M check available. Material components with cost are consumed; otherwise
  a focus or component pouch satisfies M.

RESOLUTION:
- Spell attack rolls: use spellcasting modifier + proficiency.
- Save spells: DC = 8 + spellcasting mod + proficiency.
- Healing: cap at hpMax. Reductive damage (necrotic to undead heal) is rare,
  flag explicitly.
```

### RAG infrastructure

#### Embedder
- Model: `nomic-embed-text` via Ollama `/api/embeddings`.
- Dimensions: 768.
- ~80 MB download, runs on same Ollama instance as the master LLM.
- Health-checked in `src/lib/local-services.ts` alongside other local services.

#### Vector store
- **Primary**: Postgres with pgvector extension (drizzle migration).
- **Fallback**: in-memory `Float32Array` rebuild on every server start (degraded, logs warning).

```sql
-- drizzle/0032_rag_vector.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_chunks (
  id           SERIAL PRIMARY KEY,
  source       TEXT NOT NULL,           -- 'handbook' | 'lore'
  section_path TEXT NOT NULL,           -- e.g. 'Pacing > Combat tempo'
  content      TEXT NOT NULL,
  embedding    vector(768) NOT NULL,
  source_hash  TEXT NOT NULL,           -- SHA of source file at index time
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX rag_chunks_embedding_idx ON rag_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX rag_chunks_source_hash_idx ON rag_chunks (source_hash);
```

If `CREATE EXTENSION vector` fails at migration time (host without pgvector), the migration logs a warning and the runtime falls back to the in-memory store. The schema migration for `rag_chunks` is conditional on extension availability.

#### Indicizzazione
- Trigger: first server start, or on file hash change (handbook.md, lore.md).
- Script: `scripts/build-rag-index.ts`.
- Chunking strategy (markdown-aware):
  - Split on H2/H3 headings.
  - Max chunk size: 300 tokens.
  - Overlap: 50 tokens.
  - Metadata: source file, section path (heading breadcrumb).
- Indexing time: ~10-30s for ~50KB handbook + lore (one-time, blocking with loading UI on first call).

#### Query
- Input: concatenation of last 2 user messages + last master message.
- Embed via `nomic-embed-text`.
- Top-K=3 chunks via `embedding <=> $query` (cosine distance).
- Dedupe by section_path (avoid 3 chunks from the same H2 heading).
- Result formatted as:

```
[RELEVANT CONTEXT FROM HANDBOOK/LORE]
[handbook > Pacing > Combat tempo]
<chunk content>

[lore > Magic Systems > Divine magic]
<chunk content>
```

### Baked content slim — what changes

`scripts/build-local-models.ts` is updated to bake a slimmer SYSTEM block:

| Block | Before (B+C+D) | After (Plan E) |
|---|---|---|
| MASTER_SYSTEM_PROMPT_BASE | full (~3.5K) | **slim (~2.0K)** — drop verbose tool contract preamble, drop guidance level descriptions |
| MASTER_TOOL_CONTRACT / META_TOOLS | meta variant (~1.2K) | **slim meta (~0.8K)** — drop per-subaction examples, keep enum lists |
| MASTER_HANDBOOK | compact (~1.5K) | **ultra-slim (~0.4K)** — pacing rules + turn discipline only, rest via RAG |
| MASTER_WORLD_LORE | compact (~1K) | **dropped (0)** — fully via RAG |
| MASTER_ROLL_TRIGGERS | full (~0.8K) | **dropped (0)** — absorbed into mode blocks |
| MASTER_REWARDS_MANDATE | full (~1.5K) | **slim (~0.5K)** — keep "always reward" rule, drop examples |
| MASTER_MEMORY_TOOL_RULE | full (~0.8K) | **slim (~0.2K)** — keep "scene card priority over lookup", drop codex index description (now derived from snapshot) |
| SRD_CONTEXT_COMPACT | compact (~3K) | **unchanged** — per user decision, kept intact |
| **Total baked** | **~12.3K** | **~6.9K** (-44%) |

The bake hash now includes a manifest of which blocks are included, so changing the slim variants triggers a re-bake.

### Settings UI

A new "Local optimization" card (or extension to the existing card from Plan C) in campaign Settings, visible only when `aiProvider === 'local'`:

```
┌─ Local optimization ─────────────────────────────────┐
│                                                       │
│  [x] Use compact prompt              (Plan C)         │
│  [x] Use mode-aware prompt           (Plan E.1)       │
│  [x] Use RAG context retrieval       (Plan E.2)       │
│                                                       │
│  RAG status:                                          │
│    Index:    ✓ built (handbook + lore, 247 chunks)    │
│    Embedder: ✓ online (nomic-embed-text)              │
│                                                       │
│  [Rebuild RAG index]                                  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Defaults:
- `useModeAwarePrompt`: `undefined` → resolves to `aiProvider === 'local'`.
- `useRagRetrieval`: `undefined` → resolves to `aiProvider === 'local' && embedderOnline && (pgvectorAvailable || inMemoryFallbackEnabled)`.

Both flags are read at turn-build time; toggle takes effect on the next turn.

## Edge cases & resilience

### Mode transitions

| From → To | Trigger | Handling |
|---|---|---|
| narrative → combat | `combat_action.initiative` called | Current turn is still narrative (the ambush narration). Next turn sees `MODE_COMBAT`. Narrative block contains `COMBAT_INITIATION` sub-block to guide the transition. |
| combat → narrative | `combat_action.end_combat` clears `state.combat` | Trivial. Next turn sees `MODE_NARRATIVE`. |
| narrative → exploration | `environment_action.set_travel_pace` with pace | Trivial. |
| exploration → combat | Ambush en route | Combat wins (`state.combat !== null` overrides). Travel info accessible via scene card / snapshot. |
| any → rest | `rest_action.short_rest` / `rest_action.long_rest` | Rest is an event, not a mode. Mode does NOT change. Rest tool resolves atomically. |

### RAG failure modes

| Failure | Behaviour |
|---|---|
| Chunk miss (no relevant chunk) | Model sees MODE + baked only. `lookup_codex` (existing tool, `/src/engine/tools/lookup-codex.ts`) provides on-demand fallback for named entities. Last resort: model's generic D&D 5e training knowledge. |
| Embedder offline | Detected at startup ping (`/api/embeddings` health check). Wire prompt skips RAG block. Settings UI shows "Embedder: ✗ offline" badge. Log warning. |
| pgvector unavailable | Runtime detects on first query (`SELECT 1 FROM rag_chunks LIMIT 0`). Falls back to in-memory `Float32Array` store, rebuilds on each server start (blocking, ~10s). Log warning. |
| First startup, no index | Blocking index build with loading UI: "Indicizzazione corpus AI (one-time, ~10-30s)". Subsequent starts are instant. |
| Source files changed | SHA hash mismatch triggers re-index at next boot. Same pattern as Plan D bake hash. |
| Embedder + pgvector both KO | Full graceful degradation: provider works without RAG, mode-aware still active. Effectively Plan B+C+D + mode blocks. |

### Spellcasting edge cases

- **Multi-PC party with mixed casters**: overlay activates based on `currentPlayerCharacterId` only. Non-caster PC turn → no overlay (saves ~600 tok). Switch active PC → next turn re-evaluates.
- **Multiclass with caster + non-caster levels**: snapshot.character.spellcasting is set if any class grants it. Overlay activates.
- **Caster without slots remaining**: overlay still shown (cantrips still relevant; ritual casting still relevant; descriptive flavour still relevant).

### Cache invalidation cost

Mode transitions force a partial KV-cache miss on the next turn. Estimated cost:
- 1 turn slower at each transition (~+2s on warm Ollama).
- Typical session: 5-15 transitions over 100+ turns → <5% turns affected.
- Acceptable trade-off vs. context floor reduction.

## Implementation surface

### Files to create

| Path | Purpose |
|---|---|
| `src/ai/master/mode.ts` | `deriveMode(state)`, `needsSpellcastingOverlay(snapshot)`, types |
| `src/ai/master/mode-blocks/combat.ts` | `MODE_COMBAT_BLOCK` constant + version hash |
| `src/ai/master/mode-blocks/narrative.ts` | `MODE_NARRATIVE_BLOCK` constant (includes COMBAT_INITIATION sub-block) |
| `src/ai/master/mode-blocks/exploration.ts` | `MODE_EXPLORATION_BLOCK` constant |
| `src/ai/master/mode-blocks/spellcasting-overlay.ts` | `SPELLCASTING_OVERLAY_BLOCK` constant |
| `src/ai/master/rag/chunker.ts` | Markdown-aware chunking (H2/H3 split, max 300 tok, overlap 50) |
| `src/ai/master/rag/embedder.ts` | Ollama `/api/embeddings` wrapper, health check |
| `src/ai/master/rag/indexer.ts` | Build/refresh index, hash-based invalidation |
| `src/ai/master/rag/retriever.ts` | Query top-K=3, dedupe by section_path, graceful fallback |
| `src/ai/master/rag/fallback-memory-store.ts` | In-memory `Float32Array` store, used if pgvector unavailable |
| `src/db/schema/rag-chunks.ts` | Drizzle schema for `rag_chunks` table |
| `drizzle/0032_rag_vector.sql` | Migration: `CREATE EXTENSION vector` + table + ivfflat index |
| `scripts/build-rag-index.ts` | CLI for first-time or manual index rebuild |
| `tests/ai/master/mode.test.ts` | Unit tests for `deriveMode`, `needsSpellcastingOverlay` |
| `tests/ai/master/mode-blocks.test.ts` | Snapshot tests for each mode block + assembly |
| `tests/ai/master/rag/chunker.test.ts` | Markdown chunking unit tests |
| `tests/ai/master/rag/retriever.test.ts` | RAG query, dedupe, fallback tests |
| `tests/ai/master/system-prompt.mode.test.ts` | Integration: prompt assembly per mode + token budget |

### Files to modify

| Path | Changes |
|---|---|
| `src/ai/master/system-prompt.ts` | Inject `MODE_BLOCK + SPELLCASTING_OVERLAY + RAG_CHUNKS + DYNAMIC` in the new cache-friendly order. Add inputs: `mode`, `ragChunks`, `needsSpellcasting`. |
| `src/ai/provider/local.ts` | Derive mode from state, fetch RAG chunks (async, parallel with snapshot build), pass to builder. Skip RAG if disabled or offline. |
| `scripts/build-local-models.ts` | Bake slim manifest: slim BASE, slim TOOL_CONTRACT, ultra-slim HANDBOOK, drop WORLD_LORE, drop ROLL_TRIGGERS, slim REWARDS_MANDATE, slim MEMORY_TOOL_RULE, keep SRD_COMPACT. Update bake-hash to include manifest. |
| `src/lib/local-services.ts` | Add health check for `nomic-embed-text` model. Surface in status payload. |
| `src/db/schema/index.ts` | Export new `rag_chunks` table. |
| `src/components/Settings/LocalOptimizationCard.tsx` (or equivalent) | Add 2 new toggles + RAG status panel + Rebuild button. |
| `src/ai/master/usage.ts` | Extend telemetry: `mode`, `ragChunkCount`, `ragChunkBytes`, `needsSpellcasting`, `promptEvalCount`, `cacheHit` proxy. |
| `README.md` and/or `docs/local-ai/README.md` | Document Plan E setup: pgvector install, embedder model, first-time index build. |

## Testing strategy

### Unit
- `deriveMode(state)` for each branch: combat / travel / neither.
- `needsSpellcastingOverlay(snapshot)` for spellcaster / non-spellcaster / multiclass.
- `chunker`: markdown splits on H2/H3, respects max size, applies overlap.
- `embedder`: mock Ollama, handles errors, returns vector(768).
- `retriever`: top-K limit, dedupe by section, falls back to empty on missing service.

### Snapshot
- `buildMasterSystemPrompt({ mode: 'combat', ... })` includes combat block, excludes narrative/exploration blocks.
- Same for `narrative` and `exploration`. Assert presence/absence.
- Spellcasting overlay appears only when flag is true.

### Token budget regression (CI gate)
For each (mode, spellcasting?) tuple, assert:
```
tokenCount(assembledPrompt) <= BUDGET[mode] + tolerance
```
Where BUDGET values match the floor targets in the Goals section. Failing this test gates CI.

### Mode transitions
- Fixture: state pre-`combat_action.initiative` (combat=null) → prompt has narrative block. Apply mutation → prompt has combat block. Apply `end_combat` → narrative again.
- Fixture: state with `travel.pace` set → exploration. Set combat → combat (combat wins). Clear combat → exploration again.

### RAG recall
- Fixture queries:
  - "come funziona la concentrazione" → top-3 must include Concentration chunk.
  - "regole su riposo lungo" → top-3 must include Long Rest chunk.
  - "deità del pantheon principale" → top-3 must include relevant lore chunk.
- Threshold: cosine distance < 0.4 for at least 1 of top-3 (tuned via fixture run).

### RAG resilience
- Mock embedder down → wire prompt assembled without RAG block, warning logged.
- Mock pgvector unavailable → in-memory store activated, queries succeed.
- Both down → mode-aware prompt still works, no RAG block.

### Integration with Ollama (opt-in)
- Tag: `OLLAMA_INTEGRATION=1`.
- Real call with mock model (smallest available, e.g. `qwen3:0.5b` for CI cost).
- Verify `prompt_eval_count` < expected budget per mode.

### E2E session
- Scripted session: start narrative → social scene → combat (ambush) → 3 rounds → end_combat → travel → long_rest.
- Assert mode transitions and token budget at each step.
- Assert no regression in tool call sequences vs. cloud-provider baseline.

## Telemetry

Extend `src/ai/master/usage.ts` to log per turn:

```ts
{
  sessionId: string;
  turnId: string;
  model: string;            // e.g. 'qwen3:7b-baked'
  mode: 'combat' | 'exploration' | 'narrative';
  needsSpellcasting: boolean;

  promptEvalCount: number;  // from Ollama response
  evalCount: number;        // output tokens
  totalDuration: number;    // ns from Ollama

  ragEnabled: boolean;
  ragChunkCount: number;
  ragChunkBytes: number;
  ragSourceHash: string;    // current index hash

  cacheHit: boolean;        // heuristic: promptEvalCount < 500 means prefix cache held
  durationMs: number;
}
```

Dashboard targets (post-deploy):
- Median `promptEvalCount` per (mode, model) tuple.
- % cache hit (heuristic).
- % RAG miss (defined as chunks count == 0 when ragEnabled).
- p95 `durationMs` per (mode, model).

These metrics validate the floor predictions and surface regressions early.

## Phasing — incremental rollout

Three independently shippable steps. Each ends with a measurable success criterion.

### Step 1 — Mode-aware only (no RAG yet)
**Scope**: `deriveMode`, 4 mode blocks, system-prompt rewiring, slim baked manifest.
**Files**: mode.ts, mode-blocks/*, system-prompt.ts changes, build-local-models.ts changes, Settings UI toggle (Mode-aware only).
**Success criterion**: median `promptEvalCount` per mode within 10% of Sezione 1 target (~7-8K total), no regression in tool-call sequences vs. existing.
**Estimated effort**: 1-2 giorni.

### Step 2 — RAG infrastructure (toggle OFF by default initially)
**Scope**: pgvector migration, embedder, chunker, indexer, retriever, fallback store, build script, Settings UI toggle (RAG) + status panel.
**Files**: All `rag/*`, `0032_rag_vector.sql`, `rag-chunks.ts`, `build-rag-index.ts`, Settings UI.
**Success criterion**: index builds in <30s on dev corpus; RAG recall fixture tests pass; toggle ON in test environment produces top-3 chunks for representative queries.
**Estimated effort**: 2-3 giorni.

### Step 3 — RAG activated + world_lore dropped from baked
**Scope**: Flip RAG toggle default ON for local; drop `MASTER_WORLD_LORE` from baked manifest; re-bake all installed models; validate via telemetry that recall is acceptable.
**Files**: build-local-models.ts (manifest update), default values in Settings.
**Success criterion**: 80% of turns retrieve at least 1 relevant chunk (telemetry); no qualitative degradation reported on test campaign; total context per turn within Step 1 targets minus baked savings.
**Rollback path**: re-bake with world_lore included; flip RAG toggle default OFF.
**Estimated effort**: 1 giorno + 1 settimana di osservazione.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| pgvector not available on user's Postgres host | Medium | In-memory fallback (degraded but functional). |
| RAG recall poor on niche queries (NPC names, custom lore) | Medium | `lookup_codex` already covers named entities. Generic D&D 5e training knowledge covers the rest. |
| Mode transitions cause noticeable lag (cache invalidation) | Low | Estimated <5% turns affected. Acceptable. |
| Spellcasting overlay misses non-PC casters (NPC spellcasters) | Low | Overlay tied to active PC only; NPCs use baked SRD spell rules + lookup. |
| Ultra-slim handbook loses important DM craft rules | Medium | Keep `master_handbook.md` full in RAG corpus; retrieval covers gaps. Validate via test campaign. |
| `num_ctx` tuning breaks output generation (per prior revert in `42e35d1`) | Medium | Re-enable only after Step 1 telemetry confirms p95 `promptEvalCount + max_output` < 80% of target `num_ctx`. Make `num_ctx` configurable per-model in Settings; defaults to model-native value (no reduction) until validated. |
| Re-baking models on manifest change requires user action | Low | Stale-warning UI from Plan D already in place; surfaces in Settings. |
| pgvector ivfflat index requires tuning `lists` parameter for corpus size | Low | `lists=100` is safe for <100K chunks. Re-tune if corpus grows. |

## Open questions

None at this stage — all design decisions validated with user during brainstorming.

## Appendix — Token budget breakdown (estimated)

All values are estimates (chars/4 heuristic for English/Italian mix). Real values to be confirmed via Step 1 telemetry.

### Baked content per Modelfile

| Block | Tokens |
|---|---:|
| MASTER_SYSTEM_PROMPT_BASE (slim) | ~2.0K |
| MASTER_TOOL_CONTRACT / META (slim) | ~0.8K |
| MASTER_REWARDS_MANDATE (slim) | ~0.5K |
| MASTER_MEMORY_TOOL_RULE (slim) | ~0.2K |
| MASTER_HANDBOOK (ultra-slim) | ~0.4K |
| SRD_CONTEXT_COMPACT (unchanged) | ~3.0K |
| **Total baked** | **~6.9K** |

### Wire per turn (by mode)

| Block | Narrative | Exploration | Combat | Combat+Spell |
|---|---:|---:|---:|---:|
| MODE_BLOCK | 400 | 400 | 400 | 400 |
| SPELLCASTING_OVERLAY | 0 | 0 | 0 | 600 |
| RAG_CHUNKS (top-3) | 500 | 500 | 500 | 500 |
| DYNAMIC (scene+snapshot+memory) | 800 | 800 | 800 | 800 |
| **Wire total** | **~1.7K** | **~1.7K** | **~1.7K** | **~2.3K** |

### Total context window used

| Mode | Baked | Wire | **Total** |
|---|---:|---:|---:|
| Narrative | 6.9K | 1.7K | **8.6K** |
| Exploration | 6.9K | 1.7K | **8.6K** |
| Combat | 6.9K | 1.7K | **8.6K** |
| Combat + spellcasting | 6.9K | 2.3K | **9.2K** |
