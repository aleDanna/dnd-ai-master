# Storage and Mutation

The vault is a markdown filesystem. There is NO Postgres for knowledge or game state — only `ai_usage` telemetry stays in DB. The events.md append-only log is the source of truth; per-entity `.md` files are *materialized views* regenerated from events.

## Requirements

These are locked from spike work and cannot be changed without re-validation:

- **Storage = filesystem markdown only.** Obsidian-the-app is optional. No knowledge DB.
- **Static knowledge = path-deterministic.** `/handbook/<category>/<id>.md` (spells, monsters, items, rules, classes).
- **Dynamic knowledge = wiki-link traversal.** Campaigns entered via `/campaigns/<id>/index.md`.
- **Per-entity files use frontmatter+body.** Frontmatter = structured mutable state (hp, slot, conditions, inventory). Body = narrative/lore.
- **events.md is the source of truth.** Derived view files (e.g. `characters/aragorn.md`) are projections. On startup or DR, replay events.md → regenerate views.
- **Mutations go through `EventsWriter`** (single-writer mutex per campaign_id). NEVER do naive read-modify-write on a frontmatter field — spike 006 measured 99/100 lost updates under contention.

## How to Build It

### Vault layout (canonical)

```
/vault
  /handbook/
    /spells/<spell-id>.md           # frontmatter: level, school, classes, casting_time, range, duration
    /monsters/<monster-id>.md       # frontmatter: type, cr, ac, hp, speed
    /items/<item-id>.md
    /rules/<topic>.md
    /classes/<class>.md
    index.md                        # TOC, fits in system prompt context
  /campaigns/<campaign-id>/
    index.md                        # entry point: status, party, current session
    campaign.md                     # frontmatter: tonal_frame, premise, language
    events.md                       # append-only mutation log — SOURCE OF TRUTH
    characters/<name>.md            # MATERIALIZED VIEW — frontmatter regenerated from events
    sessions/<n>.md                 # session log, frontmatter: date, scene, status
    world/<location-id>.md
  /tools/
    index.md                        # compact tool list, read once per session
    <tool-name>.md                  # full schema, examples (optional lookup)
```

Concrete sample exists in `sources/001-vault-harness-bootstrap/vault/`.

### EventsWriter — the single-writer mutex (validated by spike 010)

100 concurrent appends → 0 lost, 0 corrupted, 0 duplicated. Pattern (in `sources/010-events-md-concurrency/writer.ts`):

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class EventsWriter {
  private static queues = new Map<string, Promise<void>>();

  static async append(path: string, line: string): Promise<void> {
    const previous = EventsWriter.queues.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    EventsWriter.queues.set(path, next);
    try {
      await previous;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line.endsWith("\n") ? line : line + "\n", "utf8");
    } finally {
      release();
      if (EventsWriter.queues.get(path) === next) {
        EventsWriter.queues.delete(path);
      }
    }
  }

  static async applyEvent(path: string, event: object): Promise<void> {
    await EventsWriter.append(path, JSON.stringify(event));
  }
}
```

Multi-process: this in-process mutex is sufficient for the single-Next.js-server deployment of dnd-ai-master. For multi-process, swap to `flock(2)` or a separate writer daemon.

### Event replay → materialized view (validated by spike 008)

`structuredClone` for state immutability, JSON.parse per line for events. Pattern:

```ts
function applyEvent(state, event) {
  const next = structuredClone(state);
  switch (event.type) {
    case "hp_change":
      next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + event.payload.delta));
      return next;
    case "condition_add":
      if (!next.conditions.includes(event.payload.condition)) next.conditions.push(event.payload.condition);
      return next;
    // ...
  }
}

const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(l => JSON.parse(l));
const state = events.reduce(applyEvent, INITIAL);
await writeFile(viewPath, serializeView(state), "utf8");
```

Full implementation in `sources/008-events-md-replay/replay.ts`.

### Disaster recovery (validated by spike 013)

DR procedure = git + replay. Validated byte-exact restore:

1. Vault is a git repo. `git commit` after every event append (or batched every N events).
2. Corrupted derived view? `git checkout` the events.md OR re-replay from current events.md.
3. Validated: corrupting `characters/aragorn.md` then `restore = cp events.md from backup + replay → derived view byte-for-byte matches original`.

No `pg_dump`, no migration tooling. Just `git push origin main` from M4.

## What to Avoid

### ✗ Naive read-modify-write on frontmatter (INVALIDATED by spike 006)

The instinct is "atomic rename(2) over a tmp file makes mutations safe." It does NOT. Spike 006 ran 100 concurrent `patchFrontmatter()` calls on the same file with rename(2) atomicity → **99/100 lost updates, 99% loss rate**. Every worker reads counter=0, increments to 1, renames; last writer wins, all increments are lost.

**This pattern is poison:** ❌
```ts
async function patchFrontmatter(path, patch) {
  const raw = await readFile(path);
  const parsed = parseMarkdown(raw);
  parsed.frontmatter = patch(parsed.frontmatter);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serialize(parsed));
  await rename(tmp, path);  // atomic but read-modify-write is racy!
}
```

**Correct pattern:** ✓ never mutate views directly. Append the event, then regenerate the view from events.md replay.

### ✗ Skipping the EventsWriter mutex "because we're single-agent"

The single-agent invariant is enforced at the API layer (`/api/sessions/:id/turn` mutex per campaign_id). But the EventsWriter mutex protects you when:
- API mutex bugs out (e.g. two requests slip through during deploy)
- A future feature wants to apply events from background jobs (auto-save, scheduled NPC actions)
- Tests run mutations in parallel

It's 30 lines of code. Always use it.

### ✗ Writing materialized views from outside the projector

Anyone (a tool call, a script, the UI) writing directly to `characters/aragorn.md` outside the events → projector flow will create state that doesn't survive a replay. The file IS the projector's output; treat it as read-only from everywhere else.

## Constraints

- **POSIX `rename(2)`** is atomic on the same filesystem. macOS APFS = same filesystem for vault contents → safe.
- **In-process mutex** scales to single Node process. Multi-process needs flock or a writer daemon.
- **events.md is monotonically growing.** No truncation in MVP. For long campaigns (months), implement snapshot+compact later — replay 50K events at session start gets noticeable around ~10K events.
- **JSON.parse on every event line.** ~100 events: <5ms. ~10K events: ~50ms (acceptable). ~100K events: ~500ms (compact required).
- **Corrupt event line halts replay.** Validated by spike 008 — `JSON.parse` throws on malformed line, replay must surface the error. Do NOT swallow it.

## Origin

Synthesized from spikes: 001, 006 (INVALIDATED, design pivoted), 008, 010, 013

Source files available in:
- `sources/001-vault-harness-bootstrap/` — canonical vault layout
- `sources/006-frontmatter-atomicity/` — the failed pattern preserved as cautionary tale
- `sources/008-events-md-replay/` — projector pattern
- `sources/010-events-md-concurrency/` — EventsWriter implementation
- `sources/013-vault-backup-restore/` — DR procedure
