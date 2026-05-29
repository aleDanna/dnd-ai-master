# Phase 08: Server-Side Combat Resolver (v1 Player Attacks) - Pattern Map

**Mapped:** 2026-05-29
**Files analyzed:** 7 (2 new src, 3 modified src, 2+ new/extended tests)
**Analogs found:** 7 / 7 (all in-repo; no RESEARCH-only fallbacks needed)

> Build ON 08-RESEARCH.md — it already has the verified line anchors, the parse-regex
> examples (§Code Examples), the "Don't Hand-Roll" table, and the 5 pitfalls. This file
> adds the **per-file closest analog + the exact delta to apply**, so the planner can
> write precise `<read_first>` / `<action>` fields. Where RESEARCH already nailed a
> snippet, this file points to it rather than duplicating.

## File Classification

| New/Modified File | Role | Data Flow (in→out) | Closest Analog | Match Quality |
|-------------------|------|--------------------|----------------|---------------|
| `src/app/api/sessions/[id]/turn/combat-resolver.ts` **(NEW)** | utility (pure domain fn) | transform (rollResult string + EncounterState → discriminated-union {events, directive, damageRequest}) | `src/app/api/sessions/[id]/turn/combat-handoff.ts` | **exact** (same dir, same "pure fn, no I/O, discriminated union, called by vault branch before X") |
| `src/app/api/sessions/[id]/turn/route.ts` (vault branch) **(MODIFY)** | route (orchestration glue) | request-response (read encounter → gate → resolve → emit → narrate → safety-net) | itself — existing vault branch `:355-372` (directive build) + `:427-455` (post-loop encounter read) | **exact** (in-file pattern reuse) |
| `src/ai/master/vault/loop.ts` **(MODIFY)** | service (LLM orchestrator) | event-driven (tool_use stream → dispatch / drop → tool_result) | itself — dispatch seam `:313-343` + `VaultLoopInput` flag pattern `:47-86` | **exact** (in-file flag + seam) |
| `src/ai/master/vault/turn-directive.ts` **(MODIFY)** | utility (pure prompt builder) | transform (opts → directive string \| null) | itself — `isRollResult` `:69` + the resolve-directive branch `:97-109` | **exact** (in-file branch gate) |
| `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` **(NEW)** | test (pure-fn unit) | request-response (fixture → assert) | `tests/sessions/vault-combat-turn-interleaving.test.ts` | **exact** (pure-fn test, EncounterState fixtures, NO db mock / NO tmpfs) |
| `tests/ai/master/vault/loop.test.ts` **(EXTEND)** | test (loop integration) | event-driven (scripted provider → assert dispatch/no-dispatch) | itself — `scriptedProvider` `:64-89` + apply_event-integration describe `:334-420` | **exact** (in-file harness reuse) |
| `tests/ai/master/vault/turn-directive.test.ts` **(EXTEND)** | test (pure-fn unit) | request-response (opts → assert string) | itself — existing describe blocks `:4-67` | **exact** (in-file pattern) |

---

## Pattern Assignments

### `src/app/api/sessions/[id]/turn/combat-resolver.ts` (NEW — utility / pure transform)

**Analog:** `src/app/api/sessions/[id]/turn/combat-handoff.ts` (THE template — same directory,
same "Phase NN pure helper called by the vault branch before the existing path" shape, same
discriminated-union return, same determinism contract, same security-comment style).

**Why this analog (not the projector reducers / `turn-directive.ts`):** `combat-handoff.ts`
is the *closest structural sibling* — it lives in the exact target directory, is the most
recently-added pure helper (Phase 07-03), and already establishes every convention the new
resolver needs: a JSDoc threat-model note, the `import type { EncounterState }`, a discriminated
union with a `kind` discriminant, an `args: {...}` single-object param, and explicit early-return
gates. The resolver differs only in that it ALSO does string parsing (borrow that from
`roll-parser.ts` regex idioms) and returns `null` on fall-through (vs `{kind:'fallback'}`).

**Header + import + determinism-contract pattern** (`combat-handoff.ts:1-15`) — copy the
JSDoc shape (phase tag, "pure function … without reading the filesystem", threat-model line,
"Determinism: no clock reads, no env reads, no randomness."):
```typescript
/**
 * Phase 07 Plan 03 — combat turn interleaving helper.
 *
 * Pure function that derives the turn-handoff decision from an active
 * EncounterState without reading the filesystem. ...
 *
 * Determinism: no clock reads, no env reads, no randomness. Pure function.
 */
import type { EncounterState } from '@/ai/master/vault/projector';
```
> Delta: also `import type { VaultEvent } from '@/ai/master/vault/events-schema';` (the
> return `events: VaultEvent[]` — plain `{type,payload}`, NO envelope; RESEARCH Pattern 1).
> Optionally `import { isRollResult } from '@/ai/master/vault/turn-directive';` if the gate
> is shared from here (the route already imports it — keep the gate in the route per D-01).

**Discriminated-union return type** (`combat-handoff.ts:28-31`) — mirror this `export type`
shape, but use the D-02 contract:
```typescript
export type CombatHandoffResult =
  | { kind: 'advance'; nextCharacterId: string }
  | { kind: 'skip' }
  | { kind: 'fallback' };
```
> Delta — the resolver's return is the CONTEXT D-02 contract (note: a single object with a
> `kind` field + the function returns `… | null`, NOT a union-only-discriminant):
> ```typescript
> export interface ResolveCombatResult {
>   kind: 'to-hit' | 'damage' | 'none';
>   events: VaultEvent[];                 // monster_hp_change / turn_advance, plain {type,payload}
>   narrationDirective: string;           // "[RESOLVED BY SYSTEM: …] narra in 2ª persona"
>   damageRequest: string | null;         // "Tira 1d6+3 per danni a Veyra" on a hit, else null
> }
> export function resolveCombat(input: {
>   rollResult: string;
>   encounter: EncounterState;
>   defaultMonsterAc?: number;            // default 12  (D-08)
>   defaultDamageDie?: string;            // default "1d6" (D-08)
> }): ResolveCombatResult | null;         // null → not a combat roll → caller falls through
> ```

**Early-return gate pattern** (`combat-handoff.ts:54-73`) — copy the "Gate 1 / Gate 2 / Gate 3
→ early return" style for the resolver's fall-through cases (unparseable, no/ambiguous target,
wrong dice+keyword combo → `return null`; NEVER throw — D-05/D-10):
```typescript
const { encounter, party } = args;
// Gate 1: encounter must be active.
if (!encounter.active) return { kind: 'fallback' };
// Gate 2: turnOrder must be non-empty.
if (encounter.turnOrder.length === 0) return { kind: 'fallback' };
...
const isPC = party.some((p) => p.id === actor.actorId);   // membership-match idiom
```
> Delta — resolver gates: parse the roll (→ `null` if no `**N**`); detect kind from dice+keyword
> (`1d20`+`attacc/colp`→to-hit; non-d20+`danni`→damage; else `null`); parse target name; match
> **case-insensitive EXACT** vs `encounter.monsters[].name` → 0 or >1 → `null` (RESEARCH Open
> Question 1). Reuse the `party.some(...)` membership idiom as `monsters.filter(m =>
> m.name.toLowerCase() === target.toLowerCase())`.

**Parsing helpers — borrow regex idioms from `roll-parser.ts`** (`extractPurpose` `:744-778`,
`inferKind` `:804-817`). The resolver parses the rendered roll-RESULT string (not a formula).
Use the **verified** parse function in RESEARCH §"Parsing the to-hit roll-result" (handles the
LAST-parenthetical breakdown + the `+0`/no-breakdown fallback `natural = total`). Do NOT
re-derive — that snippet is execution-verified (Pitfall 2). Target-extraction regex for the
damage path: `/danni\s+a\s+([^.;:!?\n)]+)/i` (RESEARCH Pitfall 1, verified round-trip).

**Hit rule — mirror, don't call** (source `src/engine/combat/attack.ts:345,361,365`):
```typescript
// attack.ts:345  if (natural === 1) → miss
// attack.ts:361  const naturalCrit = natural === 20;
// attack.ts:365  const hit = naturalCrit || attackRoll.total >= effectiveAc;
```
> Delta — replicate on the rolled TOTAL (the client already rolled the d20; D-09):
> `const ac = monster.ac ?? input.defaultMonsterAc ?? 12; const hit = natural !== 1 && (natural === 20 || total >= ac);`
> Do NOT import/call `makeAttack` (it re-rolls the d20 and needs a full `Character` — RESEARCH
> Anti-Patterns).

**Event construction — plain `{type,payload}`, NO envelope** (shapes from
`events-schema.ts:321-322`):
```typescript
| { type: 'turn_advance'; payload: Record<string, never> }
| { type: 'monster_hp_change'; payload: { id: string; delta: number } }
```
> Delta — miss → `events:[{type:'turn_advance',payload:{}}]`; hit → `events:[]` (turn does NOT
> advance until the damage roll) + `damageRequest`; damage → `events:[{type:'monster_hp_change',
> payload:{id, delta:-total}}, {type:'turn_advance',payload:{}}]`. Bonus reused from the to-hit
> roll. **Damage request MUST use the `per` lead-in** (RESEARCH Pitfall 1 — BLOCKING):
> `` `Tira ${die}+${bonus} per danni a ${monster.name}` ``.

---

### `src/app/api/sessions/[id]/turn/route.ts` (MODIFY — route / orchestration glue)

**Analog:** the existing vault branch in the SAME file — two regions are the pattern source.

**⚠ Use RESEARCH Pitfall 5 verified anchors (file is 936 lines; CONTEXT line refs drifted).**
Confirmed current anchors: vault branch `:278`; `vaultMutationsEnabled` `:282`; clean
`_playerMessage` captured at `:355-357` (BEFORE directive append `:358-372`); `runVaultToolLoop`
call `:379`; post-loop transaction `:427`; **POST-LLM encounter read to DUPLICATE up** `:454-455`;
07-03 handoff `:456`; vault early-return `:523`.

**Pattern A — the clean player message + directive build** (`route.ts:355-372`): this is where
the gate + early read + resolve hook in (BEFORE the `runVaultToolLoop` at `:379`). Capture the
CLEAN message at `:355-357` (RESEARCH Pitfall 4 — gate on the message BEFORE the directive is
appended):
```typescript
const _lastUserTurn = [...vaultHistory].reverse().find((m) => m.role === 'user');
const _playerMessage =
  typeof _lastUserTurn?.content === 'string' ? _lastUserTurn.content : undefined;
const _directive = buildTurnDirective({ vaultMutations: vaultMutationsEnabled, /* … */ });
if (_directive !== null) {
  vaultHistory = appendDirectiveToHistory(vaultHistory as …, _directive) as typeof vaultHistory;
}
```
> Delta to apply (NEW, inserted between `:357` and the directive build at `:358`):
> 1. **Early encounter read** — DUPLICATE the post-loop read (Pattern B below) up to here:
>    `const { encounter } = replayEvents(await parseEventsFile(eventsPath(campaign.id)));`
>    (both `parseEventsFile`/`replayEvents`/`eventsPath` are already imported — used at `:454-455`).
> 2. **Gate (D-01):** `vaultMutationsEnabled && encounter.active && isRollResult(_playerMessage)`.
> 3. On gate-true: `const resolver = resolveCombat({ rollResult: _playerMessage!, encounter });`
>    — `null` → treat as gate-false (fall through to today's path; directive build proceeds).
> 4. On `resolver !== null`: emit each event (Pattern C), pass D-07 suppression to the directive
>    build, set `suppressCombatMutations: true` + inject `resolver.narrationDirective` into the loop,
>    and arm the safety-net (Pattern D). Non-combat path = byte-identical to today.

**Pattern B — the encounter read to duplicate** (`route.ts:454-455`, inside the post-loop tx):
```typescript
const envelopes = await parseEventsFile(eventsPath(s.campaignId));
const { encounter } = replayEvents(envelopes);
```
> Delta — **DO NOT delete this** (RESEARCH Pattern 3). It re-reads AFTER the resolver's
> `turn_advance` is persisted, so `resolveCombatHandoff` (`:456`) sees advanced state and hands
> to the next PC. The early read (Pattern A) and this late read are intentionally two reads of
> the same file at different times.

**Pattern C — server-side event emission** (reuse `dispatchVaultTool`, the public dispatcher;
contract at `tools.ts:251-383`, single-write branch `:371-379`, UUID guard relaxed for encounter
events `:285`). RESEARCH §"Server-side event emission" has the exact loop:
```typescript
for (const ev of resolver.events) {
  const r = await dispatchVaultTool('apply_event', ev, { campaignId: campaign.id });
  if (r.isError) console.warn('[turn]', sessionId, 'resolver emit failed:', r.content);
}
```
> Delta — place this AFTER `resolveCombat` returns non-null and BEFORE `runVaultToolLoop`.
> Wrap defensively (D-10 — never hard-fail the turn). `dispatchVaultTool` is already imported
> in the loop; the route may need to add the import (verify — see Shared Patterns).

**Pattern D — loop invocation** (`route.ts:379-421`): add the narration-only flag + the directive.
> Delta — pass `suppressCombatMutations: true` on resolution turns; inject
> `resolver.narrationDirective` into `vaultHistory` (recency, via `appendDirectiveToHistory`)
> INSTEAD of the normal `buildTurnDirective` output. **Safety net** (D-06, RESEARCH Open Q3):
> after the loop, `if (resolver.damageRequest && !parseRollRequests(vaultResult.finalText).some(r => r.kind === 'damage')) { /* append resolver.damageRequest to finalText */ }`
> — import `parseRollRequests` from `@/lib/roll-parser`.

---

### `src/ai/master/vault/loop.ts` (MODIFY — service / narration-only mode)

**Analog:** the file itself — the `VaultLoopInput` optional-flag convention (`:47-86`) and the
tool-dispatch seam (`:313-343`).

**Flag pattern** (`loop.ts:60-68` — every loop knob is an optional, JSDoc'd `VaultLoopInput`
field, destructured at `:120-135`):
```typescript
export interface VaultLoopInput {
  /** Phase 03-A — when `true`, every `apply_event` tool call fans out … */
  dualWrite?: boolean;
  /** Test override; production omits and uses `VAULT_TURN_TOOL_CALL_CAP`. */
  toolCallCap?: number;
}
```
> Delta — add `suppressCombatMutations?: boolean;` with a JSDoc citing D-06/Pattern 2 (drop
> `ENCOUNTER_EVENT_TYPES` `apply_event` calls this turn — server already emitted them).
> Destructure it alongside the others around `:130-133`.

**Dispatch-seam pattern** (`loop.ts:313-342` — the single place every non-`end_turn` tool is
dispatched; the `for (const tu of toolUses)` loop emits `tool_use_start`, dispatches, emits
`tool_use_end`, pushes a `tool_result`):
```typescript
for (const tu of toolUses) {
  toolCallCount += 1;
  emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input });
  const result = await dispatchVaultTool(tu.name, tu.input, { vaultRoot, campaignId, dualWrite, sessionId, characterId: … });
  emit({ type: 'tool_use_end', toolUseId: tu.id, ok: !result.isError, …, rolls: [], mutationCount: 0 });
  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.content, is_error: result.isError });
}
```
> Delta — at the TOP of the loop body (before `dispatchVaultTool`), insert the drop branch
> (RESEARCH Pattern 2, verified sketch): `if (suppressCombatMutations && tu.name === 'apply_event'
> && ENCOUNTER_EVENT_TYPES.has((tu.input as {type?:string}).type ?? '')) { emit start; emit
> end(ok:true); toolResults.push(benign {ok:true, note:'combat resolved server-side this turn'});
> continue; }`. **Only `ENCOUNTER_EVENT_TYPES`** are dropped — non-combat `apply_event` (e.g.
> `inventory_add`) must still dispatch (RESEARCH Anti-Pattern).
> **Import delta:** add `import { ENCOUNTER_EVENT_TYPES } from './events-schema';` — verified
> NOT currently imported in `loop.ts` (only `tools`/`condense`/`reasoning-strip` are).

---

### `src/ai/master/vault/turn-directive.ts` (MODIFY — utility / D-07 suppression)

**Analog:** the file itself — the `isRollResult` gate (`:69`, reuse for the route gate) and the
roll-result "resolve" directive branch (`:97-109`) that D-07 must suppress when the server resolved.

**The branch to suppress** (`turn-directive.ts:97-109`):
```typescript
if (isRollResult(playerMessage)) {
  const r: string[] = [];
  r.push('[ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato]');
  // …
  if (vaultMutations) {
    r.push('Se era un tiro PER COLPIRE: confronta il totale con la CA … chiedi il tiro per i danni …');
    r.push('Se era un tiro PER I DANNI: chiama apply_event con monster_hp_change …');
    r.push('Quando l\'azione del turno è conclusa, chiama apply_event con turn_advance …');
  }
  return r.join('\n');
}
```
> Delta (D-07) — add an opts flag (e.g. `serverResolved?: boolean`) to `TurnDirectiveOpts`
> (`:21-42`). When `serverResolved` is true, **skip this whole `isRollResult` branch** (the
> server's `narrationDirective` takes over that turn — avoid conflicting "call apply_event
> monster_hp_change / turn_advance" instructions; RESEARCH Pitfall 3 belt-and-suspenders, and
> State-of-the-Art row 3). Keep the existing JSDoc-flag style (`:21-42`). The route passes
> `serverResolved: resolver !== null` into `buildTurnDirective` on the resolution turn (then it
> injects `resolver.narrationDirective` separately — Pattern D).

---

### `tests/app/api/sessions/[id]/turn/combat-resolver.test.ts` (NEW — pure-fn unit)

**Analog:** `tests/sessions/vault-combat-turn-interleaving.test.ts` (the `resolveCombatHandoff`
pure-fn test — **NO db mock, NO tmpfs, NO scripted provider**; just `import {...}; const FIXTURE:
EncounterState = {...}; expect(fn(args)).toEqual(...)`. Exactly right for a pure resolver).

**Imports + EncounterState fixture pattern** (`vault-combat-turn-interleaving.test.ts:1-2,59-68`):
```typescript
import { describe, it, expect } from 'vitest';
import type { EncounterState } from '@/ai/master/vault/projector';

const ACTIVE_ENCOUNTER_PC_FIRST: EncounterState = {
  active: true, round: 1, currentIdx: 0,
  turnOrder: [{ actorId: 'pc-uuid-1', initiative: 20 }, { actorId: 'goblin-1', initiative: 12 }],
  monsters: [{ id: 'goblin-1', name: 'Goblin', hpCurrent: 7, hpMax: 7, isAlive: true, conditions: [] }],
};
```
> Delta — `import { resolveCombat } from '@/app/api/sessions/[id]/turn/combat-resolver';`. Copy
> the fixture shape; add a monster WITH `ac` and one WITHOUT (to assert the default-12 path).
> Cover the REQUIRED unit rows (RESEARCH §Phase Requirements → Test Map, all REQ-039):
> to-hit ≥AC → hit + `damageRequest` (assert the `per` form round-trips via
> `parseRollRequests(result.damageRequest)`); <AC → miss + `turn_advance`, `damageRequest` null;
> nat-20 <AC → hit; nat-1 ≥AC → miss; `+0`/no-breakdown roll → `natural=total` parses; damage →
> `monster_hp_change(id,-total)` + `turn_advance`; target case-insensitive from `danni a <name>`;
> unknown/ambiguous (>1 exact-name match) target → `null`; default AC 12 / default die `1d6`;
> `1d20` during combat with NO attack keyword → `null`; garbage string → `null` (no throw).
> The to-hit roll-result fixtures are in RESEARCH §Code Examples (verified strings).
> **Note the path-bracket escaping in the run command:**
> `pnpm vitest run tests/app/api/sessions/\[id\]/turn/combat-resolver.test.ts` (RESEARCH §Test Framework).

---

### `tests/ai/master/vault/loop.test.ts` (EXTEND — loop integration / no-double-apply)

**Analog:** the file itself — `scriptedProvider` (`:64-89`) + the `apply_event`-integration
describe block with the tmpfs+seed harness (`:308-420`).

**Harness pattern** — `seedCampaignFile` (`:311-332`) writes a real `events.md` under a
`mkdtempSync` `VAULT_CAMPAIGNS_ROOT`, then asserts on the file line count before/after
(`:353-380`):
```typescript
const linesBefore = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
const provider = scriptedProvider([
  { contentBlocks: [{ type: 'tool_use', id: 'tu_apply', name: 'apply_event',
      input: { type: 'hp_change', payload: { character: APPLY_CHAR_UUID, delta: -5 } } }] },
  { contentBlocks: [{ type: 'tool_use', id: 'tu_end', name: 'end_turn', input: { response: '…' } }] },
]);
const result = await loop({ provider, campaignId: APPLY_CAMPAIGN_UUID, ...BASE_INPUT });
const linesAfter = (await readFile(eventsFile, 'utf8')).trim().split('\n').length;
expect(linesAfter).toBe(linesBefore + 1);
```
> Delta — add a `describe('runVaultToolLoop — narration-only mode (Phase 08)')`. Reuse
> `scriptedProvider` + the `seedCampaignFile` tmpfs harness. Script a response that emits
> `apply_event { type:'monster_hp_change', payload:{ id, delta } }` then `end_turn`. (a) With
> `suppressCombatMutations: true` → assert `linesAfter === linesBefore` (NOT persisted) AND a
> `tool_use_end` with `ok:true` still fired (turn completes). (b) Regression: with the flag
> falsy → the encounter event IS dispatched (line added) — i.e. today's behavior. (c) A
> non-combat `apply_event` (e.g. `hp_change`) is STILL dispatched even when the flag is true.
> Note: monster_hp_change needs a seeded monster id, or assert the drop happens BEFORE the
> dispatcher's monster lookup (the drop is at the loop seam, pre-dispatch — so a fake id is fine
> for the "not persisted" assertion: the line simply never gets written).

---

### `tests/ai/master/vault/turn-directive.test.ts` (EXTEND — pure-fn unit / D-07)

**Analog:** the file itself — the existing `describe`/`it` + `buildTurnDirective({...})`
assertion style (`:4-67`).

**Pattern** (`turn-directive.test.ts:40-47`):
```typescript
it('contains apply_event and combat event names when vaultMutations is true', () => {
  const result = buildTurnDirective({ vaultMutations: true });
  expect(result).not.toBeNull();
  expect(result!).toContain('apply_event');
});
```
> Delta — add a `describe('D-07 — server-resolved suppression')`. Assert: with a roll-result
> `playerMessage` (e.g. `'🎲 I rolled **18** for 1d20+3 (attaccare Veyra) (15+3).'`) and
> `serverResolved: true`, the output does NOT contain the resolve-branch text (e.g. NOT
> `'monster_hp_change'` / NOT `'ISTRUZIONE PRIORITARIA — il giocatore ha appena tirato'`);
> and WITHOUT `serverResolved` (today's behavior), it DOES (regression). `isRollResult` itself
> is already covered — only the new flag gating needs tests.

---

## Shared Patterns

### Pattern: Pure helper in the turn directory (resolver + handoff are siblings)
**Source:** `src/app/api/sessions/[id]/turn/combat-handoff.ts:1-74`
**Apply to:** `combat-resolver.ts`
Phase-tagged JSDoc + threat-model note + "Determinism: no clock/env/randomness" + `import type
{ EncounterState }` + discriminated-union `export type` + `args:{...}` single-object param +
explicit early-return gates + `party.some(...)`-style membership match. This is the canonical
shape for new pure logic in the turn route; copy it wholesale and swap the body.

### Pattern: Server-side event emission via the public dispatcher
**Source:** `src/ai/master/vault/tools.ts:251-383` (single-write branch `:371-379`; encounter
UUID-guard relaxed `:285`)
**Apply to:** the route's resolver-emit loop (Pattern C above)
`for (const ev of resolver.events) await dispatchVaultTool('apply_event', ev, {campaignId:
campaign.id})`. Validates (`validateEvent` `:270`), allocates UUID + timestamp (`:298-304`),
persists to `events.md` (`EventsWriter.applyEvent` `:373`), regenerates `combat.md`
(`regenerateAffectedViews` `:375`). Encounter events skip the `payload.character` UUID guard
(`:285`). The resolver stays pure (returns plain `{type,payload}`); the dispatcher stamps the
envelope. **Import check:** confirm `dispatchVaultTool` is importable in `route.ts` (it's
exported from `@/ai/master/vault/tools`; the route already imports `runVaultToolLoop` from the
sibling `loop` — add the `tools` import if absent).

### Pattern: Roll-string parse + round-trip contract (client/server symmetry)
**Sources:** `src/components/game/roll-request-button.tsx:125-134` (`formatResultText` — the
EXACT string the resolver parses: `🎲 I rolled **<total>** for <label> (<dice><mod>).`, and the
`+0`/single-die NO-breakdown case at `:126-128`); `src/lib/roll-parser.ts:744-778` (`extractPurpose`
— the `per`/`for` lead-in gate that forces the damage request's `per`); `:804-817` (`inferKind`
— `danni`→damage, `attacc`→attack); `src/ai/master/vault/prompt-builder.ts:132` (`"Tira
1d20+<bonus> per attaccare <NOME DEL BERSAGLIO>"` — the symmetric attack format).
**Apply to:** `combat-resolver.ts` parsing helpers + `combat-resolver.test.ts` round-trip assert.
The damage request **MUST** be `` `Tira ${die}+${bonus} per danni a ${monster.name}` `` (the
`per` is BLOCKING — RESEARCH Pitfall 1). The to-hit parse must read the breakdown from the LAST
parenthetical and fall back to `natural=total` when absent (Pitfall 2). Use the verified parse
fn in RESEARCH §Code Examples — do not re-derive.

### Pattern: Hit rule mirrored (not called)
**Source:** `src/engine/combat/attack.ts:345` (nat-1 miss), `:361` (nat-20 crit), `:365`
(`hit = naturalCrit || total >= effectiveAc`)
**Apply to:** `combat-resolver.ts` to-hit branch
Replicate `hit = natural !== 1 && (natural === 20 || total >= (monster.ac ?? 12))` on the
ROLLED total. Do NOT import `makeAttack`/`applyDamage` (they re-roll the d20 and need a full
`Character`/resistances — RESEARCH Anti-Patterns; D-09).

### Pattern: Optional JSDoc'd flag on an input interface
**Sources:** `VaultLoopInput` (`src/ai/master/vault/loop.ts:47-86`); `TurnDirectiveOpts`
(`src/ai/master/vault/turn-directive.ts:21-42`)
**Apply to:** the new `suppressCombatMutations?` (loop) and `serverResolved?` (turn-directive)
flags. Every existing knob is an optional field with a phase-tagged JSDoc explaining the default
and the gate — match that exactly.

---

## No Analog Found

None. Every file has a strong in-repo analog (most are in-file pattern reuse; the genuinely new
`combat-resolver.ts` has an exact structural sibling in `combat-handoff.ts`). RESEARCH's verified
parse-fn snippet (§Code Examples) covers the only piece without a direct copy-target (string
parsing of the rendered roll-result) — and it is execution-verified, so the planner should use
it verbatim rather than treating it as "no analog".

## Metadata

**Analog search scope:** `src/app/api/sessions/[id]/turn/` (resolver + route + handoff),
`src/ai/master/vault/` (loop, turn-directive, tools, projector, events-schema, prompt-builder),
`src/lib/roll-parser.ts`, `src/components/game/roll-request-button.tsx`,
`src/engine/combat/attack.ts`, `tests/ai/master/vault/`, `tests/sessions/`.
**Files scanned:** 13 read (targeted ranges) + 4 greps.
**Read-only:** confirmed — no source files modified; only this PATTERNS.md written.
**Pattern extraction date:** 2026-05-29
