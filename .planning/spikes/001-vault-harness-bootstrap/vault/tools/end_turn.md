# Tool: end_turn

## Purpose
Conclude your turn and deliver your final narrative response to the player. After calling this, the turn ends.

## Schema
```json
{
  "name": "end_turn",
  "arguments": {
    "response": "string — your narrative or answer for the player. Markdown allowed."
  }
}
```

## Returns
Nothing — this terminates the turn.

## When to use
After you have gathered all necessary information from the vault and are ready to respond.

## Example
Arguments: `{ "response": "Fireball at 5th-level slot deals 10d6 fire damage (8d6 base + 2d6 for slot upcasting)." }`
