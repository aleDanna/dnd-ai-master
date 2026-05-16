# Local Tools — Contextual Subset (Plan A) — Design

**Status:** Draft · **Date:** 2026-05-16 · **Author:** alessio.danna.94@gmail.com
**Builds on:** [2026-05-16-local-ai-provider-design.md](./2026-05-16-local-ai-provider-design.md)

## Goal

Local-provider master turns currently expose a flat **22-tool subset** of the
72-tool `ALWAYS_ON` catalogue. The subset is good enough to play but is
context-blind: every turn carries 22 tool definitions regardless of whether
the party is in combat or exploring. We want to swap to **contextual
subsetting**: the master sees a stable **15-tool core** every turn, plus
~5-8 tools that are unique to the current mode (combat vs exploration).

Effects:

- **Exploration mode**: 15 core + 5 exploration-specific = **20 tools** (prompt
  shrinks by ~10% vs today, removes irrelevant combat tools the master might
  call by mistake)
- **Combat mode**: 15 core + 8 combat-specific = **23 tools** (1 more tool
  than today, but the new ones — `cast_spell`, `end_combat`,
  `concentration_check` — are critical for combat correctness)
- **Cloud providers**: untouched, still get the full 72-tool list

## Non-goals

- ❌ Mode override UI in Settings — auto-detection from `state.inCombat` is
  the only signal. Manual override deferred to a future ticket.
- ❌ New "downtime" / "travel" modes — Plan A v1 only splits combat vs
  exploration. Downtime/travel-specific tools (crafting, vehicles, mounts)
  stay OFF for local providers, matching current behaviour.
- ❌ Restoring full feature parity with cloud — local stays a curated subset.
  This change ONLY rebalances within the 20-25 tool budget.
- ❌ Refactoring the cloud path — `buildToolDefinitions(prefs)` without the
  new opts still returns the full `ALWAYS_ON` list, no regression.

## Architecture

A single extension to `buildToolDefinitions`:

```ts
buildToolDefinitions(
  prefs,
  opts?: {
    localOptimized?: boolean;
    mode?: 'combat' | 'exploration';
  },
)
```

When `localOptimized=true`, the function returns:

```
CORE_LOCAL_TOOLS  ∪  MODE_TOOLS[mode]
```

When `localOptimized=false` (or omitted), behaviour is unchanged — full
`ALWAYS_ON` list.

`mode` defaults to `'exploration'` when the caller doesn't provide one (safe
fallback for the rare callsites that don't have session state).

The turn route reads `state.inCombat` from the snapshot and passes the right
`mode`:

```ts
const localOptimized = userPrefs.aiProvider === 'local';
const tools = buildToolDefinitions(
  { imageGenerationEnabled: userPrefs.imageGenerationEnabled },
  {
    localOptimized,
    mode: snap.state.inCombat ? 'combat' : 'exploration',
  },
);
```

## Tool catalogue

### CORE (15 tools, exposed every turn when localOptimized=true)

```
roll_dice
roll_d20
ability_check
saving_throw
lookup_codex
set_current_player
add_narrative_item
award_xp
apply_condition
remove_condition
add_item
remove_item
take_action
short_rest
long_rest
```

Rationale: these cover the must-have actions every D&D session needs
regardless of whether the party is fighting or talking — dice, checks, basic
narration items, rewards, conditions, inventory, rest cycles.

### COMBAT-ONLY (8 tools, added when `mode='combat'`)

```
roll_initiative
make_attack
apply_damage
end_turn
end_combat
cast_spell
use_resource
concentration_check
```

Rationale: tools that ONLY make sense in combat. `cast_spell` is here (not
in core) because outside combat the master narrates spell effects without
the formal tool. `use_resource` is the generic counterpart for limited-use
features triggered during combat (rage charges, action surge, ki points,
etc. — formerly each had its own tool, now folded into `use_resource` for
local).

### EXPLORATION-ONLY (5 tools, added when `mode='exploration'`)

```
set_travel_pace
set_light_level
set_marching_order
forced_march
check_vision
```

Rationale: tools that only matter outside combat — pacing, marching order,
ambient lighting, vision checks, forced-march checks. In combat the master
narrates these without the tool.

### Permanently dropped from local exposure (vs ALWAYS_ON)

Same as Plan-A-predecessor:
- Crafting workflow (`start_crafting`, `progress_crafting`, …)
- Downtime activities + hirelings
- Bastions, mounts, vehicles
- Attunement / focus equipment
- Class-specific features (`start_rage`, `use_action_surge`,
  `use_channel_divinity`, `grant_bardic_inspiration`, `use_lay_on_hands`)
- Death saves + stabilize (combat handles via narrative + `apply_damage`)
- Inspiration grant/spend
- Meta tools (`set_tonal_frame`, `set_engagement_profile`,
  `update_npc_beats`)
- Multi-class progression (`level_up`, `add_class_level`)

If a player needs these on a local turn, the recommended workaround is to
flip the provider to a cloud one temporarily (Settings → AI master →
Anthropic/OpenAI/Gemini). The campaign settings persist per-campaign so
the cloud key isn't needed permanently.

## Data flow

```
turn route
  → resolved userPrefs.aiProvider
  → buildSnapshot → snap.state.inCombat (boolean)
  → buildToolDefinitions(prefs, {
       localOptimized: aiProvider === 'local',
       mode: snap.state.inCombat ? 'combat' : 'exploration',
     })
  → tool list passed to runToolLoop
```

The mode can change between turns within the same session (e.g. the master
calls `roll_initiative` mid-exploration → next turn `inCombat=true` → 8
combat tools become available; later `end_combat` flips it back → 5
exploration tools come back, 8 combat tools drop).

## Edge cases

- **First turn of a session (`isBegin=true`)**: snapshot exists; `inCombat`
  defaults to `false` from session bootstrap, so the master sees the
  exploration set. Correct (the master always opens a campaign with a
  non-combat scene).
- **Master tries to call a tool not in the current mode**: tool loop returns
  `error: 'unknown_tool'` as today. Master narrates around it on next round.
  E.g. master calls `cast_spell` outside combat → error → master narrates
  the spell effect in prose without mechanical resolution. Acceptable
  degrade for local; cloud is unaffected.
- **Mode toggles mid-session due to a tool call**: the NEXT turn picks up
  the new mode. Within the current tool loop (same prompt) the model
  doesn't see the new toolset — has to wait for the next user message.
  No fix needed: tool loops typically end with narration and a fresh prompt
  arrives for the next interaction anyway.
- **Cloud provider gets `mode` arg too**: ignored (`localOptimized=false`
  short-circuits before mode is consulted). Forward-compatible if a future
  optimisation wants to use mode for cloud too.

## File map

**Modified files:**

| File | Change |
|---|---|
| `src/engine/tools/index.ts` | Add `MODE_LOCAL_TOOLS` map + extend `buildToolDefinitions` signature + new conditional return path |
| `src/app/api/sessions/[id]/turn/route.ts` | Pass `mode: snap.state.inCombat ? 'combat' : 'exploration'` to `buildToolDefinitions` |

**New files:** none.

**Test files modified:**

| File | Change |
|---|---|
| `tests/engine/tools/build-tool-definitions.test.ts` (new or extend existing) | Cover: (1) localOptimized=false returns 72; (2) localOptimized=true, mode='exploration' returns CORE+EXPLORATION (20); (3) localOptimized=true, mode='combat' returns CORE+COMBAT (23); (4) localOptimized=true, no mode returns CORE+EXPLORATION (default); (5) all returned tool names exist in ALWAYS_ON (typo guard) |

## Implementation plan

### Step 1 — Define the tool sets in `src/engine/tools/index.ts`

Replace the current `LOCAL_ESSENTIAL_TOOL_NAMES: Set<string>` constant with
three sets:

```ts
const CORE_LOCAL_TOOL_NAMES = new Set<string>([
  'roll_dice', 'roll_d20', 'ability_check', 'saving_throw',
  'lookup_codex', 'set_current_player', 'add_narrative_item', 'award_xp',
  'apply_condition', 'remove_condition',
  'add_item', 'remove_item',
  'take_action',
  'short_rest', 'long_rest',
]);

const COMBAT_LOCAL_TOOL_NAMES = new Set<string>([
  'roll_initiative', 'make_attack', 'apply_damage',
  'end_turn', 'end_combat',
  'cast_spell', 'use_resource', 'concentration_check',
]);

const EXPLORATION_LOCAL_TOOL_NAMES = new Set<string>([
  'set_travel_pace', 'set_light_level', 'set_marching_order',
  'forced_march', 'check_vision',
]);
```

Extend the function signature:

```ts
export function buildToolDefinitions(
  _prefs: Pick<UserPreferences, 'imageGenerationEnabled'>,
  opts?: { localOptimized?: boolean; mode?: 'combat' | 'exploration' },
): AnthropicTool[] {
  if (!opts?.localOptimized) return ALWAYS_ON;
  const mode = opts.mode ?? 'exploration';
  const allowed = new Set<string>([
    ...CORE_LOCAL_TOOL_NAMES,
    ...(mode === 'combat' ? COMBAT_LOCAL_TOOL_NAMES : EXPLORATION_LOCAL_TOOL_NAMES),
  ]);
  return ALWAYS_ON.filter((t) => allowed.has(t.name));
}
```

### Step 2 — Wire the route

In `src/app/api/sessions/[id]/turn/route.ts`, replace:

```ts
const localOptimized = userPrefs.aiProvider === 'local';
const tools = buildToolDefinitions(
  { imageGenerationEnabled: userPrefs.imageGenerationEnabled },
  { localOptimized },
);
```

With:

```ts
const localOptimized = userPrefs.aiProvider === 'local';
const tools = buildToolDefinitions(
  { imageGenerationEnabled: userPrefs.imageGenerationEnabled },
  {
    localOptimized,
    mode: snap.state.inCombat ? 'combat' : 'exploration',
  },
);
```

Update the existing `[turn]` debug log line to include the mode:

```ts
console.log('[turn]', sessionId, 'provider resolved:', provider.name,
  'calling runToolLoop with model=', userPrefs.aiMasterModel,
  'tools=', tools.length, 'localOptimized=', localOptimized,
  'mode=', snap.state.inCombat ? 'combat' : 'exploration');
```

### Step 3 — Tests

Create `tests/engine/tools/local-subsetting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildToolDefinitions, TOOL_DEFINITIONS } from '@/engine/tools';

describe('buildToolDefinitions — contextual subsetting', () => {
  it('returns the full ALWAYS_ON list when localOptimized is false (or omitted)', () => {
    expect(buildToolDefinitions({ imageGenerationEnabled: false })).toEqual(TOOL_DEFINITIONS);
    expect(buildToolDefinitions({ imageGenerationEnabled: false }, { localOptimized: false })).toEqual(TOOL_DEFINITIONS);
  });

  it('returns CORE + EXPLORATION tools when localOptimized + mode="exploration"', () => {
    const r = buildToolDefinitions(
      { imageGenerationEnabled: false },
      { localOptimized: true, mode: 'exploration' },
    );
    const names = r.map((t) => t.name).sort();
    expect(names).toContain('roll_dice');           // core
    expect(names).toContain('set_travel_pace');     // exploration
    expect(names).not.toContain('make_attack');     // combat-only
    expect(names).not.toContain('cast_spell');      // combat-only
    expect(names).not.toContain('start_crafting');  // not in local subset
    expect(r.length).toBeGreaterThanOrEqual(18);
    expect(r.length).toBeLessThanOrEqual(22);
  });

  it('returns CORE + COMBAT tools when localOptimized + mode="combat"', () => {
    const r = buildToolDefinitions(
      { imageGenerationEnabled: false },
      { localOptimized: true, mode: 'combat' },
    );
    const names = r.map((t) => t.name).sort();
    expect(names).toContain('roll_dice');           // core
    expect(names).toContain('make_attack');         // combat
    expect(names).toContain('cast_spell');          // combat
    expect(names).toContain('concentration_check'); // combat
    expect(names).not.toContain('set_travel_pace'); // exploration-only
    expect(names).not.toContain('start_crafting');  // not in local subset
    expect(r.length).toBeGreaterThanOrEqual(20);
    expect(r.length).toBeLessThanOrEqual(25);
  });

  it('defaults to exploration when localOptimized=true but mode is omitted', () => {
    const r = buildToolDefinitions(
      { imageGenerationEnabled: false },
      { localOptimized: true },
    );
    expect(r.map((t) => t.name)).toContain('set_travel_pace');
    expect(r.map((t) => t.name)).not.toContain('make_attack');
  });

  it('every name in the subsets exists in ALWAYS_ON (typo guard)', () => {
    const allNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    const subsets = buildToolDefinitions({ imageGenerationEnabled: false }, { localOptimized: true, mode: 'combat' })
      .concat(buildToolDefinitions({ imageGenerationEnabled: false }, { localOptimized: true, mode: 'exploration' }));
    for (const t of subsets) {
      expect(allNames.has(t.name)).toBe(true);
    }
  });
});
```

### Step 4 — Manual smoke test

1. `pnpm dev` from a fresh worktree (or main, since local-ai already merged)
2. Create a campaign with `aiProvider=local`, `aiMasterModel=qwen3:14b` (or
   whatever local model is fast enough)
3. Start a turn outside combat → check `[turn]` log shows `tools=20
   mode=exploration`
4. Have the master call `roll_initiative` (or directly send "attack the
   goblin") → state.inCombat becomes true
5. Next turn → check `[turn]` log shows `tools=23 mode=combat`
6. End combat → next turn back to `tools=20 mode=exploration`

### Step 5 — Commit

```bash
git add src/engine/tools/index.ts src/app/api/sessions/[id]/turn/route.ts \
  tests/engine/tools/local-subsetting.test.ts
git commit -m "perf(local-ai): contextual tool subsetting (combat vs exploration)

Replaces the flat 22-tool local subset with a 15-tool core plus 5-8
mode-specific tools (combat / exploration). The route picks the mode
from snap.state.inCombat each turn. Cloud providers still get the
full ALWAYS_ON list (no opts.localOptimized).

Effects on local provider turns:
  - Exploration: 20 tools (was 22) — drops cast_spell, end_combat,
    etc. that the master would never call outside combat anyway.
  - Combat: 23 tools (was 22) — adds cast_spell, end_combat,
    concentration_check which were missing.

Net win: prompt slightly leaner overall, and the master can now
properly handle combat-specific actions when it matters."
```

## Estimated effort

- Step 1 (code): 15 min
- Step 2 (route wire): 5 min
- Step 3 (tests): 20 min
- Step 4 (manual smoke): 10 min
- Step 5 (commit): 2 min

**Total: ~1 hour** for a fully tested, committed feature.

## Open questions / future work

- **Downtime mode**: when `narrative_set_mode('downtime')` or equivalent
  exists, surface a third subset with `start_crafting`, `complete_crafting`,
  `start_downtime_activity`, etc. Out of scope here.
- **Travel mode**: same idea for mounts, vehicles, party logistics. Out of
  scope.
- **Mode override UI in Settings**: "Force tool set: auto / combat /
  exploration / all" toggle. Useful for debugging master behaviour but
  niche. Defer.
- **Token-budget-driven trimming**: dynamically count tool-definition
  tokens and drop the least-used ones once over a threshold. Smarter but
  more complex; current static partition is good enough.
