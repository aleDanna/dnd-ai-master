# Phase 02: Vault Write Path (Event Sourcing) — Pattern Map

**Mapped:** 2026-05-25
**Files analyzed:** 22 (13 source + 7 tests + 2 scripts + 1 schema + 1 doc) plus 6 extends-existing edits
**Analogs found:** 22 / 22 (100% — Phase 01 + spike folders provided exact precedent for every artifact)

## File Classification

### NEW source modules (under `src/ai/master/vault/`)
| File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/ai/master/vault/events-schema.ts` | model / type-guard | transform (pure validation) | `src/ai/master/vault/tools.ts` (named exports, JSDoc with REQ refs); plus skill ref `references/storage-and-mutation.md` | exact (style match) |
| `src/ai/master/vault/campaign-paths.ts` | utility (path resolver) | transform (string → path) | `src/ai/master/vault/path.ts` (lines 26-28 + 42-80; module-load env read, safe-path helper) | exact |
| `src/ai/master/vault/events-writer.ts` | service (single-writer mutex) | file-I/O append-only | `.planning/spikes/010-events-md-concurrency/writer.ts` (direct lift target) | exact lift |
| `src/ai/master/vault/projector.ts` | service (pure reducer + view writer) | transform + file-I/O | `.planning/spikes/008-events-md-replay/replay.ts` (reducer + serializer); plus `src/ai/master/vault/path.ts` for the pure-function module shape | exact lift |

### EXTEND existing source modules
| File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/ai/master/vault/tools.ts` (add 4th tool + dispatch branch) | controller (LLM tool dispatcher) | request-response | the existing 3 branches inside the same file (lines 99-138) | exact (extend existing dispatch switch) |
| `src/ai/master/vault/index.ts` (barrel) | barrel export | n/a | existing barrel (`export * from './path'` etc., 9 lines total) | exact |
| `src/ai/master/vault/loop.ts` (add VaultLoopInput.campaignId + forward to ctx) | controller (tool loop) | request-response | existing destructure + dispatch call pattern in the same file (lines 67-77, 139, 186) | exact |
| `src/ai/master/vault/prompt-builder.ts` (add vaultMutations input + applyEventMention) | utility (pure prompt assembly) | transform | existing `buildVaultSystemPrompt` lines 32-54 (line-array push pattern, conditional language clause) | exact |
| `src/sessions/types.ts` (add `VAULT_TURN_TOOL_CALL_CAP`) | config constant | n/a | existing `TURN_TOOL_CALL_CAP = 12` at line 39 | exact (same shape, adjacent declaration) |
| `src/db/schema/campaigns.ts` (add `vaultMutations?: boolean` to `CampaignSettings`) | model (DB schema) | n/a | existing `masterBackend?: MasterBackend` field at lines 65-72 | exact (parallel-shape pattern) |
| `src/db/schema/users.ts` (mirror `vaultMutations?` on `UserPreferences`) | model (DB schema) | n/a | existing `masterBackend?` field on `UserPreferences` | exact (Phase 01 parallel-shape precedent) |
| `src/lib/preferences.ts` (add `resolveVaultMutations` + validator arm + DEFAULT_PREFERENCES + getCampaignSettings field) | service (settings resolver) | transform | existing `resolveMasterBackend` at lines 116-130 + `validateSettingsPatch` masterBackend arm at lines 563-571 | exact (parallel-shape) |
| `src/app/api/sessions/[id]/turn/route.ts` (gate apply_event exposure on resolveVaultMutations) | controller (Next.js route handler) | request-response | the existing vault branch lines 248-409 (Phase 01 plan 07 insertion) | exact (extend in place) |

### NEW scripts (under `scripts/`)
| File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `scripts/vault-backup.ts` | CLI (operator-driven backup) | file-I/O batch | `scripts/vault-flip.ts` (tsx shebang, `_env-loader`, argv parsing, structured exits) | exact |
| `scripts/vault-rebuild-views.ts` | CLI (recovery / DR) | file-I/O batch | `scripts/vault-flip.ts` + `scripts/db-snapshot.ts` (CLI patterns) | exact |
| EXTEND `scripts/vault-flip.ts` (add `--enable-mutations` + seed event flow) | CLI (settings flip + seed event emit) | DB read + file-I/O write | the same file's existing `flipCampaign()` + drizzle update flow | exact (extend in place) |
| EXTEND `package.json` (`vault:backup`, `vault:rebuild-views`) | config | n/a | existing `"vault:flip": "tsx scripts/vault-flip.ts"` entry | exact |

### NEW tests (under `tests/`)
| File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `tests/ai/master/vault/events-schema.test.ts` | unit test | transform | `tests/ai/master/vault/tools.test.ts` (describe/it blocks, `toEqual` for happy paths, focused validator-rejection cases) | exact |
| `tests/ai/master/vault/campaign-paths.test.ts` | unit test | transform | `tests/ai/master/vault/path.test.ts` (mkdtemp + rm cleanup, env override via `vi.stubEnv`, traversal rejection table) | exact |
| `tests/ai/master/vault/events-writer.test.ts` | integration (filesystem + concurrency) | file-I/O | `.planning/spikes/010-events-md-concurrency/stress.ts` (Promise.all + uniqueness check) ported into the `tests/ai/master/vault/path.test.ts` setup pattern | exact lift |
| `tests/ai/master/vault/projector.test.ts` | unit test (pure reducer) + integration (view write) | transform + file-I/O | `.planning/spikes/008-events-md-replay/replay.ts` test loop ported to vitest; `tests/ai/master/vault/path.test.ts` for setup style | exact lift |
| `tests/ai/master/vault/apply-event-integration.test.ts` | integration (end-to-end dispatch → events.md → view → DR roundtrip) | file-I/O + request-response | `tests/ai/master/vault/tools.test.ts` dispatcher test pattern + `.planning/spikes/013-vault-backup-restore/run-backup-restore.ts` DR test | exact lift |
| `tests/ai/master/vault/events-writer-stress.test.ts` | integration (high-N stress + truncated-tail recovery) | file-I/O | `.planning/spikes/010-events-md-concurrency/stress.ts` (already a stress harness) + the new `events-writer.test.ts` from plan 02-03 | exact lift |
| `tests/lib/preferences-vault-mutations.test.ts` | unit test (validator + resolver) | transform | `tests/lib/preferences-master-backend.test.ts` (THE template — same shape) | exact |
| `tests/sessions/turn-tool-call-cap.test.ts` | unit test (constants + tool loop cap) | transform + request-response | `tests/ai/master/vault/loop.test.ts` (scriptedProvider mock pattern) | exact (extract scriptedProvider helper) |
| `tests/sessions/vault-mutations-gate.test.ts` | unit test (branch coverage for turn-route flag) | request-response | `tests/sessions/turn-route-branch.test.ts` (THE template — quadrant assertions on backend × flag) | exact |
| `tests/sessions/vault-mutations-resume.test.ts` | integration (restart via `vi.resetModules`) | file-I/O + transform | `tests/ai/master/vault/path.test.ts` (env stub + mkdtemp) + projector test from plan 02-04 | role-match |
| `tests/scripts/vault-backup.test.ts` | integration (CLI subprocess) | request-response | `tests/scripts/migrate-handbook-to-vault.test.ts` (per the plan 02-10 read_first) — fallback to `tests/sessions/turn-route-branch.test.ts` for env stubs | role-match (no exact scripts/ test analog in vault domain) |

### EXTEND existing tests
| File | Why | Analog |
|---|---|---|
| `tests/ai/master/vault/tools.test.ts` | bump 3→4, add apply_event dispatch cases | the file's own Phase 01 cases (lines 12-40 for definition shape; 42-106 for dispatch happy/error paths) |
| `tests/ai/master/vault/loop.test.ts` | add apply_event branch case (forwarding campaignId) | the file's own `scriptedProvider` mock pattern |
| `tests/ai/master/vault/phase-smoke.test.ts` | invert `not.toContain('apply_event')` → `toContain('apply_event')`; bump `toHaveLength(3)` → `toHaveLength(4)` | the file's existing barrel-smoke shape (~50 LOC total) |
| `tests/sessions/turn-route-branch.test.ts` | invert "exactly 3 tools" → "exactly 4 tools"; remove `not.toContain('apply_event')` | the file itself — surgical line edits |

### NEW doc
| File | Role | Closest Analog |
|---|---|---|
| `docs/operators/vault-backup.md` | operator runbook | NO existing `docs/operators/*` file in repo at planning time — Phase 02 establishes the precedent; follow the structure documented in plan 02-10 Task 6 (sections: Backup, Recovery DR, Single-write coexistence, Correction policy, Multi-process safety, Storage budget, Phase 03 follow-ups). |

### NEW phase doc (final wrap-up)
| File | Role | Closest Analog |
|---|---|---|
| `.planning/phases/02-vault-write-path-event-sourcing/SUMMARY.md` | phase closure doc | `.planning/phases/01-vault-read-path/SUMMARY.md` (THE template — mirror section structure verbatim) |

---

## Pattern Assignments

### `src/ai/master/vault/events-schema.ts` (NEW — type-guard module, pure transform)

**Analog:** `src/ai/master/vault/tools.ts` (style + JSDoc style) + skill page `.claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md` (the discriminated-union pattern, lines 82-100).

**Module-header / REQ-citation pattern** (from `tools.ts` lines 1-16):
```typescript
import type { ToolDef } from '@/ai/provider/types';
import { listVaultDir, readVaultFile } from './path';

/**
 * REQ-010 — Fixed 4-tool surface (3 of 4 in Phase 01; `apply_event` arrives in Phase 02).
 * REQ-011 — NEVER expose singular `read_vault(path)`. Only batched `read_vault_multi`.
 * REQ-013 — Server accepts both turn terminators (`end_turn` tool call AND
 *           `no_tool_calls + content`). This module defines the `end_turn` tool;
 *           the dual-terminator handling is in the loop module (plan 04).
 *
 * Tool definitions are in the canonical Anthropic-shaped form (`ToolDef =
 * Anthropic.Messages.Tool`). [...]
 */
```
**KEEP:** REQ refs at top, citation of spike/skill page, JSDoc above each export.
**ADAPT:** Use REQ-005 / REQ-010 + spike 008 citation. Zero imports (pure logic per plan 02-01 grep gate `grep -c "import" → 0`).

**Discriminated union pattern** (from `.planning/spikes/008-events-md-replay/replay.ts` lines 9-14):
```typescript
type Event =
  | { type: "hp_change"; delta: number }
  | { type: "condition_add"; condition: string }
  | { type: "condition_remove"; condition: string }
  | { type: "spell_slot_use"; level: number }
  | { type: "spell_slot_restore"; level: number };
```
**KEEP:** Each member as `{ type: '<literal>'; payload: {...} }`.
**ADAPT:** Wrap payload in `payload: {...}` (the spike used flat shapes; Phase 02 separates envelope from payload). Add 3 more types (`inventory_add`, `inventory_remove`, `campaign_initialized`). The seed `campaign_initialized` payload uses `VaultSeedCharacter[]` with OPTIONAL `hp_current` and `spell_slots` per the live Postgres reality.

---

### `src/ai/master/vault/campaign-paths.ts` (NEW — path resolver utility)

**Analog:** `src/ai/master/vault/path.ts` (whole file is the model — same module reads VAULT_CAMPAIGNS_ROOT at module load; same pattern of named exports + safe-path helper).

**Module-load env read** (from `path.ts` lines 14-28):
```typescript
/**
 * DYNAMIC campaign data root — `events.md` + materialized views per campaign.
 *
 * REQ-007 mandates this lives OUTSIDE the codebase repo [...]
 *   1. `VAULT_CAMPAIGNS_ROOT` env var (operator override)
 *   2. `~/.dnd-ai-master/vault/campaigns/` (home-based default)
 */
export const VAULT_CAMPAIGNS_ROOT = process.env.VAULT_CAMPAIGNS_ROOT
  ? resolve(process.env.VAULT_CAMPAIGNS_ROOT)
  : join(homedir(), '.dnd-ai-master', 'vault', 'campaigns');
```
**KEEP:** Import `VAULT_CAMPAIGNS_ROOT` from `./path` (do NOT re-read env in this module).
**ADAPT:** Build `campaignDir(uuid)` / `eventsPath(uuid)` / `characterViewPath(uuid, name, charId)` on top of the existing constant.

**Path-safety pattern** (from `path.ts` lines 42-80 `safeVaultPath`):
```typescript
// Strip leading slashes so the LLM-provided "/handbook/foo.md" and
// "handbook/foo.md" forms both resolve under root.
const stripped = input.replace(/^\/+/, '');
const candidate = normalize(join(root, stripped));

// Lexical guard: candidate must be the root itself OR a child path.
// `path.sep` boundary prevents `/data/vault-evil` from passing a naive prefix.
const rootWithSep = root.endsWith('/') ? root : root + '/';
if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
```
**KEEP:** `path.resolve` + path-prefix invariant assertion.
**ADAPT:** Phase 02 adds a UUID regex front-gate (`UUID_REGEX.test()` → throw) so any non-UUID input fails closed before touching the filesystem. Slug helper for character names follows the spec in plan 02-02 (NFD normalize + diacritic strip + `[^a-z0-9-]` replace; if-empty → `'unnamed'`).

---

### `src/ai/master/vault/events-writer.ts` (NEW — single-writer mutex)

**Analog:** `.planning/spikes/010-events-md-concurrency/writer.ts` (direct verbatim lift target — 35 lines, validated 100/100 in 7ms).

**Full module excerpt** (the entire spike file, lines 1-35):
```typescript
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Single-writer queue per file path. Serializes concurrent appends.
 *
 * Note: this is in-process only — multi-process safety requires flock or a
 * separate writer daemon. For dnd-ai-master's single-Next.js-server scenario,
 * in-process mutex is sufficient.
 */
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
      // Cleanup map entry if we're still the head (no one chained after us)
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
**KEEP:** Literally everything — the algorithm is locked by 100/100 spike validation. Change ONLY:
- Add the multi-paragraph module-header JSDoc citing REQ-005 + spike 010 + NON-REQ-001 (multi-process out of scope) + the path-canonicalization invariant noted by plan 02-03 (callers MUST pass `eventsPath(...)` which already `resolve()`s).
- Convert string quotes to project style if linter requires (`"` → `'` per the rest of `src/ai/master/vault/`).
**ADAPT:** Nothing structural.

---

### `src/ai/master/vault/projector.ts` (NEW — pure reducer + view writer)

**Analog:** `.planning/spikes/008-events-md-replay/replay.ts` (the reducer + serializer pattern, ~165 lines total) + the pure-function module shape from `src/ai/master/vault/path.ts`.

**Reducer pattern** (from `replay.ts` lines 43-66):
```typescript
function applyEvent(state: CharacterState, event: Event): CharacterState {
  const next = structuredClone(state);
  switch (event.type) {
    case "hp_change":
      next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + event.delta));
      return next;
    case "condition_add":
      if (!next.conditions.includes(event.condition)) next.conditions.push(event.condition);
      return next;
    [...]
    case "spell_slot_use": {
      const slot = next.spell_slots[event.level];
      if (slot && slot.used < slot.max) slot.used += 1;
      return next;
    }
    [...]
  }
}
```
**KEEP:** `structuredClone(state)`; switch on `event.type`; HP clamp `Math.max(0, Math.min(hp_max, ...))`; immutability discipline; `default:` arm.
**ADAPT:**
- Payload nesting: `event.payload.delta` instead of `event.delta` (the spike used flat shapes; Phase 02 uses `{type, payload}`).
- Add `default:` exhaustiveness arm with `const _exhaustive: never = event;` + `console.warn` (Pitfall 6 — graceful degradation on unknown types).
- Add `inventory_add` / `inventory_remove` arms (spike-008 did not cover inventory).
- Add `campaign_initialized` no-op arm (seed handling is done in `replayEvents`, not `applyEvent`).
- Sort `next.conditions` and `next.inventory` for deterministic byte-stable view output (spike 013 byte-exact restore depends on this).

**Serialization pattern** (from `replay.ts` lines 76-93):
```typescript
function serializeCharacter(state: CharacterState): string {
  const slotLines = Object.entries(state.spell_slots)
    .map(([lvl, s]) => `  ${lvl}: { max: ${s.max}, used: ${s.used} }`)
    .join("\n");
  return `---
name: Aragorn
hp_current: ${state.hp_current}
hp_max: ${state.hp_max}
conditions: [${state.conditions.join(", ")}]
spell_slots:
${slotLines}
---

# Aragorn

Replayed character sheet from events.md.
`;
}
```
**KEEP:** Hand-rolled YAML emitter (NO `yaml` package dep); deterministic ordering; clear `---` frontmatter delimiters.
**ADAPT:** Use `lines: string[]` + `push` + `join('\n')` pattern (matches `prompt-builder.ts` byte-stability discipline; see analog below). Use the keys defined in plan 02-04 Task 1 Action 8: `id`, `name`, `hp_current`, `hp_max`, `conditions`, `spell_slots`, `inventory`, `last_event_id`, `last_updated`. Sort `Object.keys(state.spell_slots)` and `state.inventory.sort()` for byte stability.

**Pure-function discipline** (cross-reference `src/ai/master/vault/prompt-builder.ts` lines 31-54): the projector must contain ZERO `Date.now()`, `Math.random()`, `process.env` reads. The plan 02-04 acceptance criteria grep gate `grep -c "Date.now\|Math.random\|process.env" → 0` enforces this.

---

### `src/ai/master/vault/tools.ts` (EXTEND — add 4th tool + 4th dispatch branch + root routing)

**Analog:** the existing 3 entries / 3 branches IN THE SAME FILE.

**Tool definition shape** (from the file, lines 36-46):
```typescript
{
  name: 'list_vault',
  description: 'List immediate children of a vault directory.',
  input_schema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Vault directory path' },
    },
    required: ['directory'],
  },
},
```
**KEEP:** Same `name` / `description` / `input_schema.{type, properties, required}` shape.
**ADAPT:** Replace existing trailing comment `// apply_event is Phase 02 — intentionally omitted` with the 4th entry. Description: per RESEARCH §6 (verbatim from skill `references/tool-surface.md`). NIT 1: payload description explicitly says "`character` is the character UUID — NOT the character name".

**Dispatch branch shape** (from the file, lines 121-132 — `list_vault` branch, the closest in structure to apply_event):
```typescript
if (name === 'list_vault') {
  const raw = (input ?? {}) as { directory?: unknown };
  if (typeof raw.directory !== 'string') {
    return { content: 'ERROR: list_vault requires a string `directory` argument', isError: true };
  }
  const children = await listVaultDir(raw.directory, vaultRoot);
  if (children.length === 0) {
    return { content: '(no children or path not found)', isError: false };
  }
  const body = `Children of ${raw.directory}:\n` + children.map((c) => `- ${c}`).join('\n');
  return { content: body, isError: false };
}
```
**KEEP:**
- Input cast pattern: `const raw = (input ?? {}) as { ... };`.
- Per-field `typeof` check returning `isError: true` with `'ERROR: <reason>'` literal-marker content (Phase 01 contract — see also `path.ts` lines 91-98 for the same pattern in `readVaultFile`).
- Branch never throws — all errors surface as marker strings.
**ADAPT:** Three validation gates before any write (in order): (1) input shape, (2) campaignId present in ctx, (3) `UUID_REGEX.test(ctx.campaignId)`. Then `validateEvent(raw)` (plan 02-01). Then construct envelope, `EventsWriter.applyEvent(...)`, `regenerateAffectedViews(...)`. Wrap the write+regenerate in a try/catch that converts any thrown error into `{ content: 'ERROR: apply_event failed during persist: <msg>', isError: true }`.

**Decision 4 — root routing for `read_vault_multi` and `list_vault`:** the existing dispatch passes `vaultRoot` to `readVaultFile`/`listVaultDir`. Promote the test-seam `root` parameter to production by inspecting the path prefix:
```typescript
const stripped = pathStr.replace(/^\/+/, '');
const isCampaignPath = stripped.startsWith('campaigns/');
const effectiveRoot = isCampaignPath ? VAULT_CAMPAIGNS_ROOT : vaultRoot;
const effectivePath = isCampaignPath ? '/' + stripped.slice('campaigns/'.length) : pathStr;
const content = await readVaultFile(effectivePath, effectiveRoot);
```

---

### `src/ai/master/vault/index.ts` (EXTEND — barrel export)

**Analog:** the file itself (9 lines, lines 1-9).
```typescript
// Barrel export for the markdown vault layer (Phase 01 — vault-llm-wiki migration).
// See .planning/phases/01-vault-read-path/PLAN.md for the design overview.
// Note: VAULT_CAMPAIGNS_ROOT is exported here for Phase 02 consumers;
// it is unused at runtime in Phase 01 (vault is read-only).
export * from './path';
export * from './prompt-builder';
export * from './tools';
export * from './loop';
```
**KEEP:** Same comment style + `export * from './<file>';` lines.
**ADAPT:** Append:
```typescript
export * from './events-schema';
export * from './events-writer';
export * from './projector';
export * from './campaign-paths';
// Re-export from preferences for convenience (the Phase 02 dispatch surface
// is gated on this resolver from src/lib/preferences.ts).
export { resolveVaultMutations } from '@/lib/preferences';
```

---

### `src/ai/master/vault/loop.ts` (EXTEND — VaultLoopInput.campaignId)

**Analog:** the existing `VaultLoopInput` interface (lines 39-56) + destructure (lines 67-77) + dispatch calls (~139, ~186).

**Existing destructure pattern** (lines 67-77):
```typescript
const {
  provider,
  model,
  systemBlocks,
  history,
  vaultRoot,
  recordUsage,
  onEvent,
  sessionId,
  campaignLanguage,
} = input;
const toolCallCap = input.toolCallCap ?? TURN_TOOL_CALL_CAP;
const turnTimeoutMs = input.turnTimeoutMs ?? TURN_TIMEOUT_MS;
```
**KEEP:** Destructure all `VaultLoopInput` fields at the top of the function.
**ADAPT:** Add `campaignId` to the destructure list. Forward it in BOTH `dispatchVaultTool` calls (`{ vaultRoot, campaignId }`). Also swap `TURN_TOOL_CALL_CAP` → `VAULT_TURN_TOOL_CALL_CAP` per plan 02-06 Task 2.

---

### `src/ai/master/vault/prompt-builder.ts` (EXTEND — vaultMutations input + applyEventMention)

**Analog:** the file itself (lines 17-54).

**Input interface + line-array build pattern** (lines 17-54):
```typescript
export interface VaultPromptInput {
  vaultRoot: string;
  campaignId: string;
  toolCount: number;
  language?: string;
}

export function buildVaultSystemPrompt(input: VaultPromptInput): string {
  const lines: string[] = [
    'You are an experienced D&D 5e Dungeon Master.',
    [...]
    "If you don't know what tools exist, your FIRST action is to read /tools/index.md.",
    'After that, use any of the ' + input.toolCount + ' listed tools directly.',
    '',
  ];
  if (typeof input.language === 'string' && input.language.length > 0) {
    lines.push('Respond in language: ' + input.language + '.');
    lines.push('');
  }
  lines.push('Keep responses concise.');
  return lines.join('\n');
}
```
**KEEP:** Same line-array push + `join('\n')` pattern (byte-stability discipline); conditional clause guarded by `typeof === 'string'`; no template literals across newlines.
**ADAPT:** Add `vaultMutations?: boolean` to `VaultPromptInput`. Add an `applyEventMention` const ternary (per plan 02-08 Change 3) and `lines.push(applyEventMention)` only when non-empty. Add a consistency assertion (`vaultMutations:true` requires `toolCount: 4`; the symmetric error for `false`/`undefined` requires `3`). Citation: REQ-022 purity preserved — boolean input, no env/random/timestamp source. Forbidden-patterns scan (`__forbidden-patterns.ts`) must still pass with zero matches.

---

### `src/sessions/types.ts` (EXTEND — VAULT_TURN_TOOL_CALL_CAP)

**Analog:** the existing `TURN_TOOL_CALL_CAP` declaration at line 39.

```typescript
export const TURN_TOOL_CALL_CAP = 12;
// Wall-clock budget for the full tool loop (one turn = N model round-trips).
// gpt-5 with reasoning routinely takes 20-40s per round-trip [...]
export const TURN_TIMEOUT_MS = envPositiveInt('TURN_TIMEOUT_MS', 120000);
```
**KEEP:** `export const NAME = <number>;` form; multi-line JSDoc above documenting the rationale.
**ADAPT:** Insert IMMEDIATELY AFTER line 39, before `TURN_TIMEOUT_MS`. Cite Pitfall 4 + Decision 11 in the JSDoc.

---

### `src/db/schema/campaigns.ts` (EXTEND — CampaignSettings.vaultMutations)

**Analog:** the same file's `masterBackend?: MasterBackend` field at lines 65-72.

```typescript
/**
 * Phase 01 feature flag (vault-llm-wiki migration). Selects which
 * knowledge backend the master uses for this campaign.
 *  - 'baked' (default) → existing baked variant + RAG path [...]
 *  - 'vault'           → markdown-vault path [...]
 * When 'vault', game-state mutation is unavailable (Phase 02 adds apply_event).
 */
masterBackend?: MasterBackend;
```
**KEEP:** JSDoc above with bullet-list semantic enumeration.
**ADAPT:** Position the new field IMMEDIATELY AFTER `masterBackend?` (lexical proximity to its parent flag). Cite Decision 5 + Pitfall 5 in the JSDoc. Use `vaultMutations?: boolean` shape (NOT an enum — Decision 5 explicitly rejects extending `masterBackend` to a 3-value enum). The change is purely additive (existing `undefined` rows resolve to `false`).

---

### `src/db/schema/users.ts` (EXTEND — UserPreferences.vaultMutations, parallel-shape)

**Analog:** the same file's `UserPreferences` interface + the existing `masterBackend?` field on the same interface (Phase 01 plan 06 precedent).

**KEEP:** Same JSDoc + field declaration shape.
**ADAPT:** Add `vaultMutations?: boolean` per Phase 01's parallel-shape convention (every per-campaign settings field that lives on `CampaignSettings` also gets a "user default" arm on `UserPreferences`, even if the campaign-side resolver is authoritative). The acceptance criterion in plan 02-05 Task 2 grep gate covers this.

---

### `src/lib/preferences.ts` (EXTEND — 5 changes per plan 02-05 Task 2)

**Analog:** `resolveMasterBackend` (lines 116-130) + `validateSettingsPatch` masterBackend arm (lines 563-571) + `getCampaignSettings` Required-return shape (lines 367-386) + `DEFAULT_PREFERENCES` (lines 154-192).

**Resolver pattern** (lines 122-130):
```typescript
function envDefaultMasterBackend(): MasterBackend {
  const raw = (process.env.MASTER_BACKEND ?? '').trim().toLowerCase();
  return raw === 'vault' ? 'vault' : 'baked';
}

export function resolveMasterBackend(stored: MasterBackend | undefined): MasterBackend {
  if (stored === 'vault' || stored === 'baked') return stored;
  return envDefaultMasterBackend();
}
```
**KEEP:** `export function` + signature `(stored: T | undefined): T` shape; JSDoc citing the Phase + Decision.
**ADAPT:** `resolveVaultMutations` is BOTH-arg-aware (`masterBackend` AND `vaultMutations`) — return `false` unconditionally when `resolveMasterBackend(settings.masterBackend) !== 'vault'` (Pitfall 5 enforcement).

**Validator arm pattern** (lines 563-571):
```typescript
if ('masterBackend' in body) {
  if (body.masterBackend === undefined || body.masterBackend === null) {
    out.masterBackend = undefined;
  } else if (!isMasterBackend(body.masterBackend)) {
    return { ok: false, error: 'invalid-masterBackend' };
  } else {
    out.masterBackend = body.masterBackend;
  }
}
```
**KEEP:** `if (KEY in body)` + null/undefined-clear arm + typed-validation arm + assignment arm + error literal `'invalid-<key>'`.
**ADAPT:** For `vaultMutations`, the validation gate is `typeof body.vaultMutations !== 'boolean'` (instead of `isMasterBackend(...)`). Error literal `'invalid-vaultMutations'`.

---

### `src/app/api/sessions/[id]/turn/route.ts` (EXTEND — gate apply_event on resolveVaultMutations)

**Analog:** the file's existing vault branch (Phase 01 plan 07 insertion at lines 248-409 per the research doc).

**KEEP:** Vault branch already exists with `resolveMasterBackend(userPrefs.masterBackend)` call + `buildVaultSystemPrompt({...})` + `runVaultToolLoop({...})` chain.
**ADAPT:** Three additive changes per plan 02-08 Change 2-4:
1. Import `resolveVaultMutations` alongside `resolveMasterBackend`.
2. After resolving `masterBackend`, add `const vaultMutationsEnabled = resolveVaultMutations(userPrefs);`.
3. Pass `toolCount: vaultMutationsEnabled ? 4 : 3` and `vaultMutations: vaultMutationsEnabled` to `buildVaultSystemPrompt`.
4. Conditional spread `...(vaultMutationsEnabled && { campaignId: campaign.id })` on `runVaultToolLoop({...})`.
5. Update the existing branch's leading comment block to document the (masterBackend, vaultMutations) quadrant table.

---

### `scripts/vault-backup.ts` (NEW — operator-driven backup CLI)

**Analog:** `scripts/vault-flip.ts` (the closest CLI in shape — tsx shebang, `_env-loader`, argv parsing, structured exits).

**Shebang + env loader + argv pattern** (from `vault-flip.ts` lines 1-42):
```typescript
#!/usr/bin/env tsx
/**
 * scripts/vault-flip.ts — toggle a campaign between `vault` and `baked`
 * backends without dropping into psql.
 *
 * Usage:
 *   pnpm vault:flip                          # list campaigns + their current backend
 *   pnpm vault:flip --id=<uuid> --to=vault   # set masterBackend=vault
 *   pnpm vault:flip --id=<uuid> --to=baked   # set masterBackend=baked
 * [...]
 */
import './_env-loader';
[...]

interface Args {
  id: string | null;
  to: MasterBackend | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { id: null, to: null };
  for (const a of argv) {
    if (a.startsWith('--id=')) args.id = a.slice('--id='.length);
    else if (a.startsWith('--to=')) {
      const raw = a.slice('--to='.length);
      if (!isMasterBackend(raw)) {
        console.error(`Invalid --to=${raw}. Use 'vault' or 'baked'.`);
        process.exit(2);
      }
      args.to = raw;
    }
  }
  return args;
}
```
**KEEP:** `#!/usr/bin/env tsx` shebang, `import './_env-loader';` first import line, multi-paragraph JSDoc with Usage block, `interface Args` + `parseArgs` pattern with `process.exit(2)` on invalid input, `console.error(...)` for errors.
**ADAPT:**
- Args: `--strategy=git|tarball`, `--push` (git only), `--keep=N` (tarball only). Default strategy per plan 02-10 Task 1 checkpoint.
- For the git strategy: use `execSync` from `node:child_process` with `{ stdio: 'inherit' }` for `git init` / `git add` / `git commit` / `git push`.
- T-02-06 defense: `git diff --unified=0 HEAD -- "*.md"` and check for `^-[^-]` lines (means a removed line — events.md is append-only, so removals indicate non-append edits → refuse).
- For tarball: `execSync('tar', ['-czf', out, '-C', parent, basename])` + `~/Backups/dnd-ai-master/` location + rotation by mtime.
- Main wrapped in try/catch → `console.error(err); process.exit(1);`.

**vault-flip's `main()` shape** (lines 149-169):
```typescript
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  [...]
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('vault-flip failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```
**KEEP:** Same `main()` wrap + catch. Note: `vault-backup.ts` does NOT need `pool.end()` (no DB connection).

---

### `scripts/vault-rebuild-views.ts` (NEW — recovery / DR script)

**Analog:** `scripts/vault-flip.ts` (argv + tsx style) + the new `vault-backup.ts` from Task 2 above.

**KEEP:** Same shebang, `_env-loader` import, argv parsing for `--campaign=<uuid>`.
**ADAPT:**
- Validate UUID via `UUID_REGEX.test(...)` (from `@/ai/master/vault/campaign-paths`).
- Use `regenerateCharacterView` / `replayEvents` / `parseEventsFile` from `@/ai/master/vault/projector` (plan 02-04 exports).
- Multi-campaign flow: `readdirSync(VAULT_CAMPAIGNS_ROOT)` + filter to UUID-shaped subdirs.
- Progress logs: `[rebuild] <id>: <n> events → <m> characters`.
- No DB write — pure filesystem operation. The script does NOT need `pool.end()`.

---

### EXTEND `scripts/vault-flip.ts` (add `--enable-mutations` flag + seed event flow)

**Analog:** the file's existing `flipCampaign()` function (lines 110-147) and the `Args` + `parseArgs` pattern at lines 23-42.

**KEEP:** Same `interface Args` structure + `parseArgs` parsing — just add two new boolean fields (`enableMutations`, `disableMutations`).

**ADAPT (the new seed-event flow, plan 02-10 Task 4):**
1. After the existing `db.update` that sets `masterBackend`, add a conditional block when `args.enableMutations === true`:
   - Merge `{vaultMutations: true}` into `campaign.settings` and write back.
   - **Critical: `hp_current` lives on `session_state.hpCurrent`, NOT on `characters`.** Use a drizzle `leftJoin` from `characters` → `sessions` → `sessionState`, ordered by `sessions.updatedAt DESC` for most-recent active session. JS-side dedup via `Array.from(new Map(rows.map((r) => [r.id, r])).values())`.
   - Build `payloadCharacters: VaultSeedCharacter[]` with OPTIONAL fields:
     - `hp_current` included only when `r.hpCurrent !== null && Number.isInteger(...)`, clamped to `[0, r.hpMax]`.
     - `spell_slots` assembled by merging `r.spellcasting?.slotsMax` (per-level cap) with `r.spellSlotsUsed ?? {}` (per-level used counter); skip entirely when non-caster (`spellcasting === null`) or empty merged record.
   - Build the envelope (`{id: randomUUID(), version: EVENT_SCHEMA_VERSION, type: 'campaign_initialized', payload: {characters: payloadCharacters}, timestamp: new Date().toISOString()}`).
   - `await EventsWriter.applyEvent(eventsPath(campaign.id), envelope);` then `await regenerateAffectedViews(campaign.id, envelope);`.
   - Log per-character status (with `hp_current=hp_max(N) (no session_state row)` annotation when fallback fires).
2. Add Pitfall-5 warning: if `args.enableMutations && campaign.settings?.masterBackend !== 'vault'`, print `WARN: enabling vaultMutations on a baked campaign — flag has no effect [...]`.
3. Negative grep guard (plan 02-10 acceptance criterion): `grep -c "characters.hp_current\|characters\\.hpCurrent" scripts/vault-flip.ts` MUST return 0 (BLOCKER 1 defense — the wrong column is never referenced).

---

### `tests/ai/master/vault/events-schema.test.ts` (NEW — pure validator tests, no DB)

**Analog:** `tests/ai/master/vault/tools.test.ts` for describe/it shape + table-driven `it.each` from `tests/ai/master/vault/path.test.ts`.

**describe/it shape with explicit type narrowing** (from `tools.test.ts` lines 12-40):
```typescript
describe('VAULT_TOOL_DEFINITIONS shape', () => {
  it('contains exactly 3 tools (apply_event arrives in Phase 02)', () => {
    expect(VAULT_TOOL_DEFINITIONS).toHaveLength(3);
    expect(VAULT_TOOL_COUNT).toBe(3);
  });

  it('names are read_vault_multi, list_vault, end_turn', () => {
    const names = VAULT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['read_vault_multi', 'list_vault', 'end_turn']);
  });
  [...]
});
```
**KEEP:** Top-level `describe` per surface; nested `it` per assertion; `expect().toEqual` for sets/arrays; explicit unique-set + length checks (plan 02-01 Task 2 acceptance criteria).
**ADAPT:** For the validator happy-path/rejection table, use the narrowing pattern (`if (r.ok) { ... type narrowed to VaultEvent ... }`). The seed event covers THREE happy-path variants per the OPTIONAL-fields contract from plan 02-01: minimum / hp_current present / full shape.

**Verify NO DB dependency:** `unset DATABASE_URL; pnpm test ...` must exit 0 (the grep gate `grep -c "@/db/\\|@/lib/preferences"` returns 0).

---

### `tests/ai/master/vault/campaign-paths.test.ts` (NEW — path resolver tests)

**Analog:** `tests/ai/master/vault/path.test.ts` (env override via `vi.stubEnv`, mkdtemp + rm cleanup, traversal rejection table).

**Env override + dynamic import** (from `path.test.ts` style + plan 02-02 Task 2 Action):
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeVaultPath, [...] } from '@/ai/master/vault/path';

describe('vault/path', () => {
  let root: string;
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-path-test-'));
    root = join(dir, 'vault');
    [...]
  });
  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });
```
**KEEP:** mkdtemp + rm pattern; named `'gsd-test-vault-'` prefix when scoping to Phase 02; `beforeEach` / `afterEach` pair for per-test isolation when env stubs are involved.
**ADAPT:** Use `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', testDir)` + `vi.resetModules()` + dynamic `await import(...)` so the new module's module-load env read fires against the stub (this is the test seam path.ts already uses for VAULT_CAMPAIGNS_ROOT).

**Traversal-rejection table pattern** (from `path.test.ts` lines 55-65):
```typescript
describe('safeVaultPath — rejects traversal', () => {
  it.each([
    ['../etc/passwd'],
    ['/handbook/../../etc/passwd'],
    [...]
  ])('rejects %s', async (input) => {
    const result = await safeVaultPath(input, root);
    expect(result).toBeNull();
  });
});
```
**KEEP:** `it.each([...])('rejects %s', ...)` pattern for the UUID-regex rejection cases (plan 02-02 Task 2 case "rejects non-UUID strings"). Use `expect(() => fn()).toThrow(/UUID/)` for the throwing cases.

---

### `tests/ai/master/vault/events-writer.test.ts` (NEW — concurrency + isolation + error path)

**Analog:** `.planning/spikes/010-events-md-concurrency/stress.ts` (the harness) + `tests/ai/master/vault/path.test.ts` (mkdtemp + rm pattern).

**Promise.all + uniqueness check pattern** (from `.planning/spikes/010-events-md-concurrency/stress.ts`, the spike's core invariant):
```typescript
const N = 100;
const path = join(testDir, 'events.md');

await Promise.all(
  Array.from({ length: N }, (_, i) =>
    EventsWriter.applyEvent(path, { id: i, type: 'hp_change', payload: { delta: 1 } }),
  ),
);

const raw = await readFile(path, 'utf8');
const lines = raw.trim().split('\n');
expect(lines.length).toBe(N);

const parsed = lines.map((l) => JSON.parse(l));
const ids = new Set(parsed.map((e) => e.id));
expect(ids.size).toBe(N);  // 0 duplicates
for (let i = 0; i < N; i++) expect(ids.has(i)).toBe(true);  // 0 missing
```
**KEEP:** Verbatim — this is the spike-010 regression test ported into vitest.
**ADAPT:** Setup uses `mkdtempSync(join(tmpdir(), 'gsd-events-writer-'))` + `rmSync(testDir, {recursive:true,force:true})` per plan 02-03 Task 2 (sync versions because the test only uses sync setup; async setup would be equivalent). Add STRESS_N override (`.skip` when env unset). Add "isolation per path" describe (two paths split 5/5 from a 10-call Promise.all). Add "mutex release on error" describe (chmod 000 dir on macOS, `/proc/1` on linux for forced EACCES; verify a follow-up call to a different path proceeds).

---

### `tests/ai/master/vault/projector.test.ts` (NEW — purity + determinism + round-trip)

**Analog:** `.planning/spikes/008-events-md-replay/replay.ts` (the replay+corrupt test loop, lines 99-158) + the `tests/ai/master/vault/tools.test.ts` describe/it shape.

**Replay + corruption-fail-fast pattern** (from `replay.ts` lines 140-156):
```typescript
console.log("\n▶ Resilience test: corrupt event line 50");
const corruptedLines = [...lines];
corruptedLines[50] = "{ this is not json";
await writeFile(EVENTS_FILE, corruptedLines.join("\n") + "\n", "utf8");
let corruptedFailed = false;
let replayedCorrupt = structuredClone(INITIAL);
try {
  for (const line of corruptedLines) {
    replayedCorrupt = applyEvent(replayedCorrupt, deserializeEvent(line));
  }
} catch (e) {
  corruptedFailed = true;
}
```
**KEEP:** Inject corruption at a specific line, expect throw with line number in error message.
**ADAPT:** Vitest `await expect(parseEventsFile(path)).rejects.toThrow(/line 2/)` (or whichever line is corrupted). Cover both "truncated last line" and "fully corrupt middle line" cases.

**Purity assertion** (from `tests/ai/master/vault/path.test.ts` lines 153-158):
```typescript
it('source file contains no Date.now / Math.random calls', async () => {
  const src = await readFile(resolve(process.cwd(), 'src/ai/master/vault/path.ts'), 'utf8');
  expect(src).not.toMatch(/Date\.now\(/);
  expect(src).not.toMatch(/Math\.random\(/);
});
```
**KEEP:** Static `readFileSync` + regex assertion.
**ADAPT:** Apply to `src/ai/master/vault/projector.ts` (the projector must be PURE — also forbid `process.env`).

**Three Postgres-reality describe blocks** (per plan 02-04 Task 2 Action 1):
- `INITIAL_CHARACTER_STATE` happy-path with `hp_current` absent → falls back to `hp_max`.
- `INITIAL_CHARACTER_STATE` with `spell_slots` absent → falls back to `{}`.
- Mixed seed across two characters (one fresh / one played) → independent defaults.

---

### `tests/ai/master/vault/apply-event-integration.test.ts` (NEW — end-to-end + DR roundtrip + property test)

**Analog:** `tests/ai/master/vault/tools.test.ts` (dispatcher invocation pattern) + `.planning/spikes/013-vault-backup-restore/run-backup-restore.ts` (the DR roundtrip) + `.planning/spikes/008-events-md-replay/replay.ts` (the property test shape).

**KEEP:**
- Dispatcher invocation: `await dispatchVaultTool('apply_event', {...}, {campaignId})` matches `tools.test.ts` lines 57-65 pattern.
- `existsSync` / `readFile` post-conditions matching `tools.test.ts` lines 80-89.
- Property test: generate N random events with a fixed RNG seed, apply via dispatcher, snapshot view, replay directly via `replayEvents`, assert deeply equal.

**ADAPT:**
- Seed campaign with `campaign_initialized` event FIRST (helper `async function seedCampaign(campaignId, characters: VaultSeedCharacter[])` at top of file).
- DR roundtrip: `cp events.md events.md.backup` → overwrite view file with garbage → call `regenerateCharacterView` → byte-exact match check.
- REQ-007 isolation: stub both `VAULT_ROOT` and `VAULT_CAMPAIGNS_ROOT` to disjoint tmpdirs; assert writes happen ONLY under VAULT_CAMPAIGNS_ROOT.
- "Restart simulation": `vi.resetModules()` + re-import the modules + call `replayEvents` on the fresh module; assert post-restart state matches pre-restart.

---

### `tests/ai/master/vault/events-writer-stress.test.ts` (NEW — high-N stress + truncated-tail recovery)

**Analog:** `.planning/spikes/010-events-md-concurrency/stress.ts` directly (the spike harness, already a stress test).

**KEEP:** Promise.all + uniqueness check from the spike — verbatim. STRESS_N env override (default 1000, max 10000+ via `STRESS_N=10000`).

**ADAPT:**
- 4 axes per plan 02-09 Task 1:
  1. Direct writer N=1000 stress.
  2. Dispatch-layer N=100 stress (validates the projector regen survives concurrent load).
  3. Truncated-tail recovery (spike 008 fail-fast invariant ported).
  4. Multi-campaign isolation (5 campaigns × 100 events = 500 total, assert each campaign's events.md has 101 lines (1 seed + 100), no event_id cross-contamination).
- Wall-clock measurement: `wall_ms = Date.now() - start` AROUND a single `await Promise.all(...)` then `wall_ms / N < 50`. NEVER sum per-event timings (would be `N×` wall-clock under mutex serialization).

---

### `tests/lib/preferences-vault-mutations.test.ts` (NEW — validator + resolver tests)

**Analog:** `tests/lib/preferences-master-backend.test.ts` (the EXACT template — same shape).

**Resolver test pattern** (from `preferences-master-backend.test.ts` lines 9-48):
```typescript
describe('resolveMasterBackend (Phase 01 vault-llm-wiki feature flag)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to baked when no stored value and no env override', () => {
    vi.stubEnv('MASTER_BACKEND', '');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('returns the env override when no stored value', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend(undefined)).toBe('vault');
  });
  [...]
});
```
**KEEP:** `beforeEach(() => vi.unstubAllEnvs())`; one `it` per truth-table row; assertions via `toBe(true)` / `toBe(false)`.
**ADAPT:**
- Quadrants: (masterBackend=vault, baked) × (vaultMutations=true, false, undefined) — 6 cases.
- **The KEY assertion** (Pitfall 5): `resolveVaultMutations({masterBackend: 'baked', vaultMutations: true})` → `false`.
- Validator arm: 7 cases mirroring `preferences-master-backend.test.ts` lines 67-95 (`'invalid-vaultMutations'` for non-boolean inputs).

---

### `tests/sessions/turn-tool-call-cap.test.ts` (NEW — constants + cap separation)

**Analog:** `tests/ai/master/vault/loop.test.ts` (the `scriptedProvider` mock pattern at lines 21-46).

**scriptedProvider helper pattern** (verbatim from `loop.test.ts` lines 21-46):
```typescript
function scriptedProvider(responses: (
  | { contentBlocks: ContentBlock[]; deltas?: string[]; sleepMs?: number }
)[]): MasterProvider {
  let idx = 0;
  return {
    name: 'anthropic',
    async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
      const entry = responses[idx];
      idx += 1;
      if (!entry) throw new Error(`scriptedProvider: no response queued for call #${idx}`);
      [...]
      return {
        contentBlocks: entry.contentBlocks,
        stopReason: entry.contentBlocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: EMPTY_USAGE,
      };
    },
    [...]
  } as unknown as MasterProvider;
}
```
**KEEP:** Copy verbatim into the new file (or factor into a shared helper later).
**ADAPT:**
- Constants asserts: `TURN_TOOL_CALL_CAP === 12` AND `VAULT_TURN_TOOL_CALL_CAP === 20` AND they are distinct.
- "does not truncate at 20 tool calls" — mock provider returns 20 tool_use responses; `runVaultToolLoop` completes without `truncated: true`.
- Static check that `src/ai/master/tool-loop.ts` (baked path) still imports `TURN_TOOL_CALL_CAP` and NOT `VAULT_TURN_TOOL_CALL_CAP`.

---

### `tests/sessions/vault-mutations-gate.test.ts` (NEW — turn-route 4-quadrant branch coverage)

**Analog:** `tests/sessions/turn-route-branch.test.ts` (the existing branch-coverage test, lines 23-118).

**Quadrant assertions** (from `turn-route-branch.test.ts` lines 23-47):
```typescript
describe('turn-route vault branch — resolveMasterBackend behaviour', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses baked when neither stored nor env are set', () => {
    vi.stubEnv('MASTER_BACKEND', '');
    expect(resolveMasterBackend(undefined)).toBe('baked');
  });

  it('uses env override when no stored value', () => {
    vi.stubEnv('MASTER_BACKEND', 'vault');
    expect(resolveMasterBackend(undefined)).toBe('vault');
  });
  [...]
});
```
**KEEP:** Same `describe('turn-route vault branch — <topic>')` shape, env stub + restore pattern.
**ADAPT:** Mock `getSessionMasterPreferences` to return each of the 4 (masterBackend, vaultMutations) quadrants; spy on `runVaultToolLoop` and `runToolLoop`; assert which loop is called + whether `campaignId` is included in the args + assert the prompt's `toolCount` (3 or 4) + presence/absence of `'apply_event'` mention in the system prompt.

---

### `tests/sessions/vault-mutations-resume.test.ts` (NEW — restart preserves state via replay)

**Analog:** `tests/ai/master/vault/path.test.ts` (env stub + mkdtemp setup) + projector test from plan 02-04 + the new `apply-event-integration.test.ts` "restart simulation" case.

**KEEP:** Same tmpdir setup, env stub via `vi.stubEnv`, dynamic re-import.
**ADAPT:**
- Use `VaultSeedCharacter` imports (not ad-hoc shapes) — the grep gate `grep -c "VaultSeedCharacter" → ≥ 1` enforces this.
- THREE fixture variants (BLOCKER 1 ground truth):
  - Freshly-created campaign (no `hp_current`, no `spell_slots` in seed) → projector defaults to `hp_max` and `{}`.
  - Played-session campaign (`hp_current` + `spell_slots` populated) → projector uses seed values verbatim.
  - Mixed campaign (some chars fresh, some played) → defaults applied independently.
- `vi.resetModules()` to simulate Next.js restart.

---

### `tests/scripts/vault-backup.test.ts` (NEW — CLI subprocess test)

**Analog:** `tests/scripts/migrate-handbook-to-vault.test.ts` per the plan 02-10 Task 7 `read_first` (style reference for spawning tsx scripts). NOTE: at planning time the verifier confirmed `tests/scripts/` does NOT exist yet — the file `migrate-handbook-to-vault.test.ts` will be the first script test or may be created alongside this plan. Use the closest available analog (`tests/sessions/turn-route-branch.test.ts` for env stub patterns + `tests/ai/master/vault/path.test.ts` for `mkdtemp` setup).

**KEEP:** `child_process.spawnSync('tsx', ['scripts/vault-backup.ts', ...args])` invocation; env override via `{...process.env, VAULT_CAMPAIGNS_ROOT: testDir, HOME: testHomeDir}`; assert `result.status === <code>` + `result.stderr.toString().includes(<msg>)`.
**ADAPT:**
- `it('refuses to commit when events.md has been hand-edited (T-02-06)')` — THE load-bearing case; assert exit 1 + stderr contains 'refuse' or 'non-append'.
- Tarball rotation test: pre-create N+1 tarballs (mtime spread), run backup, assert oldest is deleted.

---

## Shared Patterns

### Pattern A: Module header with REQ + spike citations
**Source:** `src/ai/master/vault/tools.ts` lines 1-16; `src/ai/master/vault/path.ts` lines 5-12.
**Apply to:** Every NEW source module under `src/ai/master/vault/` (events-schema.ts, campaign-paths.ts, events-writer.ts, projector.ts).
```typescript
/**
 * REQ-<NNN> — <one-line description>.
 *
 * <multi-paragraph rationale citing spike + the closest skill ref>.
 *
 * Source-of-truth: <path to spike or skill reference>
 */
```
**KEEP:** Multi-line JSDoc, REQ tags, spike citation (`.planning/spikes/<NNN>/...`), skill ref citation (`.claude/skills/spike-findings-dnd-ai-master/references/...`).
**ADAPT:** Match the citation per the plan's `<requirements>` frontmatter list.

### Pattern B: Literal-marker error contract (`'ERROR: <reason>'`)
**Source:** `src/ai/master/vault/path.ts` lines 91-98 (`readVaultFile`) + `src/ai/master/vault/tools.ts` line 124 (dispatcher).
**Apply to:** Every dispatch branch (apply_event branch in tools.ts), every read-helper, every script that talks to the LLM.
```typescript
if (code === 'ENOENT' || code === 'ENOTDIR') return `ERROR: file not found at ${input}`;
return `ERROR: cannot read ${input}`;
[...]
return { content: 'ERROR: list_vault requires a string `directory` argument', isError: true };
```
**KEEP:** `'ERROR: <message>'` literal string prefix + return-as-marker contract (NEVER throw — the LLM must see these as tool results).
**ADAPT:** Use `'ERROR: apply_event requires {type: string, payload: object}'` etc. per plan 02-07 Change 6.

### Pattern C: `vi.stubEnv` + dynamic re-import for module-load env reads
**Source:** `tests/ai/master/vault/path.test.ts` (the precedent for testing VAULT_CAMPAIGNS_ROOT env override).
**Apply to:** Every test that exercises `VAULT_CAMPAIGNS_ROOT` env override (campaign-paths.test.ts, projector.test.ts, apply-event-integration.test.ts, events-writer-stress.test.ts, vault-mutations-resume.test.ts).
```typescript
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gsd-<scope>-test-'));
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', testDir);
  vi.resetModules();  // forces module-load env read
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
// Then in each it block:
const mod = await import('@/ai/master/vault/campaign-paths');
```
**KEEP:** mkdtemp + rm cleanup, `vi.unstubAllEnvs` in afterEach, dynamic import.
**ADAPT:** Different `'gsd-<scope>-test-'` prefix per test file.

### Pattern D: Parallel-shape (Phase 01 precedent) for new settings fields
**Source:** Phase 01 plan 06 `masterBackend` flag — `src/db/schema/campaigns.ts` lines 65-72, `src/db/schema/users.ts` (same field on UserPreferences), `src/lib/preferences.ts` (DEFAULT_PREFERENCES + resolver + validator).
**Apply to:** `vaultMutations` flag across the same 3 places.
```typescript
// 1. CampaignSettings (campaigns.ts)
masterBackend?: MasterBackend;

// 2. UserPreferences (users.ts) — parallel-shape, even though it's per-campaign
masterBackend?: MasterBackend;

// 3. preferences.ts: DEFAULT_PREFERENCES + resolveMasterBackend + validateSettingsPatch arm
```
**KEEP:** Field in BOTH interfaces (CampaignSettings AND UserPreferences). DEFAULT_PREFERENCES has the default. Resolver function. validateSettingsPatch arm.
**ADAPT:** For `vaultMutations`, the resolver additionally enforces Pitfall 5 (returns `false` when `masterBackend !== 'vault'` regardless of stored value).

### Pattern E: REQ-022 forbidden-patterns enforcement (purity discipline)
**Source:** `src/ai/master/vault/__forbidden-patterns.ts` + `tests/ai/master/vault/prompt-builder.test.ts`.
```typescript
export const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Date.now',       re: /Date\.now\(/ },
  { name: 'new Date(',      re: /new\s+Date\(/ },
  { name: 'Math.random',    re: /Math\.random\(/ },
  { name: 'process.hrtime', re: /process\.hrtime/ },
  { name: 'randomUUID',     re: /randomUUID\(/ },
  { name: 'process.env',    re: /process\.env\./ },
  { name: 'hostname',       re: /\.hostname\(/ },
];
```
**Apply to:** `src/ai/master/vault/events-schema.ts` (events-schema is pure logic per plan 02-01 — zero imports, zero side effects); `src/ai/master/vault/projector.ts` (the reducer must be PURE — plan 02-04 grep gate explicitly forbids these patterns). The `__forbidden-patterns.ts` lint scan currently targets `prompt-builder.ts`; consider extending the lint scope OR adding a per-test grep-check in `projector.test.ts` (plan 02-04 already specifies this via `grep -c "Date.now\|Math.random\|process.env" → 0`).
**KEEP:** Same RegExp list.
**ADAPT:** The prompt-builder extension in plan 02-08 must still pass the existing lint scan with zero matches — the conditional `applyEventMention` text in plan 02-08 Change 3 uses only string concatenation, no env/random/timestamp.

### Pattern F: Tsx CLI script — shebang + `_env-loader` + `parseArgs` + `main()`
**Source:** `scripts/vault-flip.ts` lines 1-22, 23-42, 149-169.
**Apply to:** `scripts/vault-backup.ts`, `scripts/vault-rebuild-views.ts`, `scripts/vault-flip.ts` extension.
```typescript
#!/usr/bin/env tsx
/**
 * scripts/<name>.ts — <one-line description>.
 *
 * Usage:
 *   pnpm <script:name>                # <default behavior>
 *   pnpm <script:name> --<flag>=<val>  # <specific behavior>
 *
 * Uses `_env-loader` so it works wherever `vercel env pull` has populated [...]
 */
import './_env-loader';
// [other imports]

interface Args { /* ... */ }

function parseArgs(argv: string[]): Args {
  const args: Args = { /* init */ };
  for (const a of argv) {
    if (a.startsWith('--<flag>=')) args.<flag> = a.slice('--<flag>='.length);
    // ...
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // ... main flow ...
  await pool.end();  // ONLY if the script touches the DB
  process.exit(0);
}

main().catch((e) => {
  console.error('<script-name> failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
```
**KEEP:** Shebang, JSDoc Usage block, env-loader import first, structured exit codes (`process.exit(2)` for arg errors, `process.exit(1)` for runtime errors, `process.exit(0)` for success), `console.error` for diagnostics.
**ADAPT:** `vault-rebuild-views.ts` skips `pool.end()` (filesystem-only). `vault-backup.ts` skips `pool.end()` (only does `execSync('git', ...)` / tarball — no DB connection).

---

## No Analog Found

| File | Role | Reason |
|---|---|---|
| `tests/scripts/vault-backup.test.ts` | CLI subprocess test | NO `tests/scripts/` directory exists at planning time. The plan 02-10 `read_first` cites `tests/scripts/migrate-handbook-to-vault.test.ts` but this file does not yet exist (verified via `ls tests/sessions/` showing no `tests/scripts/`). The executor establishes the precedent — use `tests/ai/master/vault/path.test.ts` for setup style + `tests/sessions/turn-route-branch.test.ts` for env stubs, and import `spawnSync` from `node:child_process` for the tsx invocation. |
| `docs/operators/vault-backup.md` | operator runbook | NO `docs/operators/*` exists at planning time. Phase 02 establishes the precedent — follow the 8-section structure documented in plan 02-10 Task 6 Action verbatim. |

These two files have no codebase analog. The plan files (02-10 Tasks 6+7) provide complete, self-contained specifications — the executor must follow those plan sections literally rather than copying patterns from a sibling file.

---

## Metadata

**Analog search scope:**
- `src/ai/master/vault/` (all 6 existing Phase 01 source files)
- `src/db/schema/{campaigns.ts, users.ts}` (parallel-shape precedent for `masterBackend`)
- `src/lib/preferences.ts` (resolver + validator patterns)
- `src/scripts/vault-flip.ts` (CLI shape — note: the working copy of `vault-flip.ts` confirmed to be the same content as `scripts/vault-flip.ts` per the planning time `src/scripts/` listing)
- `scripts/{vault-flip.ts, db-snapshot.ts, _env-loader.ts}` (CLI patterns)
- `tests/ai/master/vault/` (all 5 existing Phase 01 test files)
- `tests/sessions/turn-route-branch.test.ts` (branch-coverage precedent)
- `tests/lib/preferences-master-backend.test.ts` (resolver + validator test precedent)
- `.planning/spikes/008-events-md-replay/replay.ts` (reducer + serializer + corruption-fail-fast)
- `.planning/spikes/010-events-md-concurrency/{writer.ts, stress.ts}` (mutex + stress harness)
- `.planning/spikes/013-vault-backup-restore/` (DR procedure)

**Files scanned:** 22+ (Phase 01 production files + 3 validated spike sources + 8 existing test files)
**Pattern extraction date:** 2026-05-25
