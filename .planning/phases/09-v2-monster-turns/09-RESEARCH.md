# Phase 09: v2 Monster Turns - Research

**Researched:** 2026-05-30
**Domain:** Server-side monster-turn combat resolver (extends Phase 08 v1 player-attack resolver)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Trigger & turn loop**

- D-01: After any player message + resulting turn_advance, read the post-turn EncounterState. If `turnOrder[currentIdx].actorId` matches a live `monsters[].id` → enter the monster-turn loop. Gate: `vaultMutations && encounter.active`. Trigger is GENERAL (not only after player attack — covers monster-first initiative, PC non-attack turns).
- D-02: Resolve consecutive monster turns in the SAME HTTP request: per monster turn → roll attack vs target PC AC → on hit emit `hp_change(PC, -damage)` → emit `turn_advance` → repeat. After the loop, the existing 07-03 `resolveCombatHandoff` hands to the next PC. Single round-trip; one narration pass (D-15).
- D-03: Stop loop when (a) active actor is a live PC; (b) no live targetable PC remains (all at 0 HP — see D-14); (c) safety iteration cap reached. Auto `combat_end` NOT emitted (v3 / existing flow, like v1).

**Monster attack data — 3-level fallback**

- D-04: Bestiary match → parse real stats from `## Actions` prose using regex. `parseNamedBlocks` (srd/parsers/monsters.ts:65) yields `{name, description}` pairs; v2 adds regex to extract `+N to hit` and `XdY±Z` from description.
- D-05: Custom monster (not in bestiary) → LLM provides coarse difficulty hint (`cr?`) in `monster_spawn` payload; SERVER maps it deterministically to `(attackBonus, damageDice)` via a tunable table (loosely DMG "Monster Statistics by Challenge Rating").
- D-06: No hint AND no bestiary match → base default `+4 to hit / 1d6 damage`. Use named constants `DEFAULT_MONSTER_ATTACK_BONUS` / `DEFAULT_MONSTER_DAMAGE_DIE` (mirrors v1's `DEFAULT_MONSTER_AC = 12`).
- D-07: Sequencing note — real smoke (One Piece) uses CUSTOM monsters → D-05 cr→table path is smoke-critical; D-04 bestiary path must NOT block it (split D-04 into own task if needed).

**Additive schema change**

- D-08: `monster_spawn` payload gains optional `cr?` (numeric) field. Additive + backward-compatible (old events replay byte-stable). Touch points: `events-schema.ts` (`monster_spawn` payload type + validator), `tools.ts:101` (`apply_event` description), `prompt-builder.ts` (§Monster stats / monster_spawn step).

**Monster attack resolution rules + determinism**

- D-09: Hit rule (5e-faithful, mirrors v1): `nat1 = auto-miss`, `nat20 = auto-hit`, else `hit = total >= AC`. Roll `d20 + attackBonus` server-side. On hit → roll damage dice (NO crit-doubling, deferred v3) → `hp_change(PC, -total)`.
- D-10: ALL randomness (d20, damage, target selection) draws from a SINGLE injectable RNG seam (default `src/engine/rand.ts` `defaultRng`, crypto-backed) → headless-testable with deterministic `makeSeededRng`. Reuse `src/engine/dice.ts` `rollD20`/`rollDamage`.

**PC target selection**

- D-11: Monster attacks a PC chosen at RANDOM among live combat participants (in `turnOrder`, HP > 0), drawn from the SAME injected RNG seam. Collapses to single PC in 1v1.
- D-12: PC-AC bridge (minimal) — extend the route's party select to pull `characters.ac` (Postgres, `notNull` → no PC-AC default needed; `src/db/schema/characters.ts:38`). `abilities`/`proficiencyBonus` NOT needed.

**Damage application + PC downed**

- D-13: Monster→PC damage uses existing `hp_change { character: <PC UUID>, delta: -damage }`. Reducer clamps at 0. No new event type.
- D-14: PC at 0 HP → that PC leaves targetable pool (HP > 0 gate, D-11). If it was the LAST live PC → loop STOPS (D-03b); narration signals party KO. Real death-save mechanics deferred to v3.

**Narration (reuse v1 pattern)**

- D-15: SINGLE combined narration pass after loop resolves all consecutive monster turns. Server builds ONE directive listing every monster action's outcome → `runVaultToolLoop` in narration-only mode (1 LLM call — M4 latency constraint) → `enforceResolvedNarration` strips competing roll-requests / leaked event-JSON. Reuses v1 D-06/D-07 pattern (`combat-resolver.ts:252`).
- D-16: Suppress / gate the "Area C — Turn rule" lines (`prompt-builder.ts:209-217`) on a server-resolved monster turn — analogous to v1's D-07 player-side suppression in `turn-directive.ts`.

### Claude's Discretion

- Difficulty-hint field: `cr` (lean) vs coarse `tier` enum (D-08).
- The exact difficulty→(attackBonus, damageDice) mapping table (D-05).
- Bestiary-prose regex for `+N to hit` / `XdY±Z` (D-04).
- Exact base-default numbers beyond +4/1d6 and the damage formula (die only vs die+flat) (D-06).
- Safety iteration cap value (D-03c).
- Whether the monster-turn resolver lives in `combat-resolver.ts` or a new sibling (e.g. `combat-monster-turns.ts`).
- Exactly where in the vault branch of `route.ts` the loop hooks.
- How D-16 suppression is implemented (prompt gating vs directive override).
- Narration directive wording (semantics LOCKED: per-monster hit/miss/damage, 2nd person, Italian).

### Deferred Ideas (OUT OF SCOPE)

- Crit-damage doubling (nat20 → double dice; `rollDamage(...,{crit:true})` already exists in dice.ts).
- Resistances / immunities / vulnerabilities / cover / advantage-disadvantage.
- Multiattack (multiple attacks per turn).
- Real death-save mechanics (`death_save_*` events) + true party-KO / game-over.
- Auto `combat_end` when one side is fully down.
- Conditions applied by monster actions.
- Structured attack fields in bestiary frontmatter instead of D-04 prose parsing.
- Recompute monster attack bonus from STR/DEX + proficiency.
- PC target = always `cpcId`.
</user_constraints>

---

## Summary

Phase 09 extends the Phase 08 server-side combat resolver from player-attack resolution to monster-turn resolution. The architectural pattern is already established by v1: the server is the sole authority on mechanics, the LLM narrates only. v2 adds the inverse direction — when the active encounter actor is a monster, the server rolls its attack, selects a random live PC target, pulls the PC's AC from Postgres, applies damage via the existing `hp_change` event, advances the turn, and loops until a PC's turn or a stop condition fires. The entire loop resolves within a single HTTP request and is narrated in one combined LLM pass.

The three distinct concerns are: (1) reading monster attack stats (3-level fallback: bestiary prose parse → CR table → named-constant default), (2) threading the loop into the existing route.ts vault branch at the correct hook point (after v1 player resolution but before the post-loop encounter read that feeds `resolveCombatHandoff`), and (3) an additive schema change adding an optional `cr?` field to `monster_spawn` so the LLM can communicate difficulty intent for custom monsters.

All randomness is injectable (existing `makeSeededRng` / `defaultRng` pattern from `engine/rand.ts`), making the resolver fully headless-testable. The PC-AC bridge is a minimal one-liner extending the existing party select. The narration-only mode and `enforceResolvedNarration` already exist in `combat-resolver.ts:252`; v2 reuses them with a combined multi-turn directive.

**Primary recommendation:** Keep the monster-turn resolver in `combat-resolver.ts` as a sibling export (or a new file `combat-monster-turns.ts`) rather than an inline lambda in route.ts — pure function, injectable RNG, mirrors v1's `resolveCombat` shape. Wire the loop at route.ts:~407 (immediately after the v1 `_resolver` block) before `buildTurnDirective`, gated on `vaultMutations && encounter.active && activeActorIsMonster`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Monster attack roll (d20) | API/Backend | — | Server-side RNG; client never sees raw die values |
| Monster damage roll | API/Backend | — | Same — injected RNG; must be deterministic in tests |
| Random live-PC target selection | API/Backend | — | Part of resolver; injected RNG seam (D-10/D-11) |
| PC AC lookup | Database (Postgres) | API/Backend | `characters.ac notNull`; route party select extended (D-12) |
| Monster attack stats (bestiary) | API/Backend | Filesystem | Parse `data/vault/handbook/monsters/<slug>.md` at resolution time |
| Monster attack stats (CR table) | API/Backend | — | In-memory lookup; no I/O |
| hp_change event emission (PC) | API/Backend | Vault FS | `dispatchVaultTool('apply_event', ...)` → events.md |
| turn_advance event emission | API/Backend | Vault FS | Same dispatcher, same pattern as v1 |
| Loop driver (consecutive turns) | API/Backend | — | Synchronous within single HTTP request (D-02) |
| Narration (combined pass) | API/Backend → LLM | — | Server builds directive, LLM narrates, `enforceResolvedNarration` enforces |
| Prompt suppression (Area C) | API/Backend | — | `buildTurnDirective` gating (D-16), mirrors D-07 |
| Schema change (`cr?` field) | API/Backend | LLM surface | `events-schema.ts` + `tools.ts` + `prompt-builder.ts` (D-08) |

---

## Standard Stack

No new packages are needed. This phase uses only existing in-repo modules.

### Core (all existing)

| Module | Location | Purpose | Confirmed |
|--------|----------|---------|-----------|
| `engine/rand.ts` | `src/engine/rand.ts` | Injectable RNG (`defaultRng`, `makeSeededRng`) | [VERIFIED: live code read] |
| `engine/dice.ts` | `src/engine/dice.ts` | `rollD20({modifier}, rng)`, `rollDamage(formula, opts, rng)` | [VERIFIED: live code read] |
| `combat-resolver.ts` | `src/app/api/sessions/[id]/turn/combat-resolver.ts` | `enforceResolvedNarration`, `ResolveCombatResult` (reuse / extend) | [VERIFIED: live code read] |
| `projector.ts` | `src/ai/master/vault/projector.ts` | `EncounterState` shape, `applyEncounterEvent` | [VERIFIED: live code read] |
| `events-schema.ts` | `src/ai/master/vault/events-schema.ts` | `VaultEvent`, `validateEvent`, `ENCOUNTER_EVENT_TYPES` | [VERIFIED: live code read] |
| `turn-directive.ts` | `src/ai/master/vault/turn-directive.ts` | `buildTurnDirective`, `serverResolved` flag pattern | [VERIFIED: live code read] |
| `srd/parsers/monsters.ts` | `src/srd/parsers/monsters.ts` | `parseNamedBlocks` — splits Actions prose (D-04 reference) | [VERIFIED: live code read] |
| `combat-handoff.ts` | `src/app/api/sessions/[id]/turn/combat-handoff.ts` | `resolveCombatHandoff` — runs AFTER the loop | [VERIFIED: live code read] |

### Package Legitimacy Audit

No new packages are installed. This section is intentionally omitted — Phase 09 is a pure code extension of existing in-repo modules.

---

## Architecture Patterns

### System Architecture Diagram

```
Player turn message
        |
   [route.ts vault branch]
        |
   v1 resolver block (_resolver != null?)
        |
        +-- v1 resolved (player attack) OR not a roll-result
        |           |
        |    [POST-v1 encounter read]  ← NEW (post-loop encounter state)
        |           |
        |    activeActorIsMonster? --NO--> [resolveCombatHandoff] → PC turn handoff
        |           |
        |          YES
        |           |
        |    [Monster Turn Loop]  ← NEW
        |     |
        |     +-- read monster stats (3-level fallback)
        |     |    1. bestiary slug match → parse Actions prose
        |     |    2. cr from EncounterState.monsters[].cr? → table lookup
        |     |    3. DEFAULT_MONSTER_ATTACK_BONUS / DEFAULT_MONSTER_DAMAGE_DIE
        |     |
        |     +-- pick random LIVE PC target (injected RNG)
        |     |    (turnOrder members with HP > 0)
        |     |
        |     +-- rollD20({modifier: attackBonus}, rng)
        |     |    hit rule: nat1=miss, nat20=hit, total>=AC=hit
        |     |
        |     +-- on HIT: rollDamage(damageDice, {}, rng)
        |     |    emit hp_change { character: pcId, delta: -damage }
        |     |
        |     +-- emit turn_advance {}
        |     |
        |     +-- re-read EncounterState (or compute from accumulated events)
        |     |
        |     +-- stop conditions: (a) active actor is PC, (b) no live PC,
        |     |    (c) safety cap reached
        |     |
        |     +-- LOOP or STOP
        |           |
        |    [Build combined narration directive]
        |     "[RESOLVED BY SYSTEM: Veyra colpisce per 5 danni; Goblin manca]
        |      narra in seconda persona…"
        |           |
        |    [runVaultToolLoop narration-only + suppressCombatMutations:true]
        |           |
        |    [enforceResolvedNarration] → strip model roll-asks / leaked JSON
        |           |
        |    [resolveCombatHandoff] → PC turn handoff (existing)
        |
   persist narration → notifySession
```

### Recommended File Structure (Phase 09 changes only)

```
src/
├── app/api/sessions/[id]/turn/
│   ├── combat-resolver.ts          # extend: add resolveMonsterTurn() + MonsterTurnResult
│   │   OR
│   ├── combat-monster-turns.ts     # new sibling: monster-turn resolver + loop driver
│   └── route.ts                    # modify: hook loop, party select +ac, D-16 gate
├── ai/master/vault/
│   ├── events-schema.ts            # modify: monster_spawn payload + validator (cr?)
│   ├── tools.ts                    # modify: apply_event description (cr? field)
│   ├── prompt-builder.ts           # modify: monster_spawn mention + Area C gating
│   └── turn-directive.ts           # modify: D-16 suppression (monsterResolved flag)
```

### Pattern 1: Monster-Turn Resolver (pure function, injectable RNG)

The v1 `resolveCombat` is the template. The monster-turn resolver mirrors its contract: pure function, no I/O, injectable RNG, never throws, returns null on defensive edges.

```typescript
// Source: combat-resolver.ts + engine/rand.ts (live code)

export interface MonsterTurnResult {
  monsterName: string;
  hit: boolean;
  natural: number;
  total: number;
  ac: number;
  damage: number | null;  // null on miss
  pcTargetId: string;
  /** Events to emit server-side: [hp_change (on hit), turn_advance] */
  events: VaultEvent[];
}

export function resolveMonsterTurn(input: {
  monster: EncounterState['monsters'][number];
  attackBonus: number;
  damageDice: string;
  livePcIds: string[];  // pre-filtered: in turnOrder AND hp > 0
  pcAcById: Map<string, number>;
  rng?: Rng;
}): MonsterTurnResult {
  const rng = input.rng ?? defaultRng;
  // Target selection — random live PC (D-11)
  const targetIdx = rng.intInclusive(0, input.livePcIds.length - 1);
  const pcId = input.livePcIds[targetIdx]!;
  const ac = input.pcAcById.get(pcId)!;
  // Attack roll (D-09)
  const d20 = rollD20({ modifier: input.attackBonus }, rng);
  const natural = d20.rolls[0]!;
  const total = d20.total;
  const hit = natural !== 1 && (natural === 20 || total >= ac);
  const events: VaultEvent[] = [];
  let damage: number | null = null;
  if (hit) {
    const dmg = rollDamage(input.damageDice, {}, rng);
    damage = dmg.total;
    events.push({ type: 'hp_change', payload: { character: pcId, delta: -damage } });
  }
  events.push({ type: 'turn_advance', payload: {} });
  return { monsterName: input.monster.name, hit, natural, total, ac, damage, pcTargetId: pcId, events };
}
```

[VERIFIED: engine/dice.ts `rollD20` accepts `(opts, rng)`, `rollDamage` accepts `(formula, opts, rng)` — live code confirmed]
[VERIFIED: engine/rand.ts `Rng.intInclusive(min, max)` inclusive — live code confirmed]

### Pattern 2: 3-Level Monster Stats Fallback

```typescript
// Source: derived from D-04/D-05/D-06 CONTEXT.md + bestiary live file inspection

const DEFAULT_MONSTER_ATTACK_BONUS = 4;
const DEFAULT_MONSTER_DAMAGE_DIE = '1d6';

function getMonsterAttackStats(
  monster: EncounterState['monsters'][number] & { cr?: number },
  bestiaryActions?: string,  // raw ## Actions prose if bestiary match found
): { attackBonus: number; damageDice: string } {
  // Level 1: bestiary prose parse (D-04)
  if (bestiaryActions) {
    const parsed = parseFirstAttackFromProse(bestiaryActions);
    if (parsed) return parsed;
  }
  // Level 2: cr-hint → table (D-05)
  if (monster.cr != null) {
    return CR_TO_ATTACK_STATS_TABLE[monster.cr] ?? CR_TO_ATTACK_STATS_TABLE[0]!;
  }
  // Level 3: named-constant defaults (D-06)
  return { attackBonus: DEFAULT_MONSTER_ATTACK_BONUS, damageDice: DEFAULT_MONSTER_DAMAGE_DIE };
}
```

### Pattern 3: Bestiary Prose Regex (D-04)

Verified against live bestiary files: goblin.md, orc.md, troll.md, zombie.md, bandit-captain.md, adult-red-dragon.md. All use the `parseNamedBlocks` colon format: `Name: +N to hit, reach/range, XdY+Z type.`

The Multiattack line is always listed FIRST in multi-attack monsters (troll.md, bandit-captain.md, adult-red-dragon.md). The first ATTACK action (with `to hit`) is the subsequent line.

```typescript
// Source: live bestiary file inspection (goblin.md, orc.md, troll.md, zombie.md, bandit-captain.md)
// All observed Actions prose variants:
//   "Scimitar: +4 to hit, 5ft, 1d6+2 slashing."             → goblin
//   "Greataxe: +5 to hit, 5ft, 1d12+3 slashing."            → orc  
//   "Bite: +7 to hit, 5ft, 1d6+4 piercing."                 → troll
//   "Slam: +3 to hit, 5ft, 1d6+1 bludgeoning."              → zombie
//   "Scimitar: +5 to hit, 5ft, 1d6+3 slashing."             → bandit-captain
//   "Bite: +14 to hit, 10ft, 2d10+8 piercing + 4d6 fire."   → adult-red-dragon (compound)
//   "Multiattack: 1 bite + 2 claws."                         → troll (NOT an attack — skip)
//   "Fire Breath (recharge 5-6, ...)."                       → adult-red-dragon (not `+N to hit` — skip)

// Pattern: `+N to hit` is the reliable signal. Damage is ALWAYS after the hit, before the damage type.
// First attack with +N to hit (skipping Multiattack / no-hit lines):
const ATTACK_HIT_RE = /\+(\d+)\s*to\s*hit/i;
const DAMAGE_DICE_RE = /(\d+d\d+(?:[+-]\d+)?)/;  // captures first XdY or XdY+Z

function parseFirstAttackFromProse(actionsText: string): { attackBonus: number; damageDice: string } | null {
  const blocks = parseNamedBlocks(actionsText);  // yields [{name, description}]
  for (const block of blocks) {
    const hitM = ATTACK_HIT_RE.exec(block.description);
    if (!hitM) continue;  // Multiattack, Breath, Traits — no `+N to hit`
    const attackBonus = parseInt(hitM[1]!, 10);
    const diceM = DAMAGE_DICE_RE.exec(block.description);
    if (!diceM) continue;
    const damageDice = diceM[1]!;
    return { attackBonus, damageDice };
  }
  return null;
}
```

**Prose variation notes** [VERIFIED: live bestiary files]:
- Compound damage (`2d10+8 piercing + 4d6 fire`) — the FIRST `XdY+Z` match captures the primary die, which is correct for v2 (no resistance modeling).
- CR strings in frontmatter are `"1/4"`, `"1/2"`, `"5"`, `"17"` etc. — mixed numeric and fractional strings. Parsing `cr` from frontmatter requires handling fractions when using in the CR table.
- All 180 bestiary files follow the same frontmatter + `## Actions` structure established by seed-bestiary.ts.

### Pattern 4: CR → Attack Stats Table (D-05, Claude's Discretion)

The DMG "Monster Statistics by Challenge Rating" table is [ASSUMED] from training knowledge (not in the project's rulebook files — `master_handbook.md §8.2` covers ENVIRONMENTAL improvised damage only, not melee attack statistics).

Recommended concrete lookup for the planner's use (tunable, loosely DMG-aligned):

```typescript
// [ASSUMED: DMG "Monster Statistics by Challenge Rating" guidance]
// Floor: CR 0 / ≤1/4 → +4 / 1d6 (goblin-tier, matches D-06 default)
// These are TUNABLE; store as a record the planner/implementer can adjust.
const CR_TO_ATTACK_STATS: Record<number, { attackBonus: number; damageDice: string }> = {
  0:  { attackBonus: 4,  damageDice: '1d6'    },  // 0–1/4 → goblin tier
  1:  { attackBonus: 4,  damageDice: '1d8'    },  // CR 1
  2:  { attackBonus: 5,  damageDice: '1d8+3'  },  // CR 2 (bandit captain: +5/1d6+3 ✓)
  3:  { attackBonus: 5,  damageDice: '1d10+3' },  // CR 3
  4:  { attackBonus: 5,  damageDice: '2d6+3'  },  // CR 4
  5:  { attackBonus: 7,  damageDice: '2d6+4'  },  // CR 5 (troll: +7/2d6+4 ✓)
  6:  { attackBonus: 7,  damageDice: '2d8+4'  },  // CR 6–7
  8:  { attackBonus: 8,  damageDice: '2d8+5'  },  // CR 8–11
  12: { attackBonus: 10, damageDice: '3d8+5'  },  // CR 12–16
  17: { attackBonus: 14, damageDice: '2d10+8' },  // CR 17+ (adult red dragon: +14/2d10+8 ✓)
};
// Lookup: find the largest key ≤ actual CR. Fractions: 1/4→0.25→key 0, 1/2→0.5→key 0.
```

**Verification against live bestiary data**:
- Goblin CR 1/4: +4 to hit, 1d6+2 → table gives +4/1d6 (conservative, valid) [VERIFIED: goblin.md]
- Orc CR 1/2: +5 to hit, 1d12+3 → table gives +4/1d6 (conservative) [VERIFIED: orc.md]
- Bandit Captain CR 2: +5 to hit, 1d6+3 → table gives +5/1d8+3 (reasonable) [VERIFIED: bandit-captain.md]
- Troll CR 5: +7 to hit, 2d6+4 → table gives +7/2d6+4 (exact match) [VERIFIED: troll.md]
- Adult Red Dragon CR 17: +14 to hit, 2d10+8 → table gives +14/2d10+8 (exact match) [VERIFIED: adult-red-dragon.md]

The LLM passes `cr` as a numeric value (D&D-native — LLM handles CR fluently). The `monster_spawn` payload `cr?` field should accept a `number` type in TypeScript. The validator must accept positive numbers including fractions (0.25 for CR 1/4, 0.5 for CR 1/2). The LLM will pass integer CRs for custom monsters (e.g., `"cr": 3`), which is simpler than the string-fraction format in bestiary frontmatter.

### Pattern 5: Hook Point in route.ts (D-01/D-02)

[VERIFIED: route.ts live code, 1062 lines total]

The v1 player resolver block ends at route.ts approximately line 406 (`if (_resolver !== null) { for (const ev of _resolver.events) ... }`). The monster-turn loop hooks IMMEDIATELY AFTER this block, before `buildTurnDirective` (~line 442). The post-loop encounter read already exists at line 580 inside the DB transaction (`parseEventsFile` → `replayEvents` → `resolveCombatHandoff`).

The new monster-turn block needs:
1. Read encounter state (post-v1 resolution) — EARLY READ, same as the v1 gate
2. Detect if active actor is a monster (`turnOrder[currentIdx].actorId` not in party)
3. Also need: extend the party select (line 560) to include `ac` — **this is the D-12 bridge**

```typescript
// Hook point: after the v1 _resolver emission block (~ route.ts:415)
// and before buildTurnDirective (~ route.ts:442)

// Read post-v1 encounter state (new early read for monster-turn detection)
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
        // Run the monster-turn loop
        // ... (see Loop Driver pattern below)
        _monsterLoopRan = true;
      }
    }
  } catch (err) {
    console.warn('[turn] monster-turn gate read failed:', err);
  }
}
```

**CRITICAL — PC AC bridge (D-12):** The existing party selects at lines 560 and 968 select `{ id, name, createdAt }`. Both need `ac` added. The line-560 select feeds `resolveCombatHandoff` (which only needs `id`) — `ac` addition is additive (no type breakage since `resolveCombatHandoff` uses `ReadonlyArray<{ id: string }>`). The monster-turn resolver builds a `Map<pcId, ac>` from this extended select.

```typescript
// Modified party select (line 560):
const party = await tx
  .select({ id: charactersTable.id, name: charactersTable.name, ac: charactersTable.ac, createdAt: charactersTable.createdAt })
  .from(charactersTable)
  .where(and(
    eq(charactersTable.campaignId, s.campaignId),
    isNull(charactersTable.deletedAt),
    isNotNull(charactersTable.templateId),
  ))
  .orderBy(charactersTable.createdAt);
```

But note: the monster-turn loop runs BEFORE the DB transaction (it needs to emit events in the loop, not just at the end). So the PC AC map needs to be built EARLIER — either via a separate early select or by moving the party select up. The cleanest approach: add a small targeted select of `{ id, ac }` right before the monster-turn gate check, specific to the campaignId, without touching the transaction-scoped party selects.

### Pattern 6: Loop Driver

```typescript
// Source: derived from D-02/D-03 CONTEXT.md + projector.ts reducer behavior

const MONSTER_LOOP_SAFETY_CAP = 20;  // Claude's discretion — covers any realistic encounter

async function runMonsterTurnLoop(args: {
  campaignId: string;
  pcAcById: Map<string, number>;
  rng: Rng;
  sessionId: string;
}): Promise<MonsterTurnResult[]> {
  const results: MonsterTurnResult[] = [];
  let iterations = 0;

  while (iterations < MONSTER_LOOP_SAFETY_CAP) {
    iterations++;
    // Re-read encounter state after each turn_advance emission
    const { encounter } = replayEvents(await parseEventsFile(eventsPath(args.campaignId)));
    if (!encounter.active || encounter.turnOrder.length === 0) break;

    const activeEntry = encounter.turnOrder[encounter.currentIdx];
    if (!activeEntry) break;
    const activeMonster = encounter.monsters.find(m => m.id === activeEntry.actorId && m.isAlive);

    // Stop condition (a): active actor is a PC (not a monster)
    if (!activeMonster) break;

    // Live PC targets (D-11, D-14)
    const pcIds = encounter.turnOrder
      .map(t => t.actorId)
      .filter(id => args.pcAcById.has(id));
    const livePcIds = pcIds.filter(id => {
      // HP > 0: we need per-PC HP — but EncounterState only has monster HP.
      // PC HP comes from CharacterState (per-character vault file / Postgres).
      // For v2: use Postgres hp lookup (snap.party[].hpCurrent) or a separate select.
      // See Pitfall 2 below — this is a non-obvious gap.
      return true;  // placeholder — see Pitfall 2
    });

    // Stop condition (b): no live targetable PC
    if (livePcIds.length === 0) break;

    // Resolve this monster's turn
    const stats = getMonsterAttackStats(activeMonster, getBestiaryActions(activeMonster.name));
    const result = resolveMonsterTurn({
      monster: activeMonster,
      attackBonus: stats.attackBonus,
      damageDice: stats.damageDice,
      livePcIds,
      pcAcById: args.pcAcById,
      rng: args.rng,
    });

    // Emit events server-side (D-02, mirrors v1 D-06)
    for (const ev of result.events) {
      const r = await dispatchVaultTool('apply_event', ev, { campaignId: args.campaignId });
      if (r.isError) console.warn('[turn] monster-turn emit failed:', r.content);
    }

    results.push(result);
  }
  return results;
}
```

### Pattern 7: D-16 Suppression (monsterResolved flag, mirrors D-07)

v1 added `serverResolved` to `TurnDirectiveOpts` (turn-directive.ts:54) which suppresses the player-side resolve directive AND the combat-start catalog. v2 adds a parallel `monsterResolved` flag (or reuses `serverResolved`) to suppress the "Area C — Turn rule" lines (`prompt-builder.ts:209-217`).

[VERIFIED: prompt-builder.ts:209-217 — "Area C — Turn rule" is the `combatLifecycleBlock()` push block starting at line 209, covering `lines.push('### Turn rule')` through the end of the function at line 218. It's part of the STATIC `combatLifecycleBlock()` function which takes no arguments (deterministic, REQ-022).]

**The suppression challenge:** `combatLifecycleBlock()` is currently static (no parameters), which preserves REQ-022 byte-stability of the SYSTEM PROMPT. The Area C lines live inside the system prompt, not the per-turn directive.

Two approaches (Claude's discretion):
1. **Directive-only suppression (recommended):** Leave the system prompt unchanged. On a monster-resolved turn, the `runVaultToolLoop` receives `suppressCombatMutations: true` (already wired from v1). The system prompt still contains Area C, but the directive injected into history says `[RESOLVED BY SYSTEM: ...]` which overrides it at the recency layer. This is exactly what v1 does — the system prompt still has combat instructions, but the directive + `suppressCombatMutations` prevent the model from acting on them.
2. **buildTurnDirective gate:** Extend `TurnDirectiveOpts` to accept `monsterResolved?: boolean` and in the returned directive string, add an explicit negation of Area C ("Il server ha già eseguito i turni dei mostri — NON chiamare hp_change o turn_advance per i mostri").

Approach 1 is simpler and avoids touching `buildVaultSystemPrompt` (which cannot accept per-turn flags without breaking REQ-022). Approach 2 is belt-and-suspenders. Both can coexist.

### Pattern 8: Combined Narration Directive (D-15)

After the loop, build ONE directive covering all monster actions:

```
[RESOLVED BY SYSTEM: turni mostri — Veyra colpisce Luffy per 7 danni (15 vs CA 12); 
il Goblin manca Luffy (8 vs CA 12)] 
Narra questi esiti in seconda persona, in ordine; NON chiedere tiri e NON scrivere 
eventi JSON — il sistema ha già applicato danni e avanzamenti di turno.
```

This is injected via `appendDirectiveToHistory` (the same mechanism as v1's `_resolver.narrationDirective`). The `suppressCombatMutations: true` flag is already wired from v1.

### Anti-Patterns to Avoid

- **Running the loop INSIDE the DB transaction:** `dispatchVaultTool` calls `parseEventsFile`/`regenerateAffectedViews` which does filesystem I/O. Running it inside a `db.transaction()` block risks deadlock or long-held transaction. The v1 `_resolver` events are emitted OUTSIDE the transaction at route.ts:415. The monster-turn loop MUST also run outside the transaction.
- **Re-reading events.md once per iteration with no cap:** Always enforce `MONSTER_LOOP_SAFETY_CAP` before each `parseEventsFile` call. The cap prevents infinite loops if the `turn_advance` reducer fails to advance due to an unexpected edge.
- **Tracking PC HP from EncounterState:** `EncounterState.monsters[]` has `hpCurrent`; PCs do NOT. PC HP lives in Postgres `characters` (via snapshot) or per-character CharacterState in the vault. See Pitfall 2.
- **Passing `cr` as a string to TypeScript type:** The `monster_spawn` payload `cr?` should be `number` in the TypeScript type (the LLM passes integers; fractional CRs like 0.25 are representable). The validator must accept positive finite numbers. Do NOT use a string union.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Crypto-backed RNG | Custom `Math.random()` wrapper | `defaultRng` from `engine/rand.ts` | Already crypto-backed, injectable, tested |
| Seeded deterministic RNG for tests | Any PRNG | `makeSeededRng(seed)` from `engine/rand.ts` | Already implemented (Mulberry32), used in dice.test.ts |
| d20 roll with advantage/disadvantage | Manual `rng.intInclusive(1,20)` | `rollD20(opts, rng)` from `engine/dice.ts` | Handles adv/dis, returns DiceRoll shape with rolls[] and total |
| Damage roll | Manual loop | `rollDamage(formula, opts, rng)` from `engine/dice.ts` | Handles crit-doubling flag (even though v2 doesn't use it), formula parsing |
| Hit rule | Ad-hoc comparison | Mirror `combat-resolver.ts` hit rule exactly: `natural !== 1 && (natural === 20 \|\| total >= ac)` | Already tested, 5e-faithful |
| Event emission | Direct file write | `dispatchVaultTool('apply_event', ev, { campaignId })` | Validates, allocates UUID, persists, regenerates combat.md |
| Actions prose parsing | Bespoke markdown parser | `parseNamedBlocks` (srd/parsers/monsters.ts:65) + small regex overlay | Handles colon-form and parenthetical-form, already tested |
| Narration enforcement | New post-processor | `enforceResolvedNarration` (combat-resolver.ts:252) | Already handles roll-request stripping + event-JSON stripping |

**Key insight:** Almost every building block already exists in this codebase. v2 is primarily about wiring them together in the right sequence at the right hook point.

---

## Common Pitfalls

### Pitfall 1: PC HP Tracking for the Live-Target Filter (D-11, D-14)

**What goes wrong:** The loop needs to filter `livePcIds` to those with HP > 0. But `EncounterState` only tracks monster HP (`monsters[].hpCurrent`). PC HP is NOT in the encounter state.

**Why it happens:** Phase 06 D1 design invariant (projector.ts:650): "Only monsters live in `EncounterState.monsters`. PC HP comes from the per-character CharacterState (unchanged by this phase)."

**How to avoid:** Two options:
1. **Postgres snapshot (recommended for v2):** The route already builds `snap` (via `buildSnapshot`) which includes `snap.party[].hpCurrent`. Pass a `Map<pcId, hpCurrent>` into the loop driver alongside `pcAcById`. Both come from the same snapshot (or a targeted select of `{ id, ac, hpCurrent }` from Postgres before the loop starts).
2. **Vault CharacterState:** Each PC has a per-character `.md` file with frontmatter HP. Parsing it per iteration is expensive. Not recommended for v2.

The Postgres `characters` table has `hpMax` but the CURRENT HP is in `session_state` or materialized from vault events depending on the path. For vault campaigns, HP mutations go through `hp_change` events. The snapshot `buildSnapshot` already reconciles this (it reads both Postgres + vault event log). Use the snapshot's `snap.party[].hpCurrent` for the live-PC filter.

**Warning signs:** Tests pass because the 1v1 smoke always has 1 live PC (no filter logic needed), but multi-PC encounters stall or loop infinitely.

### Pitfall 2: `cr?` in EncounterState vs monster_spawn payload

**What goes wrong:** The `monster_spawn` payload gains `cr?`, but the projector's `EncounterState.monsters[]` shape does NOT currently include `cr`. The loop needs `cr` to route to the D-05 table.

**Why it happens:** The projector's encounter reducer (`applyEncounterEvent`, projector.ts:723) maps `monster_spawn` payload to the `EncounterState.monsters` entry. Currently it copies `{id, name, hpCurrent, hpMax, ac?, initiativeBonus?, isAlive, conditions}`. It does NOT copy `cr`.

**How to avoid:** Either (a) add `cr?: number` to the `EncounterState.monsters[]` member shape AND update the reducer to copy it from the payload — this is the cleanest approach, (b) look up the CR from the `monster_spawn` payload history by replaying events (expensive), or (c) maintain a separate `Map<monsterId, cr>` built during the spawn events at loop startup.

Option (a) is the right call: it is additive to `EncounterState` (no reducer tests break — adding a new optional field), and it makes the CR available at resolution time without re-scanning events.

**Warning signs:** `monster.cr` is always `undefined` in the loop even when the LLM correctly provided it in the spawn event.

### Pitfall 3: Double-advance on Server-Resolved Monster Turn

**What goes wrong:** After the monster-turn loop emits `turn_advance` events (one per monster turn), the existing `resolveCombatHandoff` path at route.ts:580 re-reads encounter state and derives the NEXT actor. This is correct. However, if the `suppressCombatMutations` flag is not correctly applied, the LLM's narration-only loop could emit additional `turn_advance` calls that double-advance the initiative order.

**Why it happens:** The `suppressCombatMutations: true` flag drops `ENCOUNTER_EVENT_TYPES` apply_event calls in the loop (Phase 08 Plan 02). This ALREADY handles it — exactly the same mechanism as v1. Providing `suppressCombatMutations: true` when `_monsterLoopRan` mirrors the existing `_resolver !== null` gate.

**How to avoid:** Gate `suppressCombatMutations: true` whenever `_monsterLoopRan` is true. Apply `enforceResolvedNarration` to the narration output with a `MonsterLoopResult`-shaped resolver (adapt the existing `ResolveCombatResult` interface or create a parallel one).

### Pitfall 4: Bestiary Slug vs Monster Name (D-04)

**What goes wrong:** The monster in `EncounterState.monsters[]` has a `name` field set by the LLM at spawn time (e.g. "Goblin", "goblin", "GOBLIN"). The bestiary files are at `data/vault/handbook/monsters/goblin.md` (slugified name). The lookup must slug-normalize both sides.

**Why it happens:** `matchMonster` in combat-resolver.ts already handles case-insensitive matching for player-entered target names. The bestiary slug lookup needs the same normalization: `monster.name.toLowerCase().replace(/\s+/g, '-')`.

**How to avoid:** Use the same slug normalization as `seed-bestiary.ts` uses when writing the files (`slugify` in the seed script). Check `data/vault/handbook/monsters/<slug>.md` exists using `path.join(VAULT_ROOT, 'handbook', 'monsters', slug + '.md')`. Read via `fs.readFile` (synchronous OK in the resolver since it's already in an async context).

**Edge case:** Multi-word monster names: "Bandit Captain" → `bandit-captain.md`. [VERIFIED: `data/vault/handbook/monsters/bandit-captain.md` exists]

### Pitfall 5: The CR String vs Number Mismatch (bestiary frontmatter vs EncounterState)

**What goes wrong:** Bestiary frontmatter has `cr: "1/4"` (string, fractional). The `monster_spawn` payload's new `cr?` field is a number (the LLM passes integers). The lookup table must handle BOTH entry points.

**How to avoid:** Two separate lookup paths:
- From EncounterState `monster.cr` (comes from monster_spawn payload, numeric): use as-is.
- From bestiary frontmatter `cr: "1/4"` string: parse fraction strings (`"1/4"` → 0.25, `"1/2"` → 0.5) only when using bestiary CR as a fallback. For v2, the bestiary path (D-04) uses the PARSED ATTACK STATS directly, not the CR — so the bestiary CR string is irrelevant to the lookup table.

The D-05 table is only used when `monster.cr` (from monster_spawn payload) is present. The lookup is `number` keyed (largest key ≤ cr). No fraction parsing needed for v2.

### Pitfall 6: Loop Reads events.md N Times Per Turn

**What goes wrong:** Each iteration of the monster-turn loop calls `parseEventsFile` + `replayEvents`. With a 20-cap and a large events.md file (hundreds of events from a long campaign), this is O(N * M) reads/replays.

**Why it's acceptable for v2:** The M4 target hardware (120 GB/s filesystem bandwidth, SSD) makes this fast. The One Piece smoke has <100 events total. For the safety cap of 20, this is at most 20 filesystem reads. [ASSUMED: acceptable for v2 given M4 hardware; would become a concern at O(1000+) events]

**How to avoid if it becomes a concern:** Track the accumulated `EncounterState` in-memory, applying each emitted event via `applyEncounterEvent` without re-reading disk. But this requires the resolver to accumulate state rather than reading from disk — more complex; defer to v3 optimization if needed. (Plan 09-04 adopts exactly this in-memory accumulation for the loop driver.)

---

## Code Examples

### Verified: `rollD20` with injectable RNG

```typescript
// Source: src/engine/dice.ts (live code)
import { rollD20 } from '@/engine/dice';
import { makeSeededRng } from '@/engine/rand';

const rng = makeSeededRng(42);
const d20 = rollD20({ modifier: 4 }, rng);
// d20.rolls[0] = natural (1..20)
// d20.total = natural + modifier
// d20.formula = "1d20+4"
```

### Verified: `EncounterState` shape for monster-turn detection

```typescript
// Source: src/ai/master/vault/projector.ts:661 (live code)
// turnOrder[currentIdx].actorId → check against monsters[].id AND monsters[].isAlive
const actor = encounter.turnOrder[encounter.currentIdx];
const activeMonster = actor
  ? encounter.monsters.find(m => m.id === actor.actorId && m.isAlive)
  : undefined;
const isMonsterTurn = !!activeMonster;
```

### Verified: `hp_change` for PC damage

```typescript
// Source: src/ai/master/vault/events-schema.ts:261 (live code)
// hp_change applies to CHARACTERS (PCs); monster_hp_change applies to monsters by id.
// For monster→PC damage: use hp_change with the PC's character UUID.
const event: VaultEvent = {
  type: 'hp_change',
  payload: { character: pcUuid, delta: -damage }  // negative delta = damage
};
// The reducer clamps: newHp = max(0, hpCurrent + delta)
```

### Verified: `enforceResolvedNarration` signature

```typescript
// Source: src/app/api/sessions/[id]/turn/combat-resolver.ts:252 (live code)
export function enforceResolvedNarration(
  finalText: string,
  resolver: ResolveCombatResult,  // needs damageRequest field — adapt for monster turns
): string
// Strips: roll-request lines (/\bTira\b[^"\n]*?\b\d+\s*[dD]\s*\d+/i)
//         event-label lines (monster_hp_change, turn_advance, ...)
//         event-JSON lines ({ "id"|"delta"|... })
// Appends: resolver.damageRequest if non-null
// v2: damageRequest will always be null (monsters don't request player rolls)
// → enforceResolvedNarration strips leaked JSON/event-labels; append nothing.
```

### Verified: `parseNamedBlocks` on Actions prose

```typescript
// Source: src/srd/parsers/monsters.ts:65 (live code)
// Input: "Scimitar: +4 to hit, 5ft, 1d6+2 slashing. Shortbow: +4 to hit, range 80/320, 1d6+2 piercing."
// Output: [
//   { name: 'Scimitar', description: '+4 to hit, 5ft, 1d6+2 slashing' },
//   { name: 'Shortbow', description: '+4 to hit, range 80/320, 1d6+2 piercing' }
// ]
// The segment split regex: /\.(?=\s*[A-Z][^.]+(?::|\s*\())/
// → splits on ". " before an uppercase-starting word followed by colon or paren.
```

---

## State of the Art

| Old Approach | Current Approach (Phase 09) | When Changed | Impact |
|--------------|---------------------------|--------------|--------|
| LLM runs monster turns via Area C prompt directive | Server resolves monster turns, LLM narrates only | Phase 09 | Fixes the local-model ceiling (same as v1 fixed player attacks) |
| Monster attack stats: LLM invents freely | 3-level fallback: bestiary prose → CR table → named constant | Phase 09 | Deterministic mechanics |
| PC HP: LLM tracks narratively | PC AC from Postgres `characters.ac notNull`; PC HP from snapshot | Phase 09 | Closes the PC-AC bridge |

**Deprecated/outdated for v2:**
- Area C prompt directive ("run through consecutive monster turns automatically…") — no longer the authority; the server is. The Area C lines remain in the system prompt but are neutralized by `suppressCombatMutations` + the narration directive (or optionally by a `buildTurnDirective` gate — Claude's discretion, D-16).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | DMG "Monster Statistics by Challenge Rating" table values used to populate CR_TO_ATTACK_STATS | Architecture Patterns / Pattern 4 | Table is tunable — wrong values affect game balance but not correctness. Can be adjusted post-smoke. |
| A2 | Safety iteration cap of 20 is sufficient for any realistic encounter | Architecture Patterns / Pattern 6 | If a bug prevents turn_advance from firing, the cap will eventually stop the loop — 20 is conservative. |
| A3 | PC hpCurrent is available in `snap.party[]` from the existing `buildSnapshot` call | Common Pitfalls / Pitfall 1 | If snap.party doesn't include live HP, the live-PC filter will be wrong. Verify against `buildSnapshot` return type before implementing. (RESOLVED in Open Questions — snap.party does NOT carry live HP; source it from the replay CharacterState map.) |
| A4 | M4 filesystem: 20 × `parseEventsFile` per turn is acceptable latency | Common Pitfalls / Pitfall 6 | For large campaigns (1000+ events), re-read cost could exceed the 10s target (REQ-021). (Mitigated: 09-04 keeps the loop in-memory, applying events via applyEncounterEvent rather than re-reading per iteration.) |

---

## Open Questions (RESOLVED)

All three open questions below were resolved during planning (Phase 09 plans 09-01 / 09-02 / 09-04 / 09-06). Each is marked RESOLVED inline with the resolution and a citation to where it is implemented.

1. **Where does the early PC AC/HP select live? Does `snap.party[]` carry live HP?** — **RESOLVED.**
   - What we knew: the party select at route.ts:560 is inside the DB transaction (post-LLM). The monster-turn loop needs `pcAcById` and `livePcIds` BEFORE the loop (which runs before the LLM call).
   - **Resolution:** `snap.party[]` does NOT carry live HP — it carries static character-row fields (id, name, ac, hpMax) only (confirmed against `buildSnapshot`, src/sessions/snapshot.ts:377-413). PC **AC** comes from `snap.party[].ac` (the row; `characters.ac` is `notNull`, D-12 — no PC-AC default needed). PC **current HP** is sourced from the per-character `CharacterState` map produced by `replayEvents(await parseEventsFile(eventsPath(campaign.id)))` (the same replay used for the encounter gate; per projector.ts the per-character CharacterState carries current HP, not `EncounterState.monsters[]`), falling back to the character row's `hpMax` when a PC is absent from the replay map. The route builds both `Map<pcId, ac>` and `Map<pcId, hpCurrent>` before the loop and passes them into `runMonsterTurnLoop`. Resolved in **plan 09-06 step 1** (PC-AC/PC-HP maps built from `snap.party` + the replay chars map) and consumed by the loop in **plan 09-04** (`pcAcById` / `pcHpById` args). Updates Assumption A3.

2. **Does `EncounterState.monsters[]` need `cr?` added, or is a separate Map sufficient?** — **RESOLVED.**
   - What we knew: the projector reducer does not currently copy `cr` from the spawn payload. The CR is needed at resolution time (D-05).
   - **Resolution:** `cr` IS added to `EncounterState.monsters[]` via the projector reducer (the recommended additive option a). `cr?: number` is added to the `EncounterState.monsters[]` member interface AND the `applyEncounterEvent` `monster_spawn` case copies `cr` from the (server-controlled) `monster_spawn` payload onto the entry — strictly additive, so existing cr-less event logs replay byte-stable and no reducer tests break. Resolved in **plan 09-01 Task 2** (`src/ai/master/vault/projector.ts`); the propagated `cr` feeds Level 2 (the CR table) of `getMonsterAttackStats` in **plan 09-02** and is read by the loop in **plan 09-04**.

3. **Can `ResolveCombatResult` / `enforceResolvedNarration` be reused for the monster narration pass, or does v2 need a parallel type?** — **RESOLVED.**
   - What we knew: `enforceResolvedNarration` takes `ResolveCombatResult` (which includes `damageRequest`). Monster turns never have a `damageRequest` (the PC doesn't roll in response to a monster attack — the server handles it entirely).
   - **Resolution:** `enforceResolvedNarration` is REUSED as-is — no parallel type and no monster-specific variant. Its signature is `enforceResolvedNarration(finalText: string, resolver: ResolveCombatResult): string` (defined at **src/app/api/sessions/[id]/turn/combat-resolver.ts:252**, with `ResolveCombatResult` at combat-resolver.ts:58-63). The monster path passes a `ResolveCombatResult`-shaped object with `damageRequest: null` (the monster sequence has no single settled damage-request); the strip logic (ROLL_REQUEST / EVENT_LABEL / EVENT_JSON regexes) still applies and, with `damageRequest: null`, nothing is appended. Resolved in **plan 09-06**, where the final narration is bound by `enforceResolvedNarration` whenever the monster loop ran (`_monsterLoopRan`), regardless of `_resolver` state — so the combined monster directive's output is sanitized even on the common D-01 path where a player attack also resolved in the same request.

---

## Environment Availability

Step 2.6: SKIPPED (no new external dependencies — Phase 09 is a pure extension of existing in-repo modules and the Postgres + filesystem infrastructure already used by Phase 08).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (node environment) |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `pnpm test -- --reporter=verbose tests/app/api/sessions/\\[id\\]/turn/combat-resolver.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

Phase 09 has no formal REQ IDs (ROADMAP states "Requirements: TBD"). Coverage derived from locked decisions D-01..D-16:

| D-ID | Behavior | Test Type | Automated Command | File Exists? |
|------|----------|-----------|-------------------|-------------|
| D-09 / hit rule | nat20 auto-hits even below AC | unit | `pnpm test -- tests/app/api/sessions/\\[id\\]/turn/combat-resolver.test.ts` | ❌ Wave 0 (new file or extend existing) |
| D-09 / hit rule | nat1 auto-misses even above AC | unit | same | ❌ Wave 0 |
| D-09 / hit rule | total >= AC = hit | unit | same | ❌ Wave 0 |
| D-09 / hit rule | total < AC = miss (no nat extremes) | unit | same | ❌ Wave 0 |
| D-10 / RNG seam | deterministic with makeSeededRng | unit | same | ❌ Wave 0 |
| D-11 / target | random live PC selected from injected RNG | unit | same | ❌ Wave 0 |
| D-11 / target | collapses to single PC in 1v1 | unit | same | ❌ Wave 0 |
| D-13 | hp_change emitted on hit with -damage | unit | same | ❌ Wave 0 |
| D-13 | turn_advance always emitted (hit or miss) | unit | same | ❌ Wave 0 |
| D-14 / PC at 0 HP | downed PC leaves targetable pool | unit | same | ❌ Wave 0 |
| D-14 / last PC | loop stops when no live PC remains | unit | same | ❌ Wave 0 |
| D-03 / cap | loop stops at safety cap (no advance bug) | unit | same | ❌ Wave 0 |
| D-03 / stop | loop stops when active actor is PC | unit | same | ❌ Wave 0 |
| D-04 / bestiary | parses +N/XdY from Actions prose (goblin, orc) | unit | `pnpm test -- tests/srd/` or new file | ❌ Wave 0 |
| D-04 / multiattack | skips Multiattack line, uses first +N to hit | unit | same | ❌ Wave 0 |
| D-05 / CR table | CR 5 → +7/2d6+4 (table verification) | unit | new test file | ❌ Wave 0 |
| D-06 / defaults | no hint + no bestiary → +4/1d6 | unit | same | ❌ Wave 0 |
| D-08 / schema | monster_spawn validates with optional cr? | unit | `pnpm test -- tests/ai/` or new file | ❌ Wave 0 |
| D-08 / schema | old monster_spawn without cr? still valid (byte-stable) | unit | same | ❌ Wave 0 |
| D-15 / narration | combined directive built from all loop results | integration | `pnpm test -- tests/sessions/` | ❌ Wave 0 |
| D-16 / suppression | monster-turn suppresses Area C directives | integration | `pnpm test -- tests/sessions/` | ❌ Wave 0 |
| Smoke | One Piece / Veyra: monster hits PC → hp_change in tracker | operator smoke | n/a (manual) | manual |

### Sampling Rate

- **Per task commit:** `pnpm test -- tests/app/api/sessions/\\[id\\]/turn/combat-resolver.test.ts`
- **Per wave merge:** `pnpm test` (full vault suite — currently 708 tests)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] New unit test file OR extend `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` — covers D-09 (hit rule nat1/nat20/≥AC), D-10 (injectable RNG), D-11 (random live PC), D-13 (hp_change events), D-14 (PC at 0 HP), D-03 (loop stop conditions), D-06 (defaults)
- [ ] New test file for D-04 prose regex — covers bestiary parse (goblin/orc actions prose, multiattack skipping)
- [ ] New test file for D-05 CR→stats table — covers table lookup, floor, known monster cross-check
- [ ] Extend `tests/ai/master-vault-events-schema.test.ts` (or equivalent) — covers D-08 (monster_spawn with/without cr?)
- [ ] Integration test for D-16 suppression — verify directive on a monster-resolved turn does not include Area C re-ask content
- [ ] `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` already exists (Phase 08) — can extend with monster-turn-specific describe block

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | — |
| V3 Session Management | No | — |
| V4 Access Control | Yes | `campaignId` is server-authoritative (never player-derived) — mirrors T-08-06 |
| V5 Input Validation | Yes | `cr?` validated as positive finite number; bestiary slug sanitized via path.join (mirrors safeVaultPath) |
| V6 Cryptography | No | — |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Player injects monster `id` via damage-request label to redirect damage | Tampering | Monster IDs in hp_change come only from `EncounterState.monsters[]` resolved server-side; player never supplies them |
| Malformed `cr?` value causes table crash | DoS | Validate as positive finite number in `validateEvent`; resolver falls back to default on missing/invalid |
| Over-large negative `delta` in hp_change underflows PC HP | Tampering | Reducer clamps `max(0, hp+delta)` — already in the existing `hp_change` reducer (same as monster side) |
| Infinite loop with cap disabled | DoS | `MONSTER_LOOP_SAFETY_CAP` enforced before each iteration; never throws, loop exits defensively |
| Bestiary path traversal via monster name | Tampering | Slug-normalize name + `path.join` (same pattern as `safeVaultPath`) — never use raw monster name in file path |

---

## Sources

### Primary (HIGH confidence)

- `src/app/api/sessions/[id]/turn/combat-resolver.ts` — live code, entire file read (v1 resolver contract, `enforceResolvedNarration`, hit rule, `ResolveCombatResult`)
- `src/engine/rand.ts` — live code, entire file read (`Rng` interface, `defaultRng`, `makeSeededRng`)
- `src/engine/dice.ts` — live code, entire file read (`rollD20`, `rollDamage`, `rollDice`, RNG parameter signatures)
- `src/ai/master/vault/projector.ts:661-676` — live code read (`EncounterState` shape, `monsters[]` fields)
- `src/ai/master/vault/events-schema.ts:259-339` — live code read (`VaultEvent` union, `monster_spawn` shape, `hp_change`, `ENCOUNTER_EVENT_TYPES`)
- `src/ai/master/vault/events-schema.ts:1012-1051` — live code read (`validateEvent` monster_spawn branch)
- `src/ai/master/vault/turn-directive.ts` — live code, entire file read (`serverResolved` pattern, D-07)
- `src/ai/master/vault/prompt-builder.ts:164-218` — live code read (`combatLifecycleBlock` — Area C at lines 209-217)
- `src/ai/master/vault/tools.ts:95-107` — live code read (apply_event `payload` description format)
- `src/app/api/sessions/[id]/turn/route.ts:278-650` — live code read (vault branch, hook points, party selects, existing _resolver block)
- `src/app/api/sessions/[id]/turn/combat-handoff.ts` — live code, entire file read (`resolveCombatHandoff` contract)
- `src/srd/parsers/monsters.ts:65-81` — live code read (`parseNamedBlocks` implementation)
- `src/db/schema/characters.ts:35-38` — live code read (`ac notNull` confirmed)
- `data/vault/handbook/monsters/goblin.md` — live file read (Actions prose format, cr field)
- `data/vault/handbook/monsters/orc.md` — live file read
- `data/vault/handbook/monsters/troll.md` — live file read (Multiattack + compound attacks)
- `data/vault/handbook/monsters/zombie.md` — live file read
- `data/vault/handbook/monsters/bandit-captain.md` — live file read (CR 2 stats)
- `data/vault/handbook/monsters/adult-red-dragon.md` — live file read (CR 17 + compound damage)
- `data/rules.md:215-267` — live file read (§3.10 Attack Rolls, §3.11 Crit, §3.17-3.18 HP/Death Saves)
- `data/master_handbook.md:188-227` — live file read (§7.6 Monster Behavior, §8.2 Improvising Damage)
- `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` — live code read (3-layer testing structure, EncounterState fixtures)
- `tests/engine/dice.test.ts` — live code read (makeSeededRng usage pattern)
- `.planning/phases/09-v2-monster-turns/09-CONTEXT.md` — full read (all 16 locked decisions)
- `.planning/phases/08-server-side-combat-resolver-v1-player-attacks/08-CONTEXT.md` — full read (v1 pattern being extended)
- `.planning/STATE.md` — read (Phase 08 execution decisions, deviations)
- `vitest.config.ts` — live code read (test runner configuration)
- `package.json` scripts — live read (test commands)

### Secondary (MEDIUM confidence)

- DMG "Monster Statistics by Challenge Rating" table — CR_TO_ATTACK_STATS values cross-validated against 5 live bestiary files; DMG source is [ASSUMED] but independently corroborated by the concrete stat blocks in the bestiary. [ASSUMED]

---

## Metadata

**Confidence breakdown:**
- Hook point (route.ts line ranges): HIGH — live code verified at lines 377-650
- Injectable RNG seam: HIGH — `rollD20(opts, rng)` / `rollDamage(formula, opts, rng)` signatures verified live
- Bestiary prose regex: HIGH — 6 real bestiary files inspected; pattern is consistent
- CR→stats table values: MEDIUM — cross-validated against 5 bestiary files, DMG source assumed
- EncounterState `cr?` gap (Pitfall 2): HIGH — confirmed `cr` NOT in current EncounterState type
- PC AC bridge (D-12): HIGH — `characters.ac notNull` verified at schema line 38
- D-16 suppression approach: MEDIUM — system prompt is static (REQ-022); directive-layer suppression is the safer approach; exact wording is Claude's discretion

**Research date:** 2026-05-30
**Valid until:** 2026-06-30 (stable codebase, no fast-moving external dependencies)
