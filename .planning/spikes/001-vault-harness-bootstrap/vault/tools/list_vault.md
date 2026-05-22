# Tool: list_vault

## Purpose
List the immediate children (files and subdirectories) of a vault directory.

## Schema
```json
{
  "name": "list_vault",
  "arguments": {
    "directory": "string — directory path within the vault, e.g. '/handbook/spells'"
  }
}
```

## Returns
A newline-separated list of entries. Directories end with `/`.

## When to use
- Discovering what spells exist in a category
- Browsing characters in the current campaign

## Example
Arguments: `{ "directory": "/handbook/spells" }`
Returns:
```
fireball.md
magic-missile.md
cure-wounds.md
```
