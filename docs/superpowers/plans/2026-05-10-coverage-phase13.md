# Phase 13: Stronghold + Downtime + Hirelings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Implementare downtime activities (PHB §6) + hirelings + basic strongholds. Sblocca ~3 punti coverage.

**Architecture:**

Tre macro-aree:
1. **Downtime activities** (PHB §6): Practicing a Profession (DC15 ability check, earn workdays), Recuperating (3 days, end disease/poison), Researching (1d20+INT vs DC, gain info), Training (250 days+1gp/day, learn language/tool).
2. **Hirelings**: skilled (2gp/day) and unskilled (2sp/day). Track on character.
3. **Bastion** (semplificato dal 2024 PHB): owns a property with rooms, defenders count, fortification level.

**Tools**:
- `start_downtime_activity({ character, activity, days })` — initiates an activity
- `complete_downtime_activity({ character, activityId })` — resolves outcome with appropriate roll
- `hire({ character, kind: 'skilled'|'unskilled', count, days })` — records hireling cost
- `dismiss_hireling({ character, hireId })`
- `set_bastion({ character, bastion })` — assign bastion data
- `add_bastion_room({ character, room })` — add a room to existing bastion

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration: stronghold + hirelings on characters). Builds on Phase 1-12.

---

## File Structure

### File da creare:
- `src/engine/downtime.ts` — pure helpers (activities, hireling costs, bastion economy)
- `tests/engine/downtime.test.ts`
- `tests/engine/scenarios/downtime-loop.test.ts`
- `drizzle/0021_*.sql`

### File da modificare:
- `src/engine/types.ts` — DowntimeActivity, Hireling, Bastion, BastionRoom; mutations start_downtime/complete_downtime/hire/dismiss/set_bastion/add_bastion_room
- `src/db/schema/characters.ts` — colonne `downtime_activities` jsonb, `hirelings` jsonb, `bastion` jsonb
- `src/sessions/applicator.ts` — handlers
- `src/sessions/snapshot.ts` — hydrate
- `src/engine/tools/handlers.ts` — 6 nuovi handlers
- `src/engine/tools/index.ts` — schema
- `src/ai/master/system-prompt.ts` — guidance

---

## Task 1: Helpers

```ts
// src/engine/downtime.ts

export type DowntimeActivityKind = 'practicing_profession' | 'recuperating' | 'researching' | 'training' | 'crafting';

export interface DowntimeActivityRequirements {
  daysRequired: number;
  gpCostPerDay?: number;
  abilityCheck?: { ability: 'STR'|'DEX'|'CON'|'INT'|'WIS'|'CHA'; dc: number };
}

export function downtimeRequirements(activity: DowntimeActivityKind): DowntimeActivityRequirements {
  switch (activity) {
    case 'practicing_profession':
      // PHB: 1 workweek (5 days), no cost — earns lifestyle. Higher with skill check.
      return { daysRequired: 5 };
    case 'recuperating':
      // PHB: 3 days, end disease or poison via DC 15 CON save
      return { daysRequired: 3, abilityCheck: { ability: 'CON', dc: 15 } };
    case 'researching':
      // 1 day per piece of info via DC INT check
      return { daysRequired: 1, abilityCheck: { ability: 'INT', dc: 15 } };
    case 'training':
      // PHB: 250 days, 1 gp/day to learn a language or tool
      return { daysRequired: 250, gpCostPerDay: 1 };
    case 'crafting':
      // Handled by Phase 12 — narrative pointer only
      return { daysRequired: 0 };
  }
}

export interface HirelingCost {
  goldPerDay: number;  // in gp
  silverPerDay: number;  // in sp (for unskilled)
}

export function hirelingCostPerDay(kind: 'skilled' | 'unskilled'): HirelingCost {
  if (kind === 'skilled') return { goldPerDay: 2, silverPerDay: 0 };
  return { goldPerDay: 0, silverPerDay: 2 };
}

export function hirelingTotalCost(kind: 'skilled' | 'unskilled', count: number, days: number): { gp: number; sp: number } {
  const c = hirelingCostPerDay(kind);
  return {
    gp: c.goldPerDay * count * days,
    sp: c.silverPerDay * count * days,
  };
}

export type BastionRoomKind = 'workshop' | 'library' | 'armory' | 'stable' | 'garden' | 'storage' | 'training' | 'shrine' | 'kitchen' | 'guesthouse';

export interface BastionRoom {
  kind: BastionRoomKind;
  level: number;  // 1-3 (basic/improved/master)
}

export interface Bastion {
  name: string;
  fortification: 'modest' | 'fortified' | 'castle';  // basic tier
  rooms: BastionRoom[];
  defenders: number;
}

/** Build a default room list given a fortification level. */
export function defaultBastionRooms(fortification: 'modest' | 'fortified' | 'castle'): BastionRoom[] {
  switch (fortification) {
    case 'modest': return [
      { kind: 'kitchen', level: 1 },
      { kind: 'storage', level: 1 },
    ];
    case 'fortified': return [
      { kind: 'kitchen', level: 1 },
      { kind: 'storage', level: 1 },
      { kind: 'armory', level: 1 },
      { kind: 'training', level: 1 },
    ];
    case 'castle': return [
      { kind: 'kitchen', level: 2 },
      { kind: 'storage', level: 2 },
      { kind: 'armory', level: 2 },
      { kind: 'training', level: 2 },
      { kind: 'library', level: 1 },
      { kind: 'shrine', level: 1 },
      { kind: 'guesthouse', level: 1 },
    ];
  }
}

export function defaultDefenders(fortification: 'modest' | 'fortified' | 'castle'): number {
  switch (fortification) {
    case 'modest': return 2;
    case 'fortified': return 8;
    case 'castle': return 30;
  }
}
```

Tests: ~15 cases.

Commit: `feat(downtime): pure helpers for downtime activities, hireling costs, bastion defaults`.

---

## Task 2: Schema + applicator + migration 0021

Add columns:
- `characters.downtime_activities jsonb default '[]'`
- `characters.hirelings jsonb default '[]'`
- `characters.bastion jsonb default null`

Generate migration. Apply.

Snapshot hydrates all 3 fields.

Applicator handlers (6):
- `start_downtime_activity`: append to array
- `complete_downtime_activity`: remove from array (master narrates outcome)
- `hire`: append hireling record
- `dismiss_hireling`: remove from array
- `set_bastion`: overwrite bastion field
- `add_bastion_room`: append to bastion.rooms array

Tests in applicator.test.ts (~6 tests).

Commit: `feat(applicator): downtime + hireling + bastion mutations + migration 0021`.

---

## Task 3: Tools

6 handlers + tool defs:
- `handleStartDowntimeActivity(character, activity, days?)` — uses helper for default days; emits start_downtime_activity
- `handleCompleteDowntimeActivity(character, activityId)` — emits complete
- `handleHire(character, kind, count, days)` — computes total cost via helper; emits hire mutation; doesn't enforce gp possession (master responsibility)
- `handleDismissHireling(character, hireId)` — emits dismiss
- `handleSetBastion(character, name, fortification)` — uses defaultBastionRooms + defaultDefenders helpers; emits set_bastion
- `handleAddBastionRoom(character, kind, level?)` — emits add_bastion_room

Tool definitions with proper schemas.

Tests (~12 tests).

Commit: `feat(tools): 6 stronghold/downtime/hireling tools`.

---

## Task 4: System prompt

```
### Stronghold + Downtime + Hirelings (PHB §6, 2024 PHB Bastion)

The PC can use downtime between adventures for various activities.

**Downtime activities** (PHB §6):
- `practicing_profession`: 5 days, earns lifestyle expenses
- `recuperating`: 3 days + DC 15 CON save → ends disease/poison
- `researching`: 1+ days per info, DC 15 INT check
- `training`: 250 days + 1 gp/day → learn language or tool
- `crafting`: see Phase 12 tools

Tools: `start_downtime_activity({ character, activity, days? })` and
`complete_downtime_activity({ character, activityId })`.

**Hirelings** (PHB §6): skilled = 2 gp/day (artisans, scribes, mercenaries);
unskilled = 2 sp/day (laborers, porters). Use `hire({ character, kind, count, days })`
to record a hire; `dismiss_hireling({ character, hireId })` to release.

**Bastion** (2024 PHB simplified): the PC can own a base property.
- Modest: small house/cottage, 2 rooms, 2 defenders
- Fortified: keep, 4 rooms, 8 defenders
- Castle: 7 rooms, 30 defenders

Use `set_bastion({ character, name, fortification })` to establish, then
`add_bastion_room({ character, kind, level })` to expand.

---

Italiano: Phase 13 aggiunge downtime, mercenari, e proprietà (bastion).
```

Commit.

---

## Task 5: E2E

`tests/engine/scenarios/downtime-loop.test.ts`:
1. Start practicing_profession → 5 days project; complete → outcome handled by master
2. Hire 2 unskilled for 10 days → cost 4 sp/day × 10 = 40 sp
3. Set bastion 'fortified' → 4 default rooms + 8 defenders
4. Add a library room → bastion has 5 rooms
5. Dismiss hireling → list shrinks

Commit + push.

---

## Stima sforzo Phase 13

- Task 1: 1.5h
- Task 2: 1.5h
- Task 3: 2h
- Task 4: 30min
- Task 5: 1h

**Totale: ~6h** developer; subagent: ~1 giornata.
