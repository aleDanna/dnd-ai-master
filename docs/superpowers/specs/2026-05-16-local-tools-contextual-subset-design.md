# Local Provider Speed & Coverage — Plan B (meta-tools local-only) + Plan C (compact prompt toggle)

**Status:** Approved · **Date:** 2026-05-16 · **Author:** alessio.danna.94@gmail.com
**Supersedes:** the earlier "Plan A" contextual subsetting draft in this same file (the rebalance was effectively a no-op on prompt size; we go for the real fix instead).
**Builds on:** [2026-05-16-local-ai-provider-design.md](./2026-05-16-local-ai-provider-design.md)

## Goals

Two complementary optimizations targeted **only at the `local` provider**, to make a local LLM (qwen3:14b on Mac M-series with 48GB unified memory) a viable D&D master for full sessions:

1. **Plan B — Local-only meta-tools**: collapse the 72 tools of `ALWAYS_ON` into **8 meta-tools** with sub-action discriminators, exposed ONLY when `aiProvider === 'local'`. Cloud providers (Anthropic/OpenAI/Gemini) keep the flat 72-tool list and are completely untouched. Goal: give local models access to ALL 72 game-engine features without making them choose between 72 options each turn.

2. **Plan C — Compact prompt toggle**: add a per-campaign Settings toggle `Use compact prompt (faster, for local LLMs)`. When ON, the master prompt swaps handbook/world-lore/SRD-context blocks for trimmed versions (~60% smaller). Default OFF on cloud providers, default ON on local (auto-set when the user picks `aiProvider='local'` the first time, but freely toggleable).

Combined effect on a local turn with qwen3:14b:

| Component | Today | Plan B alone | Plan B + C |
|---|---|---|---|
| Tool defs in prompt | ~5K tok (22 tools) | ~1.5K tok (8 meta) | ~1.5K tok |
| Master handbook | ~5K tok | ~5K tok | ~1K tok |
| World lore | ~3K tok | ~3K tok | ~500 tok |
| SRD context | ~10K tok | ~10K tok | ~3K tok |
| Memory + dynamic | ~5-10K tok | ~5-10K tok | ~5-10K tok |
| **Total** | **~40K tok** | **~36K tok** | **~15-18K tok** |
| **Warm turn (qwen3:14b)** | ~30-60s | ~25-50s | **~8-15s** |
| **Available features** | 22 tools | **all 72** | **all 72** |

## Non-goals

- ❌ Touch cloud provider behaviour — Anthropic/OpenAI/Gemini stay on `ALWAYS_ON` 72 tools with the full prompt. Zero regression risk.
- ❌ Refactor the game engine's tool handlers (the underlying functions stay individual — only the LLM-facing schema changes).
- ❌ Migrate the 50+ existing game-engine tests — they keep working against the underlying tool handlers, untouched.
- ❌ Hot-swap the prompt mode mid-session — the toggle is read at turn-build time, takes effect on next turn.
- ❌ Add downtime / travel mode detection — covered by `meta_action` sub-actions, no per-mode subsetting needed.

## Architecture

### Plan B — Meta-tools (local only)

Eight meta-tools, each with a `subaction` discriminator + payload schema that varies per sub-action:

| Meta-tool | Sub-actions (count) |
|---|---|
| `combat_action` | initiative, attack, damage, end_turn, end_combat, swap_target, condition_apply, condition_remove, falling, death_save, stabilize, concentration_check (14) |
| `spell_action` | cast_spell, use_resource, focus_equip, focus_unequip, attune, unattune (6) |
| `inventory_action` | add_item, remove_item, add_narrative_item, equip, unequip, recompute_ac (6) |
| `character_action` | level_up, add_class_level, award_xp, grant_inspiration, spend_inspiration, use_class_feature, start_rage, end_rage, use_action_surge, use_channel_divinity, grant_bardic, use_lay_on_hands (12) |
| `rest_action` | short_rest, long_rest (2) |
| `narrative_action` | lookup_codex, set_current_player, take_action, ability_check, saving_throw, roll_dice, roll_d20, update_npc_beats (8) |
| `environment_action` | set_travel_pace, set_light_level, set_marching_order, set_senses, check_vision, forced_march, apply_starvation, apply_dehydration, apply_suffocation (9) |
| `meta_action` | set_tonal_frame, set_engagement_profile, start_crafting, progress_crafting, complete_crafting, cancel_crafting, start_downtime, complete_downtime, hire, dismiss_hireling, set_bastion, add_bastion_room, mount, dismount, set_mount_mode, embark_vehicle, disembark_vehicle (17) |

Tot sub-actions: 74 (slight overlap allowed). Coverage of all 72 original `ALWAYS_ON` tools.

**Schema strategy**: each meta-tool exposes a discriminated union via JSON schema `oneOf`:

```json
{
  "name": "combat_action",
  "description": "Combat-related actions. Pick the sub-action and provide its payload.",
  "input_schema": {
    "type": "object",
    "required": ["subaction"],
    "properties": {
      "subaction": {
        "type": "string",
        "enum": ["initiative", "attack", "damage", "end_turn", ...]
      }
    },
    "additionalProperties": true
  }
}
```

Note: we use `additionalProperties: true` instead of `oneOf` because (a) qwen3 and other local models handle flat schemas with discriminator + free additionalProps better than oneOf-of-schemas, and (b) we validate at runtime in the dispatcher.

**Dispatcher**: a new `src/engine/tools/meta-dispatcher.ts` reads `name === 'combat_action'`, picks `subaction` from `input`, validates the remaining input against the underlying tool's schema, and forwards to the existing tool handler unchanged. Output is unchanged.

**Where it plugs in**:

- `buildToolDefinitions(prefs, { localOptimized })` returns the 8 META tools when `localOptimized=true`, the 72 flat tools otherwise. (No `mode` arg — replaced by sub-actions.)
- `runToolLoop` doesn't need changes — it still calls `applyMutations(toolName, toolInput)` against the engine. The applicator gets a meta-dispatcher wrapper that recognises meta names and rewrites them into the underlying call.

### Plan C — Compact prompt toggle

Add `compactPrompt?: boolean` to `CampaignSettings` (and `UserPreferences` for symmetry, though only campaign-scoped matters for the master).

When `true`:
- Master handbook → use `MASTER_HANDBOOK_COMPACT` (1K tok instead of 5K)
- World lore → use `MASTER_WORLD_LORE_COMPACT` (500 tok instead of 3K)
- SRD context → `buildSrdContext({ compact: true })` (3K tok instead of 10K — keeps combat + spell rules core, drops detailed sub-rules)

When `false` (default for cloud): unchanged.

**Defaults**:
- `compactPrompt: undefined` by default
- `getCampaignSettings()` resolves: if undefined, default to `aiProvider === 'local'` (i.e. local turns ON by default, cloud turns OFF).
- Explicit `true`/`false` always honoured.

**Settings UI**: a new section "Local optimization" in the campaign Settings page (visible only when `aiProvider === 'local'` to avoid clutter for cloud users), with a single toggle `Use compact prompt (faster, simpler narration)`. Default state mirrors the resolved value.

## File map

### New files

```
src/engine/tools/meta-tools.ts          — META_TOOL_DEFINITIONS + sub-action enum maps
src/engine/tools/meta-dispatcher.ts     — Routes meta tool calls to the underlying tool handlers
src/ai/master/system-prompt-compact.ts  — MASTER_HANDBOOK_COMPACT + MASTER_WORLD_LORE_COMPACT constants
src/srd/context-compact.ts              — buildSrdContextCompact() (or extend buildSrdContext with compact option)

tests/engine/tools/meta-dispatcher.test.ts
tests/engine/tools/meta-tools-coverage.test.ts (every ALWAYS_ON tool name appears in exactly one meta sub-action)
tests/ai/master/system-prompt-compact.test.ts
```

### Modified files

| File | Change |
|---|---|
| `src/engine/tools/index.ts` | `buildToolDefinitions` returns `META_TOOL_DEFINITIONS` when `localOptimized=true`; export both |
| `src/ai/master/tool-loop.ts` | When the master returns a meta-tool call, pre-process via meta-dispatcher BEFORE applying mutations |
| `src/sessions/applicator.ts` | Hook the dispatcher at the top of `applyMutations` so the rest of the file sees the original tool name |
| `src/ai/master/system-prompt.ts` | Accept `compactPrompt: boolean`; swap handbook/lore/srd blocks for compact versions when true; instruct the model on meta-tool usage when local (sub-section in MASTER_TOOL_CONTRACT) |
| `src/db/schema/campaigns.ts` | Add `compactPrompt?: boolean` to `CampaignSettings` |
| `src/db/schema/users.ts` | Add `compactPrompt?: boolean` to `UserPreferences` (symmetry, defensive) |
| `src/lib/preferences.ts` | Resolve `compactPrompt` (default-from-provider rule); validate in `validateSettingsPatch` |
| `src/app/api/campaigns/[id]/settings/route.ts` | Add `compactPrompt` to ALLOWED_KEYS |
| `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` | New "Local optimization" card with toggle, visible when `aiProvider==='local'` |
| `src/app/api/sessions/[id]/turn/route.ts` | Pass `compactPrompt: userPrefs.compactPrompt` to `buildMasterSystemPrompt` |

### Files NOT touched

- Cloud provider implementations (`anthropic.ts`, `openai.ts`, `gemini.ts`) — completely unchanged
- Local provider (`local.ts`, `ollama-adapter.ts`) — completely unchanged
- 70+ existing game-engine tool handler unit tests — they test the underlying handlers, unaffected by the meta-dispatch
- Cloud provider live-smoke tests — should still pass, no behavior change

## Implementation plan

The two plans are independent. Plan B is the more risky/cross-cutting one, so we ship it first behind a feature gate (`localOptimized=true` already gates it). Plan C is additive and depends on nothing from Plan B.

### Phase 1 — Plan B (Local-only meta-tools)

**Task 1**: Define `META_TOOL_DEFINITIONS` in `src/engine/tools/meta-tools.ts`

- Export an array of 8 AnthropicTool objects
- Each carries `name`, `description`, and `input_schema` with `subaction` enum + permissive additionalProperties
- Description is verbose: lists every sub-action with a 1-line meaning + key input fields
- Tests: schema is valid JSON Schema; enum lists match the underlying tool names

**Task 2**: Build the meta-dispatcher (`src/engine/tools/meta-dispatcher.ts`)

- Single exported function `dispatchMetaCall(name, input)` returning `{ resolvedName, resolvedInput }`
- If `name` is one of the 8 metas: extracts `subaction`, looks up the underlying tool, validates the rest of `input` against the underlying tool's schema (reusing the existing handler validation that already runs in applicator), returns the resolved name + input
- If `name` is a plain tool (cloud path): returns name+input unchanged
- Throws `Error('unknown_subaction')` if the discriminator doesn't match any sub-action of that meta
- Tests: round-trip each underlying tool name through dispatch, validate error paths

**Task 3**: Wire dispatch into `src/sessions/applicator.ts`

- At the top of `applyMutations`, run each mutation's `name`/`input` through `dispatchMetaCall`
- Keep the original `mutationName` for telemetry/logs; the rewritten name drives the handler lookup
- Tests: existing applicator tests still pass; new test: applicator with `{ name: 'combat_action', input: { subaction: 'attack', ... } }` produces the same effect as `{ name: 'make_attack', input: { ... } }`

**Task 4**: Switch `buildToolDefinitions` to return META when `localOptimized=true`

- Replace the current `LOCAL_ESSENTIAL_TOOL_NAMES` subset with `META_TOOL_DEFINITIONS`
- Cloud path (no `localOptimized`) keeps `ALWAYS_ON`
- Tests: `buildToolDefinitions({...}, { localOptimized: true })` returns 8 meta tools; `localOptimized: false` returns 72 flat

**Task 5**: Update master prompt for local meta-tool usage

- In `MASTER_TOOL_CONTRACT`, add a new sub-section "When running on a local model" explaining that the master sees 8 meta-tools and must pick a sub-action; show 1-2 examples
- Only emit this block when `compactPrompt=true` (proxy for "local mode") or when explicitly told via a new `usesMetaTools: boolean` flag on `buildMasterSystemPrompt`
- Tests: prompt includes the meta block iff the flag is set

**Task 6**: Manual smoke test (Plan B)

- Local + qwen3:14b: turn with player attacking a goblin → master should call `combat_action({ subaction: 'attack', ... })` → dispatcher rewrites → engine applies → narration appears
- Check `[ollama-start]` log shows `tools=8` for local

### Phase 2 — Plan C (Compact prompt toggle)

**Task 7**: Add `compactPrompt` to the schemas + preferences resolution

- `CampaignSettings.compactPrompt?: boolean`
- `UserPreferences.compactPrompt?: boolean`
- Defaults: in `getCampaignSettings`, if `compactPrompt === undefined`, default to `aiProvider === 'local'` (i.e. on for local, off for cloud)
- Validation in `validateSettingsPatch`: typeof boolean check

**Task 8**: Create `src/ai/master/system-prompt-compact.ts`

- Export `MASTER_HANDBOOK_COMPACT` (~1K tok) — distilled from the existing handbook, keeping core rules and dropping verbose examples, edge cases, and stylistic guidance details
- Export `MASTER_WORLD_LORE_COMPACT` (~500 tok) — narrative anchors only
- These are NEW handcrafted constants — not auto-summarised. Write them once, review, ship.

**Task 9**: Add `buildSrdContextCompact` (or extend `buildSrdContext` with `compact: true`)

- Compact version omits: spell descriptions for spells not in the party, monster stats not on screen, equipment subtypes
- Keeps: combat rules core, condition definitions, ability/skill rules, basic spellcasting flow

**Task 10**: Wire `compactPrompt` into `buildMasterSystemPrompt`

- Add `compactPrompt?: boolean` to `MasterPromptInput`
- When true: swap `input.handbook` → `MASTER_HANDBOOK_COMPACT`, `input.worldLore` → `MASTER_WORLD_LORE_COMPACT`, `input.srdContext` → compact version
- Default false (so cloud is unchanged)

**Task 11**: Wire from turn route

- Read `userPrefs.compactPrompt` (resolved via `getCampaignSettings`)
- Pass to `buildMasterSystemPrompt({ ..., compactPrompt: userPrefs.compactPrompt })`

**Task 12**: Settings UI — "Local optimization" card

- New card in `settings-client.tsx`, rendered only when `settings.aiProvider === 'local'`
- Single toggle: `Use compact prompt (faster, simpler narration)`
- Default state: mirror the resolved value (from props)
- Save handler: PUT `compactPrompt: boolean`

**Task 13**: Tests for Plan C

- Schema/validation: PUT compactPrompt accepted; getCampaignSettings resolution rule (default-from-provider)
- buildMasterSystemPrompt with compactPrompt=true swaps blocks correctly
- UI toggle round-trips state

**Task 14**: Manual smoke test (Plan C)

- Local + qwen3:14b + compactPrompt=true: check `[ollama-start]` log shows `sys[len=...]` ~60% smaller than before
- Turn time drops to ~8-15s warm
- Switch toggle off → next turn prompt is full size

### Phase 3 — Final integration check

**Task 15**: Live smoke against cloud providers (regression check)

- Anthropic with claude-sonnet-4-5: trigger a few turns, verify nothing changed
- OpenAI with gpt-5: same
- Gemini with gemini-2.5-pro: same
- All three should be byte-for-byte identical responses vs pre-refactor (they don't see meta-tools, don't see compact prompt by default)

## Estimated effort

- Phase 1 (Plan B): **1 day**
  - Tasks 1-2 (meta defs + dispatcher): 3h
  - Task 3 (applicator wire): 1h
  - Task 4 (buildToolDefinitions switch): 30min
  - Task 5 (prompt update): 1h
  - Task 6 (smoke): 30min
  - Tests: integrated in each task

- Phase 2 (Plan C): **1 day**
  - Task 7 (schemas + prefs): 2h
  - Task 8 (compact handbook + lore): 3h (writing distilled prompts is the bulk)
  - Task 9 (compact SRD): 2h
  - Task 10-11 (wire): 1h
  - Task 12 (UI): 1h
  - Task 13-14 (tests + smoke): 1h

- Phase 3: **2-3 hours**

**Total: ~2 days of focused work.**

## Open questions / risks

- **Meta-tool schema discoverability for local LLMs**: qwen3 / gpt-oss may struggle to navigate a single `combat_action` schema with 14 sub-actions and varying payloads. Mitigation: the `description` of each meta-tool lists every sub-action with a one-liner; live smoke (Task 6) is the empirical check.
- **Compact prompt may degrade narration quality**: cutting handbook examples means the master has less "voice" guidance. Acceptable trade-off explicit to the user (toggle is labelled "simpler narration"). Cloud is unaffected because default is off.
- **Default-from-provider rule may surprise users**: if a user creates a cloud campaign, then switches to local, `compactPrompt` is still `undefined` → resolved to `true` for the new local provider. Reasonable default, but worth documenting in the Settings tooltip.
- **Test coverage on the dispatcher**: needs at least one round-trip test per underlying tool name to catch typos in the sub-action enum. Auto-generated test from the ALWAYS_ON list keeps it maintenance-free.
