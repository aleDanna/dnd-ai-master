# Coverage 90% — Phase 9: Spell Engine Expansion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espandere SPELL_BINDINGS da 33 a 150+ spell del SRD + aggiungere V/S/M component validation + spellcasting focus tracking. Porta Spellcasting da 60% a ~85%.

**Architecture:**
- **Component validation** (PHB §8.3): every spell has Verbal/Somatic/Material flags. Engine validates:
  - **Verbal**: caster must not have `silenced` or `unable_to_speak` condition; gagged/silenced creature can't cast V spells.
  - **Somatic**: caster must have at least one free hand OR be wielding a spellcasting focus (PHB §8.4).
  - **Material**: caster must have the material component if explicitly required and consumed.
- **Spellcasting focus** (PHB §8.4):
  - `Character.equippedFocus?: { kind: 'arcane'|'druidic'|'holy'|'instrument'; itemSlug: string }`.
  - Tool `equip_focus({ character, kind, itemSlug })` and `unequip_focus`.
  - Focus satisfies somatic AND material (when material doesn't have a specified cost).
- **Spell bindings expansion**: add bindings for the most-used SRD spells (~120 more), bringing coverage to ~150 total.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: equippedFocus on characters). Builds on Phase 1-8.

---

## File Structure

### File da creare:
- `src/engine/spells/components.ts` — pure helpers (parseComponents, validateComponents, focusSatisfies)
- `tests/engine/spells/components.test.ts`
- `tests/engine/scenarios/spell-components-loop.test.ts`
- `drizzle/0018_*.sql`

### File da modificare:
- `src/engine/types.ts` — `SpellComponents`, `FocusKind`, `EquippedFocus`; mutation `set_focus`/`unset_focus`; Character.equippedFocus; ConditionSlug add 'silenced'
- `src/db/schema/characters.ts` — colonna equipped_focus jsonb
- `src/engine/condition-effects.ts` — silenced no-op applier (mirrors blessed/baned)
- `src/sessions/applicator.ts` — handler set_focus/unset_focus
- `src/sessions/snapshot.ts` — hydrate equippedFocus
- `src/engine/spells.ts` — extend CastSpellInput with components validation
- `src/engine/spells/spell-data.ts` — expand bindings to 150+ spells
- `src/engine/tools/handlers.ts` — equip_focus/unequip_focus + extend cast_spell with hasMaterial param
- `src/engine/tools/index.ts` — schema updates
- `src/srd/lookup.ts` — lookupSpellMeta returns components string
- `src/ai/master/system-prompt.ts` — guidance section

---

## Task 1: Component validation helpers

### Step 1: Types + parser

```ts
// types.ts
export interface SpellComponents {
  verbal: boolean;
  somatic: boolean;
  material: boolean;
  /** Free-text material description (e.g., "silver dust 25 gp consumed", "a sprig of mistletoe"). */
  materialDescription?: string;
  /** True if material has explicit cost or is consumed (focus cannot replace). */
  materialCostly?: boolean;
}

export type FocusKind = 'arcane' | 'druidic' | 'holy' | 'instrument';

export interface EquippedFocus {
  kind: FocusKind;
  itemSlug: string;
}

// Character (extend):
equippedFocus?: EquippedFocus;

// Mutations:
| { op: 'set_focus'; characterId: string; focus: EquippedFocus }
| { op: 'unset_focus'; characterId: string }

// ConditionSlug (extend): 'silenced'
```

### Step 2: Parser

```ts
// src/engine/spells/components.ts
import type { SpellComponents } from '../types';

/** Parse a PHB-style components string like "V S M (a sprig of mistletoe)" or "V" or "V S M (silver dust worth 25 gp)". */
export function parseComponents(s: string | undefined | null): SpellComponents {
  const text = (s ?? '').trim();
  if (!text) {
    return { verbal: false, somatic: false, material: false };
  }
  const verbal = /\bV\b/i.test(text);
  const somatic = /\bS\b/i.test(text);
  const materialMatch = text.match(/\bM\b\s*\(([^)]*)\)/i);
  const material = !!materialMatch || /\bM\b/i.test(text);
  const materialDescription = materialMatch?.[1]?.trim();
  // "Costly" if description mentions a gp cost OR "consumed".
  const materialCostly = materialDescription
    ? /\b\d+\s*(?:gp|sp|ep|cp|pp)\b/i.test(materialDescription) || /consumed/i.test(materialDescription)
    : false;
  return { verbal, somatic, material, materialDescription, materialCostly };
}
```

### Step 3: Validator

```ts
import type { SpellComponents, EquippedFocus, ConditionInstance } from '../types';

export interface ValidateComponentsInput {
  components: SpellComponents;
  /** Conditions on the caster — used to detect 'silenced' for V. */
  casterConditions: ConditionInstance[];
  /** True if the caster has at least one free hand (no weapon/shield in both). */
  freeHand: boolean;
  /** Currently equipped focus, if any. */
  equippedFocus?: EquippedFocus;
  /** True if the caster has the material component in inventory (for material-required spells). */
  hasMaterial: boolean;
  /** True if the spellcaster's class can use the equipped focus's kind for this spell. */
  canUseFocus: boolean;
}

export type ComponentError = 'silenced' | 'no_free_hand' | 'missing_material';

export function validateComponents(input: ValidateComponentsInput): ComponentError | null {
  if (input.components.verbal && input.casterConditions.some((c) => c.slug === 'silenced')) {
    return 'silenced';
  }
  if (input.components.somatic) {
    // Somatic requires a free hand OR a focus held.
    const focusInHand = !!input.equippedFocus && input.canUseFocus;
    if (!input.freeHand && !focusInHand) return 'no_free_hand';
  }
  if (input.components.material) {
    // Focus replaces material when material is NOT costly. Costly (consumed/gp) require explicit possession.
    if (input.components.materialCostly) {
      if (!input.hasMaterial) return 'missing_material';
    } else {
      // Non-costly material: focus OR explicit possession works.
      const focusReplaces = !!input.equippedFocus && input.canUseFocus;
      if (!focusReplaces && !input.hasMaterial) return 'missing_material';
    }
  }
  return null;
}

/** PHB §8.4 focus eligibility per class. */
export function focusKindForClass(classSlug: string): FocusKind | null {
  switch (classSlug) {
    case 'sorcerer':
    case 'warlock':
    case 'wizard':
      return 'arcane';
    case 'druid':
    case 'ranger':
      return 'druidic';
    case 'cleric':
    case 'paladin':
      return 'holy';
    case 'bard':
      return 'instrument';
    default:
      return null;
  }
}
```

### Step 4: Tests

`tests/engine/spells/components.test.ts`:
- parseComponents: empty, "V", "V S", "V S M", "V S M (silver dust 25 gp)", "V S M (consumed)", "V M (sprig)" — verify all flags
- validateComponents: silenced + V → error; somatic without hand or focus → error; material costly without possess → error; material non-costly with focus → ok
- focusKindForClass: all 12 classes mapped correctly

### Step 5: Commit
`feat(spells): component parser + validator (PHB §8.3)`.

---

## Task 2: Schema + applicator + migration

### Step 1: Schema

```ts
// src/db/schema/characters.ts
equippedFocus: jsonb('equipped_focus').$type<{ kind: string; itemSlug: string } | null>().default(null),
```

### Step 2: Migration

```bash
pnpm db:generate
pnpm db:migrate
```

### Step 3: Applicator

```ts
case 'set_focus': {
  await tx.update(charactersTable).set({ equippedFocus: m.focus }).where(eq(charactersTable.id, m.characterId));
  break;
}
case 'unset_focus': {
  await tx.update(charactersTable).set({ equippedFocus: null }).where(eq(charactersTable.id, m.characterId));
  break;
}
```

### Step 4: Snapshot hydration

`character.equippedFocus = row.equippedFocus ?? undefined` (defensive validation: if focus.kind is not in FocusKind union, drop).

### Step 5: condition-effects.ts

Add `silenced` to ConditionSlug + no-op applier (silenced's only effect is gating V spells; handled in component validation).

### Step 6: Tests + commit

3 applicator tests + commit `feat(applicator): set_focus/unset_focus + migration 0018; silenced condition`.

---

## Task 3: castSpell components integration

### Step 1: Update CastSpellInput

```ts
spellMeta?: {
  ritual?: boolean;
  concentration?: boolean;
  castingTime?: string;
  /** PHB-style components string e.g., "V S M (silver dust 25 gp)". */
  components?: string;
};
/** Caster has a free hand for somatic. Default true. */
freeHand?: boolean;
/** Caster has the spell's material in inventory. Default true (Master responsibility). */
hasMaterial?: boolean;
```

### Step 2: Validate before slot consumption

```ts
import { parseComponents, validateComponents, focusKindForClass } from './spells/components';

// After ritual check, before slot check:
if (input.spellMeta?.components) {
  const components = parseComponents(input.spellMeta.components);
  const componentError = validateComponents({
    components,
    casterConditions: input.runtime.conditions,
    freeHand: input.freeHand ?? true,
    equippedFocus: input.caster.equippedFocus,
    hasMaterial: input.hasMaterial ?? true,
    canUseFocus: input.caster.equippedFocus
      ? focusKindForClass(input.caster.classSlug) === input.caster.equippedFocus.kind
      : false,
  });
  if (componentError) {
    return { ok: false, error: `component_${componentError}`, rolls: [], mutations: [] };
  }
}
```

### Step 3: Tests in `spells.test.ts`

```ts
describe('castSpell — component validation', () => {
  it('silenced caster cannot cast V spell', () => { /* ... */ });
  it('no free hand + no focus → component_no_free_hand', () => { /* ... */ });
  it('focus replaces non-costly material', () => { /* ... */ });
  it('costly material requires actual possession even with focus', () => { /* ... */ });
  it('hasMaterial: true (default) bypasses material check', () => { /* ... */ });
  it('S-only spell does not check verbal/material', () => { /* ... */ });
});
```

### Step 4: Commit
`feat(spells): component validation in castSpell (PHB §8.3)`.

---

## Task 4: Tools — equip_focus, unequip_focus + cast_spell extension

### Step 1: Handlers

```ts
export function handleEquipFocus(
  ctx: ToolCtx, state: EngineState,
  input: { character: string; kind: FocusKind; itemSlug: string },
): ActionResult<{ equipped: boolean }> {
  const char = state.characters.find((c) => c.id === input.character);
  if (!char) return { ok: false, error: 'unknown_character', rolls: [], mutations: [] };
  
  // Validate kind
  if (!['arcane', 'druidic', 'holy', 'instrument'].includes(input.kind)) {
    return { ok: false, error: 'invalid_focus_kind', rolls: [], mutations: [] };
  }
  
  // Validate item is in inventory
  const hasItem = char.inventory.some((i) => i.slug === input.itemSlug);
  if (!hasItem) return { ok: false, error: 'item_not_in_inventory', rolls: [], mutations: [] };
  
  return {
    ok: true, data: { equipped: true },
    rolls: [],
    mutations: [{ op: 'set_focus', characterId: char.id, focus: { kind: input.kind, itemSlug: input.itemSlug } }],
  };
}

export function handleUnequipFocus(...): ActionResult<{ unequipped: boolean }> {
  // Idempotent
}
```

### Step 2: Extend cast_spell tool handler

In the cast_spell handler, also pass `freeHand` and `hasMaterial` from input to castSpell. Default both true. The Master decides.

Update lookupSpellMeta to also fetch `components` string from srdSpell.

### Step 3: Tool defs in index.ts

```ts
{
  name: 'equip_focus',
  description: 'PHB §8.4: equip a spellcasting focus. Kinds: arcane (orb/rod/staff/wand for sorcerer/warlock/wizard), druidic (sprig/totem/wooden staff for druid/ranger), holy (holy symbol for cleric/paladin), instrument (musical for bard). Focus replaces somatic free-hand requirement and non-costly material components.',
  ...
},
{ name: 'unequip_focus', ... },
```

Update cast_spell schema with `freeHand` and `hasMaterial` optional booleans.

### Step 4: Tests + commit

`feat(tools): equip_focus/unequip_focus + cast_spell freeHand/hasMaterial wiring`.

---

## Task 5: SPELL_BINDINGS expansion (~120 more spells)

Add bindings for the most-used SRD spells. Target: 150+ total bindings.

Categories to expand:
- **Cantrips** (current 9): add booming-blade, green-flame-blade (if SRD), spare-the-dying, thaumaturgy, true-strike, druidcraft.
- **1st-level damage**: chromatic-orb, magic-stone, hellish-rebuke, witch-bolt, ice-knife.
- **1st-level utility**: alarm, comprehend-languages, detect-evil-and-good, detect-poison-and-disease, expeditious-retreat, false-life, feather-fall, find-familiar, fog-cloud, goodberry, grease, jump, longstrider, mage-armor (already), protection-from-evil-and-good, purify-food-and-drink, sanctuary, silent-image, sleep (already), speak-with-animals, thunderwave (already), unseen-servant.
- **1st-level buff/heal**: cure-wounds (already), healing-word (already), bless (already), bane (already), shield-of-faith (already), command, divine-favor, faerie-fire, guiding-bolt, hex, hunter's-mark, inflict-wounds.
- **2nd-level**: aid, alter-self, animal-messenger, arcane-lock, augury, barkskin, blindness-deafness, blur, branding-smite, calm-emotions, continual-flame, darkness, darkvision, detect-thoughts, enhance-ability, enlarge-reduce, find-traps, flame-blade, flaming-sphere, gust-of-wind, heat-metal, hold-person (already), invisibility, knock, levitate, lesser-restoration, locate-animals-or-plants, locate-object, magic-mouth, magic-weapon, melf's-acid-arrow, mirror-image, misty-step, moonbeam, pass-without-trace, prayer-of-healing, protection-from-poison, ray-of-enfeeblement, rope-trick, scorching-ray (already), see-invisibility, shatter, silence, spider-climb, spike-growth, spiritual-weapon, suggestion, warding-bond, web, zone-of-truth.
- **3rd-level**: animate-dead, beacon-of-hope, bestow-curse, blink, call-lightning, clairvoyance, conjure-animals, counterspell (already), create-food-and-water, daylight, dispel-magic, fear, feign-death, fireball (already), fly (already), gaseous-form, glyph-of-warding, haste, hypnotic-pattern, leomund's-tiny-hut, lightning-bolt (already), magic-circle, major-image, mass-healing-word, meld-into-stone, nondetection, plant-growth, protection-from-energy, remove-curse, revivify, sending, sleet-storm, slow, speak-with-dead, speak-with-plants, spirit-guardians, stinking-cloud, tongues, vampiric-touch, water-breathing, water-walk, wind-wall.
- **4th-level**: arcane-eye, banishment, blight, compulsion, confusion, conjure-minor-elementals, conjure-woodland-beings, control-water, death-ward, dimension-door, divination, dominate-beast, fabricate, faithful-hound, fire-shield, flame-strike (no — this is 5th), freedom-of-movement, giant-insect, grasping-vine, greater-invisibility, guardian-of-faith, hallucinatory-terrain, ice-storm, leomund's-secret-chest, locate-creature, otiluke's-resilient-sphere, phantasmal-killer, polymorph, private-sanctum, resilient-sphere, secret-chest, stone-shape, stoneskin, wall-of-fire.
- **5th-level**: animate-objects, antilife-shell, awaken, bigby's-hand, cloudkill, commune, commune-with-nature, cone-of-cold, conjure-elemental, contact-other-plane, contagion, creation, dispel-evil-and-good, dominate-person, dream, flame-strike, geas, greater-restoration, hallow, hold-monster, insect-plague, legend-lore, mass-cure-wounds, mislead, modify-memory, passwall, planar-binding, raise-dead, rary's-telepathic-bond, reincarnate, scrying, seeming, swift-quiver, telekinesis, teleportation-circle, tree-stride, wall-of-force, wall-of-stone.

NB: many of these are too complex to fully bind mechanically. Strategy:
- Damage spells with simple roll: bind to attack_damage / save_half / aoe_save.
- Buff/condition: bind to buff or save_condition.
- Heal: bind to heal.
- Utility (most spells with no rolls): bind to utility.
- Complex spells (polymorph, true-resurrection, wish): leave UNBOUND → narrative cast.

Target: ~150 bindings; non bound spells si comportano comunque correttamente (slot consume + narrative).

Aggiungi i bindings + test che enumera ~150 bindings. Commit: `feat(spells): expand SPELL_BINDINGS to 150+ SRD spells`.

---

## Task 6: System prompt update

Add new section in MASTER_TOOL_CONTRACT:

```
### Spell Components & Focus (PHB §8.3, §8.4)

When the AI Master calls `cast_spell`, the engine validates V/S/M components:
- **Verbal (V)**: caster must not be silenced/gagged. Add `silenced` condition
  to block verbal casting.
- **Somatic (S)**: caster needs a free hand OR a held spellcasting focus
  matching their class.
- **Material (M)**: caster needs the listed material in inventory if the
  spell specifies a cost (e.g., "diamond dust worth 100 gp"). Non-costly
  materials are replaced by a focus.

Tools: `equip_focus({ character, kind, itemSlug })` to mark a focus held;
`unequip_focus({ character })` to drop. Pass `freeHand: false` to cast_spell
if the caster has both hands occupied (no focus, no spell). Pass
`hasMaterial: false` if you've narratively determined the material is missing.

Focus kinds per class (PHB §8.4):
- Arcane: sorcerer, warlock, wizard
- Druidic: druid, ranger
- Holy symbol: cleric, paladin
- Instrument: bard

Errors: `component_silenced`, `component_no_free_hand`, `component_missing_material`.

---

Italiano: Phase 9 valida i componenti V/S/M degli incantesimi. Equip un focus
con `equip_focus`. Default freeHand=true e hasMaterial=true (responsabilità
narrativa del Master sovrascriverli).
```

Commit.

---

## Task 7: E2E + smoke

`tests/engine/scenarios/spell-components-loop.test.ts`:
1. Wizard equipa arcane focus → casta fire-bolt OK senza free hand.
2. Wizard NON equipa focus + entrambe le mani occupate → fire-bolt errors component_no_free_hand.
3. Wizard silenced → fire-bolt errors component_silenced (V required).
4. Cleric senza holy symbol equipato + mani occupate → cure-wounds errors component_no_free_hand.
5. Wizard casta find-familiar (M consumed: charcoal/incense/herbs 10 gp) senza i materiali → component_missing_material.
6. Wizard casta wish (no spell binding) → narrative cast OK con slot consume + componenti validati.

`pnpm test`, `pnpm typecheck`.

Commit final tweaks.

---

## Self-review checklist

- [ ] Coverage delta: Spellcasting 60% → 85%.
- [ ] Backward compat: tutti i nuovi field opzionali; default freeHand=true, hasMaterial=true.
- [ ] Component validation BEFORE slot consume (so refused casts don't burn slots).
- [ ] silenced condition added to ConditionSlug union with no-op applier.
- [ ] Focus kinds per class match PHB §8.4 exactly.

---

## Stima sforzo Phase 9

- Task 1 (helpers): 1.5h
- Task 2 (schema + applicator): 1.5h
- Task 3 (castSpell integration): 1.5h
- Task 4 (tools): 1h
- Task 5 (~120 bindings): 3h
- Task 6 (prompt): 30min
- Task 7 (E2E + smoke): 1h

**Totale: ~10h** developer; subagent-driven: ~1.5 giornate.
