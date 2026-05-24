---
tool: read_vault_multi
---

# read_vault_multi

Read MANY markdown files in ONE call. Prefer this over multiple sequential reads.

## Schema

```json
{
  "name": "read_vault_multi",
  "arguments": {
    "paths": ["array of absolute vault paths, e.g. '/handbook/spells/fireball.md'"]
  }
}
```

## Example

```json
{ "paths": ["/handbook/spells/fireball.md", "/handbook/monsters/goblin.md"] }
```

Result is a single concatenated block per file, separated by `---`. Per-file errors (missing file, traversal attempt) appear inline so the batch never aborts.
