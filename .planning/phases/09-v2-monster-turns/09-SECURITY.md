---
phase: 09
slug: v2-monster-turns
status: verified
threats_total: 22
threats_closed: 22
threats_open: 0
asvs_level: 2
created: 2026-05-31
---

# Phase 09 — Security Audit

> Per-phase security contract: threat register, accepted risks, and audit trail.
> All 22 threats authored at plan time (`register_authored_at_plan_time: true`).
> ASVS Level 2. `block_on: high`.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| monster_spawn payload → validateEvent | `cr` value enters the system via the event log; validateEvent is the sole input-validation gate | Numeric `cr` from LLM |
| validated event → EncounterState | `cr` flows into state only via the server-controlled reducer; no player-input surface | Validated numeric `cr` |
| cr value → CR-table lookup | A server-validated `cr` crosses into an array lookup | Numeric index |
| Monster name → filesystem | A name used to locate a bestiary file; could contain `../` | File path derivation |
| Bestiary prose → regex engine | Bestiary markdown content crosses into a regex matcher (ReDoS surface) | Multi-line string |
| livePcIds / pcAcById → combat math | PC ids + AC originate from server state (Postgres + vault replay), never from player input | Identity + AC integer |
| Loop events → events.md | Emission goes through the validating dispatcher; loop runs OUTSIDE the DB transaction | VaultEvent array |
| LLM narration → client | On a loop-ran turn the model can leak roll-asks / event-JSON; final text must be sanitized | Prose string |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status | Evidence (file:line) |
|-----------|----------|-----------|-------------|------------|--------|----------------------|
| T-09-01 | Input Validation / DoS | `cr` in monster_spawn payload | mitigate | validateEvent rejects non-number / NaN / Infinity / negative `cr` before it reaches state | CLOSED | `events-schema.ts:1054-1066` — guard `typeof p.cr !== 'number' || !Number.isFinite(p.cr) || p.cr < 0` with explicit error message |
| T-09-02 | Tampering | event replay / schema change | mitigate | Additive optional `cr?: number` on both event type and state; cr-less logs project byte-identically | CLOSED | `events-schema.ts:318-321` (type) + `projector.ts:674-676` (interface) + `projector.ts:763` (conditional copy: `if (cr !== undefined) monster.cr = cr`) |
| T-09-03 | Tampering | player-influenced monster stats | mitigate | `cr` copied verbatim from the server-controlled monster_spawn event only; reducer introduces no new player-input surface | CLOSED | `projector.ts:750` — `const { id, name, hpMax, ac, initiativeBonus, cr } = event.payload;` with `if (cr !== undefined) monster.cr = cr;` at line 763; no other code path sets `EncounterState.monsters[].cr` |
| T-09-04 | DoS | getMonsterAttackStats cr lookup | mitigate | `cr` validated (`Number.isFinite(cr) && cr >= 0`) before table lookup; NaN/Infinity/negative fall back to named-constant default, never throws | CLOSED | `monster-turns.ts:121` — `if (cr !== undefined && Number.isFinite(cr) && cr >= 0)` + fallthrough to `DEFAULT_MONSTER_ATTACK_BONUS`/`DEFAULT_MONSTER_DAMAGE_DIE` at line 135 |
| T-09-05 | Tampering | monster attack stats | mitigate | `attackBonus`/`damageDice` derive only from the CR table, bestiary parse, or server constants; target ids/AC come from server-resolved EncounterState/Postgres | CLOSED | `monster-turns.ts:110-136` (`getMonsterAttackStats` — 3-level table/bestiary/default only); `route.ts:460-473` (PC-AC from `charactersTable.ac`, PC-HP from vault replay) |
| T-09-06 | DoS | randomness seam | mitigate | All randomness via injected `Rng` (default `defaultRng`); no `Math.random` in code; empty `livePcIds` returns `null`, never throws | CLOSED | `monster-turns.ts:197` — `const rng = input.rng ?? defaultRng`; `Math.random` appears only in a comment (line 19), not in code (confirmed by grep); `monster-turns.ts:195` — `if (input.livePcIds.length === 0) return null` |
| T-09-07 | Tampering | HP underflow (resolveMonsterTurn) | mitigate | resolveMonsterTurn emits only the negative delta; the `hp_change` reducer clamps `max(0, hp+delta)` | CLOSED | `monster-turns.ts:220` — `{ type: 'hp_change', payload: { character: pcId, delta: -damage } }`; `projector.ts:307-311` — `Math.max(0, Math.min(state.hp_max, state.hp_current + event.payload.delta))` |
| T-09-08 | Tampering | name-based bestiary file lookup | mitigate | Every name routed through `readVaultFile` → `safeVaultPath` (slug-normalize + path-confine + symlink guard); no hand-rolled fs/path.join | CLOSED | `monster-bestiary.ts:156-160` — `slug = slugify(name)` then `await readVaultFile('handbook/monsters/${slug}.md')`; imports `readVaultFile` from `@/ai/master/vault/path` (line 25); no fs/path import present in the file |
| T-09-09 | DoS | attack-line regex (ReDoS) | mitigate | Bounded per-block-description regex (no nested unbounded quantifiers over the full body); regexes are `ATTACK_HIT_RE` + `DAMAGE_DICE_RE` run per block | CLOSED | `monster-bestiary.ts:35` — `ATTACK_HIT_RE = /\+(\d+)\s{0,4}to\s{1,4}hit/i` (bounded quantifiers); `monster-bestiary.ts:40` — `DAMAGE_DICE_RE = /(\d+d\d+(?:[+-]\d+)?)/`; both executed at line 101-104 on a single `block.description`, not over the full multi-line body |
| T-09-10 | Tampering | malformed / absent attack line | mitigate | No match / missing file returns `null` (never throws); caller falls back to D-05/D-06 path | CLOSED | `monster-bestiary.ts:163` — `if (contents.startsWith('ERROR')) return null`; `monster-bestiary.ts:108` — `return null` on no matching block; `getBestiaryAttackStats` wraps `slugify` in try/catch at line 152-158 and catches all errors |
| T-09-11 | DoS | the monster loop (unbounded) | mitigate | Named constant `MONSTER_LOOP_SAFETY_CAP = 20` bounds total iterations; cap → `stopReason 'cap-reached'`, never throws | CLOSED | `monster-turns.ts:248` — `export const MONSTER_LOOP_SAFETY_CAP = 20`; `monster-turns.ts:352` — `while (iterations < MONSTER_LOOP_SAFETY_CAP)`; default `stopReason = 'cap-reached'` at line 340 |
| T-09-12 | DoS / Integrity | PC HP underflow (working copy) | mitigate | Working-copy HP decrements clamped at 0 (`Math.max(0, ...)`) | CLOSED | `monster-turns.ts:421` — `workHp.set(r.pcTargetId, Math.max(0, current - r.damage))` |
| T-09-13 | Tampering | caller-state mutation | mitigate | Loop operates on `structuredClone(args.encounter)` + `new Map(args.pcHpById)`; never mutates caller inputs | CLOSED | `monster-turns.ts:334-335` — `let workEncounter = structuredClone(args.encounter);` and `const workHp = new Map(args.pcHpById);` |
| T-09-14 | Tampering | LLM narration vs resolved facts | mitigate | Combined directive carries ONLY resolved hit/miss/damage facts; route binds `enforceResolvedNarration` whenever `_monsterLoopRan` | CLOSED | `monster-turns.ts:480-490` (`buildMonsterLoopNarrationDirective` — maps only `r.hit`, `r.damage`, `r.total`, `r.ac`, `r.monsterName` from resolved results); `route.ts:668-682` — `enforceResolvedNarration` called whenever `_monsterLoopRan`; `combat-resolver.ts:252-277` — strips roll-requests + event-JSON lines |
| T-09-15 | Tampering | double-apply on server-resolved monster turn | mitigate | `monsterResolved` flag suppresses the combat re-ask directives (combat-intent + catalog) in `buildTurnDirective` | CLOSED | `turn-directive.ts:69` — `monsterResolved?: boolean` on `TurnDirectiveOpts`; `turn-directive.ts:166` — `if (!serverResolved && !monsterResolved && vaultMutations && detectCombatIntent(...))` (combat-intent guard); `turn-directive.ts:207` — `if (vaultMutations && !serverResolved && !monsterResolved)` (catalog guard) |
| T-09-16 | Tampering | malformed LLM-supplied cr | mitigate | Advertising `cr` in the tool description does not trust it — `validateEvent` (T-09-01) rejects bad cr before it reaches state; resolver defaults on malformed cr (T-09-04) | CLOSED | `tools.ts:101` — `cr?:number` in the monster_spawn clause (advertisement only); validation at `events-schema.ts:1054-1066`; default fallback at `monster-turns.ts:135` |
| T-09-17 | Integrity | REQ-022 prompt-cache hygiene | mitigate | The `cr` instruction is a deterministic static line inside the vaultMutations-gated combat block; D-16 stays at the directive layer (no per-turn system-prompt mutation) | CLOSED | `prompt-builder.ts:208-209` — static lines (`'Include \`cr\` (Challenge Rating, a number like 1, 3, 5)...'`) with no `Date.now`/`Math.random`/`process.env`; `turn-directive.ts:166,207` — D-16 guards are in the directive layer, not the system prompt |
| T-09-18 | Tampering | monster id / target selection | mitigate | Loop reads active monster + targets from server-resolved EncounterState + party PC-id set; player never supplies a monster id or target; `campaignId` is always `campaign.id` | CLOSED | `route.ts:447-453` — active actor derived from `encounter.turnOrder[encounter.currentIdx]` then matched via `encounter.monsters.find(m => m.id === active.actorId && m.isAlive)`; `route.ts:460-473` — PC set built from `db.select(...).from(charactersTable).where(eq(charactersTable.campaignId, campaign.id))`; `route.ts:490` — `campaignId: campaign.id` (server-authoritative, never player-derived) |
| T-09-19 | DoS | loop inside HTTP request / long-held transaction | mitigate | Loop bounded by `MONSTER_LOOP_SAFETY_CAP`; runs OUTSIDE the DB transaction; whole block in try/catch, never breaks the turn | CLOSED | `route.ts:440-510` — monster loop block is before `db.transaction(async (tx) => {` at line 693; `route.ts:440` — `if (vaultMutationsEnabled) { try { ... } catch (err) { console.warn(...) } }` |
| T-09-20 | Information Disclosure / Tampering | LLM leaks roll-asks / event-JSON or re-emits loop events | mitigate | `suppressCombatMutations` extended to loop turn AND `monsterResolved` flag passed AND final narration through `enforceResolvedNarration` whenever `_monsterLoopRan` (including the common D-01 path where `_resolver` is also set) | CLOSED | `route.ts:616` — `...((_resolver !== null || _monsterLoopRan) && { suppressCombatMutations: true })`; `route.ts:540` — `monsterResolved: _monsterLoopRan`; `route.ts:668-682` — `if (_monsterLoopRan)` branch builds `_monsterResolved` object with `damageRequest: null` and calls `enforceResolvedNarration`; `combat-resolver.ts:256-270` — strips EVENT_LABEL / EVENT_JSON / ROLL_REQUEST lines |
| T-09-21 | DoS | hp_change underflow / huge delta | mitigate | Loop clamps working HP at 0; existing `hp_change` reducer clamps `max(0, hp+delta)` | CLOSED | `monster-turns.ts:421` — `Math.max(0, current - r.damage)` (working copy); `projector.ts:308-311` — `Math.max(0, Math.min(state.hp_max, state.hp_current + event.payload.delta))` (reducer) |
| T-09-22 | DoS / Availability | bestiary fs read failure mid-loop | mitigate | `getBestiaryAttackStats` returns `null` on any fs failure / parse miss and NEVER throws; null bestiary falls through to CR table / named-constant default; loop never aborts | CLOSED | `monster-bestiary.ts:149-167` — `getBestiaryAttackStats` has multiple `return null` paths, catches slugify errors, checks `contents.startsWith('ERROR')`; `monster-turns.ts:394` — `const bestiary = await lookup(activeMonster.name)` then `getMonsterAttackStats({ cr: activeMonster.cr, bestiary })` at line 395, which treats `null` bestiary as "use fallback" |
| T-09-SC | Tampering / supply-chain | npm package installs | mitigate | No package installs this phase; dependency surface unchanged | CLOSED | `git log --since="2026-05-20" -- package.json pnpm-lock.yaml` returns zero Phase 09 commits; Phase 09 commits (`47ef812`, `9535b30`, `64e0bb3`, `2cac3ea`, etc.) show no `package.json` in their `--stat` output |

---

## Accepted Risks Log

No accepted risks.

---

## Unregistered Threat Flags (SUMMARY.md ## Threat Flags)

No new unregistered attack surface was reported in any Phase 09 SUMMARY.md file (none of the six summaries contain a `## Threat Flags` section). The two findings from the operator smoke (`deferred-items.md`) are operational gaps (live v2 loop not exercised; free-text attack bypasses isRollResult gate), not new threat surfaces beyond the registered register.

---

## Notable Audit Observations

**ASVS L2 high-severity threats individually verified:**

- **T-09-08 (path traversal):** Confirmed by reading `monster-bestiary.ts:25,156-160`. The file imports only `readVaultFile` from `@/ai/master/vault/path` (which internally calls `safeVaultPath`) and `slugify`. There is no `import { readFile } from 'node:fs'` or `path.join` — no hand-rolled path construction exists in the file.

- **T-09-09 (ReDoS):** Both regexes (`ATTACK_HIT_RE`, `DAMAGE_DICE_RE`) use bounded quantifiers (`\s{0,4}`, `\s{1,4}`) and are applied at `monster-bestiary.ts:101-104` to `block.description` (a single bounded string segment), not to the full multi-line body. The `splitActionBlocks` splitter uses a linear scan with no nested quantifiers.

- **T-09-11 / T-09-19 (loop DoS / transaction hold):** `MONSTER_LOOP_SAFETY_CAP = 20` is at `monster-turns.ts:248` and guards the while condition at line 352. The loop block in `route.ts:440-510` is positioned before the `db.transaction(...)` call at line 693 — confirmed by reading line numbers.

- **T-09-20 (narration sanitization / info disclosure):** Three independent layers verified: (1) `suppressCombatMutations` at `route.ts:616`; (2) `monsterResolved` directive suppression at `turn-directive.ts:166,207`; (3) `enforceResolvedNarration` bound at `route.ts:668-682` gated on `_monsterLoopRan` (NOT only on `_resolver !== null`), covering the common D-01 path where both flags are set in the same request.

- **T-09-18 (server-authoritative ids):** The active monster is derived from the server-replayed `EncounterState.turnOrder[currentIdx]` at `route.ts:448-453`. The PC set is sourced from a direct Postgres query filtered by `campaign.id` at `route.ts:460-467`. `campaignId` in every `dispatchVaultTool` call is `campaign.id` at `route.ts:490` — never a player-supplied value.

**Operational gap (not a code security gap):**

The live v2 loop has not yet been exercised in a production session (deferred-items.md, VERIFICATION.md `status: human_needed`). The operator smoke on 2026-05-31 did not trigger `runMonsterTurnLoop` because a free-text attack bypasses `isRollResult()`. This is a smoke-configuration gap, not a code defect or a security vulnerability. All 22 declared mitigations are present and effective in the implemented code as verified above; the code paths are covered by 507+ automated tests (828 total, 4 pre-existing unrelated failures excluded).

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | ASVS Level | Run By |
|------------|---------------|--------|------|------------|--------|
| 2026-05-31 | 22 | 22 | 0 | 2 | gsd-security-auditor (Claude Sonnet 4.6) |

---

## Sign-Off

- [x] All 22 threats have a disposition (all: mitigate)
- [x] Accepted risks documented in Accepted Risks Log (none)
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-31
