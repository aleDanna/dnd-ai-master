---
tool: end_turn
---

# end_turn

Conclude the turn with a final narrative response.

## Schema

```json
{
  "name": "end_turn",
  "arguments": { "response": "string — the final narrative for the player" }
}
```

## Alternative terminator

You may ALSO end the turn by returning normal content with no tool calls (`no_tool_calls + content`). Both forms are accepted by the server.
