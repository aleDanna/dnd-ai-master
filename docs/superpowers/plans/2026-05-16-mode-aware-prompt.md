# Plan E.1 — Mode-Aware Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mode-aware prompt composition (combat/exploration/narrative + conditional spellcasting overlay) and slim down the baked Modelfile content so 3-4B and 7-8B local models fit comfortably in 8-16K context windows.

**Architecture:** Derive mode deterministically from `EngineState.combat` + `state.travel?.pace`. Inject only the relevant mode block per turn. Slim the baked manifest (drop `MASTER_WORLD_LORE`, drop standalone `MASTER_ROLL_TRIGGERS`, ultra-slim `MASTER_HANDBOOK`) and keep `SRD_CONTEXT_COMPACT` intact per design decision. Toggle is per-campaign, default ON for local provider.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM (Postgres), Next.js App Router, Ollama (local provider).

**Base branch:** This plan assumes the worktree branches off `feat/local-meta-tools` (has Plan B+C+D merged). Do NOT execute against `main` — main lacks meta-tools, compact prompt, and baked-model infrastructure that this plan extends. Recommended: create a new worktree from `feat/local-meta-tools`, name the branch `feat/local-mode-aware-prompt`.

**Spec:** [docs/superpowers/specs/2026-05-16-mode-aware-rag-prompt-design.md](../specs/2026-05-16-mode-aware-rag-prompt-design.md) (Plan E.1 section — Step 1 of phasing).

**Out of scope for this plan:** RAG infrastructure (covered in Plan E.2, written after E.1 lands).

---

## File Structure

### Create
- `src/ai/master/mode.ts` — `deriveMode()` + `needsSpellcastingOverlay()` + types
- `src/ai/master/mode-blocks/index.ts` — barrel export of mode blocks
- `src/ai/master/mode-blocks/combat.ts` — `MODE_COMBAT_BLOCK` constant
- `src/ai/master/mode-blocks/narrative.ts` — `MODE_NARRATIVE_BLOCK` (includes COMBAT_INITIATION sub-block)
- `src/ai/master/mode-blocks/exploration.ts` — `MODE_EXPLORATION_BLOCK`
- `src/ai/master/mode-blocks/spellcasting-overlay.ts` — `SPELLCASTING_OVERLAY_BLOCK`
- `src/ai/master/slim-prompts.ts` — slim variants: `MASTER_SYSTEM_PROMPT_BASE_SLIM`, `MASTER_TOOL_CONTRACT_SLIM`, `MASTER_REWARDS_MANDATE_SLIM`, `MASTER_MEMORY_TOOL_RULE_SLIM`, `MASTER_HANDBOOK_ULTRA_SLIM`
- `tests/ai/master/mode.test.ts`
- `tests/ai/master/mode-blocks.test.ts`
- `tests/ai/master/system-prompt.mode.test.ts`
- `tests/ai/master/system-prompt.token-budget.test.ts`
- `tests/scripts/build-local-models.slim.test.ts`

### Modify
- `src/ai/master/system-prompt.ts` — accept `mode` + `needsSpellcasting` inputs; inject blocks
- `src/ai/master/system-prompt.ts` — bump `MASTER_PROMPT_VERSION` (forces re-bake)
- `scripts/build-local-models.ts` — `buildStaticSystemContent()` uses slim variants
- `src/app/api/sessions/[id]/turn/route.ts` — derive mode from snapshot state, pass to builder
- `src/db/schema/users.ts` — add `useModeAwarePrompt` boolean field to user preferences
- `src/lib/preferences.ts` — add `useModeAwarePrompt` to `UserPreferences` type with default resolution
- `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` — add toggle in "Local optimization" card
- `src/ai/master/usage.ts` — extend `recordUsage` payload with `mode` + `needsSpellcasting`
- New Drizzle migration `drizzle/0032_mode_aware_prompt_pref.sql`

---

## Task 1: `deriveMode` and `needsSpellcastingOverlay` utilities

**Files:**
- Create: `src/ai/master/mode.ts`
- Test: `tests/ai/master/mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/mode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveMode, needsSpellcastingOverlay, type MasterMode } from '@/ai/master/mode';
import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    characters: [],
    combatActors: [],
    runtime: {},
    combat: null,
    scene: '',
    travel: undefined,
    tonalFrame: null,
    engagementProfile: [],
    ...overrides,
  } as EngineState;
}

function makeSnapshot(overrides: Partial<SnapshotForModel> = {}): SnapshotForModel {
  return {
    state: makeState(),
    characterMonoSpace: '{}',
    scene: '',
    language: null,
    party: [],
    currentPlayerCharacterId: null,
    ...overrides,
  } as SnapshotForModel;
}

describe('deriveMode', () => {
  it('returns "combat" when state.combat is non-null', () => {
    const state = makeState({
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
    });
    expect(deriveMode(state)).toBe<MasterMode>('combat');
  });

  it('returns "exploration" when travel.pace is set and not in combat', () => {
    const state = makeState({
      travel: { pace: 'Normal', lightLevel: 'bright', marchingOrder: [] },
    });
    expect(deriveMode(state)).toBe<MasterMode>('exploration');
  });

  it('returns "narrative" when neither combat nor travel is set', () => {
    expect(deriveMode(makeState())).toBe<MasterMode>('narrative');
  });

  it('combat wins over travel when both are set (ambush en route)', () => {
    const state = makeState({
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
      travel: { pace: 'Normal', lightLevel: 'bright', marchingOrder: [] },
    });
    expect(deriveMode(state)).toBe<MasterMode>('combat');
  });
});

describe('needsSpellcastingOverlay', () => {
  it('returns true when active PC has spellcasting', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(true);
  });

  it('returns false when active PC has no spellcasting', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: null } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });

  it('returns false when no active PC is set', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: null,
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });

  it('returns false when active PC not found in party', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'missing',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/mode.test.ts`
Expected: FAIL with "Cannot find module '@/ai/master/mode'".

- [ ] **Step 3: Write minimal implementation**

Create `src/ai/master/mode.ts`:

```ts
import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

export type MasterMode = 'combat' | 'exploration' | 'narrative';

/**
 * Derive the active master mode from engine state. Used by the prompt
 * builder to load only the relevant mode block per turn. Combat wins
 * over travel (e.g. ambush en route). When neither is set we default
 * to narrative, which covers social scenes, exposition, and downtime.
 */
export function deriveMode(state: EngineState): MasterMode {
  if (state.combat !== null && state.combat !== undefined) return 'combat';
  if (state.travel?.pace !== undefined) return 'exploration';
  return 'narrative';
}

/**
 * Decide whether the spellcasting overlay block should be appended to
 * the wire prompt this turn. We tie this to the ACTIVE PC only (not the
 * whole party) — a fighter's turn doesn't need spell rules even if the
 * party has a wizard.
 */
export function needsSpellcastingOverlay(snapshot: SnapshotForModel): boolean {
  const activeId = snapshot.currentPlayerCharacterId;
  if (!activeId) return false;
  const pc = snapshot.party.find((c) => c.id === activeId);
  return pc?.spellcasting != null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/mode.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/mode.ts tests/ai/master/mode.test.ts
git commit -m "feat(local-ai): mode.ts — deriveMode + needsSpellcastingOverlay utils"
```

---

## Task 2: Mode block constants (combat, narrative, exploration)

**Files:**
- Create: `src/ai/master/mode-blocks/combat.ts`
- Create: `src/ai/master/mode-blocks/narrative.ts`
- Create: `src/ai/master/mode-blocks/exploration.ts`
- Create: `src/ai/master/mode-blocks/index.ts`
- Test: `tests/ai/master/mode-blocks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/mode-blocks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  MODE_COMBAT_BLOCK,
  MODE_NARRATIVE_BLOCK,
  MODE_EXPLORATION_BLOCK,
  MODE_BLOCKS,
} from '@/ai/master/mode-blocks';

describe('mode blocks', () => {
  it('all blocks are non-empty strings', () => {
    expect(MODE_COMBAT_BLOCK.length).toBeGreaterThan(100);
    expect(MODE_NARRATIVE_BLOCK.length).toBeGreaterThan(100);
    expect(MODE_EXPLORATION_BLOCK.length).toBeGreaterThan(100);
  });

  it('all blocks fit within the ~400 token budget (rough char/4 estimate)', () => {
    // 400 tokens ≈ 1600 chars; allow 25% slack for safety.
    const MAX_CHARS = 2000;
    expect(MODE_COMBAT_BLOCK.length).toBeLessThan(MAX_CHARS);
    expect(MODE_NARRATIVE_BLOCK.length).toBeLessThan(MAX_CHARS);
    expect(MODE_EXPLORATION_BLOCK.length).toBeLessThan(MAX_CHARS);
  });

  it('combat block mentions initiative + concentration', () => {
    expect(MODE_COMBAT_BLOCK).toMatch(/initiative/i);
    expect(MODE_COMBAT_BLOCK).toMatch(/concentration/i);
  });

  it('narrative block contains a COMBAT INITIATION sub-block', () => {
    expect(MODE_NARRATIVE_BLOCK).toMatch(/COMBAT INITIATION/);
    expect(MODE_NARRATIVE_BLOCK).toMatch(/combat_action\.initiative/);
  });

  it('exploration block mentions pace + vision', () => {
    expect(MODE_EXPLORATION_BLOCK).toMatch(/pace/i);
    expect(MODE_EXPLORATION_BLOCK).toMatch(/vision/i);
  });

  it('MODE_BLOCKS map covers all three modes', () => {
    expect(MODE_BLOCKS.combat).toBe(MODE_COMBAT_BLOCK);
    expect(MODE_BLOCKS.narrative).toBe(MODE_NARRATIVE_BLOCK);
    expect(MODE_BLOCKS.exploration).toBe(MODE_EXPLORATION_BLOCK);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/mode-blocks.test.ts`
Expected: FAIL with "Cannot find module '@/ai/master/mode-blocks'".

- [ ] **Step 3: Create the four mode block files**

Create `src/ai/master/mode-blocks/combat.ts`:

```ts
export const MODE_COMBAT_BLOCK = `## MODE: COMBAT

You are running an active combat encounter. The full combat rules are in
your baked SRD context — this block is tactical priming.

PRIORITIES:
- Track initiative order; announce the current actor each turn.
- Resolve opportunity attacks on movement out of threatened squares.
- Check concentration on damage to spellcasters: CON save DC = max(10, damage/2).
- Apply reactions before turn end.
- After damage, if a PC drops to HP<=0: prompt a death save on their next turn.

TURN ECONOMY: action, bonus action, reaction, movement, free interaction.
Announce what each PC used so the player can decide their next turn.

USE lookup_codex for monster stat blocks or specific spell effects not
already in your context. Do NOT invent stats — look them up.
`;
```

Create `src/ai/master/mode-blocks/narrative.ts`:

```ts
export const MODE_NARRATIVE_BLOCK = `## MODE: NARRATIVE

You are running a narrative scene (no active combat, no travel). The full
DM craft rules are in your baked content — this block is mode-specific.

PRIORITIES:
- Establish scene: place, time, mood, present NPCs.
- Roleplay social interactions FIRST; request Insight/Persuasion/Deception
  rolls only when the outcome is uncertain and consequential.
- Default DCs: easy 10, medium 15, hard 20, very hard 25.
- Use scene card entities for continuity. Look up named NPCs via lookup_codex
  if not already on the scene card.
- Award XP at scene end if it served a quest milestone (per baked rewards mandate).

### COMBAT INITIATION (sub-block)

If you describe an ambush, hostile encounter, or aggression that will lead
to combat:
  1. FIRST call combat_action with subaction="initiative", listing all combatants.
  2. THEN narrate the opening of the fight.

Do NOT narrate combat actions (attacks, damage, conditions) without
initiative rolled first. The state machine requires combat to be active.
`;
```

Create `src/ai/master/mode-blocks/exploration.ts`:

```ts
export const MODE_EXPLORATION_BLOCK = `## MODE: EXPLORATION

You are running travel or exploration (state.travel.pace is set). Combat
rules are in baked SRD; this block focuses on travel-specific mechanics.

PRIORITIES:
- Honor the chosen travel pace (Fast/Normal/Slow):
  * Fast: -5 passive Perception, no stealth.
  * Normal: standard.
  * Slow: stealth allowed; +5 passive Perception when scouting.
- Track marching order for surprise rounds and area-of-effect targeting.
- Apply vision and light:
  * Bright light: normal sight.
  * Dim light: lightly obscured (disadvantage on Perception relying on sight).
  * Darkness: heavily obscured (effectively blinded without darkvision).
- Forced march beyond 8h: CON save DC 10 + 1 per extra hour, fail = 1 level
  of exhaustion.

TRANSITIONS:
- Random or planned encounter → see COMBAT INITIATION in the narrative
  block guidance.
- End of a travel leg → call environment_action with subaction="set_travel_pace"
  and pace=null, then describe arrival.
`;
```

Create `src/ai/master/mode-blocks/index.ts`:

```ts
import { MODE_COMBAT_BLOCK } from './combat';
import { MODE_NARRATIVE_BLOCK } from './narrative';
import { MODE_EXPLORATION_BLOCK } from './exploration';
import type { MasterMode } from '../mode';

export { MODE_COMBAT_BLOCK, MODE_NARRATIVE_BLOCK, MODE_EXPLORATION_BLOCK };

export const MODE_BLOCKS: Record<MasterMode, string> = {
  combat: MODE_COMBAT_BLOCK,
  narrative: MODE_NARRATIVE_BLOCK,
  exploration: MODE_EXPLORATION_BLOCK,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/mode-blocks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/mode-blocks/ tests/ai/master/mode-blocks.test.ts
git commit -m "feat(local-ai): 3 mode blocks (combat/narrative/exploration)"
```

---

## Task 3: Spellcasting overlay block

**Files:**
- Create: `src/ai/master/mode-blocks/spellcasting-overlay.ts`
- Modify: `src/ai/master/mode-blocks/index.ts`
- Modify: `tests/ai/master/mode-blocks.test.ts`

- [ ] **Step 1: Extend the failing test**

Edit `tests/ai/master/mode-blocks.test.ts`, add a new `describe` block:

```ts
import { SPELLCASTING_OVERLAY_BLOCK } from '@/ai/master/mode-blocks';

describe('spellcasting overlay', () => {
  it('is a non-empty string within ~600 token budget', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK.length).toBeGreaterThan(200);
    expect(SPELLCASTING_OVERLAY_BLOCK.length).toBeLessThan(3000); // ~750 tok ceiling
  });

  it('covers slot mechanics + concentration + components', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/slot/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/concentration/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/components?/i);
  });

  it('mentions both spell attack rolls and save spells', () => {
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/spell attack/i);
    expect(SPELLCASTING_OVERLAY_BLOCK).toMatch(/(saving throw|save spell)/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/mode-blocks.test.ts`
Expected: FAIL with "SPELLCASTING_OVERLAY_BLOCK is not exported".

- [ ] **Step 3: Create overlay file and re-export it**

Create `src/ai/master/mode-blocks/spellcasting-overlay.ts`:

```ts
export const SPELLCASTING_OVERLAY_BLOCK = `## OVERLAY: SPELLCASTING

The active PC is a spellcaster. The full SRD spell-rules section is in your
baked content — this overlay provides quick reference for in-turn calls.

SLOT MECHANICS:
- spell_action with subaction="cast_spell" consumes a slot of the cast level.
- Cantrips: no slot. Scale by character level (1-4: base, 5-10: ×2, 11-16: ×3,
  17+: ×4 dice).
- Long rest: all slots restored.
- Short rest: only warlock pact slots and explicitly short-rest features regain.

CONCENTRATION:
- Only one concentration spell at a time per caster.
- Taking damage triggers a CON save: DC = max(10, damage/2). Fail = drop.
- Casting a new concentration spell ends any current concentration.

COMPONENTS:
- V/S/M check available. Costed material components are consumed.
- A focus or component pouch satisfies non-costed M.

RESOLUTION:
- Spell attack rolls: d20 + spellcasting mod + proficiency bonus.
- Save spells: target rolls; DC = 8 + spellcasting mod + proficiency bonus.
- Healing: cap at hpMax. Necrotic on undead heals — flag explicitly.

Use lookup_codex for the full text of a specific spell if it's not in your
recent context (e.g. niche cleric domain spells).
`;
```

Edit `src/ai/master/mode-blocks/index.ts`, add export:

```ts
import { MODE_COMBAT_BLOCK } from './combat';
import { MODE_NARRATIVE_BLOCK } from './narrative';
import { MODE_EXPLORATION_BLOCK } from './exploration';
import { SPELLCASTING_OVERLAY_BLOCK } from './spellcasting-overlay';
import type { MasterMode } from '../mode';

export {
  MODE_COMBAT_BLOCK,
  MODE_NARRATIVE_BLOCK,
  MODE_EXPLORATION_BLOCK,
  SPELLCASTING_OVERLAY_BLOCK,
};

export const MODE_BLOCKS: Record<MasterMode, string> = {
  combat: MODE_COMBAT_BLOCK,
  narrative: MODE_NARRATIVE_BLOCK,
  exploration: MODE_EXPLORATION_BLOCK,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/mode-blocks.test.ts`
Expected: PASS, 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/mode-blocks/spellcasting-overlay.ts src/ai/master/mode-blocks/index.ts tests/ai/master/mode-blocks.test.ts
git commit -m "feat(local-ai): spellcasting overlay block"
```

---

## Task 4: Slim variants of base prompts (for slim baked manifest)

**Files:**
- Create: `src/ai/master/slim-prompts.ts`
- Test: extend Task 7's test (build-local-models.slim.test.ts)

This task just creates the constants. They get wired into the build script in Task 8.

- [ ] **Step 1: Create the slim variants file**

Create `src/ai/master/slim-prompts.ts`:

```ts
/**
 * Slim variants of the master's static blocks, used by Plan E.1 to shrink
 * the baked Modelfile SYSTEM directive. Full variants in system-prompt.ts
 * remain unchanged and are still used by cloud providers (Anthropic /
 * OpenAI / Gemini) and by non-baked local turns.
 *
 * Token budget targets (chars/4 heuristic):
 *  - MASTER_SYSTEM_PROMPT_BASE_SLIM:    ~2.0K tok ( ~8000 chars)
 *  - MASTER_TOOL_CONTRACT_SLIM:         ~0.8K tok ( ~3200 chars)
 *  - MASTER_REWARDS_MANDATE_SLIM:       ~0.5K tok ( ~2000 chars)
 *  - MASTER_MEMORY_TOOL_RULE_SLIM:      ~0.2K tok (  ~800 chars)
 *  - MASTER_HANDBOOK_ULTRA_SLIM:        ~0.4K tok ( ~1600 chars)
 */

export const MASTER_SYSTEM_PROMPT_BASE_SLIM = `# ROLE

You are the D&D 5e master for a small party of player characters. You
narrate scenes, voice NPCs, adjudicate rules, and call game-engine tools
to mutate world state. The player(s) drive their PCs; you drive everything
else.

# LANGUAGE

Mirror the language of the campaign (set at session start). Never switch
to English unless the campaign language is English.

# TOOL CONTRACT (HIGH LEVEL)

You have access to game-engine tools that mutate persistent state. Calling
a tool is the ONLY way to update HP, conditions, inventory, XP, combat
state, or travel state. Narration alone does NOT mutate state.

State-mutating tools must be called BEFORE you narrate the consequence
(otherwise the snapshot you see next turn will be stale).

# TURN LIFECYCLE

1. Read the player's input + current snapshot.
2. Decide outcomes (request rolls if uncertain; pick DCs).
3. Call any required tools (state mutations FIRST).
4. Narrate the resulting scene in the campaign language.
5. End with what the active PC sees / hears / has to decide.

# OUTPUT DISCIPLINE

- No system commentary, no meta about being an AI, no preamble like
  "Sure, here's...". Just narrate.
- Keep narration tight: 2-5 paragraphs per turn unless the scene
  legitimately needs more.
- Use sensory detail (sight, sound, smell, touch) sparingly but vividly.
- End with a clear hook or question for the player.
`;

export const MASTER_TOOL_CONTRACT_SLIM = `# TOOL USAGE RULES

- ALWAYS call state-mutating tools BEFORE narrating outcomes.
- Tool calls can stack in one turn: e.g. make_attack → apply_damage →
  apply_condition → end_turn.
- For checks (ability_check, saving_throw, attack rolls): if the player has
  not yet rolled, request the roll first; do NOT mutate state pre-emptively.
- For combat actions: respect turn order. The currentIdx in state.combat
  points to whose turn it is.
- For rewards (XP, items): call award_xp / add_item at the end of any
  meaningful encounter or scene (see rewards mandate).
- For NPCs and lore: call lookup_codex to retrieve canonical text. Do not
  invent stats, names, or details that contradict the codex.

Available tools and their schemas are in the tool list passed by the
runtime — refer to their descriptions for exact inputs.
`;

export const MASTER_REWARDS_MANDATE_SLIM = `# REWARDS MANDATE (HARD RULE)

At the END of every encounter, dungeon, milestone, or significant scene
you MUST:
  1. Call award_xp with a per-PC XP amount appropriate to the challenge.
  2. Call add_item / add_narrative_item for any loot, story items, or
     trophies the party earned.

Default XP guideline: easy encounter ~25 per PC, medium ~50, hard ~100,
deadly ~200, milestone ~500. Scale by party level if needed.

Loot guideline: at least 1 narrative item per scene (a letter, a key, a
rumor token); coin and gear from defeated enemies as appropriate.

If you forget rewards the players notice and the campaign stalls. Make
the rewards an automatic step, not an afterthought.
`;

export const MASTER_MEMORY_TOOL_RULE_SLIM = `# MEMORY: SCENE CARD > LOOKUP

The scene card (when present) lists the entities currently relevant to the
scene with their canonical data. Trust it over your training memory.

For entities NOT on the scene card, call lookup_codex with the entity kind
(npc, location, quest, faction, lore_fact, named_item, relationship) and a
slug or name fragment. The codex is the canonical source.

Never contradict the codex. If the lookup returns nothing, you can invent
a minor detail — but stay consistent with prior scenes.
`;

export const MASTER_HANDBOOK_ULTRA_SLIM = `# DM CRAFT — CORE PRINCIPLES

PACING:
- Keep scenes tight. One scene = one question or one decision.
- Cut to the next moment as soon as the player has decided; don't narrate
  travel-by-travel.

TURN DISCIPLINE:
- One state-mutating action per player turn (unless they explicitly chain).
- Always end with a hook so the player has something to react to.

NPC VOICE:
- Each named NPC has at least one distinguishing trait (mannerism, accent,
  agenda). Use it consistently.
- Antagonists negotiate, hesitate, scheme — they're not pinatas.

PITFALLS TO AVOID:
- Don't read tool output verbatim to the player. Translate it into prose.
- Don't dump lore unprompted. Reveal through scenes, NPCs, found documents.
- Don't railroad: if the player picks an unexpected solution, let it work
  (or fail believably) rather than blocking it.

Full handbook is available in your context (via lookup or baked) if you
need to consult specific sections; this is the always-loaded core.
`;
```

- [ ] **Step 2: Build (typecheck) to verify file is valid TS**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors mentioning slim-prompts.ts).

- [ ] **Step 3: Commit**

```bash
git add src/ai/master/slim-prompts.ts
git commit -m "feat(local-ai): slim variants of base prompts for baked manifest"
```

---

## Task 5: Extend `buildMasterSystemPrompt` to accept mode + needsSpellcasting

**Files:**
- Modify: `src/ai/master/system-prompt.ts`
- Test: `tests/ai/master/system-prompt.mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/system-prompt.mode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

function baseInput(overrides: Partial<Parameters<typeof buildMasterSystemPrompt>[0]> = {}) {
  return {
    handbook: 'HANDBOOK_CONTENT',
    worldLore: 'LORE_CONTENT',
    srdContext: 'SRD_CONTENT',
    characterMonoSpace: '{}',
    scene: '',
    language: 'en' as const,
    manualRolls: false,
    masterGuidanceLevel: 'balanced' as const,
    showDifficultyNumbers: true,
    narrationPace: 'standard' as const,
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    tonalFrame: null,
    engagementProfile: [],
    party: [],
    currentPlayerCharacterId: null,
    usesMetaTools: false,
    staticBlocksAlreadyBaked: false,
    ...overrides,
  };
}

describe('buildMasterSystemPrompt — mode injection', () => {
  it('injects MODE_COMBAT_BLOCK when mode="combat"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'combat' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: COMBAT/);
    expect(text).not.toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: EXPLORATION/);
  });

  it('injects MODE_NARRATIVE_BLOCK when mode="narrative"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'narrative' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: COMBAT/);
  });

  it('injects MODE_EXPLORATION_BLOCK when mode="exploration"', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'exploration' }));
    const text = system.map((b) => b.text).join('\n');
    expect(text).toMatch(/MODE: EXPLORATION/);
    expect(text).not.toMatch(/MODE: COMBAT/);
  });

  it('includes spellcasting overlay only when needsSpellcasting=true', () => {
    const withOverlay = buildMasterSystemPrompt(baseInput({ mode: 'combat', needsSpellcasting: true }));
    const withoutOverlay = buildMasterSystemPrompt(baseInput({ mode: 'combat', needsSpellcasting: false }));
    const withText = withOverlay.system.map((b) => b.text).join('\n');
    const withoutText = withoutOverlay.system.map((b) => b.text).join('\n');
    expect(withText).toMatch(/OVERLAY: SPELLCASTING/);
    expect(withoutText).not.toMatch(/OVERLAY: SPELLCASTING/);
  });

  it('mode block appears AFTER static blocks and BEFORE dynamic tail (cache stability)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({ mode: 'combat' }));
    const texts = system.map((b) => b.text);
    const baseIdx = texts.findIndex((t) => t.includes('HANDBOOK_CONTENT'));
    const modeIdx = texts.findIndex((t) => t.includes('MODE: COMBAT'));
    const dynamicIdx = texts.findIndex((t) => t.includes('Current snapshot'));
    expect(baseIdx).toBeLessThan(modeIdx);
    expect(modeIdx).toBeLessThan(dynamicIdx);
  });

  it('NO mode block injected when mode is undefined (backward compat with Plan B+C+D)', () => {
    const { system } = buildMasterSystemPrompt(baseInput({}));
    const text = system.map((b) => b.text).join('\n');
    expect(text).not.toMatch(/MODE: NARRATIVE/);
    expect(text).not.toMatch(/MODE: COMBAT/);
    expect(text).not.toMatch(/MODE: EXPLORATION/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/ai/master/system-prompt.mode.test.ts`
Expected: FAIL with "Object literal may only specify known properties, and 'mode' does not exist in type 'MasterPromptInput'" (or runtime: tests fail because MODE: COMBAT not in output).

- [ ] **Step 3: Extend `MasterPromptInput` interface and wire blocks**

In `src/ai/master/system-prompt.ts`, locate the `MasterPromptInput` interface (search for `export interface MasterPromptInput` — should be near line 1660). Add two new optional fields:

```ts
export interface MasterPromptInput {
  // ... existing fields ...
  /** Plan E.1: which mode block to inject. Default 'narrative' (back-compat). */
  mode?: 'combat' | 'exploration' | 'narrative';
  /** Plan E.1: whether the active PC has spellcasting (overlay gate). */
  needsSpellcasting?: boolean;
}
```

`buildMasterSystemPrompt` is currently synchronous, so we use a STATIC top-level import (NOT a dynamic `import()`, which would force the function to become `async` and ripple through every caller).

Add this at the top of `system-prompt.ts` (with the other imports, around line 1-20):

```ts
import { MODE_BLOCKS, SPELLCASTING_OVERLAY_BLOCK } from './mode-blocks';
```

Then in the body, replace the dynamic-import block with the synchronous version:

```ts
// ── (2.5) PLAN E.1 MODE BLOCK + SPELLCASTING OVERLAY ──
// Both fields are optional: when undefined (toggle OFF / cloud provider /
// pre-E.1 callers) we inject NOTHING here, preserving Plan B+C+D
// behaviour byte-for-byte. Only callers that opt in by passing
// `mode: <value>` get the new block.
if (input.mode) {
  blocks.push({
    type: 'text',
    text: MODE_BLOCKS[input.mode],
    cache_control: { type: 'ephemeral' },
  });
}
if (input.needsSpellcasting) {
  blocks.push({
    type: 'text',
    text: SPELLCASTING_OVERLAY_BLOCK,
    cache_control: { type: 'ephemeral' },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/ai/master/system-prompt.mode.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full system-prompt test suite (no regression)**

Run: `pnpm vitest run tests/ai/master/system-prompt.test.ts`
Expected: PASS (existing tests should not break — `mode` defaults to `'narrative'` when undefined).

- [ ] **Step 6: Commit**

```bash
git add src/ai/master/system-prompt.ts tests/ai/master/system-prompt.mode.test.ts
git commit -m "feat(local-ai): inject mode block + spellcasting overlay in master prompt"
```

---

## Task 6: Token budget regression test (CI gate)

**Files:**
- Test: `tests/ai/master/system-prompt.token-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/system-prompt.token-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

/**
 * Rough token count via chars/4 heuristic. Real tokenization varies ±15%
 * for Italian/English mix. We assert generous ceilings to catch
 * regressions (a single block doubling in size) without flaking on
 * minor edits.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function bakedInput(overrides: Partial<Parameters<typeof buildMasterSystemPrompt>[0]> = {}) {
  // When staticBlocksAlreadyBaked=true the big static blocks are skipped,
  // simulating a baked-model turn. This is the configuration the budget
  // applies to.
  return {
    handbook: '',
    worldLore: '',
    srdContext: '',
    characterMonoSpace: JSON.stringify({ name: 'Test', hp: 10, ac: 14 }),
    scene: 'A dim tavern.',
    language: 'en' as const,
    manualRolls: false,
    masterGuidanceLevel: 'balanced' as const,
    showDifficultyNumbers: true,
    narrationPace: 'standard' as const,
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    tonalFrame: null,
    engagementProfile: [],
    party: [{ id: 'pc1', name: 'Test' }] as any,
    currentPlayerCharacterId: 'pc1',
    usesMetaTools: true,
    staticBlocksAlreadyBaked: true,
    ...overrides,
  };
}

// Targets from the Plan E.1 design (Appendix). Tolerances allow for
// the "guidance balanced" + "lang hint" + "party mode block" overhead.
const WIRE_BUDGET: Record<string, number> = {
  narrative: 2500,
  exploration: 2500,
  combat: 2500,
  'combat+spell': 3200,
};

describe('Plan E.1 token budget (baked model turn, wire only)', () => {
  for (const mode of ['narrative', 'exploration', 'combat'] as const) {
    it(`mode=${mode} fits within ${WIRE_BUDGET[mode]} tokens`, () => {
      const { system } = buildMasterSystemPrompt(bakedInput({ mode }));
      const total = system.reduce((acc, b) => acc + approxTokens(b.text), 0);
      expect(total).toBeLessThanOrEqual(WIRE_BUDGET[mode]);
    });
  }

  it('mode=combat + spellcasting overlay fits within combat+spell budget', () => {
    const { system } = buildMasterSystemPrompt(
      bakedInput({ mode: 'combat', needsSpellcasting: true }),
    );
    const total = system.reduce((acc, b) => acc + approxTokens(b.text), 0);
    expect(total).toBeLessThanOrEqual(WIRE_BUDGET['combat+spell']);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (or fails informatively)**

Run: `pnpm vitest run tests/ai/master/system-prompt.token-budget.test.ts`
Expected: PASS. If it fails, the actual token count is printed — adjust mode block content (Task 2 or Task 3) to fit, or document the budget bump in commit message.

- [ ] **Step 3: Commit**

```bash
git add tests/ai/master/system-prompt.token-budget.test.ts
git commit -m "test(local-ai): token budget regression guard for mode-aware prompt"
```

---

## Task 7: Slim manifest in `build-local-models.ts`

**Files:**
- Modify: `scripts/build-local-models.ts`
- Test: `tests/scripts/build-local-models.slim.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/build-local-models.slim.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// We test `buildStaticSystemContent` in isolation by re-exporting it
// from the script. To avoid running the whole script on import, the
// script's `main()` is only invoked when run as a CLI (Node entry-point
// check). The function itself is importable.
import { buildStaticSystemContent } from '../../scripts/build-local-models';

describe('Plan E.1 slim baked manifest', () => {
  it('includes slim BASE, slim TOOL_CONTRACT, ultra-slim HANDBOOK', async () => {
    const content = await buildStaticSystemContent();
    expect(content).toMatch(/# ROLE\b/); // BASE_SLIM marker
    expect(content).toMatch(/# TOOL USAGE RULES\b/); // TOOL_CONTRACT_SLIM marker
    expect(content).toMatch(/# DM CRAFT — CORE PRINCIPLES\b/); // HANDBOOK_ULTRA_SLIM marker
  });

  it('does NOT include MASTER_WORLD_LORE content (dropped from baked)', async () => {
    const content = await buildStaticSystemContent();
    // The world lore opens with "# WORLD LORE" or "## COSMOLOGY" — assert
    // none of those distinctive headers appear.
    expect(content).not.toMatch(/^# WORLD LORE/m);
    expect(content).not.toMatch(/^## COSMOLOGY/m);
  });

  it('does NOT include standalone MASTER_ROLL_TRIGGERS block (absorbed in mode blocks)', async () => {
    const content = await buildStaticSystemContent();
    expect(content).not.toMatch(/# ROLL TRIGGERS/);
  });

  it('still includes SRD_CONTEXT compact intact (per design decision)', async () => {
    const content = await buildStaticSystemContent();
    // SRD context has a distinctive header — verify it's present.
    expect(content).toMatch(/(SRD|System Reference Document|abilities table)/i);
  });

  it('total baked content fits within ~7K tok ceiling', async () => {
    const content = await buildStaticSystemContent();
    const tokens = Math.ceil(content.length / 4);
    expect(tokens).toBeLessThanOrEqual(7500); // target ~6.9K, ceiling 7.5K
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/scripts/build-local-models.slim.test.ts`
Expected: FAIL (currently `buildStaticSystemContent` is NOT exported and bakes full content).

- [ ] **Step 3: Refactor script to export and use slim variants**

In `scripts/build-local-models.ts`:

3a. **Export `buildStaticSystemContent`** by changing its signature line (around line 158):
```ts
async function buildStaticSystemContent(): Promise<string> {
```
to:
```ts
export async function buildStaticSystemContent(): Promise<string> {
```

3b. **Replace the imports block** (lines 21-32) to pull slim variants:
```ts
import {
  MASTER_PROMPT_VERSION,
  MASTER_TOOL_CONTRACT,           // KEEP for non-slim use elsewhere
  MASTER_META_TOOLS_INSTRUCTION,
  MASTER_REWARDS_MANDATE,
  MASTER_MEMORY_TOOL_RULE,
} from '../src/ai/master/system-prompt';
import {
  MASTER_SYSTEM_PROMPT_BASE_SLIM,
  MASTER_TOOL_CONTRACT_SLIM,
  MASTER_REWARDS_MANDATE_SLIM,
  MASTER_MEMORY_TOOL_RULE_SLIM,
  MASTER_HANDBOOK_ULTRA_SLIM,
} from '../src/ai/master/slim-prompts';
import { buildSrdContext } from '../src/ai/master/srd-context';
import { getBakedModelName, computeMasterPromptHash } from '../src/ai/master/baked-models';
```

Note: we drop the `getMasterHandbook` and `getMasterWorldLore` imports — slim handbook is now baked as a constant; world lore is no longer baked.

3c. **Rewrite `buildStaticSystemContent`** (lines 158-177) to use slim variants and drop world_lore + standalone roll_triggers:

```ts
export async function buildStaticSystemContent(): Promise<string> {
  const srdContext = await buildSrdContext({ compact: true }); // compact, per design
  const blocks: string[] = [
    MASTER_SYSTEM_PROMPT_BASE_SLIM,
    MASTER_TOOL_CONTRACT_SLIM,
    MASTER_META_TOOLS_INSTRUCTION,        // unchanged — required for local meta-tools
    MASTER_REWARDS_MANDATE_SLIM,
    MASTER_MEMORY_TOOL_RULE_SLIM,
    MASTER_HANDBOOK_ULTRA_SLIM,
    srdContext,
    // DROPPED: MASTER_SYSTEM_PROMPT_BASE (full), MASTER_TOOL_CONTRACT (full),
    //         MASTER_ROLL_TRIGGERS, MASTER_REWARDS_MANDATE (full),
    //         MASTER_MEMORY_TOOL_RULE (full), getMasterHandbook (full),
    //         getMasterWorldLore (full).
    // ROLL_TRIGGERS is now distributed across the mode blocks (Plan E.1).
    // World lore moves to RAG in Plan E.2.
  ];
  return blocks.join('\n\n');
}
```

3d. **Bump `MASTER_PROMPT_VERSION`** in `src/ai/master/system-prompt.ts` (find the const, around line 1 or near other exports — search `MASTER_PROMPT_VERSION =`). Bump the integer / string suffix so the bake-hash check forces a re-bake on next run. Example:

If current is:
```ts
export const MASTER_PROMPT_VERSION = '5';
```
change to:
```ts
export const MASTER_PROMPT_VERSION = '6'; // Plan E.1: slim baked manifest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/scripts/build-local-models.slim.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run typecheck (no broken imports elsewhere)**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-local-models.ts src/ai/master/system-prompt.ts tests/scripts/build-local-models.slim.test.ts
git commit -m "feat(local-ai): slim baked manifest — drop world_lore + roll_triggers, ultra-slim handbook"
```

---

## Task 8: Add `useModeAwarePrompt` preference (DB + types + resolution)

**Files:**
- Modify: `src/db/schema/users.ts` (for `UserPreferences`)
- Modify: `src/db/schema/campaigns.ts` (for `CampaignSettings` — mirror Plan C `compactPrompt` pattern)
- Modify: `src/lib/preferences.ts`
- Create: `drizzle/0032_mode_aware_prompt_pref.sql` (numbering may vary — drizzle-kit assigns next free)
- Test: `tests/lib/preferences-mode-aware.test.ts`

> **Note on dual-schema pattern**: Plan C added `compactPrompt` to BOTH `users.ts` and `campaigns.ts` (campaign value wins at runtime; user-level acts as default when creating a new campaign). Plan E.1 mirrors this — add the same field in both tables.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/preferences-mode-aware.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveUseModeAwarePrompt } from '@/lib/preferences';

describe('resolveUseModeAwarePrompt', () => {
  it('returns true when explicitly true', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'cloud', useModeAwarePrompt: true })).toBe(true);
  });

  it('returns false when explicitly false', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'local', useModeAwarePrompt: false })).toBe(false);
  });

  it('defaults to true when undefined and provider=local', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'local', useModeAwarePrompt: undefined })).toBe(true);
  });

  it('defaults to false when undefined and provider=cloud', () => {
    expect(resolveUseModeAwarePrompt({ aiProvider: 'cloud', useModeAwarePrompt: undefined })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lib/preferences-mode-aware.test.ts`
Expected: FAIL ("resolveUseModeAwarePrompt is not exported").

- [ ] **Step 3: Add field to preferences type and resolver**

In `src/lib/preferences.ts`, locate the `UserPreferences` interface (or type). Add the field:

```ts
export interface UserPreferences {
  // ... existing fields ...
  /** Plan E.1: enable mode-aware prompt composition. Default ON for local. */
  useModeAwarePrompt?: boolean;
}
```

Append the resolver function (or add near `compactPrompt` resolution if one exists):

```ts
/**
 * Resolve the effective value of useModeAwarePrompt. When the user has not
 * explicitly set it, default ON for local providers and OFF for cloud
 * (cloud doesn't need the optimization — they pay per token, not per
 * context window allocation).
 */
export function resolveUseModeAwarePrompt(prefs: {
  aiProvider: string;
  useModeAwarePrompt?: boolean;
}): boolean {
  if (typeof prefs.useModeAwarePrompt === 'boolean') return prefs.useModeAwarePrompt;
  return prefs.aiProvider === 'local';
}
```

- [ ] **Step 4: Add field to both Drizzle schemas**

In `src/db/schema/users.ts`, locate the `users` table definition. Add a new column next to where `compactPrompt` lives:

```ts
useModeAwarePrompt: boolean('use_mode_aware_prompt'),
```

In `src/db/schema/campaigns.ts`, locate the `campaigns` table (or the table that holds `compactPrompt`) and add the same column:

```ts
useModeAwarePrompt: boolean('use_mode_aware_prompt'),
```

Mirror the exact pattern of `compactPrompt` (snake_case column name, nullable boolean).

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `drizzle/0032_<name>.sql` is created with `ALTER TABLE users ADD COLUMN use_mode_aware_prompt boolean;`.

If drizzle-kit names it differently (e.g. `0033_...`), use whatever number is auto-assigned. Verify the SQL looks correct.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/lib/preferences-mode-aware.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Run typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema/users.ts src/lib/preferences.ts drizzle/0032_*.sql tests/lib/preferences-mode-aware.test.ts
git commit -m "feat(local-ai): useModeAwarePrompt preference field + resolver"
```

---

## Task 9: Wire mode derivation into turn route

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Add imports at the top of the file**

In `src/app/api/sessions/[id]/turn/route.ts`, near the existing imports (around line 13):

```ts
import { deriveMode, needsSpellcastingOverlay } from '@/ai/master/mode';
import { resolveUseModeAwarePrompt } from '@/lib/preferences';
```

- [ ] **Step 2: Derive mode just before calling buildMasterSystemPrompt**

In the same file, locate the `const sys = buildMasterSystemPrompt({...})` call (around line 222). Just BEFORE it, add:

```ts
// Plan E.1: mode-aware prompt. When enabled, derive the active mode from
// engine state + check whether the active PC is a spellcaster.
const useModeAware = resolveUseModeAwarePrompt({
  aiProvider: userPrefs.aiProvider,
  useModeAwarePrompt: userPrefs.useModeAwarePrompt,
});
const mode = useModeAware ? deriveMode(snap.state) : undefined;
const needsSpellcasting = useModeAware ? needsSpellcastingOverlay(snap) : undefined;
```

- [ ] **Step 3: Pass new fields to buildMasterSystemPrompt**

In the same `buildMasterSystemPrompt` call (line 222 area), append two fields to the input object:

```ts
const sys = buildMasterSystemPrompt({
  // ... existing fields ...
  staticBlocksAlreadyBaked: baked,
  // Plan E.1: mode-aware prompt fields.
  mode,
  needsSpellcasting,
});
```

- [ ] **Step 4: Run the turn-route test suite to verify no regression**

Run: `pnpm vitest run tests/ai/master/`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/sessions/\[id\]/turn/route.ts
git commit -m "feat(local-ai): wire mode-aware prompt into turn route"
```

---

## Task 10: Settings UI toggle for `useModeAwarePrompt`

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`
- Modify: `src/app/api/campaigns/[id]/settings/route.ts`

- [ ] **Step 1: Update the settings API route to accept the new field**

In `src/app/api/campaigns/[id]/settings/route.ts`, locate the settings schema/validator (look for `compactPrompt` to find the right block). Add the new field to the request body schema:

```ts
// In the body validation (likely Zod):
useModeAwarePrompt: z.boolean().optional(),
```

And to the update payload that hits the DB.

- [ ] **Step 2: Add the toggle UI in settings-client.tsx**

In `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`, locate the "Local optimization" Eyebrow block (line 658). Just after the existing `onCompactPromptToggle` button, add a similar block for the new toggle:

```tsx
{/* Plan E.1: mode-aware prompt toggle */}
<button
  onClick={onModeAwarePromptToggle}
  disabled={disabled}
  aria-pressed={settings.useModeAwarePrompt}
  style={{
    background: settings.useModeAwarePrompt ? 'var(--arcane)' : 'transparent',
    border: '1px solid ' + (settings.useModeAwarePrompt ? 'var(--arcane)' : 'var(--border-strong)'),
    borderRadius: 999,
    color: settings.useModeAwarePrompt ? 'var(--bone)' : 'var(--fg-muted)',
    padding: '6px 12px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
  }}
>
  {settings.useModeAwarePrompt ? 'Mode-aware prompt on' : 'Mode-aware prompt off'}
</button>
```

Then add the handler near `onCompactPromptToggle` (around line 178):

```tsx
const onModeAwarePromptToggle = () => {
  const next = !settings.useModeAwarePrompt;
  setSettings((s) => ({ ...s, useModeAwarePrompt: next }));
  void save({ useModeAwarePrompt: next });
};
```

And add `useModeAwarePrompt?: boolean` to the local `settings` state type (search for `compactPrompt?: boolean` and follow the pattern).

- [ ] **Step 3: Default resolution in the UI**

If the settings component pulls defaults from the server, ensure `useModeAwarePrompt` falls back to the resolved value (`aiProvider === 'local'`) when undefined. Mirror what's done for `compactPrompt`.

- [ ] **Step 4: Manual smoke test (browser)**

Run: `pnpm dev`
Open: <http://localhost:3000/campaigns/[some-test-campaign]/settings>
Verify:
- The "Mode-aware prompt" toggle appears in the "Local optimization" card.
- Clicking it persists across page reload.
- The aria-pressed attribute updates correctly.

(No automated E2E for this — Playwright tests are out of scope for this plan unless the repo already has one for the settings page.)

- [ ] **Step 5: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx src/app/api/campaigns/\[id\]/settings/route.ts
git commit -m "feat(local-ai): Settings UI toggle for mode-aware prompt"
```

---

## Task 11: Extend telemetry — log mode + needsSpellcasting

**Files:**
- Modify: `src/ai/master/usage.ts`
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Inspect the current `recordUsage` signature**

Read `src/ai/master/usage.ts` to see what fields `recordUsage` accepts. Add two optional fields:

```ts
export interface RecordUsageInput {
  // ... existing fields ...
  /** Plan E.1: master mode at turn execution time. */
  mode?: 'combat' | 'exploration' | 'narrative';
  /** Plan E.1: whether the spellcasting overlay was injected this turn. */
  needsSpellcasting?: boolean;
}
```

Update the function body so the new fields are persisted (likely an INSERT into a `master_usage` table — add the column if the schema requires it, or write them into a JSON metadata column if one exists).

- [ ] **Step 2: If a DB column is needed, add the migration**

If `master_usage` (or equivalent) needs new columns, add:

```ts
mode: text('mode'),
needsSpellcasting: boolean('needs_spellcasting'),
```

Then `pnpm db:generate`.

If the table has a JSON `metadata` column, just stuff them in there and skip the migration.

- [ ] **Step 3: Pass the new fields from the turn route**

In `src/app/api/sessions/[id]/turn/route.ts`, locate where `recordUsage` is called after a turn completes (search for `recordUsage(`). Pass:

```ts
await recordUsage({
  // ... existing fields ...
  mode,
  needsSpellcasting,
});
```

- [ ] **Step 4: Typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/master/usage.ts src/app/api/sessions/\[id\]/turn/route.ts drizzle/*
git commit -m "feat(local-ai): telemetry — log mode + needsSpellcasting per turn"
```

---

## Task 12: Re-bake all installed models with new slim manifest

**Files:** (no code changes — operational step)

- [ ] **Step 1: Verify build script still works**

Run: `pnpm build-local-models --dry-run`
Expected: For each installed buildable base, writes a `.ollama/dnd-master-*.Modelfile`. The SYSTEM block should contain the slim variants and SRD context, but NOT world_lore and NOT roll_triggers.

Inspect one of the generated files manually:
```bash
head -50 .ollama/dnd-master-qwen3_30b-a3b.Modelfile
```

Expected: SYSTEM block opens with `# ROLE` (BASE_SLIM), not `# MASTER SYSTEM PROMPT` (the old full variant).

- [ ] **Step 2: Run the real re-bake**

Run: `pnpm build-local-models --force`
Expected: All installed bases get re-baked. Each `ollama create dnd-master-<base>` reports success.

This may take 5-20 minutes depending on how many bases are installed.

- [ ] **Step 3: Verify a baked model still responds**

In a separate terminal:
```bash
ollama run dnd-master-qwen3_30b-a3b "Say 'hello' in one word."
```
Expected: a one-word response (no chain-of-thought, no error).

- [ ] **Step 4: Run the live smoke test if available**

Run: `pnpm vitest run tests/ai/master/live-smoke.test.ts`
Expected: PASS (this test exercises a real Ollama call; may be opt-in via `OLLAMA_SMOKE=1`).

- [ ] **Step 5: No commit needed**

The re-bake doesn't change source code — it just regenerates the local Ollama models. The bumped `MASTER_PROMPT_VERSION` in Task 7 already triggered the staleness UI for users who re-pull.

---

## Task 13: End-to-end mode transition test

**Files:**
- Test: `tests/ai/master/system-prompt.mode-transition.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ai/master/system-prompt.mode-transition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';
import { deriveMode, needsSpellcastingOverlay } from '@/ai/master/mode';
import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

function buildPrompt(state: EngineState, snap: Partial<SnapshotForModel> = {}) {
  const fullSnap: SnapshotForModel = {
    state,
    characterMonoSpace: '{}',
    scene: '',
    language: 'en',
    party: [],
    currentPlayerCharacterId: null,
    ...snap,
  } as SnapshotForModel;
  return buildMasterSystemPrompt({
    handbook: '',
    worldLore: '',
    srdContext: '',
    characterMonoSpace: fullSnap.characterMonoSpace,
    scene: fullSnap.scene,
    language: 'en',
    manualRolls: false,
    masterGuidanceLevel: 'balanced',
    showDifficultyNumbers: true,
    narrationPace: 'standard',
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    tonalFrame: null,
    engagementProfile: [],
    party: fullSnap.party,
    currentPlayerCharacterId: fullSnap.currentPlayerCharacterId,
    usesMetaTools: true,
    staticBlocksAlreadyBaked: true,
    mode: deriveMode(state),
    needsSpellcasting: needsSpellcastingOverlay(fullSnap),
  });
}

function asText(prompt: ReturnType<typeof buildPrompt>): string {
  return prompt.system.map((b) => b.text).join('\n\n');
}

describe('mode transitions through a session', () => {
  it('narrative → combat → narrative', () => {
    const narrative: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '', travel: undefined, tonalFrame: null, engagementProfile: [],
    } as EngineState;
    expect(asText(buildPrompt(narrative))).toMatch(/MODE: NARRATIVE/);

    const combat: EngineState = {
      ...narrative,
      combat: { round: 1, turnOrder: [{ actorId: 'pc1', initiative: 15 }], currentIdx: 0 },
    } as EngineState;
    expect(asText(buildPrompt(combat))).toMatch(/MODE: COMBAT/);

    const afterCombat: EngineState = { ...combat, combat: null } as EngineState;
    expect(asText(buildPrompt(afterCombat))).toMatch(/MODE: NARRATIVE/);
  });

  it('exploration en route → combat (ambush) → exploration', () => {
    const exploration: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '',
      travel: { pace: 'Normal', lightLevel: 'bright', marchingOrder: [] } as any,
      tonalFrame: null, engagementProfile: [],
    } as EngineState;
    expect(asText(buildPrompt(exploration))).toMatch(/MODE: EXPLORATION/);

    const ambush: EngineState = {
      ...exploration,
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
    } as EngineState;
    // Combat wins over travel.
    expect(asText(buildPrompt(ambush))).toMatch(/MODE: COMBAT/);

    const resume: EngineState = { ...ambush, combat: null } as EngineState;
    expect(asText(buildPrompt(resume))).toMatch(/MODE: EXPLORATION/);
  });

  it('spellcaster active → overlay appears; non-caster active → no overlay', () => {
    const state: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '', travel: undefined, tonalFrame: null, engagementProfile: [],
    } as EngineState;

    const withCaster = buildPrompt(state, {
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(asText(withCaster)).toMatch(/OVERLAY: SPELLCASTING/);

    const withFighter = buildPrompt(state, {
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: null } as any],
    });
    expect(asText(withFighter)).not.toMatch(/OVERLAY: SPELLCASTING/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run tests/ai/master/system-prompt.mode-transition.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/ai/master/system-prompt.mode-transition.test.ts
git commit -m "test(local-ai): E2E mode-transition snapshot tests"
```

---

## Task 14: Documentation update

**Files:**
- Modify: README or docs/local-ai/README.md (whichever exists)

- [ ] **Step 1: Find the right doc**

Run: `find . -name "README*.md" -not -path "*/node_modules/*" | head -10`

Likely targets: top-level `README.md`, `docs/README.md`, or a local-ai-specific README.

- [ ] **Step 2: Add a Plan E.1 section**

Append a section to the doc explaining:

```markdown
### Plan E.1 — Mode-aware prompt (local provider)

The local provider can ship a smaller per-turn prompt by loading only
the mode block relevant to the current scene type:

- **combat**: tactical priming, opportunity attacks, concentration.
- **exploration**: travel pace, vision, marching order.
- **narrative**: scene framing, social DCs, combat-initiation sub-block.

Plus a conditional **spellcasting overlay** when the active PC is a caster.

Enable via Settings → Local optimization → "Mode-aware prompt" (default ON
for local). Combine with Plan C "Compact prompt" and Plan D "Baked models"
for ~9K context window (vs ~15K with B+C+D alone) — see
[design doc](docs/superpowers/specs/2026-05-16-mode-aware-rag-prompt-design.md).

After enabling, re-bake your installed models:
\```bash
pnpm build-local-models --force
\```

To validate the optimization, check the telemetry for `prompt_eval_count`
per `(mode, model)` tuple in the master_usage table.
```

- [ ] **Step 3: Commit**

```bash
git add README.md  # or docs/local-ai/README.md, whichever was modified
git commit -m "docs(local-ai): document Plan E.1 mode-aware prompt setup"
```

---

## Self-review checklist

After all 14 tasks are complete, verify:

- [ ] **Spec coverage**: every section of the design doc's "Plan E.1" scope is implemented (mode derivation, 4 mode blocks, slim baked manifest, Settings toggle, telemetry). RAG is intentionally out of scope (Plan E.2).
- [ ] **Token budget tests pass**: `pnpm vitest run tests/ai/master/system-prompt.token-budget.test.ts` — green.
- [ ] **No regression on existing tests**: `pnpm vitest run` — full suite green.
- [ ] **Typecheck**: `pnpm tsc --noEmit` — green.
- [ ] **Lint** (if configured): `pnpm lint` — green.
- [ ] **Settings UI manual smoke**: toggle persists, the badge shows the right state.
- [ ] **Re-baked models work**: one cold start + one warm turn succeed without truncation.
- [ ] **Telemetry visible**: a test turn writes mode/needsSpellcasting into the usage table.

---

## Acceptance criteria (Step 1 done)

- Median `promptEvalCount` per `(mode, model)` is within 10% of the design's wire budget (telemetry-verified after a day of dev usage).
- No regression in tool-call sequences vs. the pre-Plan-E.1 behaviour on a smoke session (start narrative → ambush → 3 combat turns → end → travel → long rest).
- Settings toggle works and persists.
- All tests green.

When all of the above hold, Plan E.1 is ready to merge to `feat/local-meta-tools`. Plan E.2 (RAG retrieval) can then be written and implemented in a separate worktree.
