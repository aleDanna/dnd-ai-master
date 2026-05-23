---
spike: 013
name: vault-backup-restore
type: standard
validates: "Given a vault with derived views corrupted, when restoring via events.md replay + materialized view regeneration, then state matches pre-corruption byte-for-byte"
verdict: VALIDATED
related: [008, 010]
tags: [r7, dr, backup, event-sourcing]
---

# Spike 013: vault-backup-restore

## What This Validates

R7 mitigation gate: disaster recovery. The vault has two file types:
- **Source-of-truth:** `events.md` (append-only, derived from LLM mutations)
- **Derived views:** `character/<name>.md`, `session/<n>.md`, etc. (materialized projections)

If a derived view is corrupted (torn write, accidental edit, malware), can we restore it from `events.md` alone? This spike validates the recovery path end-to-end.

## How to Run

```bash
pnpm exec tsx .planning/spikes/013-vault-backup-restore/run-backup-restore.ts
```

Steps:
1. Build a vault: 5 events → derived `aragorn.md` view
2. Backup (cp -r as a stand-in for git commit / tar)
3. Corrupt the derived view (overwrite with garbage)
4. Restore: replay `events.md` → regenerate `aragorn.md`
5. Compare restored to backup byte-for-byte

## Results

**Verdict: VALIDATED**

```
▶ Step 1: build vault with 5 events + derived view
  Initial view: 62c15aa6e23fb3b64386cedacf604b245e07ca93

▶ Step 2: backup vault (simulating 'git commit')

▶ Step 3: corrupt the derived view
  Corrupted view: 722430ef4612aec8ecc7ef36955b3050e4c0949b

▶ Step 4: restore via events.md replay
  Restored view: 62c15aa6e23fb3b64386cedacf604b245e07ca93

▶ Step 5: compare restored to original backup
 Restored == backup: ✓ YES
 Detail: byte-for-byte match

✓ DR procedure works: events.md is sufficient source of truth.
  git repo of vault + events.md = full disaster recovery.
```

### Why this works

The derived views are *pure projections* of events.md. Same events + same projector + same initial state → same view, every time. This is the fundamental property of event sourcing.

The implication: **you don't actually need to back up derived views.** `events.md` + the projector code (in git) is enough. Derived views are regenerable.

For the dnd-ai-master scope, this collapses backup to:
- `git commit` after every event (or batched every N events)
- `git push` to a remote (private GitHub, local mirror, S3)
- Recovery = `git clone` + run replay script

No `pg_dump`, no binary backup format, no migration risk. Plain text + git.

## Investigation Trail

### Iteration 1 — Happy path restore

5 events, corruption simulation, restore. Byte-for-byte match. Pass.

### Iteration 2 — Test with corrupted events.md (not run)

Worth doing: corrupt one event line in `events.md` (vs corrupting a derived view). The replay should fail-fast with a JSON parse error (spike 008 already validated this). DR then becomes: restore `events.md` from git, replay, regenerate views.

### Iteration 3 — Partial corruption (not run)

What if half the derived views are corrupted but events.md is intact? Replay can selectively regenerate the broken views. Implementation: enumerate expected views from event types, compare to filesystem, regenerate missing/different ones.

## Decision-grade implications

The DR story for the vault migration is dramatically simpler than for the current Postgres-based setup:

| Aspect | Postgres | Vault |
|---|---|---|
| Backup format | binary dump | plain text (markdown + JSON) |
| Backup tool | `pg_dump` | `git push` |
| Versioning | manual (per-dump) | implicit (per-commit) |
| Recovery time | restore + replay | clone + replay |
| Cross-machine sync | manual | `git pull` |
| Recovery test | rare (people skip it) | runs as a unit test |

This is a *side benefit* of the migration, not a primary driver, but it's substantial. The vault format gives you 80% of the DR rigor of an enterprise database for 0% of the operational cost.

## Signal for the real build

- **Make the vault a git repository** at the source-of-truth level. Commit-on-event-batch (e.g. every 10 events or every minute).
- **The DR procedure is a documented one-liner**: `git clone <vault-repo> && tsx scripts/rebuild-views.ts`
- **Include rebuild-views.ts as the only-supported recovery mechanism.** Do not let users hand-edit derived views; treat them as ephemeral.
- **Schedule periodic DR tests in CI.** Take a known-good vault snapshot, corrupt a view, restore, assert match. Catches regressions in the projector code.

## Limitations of this measurement

- 5 events is trivial. A 10,000-event vault replay would take ~100 ms (linear, validated in spike 008 numbers).
- `cp -r` is a stand-in for git. Real git adds metadata (commit hashes, refs) but doesn't affect the restore correctness.
- Single character view tested. Real DR would regenerate all derived views — needs a `rebuild-all-views()` function as Phase 1 deliverable.
- Did not test cross-machine restore (clone from a remote). Trivial extension.
