# Coverage 90% — Tier 1 Phase 3: Action Economy & Standard Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare il combat tracker da "round + turnOrder" a un vero motore di action economy: tracciamento di action/bonus action/reaction/movimento usati, gli 8 standard actions implementati come tool (Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use Object), e opportunity attack auto-trigger quando un nemico esce dal reach senza Disengage. Sblocca ~10 punti coverage portando l'area Combat da 45% a ~70%.

**Architecture:**
- **TurnState** persistente per attore: `{ actionUsed, bonusUsed, reactionUsed, movementSpentFt, freeInteractionsUsed }`. Resetta automaticamente quando l'attore inizia un nuovo turno (mutation `start_turn` emessa da `advance_turn`).
- **Take action** tool unificato: `take_action({ actorId, kind, target?, dc? })` valida budget + applica effetti (Dash raddoppia speed; Disengage flag; Dodge flag; Hide → stealth check; Help → grant adv; Search → perception; Ready → store trigger).
- **Position model "distance bands"**: ogni attore ha `position?: { band: 'engaged' | 'near' | 'far' | 'distant'; engagedWith?: string[] }`. Niente griglia 5ft; bande astratte. "engaged" = entro melee reach di un nemico.
- **Opportunity attack auto-trigger**: quando un attore esce dalla band `engaged`, l'engine emette `opportunity_attack_triggered` mutations per ogni nemico che lo aveva engaged (a meno che non si sia usato Disengage o teleport). Il tool `make_attack` consuma una reaction del nemico se accetta.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: `turn_state` + `position` columns). Builds on Phase 1 + 2.

---

## File Structure (Phase 3)

### File da creare:
- `src/engine/combat/turn-state.ts` — types + helpers (newTurnState, consumeAction, consumeMovement, canMove)
- `src/engine/combat/positioning.ts` — distance bands + engagement helpers
- `src/engine/combat/standard-actions.ts` — handler factory per i 7 standard actions risolvibili (escluso Attack/Cast — già esistenti)
- `tests/engine/combat/turn-state.test.ts`
- `tests/engine/combat/positioning.test.ts`
- `tests/engine/combat/standard-actions.test.ts`
- `tests/engine/scenarios/action-economy-loop.test.ts` — E2E
- `drizzle/0013_*.sql` — migration

### File da modificare:
- `src/engine/types.ts` — `TurnState`, `Position`, ops `start_turn`, `consume_action`, `consume_movement`, `take_dodge`, `take_disengage`, `take_dash`, `take_ready`, `opportunity_attack_triggered`
- `src/engine/combat/turn.ts` — emit `start_turn` su advance_turn
- `src/sessions/applicator.ts` — handler per i nuovi mutation ops
- `src/sessions/snapshot.ts` — hydrate turnState + position
- `src/db/schema/session-state.ts` — colonne turn_state, position
- `src/db/schema/combat-actors.ts` — aggiungere position su monsters
- `src/engine/combat/attack.ts` — consume action budget; check Dodge/Disengage flags from target/attacker runtime
- `src/engine/combat/movement.ts` (nuovo? o estensione di positioning) — `move_to_band` con auto-OA detection
- `src/engine/spells.ts` — consume action/bonus action su cast (in base a casting_time del binding)
- `src/engine/tools/handlers.ts` — `take_action`, `move_to_band` (e relativi helper)
- `src/engine/tools/index.ts` — schema dei nuovi tool
- `src/ai/master/system-prompt.ts` — guidance action economy + OA + standard actions

---

## Roadmap macro aggiornata

| Phase | Status | Coverage |
|---|---|---|
| ✅ Phase 1: Conditions + Death Saves | Done | +25 |
| ✅ Phase 2 + 2.5 hotfix: Concentration + Spell Engine | Done | +15 |
| **Phase 3 (questo piano)** | 📝 In corso | +10 |
| Phase 4: Inspiration + Long Rest + Auto-Exhaustion | da pianificare | +5 |
| Phase 5: Magic Item Rarity + Attunement | da pianificare | +6 |
| Phase 6: Exploration Layer | da pianificare | +8 |
| Phase 7: NPC Three-Beat + Tonal Frame | da pianificare | +3 |

---

## Task 1: Types + turn-state helpers (TDD)

**Files:**
- Create: `src/engine/combat/turn-state.ts`
- Create: `tests/engine/combat/turn-state.test.ts`
- Modify: `src/engine/types.ts`

### - [ ] Step 1: Aggiungere types

In `src/engine/types.ts`:

```ts
export interface TurnState {
  actionUsed: boolean;
  bonusUsed: boolean;
  reactionUsed: boolean;
  movementSpentFt: number;
  freeInteractionsUsed: number;
  /** True if the actor has Dodge active until their next turn. */
  dodging: boolean;
  /** True if the actor used Disengage this turn (no OAs from movement). */
  disengaged: boolean;
  /** True if the actor used Dash this turn (effective speed × 2). */
  dashed: boolean;
  /** Stored Ready action: trigger description + planned action. */
  readied?: { trigger: string; action: string };
}

export type Position = {
  /** Abstract distance band from the action focus. */
  band: 'engaged' | 'near' | 'far' | 'distant';
  /** IDs of hostile actors currently within melee reach (engagement). */
  engagedWith: string[];
};

// Add to ActorRuntimeState:
export interface ActorRuntimeState {
  // ...existing
  turnState?: TurnState;
  position?: Position;
}

// Add to Mutation union:
export type Mutation =
  // existing ...
  | { op: 'start_turn'; actorId: string }
  | { op: 'consume_action'; actorId: string; kind: 'action' | 'bonus' | 'reaction' }
  | { op: 'consume_movement'; actorId: string; feet: number }
  | { op: 'take_dodge'; actorId: string }
  | { op: 'take_disengage'; actorId: string }
  | { op: 'take_dash'; actorId: string; extraSpeedFt: number }
  | { op: 'set_readied'; actorId: string; trigger: string; action: string }
  | { op: 'set_position'; actorId: string; position: Position }
  | { op: 'opportunity_attack_triggered'; attackerId: string; targetId: string };
```

### - [ ] Step 2: Test helpers

File: `tests/engine/combat/turn-state.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  newTurnState,
  canConsumeAction,
  consumeAction,
  canMoveFurther,
  spendMovement,
  resetForNewTurn,
} from '../../../src/engine/combat/turn-state';

describe('turn-state — newTurnState', () => {
  it('creates fresh state with no resources used', () => {
    const ts = newTurnState();
    expect(ts).toEqual({
      actionUsed: false,
      bonusUsed: false,
      reactionUsed: false,
      movementSpentFt: 0,
      freeInteractionsUsed: 0,
      dodging: false,
      disengaged: false,
      dashed: false,
    });
  });
});

describe('turn-state — canConsumeAction', () => {
  it('true when action not yet used', () => {
    expect(canConsumeAction(newTurnState(), 'action')).toBe(true);
  });
  it('false when action already used', () => {
    const ts = { ...newTurnState(), actionUsed: true };
    expect(canConsumeAction(ts, 'action')).toBe(false);
  });
  it('reactions tracked separately', () => {
    const ts = { ...newTurnState(), actionUsed: true, bonusUsed: true };
    expect(canConsumeAction(ts, 'reaction')).toBe(true);
  });
});

describe('turn-state — consumeAction', () => {
  it('marks action used', () => {
    const next = consumeAction(newTurnState(), 'action');
    expect(next.actionUsed).toBe(true);
    expect(next.bonusUsed).toBe(false);
  });
  it('returns same state if already used (idempotent)', () => {
    const ts = { ...newTurnState(), actionUsed: true };
    const next = consumeAction(ts, 'action');
    expect(next).toEqual(ts);
  });
});

describe('turn-state — movement', () => {
  it('canMoveFurther true within speed', () => {
    expect(canMoveFurther(newTurnState(), 30, 10)).toBe(true);
  });
  it('false when would exceed speed', () => {
    const ts = { ...newTurnState(), movementSpentFt: 25 };
    expect(canMoveFurther(ts, 30, 10)).toBe(false);
  });
  it('Dash doubles effective budget', () => {
    const ts = { ...newTurnState(), dashed: true, movementSpentFt: 30 };
    expect(canMoveFurther(ts, 30, 25)).toBe(true);  // total 55 ≤ 60 (30×2)
  });
  it('spendMovement increments counter', () => {
    const next = spendMovement(newTurnState(), 15);
    expect(next.movementSpentFt).toBe(15);
  });
});

describe('turn-state — resetForNewTurn', () => {
  it('zeroes everything except readied', () => {
    const used: TurnState = {
      actionUsed: true, bonusUsed: true, reactionUsed: true,
      movementSpentFt: 30, freeInteractionsUsed: 1,
      dodging: true, disengaged: true, dashed: true,
      readied: { trigger: 'enemy enters', action: 'Attack' },
    };
    const reset = resetForNewTurn(used);
    expect(reset.actionUsed).toBe(false);
    expect(reset.bonusUsed).toBe(false);
    expect(reset.movementSpentFt).toBe(0);
    expect(reset.dodging).toBe(false);
    // readied PERSISTS until trigger fires or actor's turn comes again
    expect(reset.readied).toBeUndefined(); // actually clear when it's THE actor's new turn
  });
});
```

### - [ ] Step 3: Run, expect FAIL

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/action-economy && pnpm test combat/turn-state
```

### - [ ] Step 4: Implement

```ts
// src/engine/combat/turn-state.ts
import type { TurnState } from '../types';

export function newTurnState(): TurnState {
  return {
    actionUsed: false, bonusUsed: false, reactionUsed: false,
    movementSpentFt: 0, freeInteractionsUsed: 0,
    dodging: false, disengaged: false, dashed: false,
  };
}

export function canConsumeAction(state: TurnState, kind: 'action' | 'bonus' | 'reaction'): boolean {
  switch (kind) {
    case 'action': return !state.actionUsed;
    case 'bonus': return !state.bonusUsed;
    case 'reaction': return !state.reactionUsed;
  }
}

export function consumeAction(state: TurnState, kind: 'action' | 'bonus' | 'reaction'): TurnState {
  if (!canConsumeAction(state, kind)) return state;
  const map = { action: 'actionUsed', bonus: 'bonusUsed', reaction: 'reactionUsed' } as const;
  return { ...state, [map[kind]]: true };
}

export function canMoveFurther(state: TurnState, baseSpeedFt: number, additionalFt: number): boolean {
  const budget = state.dashed ? baseSpeedFt * 2 : baseSpeedFt;
  return state.movementSpentFt + additionalFt <= budget;
}

export function spendMovement(state: TurnState, feet: number): TurnState {
  return { ...state, movementSpentFt: state.movementSpentFt + feet };
}

export function resetForNewTurn(_state: TurnState): TurnState {
  // A new turn = fresh state. Readied actions persist OUTSIDE the turn (they fire on trigger),
  // so they're cleared on actor's new turn (this function is called when the actor becomes active again).
  return newTurnState();
}
```

### - [ ] Step 5: Run, expect PASS, commit

```bash
pnpm test combat/turn-state
pnpm typecheck
git add src/engine/combat/turn-state.ts tests/engine/combat/turn-state.test.ts src/engine/types.ts
git commit -m "feat(combat): TurnState + helpers for action economy tracking"
```

---

## Task 2: Positioning helpers (distance bands)

**Files:**
- Create: `src/engine/combat/positioning.ts`
- Create: `tests/engine/combat/positioning.test.ts`

### - [ ] Step 1: Test

```ts
import { describe, expect, it } from 'vitest';
import {
  initialPosition,
  isEngaged,
  movementProvokesOA,
  enterEngagement,
  leaveEngagement,
  bandTransitionDistance,
} from '../../../src/engine/combat/positioning';

describe('positioning — initialPosition', () => {
  it('returns near band by default with no engagement', () => {
    expect(initialPosition()).toEqual({ band: 'near', engagedWith: [] });
  });
});

describe('positioning — isEngaged', () => {
  it('true when engagedWith non-empty', () => {
    expect(isEngaged({ band: 'engaged', engagedWith: ['m1'] })).toBe(true);
  });
  it('false when not engaged', () => {
    expect(isEngaged({ band: 'near', engagedWith: [] })).toBe(false);
  });
});

describe('positioning — movementProvokesOA', () => {
  it('true when leaving engagement without disengage', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1'] };
    const to = { band: 'near' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, false)).toEqual(['m1']);
  });
  it('false when disengaged', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1'] };
    const to = { band: 'near' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, true)).toEqual([]);
  });
  it('false when not engaged', () => {
    const from = { band: 'near' as const, engagedWith: [] };
    const to = { band: 'far' as const, engagedWith: [] };
    expect(movementProvokesOA(from, to, false)).toEqual([]);
  });
  it('only the enemies you LEFT trigger', () => {
    const from = { band: 'engaged' as const, engagedWith: ['m1', 'm2'] };
    const to = { band: 'engaged' as const, engagedWith: ['m2'] };  // moved out of m1's reach
    expect(movementProvokesOA(from, to, false)).toEqual(['m1']);
  });
});

describe('positioning — bandTransitionDistance', () => {
  it('engaged → near = 5 ft', () => {
    expect(bandTransitionDistance('engaged', 'near')).toBe(5);
  });
  it('near → far = 25 ft', () => {
    expect(bandTransitionDistance('near', 'far')).toBe(25);
  });
  it('far → distant = 60 ft', () => {
    expect(bandTransitionDistance('far', 'distant')).toBe(60);
  });
  it('same band = 0', () => {
    expect(bandTransitionDistance('near', 'near')).toBe(0);
  });
  it('skipping a band sums', () => {
    expect(bandTransitionDistance('engaged', 'far')).toBe(5 + 25);
  });
});
```

### - [ ] Step 2: Implement

```ts
// src/engine/combat/positioning.ts
import type { Position } from '../types';

export function initialPosition(): Position {
  return { band: 'near', engagedWith: [] };
}

export function isEngaged(p: Position): boolean {
  return p.engagedWith.length > 0;
}

export function movementProvokesOA(from: Position, to: Position, disengaged: boolean): string[] {
  if (disengaged) return [];
  if (!isEngaged(from)) return [];
  // Anyone who WAS engaging us but ISN'T anymore triggers an OA.
  return from.engagedWith.filter((id) => !to.engagedWith.includes(id));
}

export function enterEngagement(p: Position, enemyId: string): Position {
  if (p.engagedWith.includes(enemyId)) return p;
  return { band: 'engaged', engagedWith: [...p.engagedWith, enemyId] };
}

export function leaveEngagement(p: Position, enemyId: string): Position {
  const next = p.engagedWith.filter((id) => id !== enemyId);
  return { band: next.length > 0 ? 'engaged' : p.band === 'engaged' ? 'near' : p.band, engagedWith: next };
}

const BAND_ORDER: Position['band'][] = ['engaged', 'near', 'far', 'distant'];
const INTERVAL: Record<string, number> = {
  'engaged-near': 5, 'near-engaged': 5,
  'near-far': 25, 'far-near': 25,
  'far-distant': 60, 'distant-far': 60,
};

export function bandTransitionDistance(from: Position['band'], to: Position['band']): number {
  if (from === to) return 0;
  const fromIdx = BAND_ORDER.indexOf(from);
  const toIdx = BAND_ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return 0;
  let total = 0;
  if (fromIdx < toIdx) {
    for (let i = fromIdx; i < toIdx; i++) total += INTERVAL[`${BAND_ORDER[i]}-${BAND_ORDER[i + 1]}`] ?? 0;
  } else {
    for (let i = fromIdx; i > toIdx; i--) total += INTERVAL[`${BAND_ORDER[i]}-${BAND_ORDER[i - 1]}`] ?? 0;
  }
  return total;
}
```

### - [ ] Step 3: Commit

```bash
pnpm test combat/positioning
pnpm typecheck
git add src/engine/combat/positioning.ts tests/engine/combat/positioning.test.ts
git commit -m "feat(combat): distance-band positioning + OA detection helpers"
```

---

## Task 3: Applicator handlers + migration

**Files:**
- Modify: `src/engine/types.ts` (already done in Task 1, finalize)
- Modify: `src/db/schema/session-state.ts`, `src/db/schema/combat-actors.ts`
- Create: `drizzle/0013_*.sql`
- Modify: `src/sessions/snapshot.ts` (hydrate)
- Modify: `src/sessions/applicator.ts` (handlers)
- Extend: `tests/sessions/applicator.test.ts`

### - [ ] Step 1: Schema additions

```ts
// session-state.ts
turnState: jsonb('turn_state').$type<TurnState | null>().default(null),
position: jsonb('position').$type<Position | null>().default(null),

// combat-actors.ts
turnState: jsonb('turn_state').$type<TurnState | null>().default(null),
position: jsonb('position').$type<Position | null>().default(null),
```

### - [ ] Step 2: Generate + apply migration

```bash
pnpm db:generate  # produces 0013_*.sql
pnpm db:migrate
```

### - [ ] Step 3: Snapshot hydration

In `src/sessions/snapshot.ts`, add `turnState: row.turnState ?? undefined; position: row.position ?? undefined`.

### - [ ] Step 4: Applicator handlers

For each new mutation op, add a switch case. They all conform to existing pattern:

- `start_turn`: reset `turnState = newTurnState()`. Clear `readied` on this actor.
- `consume_action`: lookup current turnState (or newTurnState()), apply `consumeAction(state, kind)`, write back.
- `consume_movement`: turnState.movementSpentFt += feet.
- `take_dodge`: turnState.dodging = true (and consume_action).
- `take_disengage`: turnState.disengaged = true (and consume_action).
- `take_dash`: turnState.dashed = true (and consume_action). Note: this doesn't grant extra movement directly; movement budget is doubled when dashed.
- `set_readied`: turnState.readied = {trigger, action}.
- `set_position`: write position object.
- `opportunity_attack_triggered`: pure signal (no state change). The AI Master is expected to follow up with `make_attack` for the OA-eligible attacker (consuming a reaction).

### - [ ] Step 5: Tests for applicator

Add 8 new tests in `tests/sessions/applicator.test.ts` covering each new mutation op end-to-end.

### - [ ] Step 6: Commit

```bash
pnpm test sessions/applicator
pnpm typecheck
git add src/db/schema/ drizzle/ src/sessions/applicator.ts src/sessions/snapshot.ts tests/sessions/applicator.test.ts
git commit -m "feat(applicator): persist turnState + position; 8 new mutation handlers"
```

---

## Task 4: Integrate with `advance_turn` and `make_attack`

**Files:**
- Modify: `src/engine/combat/turn.ts` — emit start_turn for next actor
- Modify: `src/engine/combat/attack.ts` — consume action; check Dodge target flag
- Modify: `tests/engine/combat/turn.test.ts`
- Modify: `tests/engine/combat/attack.test.ts`

### - [ ] Step 1: turn.ts emits start_turn

In `endTurn`:
```ts
return {
  ok: true,
  data: { nextActorId, newRound: isLast, round: nextRound },
  rolls: [],
  mutations: [
    { op: 'advance_turn' },
    { op: 'start_turn', actorId: nextActorId },
  ],
};
```

Tests: verify both mutations emitted in order.

### - [ ] Step 2: attack.ts integration

Two points:
a) `make_attack` consumes attacker's action. If `attackerRuntime.turnState?.actionUsed`, return ok:false unless input has `useReaction: true` (for OA).
b) If target.runtime.turnState?.dodging, attacker has DIS (unless attacker already has ADV → cancel).

Add tests for both.

### - [ ] Step 3: Commit

---

## Task 5: take_action tool

**Files:**
- Create: `src/engine/combat/standard-actions.ts`
- Create: `tests/engine/combat/standard-actions.test.ts`
- Modify: `src/engine/tools/handlers.ts`, `index.ts`

### - [ ] Step 1: Standard-actions handler factory

```ts
// src/engine/combat/standard-actions.ts

export type StandardActionKind = 'dash' | 'disengage' | 'dodge' | 'help' | 'hide' | 'ready' | 'search' | 'use_object';

export interface StandardActionInput {
  actorId: string;
  kind: StandardActionKind;
  /** For 'help': beneficiaryId. For 'hide': skill is Stealth. For 'search': skill is Perception/Investigation. For 'ready': trigger + action. */
  beneficiaryId?: string;
  trigger?: string;
  readyAction?: string;
  /** DC for hide/search (Master-set). */
  dc?: number;
  /** Use bonus action instead of action (for some classes' rogue Cunning Action: Dash/Disengage/Hide as bonus). */
  useBonusAction?: boolean;
}

export interface StandardActionOutput {
  ok: boolean;
  error?: string;
  mutations: Mutation[];
  /** For hide/search: the d20 roll info; AI Master consumes via separate ability_check tool ideally. */
  rollNeeded?: { ability: 'DEX' | 'WIS'; skill: 'Stealth' | 'Perception' | 'Investigation'; dc: number };
}

export function resolveStandardAction(input: StandardActionInput, runtime: ActorRuntimeState | undefined): StandardActionOutput {
  // Validate budget: action OR bonus action
  const ts = runtime?.turnState ?? newTurnState();
  const kind: 'action' | 'bonus' = input.useBonusAction ? 'bonus' : 'action';
  if (!canConsumeAction(ts, kind)) {
    return { ok: false, error: `${kind} already used`, mutations: [] };
  }

  const muts: Mutation[] = [{ op: 'consume_action', actorId: input.actorId, kind }];
  switch (input.kind) {
    case 'dash':
      muts.push({ op: 'take_dash', actorId: input.actorId, extraSpeedFt: 0 /* speed is doubled effectively in turnState.dashed */ });
      break;
    case 'disengage':
      muts.push({ op: 'take_disengage', actorId: input.actorId });
      break;
    case 'dodge':
      muts.push({ op: 'take_dodge', actorId: input.actorId });
      break;
    case 'help':
      // Granting advantage: emit a 'helped' condition on the beneficiary OR a flag on the helper's runtime.
      // For Phase 3 simplicity: emit add_condition('helped' marker) on beneficiary, narrative slug.
      if (!input.beneficiaryId) return { ok: false, error: 'help requires beneficiaryId', mutations: [] };
      muts.push({
        op: 'add_condition',
        actorId: input.beneficiaryId,
        condition: { slug: 'helped' as any, source: 'help-action', durationRounds: 1, appliedRound: 0 /* set by tool */ },
      });
      break;
    case 'hide':
      return { ok: true, mutations: muts, rollNeeded: { ability: 'DEX', skill: 'Stealth', dc: input.dc ?? 10 } };
    case 'search':
      return { ok: true, mutations: muts, rollNeeded: { ability: 'WIS', skill: 'Perception', dc: input.dc ?? 10 } };
    case 'ready':
      if (!input.trigger || !input.readyAction) return { ok: false, error: 'ready requires trigger + readyAction', mutations: [] };
      muts.push({ op: 'set_readied', actorId: input.actorId, trigger: input.trigger, action: input.readyAction });
      break;
    case 'use_object':
      // Object interaction; uses an action. No extra mutation.
      break;
  }
  return { ok: true, mutations: muts };
}
```

(NB: 'helped' is a narrative slug. Add it to ConditionSlug union if needed. Or use a separate runtime flag — design choice.)

### - [ ] Step 2: Tool handler in handlers.ts

```ts
export function handleTakeAction(
  ctx: ToolCtx,
  state: EngineState,
  input: StandardActionInput,
): ActionResult<{ rollNeeded?: ... }> {
  const rt = state.runtime[input.actorId];
  const result = resolveStandardAction({ ...input }, rt);
  if (!result.ok) return { ok: false, error: result.error!, rolls: [], mutations: [] };
  return {
    ok: true,
    data: result.rollNeeded ? { rollNeeded: result.rollNeeded } : {},
    rolls: [],
    mutations: result.mutations,
  };
}
```

Add to TOOL_HANDLERS registry: `take_action`.

### - [ ] Step 3: Tool definition in index.ts

```ts
{
  name: 'take_action',
  description: 'PHB §3.5: take a standard action (Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use Object). Consumes the actor\'s action (or bonus action if useBonusAction=true for Rogue Cunning Action). Hide/Search return rollNeeded; AI Master should follow up with ability_check for the actual roll. Help applies a "helped" marker on the beneficiary granting advantage on next d20.',
  input_schema: { /* type, properties, required */ },
}
```

### - [ ] Step 4: Test

`tests/engine/combat/standard-actions.test.ts`: 16+ test cases (one per action × valid + invalid budget).

### - [ ] Step 5: Commit

---

## Task 6: Movement tool with auto-OA detection

**Files:**
- Create: `src/engine/combat/movement.ts` (or extend positioning)
- Modify: `src/engine/tools/handlers.ts`

### - [ ] Step 1: Movement helper

```ts
export interface MoveInput {
  actorId: string;
  toBand: Position['band'];
  /** Engagement transitions: who do we leave engagement with vs enter. */
  leavesEngagementWith?: string[];
  entersEngagementWith?: string[];
}

export function resolveMove(input: MoveInput, runtime: ActorRuntimeState | undefined, baseSpeedFt: number): { ok: boolean; error?: string; mutations: Mutation[] } {
  const ts = runtime?.turnState ?? newTurnState();
  const from = runtime?.position ?? initialPosition();
  const to: Position = {
    band: input.toBand,
    engagedWith: [...(from.engagedWith.filter((id) => !(input.leavesEngagementWith ?? []).includes(id))), ...(input.entersEngagementWith ?? [])],
  };
  const distance = bandTransitionDistance(from.band, input.toBand);
  if (!canMoveFurther(ts, baseSpeedFt, distance)) {
    return { ok: false, error: 'insufficient_movement', mutations: [] };
  }
  const oaTriggers = movementProvokesOA(from, to, ts.disengaged);
  const muts: Mutation[] = [
    { op: 'consume_movement', actorId: input.actorId, feet: distance },
    { op: 'set_position', actorId: input.actorId, position: to },
    ...oaTriggers.map((enemyId) => ({ op: 'opportunity_attack_triggered' as const, attackerId: enemyId, targetId: input.actorId })),
  ];
  return { ok: true, mutations: muts };
}
```

### - [ ] Step 2: Tool definition `move_to_band`

```ts
{
  name: 'move_to_band',
  description: 'PHB §3.8: move from current band to a new one. Distance bands: engaged (5ft of an enemy) → near (within 30ft of action focus) → far (within 90ft) → distant (beyond 90ft). Auto-detects opportunity attacks for engagement-leaving (unless actor used Disengage). Consumes movement budget (doubled if Dashed).',
  input_schema: { type: 'object', properties: { actorId, toBand, leavesEngagementWith, entersEngagementWith }, required: ['actorId', 'toBand'] },
}
```

### - [ ] Step 3: Test E2E with OA emission

```ts
it('moving from engaged to near triggers OA from former engager', () => {
  const state = stateWith({ pcEngaged: ['m1'] });
  const r = TOOL_HANDLERS['move_to_band'](ctx, state, { actorId: 'pc1', toBand: 'near', leavesEngagementWith: ['m1'] });
  const oa = r.mutations.find((m) => m.op === 'opportunity_attack_triggered');
  expect(oa).toMatchObject({ attackerId: 'm1', targetId: 'pc1' });
});

it('disengaged actor moving from engaged → near does NOT trigger OA', () => {
  // Actor used take_action({kind: 'disengage'}) earlier
  const state = stateWith({ pcEngaged: ['m1'], turnState: { disengaged: true } });
  const r = TOOL_HANDLERS['move_to_band'](ctx, state, { actorId: 'pc1', toBand: 'near', leavesEngagementWith: ['m1'] });
  const oa = r.mutations.find((m) => m.op === 'opportunity_attack_triggered');
  expect(oa).toBeUndefined();
});
```

### - [ ] Step 4: Commit

---

## Task 7: Action consumption in cast_spell + integrate with attack

**Files:**
- Modify: `src/engine/spells.ts` — based on casting_time of spell, emit consume_action
- Modify: `src/engine/combat/attack.ts` — emit consume_action (action by default)
- Modify: tests

### - [ ] Step 1: castSpell consumes action

Casting time (from `spellMeta` or DB lookup):
- `1 action` → consume action
- `1 bonus action` → consume bonus
- `1 reaction` → consume reaction
- `1 minute / 10 minutes / 1 hour` → outside combat; no consume

Add to `castSpell`:
```ts
const castingTime = input.spellMeta?.castingTime ?? '1 action';
const actionKind = castingTime.includes('bonus') ? 'bonus' : castingTime.includes('reaction') ? 'reaction' : castingTime.includes('action') ? 'action' : null;
const actionMutations: Mutation[] = actionKind ? [{ op: 'consume_action', actorId: input.runtime.actorId, kind: actionKind }] : [];

// PHB §8.5: bonus action spell rule — only a cantrip with 1 action casting time can be cast on the same turn.
if (actionKind === 'bonus') {
  const ts = input.runtime.turnState;
  if (ts?.actionUsed && !isCantrip) {
    return { ok: false, error: 'bonus_action_spell_rule', rolls: [], mutations: [] };
  }
}
```

### - [ ] Step 2: makeAttack consumes action

```ts
// In makeAttack, return error if attacker already used action (unless useReaction for OA)
const ts = input.attackerRuntime?.turnState;
if (ts?.actionUsed && !input.useReaction) {
  return { ok: false, error: 'action_already_used', rolls: [], mutations: [] };
}
const actionMut: Mutation = input.useReaction
  ? { op: 'consume_action', actorId: input.attacker.id, kind: 'reaction' }
  : { op: 'consume_action', actorId: input.attacker.id, kind: 'action' };
// Append to mutations
```

### - [ ] Step 3: Tests

Verify cast_spell errors when bonus-action-spell-rule violated. Verify make_attack errors when no action available. Verify OA path uses reaction.

### - [ ] Step 4: Commit

---

## Task 8: System prompt update

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

### - [ ] Step 1: New sub-section

```
### Action economy & standard actions (PHB §3.4–3.5)

Each combat turn the actor has:
- 1 Action (Attack, Cast a Spell, Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use Object).
- 1 Bonus Action (only if a feature/spell grants one; rogue Cunning Action allows Dash/Disengage/Hide as BA).
- Movement up to speed (or 2× when Dashed).
- 1 Reaction per round (off-turn capable: Opportunity Attack, Shield, Counterspell, Ready trigger).
- Free interactions (1 typical: draw weapon, open door, pick up item).

The engine tracks budget on `runtime.turnState`. If you call `make_attack` after the actor's action is used, the engine returns `action_already_used`. Same for `cast_spell` with `1 action` casting time. Use `take_action` to invoke standard actions:

- `take_action({ kind: 'dash' })` — doubles movement budget for the turn.
- `take_action({ kind: 'disengage' })` — leaving engagement does not provoke OAs this turn.
- `take_action({ kind: 'dodge' })` — incoming attacks have DIS (if you can see them); ADV on DEX saves until your next turn.
- `take_action({ kind: 'help', beneficiaryId })` — beneficiary gets ADV on their next d20 (within next round).
- `take_action({ kind: 'hide', dc })` — returns rollNeeded (DEX Stealth vs DC). Follow up with `ability_check` for the actual roll.
- `take_action({ kind: 'search', dc })` — same pattern, WIS Perception/Investigation.
- `take_action({ kind: 'ready', trigger, readyAction })` — store an action that triggers as reaction when condition met.
- `take_action({ kind: 'use_object' })` — interact with magic item / second object on turn.

For Cunning Action (rogue), pass `useBonusAction: true`.

### Positioning & opportunity attacks (PHB §3.8–3.9)

Positions are abstract distance bands: `engaged` (within melee reach of an enemy) → `near` (within 30ft) → `far` (90ft) → `distant`. To move, call `move_to_band({ actorId, toBand, leavesEngagementWith?, entersEngagementWith? })`. The engine:
- Computes distance from band transition (engaged↔near = 5ft, near↔far = 25ft, far↔distant = 60ft).
- Errors with `insufficient_movement` if the actor lacks movement budget.
- Auto-emits `opportunity_attack_triggered` mutations for each enemy you LEAVE engagement with — UNLESS you used Disengage this turn.

When you see `opportunity_attack_triggered`, optionally resolve it: call `make_attack({ ..., useReaction: true })` for the attacker (consumes their reaction). If the attacker has already used their reaction this round, the OA cannot fire.

### Bonus action spell rule (PHB §8.5)

If you cast a spell with `1 bonus action` casting time, the only other spell you can cast on the same turn is a cantrip with `1 action` casting time. The engine enforces this: a non-cantrip cast after a bonus-action spell errors `bonus_action_spell_rule`.
```

### - [ ] Step 2: Commit

---

## Task 9: E2E action economy scenarios

**Files:**
- Create: `tests/engine/scenarios/action-economy-loop.test.ts`

### - [ ] Step 1: Scenarios

```ts
describe('E2E — action economy', () => {
  it('PC uses action to attack, then move provokes OA', () => {
    // 1. Setup: PC engaged with goblin, goblin has reaction available
    // 2. PC attacks goblin (consume_action)
    // 3. PC moves to near (leavesEngagementWith=['goblin'])
    // 4. Mutations include opportunity_attack_triggered
    // 5. Goblin makes_attack with useReaction=true → consumes reaction
    // 6. Goblin's turnState.reactionUsed === true
  });
  
  it('PC uses Disengage then moves out — no OA', () => {
    // take_action({kind:'disengage'}) → turnState.disengaged
    // move_to_band → no OA mutations
  });
  
  it('PC dashes, can move 2x speed', () => {
    // take_action({kind:'dash'}) → turnState.dashed
    // move_to_band 60ft (PC speed 30) succeeds
  });
  
  it('Bonus-action healing-word then leveled spell errors', () => {
    // PC casts healing-word as bonus action
    // PC tries cast cure-wounds (1 action, leveled, not cantrip) → error bonus_action_spell_rule
  });
  
  it('Help grants advantage on beneficiary next d20', () => {
    // PC1 Helps PC2; PC2 attacks → has ADV (helped condition consulted)
  });
  
  it('Dodge target gives DIS to attacker', () => {
    // M1 Dodges; PC attacks M1 → DIS
  });
  
  it('advance_turn resets turnState for next actor', () => {
    // PC ends turn → start_turn fires for next actor → their turnState reset
  });
});
```

### - [ ] Step 2: Commit

---

## Task 10: Smoke + final review

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expect typecheck clean, all new tests pass, only pre-existing tts-cache fail.

---

## Self-review checklist

- [ ] Coverage delta misurato: combat area 45% → ~70%.
- [ ] Backward compat: Phase 1+2 tests still green; new fields opzionali.
- [ ] Idempotency: take_action twice in same turn → second errors.
- [ ] OA cap: a single reaction per round per attacker; multiple PCs leaving engagement → only first gets OA from same enemy.
- [ ] Dodge cancellation with attacker's natural ADV is correct.

---

## Stima sforzo Phase 3

- Task 1 (turn-state types/helpers): 2h
- Task 2 (positioning): 2h
- Task 3 (applicator + migration): 3h
- Task 4 (turn.ts + attack.ts integration): 2h
- Task 5 (take_action tool): 3h
- Task 6 (move_to_band + OA detection): 2.5h
- Task 7 (action consumption in cast_spell + attack): 2h
- Task 8 (system prompt): 30min
- Task 9 (E2E): 1.5h
- Task 10 (smoke): 30min

**Totale: ~19h** di un singolo developer; subagent-driven: ~2 giornate.

---

## Note di design

- **Distance bands invece di griglia**: trade-off pragmatico per single-player narrative. La griglia richiederebbe positioning UI e renderebbe il single-player più tabletop-like. Le bande sono "engaged/near/far/distant" + lista di engagedWith — sufficiente per OA detection, range checks, e la maggior parte delle decisioni tattiche.
- **OA trigger sui PCs non gestito**: il piano emette `opportunity_attack_triggered` ma lo consume è opzionale (l'AI Master decide se l'attacker accetta). Nessuna logica automatica "if NPC has reaction, fire OA" perché la decisione è narrativamente carica (potrebbe scegliere di non OA per drama).
- **Dodge incoming DIS check**: viene applicato in `attack.ts` consultando `targetRuntime.turnState?.dodging`. Phase 1 già consulta condition effects; il Dodge è un flag separato — gestiamolo come parallel hook.
- **Help: condition `helped`**: usiamo una narrative slug + duration 1 round. Il next d20 del beneficiary lo consuma. Non è perfettamente RAW (Help dura "until the end of your next turn") ma è abbastanza ravvicinato.
- **Bonus-action spell rule**: enforcement nel castSpell; richiede `spellMeta.castingTime`. L'AI Master deve passare lo spellMeta per casting_time non-`1 action`. Per gli unbound spell, fallback a "1 action" assunto.
