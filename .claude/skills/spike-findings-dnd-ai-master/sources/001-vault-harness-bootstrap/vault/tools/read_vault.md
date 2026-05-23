# Tool: read_vault

## Purpose
Read the full markdown content of a file in the vault.

## Schema
```json
{
  "name": "read_vault",
  "arguments": {
    "path": "string — absolute path within the vault, e.g. '/handbook/spells/fireball.md'"
  }
}
```

## Returns
The raw markdown content of the file, including YAML frontmatter.

## When to use
- Looking up a spell, monster, item, rule
- Reading a character sheet or session log
- Checking the current campaign index

## Example
Arguments: `{ "path": "/handbook/spells/fireball.md" }`
Returns: full markdown of the Fireball spell entry.

## Errors
- File not found → tool returns `ERROR: file not found`
- Path outside vault root → rejected
