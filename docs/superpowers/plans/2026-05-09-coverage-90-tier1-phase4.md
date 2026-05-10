# Coverage 90% — Tier 1 Phase 4: Inspiration + Long Rest + Auto-Exhaustion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sblocca +5 punti coverage portando "Awards/Resting/Survival" da ~30% a ~80%. Quattro pezzi: (1) Inspiration system (PHB §18.1: DM la dà, spend per ADV), (2) Long Rest constraints PHB §5.2 (≥1 HP, max 1/24h, interruzioni 1h+), (3) Forced March (PHB §6.3: oltre 8h → CON save DC 10+ore o exhaustion), (4) Hunger/Thirst (PHB §6.7: missed days/half-rations → CON save DC 15 o exhaustion).

**Architecture:**
- **Inspiration**: `Character.inspiration: boolean` (single bool — PHB: "you either have it or you don't"). Tools `grant_inspiration`/`spend_inspiration`. Spending applies advantage flag a make_attack/abilityCheck/savingThrow via parametro nuovo `useInspiration?: boolean` (consume on first roll regardless of outcome).
- **Long Rest constraints**: estendere `long_rest` tool handler. Aggiungere `lastLongRestEpoch?: number` a session_state. Validazioni:
  - `hpCurrent < 1` → error 'cannot_rest_at_zero_hp'
  - now - lastLongRestEpoch < 24h → error 'long_rest_cooldown'
  - Optional `interruptedByMinutes?: number` param → if ≥60, no benefit ("interruption resets the timer").
- **Forced March**: nuovo tool `forced_march({ actorId, hoursTraveled })`. PHB: "For each hour after the 8th, you must make a Constitution saving throw at the end of the hour. The DC is 10 + 1 for each hour past 8 hours." On fail → 1 level of exhaustion.
- **Hunger/Thirst**: nuovo tool `apply_starvation({ actorId, daysWithoutFood })`. PHB: "Surviving without food: a character can go without food for a number of days equal to 3 + their CON modifier (minimum 1)". After that, fails 1 CON save (DC 10 + 1 per day) → exhaustion. Similarly `apply_dehydration({ actorId })`.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: `inspiration` column on characters, `last_long_rest_at` column on session_state). Builds on Phase 1-3.

---

## File Structure

### File da creare:
- `src/engine/survival.ts` — pure helpers per Forced March/Starvation/Dehydration math
- `tests/engine/survival.test.ts`
- `tests/engine/scenarios/inspiration-rest-loop.test.ts`
- `drizzle/0014_*.sql` — migration

### File da modificare:
- `src/engine/types.ts` — `Character.inspiration?: boolean`, `inspirationUsed` nelle Mutation
- `src/db/schema/characters.ts` — colonna `inspiration` boolean default false
- `src/db/schema/session-state.ts` — colonna `lastLongRestAt` timestamp
- `src/engine/rests.ts` — long_rest constraints (HP, cooldown, interrupt)
- `src/engine/checks.ts`, `src/engine/combat/attack.ts` — leggere `useInspiration` flag e applicare ADV + emit consume mutation
- `src/sessions/applicator.ts` — handler per `grant_inspiration`/`spend_inspiration`/`set_long_rest_at`
- `src/sessions/snapshot.ts` — hydrate inspiration + lastLongRestAt
- `src/engine/tools/handlers.ts` — `grant_inspiration`, `spend_inspiration`, `forced_march`, `apply_starvation`, `apply_dehydration` handlers; estendere `long_rest`
- `src/engine/tools/index.ts` — schema dei nuovi tool
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Inspiration types + applicator

**Files:**
- Modify: `src/engine/types.ts`
- Modify: `src/db/schema/characters.ts`
- Create: `drizzle/0014_*.sql`
- Modify: `src/sessions/snapshot.ts`
- Modify: `src/sessions/applicator.ts`
- Extend: `tests/sessions/applicator.test.ts`

### - [ ] Step 1: Types

```ts
// In types.ts: Character interface
inspiration?: boolean;  // PHB §18.1 — single bool, you have it or don't.

// Mutation union additions:
| { op: 'grant_inspiration'; characterId: string }
| { op: 'spend_inspiration'; characterId: string }
| { op: 'set_long_rest_at'; sessionId?: string; epochMs: number }
```

### - [ ] Step 2: Schema additions

```ts
// In src/db/schema/characters.ts
inspiration: boolean('inspiration').notNull().default(false),

// In src/db/schema/session-state.ts
lastLongRestAt: timestamp('last_long_rest_at'),  // nullable
```

### - [ ] Step 3: Generate migration

```bash
pnpm db:generate
pnpm db:migrate
```

### - [ ] Step 4: Snapshot hydration

```ts
// In src/sessions/snapshot.ts:
character.inspiration = row.inspiration ?? false;
// session-state: lastLongRestAt populated if present
```

### - [ ] Step 5: Applicator handlers

```ts
case 'grant_inspiration': {
  await tx.update(characters).set({ inspiration: true }).where(eq(characters.id, m.characterId));
  break;
}
case 'spend_inspiration': {
  await tx.update(characters).set({ inspiration: false }).where(eq(characters.id, m.characterId));
  break;
}
case 'set_long_rest_at': {
  await tx.update(sessionState).set({ lastLongRestAt: new Date(m.epochMs) }).where(...);
  break;
}
```

### - [ ] Step 6: Tests + commit

```ts
// In tests/sessions/applicator.test.ts:
describe('applicator — inspiration', () => {
  it('grant_inspiration sets character.inspiration=true');
  it('spend_inspiration sets character.inspiration=false');
  it('set_long_rest_at writes timestamp');
});
```

Commit: `feat(applicator): inspiration system + long_rest cooldown tracking`.

---

## Task 2: Long rest constraints

**Files:**
- Modify: `src/engine/rests.ts` — extend longRest with constraints
- Extend: `tests/engine/rests.test.ts`

### - [ ] Step 1: Tests FIRST

```ts
describe('longRest — PHB §5.2 constraints', () => {
  it('errors when hpCurrent < 1', () => {
    const r = longRest({ character, runtime: rtAt0Hp });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_rest_at_zero_hp');
  });

  it('errors when last long rest was less than 24h ago', () => {
    const r = longRest({ character, runtime, lastLongRestAtMs: nowMs - (12 * 60 * 60 * 1000) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('long_rest_cooldown');
  });

  it('succeeds when 24h+ have passed', () => {
    const r = longRest({ character, runtime, lastLongRestAtMs: nowMs - (25 * 60 * 60 * 1000) });
    expect(r.ok).toBe(true);
  });

  it('errors when interruptedByMinutes >= 60 (1 hour activity)', () => {
    const r = longRest({ character, runtime, interruptedByMinutes: 60 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('long_rest_interrupted');
  });

  it('succeeds when interruptedByMinutes < 60', () => {
    const r = longRest({ character, runtime, interruptedByMinutes: 30 });
    expect(r.ok).toBe(true);
  });

  it('reduces exhaustion by 1 (PHB §4.1)', () => {
    const rt = { ...runtime, exhaustionLevel: 3 };
    const r = longRest({ character, runtime: rt });
    expect(r.ok).toBe(true);
    expect(r.mutations.find((m) => m.op === 'remove_condition' && m.conditionSlug === 'exhaustion')).toBeDefined();
  });

  it('emits set_long_rest_at mutation', () => {
    const r = longRest({ character, runtime, currentEpochMs: 1000 });
    const setLong = r.mutations.find((m) => m.op === 'set_long_rest_at');
    expect(setLong).toMatchObject({ epochMs: 1000 });
  });
});
```

### - [ ] Step 2: Implementation

```ts
export interface LongRestInput {
  character: Character;
  runtime: ActorRuntimeState;
  /** ms since epoch of the last long rest, if any. Undefined = never rested before. */
  lastLongRestAtMs?: number;
  /** Current ms since epoch (for the cooldown calc + storing the new timestamp). */
  currentEpochMs?: number;
  /** Minutes of strenuous activity during the rest. ≥60 invalidates the rest. */
  interruptedByMinutes?: number;
}

export function longRest(input: LongRestInput): ActionResult<{ /* ... */ }> {
  if (input.runtime.hpCurrent < 1) return { ok: false, error: 'cannot_rest_at_zero_hp', rolls: [], mutations: [] };
  
  const now = input.currentEpochMs ?? Date.now();
  if (input.lastLongRestAtMs != null && (now - input.lastLongRestAtMs) < 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'long_rest_cooldown', rolls: [], mutations: [] };
  }
  
  if ((input.interruptedByMinutes ?? 0) >= 60) {
    return { ok: false, error: 'long_rest_interrupted', rolls: [], mutations: [] };
  }
  
  // Existing long-rest logic: full HP, half hit dice (min 1), spell slots, features.
  const muts: Mutation[] = [/* existing */];
  
  // PHB §4.1: long rest reduces exhaustion by 1.
  if ((input.runtime.exhaustionLevel ?? 0) > 0) {
    muts.push({ op: 'remove_condition', actorId: input.character.id, conditionSlug: 'exhaustion' });
  }
  
  // Stamp the long rest timestamp
  muts.push({ op: 'set_long_rest_at', epochMs: now });
  
  return { ok: true, data: {/*...*/}, rolls: [], mutations: muts };
}
```

### - [ ] Step 3: Tool handler — pass-through

In `src/engine/tools/handlers.ts` `long_rest` handler:
- Read `state.runtime[character.id]` for hpCurrent + exhaustion.
- Read `state.lastLongRestAt` (or equivalent) from session-state.
- Pass to longRest engine.

### - [ ] Step 4: Commit

`feat(rests): long rest §5.2 constraints (HP, 24h cooldown, interrupt) + auto-exhaustion reduction`.

---

## Task 3: Inspiration roll integration

**Files:**
- Modify: `src/engine/combat/attack.ts`
- Modify: `src/engine/checks.ts`
- Extend: tests

### - [ ] Step 1: Tests FIRST

```ts
describe('makeAttack — useInspiration', () => {
  it('useInspiration:true with character.inspiration=true grants ADV + emits spend_inspiration', () => {
    const r = makeAttack({ ..., useInspiration: true, attackerInspiration: true });
    expect(r.rolls[0].rolls.length).toBe(2);
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeDefined();
  });

  it('useInspiration:true without inspiration → error', () => {
    const r = makeAttack({ ..., useInspiration: true, attackerInspiration: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_inspiration');
  });

  it('useInspiration:false (default) → no spend mutation', () => {
    const r = makeAttack({ ..., useInspiration: false, attackerInspiration: true });
    expect(r.mutations.find((m) => m.op === 'spend_inspiration')).toBeUndefined();
  });
});

describe('abilityCheck / savingThrow — useInspiration', () => {
  // Same patterns
});
```

### - [ ] Step 2: Implementation

In MakeAttackInput, AbilityCheckInput, SavingThrowInput: add `useInspiration?: boolean`.

The character's inspiration flag must be available via either:
a) Reading from runtime/Character directly: `input.attacker.inspiration ?? false`
b) Or a separate input field `attackerInspiration?: boolean`.

Pick (a) — Character is already a parameter and includes `inspiration`.

```ts
if (input.useInspiration) {
  if (!input.attacker.inspiration) {
    return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  }
  // Apply ADV
  advantage = true;
  // Emit spend mutation in result
  spendMut = { op: 'spend_inspiration', characterId: input.attacker.id };
}
```

For abilityCheck/savingThrow: same pattern, using `input.char.inspiration`.

PHB rules: "When you spend Inspiration, you can give yourself advantage on ONE attack roll, ability check, or saving throw." → consumed on first use regardless of outcome.

### - [ ] Step 3: Commit

`feat(combat,checks): useInspiration flag — apply ADV + consume on first roll`.

---

## Task 4: Tools `grant_inspiration` / `spend_inspiration`

**Files:**
- Modify: `src/engine/tools/handlers.ts`
- Modify: `src/engine/tools/index.ts`

### - [ ] Step 1: Handlers

```ts
export function handleGrantInspiration(
  ctx: ToolCtx, state: EngineState, input: { character: string },
): ActionResult<{ granted: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  if (char.inspiration) return { ok: true, data: { granted: false }, rolls: [], mutations: [] };
  return { ok: true, data: { granted: true }, rolls: [], mutations: [{ op: 'grant_inspiration', characterId: char.id }] };
}

export function handleSpendInspiration(
  ctx: ToolCtx, state: EngineState, input: { character: string },
): ActionResult<{ spent: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  if (!char.inspiration) return { ok: false, error: 'no_inspiration', rolls: [], mutations: [] };
  return { ok: true, data: { spent: true }, rolls: [], mutations: [{ op: 'spend_inspiration', characterId: char.id }] };
}
```

(NB: the typical `spend_inspiration` standalone tool is rarely needed — usually the spend happens via `useInspiration: true` in attack/check/save tools. But provide for narrative flexibility.)

### - [ ] Step 2: Tool definitions

```ts
{
  name: 'grant_inspiration',
  description: 'PHB §18.1: DM awards Inspiration to a player for great roleplaying or accomplishments. The PC then has Inspiration (a single boolean — you either have it or don\'t). Idempotent: granting when already inspired is a no-op.',
  input_schema: { type: 'object', properties: { character: ACTOR_ID }, required: ['character'] },
},
{
  name: 'spend_inspiration',
  description: 'Spend Inspiration to gain ADV on the next d20 roll. Most callers should use the useInspiration flag on make_attack / ability_check / saving_throw; this standalone tool is for narrative spending (e.g., the player declares "I use my inspiration before rolling"). Errors with no_inspiration if PC doesn\'t have it.',
  input_schema: { ... },
},
```

### - [ ] Step 3: Wire into TOOL_HANDLERS, commit

`feat(tools): grant_inspiration and spend_inspiration tools`.

---

## Task 5: Survival helpers + tools (Forced March, Hunger, Thirst)

**Files:**
- Create: `src/engine/survival.ts`
- Create: `tests/engine/survival.test.ts`
- Modify: `src/engine/tools/handlers.ts`, `index.ts`

### - [ ] Step 1: Pure helpers

```ts
export function forcedMarchDC(hoursTraveled: number): number {
  // PHB §6.3: DC 10 + 1 per hour past 8.
  if (hoursTraveled <= 8) return 0;  // no save needed
  return 10 + (hoursTraveled - 8);
}

export function starvationSurvivalDays(conMod: number): number {
  // PHB §6.7: 3 + CON mod (minimum 1).
  return Math.max(1, 3 + conMod);
}

export function dehydrationSaveDC(consecutiveDaysWithLessThanHalfWater: number): number {
  // PHB §6.7: DC 15 first day; +5 per consecutive day.
  return 15 + (consecutiveDaysWithLessThanHalfWater - 1) * 5;
}
```

### - [ ] Step 2: Tests

```ts
describe('forcedMarchDC', () => {
  it('returns 0 if ≤8 hours', () => { expect(forcedMarchDC(8)).toBe(0); });
  it('returns 11 at 9 hours', () => { expect(forcedMarchDC(9)).toBe(11); });
  it('returns 18 at 16 hours', () => { expect(forcedMarchDC(16)).toBe(18); });
});

describe('starvationSurvivalDays', () => {
  it('returns 4 for CON +1', () => { expect(starvationSurvivalDays(1)).toBe(4); });
  it('returns 1 (minimum) for CON -3', () => { expect(starvationSurvivalDays(-3)).toBe(1); });
});

describe('dehydrationSaveDC', () => {
  it('returns 15 day 1', () => { expect(dehydrationSaveDC(1)).toBe(15); });
  it('returns 20 day 2', () => { expect(dehydrationSaveDC(2)).toBe(20); });
});
```

### - [ ] Step 3: Tools

```ts
export function handleForcedMarch(
  ctx: ToolCtx, state: EngineState,
  input: { actor: string; hoursTraveled: number },
): ActionResult<{ saveRoll: number; saveSuccess: boolean; exhaustionApplied: boolean }> {
  const char = state.characters.find((c) => c.id === input.actor);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  const dc = forcedMarchDC(input.hoursTraveled);
  if (dc === 0) return { ok: true, data: { saveRoll: 0, saveSuccess: true, exhaustionApplied: false }, rolls: [], mutations: [] };
  
  // Roll CON save
  const conMod = abilityModifier(char.abilities.CON);
  const profBonus = char.proficiencies.saves.includes('CON') ? char.proficiencyBonus : 0;
  const roll = Math.floor(ctx.rng() * 20) + 1;
  const total = roll + conMod + profBonus;
  const success = total >= dc;
  
  if (success) {
    return { ok: true, data: { saveRoll: roll, saveSuccess: true, exhaustionApplied: false }, rolls: [/*...*/], mutations: [] };
  }
  
  // On fail: apply 1 level of exhaustion
  return {
    ok: true,
    data: { saveRoll: roll, saveSuccess: false, exhaustionApplied: true },
    rolls: [/*...*/],
    mutations: [{ op: 'add_condition', actorId: char.id, condition: { slug: 'exhaustion', source: 'forced march', durationRounds: 'until_removed', appliedRound: 0 } }],
  };
}

// Similarly handleApplyStarvation, handleApplyDehydration
```

### - [ ] Step 4: Tool definitions + commit

`feat(survival): forced_march, apply_starvation, apply_dehydration tools (PHB §6.3, §6.7)`.

---

## Task 6: System prompt update

Add new sub-section in MASTER_TOOL_CONTRACT:

```
### Inspiration & Survival (PHB §18.1, §6.3, §6.7)

**Inspiration**: when the PC roleplays exceptionally well or completes a memorable story beat, call `grant_inspiration({ character: ... })`. The PC then has Inspiration (single boolean). To spend, pass `useInspiration: true` to `make_attack`, `ability_check`, or `saving_throw` — it grants ADV on that one roll and is consumed regardless of outcome.

**Forced March (PHB §6.3)**: when the party travels >8 hours in a day, call `forced_march({ actor, hoursTraveled })`. The tool rolls a CON save (DC 10 + 1 per hour past 8). On fail, applies 1 level of exhaustion.

**Starvation/Dehydration (PHB §6.7)**: when the PC misses food/water for multiple days, call `apply_starvation({ actor, daysWithoutFood })` or `apply_dehydration({ actor, daysWithLessThanHalfWater })`. CON saves with rising DCs.

**Long rest constraints (PHB §5.2)**: `long_rest` tool now errors:
- `cannot_rest_at_zero_hp` — PC must have ≥1 HP.
- `long_rest_cooldown` — must wait 24h between long rests.
- `long_rest_interrupted` — interrupted by ≥1h of strenuous activity (combat, casting, walking).
On success, also reduces exhaustion by 1.
```

Commit.

---

## Task 7: E2E inspiration scenarios

Create `tests/engine/scenarios/inspiration-rest-loop.test.ts` with:
1. PC granted Inspiration → uses on attack → ADV + consumed.
2. PC tries to long rest at 0 HP → error.
3. PC long rests with exhaustion 3 → exhaustion 2 + restored HP.
4. Forced march 12 hours → CON save DC 14 → on fail, exhaustion +1.
5. Apply_starvation after CON survival days → exhaustion +1.

Commit.

---

## Task 8: Smoke + final verification

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Commit any minor doc tweaks.

---

## Self-review checklist

- [ ] Coverage delta: Awards/Rest/Survival 30% → ~80%.
- [ ] Backward compat: existing rests tests still green.
- [ ] Idempotency: grant_inspiration when already inspired → no-op (or no-op data flag).
- [ ] PHB §18.1: Inspiration is a single boolean, no stacking — verify.
- [ ] Long rest cooldown check uses milliseconds correctly (24h = 86_400_000 ms).

---

## Stima sforzo Phase 4

- Task 1 (types + applicator + migration): 1.5h
- Task 2 (long_rest constraints): 1.5h
- Task 3 (useInspiration in attack/checks): 1h
- Task 4 (grant/spend tools): 0.5h
- Task 5 (survival helpers + 3 tools): 2h
- Task 6 (system prompt): 0.5h
- Task 7 (E2E): 1h
- Task 8 (smoke): 0.5h

**Totale: ~8h** developer; subagent-driven: ~1 giornata.
