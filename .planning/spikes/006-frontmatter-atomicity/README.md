---
spike: 006
name: frontmatter-atomicity
type: standard
validates: "Given 100 concurrent patch_frontmatter calls on the same file via rename(2), when stress-tested, then 0 corrupted YAML files AND 0 lost updates"
verdict: INVALIDATED
related: [008]
tags: [r3, r4, mitigation, mutation, hard-finding]
---

# Spike 006: frontmatter-atomicity

## What This Validates

R3 + R4 mitigation gate: is `rename(2)`-based atomic write sufficient to safely mutate frontmatter under concurrent access? The design assumed "atomic single-file mutation: `patch_frontmatter(path, updates)` does read-modify-write with POSIX `rename(2)` for atomicity."

## How to Run

```bash
pnpm exec tsx .planning/spikes/006-frontmatter-atomicity/stress.ts
# Override sample size:
STRESS_N=500 pnpm exec tsx .planning/spikes/006-frontmatter-atomicity/stress.ts
```

100 (default) parallel `Promise`s each call `patchFrontmatter(file, c => ({...c, counter: c.counter+1}))`. Verifies after: counter value, YAML validity, body preservation.

## Results

**Verdict: INVALIDATED**

```
counter final value: 1 (expected: 100)
lost updates: 99
YAML still valid: ✓ YES
body preserved: ✓ YES
99 LOST UPDATES (99.0%) — naive read-modify-write is NOT safe under contention.
```

### What rename(2) actually guarantees

`rename(2)` is atomic *at the filesystem layer*: a reader will see either the old file or the new file, never a torn write. That's why YAML stayed valid and the body was preserved — no file corruption.

What it does NOT guarantee: read-modify-write isolation. All 100 workers:

1. Read the same initial state (`counter: 0`)
2. Mutate locally to `counter: 1`
3. Write to a tmp file
4. Rename to target

The last `rename` wins. The other 99 also "succeeded" (rename returned without error) but their state was clobbered. **Lost updates: 99 out of 100.**

This is the *same failure mode* documented in [Stop Using Markdown For Memory](https://stopusingmarkdownformemory.com/). The literature was right.

## Investigation Trail

### Iteration 1 — Naive concurrent patch (V1)

Result: catastrophic. 99% lost updates in 16 ms.

### Iteration 2 — Mitigation options (not run, sketched)

Three options to make this safe:

1. **In-process mutex per file path.** Cheap (no syscall), but only works in a single Node process. Multi-process (multiple `tsx` runners or a clustered server) bypass it.

2. **File-based lock via `proper-lockfile` or `flock(2)`.** Cross-process safe. Adds ~1-5 ms per write. Risk: stale locks if a process crashes mid-write.

3. **Single-writer queue with append-only log (event sourcing).** All mutations append to `events.md`, single writer per `campaign_id` processes the queue, derived state files are materialized views. **This is the same pattern spike 008 validated.** Fundamentally avoids contention because the only file being written by N producers is the events log, and `O_APPEND` is atomic for small writes (< 4 KB on POSIX).

## Decision-grade implications

**The design must drop the "atomic patch_frontmatter via rename(2)" primitive.** It does not provide the safety it claims under any plausible failure mode where two writers exist simultaneously.

**Recommended replacement:** events.md as single-writer log + frontmatter files as materialized views.

This *also* solves:
- R3 (cross-file consistency loss) — all mutations are in one append-only stream
- R4 (concurrent-write corruption) — only one writer per stream
- R5 (correction-blindness) — corrections become events, replayed in order
- R7 (DR / backup) — events.md is the entire history; replay rebuilds derived state

The mutation model becomes more sophisticated, but it solves four risks at once instead of one. **Spike 008 confirms the replay side works.**

## Signal for the real build

- **Do not use `patch_frontmatter(path, updates)` as a public mutation primitive.** Remove from the tool surface.
- **Replace with `apply_event({type, payload})` that appends to `events.md`.** A single-writer projector materializes frontmatter views.
- **Single-writer-per-campaign invariant** enforced at the API layer (Next.js route handler), idempotent retry logic on event_id.
- Materialized frontmatter files become *read-only* from the LLM's perspective. The LLM never writes to them directly.
- Backup strategy collapses to "git the vault, especially events.md is non-throwaway".

## Limitations of this measurement

- N=100 is more aggressive than realistic single-user load. But a single LLM tool-call that mutates 3 fields atomically already exhibits the race window if the harness has any internal concurrency. The 99% rate at N=100 will degrade gracefully but never disappear.
- Tested on macOS APFS. ext4 / NTFS / FAT may have different atomicity guarantees on rename(), but the lost-update issue is *application-level* and HW-agnostic.
- Did not test mitigation #1 or #2. Future spike: implement events-md writer queue and re-stress.
