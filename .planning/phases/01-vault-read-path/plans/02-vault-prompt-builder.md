# Plan 02: Vault System Prompt Builder (Pure Function)

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** 01-vault-path-safety (uses `VAULT_ROOT` constant)
**Estimated diff size:** ~80 LOC source + ~100 LOC tests / 3 files

## Goal

Ship the pure-function `buildVaultSystemPrompt` that produces the system prompt for the vault path. Output is byte-identical for byte-identical inputs (validated via SHA256 stability test). Source file contains zero forbidden non-deterministic constructs (`Date.now`, `Math.random`, `process.env`, `randomUUID`, `process.hrtime`, hostnames, `new Date()`) — enforced by a CI lint test that scans the source.

The output template is the spike-014-validated builder from `spike-findings-dnd-ai-master/references/prompt-builder.md`, adapted minimally to dnd-ai-master conventions. It is NOT the existing slim/full builder (`src/ai/master/slim-prompts.ts`, `src/ai/master/system-prompt.ts`) — those are baked-path concerns and stay untouched. The two builders are parallel functions selected by the route-branch in plan 07.

## Requirements satisfied

- **REQ-012** Lenient discovery protocol: prompt mentions `/tools/index.md` as the single discovery entry point, no per-tool strict lookup.
- **REQ-022** Pure-function prompt builder + CI lint enforcing prefix-cache hygiene.
- **REQ-030** Vault path uses the BASE qwen3 slug, not a `dnd-master-*` baked variant — the prompt is the runtime SYSTEM (nothing is baked into the model). This plan owns the runtime-side prompt content.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/prompt-builder.ts` | NEW | Pure function `buildVaultSystemPrompt` + `hashVaultPrompt`. |
| `src/ai/master/vault/__forbidden-patterns.ts` | NEW | Forbidden-regex array moved to its own file to avoid the spike-012 false-positive (the lint scan would match the array's string literals if they lived in the builder file). |
| `tests/ai/master/vault/prompt-builder.test.ts` | NEW | Stability + lint + difference tests. |
| `src/ai/master/vault/index.ts` | EDIT | Add `export * from './prompt-builder';` to the barrel created in plan 01. |

## Tasks

1. **Create `src/ai/master/vault/__forbidden-patterns.ts`.** Export a const array:
   ```
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
   The file's only export is this array — no other code. This isolates the regex source strings from the prompt-builder.ts scan in the test (spike 012's false-positive workaround, option 1 from `references/prompt-builder.md`).

2. **Create `src/ai/master/vault/prompt-builder.ts`.** Define:
   - `export interface VaultPromptInput { vaultRoot: string; campaignId: string; toolCount: number; language?: string; }`
   - `export function buildVaultSystemPrompt(input: VaultPromptInput): string` — returns a string built via `[...].join('\n')` (explicit ordered array — NEVER template literals across multiple lines, to avoid `\r\n` surprises from a hypothetical Windows checkout). Template content, in order:
     1. `You are an experienced D&D 5e Dungeon Master.`
     2. blank line
     3. `## Knowledge layout`
     4. blank line
     5. `Your knowledge lives in a markdown vault at root '${input.vaultRoot}'.`
     6. `- Static knowledge: /handbook/<category>/<id>.md`
     7. `- Active campaign: /campaigns/${input.campaignId}/ (reserved — populated in a later release)`
     8. blank line
     9. `## Tool usage protocol`
     10. blank line
     11. `If you don't know what tools exist, your FIRST action is to read /tools/index.md.`
     12. `After that, use any of the ${input.toolCount} listed tools directly.`
     13. blank line
     14. **Conditionally** (only when `input.language` is set): `Respond in language: ${input.language}.` then blank line — kept on its own line to preserve hash stability when language is undefined.
     15. `Keep responses concise.`
   - `export function hashVaultPrompt(prompt: string): string` — `createHash('sha256').update(prompt).digest('hex')`. Import from `'node:crypto'` (Node-builtin, no third-party).
   - **Reserved-path note:** the literal string `(reserved — populated in a later release)` documents that the `/campaigns/<id>/` path is intentionally future-reserved in Phase 01. The model is expected to skip it; if it tries `read_vault_multi(['/campaigns/<id>/index.md'])` the tool returns the standard "file not found" marker, which the model handles correctly per spike 002's lenient protocol.
   - The file MUST NOT import from `__forbidden-patterns.ts`, `Date`, `process`, `Math.random`, `crypto.randomUUID`, or any env reader. Only `node:crypto`'s `createHash` is allowed.

3. **Create `tests/ai/master/vault/prompt-builder.test.ts`** with the following vitest cases:
   - **Stability:** 1000 builds of the same `{ vaultRoot: 'data/vault', campaignId: 'test', toolCount: 3 }` yield ONE unique SHA256.
   - **Stability with language:** same loop, with `language: 'it'` — still one unique hash.
   - **Different campaignId → different hash:** `campaignId: 'a'` vs `campaignId: 'b'` produce different hashes.
   - **Different toolCount → different hash:** 3 vs 4.
   - **Different vaultRoot → different hash:** `'data/vault'` vs `'/abs/vault'`.
   - **Language presence changes hash:** with `language: 'it'` vs without language → different.
   - **No forbidden patterns in builder source:** load `src/ai/master/vault/prompt-builder.ts` via `readFileSync`, iterate `FORBIDDEN_PATTERNS` (imported from `__forbidden-patterns.ts`), assert `violations` array is empty. This is the lint test (REQ-022 enforcement).
   - **Snapshot test:** for a fixed input `{ vaultRoot: 'data/vault', campaignId: 'test-camp', toolCount: 3 }`, assert the output matches a baseline string (write the baseline once, in this PR; future builder changes that drift the output MUST update the snapshot deliberately, surfacing the change in code review — this is the "prefix cache will be invalidated" early warning).
   - **`buildVaultSystemPrompt({ toolCount: 3, ... })` includes the literal substring `"3 listed tools"`** — sanity check the toolCount interpolation.

4. **Update `src/ai/master/vault/index.ts`** (created in plan 01) to add `export * from './prompt-builder';`.

5. **No imports of this builder are wired into the turn route yet.** That happens in plan 07. This plan keeps the builder self-contained so its tests can run independently.

## Verification

- Command: `pnpm test tests/ai/master/vault/prompt-builder.test.ts` → all cases pass (8+ cases including 1000-build loop).
- Command: `pnpm typecheck` → clean.
- File inspect: `cat src/ai/master/vault/prompt-builder.ts | grep -E 'Date\.now|Math\.random|process\.env|randomUUID|hrtime|hostname'` → no matches.
- Behaviour check (manual): `pnpm exec tsx -e "import {buildVaultSystemPrompt, hashVaultPrompt} from './src/ai/master/vault/prompt-builder.ts'; const p = buildVaultSystemPrompt({vaultRoot:'data/vault',campaignId:'x',toolCount:3}); console.log(p); console.log(hashVaultPrompt(p));"` → prints the prompt body + a 64-char hex hash.
- Behaviour: snapshot file produced in this PR matches what the build outputs (avoids accidental drift on first run).

## Open questions

None. The template content is the spike-validated form. Snapshot baseline is generated in this PR — that locks the byte-exact form so any future change must explicitly update the snapshot.
