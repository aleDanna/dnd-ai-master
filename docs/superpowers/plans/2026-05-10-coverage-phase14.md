# Phase 14: Vehicles + Mounted Combat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Implementare mounted combat (PHB §3.23) + veicoli (PHB §9.6 + DMG ships). Sblocca ~3 punti coverage.

**Architecture:**

Due aree:
1. **Mount system**: una creatura può montare un'altra creatura willing più grande di una taglia. Mount/dismount costa metà speed. Mount mode: controlled (mount agisce su iniziativa rider, può fare solo Dash/Disengage/Dodge) o independent (mount agisce normalmente).
2. **Vehicles**: cart/wagon/carriage/ship/airship con stats (speed, capacity, crew, AC, HP).
3. **Mounted combat reaction**: quando un attacco colpisce mount o rider, rider può usare reaction per swap target.

**Tools**:
- `mount({ rider, mount })` — rider sale sul mount
- `dismount({ rider })` — scende
- `set_mount_mode({ rider, mode: 'controlled' | 'independent' })`
- `swap_attack_target({ rider, originalTarget, newTarget })` — reaction swap (PHB §3.23)
- `embark_vehicle({ character, vehicleSlug })` — sale su veicolo
- `disembark_vehicle({ character })` — scende

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration). Builds on Phase 1-13.

---

## File Structure

### File da creare:
- `src/engine/mounts.ts` — pure helpers (mountSizeRequirement, mountModes)
- `src/engine/vehicles.ts` — pure helpers + vehicle catalog
- `tests/engine/mounts.test.ts`
- `tests/engine/vehicles.test.ts`
- `tests/engine/scenarios/mounts-vehicles-loop.test.ts`
- `drizzle/0022_*.sql`

### File da modificare:
- `src/engine/types.ts` — `MountMode`, `Vehicle`, `Size`; mutations mount/dismount/set_mount_mode/embark_vehicle/disembark_vehicle; Character.mountedOn?: { mountId, mode }; CombatActor.size?
- `src/db/schema/characters.ts` — colonna `mounted_on` jsonb
- `src/db/schema/combat-actors.ts` — colonna `size` (varchar) o jsonb
- `src/sessions/applicator.ts` — handlers
- `src/sessions/snapshot.ts` — hydrate
- `src/engine/tools/handlers.ts` — 6 handlers
- `src/engine/tools/index.ts` — schema
- `src/ai/master/system-prompt.ts` — guidance

---

## Task 1: Mount helpers + types

```ts
// types.ts
export type Size = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';
export type MountMode = 'controlled' | 'independent';

export interface MountedState {
  mountId: string;
  mode: MountMode;
}

// Character (extend):
mountedOn?: MountedState;

// CombatActor (extend):
size?: Size;

// Mutations:
| { op: 'mount'; characterId: string; mountId: string; mode?: MountMode }
| { op: 'dismount'; characterId: string }
| { op: 'set_mount_mode'; characterId: string; mode: MountMode }
| { op: 'embark_vehicle'; characterId: string; vehicleSlug: string }
| { op: 'disembark_vehicle'; characterId: string }
```

```ts
// src/engine/mounts.ts
import type { Size } from './types';

const SIZE_ORDER: Size[] = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];

export function sizeRank(size: Size): number {
  return SIZE_ORDER.indexOf(size);
}

/** PHB §3.23: a willing creature at least one size larger may serve as mount. */
export function canBeMount(rider: Size, mount: Size): boolean {
  return sizeRank(mount) > sizeRank(rider);
}

/** Cost to mount/dismount: half rider's speed (rounded up). */
export function mountDismountCost(speed: number): number {
  return Math.ceil(speed / 2);
}

/** Controlled mount uses rider's initiative; can only Dash/Disengage/Dodge. */
export const CONTROLLED_MOUNT_ALLOWED_ACTIONS = ['dash', 'disengage', 'dodge'] as const;
```

Tests covering helpers.

Commit: `feat(mounts): pure helpers for mounted combat (PHB §3.23)`.

---

## Task 2: Vehicle catalog

```ts
// src/engine/vehicles.ts

export interface Vehicle {
  slug: string;
  name: string;
  speedFt: number;       // ground speed for vehicles
  capacityLb: number;    // cargo capacity
  passengers: number;    // max passengers
  costGp: number;
  ac?: number;           // for combat-relevant vehicles
  hpMax?: number;
  damageThreshold?: number;
  crew?: number;
}

export const VEHICLE_CATALOG: Record<string, Vehicle> = {
  // PHB §9.6 mundane vehicles
  'cart': { slug: 'cart', name: 'Cart', speedFt: 0, capacityLb: 200, passengers: 2, costGp: 15 },
  'sled': { slug: 'sled', name: 'Sled', speedFt: 0, capacityLb: 100, passengers: 1, costGp: 20 },
  'wagon': { slug: 'wagon', name: 'Wagon', speedFt: 0, capacityLb: 2000, passengers: 4, costGp: 35 },
  'carriage': { slug: 'carriage', name: 'Carriage', speedFt: 0, capacityLb: 0, passengers: 4, costGp: 100 },
  // DMG / Ghosts of Saltmarsh ships (simplified)
  'rowboat': { slug: 'rowboat', name: 'Rowboat', speedFt: 150, capacityLb: 1000, passengers: 4, costGp: 50, ac: 11, hpMax: 50, crew: 1 },
  'sailing-ship': { slug: 'sailing-ship', name: 'Sailing Ship', speedFt: 200, capacityLb: 100000, passengers: 20, costGp: 10000, ac: 15, hpMax: 300, damageThreshold: 15, crew: 20 },
  'galley': { slug: 'galley', name: 'Galley', speedFt: 400, capacityLb: 150000, passengers: 80, costGp: 30000, ac: 15, hpMax: 500, damageThreshold: 20, crew: 80 },
  'longship': { slug: 'longship', name: 'Longship', speedFt: 300, capacityLb: 50000, passengers: 40, costGp: 10000, ac: 15, hpMax: 300, damageThreshold: 15, crew: 40 },
  'warship': { slug: 'warship', name: 'Warship', speedFt: 250, capacityLb: 200000, passengers: 60, costGp: 25000, ac: 15, hpMax: 500, damageThreshold: 20, crew: 60 },
  'airship': { slug: 'airship', name: 'Airship', speedFt: 80, capacityLb: 5000, passengers: 20, costGp: 20000, ac: 13, hpMax: 300, damageThreshold: 10, crew: 10 },
};

export function vehicleBySlug(slug: string): Vehicle | undefined {
  return VEHICLE_CATALOG[slug];
}

/** Walking pace × 2 for a mount on a single trip. */
export function mountTripSpeed(baseSpeedFt: number): number {
  return baseSpeedFt * 2;
}
```

Tests covering catalog + helpers.

Commit: `feat(vehicles): catalog + helpers (PHB §9.6, DMG ships)`.

---

## Task 3: Schema + applicator + migration 0022

Add columns:
- `characters.mounted_on jsonb default null`
- `characters.embarked_on text default null` (vehicle slug)
- `combat_actors.size varchar(16)` (default 'medium' or null)

Generate migration. Apply.

Snapshot hydrates new fields.

Applicator handlers (5):
- `mount`: validate rider not already mounted; validate mount creature exists; set mountedOn
- `dismount`: clear mountedOn
- `set_mount_mode`: update mode field
- `embark_vehicle`: validate vehicle slug exists; set embarkedOn
- `disembark_vehicle`: clear embarkedOn

Tests in applicator.test.ts.

Commit: `feat(applicator): mount/dismount/embark mutations + migration 0022`.

---

## Task 4: Tools

Handlers:
- `handleMount(rider, mount, mode?)`: validate, default mode='controlled', emit mutation
- `handleDismount(rider)`: emit
- `handleSetMountMode(rider, mode)`: validate mode enum
- `handleEmbarkVehicle(character, vehicleSlug)`: validate slug
- `handleDisembarkVehicle(character)`: emit
- `handleSwapAttackTarget(rider, originalTarget, newTarget)`: this is a NARRATIVE tool that consults rider.runtime.turnState.reactionUsed — if no reaction available, error reaction_already_used; otherwise emits consume_action(reaction)

Tool definitions in `src/engine/tools/index.ts`. Wire into TOOL_HANDLERS.

Tests (~12 tests).

Commit: `feat(tools): mount/dismount/embark/disembark/swap_attack_target`.

---

## Task 5: System prompt

```
### Mounted Combat & Vehicles (PHB §3.23, §9.6)

**Mounts**: a PC can ride a willing creature one size larger. Use
`mount({ rider, mount, mode: 'controlled'|'independent' })`.

- **Controlled** (default): mount acts on rider's initiative; can only
  take Dash/Disengage/Dodge actions; rider directs.
- **Independent**: mount has its own initiative; acts as it wishes (e.g.,
  intelligent steed).

Mounting/dismounting costs half rider's speed. Use `dismount({ rider })`
to drop down.

**Reaction swap (PHB §3.23)**: when an attack targets either rider or mount,
the rider may use their reaction to make the OTHER take the hit instead.
Call `swap_attack_target({ rider, originalTarget, newTarget })` — consumes
rider's reaction.

**Vehicles** (PHB §9.6 + DMG): use `embark_vehicle({ character, vehicleSlug })`
to board (cart/wagon/rowboat/sailing-ship/galley/longship/warship/airship).
Use `disembark_vehicle` to exit. Vehicles have speed/capacity/crew tracked
in the catalog.

---

Italiano: Phase 14 aggiunge mount + veicoli. Mount in modalità controlled
(default) o independent. Reaction swap permette al rider di assorbire
l'attacco al posto del mount o viceversa.
```

Commit.

---

## Task 6: E2E

`tests/engine/scenarios/mounts-vehicles-loop.test.ts`:
1. PC mounts a horse (medium PC, large mount) → mounted state set.
2. Mount with same-size creature → fails (PHB rule).
3. Set mount mode to independent → updated.
4. Goblin attacks mount → rider uses swap_attack_target (consumes reaction); rider takes the hit.
5. PC embarks 'sailing-ship' → embarkedOn = 'sailing-ship'.
6. PC disembarks → embarkedOn cleared.

Commit + push.

---

## Stima sforzo Phase 14

- Task 1: 1.5h
- Task 2: 1.5h
- Task 3: 2h
- Task 4: 2h
- Task 5: 30min
- Task 6: 1h

**Totale: ~8.5h** developer; subagent: ~1.5 giornate.
