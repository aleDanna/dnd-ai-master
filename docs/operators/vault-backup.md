# Vault backup and recovery runbook

Phase 02 (vault-llm-wiki) ships an event-sourced write path. `events.md`
is the only durable artifact per campaign; every materialized character
view under `<campaign>/characters/` is a pure projection of the event log.
Backups are out-of-band per **REQ-006**; campaign data lives at
`VAULT_CAMPAIGNS_ROOT` outside the codebase repo per **REQ-007**.

This document is the operator-facing runbook for the three vault scripts
shipped in Phase 02 plan 02-10:

- `pnpm vault:backup`         — operator-driven backup (git or tarball)
- `pnpm vault:rebuild-views`  — disaster-recovery view regeneration
- `pnpm vault:flip`           — toggle a campaign onto the vault backend
                                and enable event-sourced mutations

---

## Backup

### Default strategy — `git` (separate repo)

The operator-locked default is **GIT** (separate, private repo inside
`VAULT_CAMPAIGNS_ROOT`). Matches the spike 013 DR validation byte-for-byte;
recovery is the documented one-liner; the script provides T-02-06 defense
against hand-edits.

```
pnpm vault:backup                       # commit current state to the local repo
pnpm vault:backup --strategy=git --push # commit + push to origin/main
```

#### One-time remote setup (optional, enables `--push`)

```
gh repo create dnd-ai-master-vault --private
cd "$VAULT_CAMPAIGNS_ROOT"
git remote add origin git@github.com:<user>/dnd-ai-master-vault.git
git push -u origin main
```

The first `pnpm vault:backup` run initializes a local repo with a sensible
`.gitignore` (`.DS_Store`, `tmp.*`, `*.tmp`). After remote setup, `--push`
forwards every commit; push failures do NOT abort the script — the commit
landed locally and can be retried manually.

### Offline-first fallback — `tarball`

When a remote git repo is impractical (air-gapped install, sneakernet
sync), the tarball strategy produces drag-and-drop portable archives:

```
pnpm vault:backup --strategy=tarball              # default rotation: keep last 30
pnpm vault:backup --strategy=tarball --keep=10    # keep last 10
```

Output:
- Default location: `~/Backups/dnd-ai-master/vault-<ISO timestamp>.tar.gz`
- Rotation: deletes oldest tarballs once `--keep=N` is exceeded
- Contents: the entire `VAULT_CAMPAIGNS_ROOT` tree (including `.git/` when present)

### Frequency recommendation

Run `pnpm vault:backup` **after each play session** (end of day). For
campaigns with multiple sessions per day, run after each session ends. The
script is idempotent (no-op when there are no changes) so over-backup is
harmless.

---

## Recovery (DR procedure)

The full DR procedure (spike 013 — VALIDATED) is a documented one-liner.

### From the git remote

```
git clone git@github.com:<user>/dnd-ai-master-vault.git "$VAULT_CAMPAIGNS_ROOT"
pnpm vault:rebuild-views
```

### From a tarball

```
tar -xzf ~/Backups/dnd-ai-master/vault-<timestamp>.tar.gz -C "$HOME"
# (or wherever VAULT_CAMPAIGNS_ROOT resolves)
pnpm vault:rebuild-views
```

### Partial recovery (one campaign's views)

If a single campaign's view files were accidentally edited or corrupted
(but `events.md` is intact), recover just that campaign:

```
pnpm vault:rebuild-views --campaign=<campaign-uuid>
```

The script replays `events.md` and regenerates every materialized
character view under `characters/`. Output is byte-stable per the projector
contract (spike 013 invariant: corrupt → replay → byte-for-byte match).

### Why this works

`events.md` is the source of truth; the views are pure projections. Same
events + same projector + same initial state → same view, every time. You
do not need to back up derived views — `events.md` + the projector code
(in git) is enough.

---

## Single-write coexistence — Phase 02 caveat (Decision 8)

**Important Phase 02 behavior:** when a campaign has `vaultMutations: true`,
the LLM's `apply_event` tool writes ONLY to `events.md`. Postgres
(`session_state`, `characters`) is **NOT** updated for that campaign in
Phase 02.

The UI continues reading from Postgres until Phase 03 ships the UI
vault-read path. This means **the UI shows stale state** for any
mutation-enabled campaign until you refresh / restart the session that
re-loads from the Postgres baseline.

**Operator implication:**

- **Test cohort only** for Phase 02 — opt in one or two campaigns you own
  to validate the vault write path end-to-end. Do NOT enable for
  production / shared campaigns yet.
- Refresh the campaign page after each session to see the updated
  Postgres view (the master will have written to `events.md` but the UI
  still pulls from Postgres).
- Phase 03 resolves this: dual-write reconciliation + UI reads from
  materialized views.

The single-write coexistence is the explicit Phase 02 scope. Phase 03
owns the read-path migration and dual-write reconciliation.

---

## Correction policy (T-02-06)

`events.md` is **APPEND-ONLY**. Manual edits to past event lines are
**prohibited**.

If a past event was wrong (LLM hallucinated, operator typo, etc.), the
correction policy is to emit a **compensating event** via the LLM tool
surface. Example: if a `hp_change {delta: -5}` was wrong, the LLM appends
`hp_change {delta: +5}` later in the log. The reducer applies both
deterministically; replay reflects the net state.

**Defense in script:** `pnpm vault:backup --strategy=git` refuses to
commit when it detects non-append edits to any `.md` file (events.md or a
view file). The error message tells the operator to either:

- Revert the manual edit (`git checkout -- events.md`), OR
- Run `pnpm vault:rebuild-views --campaign=<uuid>` to regenerate view
  files (if the edit was to a view, not events.md).

The script CANNOT detect tampering in a freshly-cloned repo with no HEAD
yet. The defense kicks in from the second commit onward.

---

## Multi-process safety (T-02-10)

The Phase 02 `EventsWriter` mutex is **in-process only** (NON-REQ-001:
single-Next.js-server invariant). Two Node processes writing the same
`events.md` hold separate mutex queues and corrupt each other.

**Operational rule:** any bulk-mutation script (Phase 03 import,
recovery tool, ad-hoc `tsx scripts/<something>.ts` that writes to
events.md) MUST run with the Next.js server stopped.

**Warning signs of multi-process contention:**

- `JSON.parse` errors during replay on lines you do not recognize
- Truncated event payload (line ends mid-string)
- Two events with the same `id` (the dispatcher allocates a fresh
  `randomUUID()` per call; duplicates indicate a write race)

**Recovery from contention:** revert `events.md` to the last good commit
(`git log -- events.md` to find it), replay, validate.

---

## Storage budget

Per-campaign footprint (linear in event count):

- ~200 bytes per event (envelope + payload)
- ~500 bytes per character view file
- A year-long campaign with ~2K events + 4 PCs → **~400 KB per campaign**
- 50 campaigns → **~20 MB total**

SSD impact on Mac Mini M4 (256 GB) — negligible at any realistic campaign
count. Backup repo growth is similarly modest: 50 campaigns × 20 commits
per campaign per year ≈ a few MB pack file.

---

## Threat model coverage

Phase 02 plan 02-10 maps the following threat-model entries to script
behavior:

| Threat | Mitigation in this runbook |
|---|---|
| T-02-06 (manual events.md edits) | Refuse to commit on non-append edits; correction = compensating events |
| T-02-10 (multi-process race) | Single-Next.js-server invariant; bulk scripts run with server stopped |
| T-02-11 (backup repo corruption) | `git push` without `--force`; refuse on dirty working tree; `git reflog` recovery |

`git reflog` is the catch-all if a `git push --force` from outside the
script ever rewrites history: every commit stays in the reflog for 90
days by default; `git reset --hard <reflog-sha>` brings back the lost
state.

---

## Future (Phase 03 follow-ups)

Tracked as Phase 03 deliverables; out of scope for Phase 02:

- **Snapshot + compact at the 10K-event boundary** (Pitfall 3). Replay
  performance at 10K events is ~100 ms (spike 008) — well within budget,
  but campaigns running for multiple years will benefit from rolling
  the prefix into a snapshot file.
- **Dual-write reconciliation** (Open Question 3). Postgres ↔ events.md
  synchronization so the UI vault-read path sees the same state the
  master writes.
- **UI vault-read path** (Decision 8). Replace the Postgres read path
  with materialized-view reads for mutation-enabled campaigns. Resolves
  the single-write coexistence caveat above.

---

## Quick reference

```
# Backup
pnpm vault:backup                              # git (default)
pnpm vault:backup --strategy=git --push        # git + push
pnpm vault:backup --strategy=tarball           # tarball fallback
pnpm vault:backup --strategy=tarball --keep=10 # tarball with rotation

# Recovery
pnpm vault:rebuild-views                       # all campaigns
pnpm vault:rebuild-views --campaign=<uuid>     # one campaign

# Phase 02 opt-in
pnpm vault:flip                                # list campaigns + flags
pnpm vault:flip --id=<uuid> --to=vault         # flip backend to vault
pnpm vault:flip --id=<uuid> --enable-mutations # enable event-sourced writes (seeds events.md)
```
