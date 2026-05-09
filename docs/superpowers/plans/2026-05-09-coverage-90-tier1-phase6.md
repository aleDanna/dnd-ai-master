# Coverage 90% — Tier 1 Phase 6: Exploration Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sblocca +8 punti coverage portando "Exploration/Travel/Vision/Hazards" da 18% a ~85%. Cinque pezzi:
1. Travel pace state + tools (Fast/Normal/Slow per PHB §6.1)
2. Vision/Light state + check_vision tool (darkvision/blindsight/tremorsense per PHB §6.4)
3. Falling damage tool (1d6 per 10ft max 20d6 per PHB §6.6)
4. Suffocation (hold breath: 1+CON min, then CON mod rounds at 0 HP per PHB §6.5)
5. Marching order (front/middle/back per PHB §6.2 — narrative-only flag)

**Architecture:**
- **Travel state**: `EngineState.travel?: { pace, lightLevel, marchingOrder?: { front: string[], middle: string[], back: string[] } }`. Persisted on session_state.
- **Travel pace** (PHB §6.1): Fast = 4mi/h with -5 passive Perception; Normal = 3mi/h; Slow = 2mi/h with stealth allowed. Tool `set_travel_pace({ pace })`.
- **Vision** (PHB §6.4): light levels = bright/dim/darkness. Senses tracked on Character/CombatActor: `senses?: { darkvisionFt?, blindsightFt?, tremorsenseFt?, truesightFt? }`. Tool `check_vision({ observerId, targetId, distanceFt, lightLevel })` returns `canSee/heavilyObscured/lightlyObscured` + appropriate ADV/DIS guidance for Perception.
- **Falling**: tool `apply_falling({ actorId, distanceFt })` rolls `Math.min(distanceFt / 10, 20)d6` bludgeoning + emits add_condition prone.
- **Suffocation**: tool `apply_suffocation({ actorId, secondsWithoutAir })`. Survival = max(30, (1 + conMod) * 60) seconds. After: CON mod rounds at 0 HP, then drop to 0.
- **Marching order**: simple field on travel state; informational only. Used by Master narratively.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: travel state on session_state, senses on characters + combat_actors). Builds on Phase 1-5.

---

## File Structure

### File da creare:
- `src/engine/exploration.ts` — pure helpers (travelPaceData, fallingDamageDice, suffocationSurvival, lightLevelEffects)
- `tests/engine/exploration.test.ts`
- `tests/engine/scenarios/exploration-loop.test.ts`
- `drizzle/0016_*.sql`

### File da modificare:
- `src/engine/types.ts` — TravelState, LightLevel, Senses, MarchingOrder; mutations set_travel_pace/set_light_level/set_marching_order/etc.
- `src/db/schema/session-state.ts` — colonna `travel` jsonb
- `src/db/schema/characters.ts` — colonna `senses` jsonb
- `src/db/schema/combat-actors.ts` — colonna `senses` jsonb
- `src/sessions/applicator.ts` — handlers per le nuove mutations
- `src/sessions/snapshot.ts` — hydrate travel + senses
- `src/engine/tools/handlers.ts` — set_travel_pace, check_vision, apply_falling, apply_suffocation handlers
- `src/engine/tools/index.ts` — schema dei nuovi tool
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Types + helpers

```ts
// types.ts
export type TravelPace = 'fast' | 'normal' | 'slow';
export type LightLevel = 'bright' | 'dim' | 'darkness';

export interface MarchingOrder {
  front: string[];
  middle: string[];
  back: string[];
}

export interface TravelState {
  pace?: TravelPace;
  lightLevel?: LightLevel;
  marchingOrder?: MarchingOrder;
}

export interface Senses {
  darkvisionFt?: number;
  blindsightFt?: number;
  tremorsenseFt?: number;
  truesightFt?: number;
  passivePerception?: number;  // optional override; otherwise derived from skill
}

// Add to Character + CombatActor:
senses?: Senses;

// Add to EngineState:
travel?: TravelState;

// Mutations:
| { op: 'set_travel_pace'; pace: TravelPace }
| { op: 'set_light_level'; lightLevel: LightLevel }
| { op: 'set_marching_order'; order: MarchingOrder }
| { op: 'set_senses'; actorId: string; senses: Senses }
```

```ts
// src/engine/exploration.ts
import type { TravelPace, LightLevel, Senses } from './types';

export interface TravelPaceData {
  perMinuteFt: number;
  perHourMi: number;
  perDayMi: number;
  passivePerceptionMod: number;  // -5 for Fast, 0 for Normal, 0 for Slow
  stealthAllowed: boolean;
}

export const TRAVEL_PACES: Record<TravelPace, TravelPaceData> = {
  fast: { perMinuteFt: 400, perHourMi: 4, perDayMi: 30, passivePerceptionMod: -5, stealthAllowed: false },
  normal: { perMinuteFt: 300, perHourMi: 3, perDayMi: 24, passivePerceptionMod: 0, stealthAllowed: false },
  slow: { perMinuteFt: 200, perHourMi: 2, perDayMi: 18, passivePerceptionMod: 0, stealthAllowed: true },
};

/** PHB §6.6: 1d6 per 10 ft fallen, max 20d6, plus prone. */
export function fallingDamageFormula(distanceFt: number): { dice: number; sides: 6; max: number } {
  const dice = Math.min(20, Math.floor(distanceFt / 10));
  return { dice, sides: 6, max: dice * 6 };
}

/** PHB §6.5: hold breath = max(30 sec, (1 + conMod) minutes). 
 *  After: conMod rounds (min 1) at 0 HP, then drop to 0 and start dying. */
export interface SuffocationOutcome {
  holdBreathSeconds: number;
  postBreathRounds: number;
}

export function suffocationSurvival(conMod: number): SuffocationOutcome {
  return {
    holdBreathSeconds: Math.max(30, (1 + conMod) * 60),
    postBreathRounds: Math.max(1, conMod),
  };
}

/** PHB §6.4 light level effects on Perception checks relying on sight. */
export interface VisionEffects {
  perceptionDisadvantage: boolean;
  effectivelyBlinded: boolean;
}

export function lightEffects(level: LightLevel, observerSenses: Senses, distanceFt: number): VisionEffects {
  // Bright light: normal vision.
  if (level === 'bright') return { perceptionDisadvantage: false, effectivelyBlinded: false };
  
  // Darkvision: see in dim as if bright; darkness as if dim (still DIS for Perception).
  // Truesight overrides everything within range.
  if ((observerSenses.truesightFt ?? 0) >= distanceFt) {
    return { perceptionDisadvantage: false, effectivelyBlinded: false };
  }
  
  if (level === 'dim') {
    // Dim light = lightly obscured: DIS on Perception relying on sight.
    // BUT darkvision treats dim as bright if within range.
    if ((observerSenses.darkvisionFt ?? 0) >= distanceFt) {
      return { perceptionDisadvantage: false, effectivelyBlinded: false };
    }
    return { perceptionDisadvantage: true, effectivelyBlinded: false };
  }
  
  // Darkness = heavily obscured: effectively blinded.
  // Darkvision sees darkness as dim → still DIS for Perception, not blinded.
  if ((observerSenses.darkvisionFt ?? 0) >= distanceFt) {
    return { perceptionDisadvantage: true, effectivelyBlinded: false };
  }
  // No darkvision: effectively blinded.
  return { perceptionDisadvantage: true, effectivelyBlinded: true };
}
```

Tests for each helper. Commit: `feat(exploration): travel pace + falling + suffocation + vision helpers`.

---

## Task 2: Schema + applicator + migration 0016

Add columns:
- `session_state.travel` jsonb default null
- `characters.senses` jsonb default null
- `combat_actors.senses` jsonb default null

Generate migration. Apply.

Applicator handlers (4 new):
```ts
case 'set_travel_pace': {
  // Read current travel object, merge pace
  const [s] = await tx.select({ travel: sessionStateTable.travel }).from(...);
  const next = { ...(s?.travel ?? {}), pace: m.pace };
  await tx.update(sessionStateTable).set({ travel: next }).where(...);
  break;
}
case 'set_light_level': /* similar */
case 'set_marching_order': /* similar */
case 'set_senses': {
  // Update characters or combat_actors row based on actorId
}
```

Snapshot hydration: `state.travel = row.travel ?? undefined; character.senses = ...; combatActor.senses = ...`.

Tests. Commit.

---

## Task 3: Tools

### check_vision

```ts
export function handleCheckVision(
  ctx: ToolCtx, state: EngineState,
  input: { observer: string; distanceFt: number; lightLevel?: LightLevel },
): ActionResult<{ canSee: boolean; perceptionDisadvantage: boolean; effectivelyBlinded: boolean; senseUsed?: string }> {
  const obs = state.characters.find((c) => c.id === input.observer)
    ?? state.combatActors.find((a) => a.id === input.observer);
  if (!obs) return { ok: false, error: 'unknown_observer', rolls: [], mutations: [] };
  
  const senses = obs.senses ?? {};
  const lightLevel = input.lightLevel ?? state.travel?.lightLevel ?? 'bright';
  const fx = lightEffects(lightLevel, senses, input.distanceFt);
  
  // Tremorsense / blindsight don't depend on light:
  if ((senses.blindsightFt ?? 0) >= input.distanceFt) {
    return { ok: true, data: { canSee: true, perceptionDisadvantage: false, effectivelyBlinded: false, senseUsed: 'blindsight' }, rolls: [], mutations: [] };
  }
  if ((senses.tremorsenseFt ?? 0) >= input.distanceFt) {
    return { ok: true, data: { canSee: true, perceptionDisadvantage: false, effectivelyBlinded: false, senseUsed: 'tremorsense' }, rolls: [], mutations: [] };
  }
  
  return {
    ok: true,
    data: {
      canSee: !fx.effectivelyBlinded,
      perceptionDisadvantage: fx.perceptionDisadvantage,
      effectivelyBlinded: fx.effectivelyBlinded,
      senseUsed: 'sight',
    },
    rolls: [], mutations: [],
  };
}
```

### apply_falling

```ts
export function handleApplyFalling(
  ctx: { rng: () => number }, state: EngineState,
  input: { actor: string; distanceFt: number },
): ActionResult<{ damage: number; prone: boolean }> {
  const target = state.characters.find((c) => c.id === input.actor)
    ?? state.combatActors.find((a) => a.id === input.actor);
  if (!target) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };
  
  const { dice } = fallingDamageFormula(input.distanceFt);
  if (dice === 0) {
    return { ok: true, data: { damage: 0, prone: false }, rolls: [], mutations: [] };
  }
  // Roll dice d6
  let total = 0;
  const rollValues: number[] = [];
  for (let i = 0; i < dice; i++) {
    const r = Math.floor(ctx.rng() * 6) + 1;
    rollValues.push(r);
    total += r;
  }
  
  return {
    ok: true,
    data: { damage: total, prone: true },
    rolls: [{ formula: `${dice}d6`, rolls: rollValues, modifier: 0, total }],
    mutations: [
      { op: 'apply_damage', actorId: target.id, amount: total, type: 'bludgeoning' },
      { op: 'add_condition', actorId: target.id, condition: { slug: 'prone', source: 'falling', durationRounds: 'until_removed', appliedRound: 0 } },
    ],
  };
}
```

### apply_suffocation

```ts
export function handleApplySuffocation(
  ctx: ToolCtx, state: EngineState,
  input: { actor: string; secondsWithoutAir: number },
): ActionResult<{ holdBreathSeconds: number; postBreathRounds: number; status: 'ok' | 'past_breath' | 'unconscious' | 'dying' }> {
  const char = state.characters.find((c) => c.id === input.actor);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  const conMod = abilityModifier(char.abilities.CON);
  const { holdBreathSeconds, postBreathRounds } = suffocationSurvival(conMod);
  const postBreathSeconds = postBreathRounds * 6;  // 6 sec per round
  
  if (input.secondsWithoutAir <= holdBreathSeconds) {
    return { ok: true, data: { holdBreathSeconds, postBreathRounds, status: 'ok' }, rolls: [], mutations: [] };
  }
  
  if (input.secondsWithoutAir <= holdBreathSeconds + postBreathSeconds) {
    // Past hold breath, but not yet at 0 HP
    return { ok: true, data: { holdBreathSeconds, postBreathRounds, status: 'past_breath' }, rolls: [], mutations: [] };
  }
  
  // Drop to 0 HP and start dying
  return {
    ok: true,
    data: { holdBreathSeconds, postBreathRounds, status: 'unconscious' },
    rolls: [],
    mutations: [
      { op: 'set_hp', actorId: char.id, hpCurrent: 0 },
      { op: 'add_condition', actorId: char.id, condition: { slug: 'unconscious', source: 'suffocation', durationRounds: 'until_removed', appliedRound: 0 } },
    ],
  };
}
```

### set_travel_pace, set_light_level, set_marching_order, set_senses

Wrapper handlers that emit corresponding mutations.

Tool definitions in index.ts. TOOL_HANDLERS wiring.

Tests in `tests/engine/tools/exploration.test.ts`. Commit: `feat(tools): exploration tools (travel pace, vision, falling, suffocation)`.

---

## Task 4: System prompt

Add new section:

```
### Exploration Layer (PHB §6.1–6.7)

**Travel pace** (PHB §6.1):
- Fast: 4 mi/h, 30 mi/day, -5 passive Perception
- Normal: 3 mi/h, 24 mi/day, baseline
- Slow: 2 mi/h, 18 mi/day, stealth allowed
Use `set_travel_pace({ pace: 'fast'|'normal'|'slow' })` when the party
chooses or you announce travel.

**Vision & Light** (PHB §6.4):
- Bright: normal vision.
- Dim: lightly obscured → DIS on Perception relying on sight (unless darkvision).
- Darkness: heavily obscured → effectively blinded (unless darkvision).
- Darkvision treats dim as bright, darkness as dim (still DIS).
- Blindsight/Tremorsense ignore light entirely (within range).
- Truesight overrides all sight-based effects within range.

Use `check_vision({ observer, distanceFt, lightLevel? })` to programmatically
check what an actor can perceive. Returns {canSee, perceptionDisadvantage,
effectivelyBlinded, senseUsed}.

**Falling** (PHB §6.6): use `apply_falling({ actor, distanceFt })`. Rolls
1d6 per 10 ft (max 20d6) bludgeoning + adds prone.

**Suffocation** (PHB §6.5): hold breath = max(30 sec, (1+CON mod)·60 sec).
Then CON mod rounds (min 1) at 0 HP, then drop to 0 and start dying.
Use `apply_suffocation({ actor, secondsWithoutAir })`.

**Marching order** (PHB §6.2): use `set_marching_order({ order: { front, middle, back } })`
to track who's in which rank. Affects ambushes and area attacks narratively.

---

Italiano: Phase 6 aggiunge il layer di esplorazione: travel pace (Fast/Normal/Slow),
controlli di visione con darkvision/blindsight/tremorsense, danno da caduta,
soffocamento, e ordine di marcia.
```

Commit: `docs(prompt): document exploration layer (travel/vision/falling/suffocation)`.

---

## Task 5: E2E + smoke

`tests/engine/scenarios/exploration-loop.test.ts`:
1. Travel: set Fast → passive Perception drops 5 → set Slow → restored.
2. Vision: dim light + 60ft darkvision → can see clearly within 60ft, DIS beyond.
3. Falling 30ft: 3d6 bludgeoning + prone.
4. Falling 250ft: capped at 20d6 + prone.
5. Suffocation CON+1: 120 sec hold → past_breath at 130 → unconscious at 142.

Smoke: `pnpm test`, `pnpm typecheck`. Commit final tweaks.

---

## Self-review checklist

- [ ] Coverage delta: Exploration 18% → ~85%.
- [ ] Backward compat: travel/senses optional everywhere.
- [ ] PHB §6.4: darkvision still gives DIS on Perception in actual darkness.
- [ ] Falling cap at 20d6 enforced.
- [ ] Suffocation thresholds correct.

---

## Stima sforzo Phase 6

- Task 1 (helpers + types): 2h
- Task 2 (schema + applicator + migration): 2h
- Task 3 (tools): 3h
- Task 4 (system prompt): 30min
- Task 5 (E2E): 1h

**Totale: ~9h** developer; subagent-driven: ~1.5 giornate.
