# Coverage 90% — Phase 10: Multiclassing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare il sistema multiclassing PHB §2.5: prerequisiti ability minimi, multi-class spell slot table, hit dice/HP per class level. Porta Character Creation da 82% a ~95%.

**Architecture:**

Il refactor critico: `Character.classSlug: string` (single class) deve diventare `Character.classes: ClassLevel[]` (multi-class). Per backward compat:
- Mantenere `classSlug` come getter/derived field = first class slug
- Aggiungere `classes: ClassLevel[]` array dove il primo è la "starting class"

```ts
export interface ClassLevel {
  slug: string;       // class slug
  level: number;      // levels in this class (1+)
  subclass?: string;  // subclass slug if chosen
}
```

`Character.level` rimane = sum of class levels (total character level).

**Multiclassing prerequisites** (PHB §2.5): adding a level in a new class requires meeting the ability minimums of BOTH starting class and new class:
- Barbarian: STR 13
- Bard: CHA 13
- Cleric: WIS 13
- Druid: WIS 13
- Fighter: STR 13 OR DEX 13
- Monk: DEX 13 AND WIS 13
- Paladin: STR 13 AND CHA 13
- Ranger: DEX 13 AND WIS 13
- Rogue: DEX 13
- Sorcerer: CHA 13
- Warlock: CHA 13
- Wizard: INT 13

**Multi-class spell slot table** (PHB §13): combine caster levels:
- Full caster (Bard, Cleric, Druid, Sorcerer, Wizard): full level count
- Half caster (Paladin, Ranger): floor(level / 2)
- Third caster (Eldritch Knight subclass of Fighter, Arcane Trickster of Rogue): floor(level / 3)
- Warlock: separate Pact Magic slots (NOT combined)

Combined caster level → consult full caster spell slot table.

**Tool**: `add_class_level({ characterId, classSlug, subclass? })` validates prereqs + appends to classes array. Tool `level_up` extended to accept optional classSlug for multiclass progression.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration). Builds on Phase 1-9.

---

## File Structure

### File da creare:
- `src/engine/multiclass.ts` — pure helpers (multiclassPrereqs, casterLevel, combinedSpellSlots)
- `tests/engine/multiclass.test.ts`
- `tests/engine/scenarios/multiclass-loop.test.ts`
- `drizzle/0019_*.sql`

### File da modificare:
- `src/engine/types.ts` — `ClassLevel` interface; `Character.classes: ClassLevel[]` (with classSlug as backward-compat alias)
- `src/db/schema/characters.ts` — colonna `classes` jsonb (con `classSlug` mantained as legacy column or as derived view)
- `src/engine/levelup.ts` — gestione multiclass progression
- `src/engine/tools/handlers.ts` — `add_class_level` handler
- `src/engine/tools/index.ts` — schema
- `src/sessions/applicator.ts` — handler `add_class_level`
- `src/sessions/snapshot.ts` — hydrate classes array
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Types + helpers

### Step 1: Types

```ts
// types.ts
export interface ClassLevel {
  slug: string;
  level: number;
  subclass?: string;
}

// Character (backward compat):
export interface Character {
  // ...existing
  /** Multi-class breakdown. First entry is the starting class. Sum of levels = Character.level. */
  classes?: ClassLevel[];
  // classSlug remains as the primary class slug for legacy callers.
}

// Mutation:
| { op: 'add_class_level'; characterId: string; classSlug: string; subclass?: string }
```

### Step 2: Helpers

```ts
// src/engine/multiclass.ts
import type { Character, ClassLevel } from './types';

export const MULTICLASS_PREREQS: Record<string, { mode: 'and' | 'or'; mins: Partial<Record<'STR'|'DEX'|'CON'|'INT'|'WIS'|'CHA', number>> }> = {
  barbarian: { mode: 'and', mins: { STR: 13 } },
  bard: { mode: 'and', mins: { CHA: 13 } },
  cleric: { mode: 'and', mins: { WIS: 13 } },
  druid: { mode: 'and', mins: { WIS: 13 } },
  fighter: { mode: 'or', mins: { STR: 13, DEX: 13 } },
  monk: { mode: 'and', mins: { DEX: 13, WIS: 13 } },
  paladin: { mode: 'and', mins: { STR: 13, CHA: 13 } },
  ranger: { mode: 'and', mins: { DEX: 13, WIS: 13 } },
  rogue: { mode: 'and', mins: { DEX: 13 } },
  sorcerer: { mode: 'and', mins: { CHA: 13 } },
  warlock: { mode: 'and', mins: { CHA: 13 } },
  wizard: { mode: 'and', mins: { INT: 13 } },
};

export function meetsMulticlassPrereqs(character: Character, newClassSlug: string): boolean {
  // Adding a level to existing class: no prereq check (only when adding NEW class).
  const existingClasses = (character.classes ?? []).map((c) => c.slug);
  if (existingClasses.includes(newClassSlug)) return true;
  
  // Must meet starting class's prereqs AND new class's prereqs.
  const startingClass = character.classes?.[0]?.slug ?? character.classSlug;
  for (const slug of [startingClass, newClassSlug]) {
    const prereq = MULTICLASS_PREREQS[slug];
    if (!prereq) continue;
    const checks = Object.entries(prereq.mins).map(([ab, min]) => character.abilities[ab as 'STR'] >= min);
    if (prereq.mode === 'and' && !checks.every(Boolean)) return false;
    if (prereq.mode === 'or' && !checks.some(Boolean)) return false;
  }
  return true;
}

/** PHB §13.2: spell-slot caster level for multiclassing. */
export const CASTER_TYPE: Record<string, 'full' | 'half' | 'third' | 'pact' | 'none'> = {
  bard: 'full', cleric: 'full', druid: 'full', sorcerer: 'full', wizard: 'full',
  paladin: 'half', ranger: 'half',
  // 'third' for Eldritch Knight (fighter) and Arcane Trickster (rogue) — handled via subclass below
  fighter: 'none', rogue: 'none',
  monk: 'none', barbarian: 'none',
  warlock: 'pact',
};

export function combinedCasterLevel(classes: ClassLevel[]): number {
  let total = 0;
  for (const cl of classes) {
    const type = CASTER_TYPE[cl.slug] ?? 'none';
    switch (type) {
      case 'full': total += cl.level; break;
      case 'half':
        // PHB: half-caster levels count as half (rounded down) for slot calc; PHB§13.2 says round DOWN
        // EXCEPT: half-casters at level 1 in their class don't grant slots (paladin/ranger get spells at L2).
        if (cl.level >= 2) total += Math.floor(cl.level / 2);
        break;
      case 'third':
        // Eldritch Knight / Arcane Trickster — third-caster, level >= 3 to start.
        if (cl.level >= 3) total += Math.floor(cl.level / 3);
        break;
      case 'pact':
      case 'none':
      default:
        break;
    }
    // Third caster via subclass (Eldritch Knight / Arcane Trickster)
    if ((cl.slug === 'fighter' && cl.subclass === 'eldritch-knight') ||
        (cl.slug === 'rogue' && cl.subclass === 'arcane-trickster')) {
      if (cl.level >= 3) total += Math.floor(cl.level / 3);
    }
  }
  return total;
}

/** Standard full-caster slot table from PHB §13.1. */
const FULL_CASTER_SLOTS: Partial<Record<1|2|3|4|5|6|7|8|9, number>>[] = [
  /* Lvl 0 unused */ {},
  /* 1 */  { 1: 2 },
  /* 2 */  { 1: 3 },
  /* 3 */  { 1: 4, 2: 2 },
  /* 4 */  { 1: 4, 2: 3 },
  /* 5 */  { 1: 4, 2: 3, 3: 2 },
  /* 6 */  { 1: 4, 2: 3, 3: 3 },
  /* 7 */  { 1: 4, 2: 3, 3: 3, 4: 1 },
  /* 8 */  { 1: 4, 2: 3, 3: 3, 4: 2 },
  /* 9 */  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  /* 10 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  /* 11 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  /* 12 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  /* 13 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  /* 14 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  /* 15 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  /* 16 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  /* 17 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  /* 18 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  /* 19 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  /* 20 */ { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
];

export function spellSlotsForCasterLevel(casterLevel: number): Partial<Record<1|2|3|4|5|6|7|8|9, number>> {
  if (casterLevel < 1) return {};
  const idx = Math.min(20, Math.max(1, casterLevel));
  return { ...FULL_CASTER_SLOTS[idx] };
}
```

### Step 3: Tests

`tests/engine/multiclass.test.ts`:
- `meetsMulticlassPrereqs`: each of 12 classes; AND vs OR mode; existing class re-level no-check; missing prereq → false
- `combinedCasterLevel`: full caster only; half caster at level 1 (= 0 contribution); half caster at level 2 (= 1); third caster Eldritch Knight at level 3 (= 1); pact/non-caster (= 0)
- `spellSlotsForCasterLevel`: every level 1-20 maps correctly

### Step 4: Commit
`feat(multiclass): prereqs + caster level + spell slot helpers (PHB §2.5, §13)`.

---

## Task 2: Schema + applicator + migration

### Step 1: Schema

```ts
// src/db/schema/characters.ts
classes: jsonb('classes').$type<{ slug: string; level: number; subclass?: string }[]>().default([]),
```

(NB: `classSlug` column remains for legacy compat — derived from `classes[0].slug` if classes is non-empty.)

### Step 2: Migration

```bash
pnpm db:generate  # produces 0019_*.sql with classes column
pnpm db:migrate
```

### Step 3: Backfill on character read

In snapshot.ts hydration:
```ts
const classes = (Array.isArray(row.classes) && row.classes.length > 0)
  ? row.classes
  : [{ slug: row.classSlug, level: row.level }];  // backfill from legacy
character.classes = classes;
character.classSlug = classes[0].slug;  // keep alias
```

### Step 4: Applicator handler

```ts
case 'add_class_level': {
  const [c] = await tx.select({ classes: charactersTable.classes, level: charactersTable.level })
    .from(charactersTable).where(eq(charactersTable.id, m.characterId));
  if (!c) break;
  
  const classes = (Array.isArray(c.classes) && c.classes.length > 0) ? c.classes : [];
  const existingIdx = classes.findIndex((cl) => cl.slug === m.classSlug);
  let newClasses: ClassLevel[];
  if (existingIdx >= 0) {
    newClasses = [...classes];
    newClasses[existingIdx] = { ...newClasses[existingIdx], level: newClasses[existingIdx].level + 1 };
    if (m.subclass) newClasses[existingIdx].subclass = m.subclass;
  } else {
    newClasses = [...classes, { slug: m.classSlug, level: 1, subclass: m.subclass }];
  }
  
  const newTotalLevel = newClasses.reduce((s, cl) => s + cl.level, 0);
  await tx.update(charactersTable)
    .set({ classes: newClasses, level: newTotalLevel })
    .where(eq(charactersTable.id, m.characterId));
  break;
}
```

### Step 5: Tests + commit

`feat(applicator): add_class_level handler + migration 0019`.

---

## Task 3: Tool `add_class_level`

### Step 1: Handler

```ts
import { meetsMulticlassPrereqs } from '../multiclass';

export function handleAddClassLevel(
  ctx: ToolCtx, state: EngineState,
  input: { character: string; classSlug: string; subclass?: string },
): ActionResult<{ added: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  // Validate class slug
  const valid = ['barbarian','bard','cleric','druid','fighter','monk','paladin','ranger','rogue','sorcerer','warlock','wizard'];
  if (!valid.includes(input.classSlug)) {
    return { ok: false, error: 'invalid_class_slug', rolls: [], mutations: [] };
  }
  
  // Multiclass prereq check
  if (!meetsMulticlassPrereqs(char, input.classSlug)) {
    return { ok: false, error: 'multiclass_prereqs_not_met', rolls: [], mutations: [] };
  }
  
  return {
    ok: true, data: { added: true },
    rolls: [],
    mutations: [{ op: 'add_class_level', characterId: char.id, classSlug: input.classSlug, subclass: input.subclass }],
  };
}
```

### Step 2: Tool definition

```ts
{
  name: 'add_class_level',
  description: 'PHB §2.5: add a level to a character. If the slug matches an existing class, level it up. If new, multiclass — requires ability prereqs (e.g., Wizard requires INT 13). Returns multiclass_prereqs_not_met on failure.',
  input_schema: {
    type: 'object',
    properties: {
      character: { type: 'string' },
      classSlug: { type: 'string', enum: ['barbarian','bard','cleric','druid','fighter','monk','paladin','ranger','rogue','sorcerer','warlock','wizard'] },
      subclass: { type: 'string', description: 'Optional subclass slug for archetype tracking' },
    },
    required: ['character', 'classSlug'],
  },
}
```

### Step 3: Tests + commit

`feat(tools): add_class_level tool with prereq validation`.

---

## Task 4: System prompt

```
### Multiclassing (PHB §2.5)

A PC may add levels in classes other than their starting class, subject to
ability prerequisites:

| Class | Prereq |
|---|---|
| Barbarian | STR 13 |
| Bard | CHA 13 |
| Cleric | WIS 13 |
| Druid | WIS 13 |
| Fighter | STR 13 OR DEX 13 |
| Monk | DEX 13 AND WIS 13 |
| Paladin | STR 13 AND CHA 13 |
| Ranger | DEX 13 AND WIS 13 |
| Rogue | DEX 13 |
| Sorcerer | CHA 13 |
| Warlock | CHA 13 |
| Wizard | INT 13 |

A multiclassing PC must meet BOTH the starting class's AND the new class's
prereqs. Use `add_class_level({ character, classSlug, subclass? })` to add
a level. Errors `multiclass_prereqs_not_met` on failure.

The PC's snapshot shows `classes: [{slug, level, subclass?}]`. Total character
level = sum of class levels.

**Spell slots for multi-classers** (PHB §13.2):
- Full casters (bard/cleric/druid/sorcerer/wizard): each level counts in full.
- Half casters (paladin/ranger): floor(level/2). Doesn't contribute at level 1.
- Third casters (Eldritch Knight, Arcane Trickster): floor(level/3). Starts at level 3.
- Warlock Pact Magic: SEPARATE from the multiclass slot table.

Sum these to get combined caster level, then consult the full-caster slot table.

---

Italiano: Phase 10 aggiunge multiclassing — chiama `add_class_level` con il
nuovo class slug; il motore valida prereqs di abilità (es. Wizard richiede
INT 13). I caster multiclass usano una slot table combinata.
```

Commit.

---

## Task 5: E2E + smoke

`tests/engine/scenarios/multiclass-loop.test.ts`:
1. Fighter STR 16 → add Wizard level → fails (INT 10 < 13).
2. Fighter STR 16 INT 13 → add Wizard level → succeeds; classes = [fighter, wizard].
3. Bard 5 + Wizard 5 → combined caster level 10 → spell slots match level 10 full-caster table.
4. Paladin 5 + Wizard 5 → caster level = 2 (floor(5/2)) + 5 = 7 → match level 7 slots.
5. Fighter 5 (Eldritch Knight) + Wizard 5 → caster level = floor(5/3)=1 + 5 = 6.
6. Warlock multiclass: Warlock 5 + Wizard 5 → Wizard slots from level-5 caster table; Warlock pact slots separate.

Commit + push.

---

## Self-review checklist

- [ ] Coverage delta: Character Creation 82% → ~95%.
- [ ] Backward compat: existing single-class characters work without changes (classes derived from classSlug).
- [ ] PHB §2.5 prereqs exact match.
- [ ] Half-caster level 1 doesn't grant slots (PHB rule).
- [ ] Eldritch Knight / Arcane Trickster start contributing at level 3.

---

## Stima sforzo Phase 10

- Task 1 (helpers): 2.5h
- Task 2 (schema + applicator + migration): 2h
- Task 3 (tool): 1h
- Task 4 (prompt): 30min
- Task 5 (E2E): 1.5h

**Totale: ~7.5h** developer; subagent-driven: ~1 giornata.
