---
phase: 10-server-authoritative-combat-and-tracker
reviewed: 2026-06-01T00:40:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/app/api/sessions/[id]/turn/encounter-opener.ts
  - src/app/api/sessions/[id]/turn/monster-bestiary.ts
  - src/app/api/sessions/[id]/turn/route.ts
  - tests/app/api/sessions/[id]/turn/empty-narration-notify.test.ts
  - tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts
  - tests/app/api/sessions/[id]/turn/encounter-opener.test.ts
  - tests/app/api/sessions/[id]/turn/monster-bestiary-statblock.test.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-06-01T00:40:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Phase 10 makes encounter openers server-authoritative. The three core invariants the
phase set out to protect are **sound**:

- **Path-traversal safety (T-10-04/06):** `getBestiaryStatblock` never builds an fs
  path from raw input — it routes through `slugify` + `readVaultFile` → `safeVaultPath`
  (null-byte, lexical-prefix, and symlink-escape guards all verified in `path.ts`). The
  traversal test (`'../../etc/passwd'` → `null`) passes and the design is correct.
- **REQ-047 (no damage on the opener turn):** `runEncounterOpener` returns exactly
  `[monster_spawn, initiative_set]` and emits no HP/damage event on any path; verified
  by both unit and wiring tests.
- **async→sync bestiary seam:** `route.ts` pre-awaits `getBestiaryStatblock` and injects
  a sync `() => stats` closure into the pure opener — correct, and the wiring test proves
  the real SRD goblin value (hpMax 7, ac 15) reaches `monster_spawn`.
- **Empty-narration notify guard (REQ-046):** the `combatStateChanged` XOR branch is
  correct and does not regress the existing turn-error UX (`{type:'state'}` is an
  already-established SSE event emitted by `emitStateRefresh` in `tools.ts`; the genuine
  non-combat empty case still emits `turn-error`).

The opener's event payloads were cross-checked against `events-schema.ts` (`validateEvent`)
and `projector.ts` (`encounterReducer`) and are shape-compatible: `monster_spawn` forwards
`cr` as a parsed number, `hpMax`/`ac` are integer-guarded, and `initiative_set.order`
entries carry integer initiatives. All 39 Phase-10 tests pass and `tsc --noEmit` is clean
on the reviewed files.

**However, the monster-name extraction step (`_extractMonsterName` in `route.ts`) has a
correctness defect that silently breaks the phase's headline goal (real SRD stats) in any
multiplayer session, and a second defect for English-language play.** These are not caught
by the test suite because the wiring test only exercises a single-PC snapshot with the
monster name passed in directly — it never drives `_extractMonsterName` with a party-mode
message.

## Critical Issues

### CR-01: `_extractMonsterName` extracts the PC's own name in party mode (silently defeats SRD lookup)

**File:** `src/app/api/sessions/[id]/turn/route.ts:317-319, 361-381`
**Issue:**
In party mode (`snap.party.length > 1`, set as `usePrefix` at `route.ts:296`), every
player message in `vaultHistory` is rewritten with a `[CharacterName]` author prefix
(`route.ts:303`). That prefixed string becomes `_playerMessage` (`route.ts:317-319`),
which is then passed verbatim to `_extractMonsterName(_playerMessage ?? '')`
(`route.ts:381`).

`_extractMonsterName` strips the punctuation class `[!?.,;:]` (`route.ts:366`) — which
does **not** include `[` or `]` — so the brackets survive verb/article stripping. The
capitalized-word matcher then locks onto the first capital letter, which is the **PC's
name inside the brackets**, not the monster. Verified at runtime:

```
"[Aria] attacco il goblin"            => "[Aria]"
"[Bryn] colpisco lo scheletro con la spada" => "[Bryn]"
```

Downstream: `getBestiaryStatblock("[Aria]")` → `slugify("[Aria]")` → `"aria"` (brackets
collapse to nothing; does NOT throw) → reads `handbook/monsters/aria.md` → not found →
`null` → opener falls back to the CR table for HP. The encounter then spawns a monster
literally **named `[Aria]`** with a generic CR-default HP instead of the real SRD monster.
This is the exact failure the BLOCKER-1 acceptance test was written to prevent (real SRD
hpMax, not a CR-default) — but the test only covers the single-PC path where `usePrefix`
is false, so the regression is invisible.

This corrupts `monster_spawn.payload.name` (player-facing combat tracker shows `[Aria]`)
and `hpMax` (wrong HP) for the common multiplayer case.

**Fix:** Strip the author prefix before extraction (and/or extract from the raw message
rather than the prefixed history entry). Minimal fix at the extractor:

```ts
const _extractMonsterName = (msg: string): string => {
  const cleaned = msg
    // Drop a leading "[Character Name] " author prefix added in party mode
    // (route.ts:303) so it is never mistaken for the monster name.
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/[!?.,;:]/g, ' ')
    // ...rest unchanged
```

Better still, capture the monster name from the *clean* player text rather than the
bracket-prefixed `vaultHistory` entry. Note the resolver path already learned this lesson
(it gates on the clean `_playerMessage` — but here `_playerMessage` is the prefixed
string, so the same precaution must be applied to the extractor input).

## Warnings

### WR-01: English article `the` is not stripped — English combat intent yields monster name `"the"`

**File:** `src/app/api/sessions/[id]/turn/route.ts:368`
**Issue:**
The verb/article strip list in `_extractMonsterName` includes Italian articles
(`il|lo|la|un|uno|una|i|gli|le|con|a|ad`) and English attack verbs (`attack\w*`,
`strik\w*`, …) but **not the English article `the`**. `detectCombatIntent` matches English
verbs (`attack\w*` etc., see `turn-directive.ts:79`), so an English-language campaign can
reach the opener with `"attack the goblin"`, which extracts `"the"`:

```
"attack the goblin" => "the"
```

`getBestiaryStatblock("the")` → `handbook/monsters/the.md` → not found → CR fallback, and
the monster spawns named `"the"`. Lower severity than CR-01 because the primary play
language is Italian (per project memory), but the opener gate explicitly fires on English
verbs, so this path is reachable.
**Fix:** Add English articles/determiners to the strip alternation, e.g.
`|the|a|an|that|this`, and consider stripping `with|on|at` to mirror the Italian `con`.

### WR-02: SRD `initiativeBonus` is read by neither the statblock reader nor the opener — monsters always roll 1d20+0

**File:** `src/app/api/sessions/[id]/turn/monster-bestiary.ts:206-222`, `src/app/api/sessions/[id]/turn/encounter-opener.ts:264-274`
**Issue:**
SRD frontmatter carries `initiativeBonus` (e.g. `goblin.md` has `initiativeBonus: 2`), and
both the events-schema (`monster_spawn.initiativeBonus?`) and projector support it. But
`getBestiaryStatblock` only parses `hpMax`/`ac`/`cr` (the `BestiaryStatblock` interface
omits `initiativeBonus`), and `runEncounterOpener` rolls the monster's initiative as plain
`roll1d20()` with no bonus. The goblin's +2 DEX initiative is silently dropped, so monster
initiative ordering is mechanically wrong vs. the SRD. The code comments
(`encounter-opener.ts:266-268`) acknowledge this as a deliberate "keep simple for now"
decision, which is why this is a Warning rather than a Blocker — but the data is present
on disk and the downstream schema already supports the field, so the simplification
discards real, available accuracy.
**Fix:** Parse `initiativeBonus` in `getBestiaryStatblock`, add it to `BestiaryStats`, and
add it to `roll1d20() + (stats.initiativeBonus ?? 0)` for the monster entry (PCs stay +0
per INFO-9). Forward it on `monster_spawn.payload.initiativeBonus` (already schema-valid).

### WR-03: Frontmatter parser silently rejects multi-document / multi-block markers and unquoted-empty values

**File:** `src/app/api/sessions/[id]/turn/monster-bestiary.ts:180-198, 207`
**Issue:**
Two edge cases in the inline YAML frontmatter scan:
1. The key/value regex `^(\w+):\s*(.+?)\s*$` (line 207) requires a **non-empty** value
   (`.+?`). A frontmatter line written as `cr:` or `cr: ` (key, empty value, no quotes)
   does not match and is skipped. This is benign for the current bestiary (the one empty
   CR, `awakened-shrub.md`, uses the quoted form `cr: ""` which yields `'""'` → stripped
   to `''` → later `parseCr('') === null` → cr omitted), but it is a latent
   parse-divergence from a real YAML reader.
2. The closing-`---` scan (lines 181-190) `break`s on the first closing delimiter and the
   "content before opening `---`" guard (line 192-195) returns `null`. A file whose first
   line is blank before `---`, or a `---` thematic break inside the body, is handled by the
   `opened`/`inFrontmatter` flags, but the parser is a hand-rolled subset and will diverge
   from `gray-matter`/real YAML on quoted multiline or list values. Given the reader is
   "return null on any miss", divergence degrades to a CR-fallback rather than a crash —
   acceptable, but fragile.
**Fix:** For (1), allow empty values (`(.*?)`) or document that empty-value lines are
intentionally skipped. For (2), prefer the existing project YAML/frontmatter parser if one
is already a dependency, to avoid maintaining a second divergent parser (note
`monster-bestiary.ts` itself flags isolation from `parseNamedBlocks` as deliberate, so a
shared util may be out of scope — at minimum add a test fixture for the unquoted/empty
cases).

### WR-04: Wiring test asserts production source via a brittle regex on `route.ts` text

**File:** `tests/app/api/sessions/[id]/turn/encounter-opener-wiring.test.ts:255-269`
**Issue:**
The "PRODUCTION route passes sessionId" test reads `route.ts` as a string and asserts
`routeSrc.toMatch(/dispatchVaultTool\('apply_event',\s*ev,\s*\{\s*campaignId:\s*campaign\.id,\s*sessionId\s*\}/)`.
This couples the test to exact source formatting and argument **ordering**: a harmless
refactor (reordering to `{ sessionId, campaignId: campaign.id }`, extracting the ctx into
a variable, or running Prettier with different spacing) breaks the test even though the
wiring is still correct. It also gives false confidence — it proves the *string* exists,
not that the dispatch is reachable on the opener branch. This is a test-reliability concern
(in-scope per the test-file exception): a brittle assertion that fails on valid refactors
trains reviewers to ignore it.
**Fix:** Either (a) drive the real route branch in a headless harness and assert
`emitStateRefresh`/`notifySession` was called with `sessionId`, or (b) downgrade this to a
non-blocking lint/grep check outside the unit suite. If kept as-is, make the regex tolerant
of key ordering and whitespace.

## Info

### IN-01: `enforceResolvedNarration` invoked with a triple-cast fake `ResolveCombatResult` on the monster path

**File:** `src/app/api/sessions/[id]/turn/route.ts:748-754`
**Issue:**
The monster-loop branch builds `{ kind:'resolved', events:[], narrationDirective, damageRequest:null } as unknown as ResolveCombatResult` to reuse only the strip logic. The
`as unknown as` double-cast defeats type checking — if `ResolveCombatResult`'s shape or
`enforceResolvedNarration`'s field reads change, this silently compiles. (Pre-existing from
Phase 09, not introduced here, but it sits in the reviewed diff region.)
**Fix:** Expose a dedicated `stripLeakedCombatProse(text)` helper, or make
`enforceResolvedNarration` accept a narrower "strip-only" option, so no fake object/cast is
needed.

### IN-02: `_extractMonsterName` fallbacks can produce non-monster nouns; lookup miss is the only safety net

**File:** `src/app/api/sessions/[id]/turn/route.ts:374-379`
**Issue:**
Even after CR-01/WR-01 are fixed, the heuristic returns the first capitalized word group or
first >1-char word, so messages like `attacco la guardia` → `"guardia"` (works, file
exists) but `attacco con rabbia` would extract `"rabbia"` (an emotion). The only thing
preventing a nonsense monster is the bestiary lookup returning null → CR fallback. This is
inherent to Option-B extraction (documented as a temporary seam to be replaced by Option-A
constrained-JSON), so it is informational — but worth a regression test asserting graceful
degradation (spawn proceeds, name is the extracted token, HP is the fallback) so the
Option-A swap has a baseline.
**Fix:** Add a unit test for `_extractMonsterName` (currently it has zero direct coverage —
it is an inline closure, untestable without extraction). Extracting it to a named export
would also make CR-01's fix verifiable.

### IN-03: Initiative tie-break favors PCs by insertion order — intentional but undocumented in the event contract

**File:** `src/app/api/sessions/[id]/turn/encounter-opener.ts:276-279`
**Issue:**
`orderEntries.sort((a, b) => b.initiative - a.initiative)` relies on `Array.prototype.sort`
stability (guaranteed in modern V8) to break ties in favor of PCs (pushed before the
monster). The comment explains the intent, but the resulting `initiative_set.order` is
consumed by the projector/handoff as authoritative with no documented tie-break rule, so a
future change to insertion order (e.g. pushing the monster first) would silently flip
initiative ties against the player.
**Fix:** Make the tie-break explicit in the comparator (e.g. secondary sort key, or an
`isPc` flag) so it does not depend on push order, and note the rule where the event is
documented.

---

_Reviewed: 2026-06-01T00:40:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
