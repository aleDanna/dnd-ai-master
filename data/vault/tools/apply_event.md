---
tool: apply_event
---

# apply_event

Append a game-state mutation event to the campaign's event log. The dispatcher validates the event shape, enforces the character UUID guard for character-scoped events, writes to `events.md`, and synchronously regenerates any affected materialized views.

Returns `{ok: true, event_id: "<uuid>"}` on success. Errors surface as descriptive `ERROR:` strings — never throws.

## Encounter lifecycle

These 6 event types drive combat state. They have **no `payload.character` field** — the UUID guard is skipped for all members of this group.

| Event | Payload shape | Notes |
|---|---|---|
| `combat_start` | `{}` | Opens a new encounter. Clears any prior encounter state. |
| `monster_spawn` | `{id: string, name: string, hpMax: number, ac?: number, initiativeBonus?: number}` | Spawns one monster into the encounter. `id` is a master-invented free string (e.g. `"goblin-1"`). |
| `initiative_set` | `{order: [{actorId: string, initiative: number}]}` | Sets the full initiative order. `actorId` is the character UUID for PCs, or the monster `id` for monsters. |
| `turn_advance` | `{}` | Advances to the next actor in initiative order. |
| `monster_hp_change` | `{id: string, delta: number}` | Adjusts a monster's current HP. `id` must match the `id` used in `monster_spawn`. `delta` is negative for damage, positive for healing. |
| `combat_end` | `{}` | Closes the encounter. |

The live combat tracker is at `campaigns/<campaignId>/combat.md`.

## Character events

All other event types (hp_change, condition_add, spell_slot_use, etc.) require `payload.character` to be the character's UUID — the value of `id` in the character's materialized view frontmatter (`campaigns/<campaignId>/characters/<slug>.md`). Names are not unique; always use the UUID.

See the `type.description` field of the tool schema for the full list of character event types and their payload shapes.

## Example — combat sequence

```json
{ "type": "combat_start", "payload": {} }
{ "type": "monster_spawn", "payload": { "id": "goblin-1", "name": "Goblin", "hpMax": 7, "ac": 15, "initiativeBonus": 2 } }
{ "type": "initiative_set", "payload": { "order": [{ "actorId": "goblin-1", "initiative": 14 }, { "actorId": "<pc-uuid>", "initiative": 10 }] } }
{ "type": "turn_advance", "payload": {} }
{ "type": "monster_hp_change", "payload": { "id": "goblin-1", "delta": -5 } }
{ "type": "combat_end", "payload": {} }
```
