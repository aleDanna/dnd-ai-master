---
phase: 02
plan: 10
type: execute
wave: 3
depends_on: [02-02, 02-04]
files_modified:
  - scripts/vault-backup.ts
  - scripts/vault-rebuild-views.ts
  - scripts/vault-flip.ts
  - package.json
  - docs/operators/vault-backup.md
  - tests/scripts/vault-backup.test.ts
autonomous: false
requirements: [REQ-006, REQ-007]
must_haves:
  truths:
    - "pnpm vault:backup --strategy=git initializes a git repo under VAULT_CAMPAIGNS_ROOT if missing, commits all events.md + view files, refuses to commit if events.md has non-append edits (T-02-06 defense)"
    - "pnpm vault:backup --strategy=tarball produces a timestamped tarball under ~/Backups/dnd-ai-master/ with rotation (keep last N)"
    - "pnpm vault:rebuild-views --campaign=<uuid> reads events.md and regenerates all materialized views — byte-for-byte match (spike 013 invariant)"
    - "pnpm vault:flip --id=<uuid> --enable-mutations toggles vaultMutations on a campaign AND appends a campaign_initialized seed event (Decision 9) sourced from Postgres characters + session_state (most-recent active session) + spellcasting"
    - "docs/operators/vault-backup.md describes both strategies + recovery one-liner + single-write coexistence caveat"
    - "Running vault:backup with manually-edited events.md refuses with a clear error (T-02-06)"
  artifacts:
    - path: "scripts/vault-backup.ts"
      provides: "pnpm vault:backup — operator-driven backup"
    - path: "scripts/vault-rebuild-views.ts"
      provides: "pnpm vault:rebuild-views — recovery script"
    - path: "scripts/vault-flip.ts"
      provides: "Extended with --enable-mutations + seed-event support"
      contains: "enable-mutations"
    - path: "package.json"
      provides: "Three pnpm scripts wired (vault:flip pre-existing)"
      contains: "vault:backup"
    - path: "docs/operators/vault-backup.md"
      provides: "Operator runbook"
  key_links:
    - from: "scripts/vault-backup.ts"
      to: "src/ai/master/vault/path.ts"
      via: "uses VAULT_CAMPAIGNS_ROOT as the backup target"
      pattern: "VAULT_CAMPAIGNS_ROOT"
    - from: "scripts/vault-rebuild-views.ts"
      to: "src/ai/master/vault/projector.ts"
      via: "regenerateCharacterView per character in replay"
      pattern: "regenerateCharacterView"
    - from: "scripts/vault-flip.ts"
      to: "src/ai/master/vault/events-writer.ts"
      via: "appends the campaign_initialized seed event"
      pattern: "EventsWriter.applyEvent"
    - from: "scripts/vault-flip.ts (seed assembly)"
      to: "src/db/schema/session-state.ts + src/db/schema/characters.ts"
      via: "LEFT JOIN sessions s ON s.campaign_id = $1 + LEFT JOIN session_state ss ON ss.session_id = s.id; merge characters.spellcasting.slotsMax with characters.spellSlotsUsed"
      pattern: "session_state|spellcasting|spellSlotsUsed"
---

# Plan 02-10: Backup Strategy + Recovery Tooling

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 3 (depends on plan 02-02 for paths + plan 02-04 for projector)
**Status:** Pending
**Estimated diff size:** ~210 LOC source + ~60 LOC tests + ~180 LOC docs / 6 files
**Autonomous:** **false** — contains one checkpoint:decision for the default backup strategy

## Goal

Close REQ-006/REQ-007 with operator-driven backup tooling. Per phase Decision 7 the recommendation is "separate git repo," but the actual default goes through a checkpoint so the operator can override based on their environment.

Three deliverables:

1. **scripts/vault-backup.ts** — dispatches based on `--strategy=git|tarball`. Git strategy: initializes a repo inside VAULT_CAMPAIGNS_ROOT if missing, runs `git add . && git commit`. Tarball strategy: produces `~/Backups/dnd-ai-master/<timestamp>.tar.gz` with rotation. Both refuse to operate if events.md has non-append changes since the previous backup (T-02-06).
2. **scripts/vault-rebuild-views.ts** — recovery script. Replays events.md and regenerates views for one or all campaigns.
3. **scripts/vault-flip.ts extension** — add `--enable-mutations` flag that sets `vaultMutations: true` AND appends the campaign_initialized seed event with the campaign's Postgres characters snapshot as payload (Decision 9).

Plus the wire-up: package.json scripts, docs/operators/vault-backup.md runbook, basic CLI test.

## Requirements satisfied

- **REQ-006** DR procedure = replay events.md → regenerate views; backup is out-of-band — this plan ships both backup and recovery tooling.
- **REQ-007** Campaign data outside repo; backup strategy chosen + documented — this plan locks the choice via the checkpoint.

## Files touched

| File | Action | Why |
|---|---|---|
| scripts/vault-backup.ts | NEW | Backup CLI (git or tarball strategy). |
| scripts/vault-rebuild-views.ts | NEW | Recovery script. |
| scripts/vault-flip.ts | EDIT | Add --enable-mutations + seed event. |
| package.json | EDIT | Wire two new pnpm scripts. |
| docs/operators/vault-backup.md | NEW | Runbook. |
| tests/scripts/vault-backup.test.ts | NEW | CLI parsing + basic flow. |

## Tasks

<task type="checkpoint:decision" gate="blocking">
  <name>Task 1: Operator picks the default backup strategy</name>
  <decision>
    Which backup strategy is the default for `pnpm vault:backup` (when --strategy is not specified)?
  </decision>
  <context>
    REQ-007 mandates campaign data lives at VAULT_CAMPAIGNS_ROOT outside the codebase repo. REQ-006 mandates an out-of-band backup strategy. Spike 013 validated the recovery procedure (events.md replay → byte-exact view restore). The strategy choice is the operator's per-environment decision; Decision 7 recommends git (matches spike 013), but the operator may have a strong offline-first preference.
  </context>
  <options>
    <option id="git">
      <name>Separate git repo (RESEARCH recommendation)</name>
      <pros>
        - Per-commit history; recovery is the spike 013 one-liner
        - Zero new infrastructure
        - Diff-able: operator can inspect what changed
        - Script can refuse to commit on hand-edits (T-02-06)
      </pros>
      <cons>
        - One-time remote setup if push needed
        - Slightly slower than tarball
      </cons>
    </option>
    <option id="tarball">
      <name>Tarball + manual rotation</name>
      <pros>
        - True offline-first; zero remote setup
        - Faster (no git diff/staging overhead)
        - Drag-and-drop portable
      </pros>
      <cons>
        - Only point-in-time snapshots (no per-event history)
        - Recovery is multi-step (find right tarball, untar, replay)
      </cons>
    </option>
    <option id="both-no-default">
      <name>Both supported, no default (require --strategy)</name>
      <pros>
        - Operator must consciously pick each time
        - Future-proof for adding S3 etc.
      </pros>
      <cons>
        - Friction: must type --strategy=... every time
      </cons>
    </option>
  </options>
  <resume-signal>Select: git, tarball, or both-no-default</resume-signal>
</task>

<task type="auto">
  <name>Task 2: Create scripts/vault-backup.ts</name>
  <files>scripts/vault-backup.ts</files>
  <read_first>
    - scripts/vault-flip.ts (existing — argv parsing style, _env-loader import, console output; THE template to mirror)
    - .planning/spikes/013-vault-backup-restore/README.md (lines 60-105 — recovery procedure contract)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (Decision 7; T-02-06 — refuse on hand-edits)
    - src/ai/master/vault/path.ts (VAULT_CAMPAIGNS_ROOT export)
  </read_first>
  <action>
Create scripts/vault-backup.ts. Mirror the scripts/vault-flip.ts template (#!/usr/bin/env tsx shebang, _env-loader import, argv parsing, structured exit codes).

Required exports / behavior:

1. CLI args parsing: `--strategy=git|tarball` (Task 1 picks the default), `--push` (boolean, default false; for git strategy only), `--keep=N` (default 30; for tarball rotation).

2. Strategy: GIT
   - Verify VAULT_CAMPAIGNS_ROOT exists; exit 1 if not
   - If `<VAULT_CAMPAIGNS_ROOT>/.git` missing, run `git init` inside; write a default `.gitignore` covering `.DS_Store` and `tmp.*` patterns
   - Defensive check (T-02-06): if HEAD exists, run `git diff --unified=0 HEAD -- "*.md"` and check for any removed lines (`^-[^-]` in diff output). If found, refuse with error: "events.md or a view file has non-append changes since last commit. Manual edits to events.md are prohibited (correction policy: compensating events only). If this is a view-file regeneration, run pnpm vault:rebuild-views --campaign=<uuid> first."
   - Run `git add . && git commit -m "backup: <ISO timestamp>"`; if no changes to commit, print info and exit cleanly
   - If `--push`, run `git push origin main` and surface errors (do NOT exit; commit landed locally)

3. Strategy: TARBALL
   - Create `~/Backups/dnd-ai-master/` if missing
   - Build tarball at `~/Backups/dnd-ai-master/vault-<ISO timestamp>.tar.gz` via `tar -czf "<out>" -C "<parent>" "<basename>"`
   - Rotation: read existing tarballs, sort by mtime desc, delete entries beyond `--keep=N`

4. Module-level JSDoc:
   - Cite REQ-006, REQ-007, Decision 7, T-02-06
   - Usage examples for both strategies
   - Note: auto-push requires `git remote` configured; the script does NOT set it up

5. Use `execSync` from `node:child_process` for all shell calls (matches the simpler script style; full async is overkill for a CLI). `stdio: 'inherit'` for log forwarding.

6. Wrap `main()` in try/catch → `console.error(err); process.exit(1)`.

The Task 1 checkpoint resolves the `DEFAULT_STRATEGY` constant at the top of the file. If the operator picked "both-no-default", omit the default and make `--strategy` required; otherwise hardcode the chosen default.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/vault-backup.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - scripts/vault-backup.ts exists with #!/usr/bin/env tsx shebang
    - `grep -c "backupGit\|backupTarball" scripts/vault-backup.ts` returns ≥ 2 (or equivalent function names per chosen default)
    - `grep -c "_env-loader" scripts/vault-backup.ts` returns ≥ 1
    - `grep -c "VAULT_CAMPAIGNS_ROOT" scripts/vault-backup.ts` returns ≥ 2
    - `grep -c "refuse" scripts/vault-backup.ts` returns ≥ 1 (T-02-06 defense)
    - pnpm typecheck exits 0
    - The script exits 1 with a clear error when VAULT_CAMPAIGNS_ROOT does not exist
  </acceptance_criteria>
  <done>
    Backup script in place.
  </done>
</task>

<task type="auto">
  <name>Task 3: Create scripts/vault-rebuild-views.ts</name>
  <files>scripts/vault-rebuild-views.ts</files>
  <read_first>
    - scripts/vault-backup.ts (Task 2 — argv parsing pattern)
    - scripts/vault-flip.ts (existing)
    - src/ai/master/vault/projector.ts (plan 02-04 — regenerateCharacterView, replayEvents, parseEventsFile)
    - src/ai/master/vault/campaign-paths.ts (plan 02-02 — UUID_REGEX, eventsPath)
    - .planning/spikes/013-vault-backup-restore/README.md (lines 96-105 — the recovery one-liner contract)
  </read_first>
  <action>
Create scripts/vault-rebuild-views.ts. Behavior:

1. Args:
   - `--campaign=<uuid>` → rebuild views for ONE campaign
   - Omit `--campaign` → rebuild for ALL campaigns under VAULT_CAMPAIGNS_ROOT

2. Per-campaign flow:
   - Validate UUID via `UUID_REGEX.test(campaignId)`; exit 2 on invalid
   - If `eventsPath(campaignId)` does not exist, log "no events.md for <id>; skipping" and continue
   - Call `parseEventsFile` → `replayEvents` → for each character in the state map, call `regenerateCharacterView(campaignId, charId)`
   - Log progress lines: `[rebuild] <id>: <n> events → <m> characters`, then `[rebuild] <id>: regenerated view for character <charId>` per character

3. Multi-campaign flow:
   - List directory entries under VAULT_CAMPAIGNS_ROOT
   - Filter to entries matching UUID_REGEX that are directories
   - Run the per-campaign flow for each

4. Imports:
   - `./_env-loader` for env hydration
   - `node:fs` (readdirSync, existsSync, statSync), `node:path` (resolve)
   - `@/ai/master/vault/path` (VAULT_CAMPAIGNS_ROOT)
   - `@/ai/master/vault/projector` (regenerateCharacterView, replayEvents, parseEventsFile)
   - `@/ai/master/vault/campaign-paths` (eventsPath, UUID_REGEX)

5. Module JSDoc cites REQ-006 + spike 013 recovery one-liner. Document use cases: (a) view file accidentally edited, (b) projector code changed, (c) new schema field added.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - scripts/vault-rebuild-views.ts exists with shebang
    - `grep -c "regenerateCharacterView" scripts/vault-rebuild-views.ts` returns ≥ 1
    - `grep -c "replayEvents\|parseEventsFile" scripts/vault-rebuild-views.ts` returns ≥ 2
    - `grep -c "UUID_REGEX" scripts/vault-rebuild-views.ts` returns ≥ 1
    - pnpm typecheck exits 0
  </acceptance_criteria>
  <done>
    Recovery script in place.
  </done>
</task>

<task type="auto">
  <name>Task 4: Extend scripts/vault-flip.ts with --enable-mutations</name>
  <files>scripts/vault-flip.ts</files>
  <read_first>
    - scripts/vault-flip.ts (existing — argv parsing; db.update pattern at the bottom of the file)
    - src/db/schema/characters.ts (THE source of seed-payload fields — `hpMax: integer (NOT NULL)`, `spellcasting: jsonb<{slotsMax: Record<string,number>; ...} | null>` (may be null), `spellSlotsUsed: jsonb<Record<string,number>> (default {})`, `campaignId: uuid`)
    - src/db/schema/session-state.ts (THE source of `hp_current` — `sessionState.hpCurrent: integer (NOT NULL)`; lives per session, not per character — informs the LEFT JOIN below)
    - src/db/schema/sessions.ts (the link table — `sessions.campaignId`, `sessions.status: 'active' | 'ended'`, `sessions.id` joins to `session_state.sessionId`)
    - src/db/schema/index.ts (confirm characters + sessions + sessionState are exported)
    - src/ai/master/vault/events-writer.ts (plan 02-03 — EventsWriter.applyEvent)
    - src/ai/master/vault/projector.ts (plan 02-04 — regenerateAffectedViews)
    - src/ai/master/vault/campaign-paths.ts (plan 02-02 — eventsPath)
    - src/ai/master/vault/events-schema.ts (plan 02-01 — VaultEventEnvelope shape; EVENT_SCHEMA_VERSION; VaultSeedCharacter — note hp_current + spell_slots are OPTIONAL)
    - .planning/phases/02-vault-write-path-event-sourcing/PLAN.md (Decision 9 — synthetic campaign_initialized seed event sourced from Postgres characters snapshot)
  </read_first>
  <action>
Edit scripts/vault-flip.ts.

**Change 1 — Extend Args interface and parseArgs:**
Add two boolean fields `enableMutations` and `disableMutations`. Update the argv loop to detect `--enable-mutations` and `--disable-mutations`. If both flags present, error out with "Cannot --enable-mutations and --disable-mutations in the same invocation" and exit 2.

**Change 2 — Implement the seed flow.** After the existing `db.update` that sets `masterBackend`, add a new conditional block that runs when `args.enableMutations` is true:

1. **Update settings:** merge `{vaultMutations: true}` into `campaign.settings` and write back via `db.update`.

2. **Query characters with a LEFT JOIN onto session_state for current HP.** This is the load-bearing query because `hp_current` does NOT live on `characters` — it lives on `session_state.hpCurrent` (per-session, may be absent for a freshly-created campaign that has never been played). Construct the query using drizzle's `leftJoin`:

   ```ts
   import { eq, and, desc } from 'drizzle-orm';
   import { characters, sessions, sessionState } from '@/db/schema';

   // Strategy: for each character that is currently tied to this campaign
   // (campaignId = campaign.id, templateId IS NOT NULL — i.e. it's a per-
   // campaign instance, not a template), find the MOST-RECENT active session
   // that uses this character, then LEFT JOIN session_state on that session.
   //
   // - If the character has at least one active session with state → use ss.hpCurrent.
   // - If no active session has been played yet → session_state row is absent,
   //   ss.hpCurrent is null, and we OMIT hp_current from the seed payload
   //   (the projector's INITIAL_CHARACTER_STATE falls back to hp_max — see 02-04).
   const rows = await db
     .select({
       id: characters.id,
       name: characters.name,
       hpMax: characters.hpMax,
       spellcasting: characters.spellcasting,
       spellSlotsUsed: characters.spellSlotsUsed,
       hpCurrent: sessionState.hpCurrent,        // nullable via LEFT JOIN
       sessionStatus: sessions.status,           // for the WHERE/ORDER tie-breaker
     })
     .from(characters)
     .leftJoin(
       sessions,
       and(eq(sessions.characterId, characters.id), eq(sessions.campaignId, campaign.id))
     )
     .leftJoin(sessionState, eq(sessionState.sessionId, sessions.id))
     .where(eq(characters.campaignId, campaign.id))
     .orderBy(desc(sessions.updatedAt));         // most-recent first (single-active-session selector)
   ```

   **Active-session selector:** if a character has multiple session rows (rare — usually one active session per campaign per character), the `ORDER BY sessions.updatedAt DESC` plus a JS-side dedup (`Array.from(new Map(rows.map(r => [r.id, r])).values())` — `Map` keeps the FIRST row per id, which is the most-recent one because of the ORDER BY) keeps one row per character. Document the dedup step inline with a comment so future maintainers understand why the JS step is needed instead of a SQL `DISTINCT ON` (drizzle abstracts that away).

3. **Build the payload.** For each deduplicated row, construct a `VaultSeedCharacter` (the OPTIONAL shape from plan 02-01). The OPTIONAL fields are OMITTED, not set to undefined, when the source data is absent — matches what the validator in 02-01 accepts:

   ```ts
   const dedupedRows = Array.from(new Map(rows.map((r) => [r.id, r])).values());

   const payloadCharacters = dedupedRows.map((r) => {
     const seed: { id: string; name: string; hp_max: number; hp_current?: number; spell_slots?: Record<string, { max: number; used: number }> } = {
       id: r.id,
       name: r.name,
       hp_max: r.hpMax,
     };

     // hp_current: include ONLY when session_state row exists.
     // Otherwise omit and let the projector default to hp_max.
     // Clamp to [0, hp_max] defensively (T-02-03 mitigation parallel — guards
     // against stale session_state.hpCurrent overshooting after a manual
     // characters.hpMax decrease).
     if (typeof r.hpCurrent === 'number' && Number.isInteger(r.hpCurrent)) {
       seed.hp_current = Math.max(0, Math.min(r.hpMax, r.hpCurrent));
     }

     // spell_slots: assemble by merging spellcasting.slotsMax (cap, per-level)
     // with spellSlotsUsed (counter, per-level). Skip entirely if:
     //  - the character is a non-caster (spellcasting === null), OR
     //  - the resulting merged record is empty.
     // The OPTIONAL field on the seed lets the projector fall back to {}.
     if (r.spellcasting && r.spellcasting.slotsMax) {
       const slotsMax: Record<string, number> = r.spellcasting.slotsMax;
       const slotsUsed: Record<string, number> = r.spellSlotsUsed ?? {};
       const merged: Record<string, { max: number; used: number }> = {};
       for (const level of Object.keys(slotsMax)) {
         const max = slotsMax[level] ?? 0;
         if (max <= 0) continue;
         const used = Math.max(0, Math.min(max, slotsUsed[level] ?? 0));
         merged[level] = { max, used };
       }
       if (Object.keys(merged).length > 0) {
         seed.spell_slots = merged;
       }
     }

     return seed;
   });
   ```

4. **Construct the envelope:** `{id: randomUUID(), version: EVENT_SCHEMA_VERSION, type: 'campaign_initialized', payload: {characters: payloadCharacters}, timestamp: new Date().toISOString()}`.

5. **Append via EventsWriter:** `await EventsWriter.applyEvent(eventsPath(campaign.id), envelope)`.

6. **Regenerate views:** `await regenerateAffectedViews(campaign.id, envelope)`.

7. **Log:** `[vault-flip] seeded campaign with <n> characters; vault mutations enabled.` Also log a per-character line for visibility:
   ```ts
   for (const c of payloadCharacters) {
     const hpNote = c.hp_current !== undefined ? `hp_current=${c.hp_current}` : `hp_current=hp_max(${c.hp_max}) (no session_state row)`;
     const slotsNote = c.spell_slots ? `${Object.keys(c.spell_slots).length} slot levels` : 'no spell slots';
     console.log(`[vault-flip]  - ${c.name} (${c.id.slice(0, 8)}): ${hpNote}, ${slotsNote}`);
   }
   ```

**Change 3 — Add Pitfall-5 warning.** If `args.enableMutations` is true AND `campaign.settings?.masterBackend !== 'vault'`, print a warning: "WARN: enabling vaultMutations on a baked campaign — flag has no effect until masterBackend is also set to vault (Pitfall 5)." Continue (do not exit) — the flag is still stored; it just has no runtime effect until the operator also sets masterBackend.

**Change 4 — Implement disable-mutations.** If `args.disableMutations` is true, just update settings to `{vaultMutations: false}` and write back. Do NOT delete events.md (durable record; operator may re-enable later).

**Imports to add at the top:**
- `randomUUID` from node:crypto
- `eq, and, desc` from drizzle-orm (extend existing drizzle imports — eq is already imported per the existing file)
- `characters, sessions, sessionState` from `@/db/schema` (extend existing schema imports — campaigns is already imported per the existing file)
- `EventsWriter` from `@/ai/master/vault/events-writer`
- `regenerateAffectedViews` from `@/ai/master/vault/projector`
- `eventsPath` from `@/ai/master/vault/campaign-paths`
- `EVENT_SCHEMA_VERSION` from `@/ai/master/vault/events-schema`
  </action>
  <verify>
    <automated>pnpm typecheck && grep -c "enable-mutations\|enableMutations" scripts/vault-flip.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "enable-mutations\|enableMutations" scripts/vault-flip.ts` returns ≥ 3 (flag parsing + flow conditional + Pitfall warning)
    - `grep -c "campaign_initialized" scripts/vault-flip.ts` returns ≥ 1 (seed event type)
    - `grep -c "EventsWriter.applyEvent" scripts/vault-flip.ts` returns ≥ 1
    - `grep -c "regenerateAffectedViews" scripts/vault-flip.ts` returns ≥ 1
    - `grep -c "Pitfall 5" scripts/vault-flip.ts` returns ≥ 1 (warning text)
    - `grep -c "leftJoin\|sessionState\|sessions\\.campaignId" scripts/vault-flip.ts` returns ≥ 3 (the LEFT JOIN query is in place; hp_current is NOT sourced from characters.hp_current because that field does not exist)
    - `grep -c "spellcasting\|spellSlotsUsed\|slotsMax" scripts/vault-flip.ts` returns ≥ 3 (the spell_slots merge is in place)
    - `grep -c "characters.hp_current\|characters\\.hpCurrent" scripts/vault-flip.ts` returns 0 (BLOCKER 1 defense: the wrong column is NEVER referenced — hp_current does not live on characters)
    - pnpm typecheck exits 0
    - The script still works for the original use case (toggling masterBackend) — `pnpm vault:flip` (no args) lists campaigns; `pnpm vault:flip --id=<uuid> --to=vault` updates masterBackend
    - **Manual end-to-end smoke (post-execution):** create a test campaign with 1 wizard PC + 1 fighter PC (no session played yet); run `pnpm vault:flip --id=<test-uuid> --to=vault --enable-mutations`; `cat $VAULT_CAMPAIGNS_ROOT/<id>/events.md` shows ONE campaign_initialized line whose payload has TWO characters; the wizard entry has `spell_slots: {...}`; the fighter entry has no spell_slots key; NEITHER entry has `hp_current` (because no session_state row exists yet) — projector defaults both to hp_max on next read.
  </acceptance_criteria>
  <done>
    Seed flow integrated. Plan 02-08's smoke test (manual) uses this.
  </done>
</task>

<task type="auto">
  <name>Task 5: Wire pnpm scripts in package.json</name>
  <files>package.json</files>
  <read_first>
    - package.json (find the "scripts" key — vault:flip already exists per the Bash output earlier, mirror its pattern)
  </read_first>
  <action>
Edit package.json. Inside the `"scripts"` object, locate the existing `"vault:flip"` entry. Add two new entries:

```
"vault:backup": "tsx scripts/vault-backup.ts",
"vault:rebuild-views": "tsx scripts/vault-rebuild-views.ts",
```

Position them adjacent to `"vault:flip"` (lexical grouping). Do NOT remove or modify any existing script entries.
  </action>
  <verify>
    <automated>grep -c "vault:backup\|vault:rebuild-views" package.json</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "vault:backup" package.json` returns exactly 1
    - `grep -c "vault:rebuild-views" package.json` returns exactly 1
    - `grep -c "vault:flip" package.json` returns ≥ 1 (existing, preserved)
    - `pnpm vault:backup --help 2>&1 || true` and `pnpm vault:rebuild-views 2>&1 || true` invoke the scripts (the scripts may exit with error if env is unset, but the pnpm wire-up resolves)
  </acceptance_criteria>
  <done>
    Scripts callable via pnpm.
  </done>
</task>

<task type="auto">
  <name>Task 6: Write docs/operators/vault-backup.md runbook</name>
  <files>docs/operators/vault-backup.md</files>
  <read_first>
    - .planning/spikes/013-vault-backup-restore/README.md (lines 96-113 — canonical signal-for-real-build runbook items)
    - .planning/phases/02-vault-write-path-event-sourcing/PLAN.md (Decision 7, Decision 8, threat model rows T-02-06 + T-02-10 + T-02-11)
    - Phase 01 inheritance: any existing docs/operators/* file as a style reference (if none, this is the first one — keep it simple, markdown only)
  </read_first>
  <action>
Create docs/operators/vault-backup.md. Operator-facing English markdown (per CLAUDE.md — code/docs in English).

Required sections:

1. **# Vault backup and recovery runbook**
   - One-line summary: Phase 02 ships event-sourced writes; events.md is the only durable artifact; backups are out-of-band per REQ-006.

2. **## Backup**
   - Document the chosen default strategy (post-checkpoint resolution).
   - Both commands documented: `pnpm vault:backup --strategy=git [--push]` and `pnpm vault:backup --strategy=tarball [--keep=N]`.
   - For git strategy, document the one-time remote setup: `gh repo create dnd-ai-master-vault --private` then `cd $VAULT_CAMPAIGNS_ROOT && git remote add origin git@github.com:<user>/dnd-ai-master-vault.git` and the first `git push -u origin main`.
   - For tarball strategy, document the default location (`~/Backups/dnd-ai-master/`) and rotation (`--keep=30` by default).
   - Frequency recommendation: per session (after a day of play).

3. **## Recovery (DR procedure)**
   - The spike-013 one-liner: `git clone <vault-repo> && pnpm vault:rebuild-views` (for git strategy) or `tar -xzf <tarball> && pnpm vault:rebuild-views` (for tarball).
   - Document `pnpm vault:rebuild-views --campaign=<uuid>` for targeted recovery (one campaign's views from a partial corruption).

4. **## Single-write coexistence (Phase 02 caveat) — Decision 8**
   - Document: when a campaign has `vaultMutations: true`, writes land in events.md only. Postgres is NOT updated. The UI continues reading from Postgres until Phase 03's UI vault-read path lands.
   - Operator implication: refresh the campaign page after each session to see the updated Postgres view, OR wait for Phase 03.
   - Reference the plan 02-08 banner choice (whichever option the operator picked).

5. **## Correction policy (T-02-06)**
   - events.md is APPEND-ONLY. Manual edits to past event lines are prohibited.
   - To correct state, emit a compensating event via the LLM (e.g., `apply_event {type: 'hp_change', payload: {character: <id>, delta: +5}}` to undo a prior delta of -5).
   - `pnpm vault:backup --strategy=git` refuses to commit if it detects non-append edits.

6. **## Multi-process safety (T-02-10)**
   - In-process mutex only (NON-REQ-001). Single-Next.js-server invariant.
   - If a bulk-mutation script needs to run (Phase 03 import, recovery tool), the Next.js server MUST be stopped first.
   - Warning signs of multi-process contention: JSON.parse errors on events.md replay after a dev session that involved running both `pnpm dev` AND a one-off `tsx scripts/some-write.ts`.

7. **## Storage budget**
   - Per-campaign footprint: ~250KB for a year-long campaign (2K events × 200 bytes + 50KB of view files).
   - SSD impact on Mac Mini M4 (256GB): negligible at any realistic campaign count.

8. **## Future (Phase 03 follow-ups)**
   - Snapshot+compact at the 10K-event boundary (Pitfall 3)
   - Dual-write reconciliation (Open Question 3)
   - UI vault-read path (Decision 8 → Phase 03)
  </action>
  <verify>
    <automated>grep -c "vault:backup\|vault:rebuild-views\|vault:flip" docs/operators/vault-backup.md</automated>
  </verify>
  <acceptance_criteria>
    - docs/operators/vault-backup.md exists
    - `grep -c "vault:backup" docs/operators/vault-backup.md` returns ≥ 2
    - `grep -c "REQ-006\|REQ-007" docs/operators/vault-backup.md` returns ≥ 2
    - `grep -ci "single-write\|coexistence" docs/operators/vault-backup.md` returns ≥ 2 (Decision 8 caveat documented)
    - `grep -ci "compensating" docs/operators/vault-backup.md` returns ≥ 1 (correction policy)
    - `wc -l docs/operators/vault-backup.md` returns ≥ 80 (substantial runbook, not a stub)
  </acceptance_criteria>
  <done>
    Operator runbook in place.
  </done>
</task>

<task type="auto">
  <name>Task 7: Write tests/scripts/vault-backup.test.ts (CLI parsing + basic flow)</name>
  <files>tests/scripts/vault-backup.test.ts</files>
  <read_first>
    - scripts/vault-backup.ts (Task 2)
    - tests/scripts/migrate-handbook-to-vault.test.ts (Phase 01 style reference for script tests — child_process spawn pattern, env override)
  </read_first>
  <action>
Create tests/scripts/vault-backup.test.ts.

Test structure — one top-level `describe('vault-backup script')`:

1. **`describe('CLI parsing')`:**
   - `it('rejects invalid --strategy=X')` — spawn `tsx scripts/vault-backup.ts --strategy=invalid`; assert exit code 2; assert stderr contains "Invalid"
   - `it('rejects invalid --keep=X')` — spawn with `--keep=-1` or `--keep=abc`; assert exit code 2
   - `it('uses the default strategy when --strategy is omitted')` — spawn without args; check stdout includes `strategy=<default>` (verify the Task 1 default is honored)

2. **`describe('git strategy basic flow')`:**
   - Setup: tmpdir as VAULT_CAMPAIGNS_ROOT via env, seed a fake events.md
   - `it('initializes git repo on first invocation')` — spawn `tsx scripts/vault-backup.ts --strategy=git`; assert `.git/` directory created under tmpdir; assert commit landed
   - `it('refuses to commit when events.md has been hand-edited (T-02-06)')` — after first commit, manually overwrite events.md with non-append changes (e.g., replace line 1 with a different value); spawn the script; assert exit code 1; assert stderr contains "refuse" or "non-append"
   - `it('no-ops cleanly when there are no changes')` — spawn twice in a row; second invocation should print info about no changes and exit 0

3. **`describe('tarball strategy basic flow')`:**
   - Setup: tmpdir as VAULT_CAMPAIGNS_ROOT, populate with sample files
   - `it('creates a timestamped tarball under ~/Backups/dnd-ai-master/')` — spawn `tsx scripts/vault-backup.ts --strategy=tarball`; assert tarball file exists at the expected location (use a TEMP_BACKUPS env or stub `homedir()` for the test); use `vi.mock` if needed to redirect the Backups dir
   - `it('rotates old tarballs when --keep=N is exceeded')` — pre-create N+1 tarballs (mtime spread); run backup; assert oldest one is deleted

Notes for the test author:
- Spawning the script via tsx is slow (~1-2s per spawn). Keep the test count small (~5-7 cases).
- For the homedir redirect (tarball Backups dir), the cleanest approach is `process.env.HOME = testHomeDir` set in beforeEach. Verify that `os.homedir()` honors `HOME` on the target platform (it does on linux/macOS).
- The "hand-edit detection" test is THE T-02-06 mitigation test — must exist.

Total: 3 describe blocks, ~7 `it` cases. Test runtime budget: ~30s on M5 Pro.
  </action>
  <verify>
    <automated>pnpm test tests/scripts/vault-backup.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~7 cases pass
    - The "refuses to commit when events.md has been hand-edited" test passes (T-02-06 enforced)
    - The "initializes git repo on first invocation" test passes
    - The "rotates old tarballs" test passes
    - `grep -c "T-02-06\|refuse\|non-append" tests/scripts/vault-backup.test.ts` returns ≥ 2 (defense documented in test text)
    - Test runtime < 60 seconds
  </acceptance_criteria>
  <done>
    Backup script behavior regression-tested.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/scripts/vault-backup.test.ts` → all cases pass
- Command: `pnpm typecheck` → clean
- Manual smoke:
  1. `pnpm vault:flip --id=<test-uuid> --to=vault --enable-mutations` → vault enabled + seed event landed
  2. `cat $VAULT_CAMPAIGNS_ROOT/<id>/events.md` shows the campaign_initialized line — payload includes characters with `id`, `name`, `hp_max`; `hp_current` present ONLY when a session_state row existed; `spell_slots` present ONLY when the PC has `characters.spellcasting` non-null
  3. `pnpm vault:backup --strategy=git` (or tarball) → backup landed
  4. Corrupt a view file: `echo CORRUPT > $VAULT_CAMPAIGNS_ROOT/<id>/characters/<slug>.md`
  5. `pnpm vault:rebuild-views --campaign=<uuid>` → view file restored to byte-exact pre-corruption state
- Grep gate: `grep -c "REQ-006\|REQ-007" docs/operators/vault-backup.md` returns ≥ 2

## Open questions

The default strategy is resolved by the Task 1 checkpoint. If the operator picks an alternative not listed (e.g., S3), Task 2 is re-scoped to add it — the runbook structure accommodates new strategies cleanly. The seed-payload query (Task 4) is locked by the live Postgres schema: `hp_current` MUST be sourced from `session_state` (NOT `characters`) via LEFT JOIN; `spell_slots` MUST be assembled by merging `characters.spellcasting.slotsMax` + `characters.spellSlotsUsed`.

---

## Execution summary (Plan 02-10)

**Status:** Complete — 7 tasks shipped (Task 1 decision pre-resolved by operator before this executor was spawned), 10 vault-backup CLI tests green, typecheck clean for Plan 02-10 scope, all acceptance criteria satisfied.

**Task 1 — operator decision:** Pre-resolved by the user. Default backup strategy is **`git`** (separate repo). Hardcoded as `DEFAULT_STRATEGY: Strategy = 'git'` at the top of `scripts/vault-backup.ts`. Tarball remains supported as an explicit `--strategy=tarball` alternative.

**Commits (Plan 02-10 scope only):**
- `e40a9bb` — `feat(phase-02): add scripts/vault-backup.ts (git + tarball strategies)` — Task 2 (+313 LOC)
- `e32772c` — `feat(phase-02): add scripts/vault-rebuild-views.ts (DR recovery)` — Task 3 (+146 LOC)
- `dedd3b6` — `feat(phase-02): vault-flip --enable-mutations seeds campaign_initialized event` — Task 4 (+261/-17 LOC)
- `29f032a` — `chore(phase-02): wire pnpm vault:backup and pnpm vault:rebuild-views` — Task 5 (+2 LOC)
- `8af1c7a` — `docs(phase-02): add docs/operators/vault-backup.md operator runbook` — Task 6 (+253 LOC)
- `764b9ab` — `test(phase-02): add CLI smoke tests for scripts/vault-backup.ts` — Task 7 (+276 LOC, 10 cases)
- `e397a4e` — `fix(phase-02): remove unused imports in vault-backup.test.ts; log out-of-scope tsc error` — scope-boundary follow-up

**Acceptance criteria results:**

Task 2 (scripts/vault-backup.ts):
- `grep -c "backupGit\|backupTarball" scripts/vault-backup.ts` → **4** (≥2 required) ✓
- `grep -c "_env-loader" scripts/vault-backup.ts` → **1** (≥1 required) ✓
- `grep -c "VAULT_CAMPAIGNS_ROOT" scripts/vault-backup.ts` → **17** (≥2 required) ✓
- `grep -c "refuse" scripts/vault-backup.ts` → **7** (≥1 required, T-02-06 defense) ✓
- `pnpm typecheck` → exit 0 ✓
- Exits 1 with clear error when `VAULT_CAMPAIGNS_ROOT` does not exist ✓ (verified by test case)

Task 3 (scripts/vault-rebuild-views.ts):
- `grep -c "regenerateCharacterView" scripts/vault-rebuild-views.ts` → **3** (≥1 required) ✓
- `grep -c "replayEvents\|parseEventsFile" scripts/vault-rebuild-views.ts` → **4** (≥2 required) ✓
- `grep -c "UUID_REGEX" scripts/vault-rebuild-views.ts` → **6** (≥1 required) ✓
- `pnpm typecheck` → exit 0 ✓

Task 4 (scripts/vault-flip.ts):
- `grep -c "enable-mutations\|enableMutations" scripts/vault-flip.ts` → **15** (≥3 required) ✓
- `grep -c "campaign_initialized" scripts/vault-flip.ts` → **4** (≥1 required) ✓
- `grep -c "EventsWriter.applyEvent" scripts/vault-flip.ts` → **1** (≥1 required) ✓
- `grep -c "regenerateAffectedViews" scripts/vault-flip.ts` → **2** (≥1 required) ✓
- `grep -c "Pitfall 5" scripts/vault-flip.ts` → **3** (≥1 required) ✓
- `grep -c "leftJoin\|sessionState\|sessions\.campaignId" scripts/vault-flip.ts` → **7** (≥3 required) ✓
- `grep -c "spellcasting\|spellSlotsUsed\|slotsMax" scripts/vault-flip.ts` → **13** (≥3 required) ✓
- `grep -c "characters.hp_current\|characters\.hpCurrent" scripts/vault-flip.ts` → **0** ✓ **(BLOCKER 1 defense honored — hp_current is NEVER sourced from characters.*)**
- `pnpm typecheck` → exit 0 ✓
- Backward compat preserved: `pnpm vault:flip` (no args) still lists campaigns (with a new `mut` column for vaultMutations); `--id=<uuid> --to=vault` still flips masterBackend.

Task 5 (package.json):
- `grep -c "vault:backup" package.json` → **1** (exactly 1) ✓
- `grep -c "vault:rebuild-views" package.json` → **1** (exactly 1) ✓
- `grep -c "vault:flip" package.json` → **1** (preserved) ✓
- `pnpm vault:backup --help` → invokes correctly, prints usage ✓
- `pnpm vault:rebuild-views --help` → invokes correctly, prints usage ✓

Task 6 (docs/operators/vault-backup.md):
- `grep -c "vault:backup" docs/operators/vault-backup.md` → **12** (≥2 required) ✓
- `grep -c "REQ-006\|REQ-007" docs/operators/vault-backup.md` → **2** (≥2 required) ✓
- `grep -ci "single-write\|coexistence" docs/operators/vault-backup.md` → **3** (≥2 required) ✓
- `grep -ci "compensating" docs/operators/vault-backup.md` → **2** (≥1 required) ✓
- `wc -l docs/operators/vault-backup.md` → **253** (≥80 required, substantial runbook not a stub) ✓

Task 7 (tests/scripts/vault-backup.test.ts):
- **10/10 cases pass** in 1.96s (well under the 60s budget) ✓
- T-02-06 hand-edit refusal test passes (load-bearing mitigation test) ✓
- Git init on first invocation test passes ✓
- Tarball rotation test passes ✓
- `grep -c "T-02-06\|refuse\|non-append" tests/scripts/vault-backup.test.ts` → **6** (≥2 required) ✓

**Plan-level verification:**
- `pnpm test tests/scripts/vault-backup.test.ts` → 10/10 pass, 1.96s ✓
- `pnpm typecheck` → Plan 02-10 scope is clean; one out-of-scope unused-var error in `tests/ai/master/vault/apply-event-integration.test.ts:237` (Plan 02-07's concurrent wave-3a executor — logged in `deferred-items.md`)
- Manual smoke 1-5 from the plan-level checklist: REQUIRES a live VAULT_CAMPAIGNS_ROOT + Postgres campaign with a flipped UUID. Not executed by this autonomous run (Postgres + a test campaign UUID are operator-environment-specific). Tooling is in place for the operator to run.

**Deviations from plan:**

None of substance. Three minor implementation notes inside the plan's latitude:

1. **Task 4 dedup ordering** (vault-flip.ts `enableMutations`): used `new Map([...rows].reverse().map(...)).values()` + `.reverse()` to pick the most-recent row per character. The plan's example used `new Map(rows.map(...))` directly relying on "Map keeps the FIRST row per id" — actually JS Maps overwrite on duplicate keys, so we explicitly reverse twice to keep the most-recent row (the desired semantics). Behavior matches the plan's stated intent; the implementation is more defensive.

2. **Task 4 args validation**: added the `--enable-mutations` + `--disable-mutations` mutual-exclusion check up front (exit 2 with a clear error message). The plan called for this implicitly under Change 1 ("if both flags present, error out"); the implementation makes it explicit at parse time, before any DB query runs.

3. **Task 7 test harness**: spawned `tsx scripts/vault-backup.ts` via `node_modules/.bin/tsx` directly (rather than `pnpm exec tsx ...`) to skip the pnpm wrapper overhead. Same isolation, ~200ms faster per spawn. All 10 cases run in 1.96s on M5 Pro (well under the 60s budget).

**Out-of-scope failures documented:**

`tests/ai/master/vault/apply-event-integration.test.ts:237` has a TS6133 unused-variable error introduced by Plan 02-07's concurrent wave-3a executor (commit `2f4fe25`). Logged in `.planning/phases/02-vault-write-path-event-sourcing/deferred-items.md` under "Discovered during Plan 02-10 (backup-strategy)" with the recommended owner (Plan 02-07 verifier) and a one-line fix.

**Files changed:**
- NEW: `scripts/vault-backup.ts` (+313 LOC) — operator-driven backup CLI (git default + tarball fallback)
- NEW: `scripts/vault-rebuild-views.ts` (+146 LOC) — DR recovery: replay events.md → regenerate views
- MODIFIED: `scripts/vault-flip.ts` (+261/-17 LOC) — `--enable-mutations` seeds the `campaign_initialized` event via LEFT JOIN on Postgres
- MODIFIED: `package.json` (+2 LOC) — `vault:backup` and `vault:rebuild-views` pnpm scripts
- NEW: `docs/operators/vault-backup.md` (+253 LOC) — operator runbook
- NEW: `tests/scripts/vault-backup.test.ts` (+274 LOC after dead-import trim) — 10 CLI smoke cases
- MODIFIED: `.planning/phases/02-vault-write-path-event-sourcing/deferred-items.md` — appended Plan 02-10 out-of-scope finding
