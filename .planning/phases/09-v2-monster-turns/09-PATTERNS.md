# Phase 09: v2 Monster Turns - Pattern Map

**Mapped:** 2026-05-30
**Files analyzed:** 7 (1 new, 6 modified)
**Analogs found:** 7 / 7

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/engine/combat/monster-turns.ts` (NEW) | service | request-response | `src/app/api/sessions/[id]/turn/combat-resolver.ts` | exact — same "pure function, injectable RNG, events out, defensive null" contract |
| `src/ai/master/vault/events-schema.ts` (MODIFY) | config | CRUD | self — analog is the existing `ac?` / `initiativeBonus?` optional field pattern in `monster_spawn` | exact — additive optional field, same validator branch |
| `src/ai/master/vault/projector.ts` (MODIFY) | service | CRUD | self — analog is how `ac` and `initiativeBonus` are copied from spawn payload into `EncounterState.monsters[]` | exact — same copy pattern, same optional guard |
| `src/ai/master/vault/prompt-builder.ts` (MODIFY) | config | transform | self — analog is the existing `combatLifecycleBlock()` static lines array | exact — same `lines.push(...)` pattern |
| `src/ai/master/vault/tools.ts` (MODIFY) | config | transform | self — analog is the existing `monster_spawn` payload description string at line 101 | exact — same inline description string edit |
| `src/ai/master/vault/turn-directive.ts` (MODIFY) | middleware | request-response | self — analog is the `serverResolved` flag + its two `if (!serverResolved && ...)` guards | exact — `monsterResolved` mirrors this pattern 1:1 |
| `src/app/api/sessions/[id]/turn/route.ts` (MODIFY) | controller | request-response | self — analog is the `_resolver` block (lines 377-422) and the `buildTurnDirective(serverResolved:...)` call (lines 442-471) | exact — monster loop hooks at the same gate pattern, same flag plumbing |

---

## Pattern Assignments

### `src/engine/combat/monster-turns.ts` (NEW — service, request-response)

**Primary analog:** `src/app/api/sessions/[id]/turn/combat-resolver.ts`
**Secondary analog for hit rule:** `src/engine/combat/attack.ts` lines 341-365
**Test analog:** `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts`

#### Imports pattern (from combat-resolver.ts lines 29-31 + engine imports)

```typescript
import type { EncounterState } from '@/ai/master/vault/projector';
import type { VaultEvent } from '@/ai/master/vault/events-schema';
import { rollD20, rollDamage } from '@/engine/dice';
import { defaultRng, type Rng } from '@/engine/rand';
```

#### Result interface pattern (from combat-resolver.ts lines 58-63)

The v1 `ResolveCombatResult` is the template. `MonsterTurnResult` mirrors its shape — discriminated kind, events out, a directive field, no throws.

```typescript
// MIRROR of ResolveCombatResult (combat-resolver.ts:58-63):
export interface ResolveCombatResult {
  kind: 'to-hit' | 'damage' | 'none';
  events: VaultEvent[];
  narrationDirective: string;
  damageRequest: string | null;
}

// v2 parallel interface for a single monster turn:
export interface MonsterTurnResult {
  monsterName: string;
  hit: boolean;
  natural: number;   // the raw d20 face (1-20)
  total: number;     // natural + attackBonus
  ac: number;        // the PC's AC that was targeted
  damage: number | null;   // null on miss
  pcTargetId: string;
  events: VaultEvent[];    // [hp_change (on hit), turn_advance] — same shape as v1 events[]
}
```

#### Core pattern — pure function, injectable RNG (from combat-resolver.ts lines 148-156 + dice.ts lines 31-53 + rand.ts lines 27-37)

The hit rule is COPIED from `combat-resolver.ts:179` (itself mirroring `attack.ts:345/361/365`):
- `nat1 = auto-miss`
- `nat20 = auto-hit`
- else `total >= ac`

```typescript
// Hit rule — copy VERBATIM from combat-resolver.ts:179:
const hit = natural !== 1 && (natural === 20 || total >= ac);
```

Injectable RNG seam — default parameter pattern from `dice.ts:31` and `combat-resolver.ts:148`:

```typescript
// From dice.ts:17 and :31 — rng is always a default parameter:
export function rollDice(formula: string, rng: Rng = defaultRng): DiceRoll
export function rollD20(opts: D20Options = {}, rng: Rng = defaultRng): DiceRoll
export function rollDamage(formula: string, opts: DamageOptions = {}, rng: Rng = defaultRng): DiceRoll

// From rand.ts:3-6 — the Rng interface:
export interface Rng {
  intInclusive(min: number, max: number): number;
}

// intInclusive is also used for target selection (D-11):
const targetIdx = rng.intInclusive(0, livePcIds.length - 1);
```

#### Named constants pattern (from combat-resolver.ts lines 33-34)

```typescript
// v1 constants (combat-resolver.ts:33-34):
const DEFAULT_MONSTER_AC = 12;
const DEFAULT_DAMAGE_DIE = '1d6';

// v2 mirrored constants (same file, new export):
const DEFAULT_MONSTER_ATTACK_BONUS = 4;
const DEFAULT_MONSTER_DAMAGE_DIE = '1d6';
```

#### Narration directive pattern — Italian, 2nd person (from combat-resolver.ts lines 186-188, 196-199, 215-218)

```typescript
// v1 miss directive (combat-resolver.ts:186-188):
narrationDirective: `[RESOLVED BY SYSTEM: l'attacco contro ${monster.name} ha MANCATO (${total} vs CA ${ac})] narra questo mancato in seconda persona, senza inventare danni; NON chiedere tiri e NON scrivere eventi — il sistema gestisce il turno.`,

// v1 damage directive (combat-resolver.ts:215-217):
narrationDirective: `[RESOLVED BY SYSTEM: ${monster.name} subisce ${total} danni] narra questo colpo e i suoi effetti in seconda persona; NON chiedere tiri e NON scrivere eventi — il sistema ha già applicato danni e turno.`,

// v2 combined multi-turn directive (D-15) — analogous structure, extended with loop results:
// "[RESOLVED BY SYSTEM: turni mostri — Veyra colpisce Luffy per 7 danni (15 vs CA 12);
//  il Goblin manca Luffy (8 vs CA 12)]
//  Narra questi esiti in seconda persona, in ordine; NON chiedere tiri e NON scrivere
//  eventi JSON — il sistema ha già applicato danni e avanzamenti di turno."
```

#### Event emission pattern (from combat-resolver.ts lines 184-186, 212-215)

```typescript
// v1 miss events (combat-resolver.ts:184-186):
events: [{ type: 'turn_advance', payload: {} }],

// v1 damage events (combat-resolver.ts:212-215):
events: [
  { type: 'monster_hp_change', payload: { id: monster.id, delta: -total } },
  { type: 'turn_advance', payload: {} },
],

// v2 on HIT — emit hp_change (PC character UUID) then turn_advance:
events: [
  { type: 'hp_change', payload: { character: pcId, delta: -damage } },  // NOT monster_hp_change
  { type: 'turn_advance', payload: {} },
],
// v2 on MISS — emit turn_advance only:
events: [{ type: 'turn_advance', payload: {} }],
```

**Critical distinction:** v1 used `monster_hp_change` (monster takes damage from PC). v2 uses `hp_change` with `character: pcUUID` (PC takes damage from monster). The payload shape differs: `{character, delta}` vs `{id, delta}`. The `hp_change` event type and shape are verified at `events-schema.ts:261`.

#### Defensive edge pattern — never throws (from combat-resolver.ts lines 148-156 + jsdoc line 147)

```typescript
// v1 contract (combat-resolver.ts:147):
// NEVER throws (D-05/D-10): any unparseable roll, missing/ambiguous target, or
// wrong dice+keyword combination returns `null`.

// v2 parallel: any missing data (no live PCs, loop cap reached, missing monster)
// returns early/stops the loop. The resolver itself returns null on defensive edges.
// Pattern: if (!input.livePcIds.length) return null;
//          if (ac === undefined) { /* use default or skip */ }
```

#### Test pattern — seeded RNG + EncounterState fixtures (from tests/app/api/sessions/[id]/turn/combat-resolver.test.ts lines 1-42, and dice.test.ts lines 7-8)

```typescript
// Import pattern (combat-resolver.test.ts:1-4):
import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';
import { resolveCombat, enforceResolvedNarration } from '@/app/api/sessions/[id]/turn/combat-resolver';

// Seeded RNG in dice.test.ts:7-8:
import { makeSeededRng } from '@/engine/rand';
const rng = makeSeededRng(123);  // deterministic, headless-testable

// EncounterState fixture shape (combat-resolver.test.ts:29-42):
const ACTIVE_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 0,
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 20 },
    { actorId: 'veyra-1', initiative: 12 },
  ],
  monsters: [
    { id: 'veyra-1', name: 'Veyra', hpCurrent: 30, hpMax: 30, ac: 14, isAlive: true, conditions: [] },
  ],
};

// v2 fixture: add monster-turn scenario where monster is the active actor:
const MONSTER_ACTIVE_ENCOUNTER: EncounterState = {
  active: true,
  round: 1,
  currentIdx: 1,  // currentIdx points at monster slot
  turnOrder: [
    { actorId: 'pc-uuid-1', initiative: 15 },
    { actorId: 'veyra-1', initiative: 20 },  // monster goes first
  ],
  monsters: [
    { id: 'veyra-1', name: 'Veyra', hpCurrent: 30, hpMax: 30, ac: 12, isAlive: true, conditions: [] },
  ],
};
// PC AC map built separately (D-12 bridge):
const pcAcById = new Map([['pc-uuid-1', 14]]);
```

---

### `src/ai/master/vault/events-schema.ts` (MODIFY — config, CRUD)

**Analog:** The existing optional field pattern in `monster_spawn` — `ac?` and `initiativeBonus?` (lines 312-319 of the VaultEvent union, lines 1031-1050 of validateEvent).

#### VaultEvent union — additive optional field pattern (lines 310-319)

```typescript
// EXISTING monster_spawn entry (events-schema.ts:311-319):
| {
    type: 'monster_spawn';
    payload: {
      id: string;
      name: string;
      hpMax: number;
      ac?: number;
      initiativeBonus?: number;
    };
  }

// MODIFIED — add cr? at the end (additive, backward-compatible):
| {
    type: 'monster_spawn';
    payload: {
      id: string;
      name: string;
      hpMax: number;
      ac?: number;
      initiativeBonus?: number;
      cr?: number;            // NEW — D-08: optional difficulty hint (positive finite number)
    };
  }
```

#### Validator — optional field branch pattern (lines 1031-1050)

Copy the `ac` optional branch exactly. The `cr?` branch validates as `positive finite number` (not integer-constrained, since 0.25 / 0.5 are valid CRs from the LLM):

```typescript
// EXISTING ac? branch (events-schema.ts:1031-1040):
if (p.ac !== undefined) {
  if (
    typeof p.ac !== 'number' ||
    !Number.isInteger(p.ac) ||
    p.ac <= 0
  ) {
    return { ok: false, error: 'monster_spawn.ac must be a positive integer when provided' };
  }
  spawnPayload.ac = p.ac;
}

// NEW cr? branch — mirror structure, relax integer constraint (fractions OK):
if (p.cr !== undefined) {
  if (
    typeof p.cr !== 'number' ||
    !Number.isFinite(p.cr) ||
    p.cr < 0
  ) {
    return { ok: false, error: 'monster_spawn.cr must be a non-negative finite number when provided' };
  }
  spawnPayload.cr = p.cr;
}

// The spawnPayload type declaration also needs cr? added (same line 1026):
const spawnPayload: { id: string; name: string; hpMax: number; ac?: number; initiativeBonus?: number; cr?: number } = { ... };
```

---

### `src/ai/master/vault/projector.ts` (MODIFY — service, CRUD)

**Analog:** How `ac` and `initiativeBonus` are copied from the spawn payload into `EncounterState.monsters[]` — two distinct operations: (1) the interface type addition, (2) the reducer copy.

#### EncounterState interface — optional field addition (lines 661-676)

```typescript
// EXISTING interface (projector.ts:661-676):
export interface EncounterState {
  active: boolean;
  round: number;
  currentIdx: number;
  turnOrder: Array<{ actorId: string; initiative: number }>;
  monsters: Array<{
    id: string;
    name: string;
    hpCurrent: number;
    hpMax: number;
    ac?: number;
    initiativeBonus?: number;
    isAlive: boolean;
    conditions: string[];
  }>;
}

// MODIFIED — add cr? to monsters[] member (additive, no existing tests break):
    cr?: number;            // NEW — propagated from monster_spawn.cr (D-08)
```

#### Reducer copy pattern (projector.ts lines 747-759)

The exact pattern for how optional fields are conditionally copied into the new monster entry:

```typescript
// EXISTING reducer pattern (projector.ts:747-759):
const { id, name, hpMax, ac, initiativeBonus } = event.payload;
// Idempotent: skip duplicate spawns (deterministic replay invariant).
if (base.monsters.some((m) => m.id === id)) return base;
const monster: EncounterState['monsters'][number] = {
  id,
  name,
  hpCurrent: hpMax,
  hpMax,
  isAlive: true,
  conditions: [],
};
if (ac !== undefined) monster.ac = ac;
if (initiativeBonus !== undefined) monster.initiativeBonus = initiativeBonus;
base.monsters.push(monster);

// MODIFIED — destructure cr from payload and copy using the same conditional guard:
const { id, name, hpMax, ac, initiativeBonus, cr } = event.payload;
// ... (existing lines unchanged) ...
if (ac !== undefined) monster.ac = ac;
if (initiativeBonus !== undefined) monster.initiativeBonus = initiativeBonus;
if (cr !== undefined) monster.cr = cr;   // NEW — same pattern
base.monsters.push(monster);
```

---

### `src/ai/master/vault/prompt-builder.ts` (MODIFY — config, transform)

**Analog:** The existing `combatLifecycleBlock()` function itself (lines 179-218). The function currently takes no arguments (determinism invariant for REQ-022). The D-16 suppression approach recommended by RESEARCH is directive-layer only (leave the system prompt unchanged — same `combatLifecycleBlock()` body, no gating parameter added).

The only actual edit is the `monster_spawn` step line (Area B — Monster stats, line 206) to mention `cr?`:

#### Area B — monster_spawn payload description (lines 200-207)

```typescript
// EXISTING line 206 (prompt-builder.ts:206):
lines.push('For a campaign-specific boss not in the bestiary: invent appropriate stats and put them');
lines.push('inline in the `monster_spawn` payload — no handbook file needed for custom monsters.');

// MODIFIED — add cr hint instruction after the existing custom-boss line:
lines.push('For a campaign-specific boss not in the bestiary: invent appropriate stats and put them');
lines.push('inline in the `monster_spawn` payload — no handbook file needed for custom monsters.');
lines.push('Include `cr` (Challenge Rating, a number like 1, 3, 5) in the payload as a difficulty');
lines.push('hint — the server uses it to set the monster\'s attack strength deterministically.');
```

#### Area C — Turn rule lines (lines 209-218) — NO CHANGE to this function

Per RESEARCH Pattern 7 (directive-layer suppression is preferred): `combatLifecycleBlock()` stays unchanged. The `monsterResolved` flag in `turn-directive.ts` (D-16) handles suppression at the directive layer without touching the static system prompt.

---

### `src/ai/master/vault/tools.ts` (MODIFY — config, transform)

**Analog:** The existing `monster_spawn` inline description in the payload description string at line 101.

#### apply_event payload description (lines 101-102)

```typescript
// EXISTING description string (tools.ts:101) — the monster_spawn clause:
'... monster_spawn {id:string, name:string, hpMax:number, ac?:number, initiativeBonus?:number}; ...'

// MODIFIED — add cr?:number to the monster_spawn clause:
'... monster_spawn {id:string, name:string, hpMax:number, ac?:number, initiativeBonus?:number, cr?:number}; ...'
// Note: the full string at line 101 is one long inline string; only the monster_spawn
// clause is changed. All other clauses are left byte-identical.
```

---

### `src/ai/master/vault/turn-directive.ts` (MODIFY — middleware, request-response)

**Analog:** The `serverResolved` flag — its interface declaration (line 54), and its two `if (!serverResolved && ...)` guards (lines 118 and 145), and the third guard at line 179.

#### TurnDirectiveOpts — new flag (lines 21-55)

```typescript
// EXISTING interface (turn-directive.ts:21-55):
export interface TurnDirectiveOpts {
  vaultMutations?: boolean;
  manualRolls?: boolean;
  language?: string;
  playerMessage?: string;
  serverResolved?: boolean;  // Phase 08 D-07
}

// MODIFIED — add monsterResolved (D-16):
export interface TurnDirectiveOpts {
  vaultMutations?: boolean;
  manualRolls?: boolean;
  language?: string;
  playerMessage?: string;
  serverResolved?: boolean;   // Phase 08 D-07 — player attack resolved server-side
  monsterResolved?: boolean;  // Phase 09 D-16 — monster turn resolved server-side
}
```

#### buildTurnDirective — suppression guards (lines 100-199)

The `serverResolved` guards suppress two re-ask directives. `monsterResolved` needs to suppress the combat-first directive (line 145) to prevent the model being told to emit `turn_advance` / `monster_hp_change` that the loop already emitted:

```typescript
// EXISTING guard 1 — roll-result resolve directive (turn-directive.ts:118):
if (!serverResolved && isRollResult(playerMessage)) { ... }

// EXISTING guard 2 — combat-intent strong directive (turn-directive.ts:145):
if (!serverResolved && vaultMutations && detectCombatIntent(playerMessage)) { ... }

// EXISTING guard 3 — vaultMutations catalog lines (turn-directive.ts:179):
if (vaultMutations && !serverResolved) {
  lines.push('Quando lo stato di gioco cambia ...');
  ...
}

// v2 modifications — add monsterResolved to suppress relevant re-asks:
// Guard 2 extends to also suppress on monsterResolved (monster turn was resolved,
// no point asking the model to emit combat events):
if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(playerMessage)) { ... }

// Guard 3 extends similarly:
if (vaultMutations && !serverResolved && !monsterResolved) { ... }

// Additionally, on monsterResolved, append an explicit negation into the directive:
// "Il server ha già eseguito i turni dei mostri — NON chiamare hp_change o
//  turn_advance per i mostri. Narra solo gli esiti in seconda persona."
// (This is the D-16 belt-and-suspenders supplement to suppressCombatMutations.)
```

---

### `src/app/api/sessions/[id]/turn/route.ts` (MODIFY — controller, request-response)

**Analog:** The v1 `_resolver` block (lines 370-422) and the `buildTurnDirective(serverResolved:...)` call (lines 442-471).

#### Gate + hook pattern (lines 370-422 — v1 block to mirror)

The monster-turn loop hooks IMMEDIATELY AFTER the v1 resolver emission block (after line 422), before `buildTurnDirective` (line 442). Structure mirrors the `_resolver` block exactly:

```typescript
// v1 pattern (route.ts:377-407):
let _resolver: ReturnType<typeof resolveCombat> = null;
if (vaultMutationsEnabled && isRollResult(_playerMessage)) {
  try {
    const { encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
    if (encounter.active) {
      _resolver = resolveCombat({ rollResult: _playerMessage!, encounter });
      if (_resolver === null) {
        console.warn('[turn]', sessionId, 'combat-resolver fell through ...');
      }
    }
  } catch (err) {
    console.warn('[turn]', sessionId, 'combat-resolver gate read failed, falling through:', ...);
  }
}

// v2 parallel (insert after line 422, before buildTurnDirective at line 442):
let _monsterLoopResults: MonsterTurnResult[] = [];
let _monsterLoopRan = false;
if (vaultMutationsEnabled) {
  try {
    const { encounter: postV1Encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));
    if (postV1Encounter.active && postV1Encounter.turnOrder.length > 0) {
      const activeActor = postV1Encounter.turnOrder[postV1Encounter.currentIdx];
      const activeMonster = activeActor
        ? postV1Encounter.monsters.find(m => m.id === activeActor.actorId && m.isAlive)
        : undefined;
      if (activeMonster) {
        // Run the loop — see Loop Driver pattern
        _monsterLoopRan = true;
      }
    }
  } catch (err) {
    console.warn('[turn]', sessionId, 'monster-turn gate read failed:', err);
  }
}
```

#### Emit pattern — loop events (lines 415-422 — v1 emit block to mirror)

```typescript
// v1 emit (route.ts:415-422):
if (_resolver !== null) {
  for (const ev of _resolver.events) {
    const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
    if (r.isError) {
      console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
    }
  }
}

// v2 analog — inside the loop, per monster turn (not bulk-emitted after):
for (const ev of result.events) {
  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
  if (r.isError) console.warn('[turn] monster-turn emit failed:', r.content);
}
```

#### buildTurnDirective call — add monsterResolved flag (lines 442-448)

```typescript
// EXISTING call (route.ts:442-448):
const _directive = buildTurnDirective({
  vaultMutations: vaultMutationsEnabled,
  manualRolls: userPrefs.manualRolls,
  language: campaign.language ?? snap.language ?? undefined,
  ...(_playerMessage !== undefined && { playerMessage: _playerMessage }),
  serverResolved: _resolver !== null,
});

// MODIFIED — add monsterResolved:
const _directive = buildTurnDirective({
  vaultMutations: vaultMutationsEnabled,
  manualRolls: userPrefs.manualRolls,
  language: campaign.language ?? snap.language ?? undefined,
  ...(_playerMessage !== undefined && { playerMessage: _playerMessage }),
  serverResolved: _resolver !== null,
  monsterResolved: _monsterLoopRan,  // NEW
});
```

#### narrationDirective injection pattern (lines 467-472 — v1 pattern to mirror)

```typescript
// v1 injection (route.ts:467-472):
if (_resolver !== null) {
  vaultHistory = appendDirectiveToHistory(
    vaultHistory as { role: string; content: string }[],
    _resolver.narrationDirective,
  ) as typeof vaultHistory;
}

// v2 analog — inject combined monster-turn narration directive:
if (_monsterLoopRan && _monsterLoopResults.length > 0) {
  const combined = buildMonsterLoopNarrationDirective(_monsterLoopResults);
  vaultHistory = appendDirectiveToHistory(
    vaultHistory as { role: string; content: string }[],
    combined,
  ) as typeof vaultHistory;
}
```

#### suppressCombatMutations flag (lines 505-505)

```typescript
// EXISTING (route.ts:505):
...(_resolver !== null && { suppressCombatMutations: true }),

// MODIFIED — extend to also suppress on monster loop:
...( (_resolver !== null || _monsterLoopRan) && { suppressCombatMutations: true }),
```

#### Party select — add ac (lines 560-568)

```typescript
// EXISTING party select (route.ts:560-568):
const party = await tx
  .select({ id: charactersTable.id, name: charactersTable.name, createdAt: charactersTable.createdAt })
  .from(charactersTable)
  .where(and(
    eq(charactersTable.campaignId, s.campaignId),
    isNull(charactersTable.deletedAt),
    isNotNull(charactersTable.templateId),
  ))
  .orderBy(charactersTable.createdAt);

// MODIFIED — add ac (D-12 bridge; notNull in schema so no default needed):
const party = await tx
  .select({ id: charactersTable.id, name: charactersTable.name, ac: charactersTable.ac, createdAt: charactersTable.createdAt })
  // ... (same where/orderBy unchanged)
```

**Note:** The monster-turn loop needs `pcAcById` BEFORE the DB transaction. Per RESEARCH Open Q1: if `snap.party` (from `buildSnapshot`, called earlier in the route) already includes `ac`, use it directly. If not, add a targeted early select of `{ id, ac }` before the loop gate. Read `buildSnapshot` return type before implementing to decide.

---

## Shared Patterns

### enforceResolvedNarration — reuse unchanged

**Source:** `src/app/api/sessions/[id]/turn/combat-resolver.ts` lines 252-277
**Apply to:** `monster-turns.ts` narration enforcement (D-15)

```typescript
// Signature (combat-resolver.ts:252-254):
export function enforceResolvedNarration(
  finalText: string,
  resolver: ResolveCombatResult,
): string

// v2 usage: pass a minimal object with damageRequest: null (monsters never ask PC to roll):
enforceResolvedNarration(vaultResult.finalText, { damageRequest: null, ...rest });
// The strip logic (ROLL_REQUEST / EVENT_LABEL / EVENT_JSON regexes) applies identically.
// See RESEARCH Open Q3 for whether to reuse ResolveCombatResult or create MonsterLoopSummary.
```

### appendDirectiveToHistory — reuse unchanged

**Source:** `src/ai/master/vault/turn-directive.ts` lines 214-233
**Apply to:** Route's monster narration directive injection

```typescript
// Signature (turn-directive.ts:214-218):
export function appendDirectiveToHistory<T extends { role: string; content: string }>(
  history: T[],
  directive: string,
): T[]
// Immutability: returns new array, never mutates input.
```

### dispatchVaultTool — event emission

**Source:** `src/app/api/sessions/[id]/turn/route.ts` lines 415-422
**Apply to:** Monster loop event emission (per-turn, inside the loop)

```typescript
// Pattern (route.ts:416-421):
const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
if (r.isError) {
  console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
}
// campaignId is ALWAYS the server-authoritative campaign.id — never player-derived (T-08-06).
```

### parseEventsFile + replayEvents — encounter state read

**Source:** `src/app/api/sessions/[id]/turn/route.ts` lines 380-381 and 580-581
**Apply to:** Monster loop iteration (re-read after each turn_advance emission)

```typescript
// Pattern (route.ts:380-381):
const { encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));

// Loop iteration: same call per iteration (RESEARCH Pitfall 6: acceptable for v2).
// Always gated by MONSTER_LOOP_SAFETY_CAP before each call.
```

### Italian narration directive wording

**Source:** `src/app/api/sessions/[id]/turn/combat-resolver.ts` lines 186-217
**Apply to:** `monster-turns.ts` combined directive builder (D-15)

All directives use:
- `[RESOLVED BY SYSTEM: ...]` header
- Italian text, 2nd person ("tu")
- `NON chiedere tiri e NON scrivere eventi — il sistema ha già applicato ...`

---

## No Analog Found

All 7 files have close analogs. The following internal sub-patterns are novel (no existing analog, use RESEARCH patterns):

| Sub-pattern | Location | Reason |
|-------------|----------|--------|
| CR→attack-stats lookup table | `monster-turns.ts` | No existing CR table in the codebase; RESEARCH Pattern 4 provides the concrete values |
| Bestiary prose regex (`+N to hit` / `XdY±Z`) | `monster-turns.ts` | No existing prose regex for attack parsing; RESEARCH Pattern 3 provides the verified regex |
| Monster-turn loop driver (while + safety cap) | `monster-turns.ts` or route.ts | No existing server-side loop; RESEARCH Pattern 6 provides the structure |
| PC HP live-filter (for D-14 downed PC) | `monster-turns.ts` loop | PC HP not in EncounterState; must come from `snap.party[].hpCurrent` — see RESEARCH Pitfall 1 |

---

## Metadata

**Analog search scope:** `src/app/api/sessions/[id]/turn/`, `src/ai/master/vault/`, `src/engine/`, `tests/app/api/sessions/[id]/turn/`, `tests/engine/`
**Files read:** 13 source files + 2 test files
**Pattern extraction date:** 2026-05-30

**Key confirmed line numbers (verify before implementing):**
- `events-schema.ts` `monster_spawn` VaultEvent union: lines 311-319
- `events-schema.ts` `validateEvent` monster_spawn branch: lines 1012-1052
- `projector.ts` `EncounterState` interface: lines 661-676
- `projector.ts` `applyEncounterEvent` monster_spawn case: lines 730-761
- `turn-directive.ts` `TurnDirectiveOpts` interface: lines 21-55
- `turn-directive.ts` `serverResolved` guards: lines 118, 145, 179
- `route.ts` v1 `_resolver` gate: lines 377-407
- `route.ts` v1 `_resolver` emit: lines 415-422
- `route.ts` `buildTurnDirective` call: lines 442-448
- `route.ts` narration directive injection: lines 467-472
- `route.ts` `suppressCombatMutations` flag: line 505
- `route.ts` party select (DB transaction): lines 560-568
- `route.ts` `resolveCombatHandoff` call: lines 580-596
- `combat-resolver.ts` hit rule: line 179
- `combat-resolver.ts` `enforceResolvedNarration`: lines 252-277
- `prompt-builder.ts` `combatLifecycleBlock()` Area C (Turn rule): lines 209-218
- `tools.ts` `monster_spawn` payload description: line 101
