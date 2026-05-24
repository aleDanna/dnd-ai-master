---
tool: list_vault
---

# list_vault

List immediate children of a vault directory (one level — no recursive walk).

## Schema

```json
{
  "name": "list_vault",
  "arguments": { "directory": "absolute vault directory, e.g. '/handbook/spells'" }
}
```

## Example

`{ "directory": "/handbook/craft" }` → `Children of /handbook/craft:` followed by `- role.md`, `- combat.md`, …
