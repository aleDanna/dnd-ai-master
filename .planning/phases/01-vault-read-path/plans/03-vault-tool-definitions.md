# Plan 03: Vault Tool Definitions + Dispatcher

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** 01-vault-path-safety (`readVaultFile`, `listVaultDir`)
**Estimated diff size:** ~150 LOC source + ~90 LOC tests / 2 files

## Goal

Define the 3 Phase-01 vault tools as Ollama-shaped function definitions (`read_vault_multi`, `list_vault`, `end_turn`) and ship a single async `dispatchVaultTool(name, input, ctx)` that maps a tool call to its filesystem effect (or, for `end_turn`, the terminator value). The 4th tool, `apply_event`, is intentionally absent — Phase 02 adds it.

Tools are LIVE-only. They do NOT belong in `src/engine/tools/index.ts` (engine tools return `ActionResult { mutations, rolls, data }`; vault tools return raw strings — different contracts; mixing them invites the model to try engine tools on the vault path where they're not wired). The new module lives at `src/ai/master/vault/tools.ts`.

The `read_vault_multi` description explicitly says "Read MANY files in ONE call" to prevent the spike-009 regression where models emit multiple sequential `read_vault_multi({paths:[X]})` calls instead of one batched call. NEVER ship a singular `read_vault` definition (REQ-011 — see `tool-surface.md` lines 142-156).

## Requirements satisfied

- **REQ-010** Fixed 4-tool surface — this plan ships 3 of the 4 (no `apply_event` in Phase 01).
- **REQ-011** NEVER expose singular `read_vault(path)`.
- **REQ-013** Server accepts both terminators (`end_turn` tool call AND `no_tool_calls + content`). This plan defines the `end_turn` tool; the dual-terminator handling is in plan 04 (the loop).
- **REQ-014** Path sanitization on every read — `dispatchVaultTool` delegates to `safeVaultPath`/`readVaultFile`/`listVaultDir` from plan 01.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/tools.ts` | NEW | `VAULT_TOOL_DEFINITIONS` (Anthropic-shaped tool defs the local provider already knows how to translate via `anthropicToolToOllama`), `dispatchVaultTool`, `formatMultiReadResult`. |
| `tests/ai/master/vault/tools.test.ts` | NEW | Vitest: tool def shape, multi-read concatenation format, error markers, list result shape, end_turn passthrough. |
| `src/ai/master/vault/index.ts` | EDIT | Append `export * from './tools';`. |

## Tasks

1. **Create `src/ai/master/vault/tools.ts`.** Define:
   - `import type { ToolDef } from '@/ai/provider/types';` — the canonical Anthropic-shaped tool form already used by `runToolLoop`. The local provider's `anthropicToolToOllama` already translates this shape into Ollama's `{type:'function', function:{...}}` envelope — reusing the canonical shape means the vault path benefits from existing provider plumbing.
   - `export const VAULT_TOOL_DEFINITIONS: ToolDef[] = [...]` — three entries:
     - `read_vault_multi`: description literal `"Read MANY markdown files in ONE call. Pass an array of paths. Prefer this over multiple read_vault calls."` (the "Read MANY ... in ONE call" wording is load-bearing per spike 009 — DO NOT paraphrase). `input_schema`: `{ type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Array of vault paths to read' } }, required: ['paths'] }`.
     - `list_vault`: description `"List immediate children of a vault directory."`. Schema: `{ type: 'object', properties: { directory: { type: 'string', description: 'Vault directory path' } }, required: ['directory'] }`.
     - `end_turn`: description `"Conclude the turn with a final narrative response."`. Schema: `{ type: 'object', properties: { response: { type: 'string', description: 'The final narrative response to the player.' } }, required: ['response'] }`.
   - **No `apply_event` entry.** Comment in source: `// apply_event is Phase 02 — intentionally omitted in Phase 01 (vault is read-only for game state).`
   - `export const VAULT_TOOL_COUNT = VAULT_TOOL_DEFINITIONS.length;` — used by the prompt builder caller to compute the `toolCount` argument so the prompt and the tool array stay in sync.

2. **Define `formatMultiReadResult`.** Helper used by the dispatcher and exercised directly in tests:
   ```
   export function formatMultiReadResult(entries: { path: string; content: string }[]): string;
   ```
   Returns entries joined as `### ${path}\n\n${content}` blocks separated by `\n\n---\n\n` (spike 009 format). Stable, no sorting (preserves the model's requested order; supports the model interpreting earlier-requested files as more relevant).

3. **Define `dispatchVaultTool`.** Signature:
   ```
   export interface VaultDispatchContext { vaultRoot?: string; }
   export interface VaultDispatchResult {
     content: string;
     isError: boolean;
     /** Only set for end_turn — the final narrative the loop should commit. */
     endTurnResponse?: string;
   }
   export async function dispatchVaultTool(
     name: string,
     input: unknown,
     ctx?: VaultDispatchContext,
   ): Promise<VaultDispatchResult>;
   ```
   Behaviour:
   - `name === 'read_vault_multi'`:
     - Coerce input to `{ paths?: unknown }`. If `paths` is not an array OR is empty → `{ content: 'ERROR: read_vault_multi requires a non-empty paths array', isError: true }`.
     - For each path, call `readVaultFile(path, ctx?.vaultRoot)` (which already returns the error marker on bad paths). Build entries `[{path, content}]`. Return `formatMultiReadResult(entries)` as content; `isError: false` (individual file errors are surfaced inline so the model sees per-path status without aborting the batch — the spike-009 pattern).
     - Cap `paths.length` at 16 (spike 009 used up to 6; 16 is comfortable headroom for any conceivable single turn). If exceeded → return error marker.
   - `name === 'list_vault'`:
     - Coerce input to `{ directory?: unknown }`. If not a string → error marker.
     - Call `listVaultDir(directory, ctx?.vaultRoot)`. Format result as a newline-joined list with a header `Children of ${directory}:` then bullet items `- ${child}`. If empty: `(no children or path not found)`.
   - `name === 'end_turn'`:
     - Coerce input to `{ response?: unknown }`. Stringify to empty if missing. Return `{ content: '', isError: false, endTurnResponse: String(response ?? '') }` — the LOOP (plan 04) reads `endTurnResponse` to know to terminate; the `content` field is unused because `end_turn` does not feed a tool-result message back to the model.
   - `name === <anything else>`:
     - `{ content: 'ERROR: unknown vault tool: ' + name, isError: true }` — the model occasionally hallucinates a tool name; the dispatcher surfaces this as a tool-result error so the model can self-correct on the next iteration.
   - The function NEVER throws. Filesystem errors are caught and converted into error-marker strings (the underlying `readVaultFile` already swallows; `listVaultDir` likewise).

4. **Create `tests/ai/master/vault/tools.test.ts`** with cases:
   - **Tool def shape:** `VAULT_TOOL_DEFINITIONS.length === 3`; each entry has `{ name, description, input_schema }`. `read_vault_multi.description` matches `/Read MANY .* in ONE call/`. None of the entries is named `read_vault` (REQ-011 enforcement).
   - **`read_vault_multi` happy path:** create a tmpdir with two test files, call `dispatchVaultTool('read_vault_multi', { paths: ['/a.md', '/b.md'] }, { vaultRoot: tmp })`. Assert `content` matches the concatenated format `### /a.md\n\n<content>\n\n---\n\n### /b.md\n\n<content>`.
   - **`read_vault_multi` empty array → error.**
   - **`read_vault_multi` paths >16 → error.**
   - **`read_vault_multi` with one missing file:** result still returns the concatenated block with the error marker inline for the missing file; `isError: false` (per-file errors don't fail the batch).
   - **`read_vault_multi` with one traversal attempt** (`'../etc/passwd'`): the safe-path null gets surfaced as `ERROR: path outside vault` in that entry's content; sibling entries succeed.
   - **`list_vault` happy path:** tmpdir with three children; result starts with `Children of /` and lists each `- <name>` in sorted order.
   - **`list_vault` missing dir → `(no children or path not found)` content** (NOT an error marker — empty is semantically valid).
   - **`end_turn` returns endTurnResponse:** input `{ response: 'Final narrative.' }` → result `{ content: '', isError: false, endTurnResponse: 'Final narrative.' }`.
   - **`end_turn` with missing response:** input `{}` → `endTurnResponse: ''` (no throw).
   - **Unknown tool name → isError true.**
   - **`formatMultiReadResult` preserves order** when called directly with `[{path:'b'},{path:'a'}]`.

5. **Update `src/ai/master/vault/index.ts`** to add `export * from './tools';`.

## Verification

- Command: `pnpm test tests/ai/master/vault/tools.test.ts` → all cases pass.
- Command: `pnpm typecheck` → clean (the tool defs satisfy the existing `ToolDef` type alias).
- Behaviour: `pnpm exec tsx -e "import {VAULT_TOOL_DEFINITIONS} from './src/ai/master/vault/tools.ts'; console.log(JSON.stringify(VAULT_TOOL_DEFINITIONS, null, 2));"` → prints 3 tool entries with names `read_vault_multi`, `list_vault`, `end_turn`; NO entry named `read_vault`.
- Grep gate: `grep -c 'read_vault' src/ai/master/vault/tools.ts` shows occurrences only via `read_vault_multi` (no standalone `read_vault(`).

## Open questions

None — tool surface is locked by REQ-010/011 and the spike-009 patterns.
