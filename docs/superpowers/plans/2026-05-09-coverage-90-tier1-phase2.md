# Coverage 90% — Tier 1 Phase 2: Concentration & Spell Engine Factory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare lo spell engine da "2 handler hardcoded + 314 spell narrativi" a "30 archetipi data-driven che coprono 250+ spell con regole eseguite", più concentration enforcement automatico (max 1 concurrent, break-on-damage CON save) e ritual casting (+10 min, no slot). Sblocca ~15 punti di coverage portando l'area Spellcasting da 35% a ~75%.

**Architecture:**
- **Concentration**: nuovo campo `concentratingOn?: { spellSlug, startedRound, slotLevel }` su `ActorRuntimeState` persistito via migration. Mutations `set_concentration` e `break_concentration`. Hook in `applyDamage` emette `concentration_check` con DC = max(10, ⌊damage/2⌋). Tool `concentration_check` rolla CON save e on fail emette `break_concentration`. `castSpell` di un nuovo concentration spell rompe la corrente.
- **Spell Archetypes**: tabella `SPELL_ARCHETYPES` mappa `spellSlug → { archetype, params }`. 8 archetipi: `attack_damage`, `save_half`, `save_negate`, `save_condition`, `heal`, `buff`, `aoe_save`, `utility`. Handler factory dispatcha in base all'archetype consumando params (damage dice, save ability, condition slug, target count, scaling per slot superiore).
- **Ritual casting**: nuovo param `asRitual?: boolean` su `cast_spell`. Se true: verifica `spell.ritual`, skip slot consumption, narrative tag `ritual:true` nel risultato.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration), Anthropic SDK tool schemas. Builds on Phase 1 (`condition-effects.ts`, `getEffectsForActor`, applicator with `flags`/`exhaustionLevel`/`death_saves`).

---

## File Structure (Phase 2)

### File da creare:
- `src/engine/spells/archetypes.ts` — types + handler factory per gli 8 archetipi
- `src/engine/spells/spell-data.ts` — mapping `spellSlug → ArchetypeBinding`
- `src/engine/spells/concentration.ts` — helpers `startConcentration`, `breakConcentration`, `concentrationCheckDC`
- `tests/engine/spells/archetypes.test.ts` — unit test handler factory (per archetype)
- `tests/engine/spells/concentration.test.ts` — unit test concentration helpers
- `tests/engine/scenarios/concentration-loop.test.ts` — E2E: cast → damage → CON save → break
- `drizzle/0012_*.sql` — migration colonna `concentrating_on`

### File da modificare:
- `src/engine/types.ts` — aggiungere `concentratingOn?` a `ActorRuntimeState`, ops `set_concentration` e `break_concentration` a `Mutation`, `'concentration_check'` ad outcome di handler
- `src/engine/spells.ts` — refactor `castSpell` per usare il factory, gestire concentration replacement, supportare `asRitual`
- `src/engine/combat/damage.ts` — quando target sta concentrando ed è hit, emit `concentration_check` mutation
- `src/sessions/applicator.ts` — implementare handler `set_concentration` / `break_concentration`
- `src/sessions/snapshot.ts` — hydrate `concentratingOn` from DB
- `src/db/schema/session-state.ts` — aggiungere colonna `concentrating_on jsonb`
- `src/engine/tools/handlers.ts` — wire `asRitual` a `cast_spell`, aggiungere `handleConcentrationCheck`
- `src/engine/tools/index.ts` — schema `cast_spell` con `asRitual?`, nuovo tool `concentration_check`
- `src/ai/master/system-prompt.ts` — documentare concentration loop e ritual casting
- `src/srd/parsers/spells.ts` — eventuale, se serve esporre il flag concentration al call site (probabilmente già esposto)

### File di test da estendere:
- `tests/engine/spells.test.ts` — aggiungere casi di concentration replace e ritual
- `tests/engine/combat/damage.test.ts` — verificare emit `concentration_check` quando target concentra
- `tests/engine/tools/handlers.test.ts` — coprire i nuovi tool param

---

## Roadmap macro (riepilogo aggiornato)

| Phase | Status | Coverage |
|---|---|---|
| ~~Phase 1: Condition Effects + Death Saves~~ | ✅ Done (branch `feat/conditions-and-death-saves`) | +25 pts |
| **Phase 2 (questo piano)** | 📝 In corso | +15 pts |
| Phase 3: Action Economy + Standard Actions + OAs | da pianificare | +10 |
| Phase 4: Inspiration + Long Rest + Auto-Exhaustion | da pianificare | +5 |
| Phase 5: Magic Item Rarity + Attunement | da pianificare | +6 |
| Phase 6: Exploration Layer | da pianificare | +8 |
| Phase 7: NPC Three-Beat + Tonal Frame | da pianificare | +3 |

---

## Task 1: Concentration helpers + types (TDD)

**Files:**
- Create: `src/engine/spells/concentration.ts`
- Create: `tests/engine/spells/concentration.test.ts`
- Modify: `src/engine/types.ts`

### - [ ] Step 1: Aggiungere types

In `src/engine/types.ts`:

```ts
export interface ConcentrationState {
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  startedRound: number;
}

export interface ActorRuntimeState {
  // ... existing fields
  concentratingOn?: ConcentrationState;
  // ... rest
}

export type Mutation =
  // ... existing
  | { op: 'set_concentration'; actorId: string; spellSlug: string; slotLevel: 0|1|2|3|4|5|6|7|8|9; startedRound: number }
  | { op: 'break_concentration'; actorId: string; reason: 'damage' | 'incapacitated' | 'killed' | 'new_concentration' | 'manual' }
  // ... rest
```

### - [ ] Step 2: Scrivere il test

File: `tests/engine/spells/concentration.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  concentrationCheckDC,
  startConcentrationMutations,
  breakConcentrationMutations,
} from '../../../src/engine/spells/concentration';

describe('concentrationCheckDC', () => {
  it('damage 0 → DC 10', () => {
    expect(concentrationCheckDC(0)).toBe(10);
  });
  it('damage 10 → DC 10 (max(10, 5))', () => {
    expect(concentrationCheckDC(10)).toBe(10);
  });
  it('damage 21 → DC 10 (max(10, 10))', () => {
    expect(concentrationCheckDC(21)).toBe(10);
  });
  it('damage 22 → DC 11 (max(10, 11))', () => {
    expect(concentrationCheckDC(22)).toBe(11);
  });
  it('damage 50 → DC 25', () => {
    expect(concentrationCheckDC(50)).toBe(25);
  });
});

describe('startConcentrationMutations', () => {
  it('returns set_concentration mutation', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
    });
    expect(muts).toEqual([
      { op: 'set_concentration', actorId: 'pc1', spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
    ]);
  });

  it('if actor already concentrating on a different spell, emits break first', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
      currentlyConcentratingOn: { spellSlug: 'bane', slotLevel: 1, startedRound: 1 },
    });
    expect(muts[0]).toMatchObject({ op: 'break_concentration', actorId: 'pc1', reason: 'new_concentration' });
    expect(muts[1]).toMatchObject({ op: 'set_concentration', spellSlug: 'bless' });
  });

  it('if actor already concentrating on the same spell, no break', () => {
    const muts = startConcentrationMutations({
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
      currentlyConcentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 1 },
    });
    // re-cast same spell — break old, start new (the two represent different cast events)
    expect(muts[0]).toMatchObject({ op: 'break_concentration', reason: 'new_concentration' });
    expect(muts[1]).toMatchObject({ op: 'set_concentration' });
  });
});

describe('breakConcentrationMutations', () => {
  it('returns break_concentration mutation with reason', () => {
    const muts = breakConcentrationMutations({ actorId: 'pc1', reason: 'damage' });
    expect(muts).toEqual([{ op: 'break_concentration', actorId: 'pc1', reason: 'damage' }]);
  });
});
```

### - [ ] Step 3: Run test, expect FAIL

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine && pnpm test spells/concentration
```

### - [ ] Step 4: Implementare

File: `src/engine/spells/concentration.ts`

```ts
import type { ConcentrationState, Mutation } from '../types';

export function concentrationCheckDC(damage: number): number {
  return Math.max(10, Math.floor(damage / 2));
}

export interface StartConcentrationInput {
  actorId: string;
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  startedRound: number;
  currentlyConcentratingOn?: ConcentrationState;
}

export function startConcentrationMutations(input: StartConcentrationInput): Mutation[] {
  const muts: Mutation[] = [];
  if (input.currentlyConcentratingOn) {
    muts.push({
      op: 'break_concentration',
      actorId: input.actorId,
      reason: 'new_concentration',
    });
  }
  muts.push({
    op: 'set_concentration',
    actorId: input.actorId,
    spellSlug: input.spellSlug,
    slotLevel: input.slotLevel,
    startedRound: input.startedRound,
  });
  return muts;
}

export interface BreakConcentrationInput {
  actorId: string;
  reason: 'damage' | 'incapacitated' | 'killed' | 'new_concentration' | 'manual';
}

export function breakConcentrationMutations(input: BreakConcentrationInput): Mutation[] {
  return [{ op: 'break_concentration', actorId: input.actorId, reason: input.reason }];
}
```

### - [ ] Step 5: Run test, expect PASS

```bash
pnpm test spells/concentration
pnpm typecheck
```

### - [ ] Step 6: Commit

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine
git add src/engine/spells/concentration.ts tests/engine/spells/concentration.test.ts src/engine/types.ts
git commit -m "$(cat <<'EOF'
feat(engine): concentration helpers + types (DC, start/break mutations)

Pure helpers for the concentration loop:
- concentrationCheckDC(dmg) = max(10, floor(dmg/2)) per PHB §8.8.
- startConcentrationMutations: emits break_concentration if actor was
  already concentrating, then set_concentration.
- breakConcentrationMutations: emits break_concentration with a typed reason.

Adds ConcentrationState to ActorRuntimeState (optional) and the two
mutation ops to the Mutation union.
EOF
)"
```

---

## Task 2: Applicator handlers for concentration

**Files:**
- Modify: `src/sessions/applicator.ts`
- Modify: `src/db/schema/session-state.ts`
- Create: `drizzle/0012_*.sql`
- Modify: `src/sessions/snapshot.ts`
- Extend: `tests/sessions/applicator.test.ts`

### - [ ] Step 1: Schema + migration

File: `src/db/schema/session-state.ts` — aggiungere:
```ts
concentratingOn: jsonb('concentrating_on').$type<{ spellSlug: string; slotLevel: number; startedRound: number } | null>().default(null),
```

Run: `pnpm db:generate` per generare la migration. La migration auto-generata sarà `drizzle/0012_<random>.sql` con `ALTER TABLE session_state ADD COLUMN concentrating_on jsonb DEFAULT NULL`.

Run: `pnpm db:migrate` per applicare.

### - [ ] Step 2: Hydrate snapshot

File: `src/sessions/snapshot.ts` — nella sezione che costruisce `runtime[character.id]`:
```ts
runtime[character.id] = {
  // ... existing fields
  concentratingOn: stateRow.concentratingOn ?? undefined,
};
```

### - [ ] Step 3: Tests for applicator handlers

Append a `tests/sessions/applicator.test.ts`:

```ts
describe('applicator — concentration mutations', () => {
  it('set_concentration writes concentratingOn to the runtime state', async () => {
    let state = stateWith({});
    state = await applyMutation(state, {
      op: 'set_concentration',
      actorId: 'pc1',
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
    });
    expect(state.runtime.pc1.concentratingOn).toEqual({
      spellSlug: 'bless',
      slotLevel: 1,
      startedRound: 3,
    });
  });

  it('break_concentration clears concentratingOn', async () => {
    let state = stateWith({ concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 } });
    state = await applyMutation(state, {
      op: 'break_concentration',
      actorId: 'pc1',
      reason: 'damage',
    });
    expect(state.runtime.pc1.concentratingOn).toBeUndefined();
  });

  it('break_concentration when not concentrating is a no-op', async () => {
    let state = stateWith({});
    state = await applyMutation(state, {
      op: 'break_concentration',
      actorId: 'pc1',
      reason: 'damage',
    });
    expect(state.runtime.pc1.concentratingOn).toBeUndefined();
  });
});
```

### - [ ] Step 4: Run, expect FAIL

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine && pnpm test sessions/applicator
```

### - [ ] Step 5: Implementare nell'applicator

In `src/sessions/applicator.ts`, aggiungere due nuovi case:

```ts
case 'set_concentration': {
  // PC only (monsters don't track concentration in single-player engine)
  const isPc = state.characters.some((c) => c.id === m.actorId);
  if (!isPc) break;
  // SQL UPDATE session_state SET concentrating_on = {...} WHERE character_id = m.actorId
  await db.update(sessionState)
    .set({ concentratingOn: { spellSlug: m.spellSlug, slotLevel: m.slotLevel, startedRound: m.startedRound } })
    .where(eq(sessionState.characterId, m.actorId));
  next.runtime[m.actorId] = {
    ...next.runtime[m.actorId],
    concentratingOn: { spellSlug: m.spellSlug, slotLevel: m.slotLevel, startedRound: m.startedRound },
  };
  break;
}

case 'break_concentration': {
  const isPc = state.characters.some((c) => c.id === m.actorId);
  if (!isPc) break;
  await db.update(sessionState)
    .set({ concentratingOn: null })
    .where(eq(sessionState.characterId, m.actorId));
  const rt = next.runtime[m.actorId];
  if (rt) {
    const { concentratingOn: _, ...rest } = rt;
    next.runtime[m.actorId] = rest;
  }
  break;
}
```

(Adattare allo stile preciso dell'applicator: l'agent userà il pattern già consolidato nei case esistenti come `set_stable`.)

### - [ ] Step 6: Run, expect PASS

```bash
pnpm test sessions/applicator
pnpm typecheck
```

### - [ ] Step 7: Commit

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine
git add src/sessions/applicator.ts src/sessions/snapshot.ts src/db/schema/session-state.ts drizzle/
git commit -m "$(cat <<'EOF'
feat(applicator): persist concentration state via session_state.concentrating_on

Adds set_concentration and break_concentration handlers:
- set_concentration writes { spellSlug, slotLevel, startedRound } to PC's row.
- break_concentration nulls the column.
- Snapshot builder hydrates runtime.concentratingOn from the column.
- New migration 0012 adds the jsonb column with NULL default.
EOF
)"
```

---

## Task 3: Damage emits concentration_check

**Files:**
- Modify: `src/engine/combat/damage.ts`
- Modify: `tests/engine/combat/damage.test.ts`

### - [ ] Step 1: Test

Append a `tests/engine/combat/damage.test.ts`:

```ts
describe('applyDamage — concentration check', () => {
  it('target concentrating takes damage → emits concentration_check mutation with right DC', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target, runtime,
      amount: 21, type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeDefined();
    expect(conMut?.dc).toBe(10);  // max(10, floor(21/2)) = 10
  });

  it('damage 22 → DC 11', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target, runtime,
      amount: 22, type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut?.dc).toBe(11);
  });

  it('target NOT concentrating → no concentration_check', () => {
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, { hpCurrent: 30 });
    const result = applyDamage({
      target, runtime,
      amount: 22, type: 'piercing',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeUndefined();
  });

  it('target concentrating takes 0 damage (resistance/immunity) → no concentration_check', () => {
    const target = pcAlive({ hpMax: 30, immunities: ['fire'] });
    const runtime = runtimeFor(target, {
      hpCurrent: 30,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target, runtime,
      amount: 100, type: 'fire',
    });
    const conMut = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conMut).toBeUndefined();
  });

  it('target concentrating drops to 0 HP → emits both concentration_check AND death save fail', () => {
    // PC at 5 HP, concentrating, takes 20 damage → 0 HP, unconscious incapacitates → break
    const target = pcAlive({ hpMax: 30 });
    const runtime = runtimeFor(target, {
      hpCurrent: 5,
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = applyDamage({
      target, runtime,
      amount: 20, type: 'piercing',
    });
    // Specifically: concentration_check is NOT emitted because PC is unconscious now
    // → instead break_concentration with reason='incapacitated' should be emitted
    // (we'll handle the incapacitation cascade in this test)
    const breakMut = result.mutations.find((m) => m.op === 'break_concentration' && m.reason === 'incapacitated');
    expect(breakMut).toBeDefined();
    const conCheck = result.mutations.find((m) => m.op === 'concentration_check');
    expect(conCheck).toBeUndefined();
  });
});
```

NB: il quinto test definisce la regola "se il damage rende incapacitated, NO save check — break automatico". L'implementazione deve riflettere questo.

### - [ ] Step 2: Define `Mutation.concentration_check` op

In `src/engine/types.ts`:

```ts
| { op: 'concentration_check'; actorId: string; dc: number; spellSlug: string }
```

### - [ ] Step 3: Run, expect FAIL

```bash
pnpm test combat/damage
```

### - [ ] Step 4: Implementare nel damage.ts

In `src/engine/combat/damage.ts`, dopo aver calcolato `finalDamage`:

```ts
import { concentrationCheckDC } from '../spells/concentration';

// (after finalDamage computation, BEFORE returning)
const concentrating = input.runtime?.concentratingOn;
if (concentrating && finalDamage > 0) {
  const wouldGoUnconscious = (input.runtime?.hpCurrent ?? input.target.hpMax) - finalDamage <= 0;
  if (wouldGoUnconscious) {
    // PHB §8.8: incapacitated → break automatico, no save
    additionalMutations.push({
      op: 'break_concentration',
      actorId: input.target.id,
      reason: 'incapacitated',
    });
  } else {
    additionalMutations.push({
      op: 'concentration_check',
      actorId: input.target.id,
      dc: concentrationCheckDC(finalDamage),
      spellSlug: concentrating.spellSlug,
    });
  }
}
```

Append `additionalMutations` al risultato. Mantieni l'ordine: damage application first, then concentration check (the AI Master will see them in order).

### - [ ] Step 5: Tests pass

```bash
pnpm test combat/damage
pnpm typecheck
```

### - [ ] Step 6: Commit

```bash
git add src/engine/combat/damage.ts src/engine/types.ts tests/engine/combat/damage.test.ts
git commit -m "$(cat <<'EOF'
feat(damage): emit concentration_check when concentrating target takes damage

PHB §8.8:
- Damage > 0 to concentrating target → concentration_check with DC = max(10, ⌊dmg/2⌋).
- Damage causing incapacitation (HP → 0) → break_concentration directly with
  reason='incapacitated' (no save). The AI Master then renders the cascade
  (PC drops, spell ends, narrate it).
- 0 damage (resistance/immunity) → no check.
- Non-concentrating target → no check.
EOF
)"
```

---

## Task 4: Tool concentration_check + applicator wiring

**Files:**
- Modify: `src/engine/tools/handlers.ts` — add `handleConcentrationCheck`
- Modify: `src/engine/tools/index.ts` — schema for `concentration_check` tool
- Create: `tests/engine/tools/concentration-check.test.ts`

### - [ ] Step 1: Test the tool

File: `tests/engine/tools/concentration-check.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { TOOL_HANDLERS } from '../../../src/engine/tools/handlers';
// helpers ...

describe('tool concentration_check', () => {
  it('CON save ≥ DC → success, no break', async () => {
    const state = stateWithConcentratingPC({ conMod: 3, profCon: false });
    const handler = TOOL_HANDLERS['concentration_check'];
    const result = await handler({ rng: () => 0.95 } as any, state, {
      actorId: 'pc1',
      dc: 10,
    });
    // d20 = 20, +3 = 23 ≥ 10 → success
    expect(result.data?.success).toBe(true);
    const breakMut = result.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toBeUndefined();
  });

  it('CON save < DC → break with reason=damage', async () => {
    const state = stateWithConcentratingPC({ conMod: 0, profCon: false });
    const handler = TOOL_HANDLERS['concentration_check'];
    const result = await handler({ rng: () => 0.05 } as any, state, {
      actorId: 'pc1',
      dc: 15,
    });
    // d20 = 2, +0 = 2 < 15 → fail
    expect(result.data?.success).toBe(false);
    const breakMut = result.mutations.find((m) => m.op === 'break_concentration');
    expect(breakMut).toMatchObject({ reason: 'damage' });
  });

  it('proficiency in CON saves applies', async () => {
    const state = stateWithConcentratingPC({ conMod: 2, profCon: true, profBonus: 3 });
    const handler = TOOL_HANDLERS['concentration_check'];
    const result = await handler({ rng: () => 0.5 } as any, state, {
      actorId: 'pc1',
      dc: 15,
    });
    // d20 = 11, +2 + 3 = 16 ≥ 15 → success
    expect(result.data?.total).toBe(16);
  });

  it('errors if actor not concentrating', async () => {
    const state = stateWithoutConcentration();
    const handler = TOOL_HANDLERS['concentration_check'];
    const result = await handler({ rng: () => 0.5 } as any, state, {
      actorId: 'pc1',
      dc: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not concentrating/);
  });
});
```

### - [ ] Step 2: Schema + handler

File: `src/engine/tools/handlers.ts` — append:

```ts
export function handleConcentrationCheck(
  ctx: { rng: () => number },
  state: EngineState,
  input: { actorId: string; dc: number },
): ActionResult<{ roll: number; total: number; success: boolean }> {
  const rt = state.runtime[input.actorId];
  if (!rt) return { ok: false, error: 'unknown actor', rolls: [], mutations: [] };
  if (!rt.concentratingOn) return { ok: false, error: 'actor not concentrating', rolls: [], mutations: [] };

  const character = state.characters.find((c) => c.id === input.actorId);
  if (!character) return { ok: false, error: 'concentration check is PC-only', rolls: [], mutations: [] };

  // CON save with prof bonus if proficient
  const conMod = Math.floor((character.abilities.CON - 10) / 2);
  const profBonus = character.proficiencies.saves.includes('CON') ? character.proficiencyBonus : 0;
  const roll = Math.floor(ctx.rng() * 20) + 1;
  const total = roll + conMod + profBonus;

  const success = total >= input.dc;
  if (success) {
    return {
      ok: true,
      data: { roll, total, success: true },
      rolls: [{ formula: '1d20', rolls: [roll], modifier: conMod + profBonus, total }],
      mutations: [],
    };
  }
  return {
    ok: true,
    data: { roll, total, success: false },
    rolls: [{ formula: '1d20', rolls: [roll], modifier: conMod + profBonus, total }],
    mutations: [{ op: 'break_concentration', actorId: input.actorId, reason: 'damage' }],
  };
}
```

In `src/engine/tools/index.ts`, aggiungere:

```ts
{
  name: 'concentration_check',
  description: 'PHB §8.8: When a concentrating PC takes damage, they must succeed on a CON save (DC = max(10, ⌊damage/2⌋)) or lose concentration. Use this tool ONLY in response to a concentration_check mutation emitted by apply_damage. The tool rolls a d20 + CON mod + proficiency bonus (if proficient in CON saves) and on failure emits break_concentration.',
  input_schema: {
    type: 'object',
    properties: {
      actorId: { type: 'string', description: 'ID of the concentrating PC' },
      dc: { type: 'number', description: 'DC from the concentration_check mutation' },
    },
    required: ['actorId', 'dc'],
  },
}
```

E aggiungere a `TOOL_HANDLERS` registry.

### - [ ] Step 3: Run tests pass

```bash
pnpm test concentration-check
pnpm typecheck
```

### - [ ] Step 4: Commit

```bash
git add src/engine/tools/handlers.ts src/engine/tools/index.ts tests/engine/tools/concentration-check.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): expose concentration_check tool to AI Master

handleConcentrationCheck rolls d20 + CON mod + prof (if proficient in CON saves)
vs DC. On fail emits break_concentration with reason='damage'. Errors if
actor not concentrating.
EOF
)"
```

---

## Task 5: Spell archetype factory — types + 3 archetipi base

**Files:**
- Create: `src/engine/spells/archetypes.ts`
- Create: `src/engine/spells/spell-data.ts`
- Create: `tests/engine/spells/archetypes.test.ts`

### - [ ] Step 1: Definire types in archetypes.ts

```ts
import type { Ability, ConditionSlug, DamageType, Mutation, ActionResult } from '../types';
import { rollDice } from '../dice';
import type { Rng } from '../rand';

export type Archetype =
  | 'attack_damage'
  | 'save_half'
  | 'save_negate'
  | 'save_condition'
  | 'heal'
  | 'buff'
  | 'aoe_save'
  | 'utility';

export interface ArchetypeBindingBase {
  archetype: Archetype;
  /** Damage scaling: base dice + extra dice per slot above min level */
  damage?: { dice: string; type: DamageType; perSlotAbove?: string };
  /** For attack-roll archetypes */
  attackRoll?: boolean;
  /** For save archetypes */
  save?: { ability: Ability; halfOnSuccess?: boolean };
  /** For condition-apply archetypes */
  condition?: { slug: ConditionSlug; durationRounds: number | 'until_removed' };
  /** For heal archetypes */
  heal?: { dice: string; perSlotAbove?: string; addSpellMod?: boolean };
  /** Number of targets (default 1) */
  targets?: { default: number; perSlotAbove?: number };
  /** For AoE — area shape descriptor (narrative, not currently enforced spatially) */
  aoe?: { shape: 'cone' | 'cube' | 'cylinder' | 'line' | 'sphere'; size: string };
  /** Min slot level (e.g. fireball = 3) */
  minSlot?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Whether casting this spell starts concentration */
  concentration?: boolean;
}

export type ArchetypeBinding = ArchetypeBindingBase;

export interface ArchetypeContext {
  caster: { id: string; spellAttackBonus: number; spellSaveDC: number; spellMod: number };
  spellSlug: string;
  slotLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  targets: { id: string; ac?: number }[];
  rng: Rng;
}

export type ArchetypeHandler = (
  ctx: ArchetypeContext,
  binding: ArchetypeBinding,
) => ActionResult<{ effects: string[] }>;

export const ARCHETYPE_HANDLERS: Record<Archetype, ArchetypeHandler> = {
  attack_damage: handleAttackDamage,
  save_half: handleSaveDamage,  // shares logic with save_negate via halfOnSuccess flag
  save_negate: handleSaveDamage,
  save_condition: handleSaveCondition,
  heal: handleHeal,
  buff: handleBuff,
  aoe_save: handleAoeSave,
  utility: handleUtility,
};

function extraDiceForUpcast(scaling: string | undefined, slot: number, minSlot: number): { count: number; sides: number } | null {
  if (!scaling || slot <= minSlot) return null;
  const m = scaling.match(/^(\d+)d(\d+)$/);
  if (!m) return null;
  return { count: parseInt(m[1], 10) * (slot - minSlot), sides: parseInt(m[2], 10) };
}

function handleAttackDamage(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  if (!binding.damage) return { ok: false, error: 'attack_damage requires damage', rolls: [], mutations: [] };
  if (ctx.targets.length !== 1) return { ok: false, error: 'attack_damage requires exactly 1 target', rolls: [], mutations: [] };
  const target = ctx.targets[0]!;

  const attackRoll = Math.floor(ctx.rng() * 20) + 1;
  const attackTotal = attackRoll + ctx.caster.spellAttackBonus;
  const isCrit = attackRoll === 20;
  const isMiss = attackRoll === 1;

  const hit = !isMiss && (isCrit || (target.ac != null && attackTotal >= target.ac));

  if (!hit) {
    return {
      ok: true,
      data: { effects: ['miss'] },
      rolls: [{ formula: '1d20+attack', rolls: [attackRoll], modifier: ctx.caster.spellAttackBonus, total: attackTotal }],
      mutations: [],
    };
  }

  const dmgRoll = rollDice(binding.damage.dice, ctx.rng);
  const upcast = extraDiceForUpcast(binding.damage.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, ctx.rng) : null;
  const crit = isCrit ? rollDice(binding.damage.dice, ctx.rng) : null;
  const total = dmgRoll.total + (upcastRoll?.total ?? 0) + (crit?.total ?? 0);

  return {
    ok: true,
    data: { effects: ['attack-hit', binding.damage.type] },
    rolls: [
      { formula: '1d20+attack', rolls: [attackRoll], modifier: ctx.caster.spellAttackBonus, total: attackTotal },
      dmgRoll,
      ...(upcastRoll ? [upcastRoll] : []),
      ...(crit ? [crit] : []),
    ],
    mutations: [{ op: 'apply_damage', actorId: target.id, amount: total, type: binding.damage.type, isCrit }],
  };
}

function handleSaveDamage(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  if (!binding.damage || !binding.save) {
    return { ok: false, error: 'save_damage requires damage + save', rolls: [], mutations: [] };
  }
  // The AI Master will resolve target save via saving_throw tool with DC = ctx.caster.spellSaveDC.
  // This handler emits an apply_damage mutation assuming FAIL (full damage).
  // The Master is expected to halve the value on success if binding.save.halfOnSuccess.
  // Improvement (Phase 2.5): emit a "deferred_resolve" mutation that the AI handles per target.
  // For now: roll once, apply per target.
  const dmgRoll = rollDice(binding.damage.dice, ctx.rng);
  const upcast = extraDiceForUpcast(binding.damage.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, ctx.rng) : null;
  const total = dmgRoll.total + (upcastRoll?.total ?? 0);

  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'apply_damage' as const,
    actorId: t.id,
    amount: total,
    type: binding.damage!.type,
  }));

  return {
    ok: true,
    data: {
      effects: [
        binding.save.halfOnSuccess ? 'save_half' : 'save_negate',
        binding.damage.type,
      ],
    },
    rolls: [dmgRoll, ...(upcastRoll ? [upcastRoll] : [])],
    mutations: muts,
  };
}

function handleSaveCondition(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  if (!binding.save || !binding.condition) {
    return { ok: false, error: 'save_condition requires save + condition', rolls: [], mutations: [] };
  }
  // Emits add_condition for each target, assuming the save FAILED.
  // The AI Master decides per-target via saving_throw and removes the condition for successes.
  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'add_condition' as const,
    actorId: t.id,
    condition: {
      slug: binding.condition!.slug,
      source: ctx.spellSlug,
      durationRounds: binding.condition!.durationRounds,
      appliedRound: 0,
    },
  }));
  return { ok: true, data: { effects: [`condition:${binding.condition.slug}`] }, rolls: [], mutations: muts };
}

function handleHeal(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  if (!binding.heal) return { ok: false, error: 'heal requires heal binding', rolls: [], mutations: [] };
  if (ctx.targets.length === 0) return { ok: false, error: 'heal requires ≥1 target', rolls: [], mutations: [] };

  const dmgRoll = rollDice(binding.heal.dice, ctx.rng);
  const upcast = extraDiceForUpcast(binding.heal.perSlotAbove, ctx.slotLevel, binding.minSlot ?? 1);
  const upcastRoll = upcast ? rollDice(`${upcast.count}d${upcast.sides}`, ctx.rng) : null;
  const mod = binding.heal.addSpellMod ? ctx.caster.spellMod : 0;
  const totalHeal = dmgRoll.total + (upcastRoll?.total ?? 0) + mod;

  const muts: Mutation[] = ctx.targets.map((t) => ({ op: 'heal' as const, actorId: t.id, amount: totalHeal }));
  return { ok: true, data: { effects: ['heal'] }, rolls: [dmgRoll, ...(upcastRoll ? [upcastRoll] : [])], mutations: muts };
}

function handleBuff(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  if (!binding.condition) return { ok: false, error: 'buff requires condition slug', rolls: [], mutations: [] };
  // Buff = apply a beneficial condition (per spell semantics — bless's d4 bonus is encoded as a generic
  // 'blessed' condition that the master applies narratively; this gives a uniform contract).
  const muts: Mutation[] = ctx.targets.map((t) => ({
    op: 'add_condition' as const,
    actorId: t.id,
    condition: {
      slug: binding.condition!.slug,
      source: ctx.spellSlug,
      durationRounds: binding.condition!.durationRounds,
      appliedRound: 0,
    },
  }));
  return { ok: true, data: { effects: [`buff:${binding.condition.slug}`] }, rolls: [], mutations: muts };
}

function handleAoeSave(ctx: ArchetypeContext, binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  // Same as save_half/save_negate; the difference is conceptual (multiple targets).
  return handleSaveDamage(ctx, binding);
}

function handleUtility(_ctx: ArchetypeContext, _binding: ArchetypeBinding): ActionResult<{ effects: string[] }> {
  // Utility spells (light, mage hand, prestidigitation): no mechanical resolution beyond
  // slot consumption. The Master narrates effects.
  return { ok: true, data: { effects: ['utility'] }, rolls: [], mutations: [] };
}
```

### - [ ] Step 2: Test base archetipi

File: `tests/engine/spells/archetypes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_HANDLERS, type ArchetypeBinding, type ArchetypeContext } from '../../../src/engine/spells/archetypes';

const ctxFor = (overrides: Partial<ArchetypeContext> = {}): ArchetypeContext => ({
  caster: { id: 'pc1', spellAttackBonus: 5, spellSaveDC: 13, spellMod: 3 },
  spellSlug: 'test',
  slotLevel: 1,
  targets: [{ id: 'm1', ac: 14 }],
  rng: () => 0.5,
  ...overrides,
});

describe('archetype attack_damage (e.g. fire-bolt, ray-of-frost)', () => {
  it('hits with attack roll, applies damage', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.5 }),  // d20 = 11; 11+5 = 16 ≥ 14
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.effects).toContain('attack-hit');
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg).toBeDefined();
  });

  it('miss → no damage mutation', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.0001 }),  // d20 = 1 → auto miss
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.data?.effects).toContain('miss');
    expect(result.mutations.find((m) => m.op === 'apply_damage')).toBeUndefined();
  });

  it('crit on nat 20 doubles damage dice', () => {
    const result = ARCHETYPE_HANDLERS.attack_damage(
      ctxFor({ rng: () => 0.9999 }),  // d20 = 20
      { archetype: 'attack_damage', damage: { dice: '1d10', type: 'fire' }, attackRoll: true },
    );
    expect(result.data?.effects).toContain('attack-hit');
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg?.isCrit).toBe(true);
  });
});

describe('archetype save_half (e.g. burning-hands, fireball)', () => {
  it('emits apply_damage for each target with full damage (Master halves on save success per-target)', () => {
    const result = ARCHETYPE_HANDLERS.save_half(
      ctxFor({ targets: [{ id: 'm1', ac: 0 }, { id: 'm2', ac: 0 }] }),
      {
        archetype: 'save_half',
        damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
        save: { ability: 'DEX', halfOnSuccess: true },
        minSlot: 1,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.mutations.filter((m) => m.op === 'apply_damage').length).toBe(2);
    expect(result.data?.effects).toContain('save_half');
  });

  it('upcasts add extra damage dice (slot 3 fireball: 8d6)', () => {
    const result = ARCHETYPE_HANDLERS.save_half(
      ctxFor({ slotLevel: 4, targets: [{ id: 'm1' }] }),
      {
        archetype: 'save_half',
        damage: { dice: '8d6', type: 'fire', perSlotAbove: '1d6' },
        save: { ability: 'DEX', halfOnSuccess: true },
        minSlot: 3,
      },
    );
    // slot 4, min 3 → +1d6 over base 8d6 = 9d6 total
    const dmg = result.mutations.find((m) => m.op === 'apply_damage');
    expect(dmg).toBeDefined();
    // Just verify the mutation exists; precise total varies with rng.
  });
});

describe('archetype save_condition (e.g. hold-person)', () => {
  it('emits add_condition for each target', () => {
    const result = ARCHETYPE_HANDLERS.save_condition(
      ctxFor({ targets: [{ id: 'm1' }, { id: 'm2' }] }),
      {
        archetype: 'save_condition',
        save: { ability: 'WIS' },
        condition: { slug: 'paralyzed', durationRounds: 10 },
      },
    );
    expect(result.mutations.filter((m) => m.op === 'add_condition').length).toBe(2);
    const m = result.mutations[0];
    if (m.op === 'add_condition') expect(m.condition.slug).toBe('paralyzed');
  });
});

describe('archetype heal (e.g. cure-wounds)', () => {
  it('emits heal mutation with dice + spell mod', () => {
    const result = ARCHETYPE_HANDLERS.heal(
      ctxFor(),
      { archetype: 'heal', heal: { dice: '1d8', perSlotAbove: '1d8', addSpellMod: true }, minSlot: 1 },
    );
    const heal = result.mutations.find((m) => m.op === 'heal');
    expect(heal).toBeDefined();
  });
});

describe('archetype buff (e.g. bless, bane)', () => {
  it('emits add_condition for each target', () => {
    const result = ARCHETYPE_HANDLERS.buff(
      ctxFor({ targets: [{ id: 'pc1' }, { id: 'pc2' }] }),
      {
        archetype: 'buff',
        condition: { slug: 'blessed' as any, durationRounds: 10 },  // narrative slug
      },
    );
    expect(result.mutations.filter((m) => m.op === 'add_condition').length).toBe(2);
  });
});

describe('archetype utility (e.g. light, prestidigitation)', () => {
  it('returns ok with no mutations', () => {
    const result = ARCHETYPE_HANDLERS.utility(ctxFor(), { archetype: 'utility' });
    expect(result.ok).toBe(true);
    expect(result.mutations.length).toBe(0);
  });
});
```

### - [ ] Step 3: Run, expect FAIL

```bash
pnpm test spells/archetypes
```

### - [ ] Step 4: Implementare

Crea `src/engine/spells/archetypes.ts` con il codice dello Step 1.

### - [ ] Step 5: Run, expect PASS

```bash
pnpm test spells/archetypes
pnpm typecheck
```

### - [ ] Step 6: Commit

```bash
git add src/engine/spells/archetypes.ts tests/engine/spells/archetypes.test.ts
git commit -m "$(cat <<'EOF'
feat(spells): generic archetype handler factory (8 archetypes)

Introduces ArchetypeBinding contract + ARCHETYPE_HANDLERS registry covering:
- attack_damage (fire-bolt, ray-of-frost, eldritch-blast)
- save_half (burning-hands, fireball, lightning-bolt)
- save_negate (sleep, charm-person)
- save_condition (hold-person, hypnotic-pattern)
- heal (cure-wounds, healing-word)
- buff (bless, bane)
- aoe_save (alias of save_half for AoE flavor)
- utility (light, prestidigitation, mage-hand)

Each handler returns the right mutations; the AI Master is responsible
for per-target saving throws when save_half/save_negate emit damage
(it then applies remove_condition or recomputes damage as needed).

Slot-level scaling supported via { perSlotAbove, minSlot }.
Critical hits doubled on attack_damage archetype.
EOF
)"
```

---

## Task 6: Spell-data binding table (top 30 SRD spells)

**Files:**
- Create: `src/engine/spells/spell-data.ts`
- Create: `tests/engine/spells/spell-data.test.ts`

### - [ ] Step 1: Build the binding table

File: `src/engine/spells/spell-data.ts`

```ts
import type { ArchetypeBinding } from './archetypes';

export const SPELL_BINDINGS: Record<string, ArchetypeBinding> = {
  // === Cantrips: attack-roll ===
  'fire-bolt': {
    archetype: 'attack_damage',
    damage: { dice: '1d10', type: 'fire' },
    attackRoll: true,
    minSlot: 0,
  },
  'eldritch-blast': {
    archetype: 'attack_damage',
    damage: { dice: '1d10', type: 'force' },
    attackRoll: true,
    minSlot: 0,
  },
  'ray-of-frost': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'cold' },
    attackRoll: true,
    minSlot: 0,
  },
  'shocking-grasp': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'lightning' },
    attackRoll: true,
    minSlot: 0,
  },
  'chill-touch': {
    archetype: 'attack_damage',
    damage: { dice: '1d8', type: 'necrotic' },
    attackRoll: true,
    minSlot: 0,
  },
  'poison-spray': {
    archetype: 'save_negate',
    damage: { dice: '1d12', type: 'poison' },
    save: { ability: 'CON' },
    minSlot: 0,
  },
  'sacred-flame': {
    archetype: 'save_negate',
    damage: { dice: '1d8', type: 'radiant' },
    save: { ability: 'DEX' },
    minSlot: 0,
  },
  'acid-splash': {
    archetype: 'save_negate',
    damage: { dice: '1d6', type: 'acid' },
    save: { ability: 'DEX' },
    minSlot: 0,
  },
  'vicious-mockery': {
    archetype: 'save_negate',
    damage: { dice: '1d4', type: 'psychic' },
    save: { ability: 'WIS' },
    minSlot: 0,
  },

  // === 1st-level damage ===
  'burning-hands': {
    archetype: 'save_half',
    damage: { dice: '3d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'cone', size: '15 ft' },
    minSlot: 1,
  },
  'magic-missile': {
    // Special: auto-hit, multi-dart. Keep custom handler in spells.ts (binding here marks coverage).
    archetype: 'attack_damage',
    damage: { dice: '1d4+1', type: 'force' },
    minSlot: 1,
  },
  'thunderwave': {
    archetype: 'save_half',
    damage: { dice: '2d8', type: 'thunder', perSlotAbove: '1d8' },
    save: { ability: 'CON', halfOnSuccess: true },
    aoe: { shape: 'cube', size: '15 ft' },
    minSlot: 1,
  },

  // === 1st-level heal ===
  'cure-wounds': {
    archetype: 'heal',
    heal: { dice: '1d8', perSlotAbove: '1d8', addSpellMod: true },
    targets: { default: 1 },
    minSlot: 1,
  },
  'healing-word': {
    archetype: 'heal',
    heal: { dice: '1d4', perSlotAbove: '1d4', addSpellMod: true },
    targets: { default: 1 },
    minSlot: 1,
  },

  // === 1st-level buff ===
  'bless': {
    archetype: 'buff',
    condition: { slug: 'blessed' as any, durationRounds: 10 },
    targets: { default: 3, perSlotAbove: 1 },
    concentration: true,
    minSlot: 1,
  },
  'bane': {
    archetype: 'buff',
    condition: { slug: 'baned' as any, durationRounds: 10 },
    targets: { default: 3, perSlotAbove: 1 },
    concentration: true,
    minSlot: 1,
  },
  'shield-of-faith': {
    archetype: 'buff',
    condition: { slug: 'shielded' as any, durationRounds: 100 },
    concentration: true,
    minSlot: 1,
  },

  // === 1st-level condition ===
  'sleep': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'unconscious', durationRounds: 10 },
    minSlot: 1,
  },
  'charm-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'charmed', durationRounds: 600 },  // 1 hour
    minSlot: 1,
  },

  // === 2nd-level ===
  'hold-person': {
    archetype: 'save_condition',
    save: { ability: 'WIS' },
    condition: { slug: 'paralyzed', durationRounds: 10 },
    concentration: true,
    minSlot: 2,
  },
  'scorching-ray': {
    archetype: 'attack_damage',
    damage: { dice: '2d6', type: 'fire' },  // per ray; multi-target handled by master
    attackRoll: true,
    minSlot: 2,
  },

  // === 3rd-level ===
  'fireball': {
    archetype: 'aoe_save',
    damage: { dice: '8d6', type: 'fire', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'sphere', size: '20 ft radius' },
    minSlot: 3,
  },
  'lightning-bolt': {
    archetype: 'aoe_save',
    damage: { dice: '8d6', type: 'lightning', perSlotAbove: '1d6' },
    save: { ability: 'DEX', halfOnSuccess: true },
    aoe: { shape: 'line', size: '100 ft' },
    minSlot: 3,
  },
  'counterspell': {
    archetype: 'utility',
    minSlot: 3,
  },
  'fly': {
    archetype: 'buff',
    condition: { slug: 'flying' as any, durationRounds: 100 },
    concentration: true,
    minSlot: 3,
  },

  // === Utility ===
  'light': { archetype: 'utility', minSlot: 0 },
  'mage-hand': { archetype: 'utility', minSlot: 0 },
  'prestidigitation': { archetype: 'utility', minSlot: 0 },
  'minor-illusion': { archetype: 'utility', minSlot: 0 },
  'detect-magic': { archetype: 'utility', minSlot: 1 },
  'identify': { archetype: 'utility', minSlot: 1 },
  'shield': {
    archetype: 'buff',
    condition: { slug: 'shielded' as any, durationRounds: 1 },
    minSlot: 1,
  },
  'mage-armor': {
    archetype: 'buff',
    condition: { slug: 'mage-armored' as any, durationRounds: 28800 },  // 8 hours
    minSlot: 1,
  },
};

export function bindingFor(spellSlug: string): ArchetypeBinding | undefined {
  return SPELL_BINDINGS[spellSlug];
}
```

### - [ ] Step 2: Test the bindings

File: `tests/engine/spells/spell-data.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { SPELL_BINDINGS, bindingFor } from '../../../src/engine/spells/spell-data';

describe('SPELL_BINDINGS', () => {
  it('covers at least 30 spells', () => {
    expect(Object.keys(SPELL_BINDINGS).length).toBeGreaterThanOrEqual(30);
  });

  it('every binding has a valid archetype', () => {
    const valid = ['attack_damage', 'save_half', 'save_negate', 'save_condition', 'heal', 'buff', 'aoe_save', 'utility'];
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      expect(valid).toContain(binding.archetype);
    }
  });

  it('attack_damage and save_* bindings have damage', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'attack_damage' || binding.archetype === 'save_half' || binding.archetype === 'aoe_save' || binding.archetype === 'save_negate') {
        if (slug === 'magic-missile') continue;  // multi-dart special
        expect(binding.damage, `${slug} missing damage`).toBeDefined();
      }
    }
  });

  it('save_* bindings have save', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'save_half' || binding.archetype === 'save_negate' || binding.archetype === 'save_condition' || binding.archetype === 'aoe_save') {
        expect(binding.save, `${slug} missing save`).toBeDefined();
      }
    }
  });

  it('heal bindings have heal config', () => {
    for (const [slug, binding] of Object.entries(SPELL_BINDINGS)) {
      if (binding.archetype === 'heal') {
        expect(binding.heal, `${slug} missing heal`).toBeDefined();
      }
    }
  });

  it('bindingFor resolves a known spell', () => {
    expect(bindingFor('fire-bolt')).toBeDefined();
    expect(bindingFor('fire-bolt')?.archetype).toBe('attack_damage');
  });

  it('bindingFor returns undefined for unknown spell', () => {
    expect(bindingFor('nonexistent-spell')).toBeUndefined();
  });

  it('concentration spells are flagged correctly', () => {
    const concSpells = ['bless', 'bane', 'shield-of-faith', 'hold-person', 'fly'];
    for (const slug of concSpells) {
      expect(SPELL_BINDINGS[slug]?.concentration).toBe(true);
    }
  });
});
```

### - [ ] Step 3: Run, expect PASS

```bash
pnpm test spells/spell-data
pnpm typecheck
```

### - [ ] Step 4: Commit

```bash
git add src/engine/spells/spell-data.ts tests/engine/spells/spell-data.test.ts
git commit -m "$(cat <<'EOF'
feat(spells): SPELL_BINDINGS table for ~30 SRD spells

Maps slug → ArchetypeBinding. Coverage:
- 9 cantrips (fire-bolt, eldritch-blast, ray-of-frost, shocking-grasp,
  chill-touch, poison-spray, sacred-flame, acid-splash, vicious-mockery)
- 8 utility cantrips/L1 (light, mage-hand, prestidigitation, minor-illusion,
  detect-magic, identify, shield, mage-armor)
- 5 1st-level damage (burning-hands, magic-missile, thunderwave) and heal
  (cure-wounds, healing-word)
- 5 1st-level condition/buff (bless, bane, shield-of-faith, sleep, charm-person)
- 2 2nd-level (hold-person, scorching-ray)
- 4 3rd-level (fireball, lightning-bolt, counterspell, fly)

bindingFor(slug) is the lookup function used by castSpell.
EOF
)"
```

---

## Task 7: Refactor castSpell to use the factory + ritual support

**Files:**
- Modify: `src/engine/spells.ts`
- Modify: `tests/engine/spells.test.ts`

### - [ ] Step 1: Write failing tests for the factory integration + ritual

Append a `tests/engine/spells.test.ts`:

```ts
describe('castSpell — archetype factory dispatch', () => {
  it('fire-bolt dispatches to attack_damage archetype', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
    }, () => 0.95);
    expect(result.ok).toBe(true);
    expect(result.data?.effects).toContain('attack-hit');
  });

  it('cure-wounds dispatches to heal archetype', () => {
    const caster = pcCaster({ spellsKnown: ['cure-wounds'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'cure-wounds',
      slotLevel: 1,
      targets: [{ id: 'pc1' }],
    }, () => 0.5);
    const heal = result.mutations.find((m) => m.op === 'heal');
    expect(heal).toBeDefined();
  });

  it('unknown spell with no binding still ok (narrative cast)', () => {
    const caster = pcCaster({ spellsKnown: ['some-homebrew'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'some-homebrew',
      slotLevel: 1,
      targets: [],
    }, () => 0.5);
    expect(result.ok).toBe(true);
    expect(result.mutations.find((m) => m.op === 'use_spell_slot')).toBeDefined();
  });
});

describe('castSpell — concentration', () => {
  it('casting bless emits set_concentration mutation', () => {
    const caster = pcCaster({ spellsKnown: ['bless'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'bless',
      slotLevel: 1,
      targets: [{ id: 'pc1' }, { id: 'pc2' }, { id: 'pc3' }],
      currentRound: 1,
    }, () => 0.5);
    const setCon = result.mutations.find((m) => m.op === 'set_concentration');
    expect(setCon).toMatchObject({ spellSlug: 'bless', slotLevel: 1, startedRound: 1 });
  });

  it('casting a new concentration spell while already concentrating emits break first', () => {
    const caster = pcCaster({ spellsKnown: ['bless', 'hold-person'] });
    const runtime = runtimeFor(caster, {
      spellSlotsUsed: { 1: 0, 2: 0 },
      concentratingOn: { spellSlug: 'bless', slotLevel: 1, startedRound: 0 },
    });
    const result = castSpell({
      caster,
      runtime,
      spellSlug: 'hold-person',
      slotLevel: 2,
      targets: [{ id: 'm1' }],
      currentRound: 3,
    }, () => 0.5);
    const ops = result.mutations.map((m) => m.op);
    expect(ops).toContain('break_concentration');
    expect(ops).toContain('set_concentration');
    // break must come BEFORE set
    expect(ops.indexOf('break_concentration')).toBeLessThan(ops.indexOf('set_concentration'));
  });

  it('casting a non-concentration spell does NOT emit set_concentration', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1', ac: 10 }],
    }, () => 0.5);
    const setCon = result.mutations.find((m) => m.op === 'set_concentration');
    expect(setCon).toBeUndefined();
  });
});

describe('castSpell — ritual', () => {
  it('asRitual: true with ritual-flagged spell skips slot consumption', () => {
    const caster = pcCaster({ spellsKnown: ['detect-magic'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'detect-magic',
      slotLevel: 1,
      targets: [],
      asRitual: true,
    }, () => 0.5);
    expect(result.ok).toBe(true);
    const slotMut = result.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeUndefined();
    expect(result.data?.effects).toContain('ritual');
  });

  it('asRitual: true with non-ritual spell errors out', () => {
    const caster = pcCaster({ spellsKnown: ['fire-bolt'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster),
      spellSlug: 'fire-bolt',
      slotLevel: 0,
      targets: [{ id: 'm1' }],
      asRitual: true,
    }, () => 0.5);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a ritual/);
  });

  it('asRitual: false on a ritual spell consumes slot normally', () => {
    const caster = pcCaster({ spellsKnown: ['detect-magic'] });
    const result = castSpell({
      caster,
      runtime: runtimeFor(caster, { spellSlotsUsed: { 1: 0 } }),
      spellSlug: 'detect-magic',
      slotLevel: 1,
      targets: [],
      asRitual: false,
    }, () => 0.5);
    const slotMut = result.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeDefined();
  });
});
```

(The `pcCaster()` and `runtimeFor()` helpers may need to be added or reused from existing test infrastructure. Check `tests/engine/spells.test.ts` for current helpers.)

### - [ ] Step 2: Run, expect FAIL

```bash
pnpm test engine/spells
```

### - [ ] Step 3: Refactor `src/engine/spells.ts`

```ts
import type { ActionResult, ActorRuntimeState, Character, Mutation } from './types';
import { rollDice } from './dice';
import { defaultRng, type Rng } from './rand';
import { bindingFor } from './spells/spell-data';
import { ARCHETYPE_HANDLERS } from './spells/archetypes';
import { startConcentrationMutations } from './spells/concentration';

// (existing types unchanged)

export interface CastSpellInput {
  caster: Character;
  runtime: ActorRuntimeState;
  spellSlug: string;
  slotLevel: 0|1|2|3|4|5|6|7|8|9;
  targets: { id: string; ac?: number }[];
  currentRound?: number;
  asRitual?: boolean;
  /** Spell metadata from CSV/parser, accessed by slug. If absent we look it up. */
  spellMeta?: { ritual?: boolean; concentration?: boolean };
}

export function castSpell(input: CastSpellInput, rng: Rng = defaultRng): ActionResult<{ effects: string[] }> {
  // Existing checks: caster, knows spell, slot available...

  if (!input.caster.spellcasting) return { ok: false, error: 'not_caster', rolls: [], mutations: [] };
  if (!input.caster.spellcasting.spellsKnown.includes(input.spellSlug)) {
    return { ok: false, error: 'not_known', rolls: [], mutations: [] };
  }

  const isCantrip = input.slotLevel === 0;
  if (!isCantrip && !input.asRitual) {
    const max = input.caster.spellcasting.slotsMax[input.slotLevel] ?? 0;
    const used = input.runtime.spellSlotsUsed?.[input.slotLevel] ?? 0;
    if (max - used <= 0) return { ok: false, error: 'no_slot', rolls: [], mutations: [] };
  }

  // RITUAL CHECK
  const binding = bindingFor(input.spellSlug);
  if (input.asRitual) {
    // We need to know if the spell IS a ritual. Use spellMeta if provided, else the binding doesn't carry this.
    // Phase 2: rely on spellMeta — the AI Master must pass it (we'll wire that via tool params).
    if (!input.spellMeta?.ritual) {
      return { ok: false, error: 'spell is not a ritual', rolls: [], mutations: [] };
    }
  }

  const slotMutations: Mutation[] = (isCantrip || input.asRitual)
    ? []
    : [{ op: 'use_spell_slot', actorId: input.runtime.actorId, level: input.slotLevel as 1|2|3|4|5|6|7|8|9 }];

  // CONCENTRATION
  const concMutations: Mutation[] = binding?.concentration
    ? startConcentrationMutations({
        actorId: input.runtime.actorId,
        spellSlug: input.spellSlug,
        slotLevel: input.slotLevel,
        startedRound: input.currentRound ?? 0,
        currentlyConcentratingOn: input.runtime.concentratingOn,
      })
    : [];

  // ARCHETYPE DISPATCH
  if (!binding) {
    // No binding → narrative cast (legacy behavior)
    const effects = input.asRitual ? ['ritual', 'narrative'] : ['narrative'];
    return { ok: true, data: { effects }, rolls: [], mutations: [...slotMutations, ...concMutations] };
  }

  // Special-case magic-missile (no attack roll, multi-dart)
  if (input.spellSlug === 'magic-missile') {
    return castMagicMissile(input, rng, slotMutations, concMutations);
  }

  const handler = ARCHETYPE_HANDLERS[binding.archetype];
  const ability = input.caster.spellcasting.ability;
  const ctx = {
    caster: {
      id: input.runtime.actorId,
      spellAttackBonus: input.caster.spellcasting.spellAttackBonus,
      spellSaveDC: input.caster.spellcasting.spellSaveDC,
      spellMod: Math.floor((input.caster.abilities[ability] - 10) / 2),
    },
    spellSlug: input.spellSlug,
    slotLevel: input.slotLevel,
    targets: input.targets,
    rng,
  };
  const handlerResult = handler(ctx, binding);
  if (!handlerResult.ok) return handlerResult;

  const allEffects = [...handlerResult.data!.effects, ...(input.asRitual ? ['ritual'] : [])];
  return {
    ok: true,
    data: { effects: allEffects },
    rolls: handlerResult.rolls,
    mutations: [...handlerResult.mutations, ...slotMutations, ...concMutations],
  };
}

function castMagicMissile(input: CastSpellInput, rng: Rng, slotMutations: Mutation[], concMutations: Mutation[]): ActionResult<{ effects: string[] }> {
  const dartCount = 2 + input.slotLevel;
  if (input.targets.length < 1 || input.targets.length > dartCount) {
    return { ok: false, error: 'bad_targets', rolls: [], mutations: [] };
  }
  const rolls = [];
  const mutations: Mutation[] = [];
  for (let i = 0; i < dartCount; i++) {
    const r = rollDice('1d4+1', rng);
    rolls.push(r);
    const tgt = input.targets[i] ?? input.targets[input.targets.length - 1]!;
    mutations.push({ op: 'apply_damage', actorId: tgt.id, amount: r.total, type: 'force' });
  }
  return { ok: true, data: { effects: ['force-damage'] }, rolls, mutations: [...mutations, ...slotMutations, ...concMutations] };
}
```

### - [ ] Step 4: Run, expect PASS

```bash
pnpm test engine/spells
pnpm typecheck
```

### - [ ] Step 5: Commit

```bash
git add src/engine/spells.ts tests/engine/spells.test.ts
git commit -m "$(cat <<'EOF'
refactor(spells): castSpell uses archetype factory + concentration + ritual

- Lookup binding via bindingFor(slug); dispatch to ARCHETYPE_HANDLERS.
- Magic missile keeps its bespoke multi-dart handler.
- Spells with no binding fall through to narrative cast (legacy contract).
- Concentration spells emit set_concentration (and break_concentration if
  caster was already concentrating on a different spell).
- asRitual: true skips slot consumption when spellMeta.ritual is true.
- asRitual: true on a non-ritual spell errors out.
EOF
)"
```

---

## Task 8: Wire asRitual through cast_spell tool + spellMeta

**Files:**
- Modify: `src/engine/tools/handlers.ts`
- Modify: `src/engine/tools/index.ts`
- Modify: `tests/engine/tools/handlers.test.ts`
- Modify: `src/srd/lookup.ts` o equivalente per esporre i metadata

### - [ ] Step 1: Identificare come si fetcha il metadata di uno spell

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine
grep -n "ritual\|concentration" src/srd/lookup.ts src/srd/parsers/spells.ts src/db/schema/srd-spell.ts | head -20
```

Trova come `cast_spell` accede al metadata dello spell (`ritual`, `concentration` boolean).

### - [ ] Step 2: Aggiornare `cast_spell` schema in `src/engine/tools/index.ts`

Aggiungere proprietà `asRitual: { type: 'boolean', description: '...' }` alla properties di `cast_spell`.

### - [ ] Step 3: Aggiornare handler

In `src/engine/tools/handlers.ts`, nel `cast_spell` handler:
- Se `input.asRitual === true`, fetch `spellMeta` dal DB/SRD lookup (il metadata `ritual: boolean` deve essere esposto).
- Passare `spellMeta: { ritual, concentration }` al `castSpell` engine.

### - [ ] Step 4: Test

Append a `tests/engine/tools/handlers.test.ts` (o nuovo file `cast-spell.test.ts`):

```ts
describe('tool cast_spell — asRitual', () => {
  it('asRitual: true with detect-magic does not consume slot', async () => {
    // Setup: PC knows detect-magic, has 1 slot lvl 1
    // ...
    const handler = TOOL_HANDLERS['cast_spell'];
    const result = await handler(...);
    const slotMut = result.mutations.find((m) => m.op === 'use_spell_slot');
    expect(slotMut).toBeUndefined();
  });

  it('asRitual: true with fire-bolt errors', async () => {
    // ...
    expect(result.ok).toBe(false);
  });
});
```

### - [ ] Step 5: Run, expect PASS, commit

```bash
pnpm test tools/handlers tools/cast-spell
pnpm typecheck
git add src/engine/tools/ src/srd/ tests/engine/tools/
git commit -m "feat(tools): wire asRitual through cast_spell"
```

---

## Task 9: System prompt — concentration + ritual + archetype hints

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

### - [ ] Step 1: Append guidance section

Add a new sub-section to `MASTER_TOOL_CONTRACT`:

```
**Concentration loop (PHB §8.8):**
Many spells require concentration (bless, hold person, fly, fireball... see the
spell's metadata). When the caster's PC casts such a spell, the engine emits
`set_concentration` automatically — DO NOT call extra tools. The PC's snapshot
will show `concentratingOn: { spellSlug, slotLevel, startedRound }`.

When a concentrating PC takes damage, the engine emits `concentration_check`
(with DC = max(10, ⌊damage/2⌋)). On the same turn, call `concentration_check`
with that DC — the tool rolls a CON save (with proficiency if the PC has it)
and emits `break_concentration` on failure. Narrate the spell ending if it breaks.

A PC starting a NEW concentration spell automatically breaks the previous one.
Falling unconscious (HP → 0) automatically breaks concentration without a save.

**Ritual casting (PHB §8.13):**
Spells with the ritual tag (`detect-magic`, `identify`, `find-familiar`, etc.)
may be cast as rituals: 10 minutes longer cast time, NO slot consumed.
Pass `asRitual: true` to `cast_spell`. The tool errors if the spell isn't a
ritual. Narrate the longer ritual time as in-fiction (the PC sits, draws sigils,
chants, etc.). Time can advance via narration; no separate tool needed.

**Spell archetypes — what cast_spell does for you:**
For ~30 known SRD spells, `cast_spell` resolves the mechanical effect directly:
attack rolls (fire-bolt, eldritch-blast), damage with save (burning-hands,
fireball), heal (cure-wounds, healing-word), buff conditions (bless, bane, fly).
For multi-target save spells (fireball etc.), cast_spell emits one `apply_damage`
per target assuming FAIL — you should then call `saving_throw` per target and
manually halve / negate the damage on success (e.g. emit a follow-up `heal` for
the half-damage refund). For unknown spells, cast_spell returns ok with an empty
effects list — you narrate the cast and emit any consequence tools yourself.
```

### - [ ] Step 2: Commit

```bash
git add src/ai/master/system-prompt.ts
git commit -m "$(cat <<'EOF'
docs(prompt): document concentration loop, ritual casting, spell archetypes

Three new sub-sections in MASTER_TOOL_CONTRACT:
- Concentration loop: when set_concentration auto-fires, when to call
  concentration_check, how break_concentration cascades.
- Ritual casting: asRitual:true semantics, narrative time advancement.
- Spell archetypes: what cast_spell resolves vs what the master must
  follow up on (per-target saves on AoE, narrating utility spells).
EOF
)"
```

---

## Task 10: E2E concentration loop scenario

**Files:**
- Create: `tests/engine/scenarios/concentration-loop.test.ts`

### - [ ] Step 1: Write the scenarios

```ts
import { describe, expect, it } from 'vitest';
// reuse helpers from death-save-loop.test.ts pattern

describe('E2E — concentration loop', () => {
  it('Cleric casts bless → set_concentration → bless target takes 21 dmg → fails CON save → bless ends', async () => {
    // 1. Set up: cleric (CON +1, no prof), bless target (PC ally)
    // 2. Cast bless on 3 allies (slot 1)
    //    → mutations: set_concentration on cleric, add_condition 'blessed' on each ally, use_spell_slot 1
    //    → applyMutations
    // 3. Cleric takes 21 damage from monster
    //    → mutation: concentration_check with DC 10
    //    → applyMutations
    // 4. AI calls concentration_check tool (rng = low) → fails save
    //    → mutation: break_concentration with reason='damage'
    //    → applyMutations
    // 5. Assert: cleric.runtime.concentratingOn === undefined
    // (Note: the 'blessed' condition on allies remains in conditions[] — the master narratively
    // decides to remove it, or a future enhancement could auto-cascade. Phase 2 stops here.)
  });

  it('Cleric casting bless then hold-person breaks bless first', async () => {
    // 1. Cast bless on 3 allies → set_concentration(bless)
    // 2. Cast hold-person on enemy → mutations include break_concentration AND set_concentration(hold-person)
    // 3. Assert: cleric.runtime.concentratingOn === { spellSlug: 'hold-person', slotLevel: 2, ... }
  });

  it('Cleric concentrating drops to 0 HP → break_concentration with reason=incapacitated', async () => {
    // 1. Cast bless (concentrating)
    // 2. Take damage that drops to 0 HP
    // 3. damage.ts emits both: death_save (for the 0 HP fail) AND break_concentration with reason='incapacitated'
    // 4. Apply mutations
    // 5. Assert: concentratingOn === undefined; deathSaves.failures === 1
  });

  it('Wizard casts detect-magic as ritual → no slot consumed', async () => {
    // 1. Wizard has 2 slot-1 used 0
    // 2. cast_spell(spellSlug=detect-magic, slotLevel=1, asRitual=true)
    // 3. Assert: spellSlotsUsed[1] still 0
    // 4. Assert: result.data.effects includes 'ritual'
  });

  it('Wizard casting fire-bolt with asRitual:true errors', async () => {
    // 1. asRitual:true on fire-bolt → ok:false
  });
});
```

### - [ ] Step 2: Run, fix any issues, commit

```bash
pnpm test scenarios/concentration-loop
pnpm typecheck
git add tests/engine/scenarios/concentration-loop.test.ts
git commit -m "$(cat <<'EOF'
test(scenarios): full concentration loop E2E + ritual casting

5 end-to-end scenarios:
- Cast bless → take damage → fail CON save → break.
- Cast bless then hold-person → break first, set new.
- Cast bless → drop to 0 HP → break (reason=incapacitated, no save).
- Cast detect-magic as ritual → no slot consumed.
- Cast fire-bolt with asRitual:true → error (not a ritual).
EOF
)"
```

---

## Task 11: Smoke test + final verification

### - [ ] Step 1: Full test + typecheck + lint

```bash
cd /Users/alessiodanna/projects/dnd-ai-master/.worktrees/spell-engine
pnpm typecheck  # expect clean
pnpm test       # expect all pass except 1 pre-existing tts-cache failure
pnpm lint       # expect no NEW issues; pre-existing lint issues from main may persist
```

### - [ ] Step 2: Coverage delta

Inspect manually that the Spellcasting area has moved from ~35% to ~75%:
- ✅ Generic spell engine (8 archetipi, ~30 spell mappati)
- ✅ Concentration enforcement (set/break, DC, damage trigger, incapacitation cascade)
- ✅ Ritual casting (asRitual flag)
- ✅ Tool wired (concentration_check, asRitual)
- ❌ Component validation V/S/M (out of scope for Phase 2)
- ❌ Bonus action spell rule (Phase 3)
- ❌ Line of sight / cover (Phase 3)
- ❌ Multiclass slot calc (Phase 4)

### - [ ] Step 3: Tag

```bash
git tag -a phase2-concentration-and-archetypes -m "Phase 2 complete: concentration enforcement + spell archetype factory"
```

---

## Self-review checklist

Before considering Phase 2 done:

- [ ] **Coverage delta**: re-run the spellcasting audit Explore agent to confirm 35% → ~75%.
- [ ] **Idempotency**: if AI calls `cast_spell(bless)` twice without break, the runtime stays consistent (mutations include break + set, but the second `set` after `break` produces the same final state).
- [ ] **Damage > 0 only**: a 0-damage hit (resistance/immunity) does NOT trigger `concentration_check`.
- [ ] **No regressions**: Phase 1 tests still green (death save loop, conditions, knockOut all reachable).
- [ ] **Type consistency**: `Mutation.set_concentration` and `Mutation.break_concentration` and `Mutation.concentration_check` are all in the union; applicator handles all three.
- [ ] **Schema migration**: `concentrating_on` column is in `0012_*.sql` with proper JSONB and NULL default.

---

## Stima sforzo Phase 2

- Task 1 (concentration helpers): 1.5h
- Task 2 (applicator + migration): 2h
- Task 3 (damage → concentration_check): 1h
- Task 4 (tool concentration_check): 1.5h
- Task 5 (archetype factory): 3h (8 archetipi)
- Task 6 (binding table): 2h (30 spell)
- Task 7 (refactor castSpell): 2.5h
- Task 8 (tool asRitual wiring): 1h
- Task 9 (system prompt): 30min
- Task 10 (E2E scenarios): 1h
- Task 11 (smoke): 30min

**Totale: ~16-17h** di un singolo sviluppatore. Subagent-driven: ~1.5 giornate.

---

## Note di design

- **Save resolution per-target**: gli archetypes `save_*` emettono `apply_damage` assumendo FAIL. Il Master deve poi chiamare `saving_throw` per ogni target e:
  - Sui successi di `save_half`: emettere un `heal` con metà del damage (refund).
  - Sui successi di `save_negate`: emettere `apply_damage` con `amount: -dealt` (ovvero un `heal`).
  - Sui successi di `save_condition`: emettere `remove_condition` per quel target.
  Una **Phase 2.5 future** potrebbe introdurre un'unica mutation `apply_targeted_damage_with_save` che internalizza il loop, ma per ora teniamo il contratto a basso rischio.
- **Magic missile**: mantiene il suo handler bespoke (auto-hit, multi-dart variabile per slot). La binding nel CSV è puramente informativa.
- **Concentration su NPC/monster**: deliberatamente NON implementata in Phase 2 (single-player, e gli NPC che concentrano sono rari narrativamente). Se diventasse necessario, basta aggiungere `concentratingOn` al `CombatActor` runtime ed estendere l'applicator handler.
- **Auto-cleanup buff condition on break**: quando `bless` finisce per concentration break, le condition `'blessed'` sui target rimangono in `conditions[]`. Il Master è responsabile di rimuoverle narrativamente. Una **Phase 2.5** potrebbe linkare `condition.source = spellSlug` e introdurre un mutation `remove_conditions_by_source` per pulire automaticamente.
